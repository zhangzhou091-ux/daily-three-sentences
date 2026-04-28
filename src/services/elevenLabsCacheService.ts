/**
 * ElevenLabs 音频缓存服务
 *
 * 使用 IndexedDB 缓存 ElevenLabs TTS 生成的音频数据，
 * 相同文本+语音+模型的组合只需调用一次 API，后续直接从本地缓存播放，
 * 大幅减少 API 额度消耗。
 *
 * 缓存策略：
 * - 缓存键：text + voiceId + modelId 的哈希值
 * - 每条缓存记录包含：音频 Blob、文本摘要、创建时间、大小
 * - 支持缓存统计（条数、总大小）和批量清理
 * - 自动清理超过 30 天的旧缓存
 */

const DB_NAME = 'D3S_ElevenLabs_Cache';
const DB_VERSION = 1;
const STORE_NAME = 'audio_cache';

interface CacheRecord {
  key: string;
  audioBlob: Blob;
  textPreview: string;
  voiceId: string;
  modelId: string;
  createdAt: number;
  size: number;
  hitCount: number;
  lastHitAt: number;
}

const generateCacheKey = (text: string, voiceId: string, modelId: string): string => {
  const raw = `${text.trim()}|${voiceId}|${modelId}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `el_${Math.abs(hash).toString(36)}_${raw.length}`;
};

let dbInstance: IDBDatabase | null = null;

const getDB = (): Promise<IDBDatabase> => {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(new Error('音频缓存数据库打开失败'));

    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('voiceId', 'voiceId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
  });
};

export const elevenLabsCacheService = {
  async get(text: string, voiceId: string, modelId: string): Promise<Blob | null> {
    try {
      const db = await getDB();
      const key = generateCacheKey(text, voiceId, modelId);

      return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);

        request.onsuccess = () => {
          const record = request.result as CacheRecord | undefined;
          if (!record || !record.audioBlob) {
            resolve(null);
            return;
          }

          record.hitCount = (record.hitCount || 0) + 1;
          record.lastHitAt = Date.now();
          store.put(record);

          resolve(record.audioBlob);
        };

        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  },

  async put(text: string, voiceId: string, modelId: string, audioBlob: Blob): Promise<boolean> {
    try {
      const db = await getDB();
      const key = generateCacheKey(text, voiceId, modelId);

      const record: CacheRecord = {
        key,
        audioBlob,
        textPreview: text.trim().slice(0, 80),
        voiceId,
        modelId,
        createdAt: Date.now(),
        size: audioBlob.size,
        hitCount: 0,
        lastHitAt: Date.now(),
      };

      return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.put(record);

        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  },

  async getStats(): Promise<{ count: number; totalSize: number; oldestAt: number | null }> {
    try {
      const db = await getDB();

      return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
          const records = request.result as CacheRecord[];
          let totalSize = 0;
          let oldestAt: number | null = null;

          for (const r of records) {
            totalSize += r.size || 0;
            if (!oldestAt || r.createdAt < oldestAt) {
              oldestAt = r.createdAt;
            }
          }

          resolve({ count: records.length, totalSize, oldestAt });
        };

        request.onerror = () => resolve({ count: 0, totalSize: 0, oldestAt: null });
      });
    } catch {
      return { count: 0, totalSize: 0, oldestAt: null };
    }
  },

  async clearAll(): Promise<number> {
    try {
      const db = await getDB();
      const stats = await this.getStats();

      return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => resolve(stats.count);
        request.onerror = () => resolve(0);
      });
    } catch {
      return 0;
    }
  },

  async cleanupOld(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    try {
      const db = await getDB();
      const cutoff = Date.now() - maxAgeMs;

      return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('createdAt');
        const range = IDBKeyRange.upperBound(cutoff);
        const request = index.openCursor(range);

        let deleted = 0;
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result;
          if (cursor) {
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            resolve(deleted);
          }
        };

        request.onerror = () => resolve(0);
      });
    } catch {
      return 0;
    }
  },

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  },
};

export default elevenLabsCacheService;
