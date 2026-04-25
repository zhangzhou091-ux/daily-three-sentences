import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Sentence, UserStats, UserSettings, DictationRecord, QueueTask } from '../types';
import { generateUUID, isValidUUID } from '../utils/uuid';
import { getSupabaseConfig } from '../constants';
import { deviceService } from './deviceService';

export interface SyncResult {
  success: boolean;
  message: string;
  errorType?: string;
}

interface StoredConfig {
  url?: string;
  key?: string;
  userName?: string;
}

export interface CloudSentenceData {
  id: string;
  english: string;
  chinese: string;
  addedat: number;
  updatedat: number;
  intervalindex: number;
  nextreviewdate: number | null;
  lastreviewedat: number | null;
  timesreviewed: number;
  ismanual: boolean;
  username: string;
  tags: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: number;
  scheduleddays: number;
  masterylevel: number;
  wrongdictations: number;
  firstreviewpending: boolean;
  learnedat: number | null;
}

// 带超时的 fetch 包装器
async function fetchWithTimeout(
  url: URL | RequestInfo,
  options: RequestInit,
  timeout: number = getSupabaseConfig().TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  let isTimeout = false;
  const timeoutId = setTimeout(() => {
    isTimeout = true;
    controller.abort();
  }, timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      if (isTimeout) {
        throw new Error(`请求超时 (${timeout}ms): ${url}`);
      }
    }
    throw error;
  }
}

// 新增：当日学习列表的云端数据类型
export interface CloudDailySelection {
  user_name: string;
  date: string;
  sentence_ids: string[];
  updated_at: string;
}

class SupabaseService {
  private _client: SupabaseClient | null = null;
  private isConfigured: boolean = false;
  private _userName: string = '';
  private _url: string = '';
  private _key: string = '';
  
  // 同步队列相关属性
  private syncQueue: QueueTask<unknown>[] = [];
  private isSyncing: boolean = false;
  private readonly MAX_CONCURRENT_SYNC = 3;
  private readonly MAX_QUEUE_SIZE = 50;
  private readonly DEFAULT_TASK_TIMEOUT = 30000;
  private queueCleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  private readonly STORAGE_KEY = 'supabase_config';
  private statusListeners: Set<(isReady: boolean) => void> = new Set();
  private cloudSentencesCache: Map<string, CloudSentenceData> = new Map();
  private lastCloudFetchTime: number = 0;
  private readonly CACHE_VALID_DURATION = 60000;
  private lastSyncTime: number = 0;
  
  // 跨标签页认证同步
  private authChannel: BroadcastChannel | null = null;
  private readonly AUTH_CHANNEL_NAME = 'd3s_auth_sync';
  private readonly AUTH_LOGOUT_SIGNAL_KEY = 'd3s_auth_logout_signal';

  get client(): SupabaseClient | null {
    return this._client;
  }

  get userName(): string {
    return this._userName;
  }

  onStatusChange(callback: (isReady: boolean) => void): () => void {
    this.statusListeners.add(callback);
    callback(this.isReady);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  private emitStatusChange() {
    const isReady = this.isReady;
    this.statusListeners.forEach(callback => {
      try {
        callback(isReady);
      } catch (err) {
        console.error('Status listener error:', err);
      }
    });
  }

  private isValidUUID(id: string): boolean {
    return isValidUUID(id);
  }

  private generateValidUUID(): string {
    return generateUUID();
  }

  private cleanUserName(name: string): string {
    return name.replace(/"/g, '');
  }

  // 启动定期清理超时任务
  private startQueueCleanup(): void {
    if (this.queueCleanupTimer) return;
    this.queueCleanupTimer = setInterval(() => {
      this.cleanExpiredTasks();
    }, 10000); // 每10秒清理一次
  }

  // 清理超时任务
  private cleanExpiredTasks(): void {
    const now = Date.now();
    const before = this.syncQueue.length;
    
    this.syncQueue = this.syncQueue.filter(task => {
      if (now - task.createdAt > task.timeout) {
        task.reject(new Error(`任务超时被移除: ${task.type}`));
        return false;
      }
      return true;
    });

    if (before !== this.syncQueue.length) {
      console.log(`队列清理: ${before} -> ${this.syncQueue.length}`);
    }
  }

  // 检查是否已存在相同类型的任务
  private hasTaskOfType(type: string, entityId?: string): boolean {
    return this.syncQueue.some(task => {
      if (task.type !== type) return false;
      if (entityId) {
        return task.id.includes(entityId);
      }
      return true;
    });
  }

  // 按优先级插入队列（sentence > stats > dictation > dailySelection）
  private insertByPriority(task: QueueTask<unknown>): void {
    const priority: Record<string, number> = {
      'sentence': 1,
      'stats': 2,
      'dictation': 3,
      'dailySelection': 4
    };

    const taskPriority = priority[task.type] || 5;
    let insertIndex = this.syncQueue.findIndex(t => 
      (priority[t.type] || 5) > taskPriority
    );

    if (insertIndex === -1) {
      this.syncQueue.push(task);
    } else {
      this.syncQueue.splice(insertIndex, 0, task);
    }
  }

  private async processSyncQueue() {
    if (this.isSyncing || this.syncQueue.length === 0) {
      return;
    }

    this.isSyncing = true;

    try {
      while (this.syncQueue.length > 0) {
        // 检查超时
        this.cleanExpiredTasks();
        
        if (this.syncQueue.length === 0) break;

        const batch = this.syncQueue.splice(0, this.MAX_CONCURRENT_SYNC);
        const results = await Promise.allSettled(
          batch.map(task => task.fn())
        );

        // 处理结果
        results.forEach((result, index) => {
          const task = batch[index];
          if (result.status === 'fulfilled') {
            task.resolve(result.value);
          } else {
            task.reject(result.reason);
          }
        });
      }
    } finally {
      this.isSyncing = false;
    }
  }

  private enqueueSync<T>(
    syncFn: () => Promise<T>,
    options: {
      type: QueueTask['type'];
      id?: string;
      timeout?: number;
      deduplicate?: boolean;
      entityId?: string;
    } = { type: 'sentence' }
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.syncQueue.length >= this.MAX_QUEUE_SIZE) {
        const lowPriorityIndex = this.syncQueue.findIndex(task => 
          task.type === 'dictation' || task.type === 'dailySelection'
        );
        
        if (lowPriorityIndex !== -1) {
          const removedTask = this.syncQueue.splice(lowPriorityIndex, 1)[0];
          removedTask.reject(new Error('被高优先级任务替换'));
          console.log(`[Supabase] 移除低优先级任务: ${removedTask.type}`);
        } else {
          reject(new Error('同步队列已满，请稍后重试'));
          return;
        }
      }

      if (options.deduplicate && options.entityId) {
        const existingIndex = this.syncQueue.findIndex(task =>
          task.type === options.type &&
          (options.entityId ? task.id.includes(options.entityId) : true)
        );
        
        if (existingIndex !== -1) {
          const existingTask = this.syncQueue[existingIndex];
          
          if (options.type === 'stats') {
            console.log(`[Supabase] 检测到重复 stats 任务，执行替换策略`, { 
              entityId: options.entityId,
              existingTaskId: existingTask.id
            });
            this.syncQueue.splice(existingIndex, 1);
            existingTask.reject(new Error('被更新的 stats 任务替换'));
          } else {
            console.log(`[Supabase] 检测到重复 ${options.type} 任务，执行共享Promise策略`, { 
              entityId: options.entityId,
              existingTaskId: existingTask.id
            });
            const originalResolve = existingTask.resolve;
            const originalReject = existingTask.reject;
            
            existingTask.resolve = (value: unknown) => {
              originalResolve(value as T);
              resolve(value as T);
            };
            existingTask.reject = (reason: unknown) => {
              const error = reason instanceof Error ? reason : new Error(String(reason));
              originalReject(error);
              reject(error);
            };
            return;
          }
        }
      }

      const task: QueueTask<T> = {
        id: options.id || `${options.type}_${Date.now()}_${generateUUID()}`,
        type: options.type,
        fn: syncFn,
        resolve,
        reject,
        createdAt: Date.now(),
        timeout: options.timeout || this.DEFAULT_TASK_TIMEOUT
      };

      this.insertByPriority(task as QueueTask<unknown>);
      
      this.processSyncQueue();
    });
  }

  constructor() {
    console.log('[SupabaseService] 构造函数开始执行');
    this.loadConfigFromStorage();
    this.startQueueCleanup();
    this.setupAuthSync();
    
    console.log('[SupabaseService] 配置加载结果:', {
      hasUrl: !!this._url,
      hasKey: !!this._key,
      hasUserName: !!this._userName,
      urlLength: this._url?.length || 0,
      keyLength: this._key?.length || 0
    });
    
    if (this._url && this._key) {
      this.initializeClient();
    } else {
      console.warn('[SupabaseService] 配置缺失，isReady 将为 false');
    }
    console.log('[SupabaseService] 构造函数执行完成, isReady:', this.isReady);
  }

  private setupAuthSync(): void {
    if (typeof window === 'undefined') return;
    
    try {
      this.authChannel = new BroadcastChannel(this.AUTH_CHANNEL_NAME);
      this.authChannel.onmessage = (event) => {
        const { type } = event.data;
        
        if (type === 'AUTH_LOGOUT') {
          this.handleRemoteLogout();
        }
      };
    } catch (err) {
      console.warn('BroadcastChannel 不支持，使用 storage 事件降级');
      window.addEventListener('storage', this.handleStorageEvent);
    }
  }

  private handleStorageEvent = (e: StorageEvent): void => {
    if (e.key === this.AUTH_LOGOUT_SIGNAL_KEY) {
      this.handleRemoteLogout();
    }
  };

  private handleRemoteLogout(): void {
    this._client = null;
    this._url = '';
    this._key = '';
    this._userName = '';
    this.isConfigured = false;
    
    window.dispatchEvent(new CustomEvent('d3s:auth_expired'));
  }

  private broadcastLogout(): void {
    if (this.authChannel) {
      try {
        this.authChannel.postMessage({ type: 'AUTH_LOGOUT' });
      } catch (err) {
        console.warn('广播登出消息失败:', err);
      }
    }
    
    try {
      localStorage.setItem(this.AUTH_LOGOUT_SIGNAL_KEY, Date.now().toString());
      localStorage.removeItem(this.AUTH_LOGOUT_SIGNAL_KEY);
    } catch {
      // 忽略存储错误
    }
  }

  destroyAuthSync(): void {
    if (this.authChannel) {
      this.authChannel.close();
      this.authChannel = null;
    }
    window.removeEventListener('storage', this.handleStorageEvent);
  }

  // 配置Supabase连接
  async configure(url: string, key: string, userName: string): Promise<SyncResult> {
    if (!url || !key) {
      return { 
        success: false, 
        message: '❌ 请填写完整的Supabase配置（URL和API Key）',
        errorType: 'missing_config' 
      };
    }
    
    try {
      this._url = url;
      this._key = key;
      this._userName = this.cleanUserName(userName);
      
      const saveResult = this.saveConfigToStorage();
      if (!saveResult) {
        return { 
          success: false, 
          message: '❌ 配置保存失败，请检查浏览器存储空间或隐私设置',
          errorType: 'save_failed' 
        };
      }
      
      this.initializeClient();
      
      if (this._client) {
        return { 
          success: true, 
          message: `✅ Supabase配置成功！已连接用户：${this._userName}` 
        };
      } else {
        return { 
          success: false, 
          message: '❌ Supabase客户端初始化失败',
          errorType: 'client_init_failed' 
        };
      }
    } catch (error) {
      console.error('[SupabaseService] 配置失败:', error);
      return { 
        success: false, 
        message: '❌ Supabase配置失败，请检查URL和API Key是否正确',
        errorType: 'configuration_error' 
      };
    }
  }

  async setUserName(userName: string): Promise<SyncResult> {
    if (!this._client) {
      return { 
        success: false, 
        message: '❌ 云端服务未配置，请先配置Supabase连接',
        errorType: 'missing_config' 
      };
    }
    const cleanName = this.cleanUserName(userName);
    this._userName = cleanName;
    const saveResult = this.saveConfigToStorage();
    if (!saveResult) {
      console.error('[SupabaseService] setUserName: 配置保存失败');
    }
    this.emitStatusChange();
    return { success: true, message: `✅ 已连接用户：${cleanName}` };
  }

  /**
   * @deprecated Use setUserName instead. URL and Key are now read from env.
   */
  async init(url: string, key: string, userName: string): Promise<SyncResult> {
    if (url && key && (!this._url || !this._key)) {
      this._url = url;
      this._key = key;
      this.saveConfigToStorage();
      this.initializeClient();
    }
    return this.setUserName(userName);
  }

  // 从本地存储加载配置
  private loadConfigFromStorage(): void {
    console.log('[SupabaseService] loadConfigFromStorage 开始, STORAGE_KEY:', this.STORAGE_KEY);
    try {
      const rawData = localStorage.getItem(this.STORAGE_KEY);
      console.log('[SupabaseService] 从存储读取的原始数据:', rawData ? '存在' : '不存在');
      if (rawData) {
        const config = JSON.parse(rawData) as StoredConfig;
        console.log('[SupabaseService] 解析后的配置:', {
          hasUrl: !!config?.url,
          hasKey: !!config?.key,
          userName: config?.userName
        });
        if (config) {
          this._url = config.url || '';
          this._key = config.key || '';
          this._userName = config.userName || '';
          console.log('[SupabaseService] 配置加载成功');
        }
      } else {
        console.log('[SupabaseService] 存储中无配置数据');
      }
    } catch (error) {
      console.error('[SupabaseService] 加载配置异常:', error);
    }
  }

  private saveConfigToStorage(): boolean {
    try {
      const data = JSON.stringify({
        url: this._url,
        key: this._key,
        userName: this._userName
      });
      localStorage.setItem(this.STORAGE_KEY, data);
      console.log('[SupabaseService] 配置保存成功');
      return true;
    } catch (error) {
      console.error('[SupabaseService] 保存配置失败:', error);
      return false;
    }
  }

  // 初始化Supabase客户端
  private initializeClient(): void {
    this._client = null;
    this.isConfigured = false;
    try {
      this._client = createClient(this._url, this._key, {
        global: {
          fetch: (url, options) => fetchWithTimeout(url, options || {}, getSupabaseConfig().TIMEOUT)
        }
      });
      this.isConfigured = true;
      console.log('✅ Supabase 客户端初始化成功');
      console.log('   URL:', this._url);
      console.log('   Key:', this._key ? '已设置' : '未设置');
      console.log('   用户:', this._userName || '未设置');
      this.emitStatusChange();
    } catch (e) {
      console.error('❌ Supabase 初始化失败:', e);
      console.error('   URL:', this._url);
      console.error('   KEY:', this._key ? '已设置' : '未设置');
    }
  }

  // 获取当前配置状态
  getConfig(): { url: string; key: string; userName: string; isConfigured: boolean } {
    return {
      url: this._url,
      key: this._key,
      userName: this._userName,
      isConfigured: this.isConfigured
    };
  }

  clearConfig(): void {
    this._client = null;
    this._url = '';
    this._key = '';
    this._userName = '';
    this.isConfigured = false;

    localStorage.removeItem(this.STORAGE_KEY);
    console.log('[SupabaseService] 配置已清除');
    
    this.broadcastLogout();

    this.emitStatusChange();
  }

  /**
   * 上传性能指标到 Supabase
   */
  async uploadPerformanceMetrics(metrics: Record<string, number>): Promise<boolean> {
    if (!this._client || !this.isReady) {
      return false;
    }

    try {
      const safeMetrics: Record<string, number> = {};
      for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          safeMetrics[key] = value;
        }
      }

      const cleanUserName = this._userName;
      const performanceData = {
        user_name: cleanUserName,
        timestamp: new Date().toISOString(),
        first_paint: safeMetrics.firstPaint || 0,
        first_contentful_paint: safeMetrics.firstContentfulPaint || 0,
        total_blocking_time: safeMetrics.totalBlockingTime || 0,
        max_potential_fid: safeMetrics.maxPotentialFID || 0,
        custom_metrics: JSON.stringify(safeMetrics)
      };
      
      const { error } = await this._client
        .from('performance_metrics')
        .insert([performanceData]);
      
      if (error) {
        console.error('性能数据上传失败:', error.message);
        return false;
      }
      
      return true;
    } catch (err: unknown) {
      console.error('性能数据上传异常:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  get isReady() {
    return this.isConfigured && this._client !== null && !!this._userName;
  }

  async testConnection(url: string, key: string): Promise<{ success: boolean; error?: string }> {
    try {
      const testClient = createClient(url, key, {
        global: {
          fetch: (url, options) => fetchWithTimeout(url, options || {}, 10000)
        }
      });
      
      const { error } = await testClient
        .from('sentences')
        .select('id')
        .limit(1);
      
      if (error) {
        return { success: false, error: error.message };
      }
      
      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : '连接失败' 
      };
    }
  }

  private async fetchCloudSentences(incremental: boolean = false): Promise<Map<string, CloudSentenceData>> {
    if (!this._client) {
      console.warn('⚠️ Supabase 客户端未初始化，跳过云端数据获取');
      return new Map();
    }
    
    const cleanUserName = this._userName;
    let query = this._client
      .from('sentences')
      .select('*')
      .eq('username', cleanUserName);

    if (incremental && this.lastSyncTime > 0) {
      query = query.gte('updatedat', this.lastSyncTime);
    }

    const { data: cloudData, error } = await query.order('updatedat', { ascending: true });

    if (error) {
      if (error.message.includes('Failed to fetch') || error.message.includes('fetch')) {
        console.warn("⚠️ 网络请求失败，使用本地数据:", error.message);
      } else {
        console.error("❌ Fetch cloud sentences error:", error.message);
      }
      return new Map();
    }

    const cloudEnglishMap = new Map<string, CloudSentenceData>();
    (cloudData || []).forEach((s: CloudSentenceData) => {
      const normalizedEnglish = s.english.trim().toLowerCase();
      const existing = cloudEnglishMap.get(normalizedEnglish);
      if (!existing || (s.updatedat && (!existing.updatedat || new Date(s.updatedat) > new Date(existing.updatedat)))) {
        cloudEnglishMap.set(normalizedEnglish, s);
      }
    });

    return cloudEnglishMap;
  }

  async syncSentences(localSentences: Sentence[]): Promise<{ sentences: Sentence[], message: string }> {
    if (!this._client || !this.isReady) {
      return { sentences: localSentences, message: '☁️ 云同步未配置，使用本地数据' };
    }

    return this.enqueueSync(async () => {
      if (!this._client) {
        console.warn('⚠️ Supabase 客户端未初始化，跳过同步');
        return { sentences: localSentences, message: '☁️ 云同步未配置，使用本地数据' };
      }
      
      try {
        const validLocalSentences = localSentences.filter(s =>
          s.id && s.english && s.chinese && s.updatedAt
        ).map(s => {
          if (!this.isValidUUID(s.id)) {
            return { ...s, id: this.generateValidUUID() };
          }
          return s;
        });

        const useIncremental = Date.now() - this.lastCloudFetchTime < this.CACHE_VALID_DURATION && this.lastSyncTime > 0;
        const cloudEnglishMap = await this.fetchCloudSentences(useIncremental);

        if (!useIncremental) {
          this.cloudSentencesCache = cloudEnglishMap;
          this.lastCloudFetchTime = Date.now();
        } else {
          cloudEnglishMap.forEach((s, key) => {
            this.cloudSentencesCache.set(key, s);
          });
        }

        const localEnglishMap = new Map<string, Sentence>();
        validLocalSentences.forEach(s => {
          const normalizedEnglish = s.english.trim().toLowerCase();
          const existing = localEnglishMap.get(normalizedEnglish);
          if (!existing || (!s.updatedAt || !existing.updatedAt || new Date(s.updatedAt) > new Date(existing.updatedAt))) {
            localEnglishMap.set(normalizedEnglish, s);
          }
        });

        const merged: Sentence[] = [];
        const toUpload: CloudSentenceData[] = [];

        localEnglishMap.forEach((localSentence, normalizedEnglish) => {
          const cloudSentence = this.cloudSentencesCache.get(normalizedEnglish);

          if (!cloudSentence) {
            merged.push(localSentence);
            const uploadData = this.mapSentenceToDb(localSentence, this._userName);
            if (!this.isValidUUID(localSentence.id)) {
              uploadData.id = this.generateValidUUID();
            }
            toUpload.push(uploadData);
            return;
          }

          const localTime = localSentence.updatedAt ? new Date(localSentence.updatedAt).getTime() : 0;
          const cloudTime = cloudSentence.updatedat ? new Date(cloudSentence.updatedat).getTime() : 0;

          if (cloudTime > localTime) {
            merged.push(this.mapDbToSentence(cloudSentence));
            return;
          }

          merged.push(localSentence);
          if (localTime > cloudTime) {
            const uploadData = this.mapSentenceToDb(localSentence, this._userName);
            uploadData.id = cloudSentence.id;
            toUpload.push(uploadData);
          }
        });

        this.cloudSentencesCache.forEach((cloudSentence) => {
          if (!localEnglishMap.has(cloudSentence.english.trim().toLowerCase())) {
            merged.push(this.mapDbToSentence(cloudSentence));
          }
        });

        let syncSuccess = false;
        if (toUpload.length > 0) {
          const { error: upsertError } = await this._client
            .from('sentences')
            .upsert(toUpload, { onConflict: 'id' });

          if (upsertError) {
            console.error(`❌ 批量同步失败: ${upsertError.message}`);
          } else {
            console.log(`✅ 成功批量同步 ${toUpload.length} 条数据`);
            syncSuccess = true;
          }
        }

        this.lastSyncTime = Date.now();
        return {
          sentences: merged,
          message: syncSuccess ? `成功同步${toUpload.length}条数据` : '数据已最新'
        };
      } catch (err: unknown) {
        console.error("❌ Sync sentences failed:", err);
        return { sentences: localSentences, message: `同步异常：${err instanceof Error ? err.message : String(err)}` };
      }
    }, {
      type: 'sentence',
      id: 'batch_sync',
      timeout: 60000, // 批量同步给更长时间
      deduplicate: true,
      entityId: 'sentences'
    });
  }

  async syncSentencesWithFreshData(
    getLocalSentences: () => Promise<Sentence[]>
  ): Promise<{ sentences: Sentence[], message: string, needsLocalUpdate: boolean, deletedLocalIds: string[] }> {
    if (!this._client || !this.isReady) {
      const localSentences = await getLocalSentences();
      return { sentences: localSentences, message: '☁️ 云同步未配置，使用本地数据', needsLocalUpdate: false, deletedLocalIds: [] };
    }

    return this.enqueueSync(async () => {
      if (!this._client) {
        console.warn('⚠️ Supabase 客户端未初始化，跳过同步');
        const localSentences = await getLocalSentences();
        return { sentences: localSentences, message: '☁️ 云同步未配置，使用本地数据', needsLocalUpdate: false, deletedLocalIds: [] };
      }
      
      try {
        const cloudEnglishMap = await this.fetchCloudSentences(false);
        this.cloudSentencesCache = cloudEnglishMap;
        this.lastCloudFetchTime = Date.now();

        const freshLocalSentences = await getLocalSentences();
        
        const validLocalSentences = freshLocalSentences.filter(s =>
          s.id && s.english && s.chinese && s.updatedAt
        ).map(s => {
          if (!this.isValidUUID(s.id)) {
            return { ...s, id: this.generateValidUUID() };
          }
          return s;
        });

        const localEnglishMap = new Map<string, Sentence>();
        validLocalSentences.forEach(s => {
          const normalizedEnglish = s.english.trim().toLowerCase();
          const existing = localEnglishMap.get(normalizedEnglish);
          if (!existing || (!s.updatedAt || !existing.updatedAt || new Date(s.updatedAt) > new Date(existing.updatedAt))) {
            localEnglishMap.set(normalizedEnglish, s);
          }
        });

        const merged: Sentence[] = [];
        const toUpload: CloudSentenceData[] = [];
        let needsLocalUpdate = false;

        const deletedLocalIds: string[] = [];

        localEnglishMap.forEach((localSentence, normalizedEnglish) => {
          const cloudSentence = cloudEnglishMap.get(normalizedEnglish);

          if (!cloudSentence) {
            const isNewLocal = localSentence.updatedAt && (Date.now() - localSentence.updatedAt < 24 * 60 * 60 * 1000);

            if (isNewLocal && deviceService.canUploadSync()) {
              const uploadData = this.mapSentenceToDb(localSentence, this._userName);
              if (!this.isValidUUID(localSentence.id)) {
                uploadData.id = this.generateValidUUID();
              }
              toUpload.push(uploadData);
              merged.push(localSentence);
            } else if (isNewLocal) {
              merged.push(localSentence);
            } else {
              deletedLocalIds.push(localSentence.id);
              needsLocalUpdate = true;
            }
            return;
          }

          const localTime = localSentence.updatedAt ? new Date(localSentence.updatedAt).getTime() : 0;
          const cloudTime = cloudSentence.updatedat ? new Date(cloudSentence.updatedat).getTime() : 0;

          if (cloudTime > localTime) {
            merged.push(this.mapDbToSentence(cloudSentence));
            needsLocalUpdate = true;
            return;
          }

          merged.push(localSentence);
          if (localTime > cloudTime && deviceService.canUploadSync()) {
            const uploadData = this.mapSentenceToDb(localSentence, this._userName);
            uploadData.id = cloudSentence.id;
            toUpload.push(uploadData);
          }
        });

        cloudEnglishMap.forEach((cloudSentence) => {
          if (!localEnglishMap.has(cloudSentence.english.trim().toLowerCase())) {
            merged.push(this.mapDbToSentence(cloudSentence));
            needsLocalUpdate = true;
          }
        });

        let syncSuccess = false;
        if (toUpload.length > 0) {
          const { error: upsertError } = await this._client
            .from('sentences')
            .upsert(toUpload, { onConflict: 'id' });

          if (upsertError) {
            console.error(`❌ 批量同步失败: ${upsertError.message}`);
          } else {
            console.log(`✅ 成功批量同步 ${toUpload.length} 条数据`);
            syncSuccess = true;
          }
        }

        this.lastSyncTime = Date.now();
        return {
          sentences: merged,
          message: syncSuccess ? `成功同步${toUpload.length}条数据` : '数据已最新',
          needsLocalUpdate,
          deletedLocalIds
        };
      } catch (err: unknown) {
        console.error("❌ Sync sentences failed:", err);
        const localSentences = await getLocalSentences();
        return { sentences: localSentences, message: `同步异常：${err instanceof Error ? err.message : String(err)}`, needsLocalUpdate: false, deletedLocalIds: [] };
      }
    }, {
      type: 'sentence',
      id: 'fresh_sync',
      timeout: 60000,
      deduplicate: true,
      entityId: 'sentences_fresh'
    });
  }

  private mapSentenceToDb(s: Sentence, username: string): CloudSentenceData {
    return { 
      id: s.id,
      english: s.english,
      chinese: s.chinese,
      addedat: s.addedAt || 0,
      intervalindex: s.intervalIndex || 0,
      nextreviewdate: s.nextReviewDate || null,
      lastreviewedat: s.lastReviewedAt || null,
      timesreviewed: s.timesReviewed || 0,
      ismanual: s.isManual || false,
      updatedat: s.updatedAt || 0,
      username: username,
      tags: Array.isArray(s.tags) ? s.tags.join(';') : (s.tags || ''),
      stability: s.stability || 0,
      difficulty: s.difficulty || 0,
      reps: s.reps || 0,
      lapses: s.lapses || 0,
      state: s.state || 0,
      scheduleddays: s.scheduledDays || 0,
      masterylevel: s.masteryLevel || 0,
      wrongdictations: s.wrongDictations || 0,
      firstreviewpending: s.isPendingFirstReview || false,
      learnedat: s.learnedAt || null
    };
  }

  private mapDbToSentence(db: CloudSentenceData): Sentence {
    return {
      id: db.id,
      english: db.english,
      chinese: db.chinese,
      addedAt: db.addedat,
      intervalIndex: db.intervalindex,
      nextReviewDate: db.nextreviewdate,
      lastReviewedAt: db.lastreviewedat,
      timesReviewed: db.timesreviewed,
      masteryLevel: db.masterylevel,
      wrongDictations: db.wrongdictations,
      tags: db.tags ? db.tags.split(';').filter(Boolean) : [],
      updatedAt: db.updatedat,
      isManual: db.ismanual,
      stability: db.stability,
      difficulty: db.difficulty,
      reps: db.reps,
      lapses: db.lapses,
      state: db.state,
      scheduledDays: db.scheduleddays,
      isPendingFirstReview: db.firstreviewpending,
      learnedAt: db.learnedat || undefined
    };
  }

  async pushStats(stats: UserStats): Promise<SyncResult> {
    if (!this._client || !this.isReady) {
      return { success: false, message: '☁️ 云同步未配置，跳过统计推送' };
    }

    return this.enqueueSync(async () => {
      if (!this._client) {
        console.warn('⚠️ Supabase 客户端未初始化，跳过统计推送');
        return { success: false, message: '☁️ 云同步未配置，跳过统计推送' };
      }
      
      try {
        const cleanUserName = this._userName;
        const dbStats = {
          user_name: cleanUserName,
          total_sentences: stats.totalSentences || 0,
          completed_count: stats.dictationCount || 0,
          favorite_count: 0,
          last_sync: new Date().toISOString(),
          streak: stats.streak || 0,
          total_points: stats.totalPoints || 0,
          max_streak: stats.maxStreak || 0,
          break_times: stats.breakTimes || 0,
          streak_qualified: stats.streakQualified || 0,
          total_days_learned: stats.totalDaysLearned || 0,
          total_dictation: stats.totalDictation || 0,
          week_dictation_count: stats.weekDictationCount || 0,
          max_daily_dictation: stats.maxDailyDictation || 0,
          mobile_learn_count: stats.mobileLearnCount || 0,
          mobile_review_count: stats.mobileReviewCount || 0,
          mobile_dictation_count: stats.mobileDictationCount || 0,
          batch_sync_count: stats.batchSyncCount || 0,
          avg_stability: stats.avgStability || 0,
          total_lapses: stats.totalLapses || 0
        };
        const { error } = await this._client
          .from('user_stats')
          .upsert(dbStats, { onConflict: 'user_name' });
        if (error) {
          console.error("❌ Supabase Stats Push Error:", error.message);
          return { success: false, message: `云端同步失败: ${error.message}` };
        }
        console.log("✅ 统计数据同步成功");
        return { success: true, message: '统计数据推送成功' };
      } catch (err: unknown) {
        console.error("❌ Push stats exception:", err);
        return { success: false, message: `同步异常：${err instanceof Error ? err.message : String(err)}` };
      }
    }, {
      type: 'stats',
      id: 'push_stats',
      deduplicate: true,
      entityId: 'user_stats'
    });
  }

  async syncStats(stats: UserStats): Promise<boolean> {
    const result = await this.pushStats(stats);
    return result.success;
  }

  async pullStats(): Promise<{ stats: UserStats | null, message: string }> {
    if (!this._client || !this.isReady) {
      return { stats: null, message: '☁️ 云同步未配置' };
    }
    try {
      const { data, error } = await this._client
        .from('user_stats')
        .select('*')
        .eq('user_name', this._userName)
        .maybeSingle();
      if (error) {
        console.error("❌ Pull stats error:", error.message);
        return { stats: null, message: `获取云端统计失败：${error.message}` };
      }
      if (!data) return { stats: null, message: '云端暂无数据' };
      const mappedStats: UserStats = {
        id: String(data.id),
        totalPoints: data.total_points || 0,
        totalSentences: data.total_sentences || 0,
        dictationCount: data.completed_count || 0,
        streak: data.streak || 0,
        lastLearnDate: data.last_sync || '',
        completionDays: data.completion_days || 0,
        lastCompletionDate: data.last_completion_date || '',
        updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now(),
        maxStreak: data.max_streak || 0,
        breakTimes: data.break_times || 0,
        streakQualified: data.streak_qualified || 0,
        totalDaysLearned: data.total_days_learned || 0,
        totalDictation: data.total_dictation || 0,
        weekDictationCount: data.week_dictation_count || 0,
        maxDailyDictation: data.max_daily_dictation || 0,
        mobileLearnCount: data.mobile_learn_count || 0,
        mobileReviewCount: data.mobile_review_count || 0,
        mobileDictationCount: data.mobile_dictation_count || 0,
        batchSyncCount: data.batch_sync_count || 0,
        avgStability: data.avg_stability || 0,
        totalLapses: data.total_lapses || 0
      };
      return { stats: mappedStats, message: '统计数据同步成功' };
    } catch (err: unknown) {
      console.error("❌ Pull stats failed:", err);
      return { stats: null, message: `拉取异常：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ======================================
  // 新增：适配离线队列的同步方法（核心）
  // ======================================
  async updateSentence(sentence: Sentence): Promise<boolean> {
    if (!this._client || !this.isReady) {
      console.warn('❌ Supabase未初始化，更新句子失败');
      return false;
    }
    try {
      const cleanUserName = this._userName;
      const dbSentence = this.mapSentenceToDb(sentence, cleanUserName);
      const { error } = await this._client
        .from('sentences')
        .update(dbSentence)
        .eq('id', sentence.id)
        .eq('username', cleanUserName);
      if (error) {
        console.error('❌ 同步更新句子失败:', error.message);
        return false;
      }
      console.log(`✅ 句子${sentence.id}更新同步成功`);
      return true;
    } catch (err: unknown) {
      console.error('❌ 更新句子异常:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  async addSentence(sentence: Sentence): Promise<boolean> {
    if (!this._client || !this.isReady) {
      console.warn('❌ Supabase未初始化，添加句子失败');
      return false;
    }
    try {
      const validSentence = this.isValidUUID(sentence.id) 
        ? sentence 
        : { ...sentence, id: this.generateValidUUID() };
      
      const cleanUserName = this._userName;
      const dbSentence = this.mapSentenceToDb(validSentence, cleanUserName);
      const { error } = await this._client
        .from('sentences')
        .insert([dbSentence]);
      if (error) {
        console.error('❌ 同步添加句子失败:', error.message);
        return false;
      }
      console.log(`✅ 句子${validSentence.id}添加同步成功`);
      return true;
    } catch (err: unknown) {
      console.error('❌ 添加句子异常:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  async syncDictationRecord(record: DictationRecord): Promise<boolean> {
    if (!this._client || !this.isReady) {
      console.warn('❌ Supabase未初始化，同步默写记录失败');
      return false;
    }
    
    return this.enqueueSync(async () => {
      if (!this._client) {
        console.warn('⚠️ Supabase 客户端未初始化，跳过默写记录同步');
        return false;
      }
      
      try {
        const cleanUserName = this._userName;
        const dbRecord = {
          id: this.generateValidUUID(),
          sentence_id: record.sentenceId,
          status: record.status,
          timestamp: record.timestamp,
          is_finished: record.isFinished || false,
          username: cleanUserName
        };
        const { error } = await this._client
          .from('dictation_records')
          .insert([dbRecord]);
        if (error) {
          if (error.code === '23505') {
            console.log('默写记录已存在，跳过重复同步');
            return true;
          }
          console.error('❌ 同步默写记录失败:', error.message);
          return false;
        }
        console.log(`✅ 默写记录${dbRecord.id}同步成功`);
        return true;
      } catch (err: unknown) {
        console.error('❌ 同步默写记录异常:', err instanceof Error ? err.message : err);
        return false;
      }
    }, {
      type: 'dictation',
      id: `dictation_${record.sentenceId}`,
      deduplicate: true,
      entityId: record.sentenceId
    });
  }

  async pushDailySelection(date: string, sentenceIds: string[]): Promise<SyncResult> {
    if (!this._client || !this.isReady) {
      return { success: false, message: '☁️ 云同步未配置，跳过当日列表推送' };
    }
    
    return this.enqueueSync(async () => {
      if (!this._client) {
        console.warn('⚠️ Supabase 客户端未初始化，跳过当日列表推送');
        return { success: false, message: '☁️ 云同步未配置，跳过当日列表推送' };
      }
      
      const cleanUserName = this._userName;
      const dbData = {
        user_name: cleanUserName,
        date: date,
        sentence_ids: sentenceIds,
        updated_at: new Date().toISOString()
      };
      const { error } = await this._client
        .from('daily_selections')
        .upsert(dbData, { onConflict: 'user_name,date' });
      if (error) {
        console.error('❌ 推送当日学习列表失败:', error.message);
        return { success: false, message: `推送失败：${error.message}` };
      }
      console.log(`✅ 当日学习列表[${date}]推送云端成功`);
      return { success: true, message: '当日学习列表同步成功' };
    }, { type: 'dailySelection', id: `push_daily_${date}` });
  }

  async pullDailySelection(date: string): Promise<{ ids: string[] | null, message: string }> {
    if (!this._client || !this.isReady) {
      return { ids: null, message: '☁️ 云同步未配置，跳过当日列表拉取' };
    }
    
    return this.enqueueSync(async () => {
      if (!this._client) {
        console.warn('⚠️ Supabase 客户端未初始化，跳过当日列表拉取');
        return { ids: null, message: '☁️ 云同步未配置，跳过当日列表拉取' };
      }
      
      const cleanUserName = this._userName;
      const { data, error } = await this._client
        .from('daily_selections')
        .select('sentence_ids')
        .eq('user_name', cleanUserName)
        .eq('date', date)
        .maybeSingle();
      if (error) {
        console.error("❌ 拉取当日学习列表失败:", error.message);
        return { ids: null, message: `拉取失败：${error.message}` };
      }
      if (!data || !data.sentence_ids) {
        return { ids: null, message: '云端暂无当日学习列表' };
      }
      console.log(`✅ 当日学习列表[${date}]从云端拉取成功`);
      return { ids: data.sentence_ids, message: '拉取成功' };
    }, { type: 'dailySelection', id: `pull_daily_${date}` });
  }

  /**
   * 从云端删除句子（通过 ID 或英文内容匹配）
   */
  async deleteSentence(id: string, english?: string): Promise<boolean> {
    if (!this._client || !this.isReady) {
      console.warn('❌ Supabase未初始化，删除句子失败');
      return false;
    }
    
    try {
      const cleanUserName = this._userName;
      
      // 优先通过 ID 删除
      const { error: deleteError } = await this._client
        .from('sentences')
        .delete()
        .eq('id', id)
        .eq('username', cleanUserName);
      
      if (deleteError) {
        console.error('❌ 云端删除句子失败:', deleteError.message);
        return false;
      }
      
      // 同时删除相关的默写记录
      const { error: dictationError } = await this._client
        .from('dictation_records')
        .delete()
        .eq('sentence_id', id)
        .eq('username', cleanUserName);
      
      if (dictationError) {
        console.warn('删除云端默写记录失败:', dictationError.message);
      }
      
      // 清除缓存中的对应条目
      if (english) {
        const normalizedEnglish = english.trim().toLowerCase();
        this.cloudSentencesCache.delete(normalizedEnglish);
      }
      
      console.log(`✅ 句子 ${id} 已从云端删除`);
      return true;
    } catch (err: unknown) {
      console.error('❌ 删除句子异常:', err instanceof Error ? err.message : err);
      return false;
    }
  }
}

export const supabaseService = new SupabaseService();
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const initializeSupabase = async (userName?: string) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { success: false, message: "环境变量缺失" };
  }
  let name = userName;
  if (!name) {
    try {
      const settingsData = localStorage.getItem('d3s_settings_v3');
      if (settingsData) {
        const settings = JSON.parse(settingsData);
        name = settings?.userName || '';
      }
    } catch {
      // ignore
    }
  }
  if (!name) {
    return { success: false, message: "用户名未设置" };
  }
  return await supabaseService.init(SUPABASE_URL, SUPABASE_ANON_KEY, name);
};