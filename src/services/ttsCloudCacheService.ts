import { supabaseService } from './supabaseService';
import { dbService } from './dbService';

export type TTSEngineType = 'elevenlabs' | 'minimax';

const BUCKET_NAME = 'tts-audio-cache';
const MAX_UPLOAD_CONCURRENCY = 2;
const MAX_UPLOAD_RETRIES = 2;
const UPLOAD_RETRY_DELAY = 2000;

interface UploadTask {
  text: string;
  voice: string;
  engine: TTSEngineType;
  modelId: string;
  audioBlob: Blob;
  rate: number;
  retryCount: number;
  resolve: (success: boolean) => void;
}

let uploadQueue: UploadTask[] = [];
let activeUploads = 0;
let bucketEnsured: boolean | null = null;

const generateStoragePath = (engine: TTSEngineType, cacheKey: string): string => {
  // elevenlabs 经尾部净化后输出 WAV，并加 v2 版本段使存量污染缓存失效（minimax 路径不变）
  if (engine === 'elevenlabs') {
    return `elevenlabs/v2/${cacheKey}.wav`;
  }
  return `${engine}/${cacheKey}.mp3`;
};

const generateCloudCacheKey = (text: string, voice: string, engine: TTSEngineType, modelId?: string): string => {
  let raw = `${text.trim()}|${engine}|${voice}`;
  if (engine === 'elevenlabs' && modelId) {
    raw += `|${modelId}`;
  }
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(i);
    hash = hash & hash;
  }
  return `${engine}_${Math.abs(hash).toString(36)}_${raw.length}`;
};

const isSupabaseReady = (): boolean => {
  return supabaseService.isReady && !!supabaseService.client;
};

const isBucketNotFoundError = (errorMessage: string): boolean => {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes('bucket not found') ||
    lower.includes('does not exist') ||
    lower.includes('not found') ||
    lower.includes('404') ||
    lower.includes('no such bucket')
  );
};

const processUploadQueue = (): void => {
  while (activeUploads < MAX_UPLOAD_CONCURRENCY && uploadQueue.length > 0) {
    const task = uploadQueue.shift()!;
    activeUploads++;
    executeUpload(task).finally(() => {
      activeUploads--;
      processUploadQueue();
    });
  }
};

const executeUpload = async (task: UploadTask): Promise<void> => {
  const { text, voice, engine, modelId, audioBlob, retryCount, resolve } = task;

  if (!isSupabaseReady()) {
    resolve(false);
    return;
  }

  if (bucketEnsured === null) {
    console.log(`🔊 [CloudCache] 首次上传，主动检查存储桶 "${BUCKET_NAME}"...`);
    const ensureResult = await ensureBucket();
    bucketEnsured = ensureResult.success;
    if (!ensureResult.success) {
      console.warn(`🔊 [CloudCache] 存储桶检查失败: ${ensureResult.message}`);
    }
  }

  const client = supabaseService.client!;
  const cacheKey = generateCloudCacheKey(text, voice, engine, engine === 'elevenlabs' ? modelId : undefined);
  const path = generateStoragePath(engine, cacheKey);

  try {
    const { error } = await client.storage
      .from(BUCKET_NAME)
      .upload(path, audioBlob, {
        contentType: audioBlob.type || 'audio/mpeg',
        upsert: true,
      });

    if (error) {
      if (isBucketNotFoundError(error.message)) {
        console.warn(`🔊 [CloudCache] 存储桶 "${BUCKET_NAME}" 不可用，尝试重新创建...`);
        bucketEnsured = null;
        const createResult = await ensureBucket();
        if (createResult.success) {
          bucketEnsured = true;
          const { error: retryError } = await client.storage
            .from(BUCKET_NAME)
            .upload(path, audioBlob, {
              contentType: audioBlob.type || 'audio/mpeg',
              upsert: true,
            });
          if (!retryError) {
            await updateSentenceAudioPath(text, voice, engine, modelId, path);
            console.log(`🔊 [CloudCache] 已上传 | [${engine}] [语音] ${voice} | [大小] ${formatSize(audioBlob.size)}`);
            resolve(true);
            return;
          }
        }
      }

      if (retryCount < MAX_UPLOAD_RETRIES) {
        console.warn(`🔊 [CloudCache] 上传失败 [${engine}]，第 ${retryCount + 1}/${MAX_UPLOAD_RETRIES} 次重试: ${error.message}`);
        setTimeout(() => {
          uploadQueue.push({
            ...task,
            retryCount: retryCount + 1,
          });
          processUploadQueue();
        }, UPLOAD_RETRY_DELAY * (retryCount + 1));
        return;
      }

      console.warn(`🔊 [CloudCache] 上传失败 [${engine}]，已耗尽重试: ${error.message}`);
      resolve(false);
      return;
    }

    await updateSentenceAudioPath(text, voice, engine, modelId, path);
    console.log(`🔊 [CloudCache] 已上传 | [${engine}] [语音] ${voice} | [大小] ${formatSize(audioBlob.size)}`);
    resolve(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (retryCount < MAX_UPLOAD_RETRIES) {
      console.warn(`🔊 [CloudCache] 上传异常 [${engine}]，第 ${retryCount + 1}/${MAX_UPLOAD_RETRIES} 次重试: ${msg}`);
      setTimeout(() => {
        uploadQueue.push({
          ...task,
          retryCount: retryCount + 1,
        });
        processUploadQueue();
      }, UPLOAD_RETRY_DELAY * (retryCount + 1));
      return;
    }

    console.warn(`🔊 [CloudCache] 上传异常 [${engine}]，已耗尽重试: ${msg}`);
    resolve(false);
  }
};

const escapeLikePattern = (text: string): string => {
  return text.replace(/[%_]/g, '\\$&');
};

const updateSentenceAudioPath = async (
  text: string,
  voice: string,
  engine: TTSEngineType,
  modelId: string,
  storagePath: string
): Promise<void> => {
  const trimmedText = text.trim();
  const column = engine === 'elevenlabs' ? 'tts_audio_path_el' : 'tts_audio_path_mm';
  const localField = engine === 'elevenlabs' ? 'ttsAudioPathEl' : 'ttsAudioPathMm';

  try {
    const localSentence = await dbService.findByEnglish(trimmedText);
    if (localSentence) {
      const updatedSentence = {
        ...localSentence,
        [localField]: storagePath,
        updatedAt: Date.now(),
      };
      await dbService.put(updatedSentence);
      console.log(`🔊 [CloudCache] 本地句子音频路径已更新 | [${engine}] | [字段] ${localField}`);
    } else {
      console.warn(`🔊 [CloudCache] 本地未找到对应句子，跳过本地更新 | [文本] ${trimmedText.slice(0, 30)}`);
    }
  } catch (err) {
    console.warn(`🔊 [CloudCache] 更新本地句子音频路径异常:`, err instanceof Error ? err.message : String(err));
  }

  if (!isSupabaseReady()) return;

  const client = supabaseService.client!;
  const userName = supabaseService.userName;
  if (!userName) return;

  try {
    const now = Date.now();
    const escapedText = escapeLikePattern(trimmedText);
    const { error, count } = await client
      .from('sentences')
      .update({ [column]: storagePath, updatedat: now })
      .eq('username', userName)
      .ilike('english', escapedText);

    if (error) {
      console.warn(`🔊 [CloudCache] 更新云端音频路径失败 [${engine}]:`, error.message);
    } else {
      console.log(`🔊 [CloudCache] 云端音频路径已更新到 sentences 表 | [${engine}] | [列] ${column} | [匹配行数] ${count ?? 'unknown'}`);
    }
  } catch (err) {
    console.warn(`🔊 [CloudCache] 更新云端音频路径异常:`, err instanceof Error ? err.message : String(err));
  }
};

const ensureBucket = async (): Promise<{ success: boolean; message: string }> => {
  if (!isSupabaseReady()) {
    return { success: false, message: 'Supabase 未配置' };
  }

  const client = supabaseService.client!;

  try {
    // 策略：不依赖 listBuckets（会被 RLS 拦），直接尝试对目标 Bucket 做一个轻量操作（list）
    const { error: listError } = await client.storage.from(BUCKET_NAME).list('', { limit: 1 });

    if (!listError) {
      // list 成功 → Bucket 存在且可读
      return { success: true, message: `存储桶 "${BUCKET_NAME}" 可访问` };
    }

    // 检查是否是 "bucket not found" 错误
    if (isBucketNotFoundError(listError.message)) {
      console.log(`🔊 [CloudCache] 存储桶 "${BUCKET_NAME}" 未找到，尝试创建...`);
      const { error: createError } = await client.storage.createBucket(BUCKET_NAME, {
        public: true,
        fileSizeLimit: 5242880,
      });

      if (createError) {
        console.error(`🔊 [CloudCache] 创建存储桶失败: ${createError.message}`);
        return {
          success: false,
          message: `存储桶不存在且无法自动创建: ${createError.message}`,
        };
      }

      console.log(`🔊 [CloudCache] 存储桶 "${BUCKET_NAME}" 创建成功（公开读取）`);
      console.log(`🔊 [CloudCache] ⚠️  请在 Supabase Dashboard → Storage → Policies 中添加以下策略：`);
      console.log(`   1. 允许上传: INSERT, target: storage.objects, USING (bucket_id = '${BUCKET_NAME}')`);
      console.log(`   2. 允许下载: SELECT, target: storage.objects, USING (bucket_id = '${BUCKET_NAME}')`);
      console.log(`   或在 SQL Editor 中执行：`);
      console.log(`   CREATE POLICY "Allow public read" ON storage.objects FOR SELECT USING (bucket_id = '${BUCKET_NAME}');`);
      console.log(`   CREATE POLICY "Allow anon upload" ON storage.objects FOR INSERT WITH CHECK (bucket_id = '${BUCKET_NAME}');`);
      console.log(`   CREATE POLICY "Allow anon update" ON storage.objects FOR UPDATE USING (bucket_id = '${BUCKET_NAME}');`);

      return { success: true, message: `存储桶 "${BUCKET_NAME}" 创建成功` };
    }

    // 既不是 bucket not found，也不是成功 → 是其他错误（RLS、权限、网络等）
    return { success: false, message: `存储桶访问被拒绝: ${listError.message}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `检查存储桶异常: ${msg}` };
  }
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

export const ttsCloudCacheService = {
  async get(
    text: string,
    voice: string,
    engine: TTSEngineType,
    modelId?: string
  ): Promise<Blob | null> {
    if (!isSupabaseReady()) {
      return null;
    }

    const client = supabaseService.client!;
    const cacheKey = generateCloudCacheKey(text, voice, engine, engine === 'elevenlabs' ? modelId : undefined);
    const path = generateStoragePath(engine, cacheKey);

    try {
      const { data, error } = await client.storage
        .from(BUCKET_NAME)
        .download(path);

      if (error) {
        if (error.message?.includes('not found') || error.message?.includes('404') || error.message?.includes('does not exist')) {
          return null;
        }
        console.warn(`🔊 [CloudCache] 下载失败 [${engine}]:`, error.message);
        return null;
      }

      if (!data || data.size === 0) {
        return null;
      }

      console.log(`🔊 [CloudCache] 云端命中 | [${engine}] [语音] ${voice} | [大小] ${formatSize(data.size)}`);
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`🔊 [CloudCache] 下载异常 [${engine}]:`, msg);
      return null;
    }
  },

  async put(
    text: string,
    voice: string,
    engine: TTSEngineType,
    audioBlob: Blob,
    modelId?: string,
    rate: number = 1
  ): Promise<boolean> {
    if (!isSupabaseReady()) {
      return false;
    }

    if (rate !== 1) {
      console.log(`🔊 [CloudCache] 非原速音频跳过上传 | [语速] ${rate}x`);
      return false;
    }

    return new Promise((resolve) => {
      uploadQueue.push({
        text,
        voice,
        engine,
        modelId: modelId || '',
        audioBlob,
        rate,
        retryCount: 0,
        resolve,
      });
      processUploadQueue();
    });
  },

  async downloadByPath(storagePath: string): Promise<Blob | null> {
    if (!isSupabaseReady()) {
      return null;
    }

    if (!storagePath || !storagePath.trim()) {
      return null;
    }

    const client = supabaseService.client!;

    try {
      const { data, error } = await client.storage
        .from(BUCKET_NAME)
        .download(storagePath);

      if (error) {
        console.warn(`🔊 [CloudCache] 路径下载失败: ${storagePath}`, error.message);
        return null;
      }

      if (!data || data.size === 0) {
        return null;
      }

      console.log(`🔊 [CloudCache] 路径下载成功 | [路径] ${storagePath} | [大小] ${formatSize(data.size)}`);
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`🔊 [CloudCache] 路径下载异常: ${storagePath}`, msg);
      return null;
    }
  },

  async delete(
    text: string,
    voice: string,
    engine: TTSEngineType,
    modelId?: string
  ): Promise<boolean> {
    if (!isSupabaseReady()) {
      return false;
    }

    const client = supabaseService.client!;
    const cacheKey = generateCloudCacheKey(text, voice, engine, engine === 'elevenlabs' ? modelId : undefined);
    const path = generateStoragePath(engine, cacheKey);

    try {
      const { error } = await client.storage
        .from(BUCKET_NAME)
        .remove([path]);

      if (error) {
        console.warn(`🔊 [CloudCache] 删除失败 [${engine}]:`, error.message);
        return false;
      }

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`🔊 [CloudCache] 删除异常 [${engine}]:`, msg);
      return false;
    }
  },

  async deleteByPath(storagePath: string): Promise<boolean> {
    if (!isSupabaseReady()) {
      return false;
    }

    const client = supabaseService.client!;

    try {
      const { error } = await client.storage
        .from(BUCKET_NAME)
        .remove([storagePath]);

      if (error) {
        console.warn(`🔊 [CloudCache] 路径删除失败:`, error.message);
        return false;
      }

      console.log(`🔊 [CloudCache] 路径删除成功 | [path] ${storagePath}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`🔊 [CloudCache] 路径删除异常:`, msg);
      return false;
    }
  },

  async deleteBySentence(sentence: { ttsAudioPathEl?: string; ttsAudioPathMm?: string }): Promise<{ el: boolean; mm: boolean }> {
    const result = { el: false, mm: false };

    if (sentence.ttsAudioPathEl) {
      result.el = await this.deleteByPath(sentence.ttsAudioPathEl);
    }
    if (sentence.ttsAudioPathMm) {
      result.mm = await this.deleteByPath(sentence.ttsAudioPathMm);
    }

    return result;
  },

  async listFiles(engine?: TTSEngineType): Promise<Array<{ name: string; size: number; createdAt: string }>> {
    if (!isSupabaseReady()) {
      return [];
    }

    const client = supabaseService.client!;
    const prefix = engine ? `${engine}/` : '';

    try {
      const { data, error } = await client.storage
        .from(BUCKET_NAME)
        .list(prefix, {
          limit: 1000,
          sortBy: { column: 'created_at', order: 'desc' },
        });

      if (error) {
        console.warn(`🔊 [CloudCache] 列表失败:`, error.message);
        return [];
      }

      return (data || [])
        .filter(item => item.id && !item.id.endsWith('/'))
        .map(item => ({
          name: item.name,
          size: item.metadata?.size || 0,
          createdAt: item.created_at || '',
        }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`🔊 [CloudCache] 列表异常:`, msg);
      return [];
    }
  },

  async clearEngine(engine: TTSEngineType): Promise<number> {
    if (!isSupabaseReady()) {
      return 0;
    }

    const client = supabaseService.client!;

    try {
      const { data, error } = await client.storage
        .from(BUCKET_NAME)
        .list(`${engine}/`, { limit: 1000 });

      if (error || !data || data.length === 0) {
        return 0;
      }

      const filesToRemove = data
        .filter(item => item.id && !item.id.endsWith('/'))
        .map(item => `${engine}/${item.name}`);

      if (filesToRemove.length === 0) {
        return 0;
      }

      const { error: removeError } = await client.storage
        .from(BUCKET_NAME)
        .remove(filesToRemove);

      if (removeError) {
        console.warn(`🔊 [CloudCache] 清理失败 [${engine}]:`, removeError.message);
        return 0;
      }

      console.log(`🔊 [CloudCache] 已清理 [${engine}] ${filesToRemove.length} 个文件`);
      return filesToRemove.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`🔊 [CloudCache] 清理异常 [${engine}]:`, msg);
      return 0;
    }
  },

  async clearAll(): Promise<{ elevenlabs: number; minimax: number }> {
    const [el, mm] = await Promise.all([
      this.clearEngine('elevenlabs'),
      this.clearEngine('minimax'),
    ]);
    return { elevenlabs: el, minimax: mm };
  },

  async getStats(): Promise<{
    elevenlabs: { count: number; totalSize: number };
    minimax: { count: number; totalSize: number };
    total: { count: number; totalSize: number };
  }> {
    if (!isSupabaseReady()) {
      return {
        elevenlabs: { count: 0, totalSize: 0 },
        minimax: { count: 0, totalSize: 0 },
        total: { count: 0, totalSize: 0 },
      };
    }

    const engines: TTSEngineType[] = ['elevenlabs', 'minimax'];
    const stats: Record<string, { count: number; totalSize: number }> = {};

    for (const engine of engines) {
      const files = await this.listFiles(engine);
      let totalSize = 0;
      for (const f of files) {
        totalSize += f.size;
      }
      stats[engine] = { count: files.length, totalSize };
    }

    const totalCount = stats.elevenlabs.count + stats.minimax.count;
    const totalSize = stats.elevenlabs.totalSize + stats.minimax.totalSize;

    return {
      elevenlabs: stats.elevenlabs,
      minimax: stats.minimax,
      total: { count: totalCount, totalSize },
    };
  },

  async ensureBucket(): Promise<{ success: boolean; message: string }> {
    const result = await ensureBucket();
    if (result.success) {
      bucketEnsured = true;
    }
    return result;
  },

  resetBucketState(): void {
    bucketEnsured = null;
  },

  isAvailable(): boolean {
    return isSupabaseReady();
  },

  getBucketName(): string {
    return BUCKET_NAME;
  },

  getQueueLength(): number {
    return uploadQueue.length;
  },

  getActiveUploads(): number {
    return activeUploads;
  },

  /**
   * 校验 Storage 桶中文件是否实际存在(不下载文件内容)
   * 使用 list API 轻量校验,iOS 弱网友好
   * fail-open:任何异常返回 false,避免阻塞生成流程
   */
  async verifyFileExists(storagePath: string): Promise<boolean> {
    if (!isSupabaseReady()) return false;
    if (!storagePath || !storagePath.trim()) return false;

    const client = supabaseService.client!;
    const trimmedPath = storagePath.trim();
    const lastSlash = trimmedPath.lastIndexOf('/');
    const directory = lastSlash > 0 ? trimmedPath.substring(0, lastSlash) : '';
    const filename = lastSlash > 0 ? trimmedPath.substring(lastSlash + 1) : trimmedPath;

    if (!filename) return false;

    try {
      const { data, error } = await client.storage
        .from(BUCKET_NAME)
        .list(directory, { limit: 1000, search: filename });

      if (error) {
        console.warn(`🔊 [CloudCache] 文件存在性校验失败 | [路径] ${storagePath}`, error.message);
        return false;
      }

      const exists = Array.isArray(data) && data.some(item => item && item.name === filename);
      return exists;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`🔊 [CloudCache] 文件存在性校验异常 | [路径] ${storagePath}`, msg);
      return false;
    }
  },

  /**
   * 三阶段校验:supabase 是否已存在该句子的录音
   * 阶段1:本地 IndexedDB(无网络开销)
   * 阶段2:本地无记录时兜底直查 supabase sentences 表
   * 阶段3:对元数据存在的文件做 Storage list 验证(默认开启,可跳过)
   * fail-open:任何异常返回 { exists: false }
   *
   * @param options.skipFileVerify 弱网场景可传 true 跳过文件验证(仅查元数据)
   */
  async checkCloudAudioExists(
    text: string,
    options?: { skipFileVerify?: boolean }
  ): Promise<{ exists: boolean; engine?: TTSEngineType; path?: string }> {
    const trimmedText = text?.trim();
    if (!trimmedText) return { exists: false };

    let cloudPathEl: string | null = null;
    let cloudPathMm: string | null = null;

    // 阶段1:本地 IndexedDB(无网络开销,iOS 弱网友好)
    try {
      const sentence = await dbService.findByEnglish(trimmedText);
      if (sentence) {
        cloudPathEl = sentence.ttsAudioPathEl || null;
        cloudPathMm = sentence.ttsAudioPathMm || null;
      }
    } catch { /* ignore, fail-open */ }

    // 阶段2:本地无记录时兜底直查 supabase sentences 表(避免本地数据陈旧)
    if (!cloudPathEl && !cloudPathMm && isSupabaseReady()) {
      try {
        const client = supabaseService.client!;
        const { data } = await client
          .from('sentences')
          .select('tts_audio_path_el, tts_audio_path_mm')
          .ilike('english', trimmedText)
          .limit(1)
          .single();
        if (data) {
          cloudPathEl = data.tts_audio_path_el || null;
          cloudPathMm = data.tts_audio_path_mm || null;
        }
      } catch { /* ignore, fail-open */ }
    }

    const candidates: Array<{ path: string; engine: TTSEngineType }> = [];
    // 只要有录音（不论 v1/v2 新旧版本、不论引擎），一律视为已存在，禁止再次生成
    // 'pending' 是本地占位符而非真实存储路径，不参与文件校验（L1 元数据守卫仍会拦截）
    const isRealStoragePath = (p: string | null): p is string => !!p && p !== 'pending';
    if (isRealStoragePath(cloudPathEl)) candidates.push({ path: cloudPathEl, engine: 'elevenlabs' });
    if (isRealStoragePath(cloudPathMm)) candidates.push({ path: cloudPathMm, engine: 'minimax' });

    if (candidates.length === 0) {
      return { exists: false };
    }

    // 弱网场景跳过文件验证,仅依据元数据判定
    if (options?.skipFileVerify === true) {
      const first = candidates[0];
      return { exists: true, engine: first.engine, path: first.path };
    }

    // 阶段3:对元数据存在的文件做 Storage list 验证(防止孤儿元数据)
    for (const { path, engine } of candidates) {
      const fileExists = await this.verifyFileExists(path);
      if (fileExists) {
        return { exists: true, engine, path };
      }
    }

    console.warn(`🔊 [CloudCache] 检测到孤儿元数据 | [文本] ${trimmedText.slice(0, 30)} | 路径: ${candidates.map(c => c.path).join(', ')}`);
    return { exists: false };
  },

  async getAnyEngine(
    text: string,
    preferredEngine?: TTSEngineType
  ): Promise<{ blob: Blob; engine: TTSEngineType } | null> {
    if (!isSupabaseReady()) {
      return null;
    }

    try {
      const sentence = await dbService.findByEnglish(text.trim());
      if (!sentence) {
        return null;
      }

      const paths: Array<{ path: string; engine: TTSEngineType }> = [];

      if (preferredEngine === 'elevenlabs') {
        if (sentence.ttsAudioPathEl) paths.push({ path: sentence.ttsAudioPathEl, engine: 'elevenlabs' });
        if (sentence.ttsAudioPathMm) paths.push({ path: sentence.ttsAudioPathMm, engine: 'minimax' });
      } else if (preferredEngine === 'minimax') {
        if (sentence.ttsAudioPathMm) paths.push({ path: sentence.ttsAudioPathMm, engine: 'minimax' });
        if (sentence.ttsAudioPathEl) paths.push({ path: sentence.ttsAudioPathEl, engine: 'elevenlabs' });
      } else {
        if (sentence.ttsAudioPathEl) paths.push({ path: sentence.ttsAudioPathEl, engine: 'elevenlabs' });
        if (sentence.ttsAudioPathMm) paths.push({ path: sentence.ttsAudioPathMm, engine: 'minimax' });
      }

      for (const { path, engine } of paths) {
        const blob = await this.downloadByPath(path);
        if (blob) {
          console.log(`🔊 [CloudCache] 跨引擎命中 | [${engine}] | [路径] ${path}`);
          return { blob, engine };
        }
      }
    } catch { /* ignore */ }

    return null;
  },

  formatSize,
};

export default ttsCloudCacheService;
