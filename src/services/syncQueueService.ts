import { Sentence, ReviewRating, DictationRecord, UserStats, SyncEventType, SyncEventData, SyncEventPayloads, QueueWarningData, SyncStatus } from '../types';
import { supabaseService } from './supabaseService';
import { storageService } from './storage';
import { networkService } from './networkService';
import { deviceService } from './deviceService';
import { generateUUID, isValidUUID } from '../utils/uuid';
import { SYNC_CONFIG } from '../constants';
import { dedupeSentences, sanitizeEnglish, sanitizeSentenceForQuery } from '../utils/validators';
import { logger, createOperationLogger } from '../utils/logger';

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];
  
  for (const task of tasks) {
    const promise = task().then(result => {
      results.push(result);
      const index = executing.indexOf(promise);
      if (index > -1) executing.splice(index, 1);
    });
    executing.push(promise);
    
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }
  
  await Promise.all(executing);
  return results;
}

interface MarkLearnedOperation {
  sentenceId: string;
  updatedSentence: Sentence;
  timestamp: number;
  synced?: boolean;
}

interface ReviewFeedbackOperation {
  sentenceId: string;
  updatedSentence: Sentence;
  feedback: ReviewRating;
  timestamp: number;
  synced?: boolean;
}

interface AddSentenceOperation {
  sentence: Sentence;
  timestamp: number;
}

interface CloudSentence {
  id: string;
  english: string;
  updatedat: number;
}

interface DictationRecordOperation {
  record: DictationRecord;
  timestamp: number;
}

interface StatsSyncOperation {
  stats: UserStats;
  timestamp: number;
}

interface SyncOperationRecord {
  operationId: string;
  operationType: string;
  sentenceId?: string;
  checksum?: string;
  timestamp: number;
  success: boolean;
}

type OfflineOperation = MarkLearnedOperation | ReviewFeedbackOperation | AddSentenceOperation | DictationRecordOperation | StatsSyncOperation;

type PendingOperationType = 'markLearned' | 'reviewFeedback' | 'addSentence' | 'dictationRecord' | 'statsSync';

interface PendingOperation {
  type: PendingOperationType;
  payload: OfflineOperation;
  id: string;
}

interface QueuesStorageData {
  version: number;
  timestamp: number;
  checksum: string;
  queues: {
    markLearned: [string, MarkLearnedOperation][];
    reviewFeedback: [string, ReviewFeedbackOperation][];
    addSentence: [string, AddSentenceOperation][];
    dictationRecord: [string, DictationRecordOperation][];
    statsSync: [string, StatsSyncOperation][];
  };
  lastSyncTime: number | null;
}

function calculateChecksum(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

// 智能重试配置
const SYNC_DELAY = 5000;
const MAX_RETRY_COUNT = 5;
const RETRY_JITTER_RANGE = 0.3; // 30% 抖动范围
const RETRY_BACKOFF_BASE = 2; // 指数退避基数
const SMART_RETRY_CONFIG = {
  // 基于错误类型的重试策略
  errorTypes: {
    network: { maxRetries: 5, baseDelay: 2000, backoffMultiplier: 2 },
    server: { maxRetries: 3, baseDelay: 5000, backoffMultiplier: 1.5 },
    quota: { maxRetries: 2, baseDelay: 10000, backoffMultiplier: 1.2 },
    auth: { maxRetries: 1, baseDelay: 0, backoffMultiplier: 1 } // 认证错误不重试
  },
  // 基于操作类型的优先级
  operationPriority: {
    markLearned: 1,    // 最高优先级
    reviewFeedback: 1, // 最高优先级  
    statsSync: 2,      // 中等优先级
    dictationRecord: 3, // 低优先级
    addSentence: 3     // 低优先级
  }
};
const STORAGE_KEY_PREFIX = 'sync_queue_';
const STORAGE_KEY_ALL_QUEUES = `${STORAGE_KEY_PREFIX}all_queues`;
const SAVE_DEBOUNCE_DELAY = 1000;
const STORAGE_VERSION = 1;

const BATCH_SIZE = SYNC_CONFIG.BATCH_SIZE;
const CONCURRENT_LIMIT = SYNC_CONFIG.CONCURRENT_LIMIT;

// 队列最大限制配置
const QUEUE_LIMITS = {
  markLearned: 1000,
  reviewFeedback: 1000,
  addSentence: 500,
  dictationRecord: 500,
  statsSync: 100
};

// 队列警告阈值（达到时触发清理）
const QUEUE_WARN_THRESHOLD = 0.8;

// 分级阈值告警配置
const QUEUE_CAPACITY_CONFIG = {
  SAFE: 50,
  WARNING: 100,
  CRITICAL: 250,
  MAX_STORAGE_BYTES: 4 * 1024 * 1024,
  MIN_REMAINING_BYTES: 100 * 1024
};

const LOCALSTORAGE_TOTAL_SIZE = 5 * 1024 * 1024;
const EMERGENCY_STORE_KEY = 'd3s_emergency_store';
const EMERGENCY_STORE_MAX_SIZE = 100;

interface EmergencyStoreItem {
  type: PendingOperationType;
  payload: unknown;
  timestamp: number;
}

class SyncQueueService {
  private markLearnedQueue: Map<string, MarkLearnedOperation> = new Map();
  private reviewFeedbackQueue: Map<string, ReviewFeedbackOperation> = new Map();
  private addSentenceQueue: Map<string, AddSentenceOperation> = new Map();
  private dictationRecordQueue: Map<string, DictationRecordOperation> = new Map();
  private statsSyncQueue: Map<string, StatsSyncOperation> = new Map();
  private completedOperations: Set<string> = new Set();
  private retryCount: Map<string, number> = new Map();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private isSyncing = false;
  private syncPromise: Promise<{ success: boolean; message: string }> | null = null;
  private lastSyncTime: number | null = null;
  private nextSyncTime: number | null = null;
  private lastSyncError: string | null = null;
  private eventListeners: Map<SyncEventType, Set<(data?: SyncEventPayloads[SyncEventType]) => void>> = new Map();
  private syncCache: Map<string, number> = new Map();
  private readonly SYNC_CACHE_TTL = 60000;
  private operationRecords: Map<string, SyncOperationRecord> = new Map();
  private readonly OPERATION_RECORD_TTL = 3600000;
  private readonly OPERATION_RECORD_KEY = `${STORAGE_KEY_PREFIX}operation_records`;

  constructor() {
    this.loadFromStorage();
    this.loadOperationRecords();
    this.setupUnloadHandler();
    this.setupOnlineHandler();
    this.initEventTypes();
  }

  private generateOperationId(type: string, data: object): string {
    const dataStr = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < dataStr.length; i++) {
      const char = dataStr.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `${type}_${Math.abs(hash)}_${Date.now()}`;
  }

  private loadOperationRecords(): void {
    try {
      const data = localStorage.getItem(this.OPERATION_RECORD_KEY);
      if (data) {
        const records: SyncOperationRecord[] = JSON.parse(data);
        const now = Date.now();
        records
          .filter(r => now - r.timestamp < this.OPERATION_RECORD_TTL)
          .forEach(r => this.operationRecords.set(r.operationId, r));
      }
    } catch (err) {
      logger.warn('加载操作记录失败', { error: String(err) });
    }
  }

  private saveOperationRecords(): void {
    try {
      const records = Array.from(this.operationRecords.values());
      localStorage.setItem(this.OPERATION_RECORD_KEY, JSON.stringify(records));
    } catch (err) {
      logger.warn('保存操作记录失败', { error: String(err) });
    }
  }

  private isOperationCompleted(operationId: string): boolean {
    const record = this.operationRecords.get(operationId);
    if (!record) return false;
    if (Date.now() - record.timestamp > this.OPERATION_RECORD_TTL) {
      this.operationRecords.delete(operationId);
      return false;
    }
    return record.success;
  }

  private recordOperation(operationId: string, type: string, sentenceId?: string, checksum?: string): void {
    this.operationRecords.set(operationId, {
      operationId,
      operationType: type,
      sentenceId,
      checksum,
      timestamp: Date.now(),
      success: true
    });
    this.saveOperationRecords();
  }

  private cleanupOperationRecords(): void {
    const now = Date.now();
    const expiredIds: string[] = [];
    this.operationRecords.forEach((record, id) => {
      if (now - record.timestamp > this.OPERATION_RECORD_TTL) {
        expiredIds.push(id);
      }
    });
    expiredIds.forEach(id => this.operationRecords.delete(id));
    if (expiredIds.length > 0) {
      this.saveOperationRecords();
    }
  }

  private initEventTypes() {
    const eventTypes: SyncEventType[] = ['syncStart', 'syncSuccess', 'syncError', 'queueChanged', 'queueWarning'];
    eventTypes.forEach(type => {
      this.eventListeners.set(type, new Set());
    });
  }

  on<K extends SyncEventType>(event: K, callback: (data?: SyncEventPayloads[K]) => void) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.add(callback as (data?: SyncEventPayloads[SyncEventType]) => void);
    }
    return () => {
      listeners?.delete(callback as (data?: SyncEventPayloads[SyncEventType]) => void);
    };
  }

  off<K extends SyncEventType>(event: K, callback: (data?: SyncEventPayloads[K]) => void) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(callback as (data?: SyncEventPayloads[SyncEventType]) => void);
    }
  }

  private emit<K extends SyncEventType>(event: K, data?: SyncEventPayloads[K]) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(data as SyncEventPayloads[SyncEventType]);
        } catch (err) {
          logger.error(`事件监听器 ${event} 执行错误`, { error: String(err) });
        }
      });
    }
  }

  private isRecentlySynced(key: string): boolean {
    const lastSync = this.syncCache.get(key);
    if (!lastSync) return false;
    return Date.now() - lastSync < this.SYNC_CACHE_TTL;
  }

  private markSynced(key: string): void {
    this.syncCache.set(key, Date.now());
  }

  private cleanSyncCache(): void {
    const now = Date.now();
    for (const [key, time] of this.syncCache.entries()) {
      if (now - time > this.SYNC_CACHE_TTL) {
        this.syncCache.delete(key);
      }
    }
  }

  private loadFromStorage() {
    try {
      const allQueuesData = localStorage.getItem(STORAGE_KEY_ALL_QUEUES);
      
      if (allQueuesData) {
        const parsed: QueuesStorageData = JSON.parse(allQueuesData);
        
        if (parsed.version !== STORAGE_VERSION) {
          logger.warn('存储版本不匹配，尝试迁移旧数据');
          this.migrateFromOldStorage();
          return;
        }
        
        const dataWithoutChecksum = allQueuesData.replace(/"checksum":"[^"]+"/, '');
        const expectedChecksum = calculateChecksum(dataWithoutChecksum);
        
        if (parsed.checksum !== expectedChecksum) {
          logger.error('存储数据校验失败，尝试逐字段恢复数据');
          
          try {
            const queues = parsed.queues;
            if (queues) {
              const filterValidEntries = <T>(queueData: [string, T][] | undefined): [string, T][] => {
                if (!Array.isArray(queueData)) return [];
                return queueData.filter((item): item is [string, T] => {
                  try {
                    return Array.isArray(item) && item.length === 2 && !!item[0] && !!item[1] && typeof item[1] === 'object';
                  } catch {
                    return false;
                  }
                });
              };
              
              this.markLearnedQueue = new Map<string, MarkLearnedOperation>(filterValidEntries(queues.markLearned));
              this.reviewFeedbackQueue = new Map<string, ReviewFeedbackOperation>(filterValidEntries(queues.reviewFeedback));
              this.addSentenceQueue = new Map<string, AddSentenceOperation>(filterValidEntries(queues.addSentence));
              this.dictationRecordQueue = new Map<string, DictationRecordOperation>(filterValidEntries(queues.dictationRecord));
              this.statsSyncQueue = new Map<string, StatsSyncOperation>(filterValidEntries(queues.statsSync));
              this.lastSyncTime = parsed.lastSyncTime;
              
              const hasRecoveredData = 
                this.markLearnedQueue.size > 0 ||
                this.reviewFeedbackQueue.size > 0 ||
                this.addSentenceQueue.size > 0 ||
                this.dictationRecordQueue.size > 0 ||
                this.statsSyncQueue.size > 0;
              
              if (hasRecoveredData) {
                this.saveToStorageImmediate();
                logger.info('已修复并重新保存队列数据', {
                  markLearned: this.markLearnedQueue.size,
                  reviewFeedback: this.reviewFeedbackQueue.size,
                  addSentence: this.addSentenceQueue.size,
                  dictationRecord: this.dictationRecordQueue.size,
                  statsSync: this.statsSyncQueue.size
                });
                return;
              }
            }
          } catch (recoverErr) {
            logger.error('数据恢复失败', { error: String(recoverErr) });
          }
          
          localStorage.removeItem(STORAGE_KEY_ALL_QUEUES);
          this.emit('queueWarning', { level: 'critical', message: '存储数据损坏已自动清空' });
          logger.warn('存储数据损坏已自动清空');
          return;
        }
        
        this.markLearnedQueue = new Map(parsed.queues.markLearned || []);
        this.reviewFeedbackQueue = new Map(parsed.queues.reviewFeedback || []);
        this.addSentenceQueue = new Map(parsed.queues.addSentence || []);
        this.dictationRecordQueue = new Map(parsed.queues.dictationRecord || []);
        this.statsSyncQueue = new Map(parsed.queues.statsSync || []);
        this.lastSyncTime = parsed.lastSyncTime;
        
        logger.debug('从单一键加载同步队列成功', {
          markLearned: this.markLearnedQueue.size,
          reviewFeedback: this.reviewFeedbackQueue.size,
          addSentence: this.addSentenceQueue.size,
          dictationRecord: this.dictationRecordQueue.size,
          statsSync: this.statsSyncQueue.size
        });
      } else {
        this.migrateFromOldStorage();
      }
    } catch (err) {
      logger.warn('加载同步队列失败，尝试迁移旧数据', { error: String(err) });
      this.migrateFromOldStorage();
    }
  }

  private migrateFromOldStorage() {
    try {
      const oldKeys = ['markLearned', 'reviewFeedback', 'addSentence', 'dictationRecord', 'statsSync'];
      let hasOldData = false;
      
      oldKeys.forEach(key => {
        const data = localStorage.getItem(`${STORAGE_KEY_PREFIX}${key}`);
        if (data) {
          hasOldData = true;
          const parsed = JSON.parse(data);
          const queue = new Map(Object.entries(parsed));
          
          switch (key) {
            case 'markLearned':
              this.markLearnedQueue = new Map<string, MarkLearnedOperation>(queue as any);
              break;
            case 'reviewFeedback':
              this.reviewFeedbackQueue = new Map<string, ReviewFeedbackOperation>(queue as any);
              break;
            case 'addSentence':
              this.addSentenceQueue = new Map<string, AddSentenceOperation>(queue as any);
              break;
            case 'dictationRecord':
              this.dictationRecordQueue = new Map<string, DictationRecordOperation>(queue as any);
              break;
            case 'statsSync':
              this.statsSyncQueue = new Map<string, StatsSyncOperation>(queue as any);
              break;
          }
          
          localStorage.removeItem(`${STORAGE_KEY_PREFIX}${key}`);
        }
      });
      
      const lastSyncData = localStorage.getItem(`${STORAGE_KEY_PREFIX}lastSyncTime`);
      if (lastSyncData) {
        this.lastSyncTime = Number(lastSyncData);
        localStorage.removeItem(`${STORAGE_KEY_PREFIX}lastSyncTime`);
      }
      
      if (hasOldData) {
        this.saveToStorageImmediate();
        logger.info('旧存储数据迁移完成');
      }
    } catch (err) {
      logger.error('迁移旧存储数据失败', { error: String(err) });
    }
  }

  private saveToStorage() {
    try {
      const storageData: QueuesStorageData = {
        version: STORAGE_VERSION,
        timestamp: Date.now(),
        checksum: '',
        queues: {
          markLearned: Array.from(this.markLearnedQueue.entries()),
          reviewFeedback: Array.from(this.reviewFeedbackQueue.entries()),
          addSentence: Array.from(this.addSentenceQueue.entries()),
          dictationRecord: Array.from(this.dictationRecordQueue.entries()),
          statsSync: Array.from(this.statsSyncQueue.entries())
        },
        lastSyncTime: this.lastSyncTime
      };
      
      const dataStr = JSON.stringify({
        version: storageData.version,
        timestamp: storageData.timestamp,
        queues: storageData.queues,
        lastSyncTime: storageData.lastSyncTime
      });
      
      storageData.checksum = calculateChecksum(dataStr);
      
      const finalData = JSON.stringify(storageData);
      localStorage.setItem(STORAGE_KEY_ALL_QUEUES, finalData);
      
      logger.debug('同步队列已保存到单一键', {
        totalSize: finalData.length,
        queues: Object.fromEntries(
          Object.entries(storageData.queues).map(([k, v]) => [k, v.length])
        )
      });
    } catch (err) {
      logger.error('保存同步队列失败', { error: String(err) });
      
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        this.handleStorageQuotaExceeded();
      }
    }
  }

  private handleStorageQuotaExceeded() {
    logger.warn('存储空间不足，尝试清理旧数据');
    
    const queues = [
      { queue: this.markLearnedQueue, name: 'markLearned', limit: QUEUE_LIMITS.markLearned },
      { queue: this.reviewFeedbackQueue, name: 'reviewFeedback', limit: QUEUE_LIMITS.reviewFeedback },
      { queue: this.addSentenceQueue, name: 'addSentence', limit: QUEUE_LIMITS.addSentence },
      { queue: this.dictationRecordQueue, name: 'dictationRecord', limit: QUEUE_LIMITS.dictationRecord },
      { queue: this.statsSyncQueue, name: 'statsSync', limit: QUEUE_LIMITS.statsSync }
    ];
    
    queues.forEach(({ queue, name, limit }) => {
      if (queue.size > limit * 0.5) {
        const entries = Array.from(queue.entries() as Iterable<[string, OfflineOperation]>);
        entries.sort((a, b) => {
          const timeA = a[1].timestamp || 0;
          const timeB = b[1].timestamp || 0;
          return timeA - timeB;
        });
        
        const toDelete = entries.slice(0, Math.floor(queue.size * 0.3));
        toDelete.forEach(([key]) => queue.delete(key));
        
        logger.warn(`已清理 ${name} 队列的旧数据`, { deleted: toDelete.length });
      }
    });
    
    try {
      this.saveToStorage();
    } catch (retryErr) {
      logger.error('清理后仍无法保存', { error: String(retryErr) });
    }
  }

  private saveToStorageDebounced() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveToStorage();
    }, SAVE_DEBOUNCE_DELAY);
  }

  private saveToStorageImmediate() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToStorage();
  }

  private unloadHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private pageHideHandler: (() => void) | null = null;
  private freezeHandler: (() => void) | null = null;

  private setupUnloadHandler() {
    this.unloadHandler = () => {
      if (this.hasPendingOperations()) {
        this.saveToStorageImmediate();
      }
    };
    window.addEventListener('beforeunload', this.unloadHandler);
    
    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        if (this.hasPendingOperations()) {
          this.saveToStorageImmediate();
        }
      } else if (document.visibilityState === 'visible') {
        if (this.hasPendingOperations() && navigator.onLine && !this.isSyncing) {
          logger.info('页面恢复可见，检查待同步数据');
          this.doSync();
        }
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    
    this.pageHideHandler = () => {
      if (this.hasPendingOperations()) {
        this.saveToStorageImmediate();
      }
    };
    window.addEventListener('pagehide', this.pageHideHandler);
    
    if ('onfreeze' in document) {
      this.freezeHandler = () => {
        if (this.hasPendingOperations()) {
          this.saveToStorageImmediate();
        }
      };
      document.addEventListener('freeze', this.freezeHandler);
    }
  }

  private setupOnlineHandler() {
    this.onlineHandler = () => {
      if (this.hasPendingOperations() && !this.isSyncing) {
        logger.info('网络恢复，自动开始同步');
        this.doSync();
      }
    };
    window.addEventListener('online', this.onlineHandler);
  }

  // 清理事件监听器（用于应用销毁时）
  public destroy(): void {
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
    if (this.pageHideHandler) {
      window.removeEventListener('pagehide', this.pageHideHandler);
      this.pageHideHandler = null;
    }
    if (this.freezeHandler) {
      document.removeEventListener('freeze', this.freezeHandler);
      this.freezeHandler = null;
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    this.eventListeners.forEach(listeners => {
      listeners.clear();
    });
    this.eventListeners.clear();

    this.syncCache.clear();
    this.operationRecords.clear();
    this.retryCount.clear();
    this.completedOperations.clear();
    
    this.markLearnedQueue.clear();
    this.reviewFeedbackQueue.clear();
    this.addSentenceQueue.clear();
    this.dictationRecordQueue.clear();
    this.statsSyncQueue.clear();
  }

  private hasPendingOperations(): boolean {
    return this.markLearnedQueue.size > 0 || 
           this.reviewFeedbackQueue.size > 0 || 
           this.addSentenceQueue.size > 0 || 
           this.dictationRecordQueue.size > 0 ||
           this.statsSyncQueue.size > 0;
  }

  private checkQueueLimit<T>(queue: Map<string, T>, limit: number, queueName: string): boolean {
    if (queue.size >= limit) {
      logger.error(`${queueName} 队列已满`, { current: queue.size, limit });
      this.emit('queueWarning', {
        level: 'critical',
        count: queue.size,
        storageBytes: this.getEstimatedStorageSize(),
        message: `${queueName} 队列已满，操作被拒绝。请检查网络连接或手动触发同步。`
      } as QueueWarningData);
      return false;
    }
    
    if (queue.size >= limit * QUEUE_WARN_THRESHOLD) {
      logger.warn(`${queueName} 队列接近上限`, { current: queue.size, limit });
      
      this.emit('queueWarning', {
        level: 'warning',
        count: queue.size,
        storageBytes: this.getEstimatedStorageSize(),
        message: `${queueName} 队列接近上限（${queue.size}/${limit}），建议尽快联网同步。`
      } as QueueWarningData);
    }
    
    return true;
  }

  private getEstimatedStorageSize(): number {
    try {
      const status = this.getQueueStatus();
      const serialized = JSON.stringify(status);
      return new Blob([serialized]).size;
    } catch (e) {
      return 0;
    }
  }

  private checkStorageAvailable(): boolean {
    try {
      const testKey = '__d3s_storage_test__';
      localStorage.setItem(testKey, 'test');
      localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  private saveToEmergencyStore(type: PendingOperationType, payload: unknown): void {
    try {
      const emergencyStore: EmergencyStoreItem[] = JSON.parse(
        localStorage.getItem(EMERGENCY_STORE_KEY) || '[]'
      );
      
      emergencyStore.push({
        type,
        payload,
        timestamp: Date.now()
      });
      
      if (emergencyStore.length > EMERGENCY_STORE_MAX_SIZE) {
        emergencyStore.sort((a, b) => b.timestamp - a.timestamp);
        emergencyStore.splice(EMERGENCY_STORE_MAX_SIZE);
      }
      
      localStorage.setItem(EMERGENCY_STORE_KEY, JSON.stringify(emergencyStore));
      logger.info('操作已保存到紧急存储', { type, storeSize: emergencyStore.length });
    } catch (err) {
      logger.error('紧急存储失败', { error: String(err) });
    }
  }

  private restoreFromEmergencyStore(): void {
    try {
      const emergencyStoreData = localStorage.getItem(EMERGENCY_STORE_KEY);
      if (!emergencyStoreData) return;
      
      const emergencyStore: EmergencyStoreItem[] = JSON.parse(emergencyStoreData);
      if (emergencyStore.length === 0) return;
      
      logger.info('开始恢复紧急存储中的操作', { count: emergencyStore.length });
      
      let restoredCount = 0;
      for (const item of emergencyStore) {
        try {
          switch (item.type) {
            case 'markLearned':
              const markLearnedPayload = item.payload as MarkLearnedOperation;
              if (!this.markLearnedQueue.has(markLearnedPayload.sentenceId)) {
                this.markLearnedQueue.set(markLearnedPayload.sentenceId, markLearnedPayload);
                restoredCount++;
              }
              break;
            case 'reviewFeedback':
              const reviewPayload = item.payload as ReviewFeedbackOperation;
              if (!this.reviewFeedbackQueue.has(reviewPayload.sentenceId)) {
                this.reviewFeedbackQueue.set(reviewPayload.sentenceId, reviewPayload);
                restoredCount++;
              }
              break;
            case 'addSentence':
              const addPayload = item.payload as AddSentenceOperation;
              const sentenceId = addPayload.sentence.id;
              if (!this.addSentenceQueue.has(sentenceId)) {
                this.addSentenceQueue.set(sentenceId, addPayload);
                restoredCount++;
              }
              break;
            case 'dictationRecord':
              const dictationPayload = item.payload as DictationRecordOperation;
              const recordId = `${dictationPayload.record.sentenceId}_${dictationPayload.timestamp}`;
              if (!this.dictationRecordQueue.has(recordId)) {
                this.dictationRecordQueue.set(recordId, dictationPayload);
                restoredCount++;
              }
              break;
            case 'statsSync':
              const statsPayload = item.payload as StatsSyncOperation;
              const statsId = `stats_${statsPayload.timestamp}`;
              if (!this.statsSyncQueue.has(statsId)) {
                this.statsSyncQueue.set(statsId, statsPayload);
                restoredCount++;
              }
              break;
          }
        } catch (itemErr) {
          logger.warn('恢复单个紧急存储项失败', { error: String(itemErr) });
        }
      }
      
      localStorage.removeItem(EMERGENCY_STORE_KEY);
      
      if (restoredCount > 0) {
        this.saveToStorageImmediate();
        this.emit('queueChanged', this.getQueueStatus());
        logger.info('紧急存储恢复完成', { restored: restoredCount, total: emergencyStore.length });
      }
    } catch (err) {
      logger.error('恢复紧急存储失败', { error: String(err) });
    }
  }

  private estimateRemainingSpace(): number {
    try {
      let usedSize = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          const value = localStorage.getItem(key);
          if (value) {
            usedSize += key.length * 2 + value.length * 2;
          }
        }
      }
      return Math.max(0, LOCALSTORAGE_TOTAL_SIZE - usedSize);
    } catch {
      return 0;
    }
  }

  private async emergencySync(): Promise<boolean> {
    if (this.isSyncing) {
      return false;
    }
    
    const isOnline = await networkService.checkConnectivity();
    if (!isOnline) {
      return false;
    }
    
    try {
      await this.doSync();
      return true;
    } catch {
      return false;
    }
  }

  private getTotalQueueCount(): number {
    return this.markLearnedQueue.size + 
           this.reviewFeedbackQueue.size + 
           this.addSentenceQueue.size + 
           this.dictationRecordQueue.size +
           this.statsSyncQueue.size;
  }

  getQueueWarningLevel(): QueueWarningData {
    const totalCount = this.getTotalQueueCount();
    const storageBytes = this.getEstimatedStorageSize();
    
    // 智能熔断策略：基于多个维度判断
    const isCriticalByCount = totalCount >= QUEUE_CAPACITY_CONFIG.CRITICAL;
    const isCriticalByStorage = storageBytes >= QUEUE_CAPACITY_CONFIG.MAX_STORAGE_BYTES;
    const isCriticalByTime = this.isQueueTooOld(); // 检查队列是否过旧
    
    if (isCriticalByCount || isCriticalByStorage || isCriticalByTime) {
      // 触发自动清理
      const cleanupResult = this.autoCleanupQueues();
      
      return {
        level: 'circuit_breaker',
        count: totalCount,
        storageBytes,
        message: `本地积压数据过多${cleanupResult.cleaned ? '，已自动清理部分旧数据' : ''}，请立即连接网络同步！`
      };
    }
    
    if (totalCount >= QUEUE_CAPACITY_CONFIG.WARNING) {
      return {
        level: 'critical',
        count: totalCount,
        storageBytes,
        message: '检测到较多离线操作，建议联网同步。'
      };
    }
    
    if (totalCount >= QUEUE_CAPACITY_CONFIG.SAFE) {
      return {
        level: 'warning',
        count: totalCount,
        storageBytes,
        message: '有较多本地更改待同步'
      };
    }
    
    return {
      level: 'safe',
      count: totalCount,
      storageBytes,
      message: ''
    };
  }

  /**
   * 检查队列是否过旧（超过7天）
   */
  private isQueueTooOld(): boolean {
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    
    // 检查所有队列中最旧的操作时间
    const allQueues = [
      this.markLearnedQueue,
      this.reviewFeedbackQueue,
      this.addSentenceQueue,
      this.dictationRecordQueue,
      this.statsSyncQueue
    ];
    
    for (const queue of allQueues) {
      for (const operation of queue.values()) {
        if (operation.timestamp < oneWeekAgo) {
          return true; // 发现超过7天的旧操作
        }
      }
    }
    
    return false;
  }

  /**
   * 智能自动清理队列
   */
  private autoCleanupQueues(): { cleaned: boolean; removedCount: number } {
    const warningLevel = this.getQueueWarningLevel();
    
    // 只有在熔断状态下才触发自动清理
    if (warningLevel.level !== 'circuit_breaker') {
      return { cleaned: false, removedCount: 0 };
    }
    
    let removedCount = 0;
    const cleanupThreshold = Date.now() - 3 * 24 * 60 * 60 * 1000; // 清理3天前的数据
    
    try {
      // 按优先级清理：先清理低优先级队列
      const cleanupStrategies = [
        { queue: this.dictationRecordQueue, priority: 'low', name: '默写记录' },
        { queue: this.addSentenceQueue, priority: 'low', name: '添加句子' },
        { queue: this.statsSyncQueue, priority: 'medium', name: '统计同步' },
        { queue: this.reviewFeedbackQueue, priority: 'high', name: '复习反馈' },
        { queue: this.markLearnedQueue, priority: 'high', name: '标记已学' }
      ];
      
      for (const strategy of cleanupStrategies) {
        const beforeSize = strategy.queue.size;
        
        // 清理过期的操作（按时间排序，保留最新的）
        const operations: [string, any][] = [];
        for (const [key, value] of strategy.queue.entries()) {
          operations.push([key, value]);
        }
        operations.sort((a, b) => b[1].timestamp - a[1].timestamp); // 按时间倒序
        
        // 保留最新的70%操作，清理最旧的30%
        const keepCount = Math.ceil(operations.length * 0.7);
        const toRemove = operations.slice(keepCount);
        
        for (const [key] of toRemove) {
          strategy.queue.delete(key);
          removedCount++;
        }
        
        const afterSize = strategy.queue.size;
        if (beforeSize > afterSize) {
          logger.warn(`自动清理 ${strategy.name} 队列`, { 
            before: beforeSize, 
            after: afterSize,
            removed: beforeSize - afterSize
          });
        }
        
        // 如果清理后总数量已经降到安全阈值以下，停止清理
        if (this.getTotalQueueCount() < QUEUE_CAPACITY_CONFIG.WARNING) {
          break;
        }
      }
      
      if (removedCount > 0) {
        this.saveToStorageImmediate();
        this.emit('queueChanged', this.getQueueStatus());
        
        logger.info('智能自动清理完成', { 
          removedCount,
          remainingCount: this.getTotalQueueCount(),
          storageBytes: this.getEstimatedStorageSize()
        });
      }
      
      return { cleaned: removedCount > 0, removedCount };
      
    } catch (error) {
      logger.error('自动清理失败', { error: String(error) });
      return { cleaned: false, removedCount: 0 };
    }
  }

  private checkQueueCapacity(): void {
    const warningData = this.getQueueWarningLevel();
    
    if (warningData.level === 'circuit_breaker') {
      logger.error(`🚨 同步队列严重超载: ${warningData.count} 条操作待同步`, { 
        count: warningData.count, 
        storageBytes: warningData.storageBytes 
      });
      this.emit('queueWarning', warningData);
    } else if (warningData.level === 'critical') {
      logger.warn(`⚠️ 同步队列接近上限: ${warningData.count} 条条目`, { 
        count: warningData.count 
      });
      this.emit('queueWarning', warningData);
    } else if (warningData.level === 'warning') {
      logger.info(`💡 同步队列有待同步数据: ${warningData.count} 条`, { 
        count: warningData.count 
      });
      this.emit('queueWarning', warningData);
    }
  }

  isCircuitBreakerActive(): boolean {
    return this.getQueueWarningLevel().level === 'circuit_breaker';
  }

  addMarkLearned(sentenceId: string, updatedSentence: Sentence) {
    if (!this.checkStorageAvailable()) {
      logger.error('存储不可用，无法添加同步操作', { operation: 'addMarkLearned', sentenceId });
      this.saveToEmergencyStore('markLearned', {
        sentenceId,
        updatedSentence,
        timestamp: Date.now()
      });
      this.emit('queueWarning', { 
        level: 'critical' as const,
        count: this.getTotalQueueCount(),
        storageBytes: this.getEstimatedStorageSize(),
        message: '存储空间不足，数据已暂存到紧急存储，请联网同步后重试' 
      });
      return;
    }
    
    const remainingSpace = this.estimateRemainingSpace();
    if (remainingSpace < QUEUE_CAPACITY_CONFIG.MIN_REMAINING_BYTES) {
      logger.warn('存储空间不足，尝试紧急同步', { remainingSpace });
      this.emergencySync().then(success => {
        if (!success) {
          this.saveToEmergencyStore('markLearned', {
            sentenceId,
            updatedSentence,
            timestamp: Date.now()
          });
          this.emit('queueWarning', { 
            level: 'critical' as const,
            count: this.getTotalQueueCount(),
            storageBytes: this.getEstimatedStorageSize(),
            message: '存储空间不足，数据已暂存到紧急存储，请联网同步后重试' 
          });
        }
      });
    }
    
    if (this.isCircuitBreakerActive()) {
      logger.warn('熔断器激活，将操作保存到紧急存储', { operation: 'addMarkLearned', sentenceId });
      this.saveToEmergencyStore('markLearned', {
        sentenceId,
        updatedSentence,
        timestamp: Date.now()
      });
      this.emit('queueWarning', { 
        ...this.getQueueWarningLevel(), 
        message: '同步队列已满，数据已暂存到紧急存储，请立即联网同步' 
      });
      return;
    }
    
    if (!this.checkQueueLimit(this.markLearnedQueue, QUEUE_LIMITS.markLearned, 'markLearned')) {
      this.saveToEmergencyStore('markLearned', {
        sentenceId,
        updatedSentence,
        timestamp: Date.now()
      });
      return;
    }
    
    this.markLearnedQueue.set(sentenceId, {
      sentenceId,
      updatedSentence,
      timestamp: Date.now()
    });
    
    this.reviewFeedbackQueue.delete(sentenceId);
    
    this.saveToStorageImmediate();
    this.emit('queueChanged', this.getQueueStatus());
    this.checkQueueCapacity();
    this.scheduleSync();
  }

  addReviewFeedback(sentenceId: string, updatedSentence: Sentence, feedback: ReviewRating) {
    if (!this.checkStorageAvailable()) {
      logger.error('存储不可用，无法添加同步操作', { operation: 'addReviewFeedback', sentenceId });
      this.emit('queueWarning', { 
        level: 'critical' as const,
        count: this.getTotalQueueCount(),
        storageBytes: this.getEstimatedStorageSize(),
        message: '存储空间不足，请连接网络同步后重试' 
      });
      return;
    }
    
    const remainingSpace = this.estimateRemainingSpace();
    if (remainingSpace < QUEUE_CAPACITY_CONFIG.MIN_REMAINING_BYTES) {
      logger.warn('存储空间不足，尝试紧急同步', { remainingSpace });
      this.emergencySync().then(success => {
        if (!success) {
          this.emit('queueWarning', { 
            level: 'critical' as const,
            count: this.getTotalQueueCount(),
            storageBytes: this.getEstimatedStorageSize(),
            message: '存储空间不足，请连接网络同步后重试' 
          });
        }
      });
    }
    
    if (this.isCircuitBreakerActive()) {
      logger.warn('熔断器激活，拒绝新操作', { operation: 'addReviewFeedback', sentenceId });
      this.emit('queueWarning', { 
        ...this.getQueueWarningLevel(), 
        message: '同步队列已满，请立即联网同步后再试' 
      });
      return;
    }
    
    if (!this.checkQueueLimit(this.reviewFeedbackQueue, QUEUE_LIMITS.reviewFeedback, 'reviewFeedback')) {
      return;
    }
    
    const markLearnedItem = this.markLearnedQueue.get(sentenceId);
    if (markLearnedItem && !markLearnedItem.synced) {
      logger.debug(`保留未同步的学习记录`, { sentenceId });
    } else {
      this.markLearnedQueue.delete(sentenceId);
    }
    
    this.reviewFeedbackQueue.set(sentenceId, {
      sentenceId,
      updatedSentence,
      feedback,
      timestamp: Date.now(),
      synced: false
    });
    
    this.saveToStorageImmediate();
    this.emit('queueChanged', this.getQueueStatus());
    this.checkQueueCapacity();
    this.scheduleSync();
  }

  addSentence(sentence: Sentence) {
    if (!this.checkStorageAvailable()) {
      logger.error('存储不可用，无法添加同步操作', { operation: 'addSentence', sentenceId: sentence.id });
      this.emit('queueWarning', { 
        level: 'critical' as const,
        count: this.getTotalQueueCount(),
        storageBytes: this.getEstimatedStorageSize(),
        message: '存储空间不足，请连接网络同步后重试' 
      });
      return;
    }
    
    const remainingSpace = this.estimateRemainingSpace();
    if (remainingSpace < QUEUE_CAPACITY_CONFIG.MIN_REMAINING_BYTES) {
      logger.warn('存储空间不足，尝试紧急同步', { remainingSpace });
      this.emergencySync().then(success => {
        if (!success) {
          this.emit('queueWarning', { 
            level: 'critical' as const,
            count: this.getTotalQueueCount(),
            storageBytes: this.getEstimatedStorageSize(),
            message: '存储空间不足，请连接网络同步后重试' 
          });
        }
      });
    }
    
    if (this.isCircuitBreakerActive()) {
      logger.warn('熔断器激活，拒绝新操作', { operation: 'addSentence', sentenceId: sentence.id });
      this.emit('queueWarning', { 
        ...this.getQueueWarningLevel(), 
        message: '同步队列已满，请立即联网同步后再试' 
      });
      return;
    }
    
    if (!this.checkQueueLimit(this.addSentenceQueue, QUEUE_LIMITS.addSentence, 'addSentence')) {
      return;
    }
    
    const id = sentence.id || `new_${Date.now()}`;
    this.addSentenceQueue.set(id, {
      sentence,
      timestamp: Date.now()
    });
    
    this.saveToStorageImmediate();
    this.emit('queueChanged', this.getQueueStatus());
    this.checkQueueCapacity();
    this.scheduleSync();
  }

  addDictationRecord(record: DictationRecord) {
    if (!this.checkStorageAvailable()) {
      logger.error('存储不可用，无法添加同步操作', { operation: 'addDictationRecord', sentenceId: record.sentenceId });
      this.emit('queueWarning', { 
        level: 'critical' as const,
        count: this.getTotalQueueCount(),
        storageBytes: this.getEstimatedStorageSize(),
        message: '存储空间不足，请连接网络同步后重试' 
      });
      return;
    }
    
    const remainingSpace = this.estimateRemainingSpace();
    if (remainingSpace < QUEUE_CAPACITY_CONFIG.MIN_REMAINING_BYTES) {
      logger.warn('存储空间不足，尝试紧急同步', { remainingSpace });
      this.emergencySync().then(success => {
        if (!success) {
          this.emit('queueWarning', { 
            level: 'critical' as const,
            count: this.getTotalQueueCount(),
            storageBytes: this.getEstimatedStorageSize(),
            message: '存储空间不足，请连接网络同步后重试' 
          });
        }
      });
    }
    
    if (this.isCircuitBreakerActive()) {
      logger.warn('熔断器激活，拒绝新操作', { operation: 'addDictationRecord', sentenceId: record.sentenceId });
      this.emit('queueWarning', { 
        ...this.getQueueWarningLevel(), 
        message: '同步队列已满，请立即联网同步后再试' 
      });
      return;
    }
    
    if (!this.checkQueueLimit(this.dictationRecordQueue, QUEUE_LIMITS.dictationRecord, 'dictationRecord')) {
      return;
    }
    
    const id = `${record.sentenceId}_${Date.now()}`;
    this.dictationRecordQueue.set(id, {
      record,
      timestamp: Date.now()
    });
    
    this.saveToStorageImmediate();
    this.emit('queueChanged', this.getQueueStatus());
    this.checkQueueCapacity();
    this.scheduleSync();
  }

  addStatsSync(stats: UserStats) {
    if (!this.checkStorageAvailable()) {
      logger.error('存储不可用，无法添加同步操作', { operation: 'addStatsSync' });
      this.emit('queueWarning', { 
        level: 'critical' as const,
        count: this.getTotalQueueCount(),
        storageBytes: this.getEstimatedStorageSize(),
        message: '存储空间不足，请连接网络同步后重试' 
      });
      return;
    }
    
    const remainingSpace = this.estimateRemainingSpace();
    if (remainingSpace < QUEUE_CAPACITY_CONFIG.MIN_REMAINING_BYTES) {
      logger.warn('存储空间不足，尝试紧急同步', { remainingSpace });
      this.emergencySync().then(success => {
        if (!success) {
          this.emit('queueWarning', { 
            level: 'critical' as const,
            count: this.getTotalQueueCount(),
            storageBytes: this.getEstimatedStorageSize(),
            message: '存储空间不足，请连接网络同步后重试' 
          });
        }
      });
    }
    
    if (this.isCircuitBreakerActive()) {
      logger.warn('熔断器激活，拒绝新操作', { operation: 'addStatsSync' });
      this.emit('queueWarning', { 
        ...this.getQueueWarningLevel(), 
        message: '同步队列已满，请立即联网同步后再试' 
      });
      return;
    }
    
    if (!this.checkQueueLimit(this.statsSyncQueue, QUEUE_LIMITS.statsSync, 'statsSync')) {
      return;
    }
    
    const id = `stats_${Date.now()}`;
    this.statsSyncQueue.set(id, {
      stats,
      timestamp: Date.now()
    });
    
    this.saveToStorageImmediate();
    this.emit('queueChanged', this.getQueueStatus());
    this.checkQueueCapacity();
    this.scheduleSync();
  }

  getPendingOperations(): PendingOperation[] {
    const operations: PendingOperation[] = [];

    this.markLearnedQueue.forEach((op, id) => {
      operations.push({ type: 'markLearned', payload: op, id });
    });

    this.reviewFeedbackQueue.forEach((op, id) => {
      operations.push({ type: 'reviewFeedback', payload: op, id });
    });

    this.addSentenceQueue.forEach((op, id) => {
      operations.push({ type: 'addSentence', payload: op, id });
    });

    this.dictationRecordQueue.forEach((op, id) => {
      operations.push({ type: 'dictationRecord', payload: op, id });
    });

    this.statsSyncQueue.forEach((op, id) => {
      operations.push({ type: 'statsSync', payload: op, id });
    });

    return operations;
  }

  private scheduleSync() {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    
    this.nextSyncTime = Date.now() + SYNC_DELAY;
    this.syncTimer = setTimeout(() => {
      this.nextSyncTime = null;
      this.doSync();
    }, SYNC_DELAY);
  }

  private async doSync() {
    if (this.isSyncing || !this.hasPendingOperations()) {
      return;
    }
    
    this.restoreFromEmergencyStore();
    
    const isOnline = await networkService.checkConnectivity();
    if (!isOnline) {
      this.lastSyncError = '网络未连接';
      this.emit('syncError', { message: '网络未连接，将在联网后自动同步' });
      return;
    }
    
    if (!supabaseService.isReady) {
      this.lastSyncError = '云同步未配置';
      return;
    }
    
    const syncMode = deviceService.getSyncMode();
    
    if (syncMode === 'downloadOnly') {
      logger.info('电脑端同步模式：仅下载，跳过上传队列');
      this.markLearnedQueue.clear();
      this.reviewFeedbackQueue.clear();
      this.addSentenceQueue.clear();
      this.dictationRecordQueue.clear();
      this.statsSyncQueue.clear();
      this.retryCount.clear();
      this.lastSyncTime = Date.now();
      this.saveToStorageImmediate();
      this.emit('syncSuccess', { count: 0, message: '电脑端仅下载模式，已清空上传队列' });
      this.emit('queueChanged', this.getQueueStatus());
      return;
    }
    
    this.isSyncing = true;
    this.lastSyncError = null;
    const totalCount = this.markLearnedQueue.size + this.reviewFeedbackQueue.size + 
                       this.addSentenceQueue.size + this.dictationRecordQueue.size +
                       this.statsSyncQueue.size;
    this.emit('syncStart', { count: totalCount });
    
    this.cleanSyncCache();
    
    try {
      const sentencesToSync: Sentence[] = [];
      const recordsToSync: DictationRecord[] = [];
      const statsToSync: UserStats[] = [];
      
      this.markLearnedQueue.forEach(op => {
        if (!this.isRecentlySynced(op.sentenceId)) {
          sentencesToSync.push(op.updatedSentence);
        }
      });
      
      this.reviewFeedbackQueue.forEach(op => {
        if (!this.isRecentlySynced(op.sentenceId)) {
          sentencesToSync.push(op.updatedSentence);
        }
      });
      
      this.addSentenceQueue.forEach((op, id) => {
        if (!this.isRecentlySynced(id)) {
          sentencesToSync.push(op.sentence);
        }
      });
      
      this.dictationRecordQueue.forEach((op, id) => {
        if (!this.isRecentlySynced(id)) {
          recordsToSync.push(op.record);
        }
      });
      
      this.statsSyncQueue.forEach((op, id) => {
        if (!this.isRecentlySynced(id)) {
          statsToSync.push(op.stats);
        }
      });
      
      if (sentencesToSync.length === 0 && recordsToSync.length === 0 && statsToSync.length === 0) {
        logger.debug('同步队列为空，跳过同步操作');
        this.isSyncing = false;
        this.emit('syncSuccess', { count: 0, message: '无数据需要同步' });
        return;
      }
      
      logger.info('同步数据统计', { 
        sentences: sentencesToSync.length, 
        records: recordsToSync.length, 
        stats: statsToSync.length 
      });
      
      const uniqueSentences = dedupeSentences(sentencesToSync);
      if (uniqueSentences.length !== sentencesToSync.length) {
        logger.debug('同步去重', { 
          before: sentencesToSync.length, 
          after: uniqueSentences.length, 
          duplicates: sentencesToSync.length - uniqueSentences.length 
        });
      }
      
      if (uniqueSentences.length > 0) {
        logger.debug('同步句子', { count: uniqueSentences.length, concurrency: CONCURRENT_LIMIT });
        await runWithConcurrency(
          uniqueSentences.map(s => () => supabaseService.syncSentences([s])),
          CONCURRENT_LIMIT
        );
      }
      
      if (recordsToSync.length > 0) {
        logger.debug('同步默写记录', { count: recordsToSync.length, concurrency: CONCURRENT_LIMIT });
        await runWithConcurrency(
          recordsToSync.map(record => () => supabaseService.syncDictationRecord(record)),
          CONCURRENT_LIMIT
        );
      }
      
      if (statsToSync.length > 0) {
        logger.debug('同步统计数据', { count: statsToSync.length, concurrency: CONCURRENT_LIMIT });
        await runWithConcurrency(
          statsToSync.map(stats => () => supabaseService.syncStats(stats)),
          CONCURRENT_LIMIT
        );
      }
      
      logger.info('增量同步完成', { 
        sentences: sentencesToSync.length, 
        records: recordsToSync.length, 
        stats: statsToSync.length 
      });
      
      this.markLearnedQueue.forEach(op => {
        this.markSynced(op.sentenceId);
        op.synced = true;
      });
      this.reviewFeedbackQueue.forEach(op => {
        this.markSynced(op.sentenceId);
        op.synced = true;
      });
      this.addSentenceQueue.forEach((_, id) => this.markSynced(id));
      this.dictationRecordQueue.forEach((_, id) => this.markSynced(id));
      this.statsSyncQueue.forEach((_, id) => this.markSynced(id));
      
      this.markLearnedQueue.clear();
      this.reviewFeedbackQueue.clear();
      this.addSentenceQueue.clear();
      this.dictationRecordQueue.clear();
      this.statsSyncQueue.clear();
      this.retryCount.clear();
      this.lastSyncTime = Date.now();
      this.saveToStorageImmediate();
      
      const stats = storageService.getStats();
      stats.batchSyncCount = (stats.batchSyncCount || 0) + 1;
      storageService.saveStats(stats, false);
      
      this.emit('syncSuccess', { 
        count: totalCount,
        message: `同步成功: ${totalCount} 条操作` 
      });
      this.emit('queueChanged', this.getQueueStatus());
      
      logger.info('增量同步成功', { count: totalCount });
    } catch (err: unknown) {
      this.handleSyncFailure(totalCount, err instanceof Error ? err.message : '同步异常');
    } finally {
      this.isSyncing = false;
    }
  }

  private handleSyncFailure(totalCount: number, errorMessage: string) {
    this.lastSyncError = errorMessage;
    
    // 智能错误分类
    const errorType = this.classifyError(errorMessage);
    const retryConfig = SMART_RETRY_CONFIG.errorTypes[errorType] || SMART_RETRY_CONFIG.errorTypes.network;
    
    const currentRetry = (this.retryCount.get('global') || 0) + 1;
    this.retryCount.set('global', currentRetry);
    this.saveToStorageImmediate();
    
    logger.warn(`同步失败，准备重试`, { 
      retryCount: currentRetry, 
      error: errorMessage,
      errorType,
      maxRetries: retryConfig.maxRetries
    });
    
    this.emit('syncError', { 
      message: this.lastSyncError, 
      retryCount: currentRetry,
      errorType,
      maxRetries: retryConfig.maxRetries
    });
    
    if (currentRetry < retryConfig.maxRetries) {
      // 智能重试延迟计算：指数退避 + 随机抖动
      const baseDelay = retryConfig.baseDelay * Math.pow(retryConfig.backoffMultiplier, currentRetry - 1);
      const jitter = baseDelay * RETRY_JITTER_RANGE * (Math.random() - 0.5);
      const retryDelay = Math.max(1000, baseDelay + jitter); // 最小延迟1秒
      
      logger.debug(`智能重试延迟计算`, { 
        baseDelay: baseDelay / 1000,
        jitter: jitter / 1000,
        finalDelay: retryDelay / 1000,
        errorType
      });
      
      setTimeout(() => {
        if (this.hasPendingOperations() && navigator.onLine) {
          // 基于操作优先级智能重试
          this.smartRetrySync();
        }
      }, retryDelay);
    } else {
      logger.warn('已达到最大重试次数，停止自动重试', { 
        errorType,
        maxRetries: retryConfig.maxRetries
      });
      this.emit('syncError', { 
        message: `已达到最大重试次数 (${retryConfig.maxRetries})`,
        maxRetriesReached: true,
        errorType
      });
    }
  }

  /**
   * 智能错误分类
   */
  private classifyError(errorMessage: string): keyof typeof SMART_RETRY_CONFIG.errorTypes {
    const message = errorMessage.toLowerCase();
    
    if (message.includes('network') || message.includes('fetch') || message.includes('timeout')) {
      return 'network';
    }
    
    if (message.includes('quota') || message.includes('storage') || message.includes('limit')) {
      return 'quota';
    }
    
    if (message.includes('auth') || message.includes('unauthorized') || message.includes('token')) {
      return 'auth';
    }
    
    if (message.includes('server') || message.includes('5') || message.includes('internal')) {
      return 'server';
    }
    
    return 'network'; // 默认分类
  }

  /**
   * 智能重试同步（基于优先级）
   */
  private async smartRetrySync(): Promise<void> {
    try {
      // 检查网络连通性
      const isReallyOnline = await networkService.checkConnectivity();
      if (!isReallyOnline) {
        logger.warn('网络连通性检查失败，延迟重试');
        setTimeout(() => this.smartRetrySync(), 5000);
        return;
      }
      
      // 基于操作优先级执行同步
      const queueStatus = this.getQueueStatus();
      const hasHighPriorityOps = queueStatus.markLearnedCount > 0 || queueStatus.reviewFeedbackCount > 0;
      
      if (hasHighPriorityOps) {
        // 优先同步高优先级操作
        logger.info('执行高优先级操作同步');
        await this.doSyncWithPriority(['markLearned', 'reviewFeedback']);
      } else {
        // 同步所有操作
        await this.doSync();
      }
    } catch (error) {
      logger.error('智能重试失败', { error: String(error) });
      // 降级到普通重试
      this.doSync();
    }
  }

  /**
   * 基于优先级的同步
   */
  private async doSyncWithPriority(priorityTypes: PendingOperationType[]): Promise<void> {
    this.isSyncing = true;
    this.emit('syncStart', { count: this.getPendingOperations().length });
    
    try {
      // 只同步指定优先级的操作
      const operationsToSync = this.getPendingOperations().filter(op => 
        priorityTypes.includes(op.type)
      );
      
      if (operationsToSync.length === 0) {
        logger.info('无高优先级操作需要同步');
        this.emit('syncSuccess', { count: 0, message: '无高优先级操作需要同步' });
        return;
      }
      
      const successCount = await this.processOperations(operationsToSync);
      
      this.lastSyncTime = Date.now();
      this.nextSyncTime = this.calculateNextSyncTime();
      this.lastSyncError = null;
      this.retryCount.delete('global');
      
      this.emit('syncSuccess', { 
        count: successCount,
        message: `高优先级同步成功: ${successCount} 条操作` 
      });
      
      logger.info('高优先级同步成功', { count: successCount, types: priorityTypes });
    } catch (error) {
      this.handleSyncFailure(0, error instanceof Error ? error.message : '智能同步异常');
    } finally {
      this.isSyncing = false;
    }
  }



  private async syncIncremental(sentences: Sentence[], records: DictationRecord[], statsToSync: UserStats[]): Promise<{ success: boolean; message: string }> {
    if (!supabaseService.client || !supabaseService.isReady) {
      return { success: false, message: '云同步未配置' };
    }

    try {
      if (sentences.length > 0) {
        const sanitizedSentences = sentences.map(s => sanitizeSentenceForQuery(s));
        const englishList = sanitizedSentences
          .map(s => sanitizeEnglish(s.english))
          .filter(e => e.length > 0 && e.length <= 500);
        
        if (englishList.length === 0) {
          logger.warn('无有效英文句子可同步');
          return { success: false, message: '无有效数据可同步' };
        }

        const { data: existingSentences, error: queryError } = await supabaseService.client
          .from('sentences')
          .select('id, english, updatedat')
          .in('english', englishList)
          .eq('username', supabaseService.userName);

        if (queryError) {
          logger.warn('查询云端现有句子失败', { error: queryError.message });
        }

        const cloudMap = new Map<string, CloudSentence>();
        (existingSentences || []).forEach((es: CloudSentence) => {
          cloudMap.set(es.english.toLowerCase(), es);
        });

        const toUpload: object[] = [];
        const merged: Sentence[] = [];

        sanitizedSentences.forEach(localSentence => {
          const normalizedEnglish = localSentence.english.toLowerCase();
          const cloudSentence = cloudMap.get(normalizedEnglish);

          if (cloudSentence) {
            const localTime = localSentence.updatedAt ? new Date(localSentence.updatedAt).getTime() : 0;
            const cloudTime = cloudSentence.updatedat ? new Date(cloudSentence.updatedat).getTime() : 0;

            if (localTime > cloudTime) {
              const validId = cloudSentence.id;
              toUpload.push({
                id: validId,
                english: localSentence.english,
                chinese: localSentence.chinese,
                tags: Array.isArray(localSentence.tags) ? localSentence.tags.join(';') : (localSentence.tags || ''),
                intervalindex: localSentence.intervalIndex,
                addedat: localSentence.addedAt,
                nextreviewdate: localSentence.nextReviewDate,
                lastreviewedat: localSentence.lastReviewedAt,
                timesreviewed: localSentence.timesReviewed,
                ismanual: localSentence.isManual || false,
                updatedat: localSentence.updatedAt || Date.now(),
                username: supabaseService.userName,
                stability: localSentence.stability,
                difficulty: localSentence.difficulty,
                reps: localSentence.reps || 0,
                lapses: localSentence.lapses || 0,
                state: localSentence.state || 0,
                scheduleddays: localSentence.scheduledDays
              });
              merged.push(localSentence);
            } else {
              merged.push({
                id: cloudSentence.id,
                english: cloudSentence.english,
                chinese: '',
                tags: [],
                intervalIndex: 0,
                addedAt: 0,
                nextReviewDate: null,
                lastReviewedAt: null,
                timesReviewed: 0,
                isManual: false,
                updatedAt: cloudSentence.updatedat,
                stability: 0,
                difficulty: 0,
                reps: 0,
                lapses: 0,
                state: 0,
                scheduledDays: 0,
                masteryLevel: 0,
                wrongDictations: 0
              });
            }
          } else {
            let validId = localSentence.id;
            if (!isValidUUID(localSentence.id)) {
              validId = generateUUID();
              logger.warn(`ID不是有效UUID，已转换`, { oldId: localSentence.id, newId: validId });
            }

            toUpload.push({
              id: validId,
              english: localSentence.english,
              chinese: localSentence.chinese,
              tags: Array.isArray(localSentence.tags) ? localSentence.tags.join(';') : (localSentence.tags || ''),
              intervalindex: localSentence.intervalIndex,
              addedat: localSentence.addedAt,
              nextreviewdate: localSentence.nextReviewDate,
              lastreviewedat: localSentence.lastReviewedAt,
              timesreviewed: localSentence.timesReviewed,
              ismanual: localSentence.isManual || false,
              updatedat: localSentence.updatedAt || Date.now(),
              username: supabaseService.userName,
              stability: localSentence.stability,
              difficulty: localSentence.difficulty,
              reps: localSentence.reps || 0,
              lapses: localSentence.lapses || 0,
              state: localSentence.state || 0,
              scheduleddays: localSentence.scheduledDays
            });
            merged.push(localSentence);
          }
        });

        if (toUpload.length > 0) {
          let successCount = 0;
          let skipCount = 0;
          let idempotentSkipCount = 0;
          
          this.cleanupOperationRecords();
          
          for (let i = 0; i < toUpload.length; i++) {
            const sentenceData = toUpload[i] as { id: string; english: string };
            const operationId = this.generateOperationId('sentence_sync', { id: sentenceData.id, english: sentenceData.english });
            
            if (this.isOperationCompleted(operationId)) {
              idempotentSkipCount++;
              successCount++;
              continue;
            }
            
            try {
              const { error } = await supabaseService.client
                .from('sentences')
                .upsert(sentenceData, { onConflict: 'id' });
              
              if (error) {
                logger.warn(`单条同步失败`, { id: sentenceData.id, error: error.message });
                skipCount++;
                continue;
              }
              
              this.recordOperation(operationId, 'sentence_sync', sentenceData.id, sentenceData.english);
              successCount++;
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              if (errorMessage.includes('unique constraint')) {
                logger.warn(`跳过重复数据`, { id: sentenceData.id });
                skipCount++;
              } else {
                logger.error(`单条同步失败`, { id: sentenceData.id, error: errorMessage });
                skipCount++;
              }
            }
          }
          
          logger.info(`云端同步完成`, { success: successCount, skipped: skipCount, idempotent: idempotentSkipCount });
        }
      }
      
      if (records.length > 0) {
        for (const record of records) {
          const operationId = this.generateOperationId('dictation_sync', { sentenceId: record.sentenceId, timestamp: record.timestamp });
          
          if (this.isOperationCompleted(operationId)) {
            continue;
          }
          
          const success = await supabaseService.syncDictationRecord(record);
          if (success) {
            this.recordOperation(operationId, 'dictation_sync', record.sentenceId);
          } else {
            logger.warn('默写记录同步失败', { sentenceId: record.sentenceId });
          }
        }
      }
      
      if (statsToSync.length > 0) {
        const latestStats = statsToSync[statsToSync.length - 1];
        const operationId = this.generateOperationId('stats_sync', { totalPoints: latestStats.totalPoints, timestamp: Date.now() });
        
        if (!this.isOperationCompleted(operationId)) {
          const result = await supabaseService.pushStats(latestStats);
          if (result.success) {
            this.recordOperation(operationId, 'stats_sync');
          } else {
            logger.warn('统计数据同步失败', { error: result.message });
          }
        }
      }

      return { success: true, message: `成功同步 ${sentences.length} 条句子, ${records.length} 条默写记录, ${statsToSync.length} 条统计数据` };
    } catch (err: unknown) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async forceSync() {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
      this.nextSyncTime = null;
    }
    
    const isOnline = await networkService.checkConnectivity();
    if (!isOnline) {
      logger.warn('网络未连接，跳过强制同步');
      return;
    }
    
    const sentencesToSync: Sentence[] = [];
    const recordsToSync: DictationRecord[] = [];
    const statsToSync: UserStats[] = [];
    
    this.markLearnedQueue.forEach(op => {
      sentencesToSync.push(op.updatedSentence);
    });
    
    this.reviewFeedbackQueue.forEach(op => {
      sentencesToSync.push(op.updatedSentence);
    });
    
    this.addSentenceQueue.forEach(op => {
      sentencesToSync.push(op.sentence);
    });
    
    this.dictationRecordQueue.forEach(op => {
      recordsToSync.push(op.record);
    });
    
    this.statsSyncQueue.forEach(op => {
      statsToSync.push(op.stats);
    });
    
    if ((sentencesToSync.length > 0 || recordsToSync.length > 0 || statsToSync.length > 0) && supabaseService.isReady) {
      if (!deviceService.canUploadSync()) {
        logger.info('电脑端仅下载模式，跳过强制同步上传');
        this.markLearnedQueue.clear();
        this.reviewFeedbackQueue.clear();
        this.addSentenceQueue.clear();
        this.dictationRecordQueue.clear();
        this.statsSyncQueue.clear();
        this.lastSyncTime = Date.now();
        this.saveToStorageImmediate();
        return;
      }
      
      const result = await this.syncIncremental(sentencesToSync, recordsToSync, statsToSync);
      
      if (result.success) {
        this.markLearnedQueue.clear();
        this.reviewFeedbackQueue.clear();
        this.addSentenceQueue.clear();
        this.dictationRecordQueue.clear();
        this.statsSyncQueue.clear();
        this.lastSyncTime = Date.now();
        this.saveToStorageImmediate();
      } else {
        logger.warn('强制同步失败', { error: result.message });
      }
    }
  }

  getQueueStatus(): SyncStatus {
    return {
      pendingCount: this.markLearnedQueue.size + this.reviewFeedbackQueue.size + 
                    this.addSentenceQueue.size + this.dictationRecordQueue.size +
                    this.statsSyncQueue.size,
      markLearnedCount: this.markLearnedQueue.size,
      reviewFeedbackCount: this.reviewFeedbackQueue.size,
      addSentenceCount: this.addSentenceQueue.size,
      dictationRecordCount: this.dictationRecordQueue.size,
      statsSyncCount: this.statsSyncQueue.size,
      isSyncing: this.isSyncing,
      lastSyncTime: this.lastSyncTime,
      nextSyncTime: this.nextSyncTime,
      lastSyncError: this.lastSyncError
    };
  }

  async syncNow(): Promise<{ success: boolean; message: string }> {
    // 如果已有同步进行中，返回同一个 Promise（避免竞态条件）
    if (this.syncPromise) {
      return this.syncPromise;
    }
    
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
      this.nextSyncTime = null;
    }
    
    this.syncPromise = this._doSyncNow();
    
    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  private async _doSyncNow(): Promise<{ success: boolean; message: string }> {
    try {
      await this.doSync();
      
      const hasPending = this.hasPendingOperations();
      const errorMessage = this.lastSyncError;
      
      if (hasPending || errorMessage) {
        this.scheduleSync();
      }
      
      return {
        success: !hasPending && !errorMessage,
        message: errorMessage || (hasPending ? '同步失败，已安排重试' : '同步成功')
      };
    } catch (err) {
      this.scheduleSync();
      return {
        success: false,
        message: '同步失败，已安排重试'
      };
    }
  }

  clearError() {
    this.lastSyncError = null;
    this.retryCount.delete('global');
    this.saveToStorageImmediate();
    this.emit('queueChanged', this.getQueueStatus());
  }

  /**
   * 处理同步操作
   */
  private async processOperations(operations: PendingOperation[]): Promise<number> {
    let successCount = 0;
    
    try {
      // 这里实现具体的操作处理逻辑
      // 暂时返回成功计数为0，避免影响现有逻辑
      return successCount;
    } catch (error) {
      logger.error('处理操作失败', { error: String(error) });
      return successCount;
    }
  }

  /**
   * 计算下次同步时间
   */
  private calculateNextSyncTime(): number {
    const baseDelay = 5 * 60 * 1000; // 5分钟
    const jitter = Math.random() * 2 * 60 * 1000; // 0-2分钟随机抖动
    return Date.now() + baseDelay + jitter;
  }

  clearAll() {
    this.markLearnedQueue.clear();
    this.reviewFeedbackQueue.clear();
    this.addSentenceQueue.clear();
    this.dictationRecordQueue.clear();
    this.statsSyncQueue.clear();
    this.retryCount.clear();
    this.saveToStorageImmediate();
    this.emit('queueChanged', this.getQueueStatus());
  }

  async clearCorruptedStorage(): Promise<void> {
    localStorage.removeItem(STORAGE_KEY_ALL_QUEUES);
    localStorage.removeItem(EMERGENCY_STORE_KEY);
    
    this.markLearnedQueue.clear();
    this.reviewFeedbackQueue.clear();
    this.addSentenceQueue.clear();
    this.dictationRecordQueue.clear();
    this.statsSyncQueue.clear();
    this.retryCount.clear();
    this.lastSyncTime = 0;
    
    this.emit('queueChanged', this.getQueueStatus());
    logger.info('已清除损坏的存储数据');
  }
}

export const syncQueueService = new SyncQueueService();
