import { Sentence, ReviewRating, DictationRecord, UserStats } from '../types';
import { supabaseService } from './supabaseService';
import { storageService } from './storage';
import { networkService } from './networkService';
import { generateUUID, isValidUUID } from '../utils/uuid';
import { SYNC_CONFIG } from '../constants';
import { dedupeSentences } from '../utils/validators';

interface MarkLearnedOperation {
  sentenceId: string;
  updatedSentence: Sentence;
  timestamp: number;
}

interface ReviewFeedbackOperation {
  sentenceId: string;
  updatedSentence: Sentence;
  feedback: ReviewRating;
  timestamp: number;
}

interface AddSentenceOperation {
  sentence: Sentence;
  timestamp: number;
}

interface DictationRecordOperation {
  record: DictationRecord;
  timestamp: number;
}

interface StatsSyncOperation {
  stats: UserStats;
  timestamp: number;
}

type OfflineOperation = MarkLearnedOperation | ReviewFeedbackOperation | AddSentenceOperation | DictationRecordOperation | StatsSyncOperation;

export interface SyncStatus {
  pendingCount: number;
  markLearnedCount: number;
  reviewFeedbackCount: number;
  addSentenceCount: number;
  dictationRecordCount: number;
  statsSyncCount: number;
  isSyncing: boolean;
  lastSyncTime: number | null;
  nextSyncTime: number | null;
  lastSyncError: string | null;
}

const SYNC_DELAY = 5000;
const MAX_RETRY_COUNT = 3;
const STORAGE_KEY_PREFIX = 'sync_queue_';

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

type SyncEventType = 'syncStart' | 'syncSuccess' | 'syncError' | 'queueChanged';

class SyncQueueService {
  // ✅ 优化：使用 Map 存储，提高性能
  private markLearnedQueue: Map<string, MarkLearnedOperation> = new Map();
  private reviewFeedbackQueue: Map<string, ReviewFeedbackOperation> = new Map();
  private addSentenceQueue: Map<string, AddSentenceOperation> = new Map();
  private dictationRecordQueue: Map<string, DictationRecordOperation> = new Map();
  private statsSyncQueue: Map<string, StatsSyncOperation> = new Map();
  private completedOperations: Set<string> = new Set();
  private retryCount: Map<string, number> = new Map();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private isSyncing = false;
  private lastSyncTime: number | null = null;
  private nextSyncTime: number | null = null;
  private lastSyncError: string | null = null;
  private eventListeners: Map<SyncEventType, Set<(data?: any) => void>> = new Map();

  constructor() {
    this.loadFromStorage();
    this.setupUnloadHandler();
    this.setupOnlineHandler();
    this.initEventTypes();
  }

  private initEventTypes() {
    const eventTypes: SyncEventType[] = ['syncStart', 'syncSuccess', 'syncError', 'queueChanged'];
    eventTypes.forEach(type => {
      this.eventListeners.set(type, new Set());
    });
  }

  on(event: SyncEventType, callback: (data?: any) => void) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.add(callback);
    }
    return () => {
      listeners?.delete(callback);
    };
  }

  // ✅ 添加 off 方法，用于取消事件监听
  off(event: SyncEventType, callback: (data?: any) => void) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  private emit(event: SyncEventType, data?: any) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      // ✅ 使用 try-catch 防止单个监听器错误影响其他监听器
      listeners.forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          console.error(`事件监听器 ${event} 执行错误:`, err);
        }
      });
    }
  }

  private loadFromStorage() {
    try {
      const markLearnedData = localStorage.getItem(`${STORAGE_KEY_PREFIX}markLearned`);
      const reviewFeedbackData = localStorage.getItem(`${STORAGE_KEY_PREFIX}reviewFeedback`);
      const addSentenceData = localStorage.getItem(`${STORAGE_KEY_PREFIX}addSentence`);
      const dictationRecordData = localStorage.getItem(`${STORAGE_KEY_PREFIX}dictationRecord`);
      const statsSyncData = localStorage.getItem(`${STORAGE_KEY_PREFIX}statsSync`);
      const lastSyncData = localStorage.getItem(`${STORAGE_KEY_PREFIX}lastSyncTime`);
      
      if (markLearnedData) {
        const parsed = JSON.parse(markLearnedData);
        this.markLearnedQueue = new Map(Object.entries(parsed));
      }
      
      if (reviewFeedbackData) {
        const parsed = JSON.parse(reviewFeedbackData);
        this.reviewFeedbackQueue = new Map(Object.entries(parsed));
      }
      
      if (addSentenceData) {
        const parsed = JSON.parse(addSentenceData);
        this.addSentenceQueue = new Map(Object.entries(parsed));
      }
      
      if (dictationRecordData) {
        const parsed = JSON.parse(dictationRecordData);
        this.dictationRecordQueue = new Map(Object.entries(parsed));
      }
      
      if (statsSyncData) {
        const parsed = JSON.parse(statsSyncData);
        this.statsSyncQueue = new Map(Object.entries(parsed));
      }
      
      if (lastSyncData) {
        this.lastSyncTime = Number(lastSyncData);
      }
    } catch (err) {
      console.warn('加载同步队列失败:', err);
    }
  }

  private saveToStorage() {
    // ✅ 优化：错误隔离，每个队列独立保存，避免一个失败影响其他队列
    const queues = [
      { key: 'markLearned', data: this.markLearnedQueue },
      { key: 'reviewFeedback', data: this.reviewFeedbackQueue },
      { key: 'addSentence', data: this.addSentenceQueue },
      { key: 'dictationRecord', data: this.dictationRecordQueue },
      { key: 'statsSync', data: this.statsSyncQueue }
    ];
    
    queues.forEach(({ key, data }) => {
      try {
        const obj = Object.fromEntries(data);
        localStorage.setItem(`${STORAGE_KEY_PREFIX}${key}`, JSON.stringify(obj));
      } catch (err) {
        console.error(`保存队列 ${key} 失败:`, err);
      }
    });
    
    if (this.lastSyncTime) {
      try {
        localStorage.setItem(`${STORAGE_KEY_PREFIX}lastSyncTime`, this.lastSyncTime.toString());
      } catch (err) {
        console.error('保存同步时间失败:', err);
      }
    }
  }

  private unloadHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;

  private setupUnloadHandler() {
    this.unloadHandler = () => {
      if (this.hasPendingOperations()) {
        this.forceSync();
      }
    };
    window.addEventListener('beforeunload', this.unloadHandler);
    
    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden' && this.hasPendingOperations()) {
        this.forceSync();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private setupOnlineHandler() {
    this.onlineHandler = () => {
      if (this.hasPendingOperations() && !this.isSyncing) {
        if (import.meta.env.DEV) {
          console.log('🌐 网络恢复，自动开始同步');
        }
        this.doSync();
      }
    };
    window.addEventListener('online', this.onlineHandler);
  }

  // 清理事件监听器（用于应用销毁时）
  destroy() {
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
  }

  private hasPendingOperations(): boolean {
    return this.markLearnedQueue.size > 0 || 
           this.reviewFeedbackQueue.size > 0 || 
           this.addSentenceQueue.size > 0 || 
           this.dictationRecordQueue.size > 0 ||
           this.statsSyncQueue.size > 0;
  }

  // 检查队列大小并清理旧数据
  private checkQueueLimit<T>(queue: Map<string, T>, limit: number, queueName: string): boolean {
    // 队列已满，拒绝新操作
    if (queue.size >= limit) {
      console.error(`${queueName} 队列已满 (${queue.size}/${limit})，拒绝新操作`);
      this.emit('syncError', { message: `${queueName} 队列已满，请检查网络连接` });
      return false;
    }
    
    // 队列接近上限，清理旧数据
    if (queue.size >= limit * QUEUE_WARN_THRESHOLD) {
      console.warn(`${queueName} 队列接近上限 (${queue.size}/${limit})，开始清理旧数据`);
      
      const entries = Array.from(queue.entries());
      // 按时间戳排序，删除最旧的
      entries.sort((a, b) => {
        const timeA = (a[1] as any).timestamp || 0;
        const timeB = (b[1] as any).timestamp || 0;
        return timeA - timeB;
      });
      
      // 删除超出限制的部分，保留 80%
      const keepCount = Math.floor(limit * QUEUE_WARN_THRESHOLD);
      const toDelete = entries.slice(0, entries.length - keepCount);
      toDelete.forEach(([key]) => queue.delete(key));
      
      console.warn(`${queueName} 队列已清理，删除 ${toDelete.length} 条旧数据`);
    }
    
    return true;
  }

  addMarkLearned(sentenceId: string, updatedSentence: Sentence) {
    if (!this.checkQueueLimit(this.markLearnedQueue, QUEUE_LIMITS.markLearned, 'markLearned')) {
      return;
    }
    
    this.markLearnedQueue.set(sentenceId, {
      sentenceId,
      updatedSentence,
      timestamp: Date.now()
    });
    
    this.reviewFeedbackQueue.delete(sentenceId);
    
    this.saveToStorage();
    this.emit('queueChanged', this.getQueueStatus());
    this.scheduleSync();
  }

  addReviewFeedback(sentenceId: string, updatedSentence: Sentence, feedback: ReviewRating) {
    if (!this.checkQueueLimit(this.reviewFeedbackQueue, QUEUE_LIMITS.reviewFeedback, 'reviewFeedback')) {
      return;
    }
    
    this.reviewFeedbackQueue.set(sentenceId, {
      sentenceId,
      updatedSentence,
      feedback,
      timestamp: Date.now()
    });
    
    this.markLearnedQueue.delete(sentenceId);
    
    this.saveToStorage();
    this.emit('queueChanged', this.getQueueStatus());
    this.scheduleSync();
  }

  addSentence(sentence: Sentence) {
    if (!this.checkQueueLimit(this.addSentenceQueue, QUEUE_LIMITS.addSentence, 'addSentence')) {
      return;
    }
    
    const id = sentence.id || `new_${Date.now()}`;
    this.addSentenceQueue.set(id, {
      sentence,
      timestamp: Date.now()
    });
    
    this.saveToStorage();
    this.emit('queueChanged', this.getQueueStatus());
    this.scheduleSync();
  }

  addDictationRecord(record: DictationRecord) {
    if (!this.checkQueueLimit(this.dictationRecordQueue, QUEUE_LIMITS.dictationRecord, 'dictationRecord')) {
      return;
    }
    
    const id = `${record.sentenceId}_${Date.now()}`;
    this.dictationRecordQueue.set(id, {
      record,
      timestamp: Date.now()
    });
    
    this.saveToStorage();
    this.emit('queueChanged', this.getQueueStatus());
    this.scheduleSync();
  }

  addStatsSync(stats: UserStats) {
    if (!this.checkQueueLimit(this.statsSyncQueue, QUEUE_LIMITS.statsSync, 'statsSync')) {
      return;
    }
    
    const id = `stats_${Date.now()}`;
    this.statsSyncQueue.set(id, {
      stats,
      timestamp: Date.now()
    });
    
    this.saveToStorage();
    this.emit('queueChanged', this.getQueueStatus());
    this.scheduleSync();
  }

  getPendingOperations(): { type: string; payload: any; id: string }[] {
    const operations: { type: string; payload: any; id: string }[] = [];
    
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
    
    // ✅ 使用网络服务检查真实连接性
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
    
    this.isSyncing = true;
    this.lastSyncError = null;
    const totalCount = this.markLearnedQueue.size + this.reviewFeedbackQueue.size + 
                       this.addSentenceQueue.size + this.dictationRecordQueue.size +
                       this.statsSyncQueue.size;
    this.emit('syncStart', { count: totalCount });
    
    try {
      // ✅ 分批处理，避免单次同步数据量过大
      const BATCH_SIZE = 50;
      const sentencesToSync: Sentence[] = [];
      const recordsToSync: DictationRecord[] = [];
      const statsToSync: UserStats[] = [];
      
      this.markLearnedQueue.forEach(op => {
        sentencesToSync.push(op.updatedSentence);
      });
      
      this.reviewFeedbackQueue.forEach(op => {
        sentencesToSync.push(op.updatedSentence);
      });
      
      this.addSentenceQueue.forEach((op, id) => {
        sentencesToSync.push(op.sentence);
      });
      
      this.dictationRecordQueue.forEach((op, id) => {
        recordsToSync.push(op.record);
      });
      
      this.statsSyncQueue.forEach((op, id) => {
        statsToSync.push(op.stats);
      });
      
      // 🔴 修复：增强空数组检查，添加详细日志和边界情况处理
      if (sentencesToSync.length === 0 && recordsToSync.length === 0 && statsToSync.length === 0) {
        if (import.meta.env.DEV) {
          console.log('📊 同步队列为空，跳过同步操作');
        }
        this.isSyncing = false;
        this.emit('syncSuccess', { count: 0, message: '无数据需要同步' });
        return;
      }
      
      // 记录同步数据统计
      if (import.meta.env.DEV) {
        console.log(`📊 同步数据统计: ${sentencesToSync.length}句子, ${recordsToSync.length}记录, ${statsToSync.length}统计`);
      }
      
      // ✅ 同步前置去重：按 english 字段去重，保留最新版本
      const uniqueSentences = dedupeSentences(sentencesToSync);
      if (uniqueSentences.length !== sentencesToSync.length) {
        if (import.meta.env.DEV) {
          console.log(`📊 同步去重: ${sentencesToSync.length} 条 → ${uniqueSentences.length} 条 (${sentencesToSync.length - uniqueSentences.length} 条重复)`);
        }
      }
      
      // ✅ 分批同步句子（限流并发）
      for (let i = 0; i < uniqueSentences.length; i += BATCH_SIZE) {
        const batch = uniqueSentences.slice(i, i + BATCH_SIZE);
        if (import.meta.env.DEV) {
          console.log(`📡 同步句子批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(uniqueSentences.length / BATCH_SIZE)} (${batch.length} 条)`);
        }
        
        // ✅ 限流：每次最多并发 CONCURRENT_LIMIT 条
        for (let j = 0; j < batch.length; j += CONCURRENT_LIMIT) {
          const concurrentBatch = batch.slice(j, j + CONCURRENT_LIMIT);
          await Promise.all(concurrentBatch.map(s => supabaseService.syncSentences([s])));
        }
      }
      
      // ✅ 分批同步默写记录（限流并发）
      for (let i = 0; i < recordsToSync.length; i += BATCH_SIZE) {
        const batch = recordsToSync.slice(i, i + BATCH_SIZE);
        if (import.meta.env.DEV) {
          console.log(`📡 同步默写记录批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(recordsToSync.length / BATCH_SIZE)} (${batch.length} 条)`);
        }
        
        // ✅ 限流：每次最多并发 CONCURRENT_LIMIT 条
        for (let j = 0; j < batch.length; j += CONCURRENT_LIMIT) {
          const concurrentBatch = batch.slice(j, j + CONCURRENT_LIMIT);
          await Promise.all(concurrentBatch.map(record => supabaseService.syncDictationRecord(record)));
        }
      }
      
      // ✅ 分批同步统计数据（限流并发）
      for (let i = 0; i < statsToSync.length; i += BATCH_SIZE) {
        const batch = statsToSync.slice(i, i + BATCH_SIZE);
        if (import.meta.env.DEV) {
          console.log(`📡 同步统计数据批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(statsToSync.length / BATCH_SIZE)} (${batch.length} 条)`);
        }
        
        // ✅ 限流：每次最多并发 CONCURRENT_LIMIT 条
        for (let j = 0; j < batch.length; j += CONCURRENT_LIMIT) {
          const concurrentBatch = batch.slice(j, j + CONCURRENT_LIMIT);
          await Promise.all(concurrentBatch.map(stats => supabaseService.syncStats(stats)));
        }
      }
      
      if (import.meta.env.DEV) {
        console.log(`📡 增量同步完成: ${sentencesToSync.length} 条句子, ${recordsToSync.length} 条默写记录, ${statsToSync.length} 条统计数据`);
      }
      
      this.markLearnedQueue.clear();
      this.reviewFeedbackQueue.clear();
      this.addSentenceQueue.clear();
      this.dictationRecordQueue.clear();
      this.statsSyncQueue.clear();
      this.retryCount.clear();
      this.lastSyncTime = Date.now();
      this.saveToStorage();
      
      const stats = storageService.getStats();
      stats.batchSyncCount = (stats.batchSyncCount || 0) + 1;
      storageService.saveStats(stats, false);
      
      this.emit('syncSuccess', { 
        count: totalCount,
        message: `同步成功: ${totalCount} 条操作` 
      });
      this.emit('queueChanged', this.getQueueStatus());
      
      if (import.meta.env.DEV) {
        console.log('✅ 增量同步成功');
      }
    } catch (err: any) {
      this.handleSyncFailure(totalCount, err.message || '同步异常');
    } finally {
      this.isSyncing = false;
    }
  }

  private handleSyncFailure(totalCount: number, errorMessage: string) {
    this.lastSyncError = errorMessage;
    const currentRetry = (this.retryCount.get('global') || 0) + 1;
    this.retryCount.set('global', currentRetry);
    this.saveToStorage();
    
    console.warn(`❌ 同步失败 (第${currentRetry}次): ${errorMessage}`);
    this.emit('syncError', { message: this.lastSyncError, retryCount: currentRetry });
    
    if (currentRetry < MAX_RETRY_COUNT) {
      const retryDelay = SYNC_DELAY * Math.pow(2, currentRetry - 1);
      if (import.meta.env.DEV) {
        console.log(`🔄 将在 ${retryDelay / 1000} 秒后自动重试...`);
      }
      setTimeout(() => {
        if (this.hasPendingOperations() && navigator.onLine) {
          this.doSync();
        }
      }, retryDelay);
    } else {
      console.warn('⚠️ 已达到最大重试次数，停止自动重试');
      this.emit('syncError', { message: '已达到最大重试次数', maxRetriesReached: true });
    }
  }



  private async syncIncremental(sentences: Sentence[], records: DictationRecord[], statsToSync: UserStats[]): Promise<{ success: boolean; message: string }> {
    if (!supabaseService.client || !supabaseService.isReady) {
      return { success: false, message: '云同步未配置' };
    }

    try {
      if (sentences.length > 0) {
        // ✅ 先查询云端已存在的英文句子，避免唯一约束冲突
        const englishList = sentences.map(s => s.english.trim().toLowerCase());
        const { data: existingSentences, error: queryError } = await supabaseService.client
          .from('sentences')
          .select('id, english, updatedat')
          .in('english', englishList)
          .eq('username', supabaseService.userName);
        
        if (queryError) {
          console.warn('查询云端现有句子失败:', queryError.message);
        }
        
        // ✅ 创建英文到云端句子的映射（用于检测重复）
        const cloudEnglishMap = new Map<string, any>();
        (existingSentences || []).forEach((es: any) => {
          const normalizedEnglish = es.english.trim().toLowerCase();
          // ✅ 如果已存在，只保留更新时间较新的版本
          const existing = cloudEnglishMap.get(normalizedEnglish);
          if (!existing || (es.updatedat && (!existing.updatedat || new Date(es.updatedat) > new Date(existing.updatedat)))) {
            cloudEnglishMap.set(normalizedEnglish, es);
          }
        });
        
        // ✅ 创建本地英文到句子的映射（用于检测本地重复）
        const localEnglishMap = new Map<string, Sentence>();
        sentences.forEach(s => {
          const normalizedEnglish = s.english.trim().toLowerCase();
          const existing = localEnglishMap.get(normalizedEnglish);
          // ✅ 如果已存在，只保留更新时间较新的版本
          if (!existing || (!s.updatedAt || !existing.updatedAt || new Date(s.updatedAt) > new Date(existing.updatedAt))) {
            localEnglishMap.set(normalizedEnglish, s);
          }
        });
        
        // ✅ 合并逻辑：优先使用云端数据，本地更新的版本合并到云端
        const toUpload: any[] = [];
        const merged: Sentence[] = [];
        
        localEnglishMap.forEach((localSentence, normalizedEnglish) => {
          const cloudSentence = cloudEnglishMap.get(normalizedEnglish);
          
          if (cloudSentence) {
            // ✅ 云端已存在相同英文的句子，比较更新时间
            const localTime = localSentence.updatedAt ? new Date(localSentence.updatedAt).getTime() : 0;
            const cloudTime = cloudSentence.updatedat ? new Date(cloudSentence.updatedat).getTime() : 0;
            
            if (localTime > cloudTime) {
              // ✅ 本地更新了，上传本地版本
              const validId = cloudSentence.id;
              toUpload.push({
                id: validId,
                english: localSentence.english,
                chinese: localSentence.chinese,
                tags: localSentence.tags || '',
                intervalindex: localSentence.intervalIndex,
                addedat: localSentence.addedAt,
                nextreviewdate: localSentence.nextReviewDate,
                lastreviewedat: localSentence.lastReviewedAt,
                timesreviewed: localSentence.timesReviewed,
                ismanual: localSentence.isManual,
                updatedat: localSentence.updatedAt || Date.now(),
                username: supabaseService.userName,
                stability: localSentence.stability,
                difficulty: localSentence.difficulty,
                reps: localSentence.reps,
                lapses: localSentence.lapses,
                state: localSentence.state,
                scheduleddays: localSentence.scheduledDays
              });
              merged.push(localSentence);
            } else {
              // ✅ 云端更新了，使用云端版本
              const mergedSentence: Sentence = {
                id: cloudSentence.id,
                english: cloudSentence.english,
                chinese: cloudSentence.chinese,
                tags: cloudSentence.tags || '',
                intervalIndex: cloudSentence.intervalindex,
                addedAt: cloudSentence.addedat,
                nextReviewDate: cloudSentence.nextreviewdate,
                lastReviewedAt: cloudSentence.lastreviewedat,
                timesReviewed: cloudSentence.timesreviewed,
                isManual: cloudSentence.ismanual,
                updatedAt: cloudSentence.updatedat,
                stability: cloudSentence.stability,
                difficulty: cloudSentence.difficulty,
                reps: cloudSentence.reps,
                lapses: cloudSentence.lapses,
                state: cloudSentence.state,
                scheduledDays: cloudSentence.scheduleddays,
                masteryLevel: 0,
                wrongDictations: 0
              };
              merged.push(mergedSentence);
            }
          } else {
            // ✅ 云端不存在，直接上传
            let validId = localSentence.id;
            if (!isValidUUID(localSentence.id)) {
              validId = generateUUID();
              console.warn(`ID ${localSentence.id} 不是有效 UUID，已转换为 ${validId}`);
            }
            
            toUpload.push({
              id: validId,
              english: localSentence.english,
              chinese: localSentence.chinese,
              tags: localSentence.tags || '',
              intervalindex: localSentence.intervalIndex,
              addedat: localSentence.addedAt,
              nextreviewdate: localSentence.nextReviewDate,
              lastreviewedat: localSentence.lastReviewedAt,
              timesreviewed: localSentence.timesReviewed,
              ismanual: localSentence.isManual,
              updatedat: localSentence.updatedAt || Date.now(),
              username: supabaseService.userName,
              stability: localSentence.stability,
              difficulty: localSentence.difficulty,
              reps: localSentence.reps,
              lapses: localSentence.lapses,
              state: localSentence.state,
              scheduleddays: localSentence.scheduledDays
            });
            merged.push(localSentence);
          }
        });
        
        if (toUpload.length > 0) {
          // ✅ 逐条执行隔离错误：即使某条失败，其余仍可成功
          let successCount = 0;
          let skipCount = 0;
          
          for (let i = 0; i < toUpload.length; i++) {
            const sentenceData = toUpload[i];
            try {
              const { error } = await supabaseService.client
                .from('sentences')
                .upsert(sentenceData, { onConflict: 'id' });
              
              if (error) {
                console.warn(`⚠️ 单条同步失败 (id: ${sentenceData.id}):`, error.message);
                skipCount++;
                continue;
              }
              
              successCount++;
            } catch (err: any) {
              if (err.message && err.message.includes('unique constraint')) {
                console.warn(`⚠️ 跳过重复数据 (id: ${sentenceData.id}):`, err.message);
                skipCount++;
              } else {
                console.error(`❌ 单条同步失败 (id: ${sentenceData.id}):`, err.message);
                skipCount++;
              }
            }
          }
          
          console.log(`✅ 云端同步成功: ${successCount} 条, 跳过: ${skipCount} 条重复`);
        }
      }
      
      if (records.length > 0) {
        for (const record of records) {
          const success = await supabaseService.syncDictationRecord(record);
          if (!success) {
            console.warn('默写记录同步失败:', record.sentenceId);
          }
        }
      }
      
      if (statsToSync.length > 0) {
        const latestStats = statsToSync[statsToSync.length - 1];
        const result = await supabaseService.pushStats(latestStats);
        if (!result.success) {
          console.warn('统计数据同步失败:', result.message);
        }
      }

      return { success: true, message: `成功同步 ${sentences.length} 条句子, ${records.length} 条默写记录, ${statsToSync.length} 条统计数据` };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async forceSync() {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
      this.nextSyncTime = null;
    }
    
    // ✅ 使用网络服务检查真实连接性
    const isOnline = await networkService.checkConnectivity();
    if (!isOnline) {
      console.warn('网络未连接，跳过强制同步');
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
      const result = await this.syncIncremental(sentencesToSync, recordsToSync, statsToSync);
      
      if (result.success) {
        this.markLearnedQueue.clear();
        this.reviewFeedbackQueue.clear();
        this.addSentenceQueue.clear();
        this.dictationRecordQueue.clear();
        this.statsSyncQueue.clear();
        this.lastSyncTime = Date.now();
        this.saveToStorage();
      } else {
        console.warn('强制同步失败:', result.message);
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
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
      this.nextSyncTime = null;
    }
    
    await this.doSync();
    
    const hasPending = this.hasPendingOperations();
    const errorMessage = this.lastSyncError;
    
    return {
      success: !hasPending && !errorMessage,
      message: errorMessage || (hasPending ? '部分操作同步中...' : '同步成功')
    };
  }

  clearError() {
    this.lastSyncError = null;
    this.retryCount.delete('global');
    this.saveToStorage();
    this.emit('queueChanged', this.getQueueStatus());
  }

  clearAll() {
    this.markLearnedQueue.clear();
    this.reviewFeedbackQueue.clear();
    this.addSentenceQueue.clear();
    this.dictationRecordQueue.clear();
    this.statsSyncQueue.clear();
    this.retryCount.clear();
    this.saveToStorage();
    this.emit('queueChanged', this.getQueueStatus());
  }
}

export const syncQueueService = new SyncQueueService();
