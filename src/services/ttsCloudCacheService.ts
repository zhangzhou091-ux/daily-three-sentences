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
  /** 修复 1：元数据补写阶段标记——上传已成功，仅补写 sentences 表元数据 */
  metadataOnly?: boolean;
  /** 修复 1：metadataOnly 阶段携带的 Storage 路径（上传成功时计算得出） */
  storagePath?: string;
}

/** 修复 3：带错误类型的路径下载结果 */
export type CloudDownloadResult =
  | { blob: Blob }
  | { notFound: true }
  | { error: true };

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
  const { text, voice, engine, modelId, audioBlob, retryCount, resolve, metadataOnly } = task;

  if (!isSupabaseReady()) {
    resolve(false);
    return;
  }

  // 修复 1：元数据补写阶段——上传已成功，仅重试云端 sentences 表写入（本地 put 幂等，重做无害）
  if (metadataOnly) {
    const path = task.storagePath!;
    try {
      const { cloudOk } = await updateSentenceAudioPath(text, voice, engine, modelId, path);
      if (cloudOk) {
        console.log(`🔊 [CloudCache] 元数据补写成功（重试） | [${engine}] | [路径] ${path}`);
        resolve(true);
      } else if (retryCount < MAX_UPLOAD_RETRIES) {
        console.warn(`🔊 [CloudCache] 元数据补写失败 [${engine}]，第 ${retryCount + 1}/${MAX_UPLOAD_RETRIES} 次重试`);
        setTimeout(() => {
          uploadQueue.push({ ...task, retryCount: retryCount + 1 });
          processUploadQueue();
        }, UPLOAD_RETRY_DELAY * (retryCount + 1));
      } else {
        console.warn(`🔊 [CloudCache] 元数据补写失败 [${engine}]，已耗尽重试（同设备本地路径不受影响，跨设备将由守卫自愈）`);
        resolve(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (retryCount < MAX_UPLOAD_RETRIES) {
        console.warn(`🔊 [CloudCache] 元数据补写异常 [${engine}]，第 ${retryCount + 1}/${MAX_UPLOAD_RETRIES} 次重试: ${msg}`);
        setTimeout(() => {
          uploadQueue.push({ ...task, retryCount: retryCount + 1 });
          processUploadQueue();
        }, UPLOAD_RETRY_DELAY * (retryCount + 1));
      } else {
        console.warn(`🔊 [CloudCache] 元数据补写异常 [${engine}]，已耗尽重试: ${msg}`);
        resolve(false);
      }
    }
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
            await handleMetadataWrite(task, path);
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

    await handleMetadataWrite(task, path);
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

/**
 * 修复 1：上传成功后的元数据写入收口。
 * 云端 sentences 表写入失败（error / 匹配 0 行 / 未就绪）时，任务以 metadataOnly
 * 重新入队，走既有 MAX_UPLOAD_RETRIES + 退避逻辑，堵「跨设备孤儿文件」事故源。
 */
const handleMetadataWrite = async (task: UploadTask, storagePath: string): Promise<void> => {
  const { text, voice, engine, modelId, resolve, audioBlob } = task;
  const { cloudOk } = await updateSentenceAudioPath(text, voice, engine, modelId, storagePath);

  if (cloudOk) {
    console.log(`🔊 [CloudCache] 已上传 | [${engine}] [语音] ${voice} | [大小] ${formatSize(audioBlob.size)} | [路径] ${storagePath}`);
    resolve(true);
    return;
  }

  console.warn(`🔊 [CloudCache] 上传成功但元数据写入失败，转入 metadataOnly 重试 | [${engine}] | [路径] ${storagePath}`);
  setTimeout(() => {
    uploadQueue.push({
      ...task,
      metadataOnly: true,
      storagePath,
      retryCount: 0,
      audioBlob: new Blob(), // metadataOnly 阶段不再需要音频内容，释放大对象引用
    });
    processUploadQueue();
  }, UPLOAD_RETRY_DELAY);
};

/** 修复 5:导出供 geminiService 的兜底查询复用,统一 ilike 转义 */
export const escapeLikePattern = (text: string): string => {
  return text.replace(/[%_]/g, '\\$&');
};

const updateSentenceAudioPath = async (
  text: string,
  voice: string,
  engine: TTSEngineType,
  modelId: string,
  storagePath: string
): Promise<{ localOk: boolean; cloudOk: boolean }> => {
  const trimmedText = text.trim();
  const column = engine === 'elevenlabs' ? 'tts_audio_path_el' : 'tts_audio_path_mm';
  const localField = engine === 'elevenlabs' ? 'ttsAudioPathEl' : 'ttsAudioPathMm';

  let localOk = false;

  try {
    const localSentence = await dbService.findByEnglish(trimmedText);
    if (localSentence) {
      const updatedSentence = {
        ...localSentence,
        [localField]: storagePath,
        updatedAt: Date.now(),
      };
      await dbService.put(updatedSentence);
      localOk = true;
      console.log(`🔊 [CloudCache] 本地句子音频路径已更新 | [${engine}] | [字段] ${localField}`);
    } else {
      // 本地写失败分类①：本地句子不存在——会话内重试本地写入无意义，
      // metadataOnly 重试实际服务的是云端写入（届时本地可能已同步到该句子）
      console.warn(`🔊 [CloudCache] 本地未找到对应句子，跳过本地更新 | [文本] ${trimmedText.slice(0, 30)}`);
    }
  } catch (err) {
    // 本地写失败分类②：IndexedDB put 异常
    console.warn(`🔊 [CloudCache] 更新本地句子音频路径异常:`, err instanceof Error ? err.message : String(err));
  }

  if (!isSupabaseReady()) return { localOk, cloudOk: false };

  const client = supabaseService.client!;
  const userName = supabaseService.userName;
  if (!userName) return { localOk, cloudOk: false };

  try {
    const now = Date.now();
    const escapedText = escapeLikePattern(trimmedText);
    const { error, count } = await client
      .from('sentences')
      .update({ [column]: storagePath, updatedat: now }, { count: 'exact' })
      .eq('username', userName)
      .ilike('english', escapedText);

    if (error) {
      console.warn(`🔊 [CloudCache] 更新云端音频路径失败 [${engine}]:`, error.message);
      return { localOk, cloudOk: false };
    }

    // 修复 1：count === 0 —— 句子行尚未被同步到云端表，update 未命中任何行。
    // 不报错但什么都没写，视为可重试失败（行稍后由 syncQueueService 同步，届时才能命中；
    // 否则 Storage 有文件、sentences 表无路径，形成跨设备孤儿）
    if (count === 0) {
      console.warn(`🔊 [CloudCache] 云端 update 匹配 0 行（句子行尚未同步），视为可重试 | [${engine}] | [文本] ${trimmedText.slice(0, 30)}`);
      return { localOk, cloudOk: false };
    }

    console.log(`🔊 [CloudCache] 云端音频路径已更新到 sentences 表 | [${engine}] | [列] ${column} | [匹配行数] ${count ?? 'unknown'}`);
    return { localOk, cloudOk: true };
  } catch (err) {
    console.warn(`🔊 [CloudCache] 更新云端音频路径异常:`, err instanceof Error ? err.message : String(err));
    return { localOk, cloudOk: false };
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
    const result = await this.downloadByPathDetailed(storagePath);
    return 'blob' in result ? result.blob : null;
  },

  /**
   * 修复 3：带错误类型的路径下载。
   * - { blob }        下载成功
   * - { notFound: true } 确定不存在（404 / 0 字节）——孤儿元数据，调用方清理后放行
   * - { error: true } 网络等其他失败——fail-open 语义，调用方放行
   */
  async downloadByPathDetailed(storagePath: string): Promise<CloudDownloadResult> {
    if (!isSupabaseReady()) {
      return { error: true };
    }

    if (!storagePath || !storagePath.trim()) {
      return { notFound: true };
    }

    const client = supabaseService.client!;

    try {
      const { data, error } = await client.storage
        .from(BUCKET_NAME)
        .download(storagePath);

      if (error) {
        const msg = error.message || '';
        if (msg.includes('not found') || msg.includes('404') || msg.includes('does not exist')) {
          return { notFound: true };
        }
        console.warn(`🔊 [CloudCache] 路径下载失败: ${storagePath}`, msg);
        return { error: true };
      }

      if (!data || data.size === 0) {
        return { notFound: true };
      }

      console.log(`🔊 [CloudCache] 路径下载成功 | [路径] ${storagePath} | [大小] ${formatSize(data.size)}`);
      return { blob: data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`🔊 [CloudCache] 路径下载异常: ${storagePath}`, msg);
      return { error: true };
    }
  },

  /**
   * 修复 3：public URL 直链下载兜底。SDK 下载失败但网络仍在时，
   * 用 getPublicUrl + fetch 走另一条传输路径再试一次（桶 public:true，无需鉴权）。
   * 不手工拼 URL 字符串——自定义域名/存储端点偏移时手拼会静默 404。
   */
  async downloadViaPublicUrl(storagePath: string): Promise<Blob | null> {
    if (!isSupabaseReady()) return null;
    if (!storagePath || !storagePath.trim()) return null;

    try {
      const client = supabaseService.client!;
      const { data } = client.storage.from(BUCKET_NAME).getPublicUrl(storagePath.trim());
      const response = await fetch(data.publicUrl);
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!blob || blob.size === 0) return null;
      console.log(`🔊 [CloudCache] 直链下载成功 | [路径] ${storagePath} | [大小] ${formatSize(blob.size)}`);
      return blob;
    } catch {
      return null;
    }
  },

  /**
   * 修复 3：清除句子的陈旧音频元数据（文件已确认不存在的 404 孤儿场景）。
   * 清空本地与云端两列路径，使守卫不再误判、后续可正常重新生成。
   * 不删 Storage 文件——调用场景即文件已不存在。
   */
  async clearSentenceAudioMetadata(text: string, engine: TTSEngineType): Promise<void> {
    const trimmedText = text?.trim();
    if (!trimmedText) return;
    const column = engine === 'elevenlabs' ? 'tts_audio_path_el' : 'tts_audio_path_mm';
    const localField = engine === 'elevenlabs' ? 'ttsAudioPathEl' : 'ttsAudioPathMm';

    try {
      const localSentence = await dbService.findByEnglish(trimmedText);
      if (localSentence && localSentence[localField]) {
        const updatedSentence = { ...localSentence, [localField]: undefined, updatedAt: Date.now() };
        await dbService.put(updatedSentence);
        console.log(`🔊 [CloudCache] 已清除本地陈旧音频元数据 | [${engine}] | [文本] ${trimmedText.slice(0, 30)}`);
      }
    } catch (err) {
      console.warn(`🔊 [CloudCache] 清除本地音频元数据异常:`, err instanceof Error ? err.message : String(err));
    }

    if (!isSupabaseReady()) return;
    const client = supabaseService.client!;
    const userName = supabaseService.userName;
    if (!userName) return;

    try {
      const { error } = await client
        .from('sentences')
        .update({ [column]: null, updatedat: Date.now() })
        .eq('username', userName)
        .ilike('english', escapeLikePattern(trimmedText));
      if (error) {
        console.warn(`🔊 [CloudCache] 清除云端音频元数据失败 [${engine}]:`, error.message);
      } else {
        console.log(`🔊 [CloudCache] 已清除云端陈旧音频元数据 | [${engine}] | [文本] ${trimmedText.slice(0, 30)}`);
      }
    } catch (err) {
      console.warn(`🔊 [CloudCache] 清除云端音频元数据异常:`, err instanceof Error ? err.message : String(err));
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
   * 修复 4:HEAD 直链探测——一次请求替代 list,去掉 search 语义依赖与全目录开销,弱网成功率更高
   * - 2xx → 存在;404 → 不存在
   * - 403(私有桶)→ 退回 SDK download 第二判定(无 error → 存在)
   * - 405(不支持 HEAD)→ 退化 Range:bytes=0-0 GET(206/2xx → 存在)
   * - 其他状态码/网络异常 → false(fail-open「未能确认」语义,调用方放行)
   */
  async verifyFileExists(storagePath: string): Promise<boolean> {
    if (!isSupabaseReady()) return false;
    if (!storagePath || !storagePath.trim()) return false;

    const client = supabaseService.client!;
    const trimmedPath = storagePath.trim();

    try {
      const { data } = client.storage.from(BUCKET_NAME).getPublicUrl(trimmedPath);
      const response = await fetch(data.publicUrl, { method: 'HEAD' });

      if (response.ok) return true;
      if (response.status === 404) return false;

      if (response.status === 403) {
        // 私有桶:直链 403 → SDK download 第二判定(当前 public:true 下不会走到)
        const { error } = await client.storage.from(BUCKET_NAME).download(trimmedPath);
        return !error;
      }

      if (response.status === 405) {
        // 服务端不支持 HEAD → 退化 Range GET
        const rangeResponse = await fetch(data.publicUrl, { headers: { Range: 'bytes=0-0' } });
        return rangeResponse.ok || rangeResponse.status === 206;
      }

      return false;
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
    // 修复 5:补 username 过滤 + ilike 转义,堵 limit(1) 随机取到他人/旧的无路径行
    if (!cloudPathEl && !cloudPathMm && isSupabaseReady()) {
      try {
        const client = supabaseService.client!;
        const userName = supabaseService.userName;
        const base = client
          .from('sentences')
          .select('tts_audio_path_el, tts_audio_path_mm')
          .ilike('english', escapeLikePattern(trimmedText))
          .limit(1);
        const { data } = userName
          ? await base.eq('username', userName).single()
          : await base.single();
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
