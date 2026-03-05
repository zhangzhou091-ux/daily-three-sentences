
import { Sentence } from '../types';
import { DB_CONFIG } from '../constants';
import { normalizeEnglish } from '../utils/validators';

const DB_NAME = DB_CONFIG.NAME;
const DB_VERSION = DB_CONFIG.VERSION;
const STORE_NAME = DB_CONFIG.STORE_NAME;
const INIT_TIMEOUT = 10000;
const FALLBACK_STORAGE_KEY = 'd3s_fallback_sentences';
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 1000;

// 🔴 修复：增强错误处理工具类
class DBError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly originalError?: Error,
    public readonly isRecoverable: boolean = true
  ) {
    super(message);
    this.name = 'DBError';
  }
}

// 🔴 修复：重试机制工具函数
async function retryOperation<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = MAX_RETRY_COUNT
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt === maxRetries) {
        throw new DBError(
          `${operationName} failed after ${maxRetries} attempts: ${lastError.message}`,
          operationName,
          lastError,
          false
        );
      }
      
      if (import.meta.env.DEV) {
        console.warn(`🔄 ${operationName} attempt ${attempt} failed, retrying...`, lastError);
      }
      
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
    }
  }
  
  throw lastError || new Error(`${operationName} failed unexpectedly`);
}

// ✅ 修复：降级存储方案增强版本控制和数据一致性
class FallbackStorage {
  private memoryStore: Map<string, Sentence> = new Map();
  private isAvailable: boolean = true;
  private readonly DATA_VERSION = '1';
  private readonly VERSION_KEY = `${FALLBACK_STORAGE_KEY}_version`;
  private readonly LAST_SYNC_KEY = `${FALLBACK_STORAGE_KEY}_lastSync`;

  constructor() {
    this.loadFromLocalStorage();
  }

  private loadFromLocalStorage() {
    try {
      const savedVersion = localStorage.getItem(this.VERSION_KEY);
      if (!savedVersion || savedVersion !== this.DATA_VERSION) {
        if (savedVersion && savedVersion !== this.DATA_VERSION) {
          console.warn(`Fallback storage version mismatch: ${savedVersion} -> ${this.DATA_VERSION}, attempting migration`);
          this.migrateData(savedVersion);
        } else {
          console.log('Fallback storage: new installation, starting fresh');
        }
        localStorage.removeItem(FALLBACK_STORAGE_KEY);
        localStorage.removeItem(this.VERSION_KEY);
        localStorage.removeItem(this.LAST_SYNC_KEY);
        return;
      }

      const data = localStorage.getItem(FALLBACK_STORAGE_KEY);
      if (data) {
        const sentences: Sentence[] = JSON.parse(data);
        if (Array.isArray(sentences)) {
          sentences.forEach(s => {
            if (s && s.id) {
              this.memoryStore.set(s.id, s);
            }
          });
          console.log(`✅ Fallback storage loaded: ${sentences.length} sentences`);
        }
      }
    } catch (err) {
      console.warn('Fallback storage load failed:', err);
      this.isAvailable = false;
    }
  }

  private migrateData(fromVersion: string): void {
    try {
      const oldData = localStorage.getItem(FALLBACK_STORAGE_KEY);
      if (!oldData) return;

      const sentences: Sentence[] = JSON.parse(oldData);
      if (!Array.isArray(sentences) || sentences.length === 0) return;

      let migratedCount = 0;
      sentences.forEach(s => {
        if (s && s.id) {
          if (fromVersion === '0') {
            if (!s.updatedAt) {
              s.updatedAt = s.addedAt || Date.now();
            }
          }
          this.memoryStore.set(s.id, s);
          migratedCount++;
        }
      });

      if (migratedCount > 0) {
        this.saveToLocalStorage();
        console.log(`✅ Fallback storage migration complete: ${migratedCount} sentences migrated from v${fromVersion}`);
      }
    } catch (err) {
      console.warn('Fallback storage migration failed:', err);
    }
  }

  private saveToLocalStorage() {
    if (!this.isAvailable) return;
    try {
      const sentences = Array.from(this.memoryStore.values());
      const dataToSave = JSON.stringify(sentences);
      
      // 检查数据大小，避免超过 LocalStorage 限制（约 5MB）
      const dataSize = new Blob([dataToSave]).size;
      if (dataSize > 4 * 1024 * 1024) { // 4MB 警告阈值
        console.warn(`Fallback storage data size (${(dataSize / 1024 / 1024).toFixed(2)}MB) approaching limit`);
      }
      
      localStorage.setItem(FALLBACK_STORAGE_KEY, dataToSave);
      localStorage.setItem(this.VERSION_KEY, this.DATA_VERSION);
      localStorage.setItem(this.LAST_SYNC_KEY, Date.now().toString());
    } catch (err) {
      console.warn('Fallback storage save failed:', err);
      // 尝试清理旧数据后重试
      this.handleStorageError();
    }
  }

  private handleStorageError() {
    try {
      // 清理可能占用空间的其他数据
      const keysToClean = Object.keys(localStorage).filter(k => 
        k.startsWith('d3s_') && 
        !k.includes('fallback') && 
        !k.includes('config')
      );
      
      keysToClean.forEach(k => {
        try {
          localStorage.removeItem(k);
        } catch (e) {
          // 忽略单个删除错误
        }
      });
      
      // 重试保存
      const sentences = Array.from(this.memoryStore.values());
      localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(sentences));
      localStorage.setItem(this.VERSION_KEY, this.DATA_VERSION);
      console.log('✅ Fallback storage recovered after cleanup');
    } catch (retryErr) {
      console.error('Fallback storage recovery failed:', retryErr);
      this.isAvailable = false;
    }
  }

  // 获取最后同步时间
  getLastSyncTime(): number | null {
    try {
      const timeStr = localStorage.getItem(this.LAST_SYNC_KEY);
      return timeStr ? parseInt(timeStr, 10) : null;
    } catch {
      return null;
    }
  }

  async getAll(): Promise<Sentence[]> {
    return Array.from(this.memoryStore.values()).sort((a, b) => a.addedAt - b.addedAt);
  }

  async put(sentence: Sentence): Promise<void> {
    this.memoryStore.set(sentence.id, sentence);
    this.saveToLocalStorage();
  }

  async putAll(sentences: Sentence[]): Promise<void> {
    sentences.forEach(s => this.memoryStore.set(s.id, s));
    this.saveToLocalStorage();
  }

  async delete(id: string): Promise<void> {
    this.memoryStore.delete(id);
    this.saveToLocalStorage();
  }

  async clear(): Promise<void> {
    this.memoryStore.clear();
    if (this.isAvailable) {
      localStorage.removeItem(FALLBACK_STORAGE_KEY);
    }
  }

  async findByEnglish(english: string): Promise<Sentence | null> {
    const normalized = normalizeEnglish(english);
    for (const sentence of this.memoryStore.values()) {
      if (normalizeEnglish(sentence.english) === normalized) {
        return sentence;
      }
    }
    return null;
  }
}

class DBService {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<IDBDatabase | FallbackStorage> | null = null;
  private fallbackStorage: FallbackStorage | null = null;
  private useFallback: boolean = false;

  private isIndexedDBAvailable(): boolean {
    try {
      return typeof indexedDB !== 'undefined' && 
             indexedDB !== null &&
             typeof window !== 'undefined';
    } catch {
      return false;
    }
  }

  async init(): Promise<IDBDatabase | FallbackStorage> {
    // 如果已经在使用降级方案，直接返回
    if (this.useFallback && this.fallbackStorage) {
      return this.fallbackStorage;
    }

    if (this.db) return this.db;
    
    if (this.initPromise) {
      return this.initPromise;
    }

    // 检查 IndexedDB 是否可用
    if (!this.isIndexedDBAvailable()) {
      console.warn('IndexedDB not available, using fallback storage');
      this.useFallback = true;
      this.fallbackStorage = new FallbackStorage();
      return this.fallbackStorage;
    }

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<IDBDatabase | FallbackStorage> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // 超时时切换到降级方案
        console.warn('IndexedDB init timeout, switching to fallback');
        this.useFallback = true;
        this.fallbackStorage = new FallbackStorage();
        resolve(this.fallbackStorage);
      }, INIT_TIMEOUT);

      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          
          if (db.objectStoreNames.contains(STORE_NAME)) {
            db.deleteObjectStore(STORE_NAME);
          }
          
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          // ✅ 移除 english 字段的唯一索引，改为在应用层面处理重复
          store.createIndex('english', 'english', { unique: false });
          store.createIndex('intervalIndex', 'intervalIndex', { unique: false });
        };

        request.onsuccess = (event) => {
          clearTimeout(timeoutId);
          this.db = (event.target as IDBOpenDBRequest).result;
          resolve(this.db);
        };

        request.onerror = (event) => {
          clearTimeout(timeoutId);
          console.error('IndexedDB initialization failed, using fallback:', event);
          this.useFallback = true;
          this.fallbackStorage = new FallbackStorage();
          resolve(this.fallbackStorage);
        };

        request.onblocked = () => {
          clearTimeout(timeoutId);
          console.warn('IndexedDB blocked, using fallback storage');
          this.useFallback = true;
          this.fallbackStorage = new FallbackStorage();
          resolve(this.fallbackStorage);
        };
      } catch (err) {
        clearTimeout(timeoutId);
        console.error('IndexedDB error, using fallback:', err);
        this.useFallback = true;
        this.fallbackStorage = new FallbackStorage();
        resolve(this.fallbackStorage);
      }
    });
  }

  private async getStorage() {
    if (this.useFallback && this.fallbackStorage) {
      return this.fallbackStorage;
    }
    const storage = await this.init();
    if (storage instanceof FallbackStorage) {
      return storage;
    }
    return null; // 表示使用 IndexedDB
  }

  /**
   * Retrieves all sentences from the store with enhanced error handling.
   */
  async getAll(): Promise<Sentence[]> {
    return retryOperation(async () => {
      const fallback = await this.getStorage();
      if (fallback) {
        return fallback.getAll();
      }
      
      const db = this.db!;
      return new Promise((resolve, reject) => {
        try {
          const transaction = db.transaction(STORE_NAME, 'readonly');
          const store = transaction.objectStore(STORE_NAME);
          const request = store.getAll();

          request.onsuccess = () => {
            const result = request.result || [];
            if (import.meta.env.DEV) {
              console.log(`📊 getAll: retrieved ${result.length} sentences`);
            }
            resolve(result);
          };
          
          request.onerror = () => {
            const error = new DBError(
              `Failed to retrieve sentences: ${request.error?.message || 'Unknown error'}`,
              'getAll',
              request.error ? new Error(request.error.message) : undefined
            );
            reject(error);
          };
          
          transaction.onerror = () => {
            const error = new DBError(
              `Transaction error during retrieval: ${transaction.error?.message || 'Unknown error'}`,
              'getAll',
              transaction.error ? new Error(transaction.error.message) : undefined
            );
            reject(error);
          };
          
          transaction.onabort = () => {
            reject(new DBError('Transaction was aborted during getAll', 'getAll', undefined, true));
          };
        } catch (err) {
          reject(new DBError(
            'Unknown error during getAll',
            'getAll',
            err instanceof Error ? err : new Error(String(err))
          ));
        }
      });
    }, 'getAll');
  }

  /**
   * Adds or updates a single sentence with enhanced error handling.
   */
  async put(sentence: Sentence): Promise<void> {
    return retryOperation(async () => {
      const fallback = await this.getStorage();
      if (fallback) {
        return fallback.put(sentence);
      }
      
      const db = this.db!;
      return new Promise((resolve, reject) => {
        try {
          const transaction = db.transaction(STORE_NAME, 'readwrite');
          const store = transaction.objectStore(STORE_NAME);
          const request = store.put(sentence);

          request.onsuccess = () => {
            if (import.meta.env.DEV) {
              console.log(`✅ put: saved sentence "${sentence.english.substring(0, 30)}..."`);
            }
            resolve();
          };
          
          request.onerror = () => {
            const error = new DBError(
              `Failed to save sentence: ${request.error?.message || 'Unknown error'}`,
              'put',
              request.error ? new Error(request.error.message) : undefined
            );
            reject(error);
          };
          
          transaction.onerror = () => {
            const error = new DBError(
              `Transaction error during save: ${transaction.error?.message || 'Unknown error'}`,
              'put',
              transaction.error ? new Error(transaction.error.message) : undefined
            );
            reject(error);
          };
          
          transaction.onabort = () => {
            reject(new DBError('Transaction was aborted during put', 'put', undefined, true));
          };
        } catch (err) {
          reject(new DBError(
            'Unknown error during put',
            'put',
            err instanceof Error ? err : new Error(String(err))
          ));
        }
      });
    }, 'put');
  }

  /**
   * Bulk adds or updates multiple sentences within a single transaction.
   */
  async putAll(sentences: Sentence[]): Promise<void> {
    const fallback = await this.getStorage();
    if (fallback) {
      return fallback.putAll(sentences);
    }
    
    const db = this.db!;
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        sentences.forEach((s) => {
          const request = store.put(s);
          request.onerror = () => console.error(`Failed to put sentence ${s.id}:`, request.error);
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error(`Bulk save transaction failed: ${transaction.error?.message}`));
        transaction.onabort = () => reject(new Error('Bulk save transaction was aborted.'));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during putAll'));
      }
    });
  }

  /**
   * Deletes a sentence by ID.
   */
  async delete(id: string): Promise<void> {
    const fallback = await this.getStorage();
    if (fallback) {
      return fallback.delete(id);
    }
    
    const db = this.db!;
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error(`Failed to delete sentence: ${request.error?.message}`));
        transaction.onerror = () => reject(new Error(`Transaction error during deletion: ${transaction.error?.message}`));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during delete'));
      }
    });
  }

  async clear(): Promise<void> {
    const fallback = await this.getStorage();
    if (fallback) {
      return fallback.clear();
    }
    
    const db = this.db!;
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error(`Failed to clear store: ${request.error?.message}`));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error(`Transaction error during clear: ${transaction.error?.message}`));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during clear'));
      }
    });
  }

  async findByEnglish(english: string): Promise<Sentence | null> {
    const normalized = normalizeEnglish(english);
    const fallback = await this.getStorage();
    if (fallback) {
      return fallback.findByEnglish(normalized);
    }
    
    const db = this.db!;
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('english');
        const request = index.get(normalized);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(new Error(`Failed to find sentence: ${request.error?.message}`));
        transaction.onerror = () => reject(new Error(`Transaction error during find: ${transaction.error?.message}`));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during findByEnglish'));
      }
    });
  }

  async findDuplicates(): Promise<Map<string, Sentence[]>> {
    const all = await this.getAll();
    const grouped = new Map<string, Sentence[]>();
    
    all.forEach(s => {
      const key = normalizeEnglish(s.english);
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(s);
    });

    const duplicates = new Map<string, Sentence[]>();
    grouped.forEach((sentences, key) => {
      if (sentences.length > 1) {
        duplicates.set(key, sentences);
      }
    });
    
    return duplicates;
  }
}

export const dbService = new DBService();
