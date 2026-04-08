import { Sentence } from '../types';
import { DB_CONFIG } from '../constants';
import { normalizeEnglish } from '../utils/validators';
import { logger } from '../utils/logger';

const DB_NAME = DB_CONFIG.NAME;
const DB_VERSION = DB_CONFIG.VERSION;
const STORE_NAME = DB_CONFIG.STORE_NAME;
const INIT_TIMEOUT = 10000;
const FALLBACK_STORAGE_KEY = 'd3s_fallback_sentences';
const FALLBACK_METADATA_KEY = 'd3s_fallback_metadata';
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 1000;

const LOCALSTORAGE_SAFE_SIZE = 4 * 1024 * 1024;
const FALLBACK_MAX_SENTENCES = 500;

interface MigrationResult {
  success: boolean;
  totalSource: number;
  totalMigrated: number;
  truncated: boolean;
  error?: string;
}

interface FallbackMetadata {
  version: number;
  timestamp: number;
  checksum: string;
  sourceCount: number;
  truncated: boolean;
}

type StorageEventType = 'migrationSuccess' | 'migrationWarning' | 'migrationError' | 'storageFull' | 'truncationRequired' | 'truncationWarning';

interface D3SStorageEvent {
  type: StorageEventType;
  message: string;
  details?: {
    totalSource?: number;
    totalMigrated?: number;
    truncated?: boolean;
    requiresAction?: boolean;
    estimatedKeep?: number;
  };
}

type TruncationStrategy = 'recent' | 'important' | 'cancel';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  version: number;
}

class DataCache {
  private cache: Map<string, CacheEntry<Sentence>> = new Map();
  private allDataCache: CacheEntry<Sentence[]> | null = null;
  private readonly TTL = 30000;
  private readonly MAX_SIZE = 1000;
  private version = 0;
  private dbVersion = 0;
  private readonly DB_VERSION_KEY = 'd3s_db_version';
  private syncChannel: BroadcastChannel | null = null;
  private versionPollingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly VERSION_POLLING_INTERVAL = 2000;

  constructor() {
    this.setupCrossTabSync();
    this.startVersionPolling();
    this.setupVisibilityListener();
  }

  private setupCrossTabSync(): void {
    if (typeof window === 'undefined') return;
    
    try {
      this.syncChannel = new BroadcastChannel('d3s_db_sync');
      this.syncChannel.onmessage = (event) => {
        const { type, id, version } = event.data;
        
        if (version && version < this.dbVersion) {
          logger.debug('跨标签页同步: 忽略旧版本消息', { 
            messageVersion: version, 
            currentVersion: this.dbVersion 
          });
          return;
        }
        
        switch (type) {
          case 'INVALIDATE_ALL':
            this.invalidateAll();
            logger.debug('跨标签页同步: 收到INVALIDATE_ALL消息，缓存已失效');
            break;
          case 'INVALIDATE_ONE':
            if (id) {
              this.cache.delete(id);
              this.allDataCache = null;
              logger.debug('跨标签页同步: 收到INVALIDATE_ONE消息', { id });
            }
            break;
        }
      };
    } catch (err) {
      logger.warn('BroadcastChannel 不支持，回退到 storage 事件');
      window.addEventListener('storage', (e: StorageEvent) => {
        if (e.key === this.DB_VERSION_KEY && e.newValue) {
          const newVersion = parseInt(e.newValue, 10);
          if (!isNaN(newVersion) && newVersion > this.dbVersion) {
            this.dbVersion = newVersion;
            this.invalidateAll();
            logger.debug('跨标签页同步: 检测到数据变更，缓存已失效', { newVersion });
          }
        }
      });
    }
  }

  private startVersionPolling(): void {
    if (typeof window === 'undefined') return;
    
    this.versionPollingTimer = setInterval(() => {
      this.checkVersionChange();
    }, this.VERSION_POLLING_INTERVAL);
  }

  private setupVisibilityListener(): void {
    if (typeof window === 'undefined') return;
    
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.checkVersionChange();
      }
    });
  }

  private checkVersionChange(): void {
    try {
      const storedVersion = localStorage.getItem(this.DB_VERSION_KEY);
      if (storedVersion) {
        const newVersion = parseInt(storedVersion, 10);
        if (!isNaN(newVersion) && newVersion > this.dbVersion) {
          logger.debug('版本轮询: 检测到版本变更', { 
            oldVersion: this.dbVersion, 
            newVersion 
          });
          this.dbVersion = newVersion;
          this.invalidateAll();
        }
      }
    } catch {
      // 忽略存储读取错误
    }
  }

  private broadcast(type: string, id?: string): void {
    if (this.syncChannel) {
      try {
        this.syncChannel.postMessage({ type, id, version: this.dbVersion });
      } catch (err) {
        logger.warn('广播消息失败', { error: String(err) });
      }
    }
  }

  private bumpDbVersion(): void {
    this.dbVersion = Date.now();
    this.version++;
    try {
      localStorage.setItem(this.DB_VERSION_KEY, this.dbVersion.toString());
    } catch {
      // 忽略存储错误
    }
  }

  get(id: string): Sentence | null {
    const entry = this.cache.get(id);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.TTL) {
      this.cache.delete(id);
      return null;
    }
    return entry.data;
  }

  set(sentence: Sentence): void {
    this.version++;
    this.cache.set(sentence.id, {
      data: sentence,
      timestamp: Date.now(),
      version: this.version
    });
    this.invalidateAllCache();
    this.evictIfNeeded();
    this.bumpDbVersion();
    this.broadcast('INVALIDATE_ONE', sentence.id);
  }

  getAll(): Sentence[] | null {
    if (!this.allDataCache) return null;
    if (Date.now() - this.allDataCache.timestamp > this.TTL) {
      this.allDataCache = null;
      return null;
    }
    return this.allDataCache.data;
  }

  setAll(sentences: Sentence[]): void {
    this.version++;
    this.allDataCache = {
      data: sentences,
      timestamp: Date.now(),
      version: this.version
    };
    sentences.forEach(s => {
      this.cache.set(s.id, {
        data: s,
        timestamp: Date.now(),
        version: this.version
      });
    });
    this.evictIfNeeded();
    this.bumpDbVersion();
  }

  delete(id: string): void {
    this.version++;
    this.cache.delete(id);
    this.invalidateAllCache();
    this.bumpDbVersion();
  }

  clear(): void {
    this.version++;
    this.cache.clear();
    this.allDataCache = null;
    this.bumpDbVersion();
  }

  invalidate(id: string): void {
    this.cache.delete(id);
    this.invalidateAllCache();
  }

  invalidateAll(): void {
    this.cache.clear();
    this.allDataCache = null;
  }

  getAllValues(): Sentence[] {
    return Array.from(this.cache.values()).map(entry => entry.data);
  }

  private invalidateAllCache(): void {
    this.allDataCache = null;
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= this.MAX_SIZE) return;
    
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toEvict = entries.slice(0, Math.floor(this.MAX_SIZE * 0.2));
    toEvict.forEach(([id]) => this.cache.delete(id));
    
    logger.debug('缓存淘汰', { evicted: toEvict.length, remaining: this.cache.size });
  }

  getStats(): { size: number; hitRate: number; dbVersion: number } {
    return {
      size: this.cache.size,
      hitRate: 0,
      dbVersion: this.dbVersion
    };
  }

  destroy(): void {
    if (this.versionPollingTimer) {
      clearInterval(this.versionPollingTimer);
      this.versionPollingTimer = null;
    }
    if (this.syncChannel) {
      this.syncChannel.close();
      this.syncChannel = null;
    }
  }
}

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
      
      logger.debug(`${operationName} 尝试失败，正在重试`, { attempt, error: String(lastError) });
      
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
    }
  }
  
  throw lastError || new Error(`${operationName} failed unexpectedly`);
}

class FallbackStorage {
  private memoryStore: Map<string, Sentence> = new Map();
  private isAvailable: boolean = true;
  private readonly DATA_VERSION = '1';
  private readonly VERSION_KEY = `${FALLBACK_STORAGE_KEY}_version`;
  private readonly LAST_SYNC_KEY = `${FALLBACK_STORAGE_KEY}_lastSync`;
  private readonly MAX_SENTENCES = 1000;

  constructor() {
    this.loadFromLocalStorage();
  }

  private enforceLimit(): void {
    if (this.memoryStore.size <= this.MAX_SENTENCES) return;
    
    const entries = Array.from(this.memoryStore.entries())
      .sort((a, b) => (a[1].updatedAt || a[1].addedAt || 0) - (b[1].updatedAt || b[1].addedAt || 0));
    
    const toRemove = entries.slice(0, this.memoryStore.size - this.MAX_SENTENCES);
    toRemove.forEach(([id]) => this.memoryStore.delete(id));
    
    logger.warn('Fallback storage 已达上限，自动清理旧数据', { removed: toRemove.length });
  }

  private loadFromLocalStorage() {
    try {
      const savedVersion = localStorage.getItem(this.VERSION_KEY);
      if (!savedVersion || savedVersion !== this.DATA_VERSION) {
        if (savedVersion && savedVersion !== this.DATA_VERSION) {
          logger.warn('Fallback storage 版本不匹配，尝试迁移', { from: savedVersion, to: this.DATA_VERSION });
          this.migrateData(savedVersion);
        } else {
          logger.debug('Fallback storage: 新安装');
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
          logger.debug('Fallback storage 加载完成', { count: sentences.length });
        }
      }
    } catch (err) {
      logger.warn('Fallback storage 加载失败', { error: String(err) });
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
        logger.info('Fallback storage 迁移完成', { count: migratedCount, fromVersion });
      }
    } catch (err) {
      logger.warn('Fallback storage 迁移失败', { error: String(err) });
    }
  }

  private saveToLocalStorage(): boolean {
    if (!this.isAvailable) return false;
    try {
      const sentences = Array.from(this.memoryStore.values());
      const dataToSave = JSON.stringify(sentences);
      
      const dataSize = new Blob([dataToSave]).size;
      if (dataSize > 4 * 1024 * 1024) {
        logger.warn('Fallback storage 数据大小接近限制', { sizeMB: (dataSize / 1024 / 1024).toFixed(2) });
      }
      
      localStorage.setItem(FALLBACK_STORAGE_KEY, dataToSave);
      localStorage.setItem(this.VERSION_KEY, this.DATA_VERSION);
      localStorage.setItem(this.LAST_SYNC_KEY, Date.now().toString());
      return true;
    } catch (err) {
      logger.warn('Fallback storage 保存失败', { error: String(err) });
      this.handleStorageError();
      return false;
    }
  }

  private handleStorageError() {
    try {
      const keysToClean = Object.keys(localStorage).filter(k => 
        k.startsWith('d3s_') && 
        !k.includes('fallback') && 
        !k.includes('config')
      );
      
      keysToClean.forEach(k => {
        try {
          localStorage.removeItem(k);
        } catch {
          // 忽略单个删除错误
        }
      });
      
      const sentences = Array.from(this.memoryStore.values());
      localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(sentences));
      localStorage.setItem(this.VERSION_KEY, this.DATA_VERSION);
      logger.info('Fallback storage 清理后恢复成功');
    } catch (retryErr) {
      logger.error('Fallback storage 恢复失败', { error: String(retryErr) });
      this.isAvailable = false;
    }
  }

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
    this.enforceLimit();
    const success = this.saveToLocalStorage();
    if (!success) {
      this.memoryStore.delete(sentence.id);
      throw new Error('Fallback storage 保存失败');
    }
  }

  async putAll(sentences: Sentence[]): Promise<void> {
    const previousData = new Map(this.memoryStore);
    sentences.forEach(s => this.memoryStore.set(s.id, s));
    this.enforceLimit();
    const success = this.saveToLocalStorage();
    if (!success) {
      this.memoryStore = previousData;
      throw new Error('Fallback storage 批量保存失败');
    }
  }

  async delete(id: string): Promise<void> {
    const previousData = this.memoryStore.get(id);
    this.memoryStore.delete(id);
    const success = this.saveToLocalStorage();
    if (!success && previousData) {
      this.memoryStore.set(id, previousData);
      throw new Error('Fallback storage 删除保存失败');
    }
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
  private initStarted: boolean = false;
  private cache: DataCache = new DataCache();
  private truncationPending: boolean = false;
  private pendingMigrationData: Sentence[] = [];
  private writingPromise: Promise<void> = Promise.resolve();

  getTruncationPending(): boolean {
    return this.truncationPending;
  }

  getPendingMigrationData(): Sentence[] {
    return this.pendingMigrationData;
  }

  calculateImportance(s: Sentence): number {
    let score = 0;
    
    if (s.intervalIndex > 0 && s.intervalIndex < 5) score += 100;
    
    if (s.learnedAt && Date.now() - s.learnedAt < 7 * 24 * 60 * 60 * 1000) score += 50;
    
    score += Math.min(s.timesReviewed || 0, 20) * 2;
    
    if (s.isManual) score += 30;
    
    return score;
  }

  private mergeDataSources(dbData: Sentence[], cachedData: Sentence[]): Sentence[] {
    const mergedMap = new Map<string, Sentence>();
    
    dbData.forEach(s => {
      if (s && s.id) {
        mergedMap.set(s.id, s);
      }
    });
    
    cachedData.forEach(s => {
      if (s && s.id) {
        const existing = mergedMap.get(s.id);
        if (!existing || (s.updatedAt || 0) > (existing.updatedAt || 0)) {
          mergedMap.set(s.id, s);
        }
      }
    });
    
    return Array.from(mergedMap.values());
  }

  async confirmTruncation(strategy: TruncationStrategy): Promise<boolean> {
    if (!this.truncationPending || this.pendingMigrationData.length === 0) {
      return false;
    }

    if (strategy === 'cancel') {
      this.truncationPending = false;
      this.pendingMigrationData = [];
      logger.info('用户取消数据截断迁移');
      return false;
    }

    let dataToSave: Sentence[];
    
    if (strategy === 'recent') {
      dataToSave = [...this.pendingMigrationData]
        .sort((a, b) => (b.updatedAt || b.addedAt || 0) - (a.updatedAt || a.addedAt || 0))
        .slice(0, FALLBACK_MAX_SENTENCES);
    } else {
      dataToSave = [...this.pendingMigrationData]
        .map(s => ({ s, score: this.calculateImportance(s) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, FALLBACK_MAX_SENTENCES)
        .map(item => item.s);
    }

    const migrationResult = this.executeMigration(dataToSave, this.pendingMigrationData.length);
    
    if (migrationResult.success) {
      this.emitStorageEvent({
        type: 'migrationSuccess',
        message: `数据迁移完成，保留了 ${migrationResult.totalMigrated} 条数据`,
        details: {
          totalSource: migrationResult.totalSource,
          totalMigrated: migrationResult.totalMigrated,
          truncated: migrationResult.truncated
        }
      });
    }

    this.truncationPending = false;
    this.pendingMigrationData = [];
    this.fallbackStorage = new FallbackStorage();
    
    return migrationResult.success;
  }

  private executeMigration(dataToSave: Sentence[], totalSource: number): MigrationResult {
    try {
      const serializedData = JSON.stringify(dataToSave);
      localStorage.setItem(FALLBACK_STORAGE_KEY, serializedData);

      const verifyString = localStorage.getItem(FALLBACK_STORAGE_KEY);
      if (!verifyString) {
        throw new Error('写入后读取为空');
      }

      const verifyData: Sentence[] = JSON.parse(verifyString);
      if (verifyData.length !== dataToSave.length) {
        throw new Error(`校验失败：期望 ${dataToSave.length} 条，实际存入 ${verifyData.length} 条`);
      }

      const checksum = this.calculateChecksum(serializedData);
      const metadata: FallbackMetadata = {
        version: 1,
        timestamp: Date.now(),
        checksum,
        sourceCount: totalSource,
        truncated: totalSource > dataToSave.length
      };
      localStorage.setItem(FALLBACK_METADATA_KEY, JSON.stringify(metadata));

      logger.info('迁移执行成功', {
        totalSource,
        totalMigrated: dataToSave.length,
        truncated: totalSource > dataToSave.length
      });

      return {
        success: true,
        totalSource,
        totalMigrated: dataToSave.length,
        truncated: totalSource > dataToSave.length
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('迁移执行失败', { error: errorMessage });
      return {
        success: false,
        totalSource,
        totalMigrated: 0,
        truncated: false,
        error: errorMessage
      };
    }
  }

  private isIndexedDBAvailable(): boolean {
    try {
      return typeof indexedDB !== 'undefined' && 
             indexedDB !== null &&
             typeof window !== 'undefined';
    } catch {
      return false;
    }
  }

  private async ensureDB(): Promise<IDBDatabase | FallbackStorage> {
    if (this.useFallback && this.fallbackStorage) {
      return this.fallbackStorage;
    }

    if (this.db) return this.db;
    
    if (this.initPromise) {
      return this.initPromise;
    }

    return this.init();
  }

  async init(): Promise<IDBDatabase | FallbackStorage> {
    if (this.useFallback && this.fallbackStorage) {
      return this.fallbackStorage;
    }

    if (this.db) return this.db;
    
    if (this.initPromise) {
      return this.initPromise;
    }

    if (!this.isIndexedDBAvailable()) {
      logger.warn('IndexedDB 不可用，使用降级存储');
      this.useFallback = true;
      this.fallbackStorage = new FallbackStorage();
      return this.fallbackStorage;
    }

    this.initStarted = true;
    this.initPromise = this.doInit().catch(err => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<IDBDatabase | FallbackStorage> {
    return new Promise((resolve, reject) => {
      const switchToFallback = async () => {
        this.useFallback = true;
        
        let dbSentences: Sentence[] = [];
        
        if (this.db) {
          try {
            dbSentences = await this.readAllFromIndexedDB(this.db);
            logger.info('从 IndexedDB 读取数据用于迁移', { count: dbSentences.length });
          } catch (err) {
            logger.error('从 IndexedDB 读取数据失败，尝试从缓存和 localStorage 恢复', { error: String(err) });
          }
        }
        
        const cachedData = this.cache.getAllValues();
        let allSentences = this.mergeDataSources(dbSentences, cachedData);
        
        if (allSentences.length === 0) {
          try {
            const existingData = localStorage.getItem(FALLBACK_STORAGE_KEY);
            if (existingData) {
              allSentences = JSON.parse(existingData);
              logger.info('从 localStorage 恢复数据', { count: allSentences.length });
            }
          } catch (err) {
            logger.warn('读取现有 localStorage 数据失败', { error: String(err) });
          }
        }
        
        if (allSentences.length > 0) {
          const migrationResult = this.safeMigrateToFallback(allSentences);
          
          if (migrationResult.success) {
            this.emitStorageEvent({
              type: migrationResult.truncated ? 'migrationWarning' : 'migrationSuccess',
              message: migrationResult.truncated 
                ? `数据已迁移至备用存储，因容量限制保留了最近的 ${migrationResult.totalMigrated} 条数据`
                : `数据已完整迁移至备用存储，共 ${migrationResult.totalMigrated} 条`,
              details: {
                totalSource: migrationResult.totalSource,
                totalMigrated: migrationResult.totalMigrated,
                truncated: migrationResult.truncated
              }
            });
          } else {
            this.emitStorageEvent({
              type: 'migrationError',
              message: `数据迁移失败：${migrationResult.error}`,
              details: {
                totalSource: migrationResult.totalSource,
                totalMigrated: 0
              }
            });
          }
        }
        
        const fallback = new FallbackStorage();
        this.fallbackStorage = fallback;
        return fallback;
      };

      const timeoutId = setTimeout(() => {
        logger.warn('IndexedDB 初始化超时，切换到降级存储');
        switchToFallback().then(fallback => resolve(fallback));
      }, INIT_TIMEOUT);

      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          
          if (db.objectStoreNames.contains(STORE_NAME)) {
            db.deleteObjectStore(STORE_NAME);
          }
          
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
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
          logger.error('IndexedDB 初始化失败，使用降级存储', { error: String(event) });
          switchToFallback().then(fallback => resolve(fallback));
        };

        request.onblocked = () => {
          clearTimeout(timeoutId);
          logger.warn('IndexedDB 被阻塞，可能有其他标签页正在使用数据库');
          
          // 发出警告事件，让用户关闭其他标签页
          this.emitStorageEvent({
            type: 'migrationWarning',
            message: '检测到多个标签页冲突，请关闭其他页面以保证数据完整。'
          });
          
          // 等待一段时间后重试，而不是直接降级
          setTimeout(() => {
            if (this.db) {
              // 如果在等待期间数据库已经初始化成功
              resolve(this.db);
            } else {
              // 超时后才降级
              logger.warn('等待其他标签页释放数据库超时，使用降级存储');
              switchToFallback().then(fallback => resolve(fallback));
            }
          }, 5000); // 等待5秒
        };
      } catch (err) {
        clearTimeout(timeoutId);
        logger.error('IndexedDB 错误，使用降级存储', { error: String(err) });
        switchToFallback().then(fallback => resolve(fallback));
      }
    });
  }

  private async getStorage() {
    if (this.useFallback && this.fallbackStorage) {
      return this.fallbackStorage;
    }
    const storage = await this.ensureDB();
    if (storage instanceof FallbackStorage) {
      return storage;
    }
    return null;
  }

  private async readAllFromIndexedDB(db: IDBDatabase): Promise<Sentence[]> {
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
          resolve(request.result || []);
        };
        
        request.onerror = () => {
          reject(new Error(`Failed to read from IndexedDB: ${request.error?.message}`));
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private safeMigrateToFallback(sentences: Sentence[]): MigrationResult {
    const totalSource = sentences.length;
    
    try {
      let dataToSave = [...sentences];
      let serializedData = JSON.stringify(dataToSave);
      let truncated = false;

      if (serializedData.length * 2 > LOCALSTORAGE_SAFE_SIZE) {
        const estimatedKeep = Math.min(FALLBACK_MAX_SENTENCES, Math.floor(LOCALSTORAGE_SAFE_SIZE / (serializedData.length * 2 / sentences.length)));
        
        this.emitStorageEvent({
          type: 'truncationWarning',
          message: `存储空间不足，已自动保留最重要的 ${estimatedKeep} 条数据`,
          details: {
            totalSource: sentences.length,
            estimatedKeep,
            truncated: true
          }
        });
        
        dataToSave = [...sentences]
          .map(s => ({ s, score: this.calculateImportance(s) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, estimatedKeep)
          .map(item => item.s);
        serializedData = JSON.stringify(dataToSave);
        truncated = true;
        
        logger.warn('数据量超出 localStorage 安全范围，已自动截断', {
          originalCount: sentences.length,
          estimatedKeep,
          estimatedSize: `${(serializedData.length * 2 / 1024 / 1024).toFixed(2)}MB`
        });
      }

      localStorage.setItem(FALLBACK_STORAGE_KEY, serializedData);

      const verifyString = localStorage.getItem(FALLBACK_STORAGE_KEY);
      if (!verifyString) {
        throw new Error('写入后读取为空');
      }

      const verifyData: Sentence[] = JSON.parse(verifyString);
      if (!Array.isArray(verifyData)) {
        throw new Error('验证数据格式错误');
      }
      
      if (verifyData.length !== dataToSave.length) {
        throw new Error(`校验失败：期望 ${dataToSave.length} 条，实际存入 ${verifyData.length} 条`);
      }

      const checksum = this.calculateChecksum(serializedData);
      const metadata: FallbackMetadata = {
        version: 1,
        timestamp: Date.now(),
        checksum,
        sourceCount: totalSource,
        truncated
      };
      localStorage.setItem(FALLBACK_METADATA_KEY, JSON.stringify(metadata));

      logger.info('降级迁移成功', {
        totalSource,
        totalMigrated: dataToSave.length,
        truncated,
        checksum
      });

      return {
        success: true,
        totalSource,
        totalMigrated: dataToSave.length,
        truncated
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('降级迁移失败', { error: errorMessage, totalSource });

      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        this.emitStorageEvent({
          type: 'storageFull',
          message: '本地存储空间不足，无法保存离线数据。请确保网络连接正常以同步至云端。',
          details: { totalSource }
        });
      }

      return {
        success: false,
        totalSource,
        totalMigrated: 0,
        truncated: false,
        error: errorMessage
      };
    }
  }

  private calculateChecksum(data: string): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  private storageEventListeners: Map<StorageEventType, Set<(event: D3SStorageEvent) => void>> = new Map();

  onStorageEvent(event: StorageEventType, callback: (event: D3SStorageEvent) => void): () => void {
    if (!this.storageEventListeners.has(event)) {
      this.storageEventListeners.set(event, new Set());
    }
    this.storageEventListeners.get(event)!.add(callback);
    
    return () => {
      this.storageEventListeners.get(event)?.delete(callback);
    };
  }

  private emitStorageEvent(event: D3SStorageEvent): void {
    const listeners = this.storageEventListeners.get(event.type);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(event);
        } catch (err) {
          logger.error('存储事件监听器执行错误', { error: String(err) });
        }
      });
    }
    
    window.dispatchEvent(new CustomEvent('d3s:storage_warning', {
      detail: event
    }));
  }

  getMigrationStatus(): { hasMetadata: boolean; metadata?: FallbackMetadata } {
    try {
      const metadataStr = localStorage.getItem(FALLBACK_METADATA_KEY);
      if (metadataStr) {
        return { hasMetadata: true, metadata: JSON.parse(metadataStr) };
      }
    } catch (err) {
      logger.warn('读取迁移元数据失败', { error: String(err) });
    }
    return { hasMetadata: false };
  }

  async getAll(): Promise<Sentence[]> {
    const cachedData = this.cache.getAll();
    if (cachedData) {
      logger.debug('getAll: 从缓存返回数据', { count: cachedData.length });
      return cachedData;
    }

    return retryOperation(async () => {
      const fallback = await this.getStorage();
      if (fallback) {
        const result = await fallback.getAll();
        this.cache.setAll(result);
        return result;
      }
      
      const db = this.db!;
      return new Promise((resolve, reject) => {
        try {
          const transaction = db.transaction(STORE_NAME, 'readonly');
          const store = transaction.objectStore(STORE_NAME);
          const request = store.getAll();

          request.onsuccess = () => {
            const result = request.result || [];
            this.cache.setAll(result);
            logger.debug('getAll: 从数据库返回数据', { count: result.length });
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

  async put(sentence: Sentence): Promise<void> {
    return this.writingPromise = this.writingPromise
      .catch(() => {})
      .then(() => this.doPut(sentence));
  }

  private async doPut(sentence: Sentence): Promise<void> {
    const fallback = await this.getStorage();
    if (fallback) {
      await fallback.put(sentence);
      this.cache.set(sentence);
      return;
    }
    
    const db = this.db!;
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(sentence);

        transaction.oncomplete = () => {
          this.cache.set(sentence);
          logger.debug('put: 保存句子成功', { id: sentence.id });
          resolve();
        };

        transaction.onerror = () => {
          reject(new DBError(
            `Transaction error during save: ${transaction.error?.message || 'Unknown error'}`,
            'put',
            transaction.error ? new Error(transaction.error.message) : undefined
          ));
        };
        
        transaction.onabort = () => {
          reject(new DBError('Transaction was aborted during put', 'put', undefined, true));
        };

        request.onerror = () => {
          transaction.abort();
        };
      } catch (err) {
        reject(new DBError(
          'Unknown error during put',
          'put',
          err instanceof Error ? err : new Error(String(err))
        ));
      }
    });
  }

  async putAll(sentences: Sentence[]): Promise<void> {
    if (sentences.length === 0) return;
    
    return this.writingPromise = this.writingPromise
      .catch(() => {})
      .then(() => this.doPutAll(sentences));
  }

  private async doPutAll(sentences: Sentence[]): Promise<void> {
    const fallback = await this.getStorage();
    if (fallback) {
      await fallback.putAll(sentences);
      sentences.forEach(s => this.cache.set(s));
      return;
    }
    
    const db = this.db!;
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        transaction.oncomplete = () => {
          sentences.forEach(s => this.cache.set(s));
          logger.debug('putAll: 批量保存成功', { count: sentences.length });
          resolve();
        };

        transaction.onerror = () => {
          reject(new DBError(`批量保存事务失败: ${transaction.error?.message || 'Unknown error'}`, 'putAll'));
        };

        transaction.onabort = () => {
          reject(new DBError('批量保存事务已中止（原子性保护）', 'putAll'));
        };

        for (const s of sentences) {
          const request = store.put(s);
          request.onerror = (e) => {
            logger.error(`putAll: 写入失败 [ID: ${s.id}]`, { 
              error: request.error?.message || 'Unknown error',
              sentence: s.english?.slice(0, 50)
            });
            transaction.abort();
            e.stopPropagation();
          };
        }
      } catch (err) {
        reject(new DBError(
          'putAll 操作异常',
          'putAll',
          err instanceof Error ? err : new Error(String(err)),
          true
        ));
      }
    });
  }

  async delete(id: string): Promise<void> {
    return this.writingPromise = this.writingPromise
      .catch(() => {})
      .then(() => this.doDelete(id));
  }

  private async doDelete(id: string): Promise<void> {
    const fallback = await this.getStorage();
    if (fallback) {
      await fallback.delete(id);
      this.cache.delete(id);
      return;
    }
    
    const db = this.db!;
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        transaction.oncomplete = () => {
          this.cache.delete(id);
          logger.debug('delete: 删除句子成功', { id });
          resolve();
        };

        transaction.onerror = () => {
          reject(new DBError(
            `Transaction error during deletion: ${transaction.error?.message || 'Unknown error'}`,
            'delete',
            transaction.error ? new Error(transaction.error.message) : undefined
          ));
        };

        transaction.onabort = () => {
          reject(new DBError('Transaction was aborted during delete', 'delete', undefined, true));
        };

        request.onerror = () => {
          transaction.abort();
        };
      } catch (err) {
        reject(new DBError(
          'Unknown error during delete',
          'delete',
          err instanceof Error ? err : new Error(String(err))
        ));
      }
    });
  }

  async clear(): Promise<void> {
    return this.writingPromise = this.writingPromise
      .catch(() => {})
      .then(() => this.doClear());
  }

  private async doClear(): Promise<void> {
    const fallback = await this.getStorage();
    if (fallback) {
      await fallback.clear();
      this.cache.clear();
      return;
    }
    
    const db = this.db!;
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        transaction.oncomplete = () => {
          this.cache.clear();
          logger.debug('clear: 清空数据库成功');
          resolve();
        };

        transaction.onerror = () => {
          reject(new DBError(
            `Transaction error during clear: ${transaction.error?.message || 'Unknown error'}`,
            'clear',
            transaction.error ? new Error(transaction.error.message) : undefined
          ));
        };

        transaction.onabort = () => {
          reject(new DBError('Transaction was aborted during clear', 'clear', undefined, true));
        };

        request.onerror = () => {
          transaction.abort();
        };
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during clear'));
      }
    });
  }

  async findByEnglish(english: string): Promise<Sentence | null> {
    const normalized = normalizeEnglish(english);
    
    const cachedValues = this.cache.getAllValues();
    const cached = cachedValues.find(s => normalizeEnglish(s.english) === normalized);
    if (cached) {
      logger.debug('findByEnglish: 从缓存命中', { english: normalized });
      return cached;
    }

    const fallback = await this.getStorage();
    if (fallback) {
      return fallback.findByEnglish(english);
    }
    
    const db = this.db!;
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        
        // 修复：遍历所有数据进行标准化匹配，因为IndexedDB索引是大小写敏感的
        const request = store.getAll();
        
        request.onsuccess = () => {
          const results = request.result || [];
          const found = results.find(s => normalizeEnglish(s.english) === normalized);
          
          if (found) {
            this.cache.set(found);
            logger.debug('findByEnglish: 从数据库查询并回填缓存', { english: normalized });
          }
          resolve(found || null);
        };
        
        request.onerror = () => reject(new Error(`Failed to find sentence: ${request.error?.message}`));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Unknown error during findByEnglish'));
      }
    });
  }

  getCacheStats(): { size: number; hitRate: number } {
    return this.cache.getStats();
  }

  invalidateCache(): void {
    this.cache.invalidateAll();
  }

  async findDuplicates(): Promise<Map<string, Sentence[]>> {
    const allSentences = await this.getAll();
    const duplicatesMap = new Map<string, Sentence[]>();
    
    allSentences.forEach(sentence => {
      const normalized = normalizeEnglish(sentence.english);
      const existing = duplicatesMap.get(normalized);
      if (existing) {
        existing.push(sentence);
      } else {
        duplicatesMap.set(normalized, [sentence]);
      }
    });

    const result = new Map<string, Sentence[]>();
    duplicatesMap.forEach((sentences, key) => {
      if (sentences.length > 1) {
        result.set(key, sentences);
      }
    });

    return result;
  }
}

export type { TruncationStrategy, D3SStorageEvent, StorageEventType };
export const dbService = new DBService();
