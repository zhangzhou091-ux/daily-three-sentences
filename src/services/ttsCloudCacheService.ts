import { supabaseService } from './supabaseService';

export type TTSEngineType = 'elevenlabs' | 'minimax';

const BUCKET_NAME = 'tts-audio-cache';

const generateStoragePath = (engine: TTSEngineType, cacheKey: string): string => {
  return `${engine}/${cacheKey}.mp3`;
};

const generateCloudCacheKey = (text: string, voice: string, engine: TTSEngineType): string => {
  const raw = `${text.trim()}|${engine}|${voice}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `${engine}_${Math.abs(hash).toString(36)}_${raw.length}`;
};

const isSupabaseReady = (): boolean => {
  return supabaseService.isReady && !!supabaseService.client;
};

export const ttsCloudCacheService = {
  async get(
    text: string,
    voice: string,
    engine: TTSEngineType
  ): Promise<Blob | null> {
    if (!isSupabaseReady()) {
      return null;
    }

    const client = supabaseService.client!;
    const cacheKey = generateCloudCacheKey(text, voice, engine);
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

      console.log(`🔊 [CloudCache] 云端命中 | [${engine}] [语音] ${voice} | [大小] ${this.formatSize(data.size)}`);
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
    audioBlob: Blob
  ): Promise<boolean> {
    if (!isSupabaseReady()) {
      return false;
    }

    const client = supabaseService.client!;
    const cacheKey = generateCloudCacheKey(text, voice, engine);
    const path = generateStoragePath(engine, cacheKey);

    try {
      const { error } = await client.storage
        .from(BUCKET_NAME)
        .upload(path, audioBlob, {
          contentType: 'audio/mpeg',
          upsert: true,
        });

      if (error) {
        if (error.message?.includes('Bucket not found') || error.message?.includes('does not exist')) {
          console.warn(`🔊 [CloudCache] 存储桶 "${BUCKET_NAME}" 不存在，正在自动创建...`);
          const createResult = await this.ensureBucket();
          if (!createResult.success) {
            console.warn(`🔊 [CloudCache] 存储桶创建失败: ${createResult.message}`);
            return false;
          }
          console.log(`🔊 [CloudCache] 存储桶 "${BUCKET_NAME}" 创建成功，重新上传...`);
          const { error: retryError } = await client.storage
            .from(BUCKET_NAME)
            .upload(path, audioBlob, {
              contentType: 'audio/mpeg',
              upsert: true,
            });
          if (retryError) {
            console.warn(`🔊 [CloudCache] 重新上传失败 [${engine}]:`, retryError.message);
            return false;
          }
        } else {
          console.warn(`🔊 [CloudCache] 上传失败 [${engine}]:`, error.message);
          return false;
        }
      }

      console.log(`🔊 [CloudCache] 已上传 | [${engine}] [语音] ${voice} | [大小] ${this.formatSize(audioBlob.size)}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`🔊 [CloudCache] 上传异常 [${engine}]:`, msg);
      return false;
    }
  },

  async delete(
    text: string,
    voice: string,
    engine: TTSEngineType
  ): Promise<boolean> {
    if (!isSupabaseReady()) {
      return false;
    }

    const client = supabaseService.client!;
    const cacheKey = generateCloudCacheKey(text, voice, engine);
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
    if (!isSupabaseReady()) {
      return { success: false, message: 'Supabase 未配置' };
    }

    const client = supabaseService.client!;

    try {
      const { data, error } = await client.storage.listBuckets();

      if (error) {
        return { success: false, message: `无法列出存储桶: ${error.message}` };
      }

      const exists = (data || []).some(b => b.name === BUCKET_NAME);

      if (exists) {
        return { success: true, message: `存储桶 "${BUCKET_NAME}" 已存在` };
      }

      const { error: createError } = await client.storage.createBucket(BUCKET_NAME, {
        public: false,
        fileSizeLimit: 5242880,
      });

      if (createError) {
        return { success: false, message: `创建存储桶失败: ${createError.message}` };
      }

      return { success: true, message: `存储桶 "${BUCKET_NAME}" 创建成功` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `检查存储桶异常: ${msg}` };
    }
  },

  isAvailable(): boolean {
    return isSupabaseReady();
  },

  getBucketName(): string {
    return BUCKET_NAME;
  },

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  },
};

export default ttsCloudCacheService;
