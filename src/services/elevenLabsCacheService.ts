/**
 * ElevenLabs 音频缓存服务
 *
 * 使用 IndexedDB 缓存 ElevenLabs TTS 生成的音频数据，
 * 相同文本+语音+模型的组合只需调用一次 API，后续直接从本地缓存播放，
 * 大幅减少 API 额度消耗。
 *
 * 缓存策略：
 * - 缓存键：text + voiceId + modelId 的哈希值（djb2 算法，低碰撞率）
 * - 存储格式：ArrayBuffer（iOS Safari 兼容，避免 Blob 存储缺陷）
 * - 每条缓存记录包含：音频 ArrayBuffer、文本摘要、创建时间、大小、命中次数
 * - 无过期时间：缓存永不过期，仅靠 LRU 容量淘汰管理
 * - 容量上限：100MB，超出时按 LRU 淘汰最旧记录
 * - 写入后验证：确保数据完整存储
 * - 支持缓存统计（条数、总大小）和手动清理
 * - 支持按文本内容跨语音模糊查找（findByText）
 *
 * iOS Safari 兼容性说明：
 * - iOS Safari < 15.2 存在 Blob 存储到 IndexedDB 的已知 bug
 * - 使用 ArrayBuffer 替代 Blob 存储可避免此问题
 * - 读取时将 ArrayBuffer 转回 Blob 供 Audio 元素播放
 */

const DB_NAME = 'D3S_ElevenLabs_Cache';
const DB_VERSION = 4;
const STORE_NAME = 'audio_cache';
const MAX_CACHE_SIZE = 100 * 1024 * 1024;

interface CacheRecord {
  key: string;
  audioData: ArrayBuffer;
  audioType: string;
  textPreview: string;
  voiceId: string;
  modelId: string;
  createdAt: number;
  size: number;
  hitCount: number;
  lastHitAt: number;
}

const isIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

const blobToArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('FileReader 未返回 ArrayBuffer'));
      }
    };
    reader.onerror = () => reject(new Error('Blob 转 ArrayBuffer 失败'));
    reader.readAsArrayBuffer(blob);
  });
};

const arrayBufferToBlob = (buffer: ArrayBuffer, type: string): Blob => {
  return new Blob([buffer], { type });
};

const generateCacheKey = (text: string, voiceId: string, modelId: string): string => {
  const raw = `${text.trim()}|${voiceId}|${modelId}`;
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(i);
    hash = hash & hash;
  }
  return `el_${Math.abs(hash).toString(36)}_${raw.length}`;
};

let dbInstance: IDBDatabase | null = null;
let dbInitPromise: Promise<IDBDatabase> | null = null;

const getDB = (): Promise<IDBDatabase> => {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        dbInitPromise = null;
        reject(new Error('音频缓存数据库打开失败'));
      };

      request.onsuccess = () => {
        dbInstance = request.result;

        dbInstance.onversionchange = () => {
          dbInstance?.close();
          dbInstance = null;
        };

        dbInstance.onerror = (event) => {
          console.warn('🔊 [ElevenLabs缓存] IndexedDB 运行时错误:', event);
          dbInstance = null;
          dbInitPromise = null;
        };

        if (isIOS()) {
          console.log('🔊 [ElevenLabs缓存] iOS 环境，使用 ArrayBuffer 存储模式');
        }

        resolve(dbInstance);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('voiceId', 'voiceId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('lastHitAt', 'lastHitAt', { unique: false });
        } else if (oldVersion < 4) {
          console.log(`🔊 [ElevenLabs缓存] 数据库升级 v${oldVersion} → v${DB_VERSION}，清理 PCM→WAV 坏缓存`);
          const tx = (event.target as IDBOpenDBRequest).transaction;
          if (tx) {
            const store = tx.objectStore(STORE_NAME);
            store.clear();
          }
        }
      };

      request.onblocked = () => {
        console.warn('🔊 [ElevenLabs缓存] 数据库升级被阻塞，请关闭其他标签页');
        dbInitPromise = null;
      };
    } catch (err) {
      dbInitPromise = null;
      reject(err);
    }
  });

  return dbInitPromise;
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
          if (!record) {
            resolve(null);
            return;
          }

          if (!record.audioData || !(record.audioData instanceof ArrayBuffer)) {
            console.warn(`🔊 [ElevenLabs缓存] 缓存数据格式异常，清理 | [key] ${key}`);
            store.delete(key);
            resolve(null);
            return;
          }

          if (record.audioData.byteLength === 0) {
            console.warn(`🔊 [ElevenLabs缓存] 缓存数据为空，清理 | [key] ${key}`);
            store.delete(key);
            resolve(null);
            return;
          }

          record.hitCount = (record.hitCount || 0) + 1;
          record.lastHitAt = Date.now();
          try {
            store.put(record);
          } catch {
            console.warn('🔊 [ElevenLabs缓存] 更新命中信息失败（不影响读取）');
          }

          const blob = arrayBufferToBlob(record.audioData, record.audioType || 'audio/mpeg');
          console.log(`🔊 [ElevenLabs缓存] 命中 | [key] ${key} | [大小] ${this.formatSize(record.size)} | [命中] ${record.hitCount}次`);
          resolve(blob);
        };

        request.onerror = () => {
          console.warn('🔊 [ElevenLabs缓存] 读取失败');
          resolve(null);
        };
      });
    } catch (err) {
      console.warn('🔊 [ElevenLabs缓存] get 异常:', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  async put(text: string, voiceId: string, modelId: string, audioBlob: Blob): Promise<boolean> {
    try {
      if (!audioBlob || audioBlob.size === 0) {
        console.warn('🔊 [ElevenLabs缓存] 跳过空音频缓存');
        return false;
      }

      const audioData = await blobToArrayBuffer(audioBlob);
      if (!audioData || audioData.byteLength === 0) {
        console.warn('🔊 [ElevenLabs缓存] Blob 转 ArrayBuffer 失败，跳过缓存');
        return false;
      }

      const db = await getDB();
      const key = generateCacheKey(text, voiceId, modelId);

      const record: CacheRecord = {
        key,
        audioData,
        audioType: audioBlob.type || 'audio/mpeg',
        textPreview: text.trim().slice(0, 80),
        voiceId,
        modelId,
        createdAt: Date.now(),
        size: audioData.byteLength,
        hitCount: 0,
        lastHitAt: Date.now(),
      };

      return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        const getAllReq = store.getAll();
        getAllReq.onsuccess = () => {
          const records = getAllReq.result as CacheRecord[];
          let totalSize = 0;
          for (const r of records) {
            totalSize += r.size || 0;
          }

          const existingIdx = records.findIndex(r => r.key === key);
          if (existingIdx >= 0) {
            totalSize -= records[existingIdx].size || 0;
          }

          if (totalSize + record.size > MAX_CACHE_SIZE) {
            const sorted = [...records]
              .filter(r => r.key !== key)
              .sort((a, b) => (a.lastHitAt || a.createdAt) - (b.lastHitAt || b.createdAt));

            let freed = 0;
            const toDelete: string[] = [];
            for (const r of sorted) {
              if (totalSize + record.size - freed <= MAX_CACHE_SIZE * 0.8) break;
              freed += r.size || 0;
              toDelete.push(r.key);
            }

            for (const k of toDelete) {
              store.delete(k);
            }

            if (toDelete.length > 0) {
              console.log(`🔊 [ElevenLabs缓存] LRU淘汰 ${toDelete.length} 条，释放 ${this.formatSize(freed)}`);
            }
          }

          const putReq = store.put(record);
          putReq.onsuccess = () => {
            console.log(`🔊 [ElevenLabs缓存] 已存储 | [key] ${key} | [大小] ${this.formatSize(record.size)}`);

            if (isIOS()) {
              this.verify(key).then((valid) => {
                if (!valid) {
                  console.warn('🔊 [ElevenLabs缓存] iOS 写入验证失败，可能存储空间不足');
                }
              });
            }

            resolve(true);
          };
          putReq.onerror = () => {
            console.warn('🔊 [ElevenLabs缓存] 写入失败');
            resolve(false);
          };
        };
        getAllReq.onerror = () => {
          const putReq = store.put(record);
          putReq.onsuccess = () => resolve(true);
          putReq.onerror = () => resolve(false);
        };
      });
    } catch (err) {
      console.warn('🔊 [ElevenLabs缓存] put 异常:', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  async getStale(text: string, voiceId: string, modelId: string): Promise<Blob | null> {
    return this.get(text, voiceId, modelId);
  },

  async findByVoice(voiceId: string, modelId: string): Promise<Blob | null> {
    try {
      const db = await getDB();

      return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('voiceId');
        const request = index.getAll(voiceId);

        request.onsuccess = () => {
          const records = request.result as CacheRecord[];
          const matching = records
            .filter(r => r.modelId === modelId && r.audioData && r.audioData instanceof ArrayBuffer && r.audioData.byteLength > 0)
            .sort((a, b) => b.lastHitAt - a.lastHitAt);

          if (matching.length === 0) {
            resolve(null);
            return;
          }

          const record = matching[0];
          const blob = arrayBufferToBlob(record.audioData, record.audioType || 'audio/mpeg');
          console.log(`🔊 [ElevenLabs缓存] 语音回退 | [voiceId] ${voiceId} | [textPreview] ${record.textPreview}`);
          resolve(blob);
        };

        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  },

  async verify(key: string): Promise<boolean> {
    try {
      const db = await getDB();
      return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);

        request.onsuccess = () => {
          const record = request.result as CacheRecord | undefined;
          if (!record || !record.audioData || !(record.audioData instanceof ArrayBuffer) || record.audioData.byteLength === 0) {
            resolve(false);
            return;
          }
          resolve(true);
        };
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

  async deleteByText(text: string): Promise<number> {
    try {
      const db = await getDB();
      const textPreview = text.trim().slice(0, 80);

      return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getAllReq = store.getAll();

        getAllReq.onsuccess = () => {
          const records = getAllReq.result as CacheRecord[];
          const toDelete = records.filter(r => r.textPreview === textPreview);

          for (const r of toDelete) {
            store.delete(r.key);
          }

          if (toDelete.length > 0) {
            console.log(`🔊 [ElevenLabs缓存] 按文本删除 | [text] ${textPreview} | [条数] ${toDelete.length}`);
          }
          resolve(toDelete.length);
        };

        getAllReq.onerror = () => resolve(0);
      });
    } catch {
      return 0;
    }
  },

  async findByText(text: string): Promise<Blob | null> {
    try {
      const db = await getDB();
      const textPreview = text.trim().slice(0, 80);

      return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getAllReq = store.getAll();

        getAllReq.onsuccess = () => {
          const records = getAllReq.result as CacheRecord[];
          const matching = records
            .filter(r => r.textPreview === textPreview && r.audioData && r.audioData instanceof ArrayBuffer && r.audioData.byteLength > 0)
            .sort((a, b) => (b.lastHitAt || b.createdAt) - (a.lastHitAt || a.createdAt));

          if (matching.length === 0) {
            resolve(null);
            return;
          }

          const record = matching[0];
          record.hitCount = (record.hitCount || 0) + 1;
          record.lastHitAt = Date.now();
          try { store.put(record); } catch { /* ignore */ }

          const blob = arrayBufferToBlob(record.audioData, record.audioType || 'audio/mpeg');
          console.log(`🔊 [ElevenLabs缓存] 文本模糊命中 | [voiceId] ${record.voiceId} | [modelId] ${record.modelId} | [命中] ${record.hitCount}次`);
          resolve(blob);
        };

        getAllReq.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  },

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  },
};

export default elevenLabsCacheService;
