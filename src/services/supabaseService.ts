import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Sentence, UserStats, UserSettings } from '../types';
import { generateUUID, isValidUUID } from '../utils/uuid';
import { SUPABASE_CONFIG } from '../constants';

// 统一的同步结果类型
export interface SyncResult {
  success: boolean;
  message: string;
  errorType?: string;
}

// 带超时的 fetch 包装器
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number = SUPABASE_CONFIG.TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
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
  private isInitializing: boolean = false;
  private syncQueue: Promise<any>[] = [];
  private isSyncing: boolean = false;
  private readonly MAX_CONCURRENT_SYNC = 3;

  get client(): SupabaseClient | null {
    return this._client;
  }

  get userName(): string {
    return this._userName;
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

  private async processSyncQueue() {
    if (this.isSyncing || this.syncQueue.length === 0) {
      return;
    }
    
    this.isSyncing = true;
    
    while (this.syncQueue.length > 0) {
      const batch = this.syncQueue.splice(0, this.MAX_CONCURRENT_SYNC);
      await Promise.all(batch);
    }
    
    this.isSyncing = false;
  }

  private enqueueSync<T>(syncFn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const wrappedFn = async () => {
        try {
          const result = await syncFn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      
      this.syncQueue.push(wrappedFn());
      this.processSyncQueue();
    });
  }

  constructor() {
    if (SUPABASE_CONFIG.URL && SUPABASE_CONFIG.KEY) {
      try {
        this._client = createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.KEY);
        this.isConfigured = true;
      } catch (e) {
        console.error('Supabase initialization failed:', e);
      }
    }
  }

  async setUserName(userName: string): Promise<SyncResult> {
    if (!this._client) {
      return { success: false, message: '云端服务未配置（请检查 .env）', errorType: 'missing_config' };
    }
    const cleanName = this.cleanUserName(userName);
    this._userName = cleanName;
    return { success: true, message: `✅ 已连接用户：${cleanName}` };
  }

  /**
   * @deprecated Use setUserName instead. URL and Key are now read from env.
   */
  async init(url: string, key: string, userName: string): Promise<SyncResult> {
    return this.setUserName(userName);
  }

  clearConfig(): void {
    // Client is persistent, just clear user session
    this._userName = '';
  }

  /**
   * 上传性能指标到 Supabase
   */
  async uploadPerformanceMetrics(metrics: Record<string, number>): Promise<boolean> {
    if (!this._client || !this.isReady) {
      return false;
    }
    
    try {
      const cleanUserName = this._userName;
      const performanceData = {
        user_name: cleanUserName,
        timestamp: new Date().toISOString(),
        first_paint: metrics.firstPaint || 0,
        first_contentful_paint: metrics.firstContentfulPaint || 0,
        total_blocking_time: metrics.totalBlockingTime || 0,
        max_potential_fid: metrics.maxPotentialFID || 0,
        custom_metrics: JSON.stringify(metrics)
      };
      
      const { error } = await this._client
        .from('performance_metrics')
        .insert([performanceData]);
      
      if (error) {
        console.error('性能数据上传失败:', error.message);
        return false;
      }
      
      return true;
    } catch (err: any) {
      console.error('性能数据上传异常:', err);
      return false;
    }
  }

  get isReady() {
    return this.isConfigured && this._client !== null && !!this._userName;
  }

  async syncSentences(localSentences: Sentence[]): Promise<{ sentences: Sentence[], message: string }> {
    if (!this._client || !this.isReady) {
      return { sentences: localSentences, message: '未配置云同步，使用本地数据' };
    }
    
    return this.enqueueSync(async () => {
      try {
        const validLocalSentences = localSentences.filter(s => 
          s.id && s.english && s.chinese && s.updatedAt 
        ).map(s => {
          if (!this.isValidUUID(s.id)) {
            return { ...s, id: this.generateValidUUID() };
          }
          return s;
        });
        const cleanUserName = this._userName;

        const { data: cloudData, error } = await this._client
          .from('sentences')
          .select('*')
          .eq('username', cleanUserName);
        
        if (error) {
          console.error("❌ Fetch cloud sentences error:", error.message);
          return { sentences: validLocalSentences, message: `同步失败：${error.message}` };
        }
        
        // ✅ 创建英文到云端句子的映射，用于检测重复
        const cloudEnglishMap = new Map<string, any>();
        (cloudData || []).forEach((s: any) => {
          const normalizedEnglish = s.english.trim().toLowerCase();
          // ✅ 如果已存在，只保留更新时间较新的版本
          const existing = cloudEnglishMap.get(normalizedEnglish);
          if (!existing || (s.updatedat && (!existing.updatedat || new Date(s.updatedat) > new Date(existing.updatedat)))) {
            cloudEnglishMap.set(normalizedEnglish, {
              ...s,
              id: String(s.id),
              intervalIndex: s.intervalindex,
              addedAt: s.addedat,
              nextReviewDate: s.nextreviewdate,
              lastReviewedAt: s.lastreviewedat,
              timesReviewed: s.timesreviewed,
              isManual: s.ismanual,
              updatedAt: s.updatedat,
              stability: s.stability,
              difficulty: s.difficulty,
              reps: s.reps,
              lapses: s.lapses,
              state: s.state,
              scheduledDays: s.scheduleddays
            });
          }
        });
        
        // ✅ 创建本地英文到句子的映射（用于检测本地重复）
        const localEnglishMap = new Map<string, Sentence>();
        validLocalSentences.forEach(s => {
          const normalizedEnglish = s.english.trim().toLowerCase();
          const existing = localEnglishMap.get(normalizedEnglish);
          // ✅ 如果已存在，只保留更新时间较新的版本
          if (!existing || (!s.updatedAt || !existing.updatedAt || new Date(s.updatedAt) > new Date(existing.updatedAt))) {
            localEnglishMap.set(normalizedEnglish, s);
          }
        });
        
        // ✅ 合并逻辑：优先使用云端数据，本地重复的英文句子合并到云端
        const merged: Sentence[] = [];
        const toUpload: any[] = [];
        
        // 处理本地句子
        localEnglishMap.forEach((localSentence, normalizedEnglish) => {
          const cloudSentence = cloudEnglishMap.get(normalizedEnglish);
          
          if (cloudSentence) {
            // ✅ 云端已存在相同英文的句子，比较更新时间
            const localTime = localSentence.updatedAt ? new Date(localSentence.updatedAt).getTime() : 0;
            const cloudTime = cloudSentence.updatedAt ? new Date(cloudSentence.updatedAt).getTime() : 0;
            
            if (localTime > cloudTime) {
              // ✅ 本地更新了，上传本地版本（使用云端ID）
              merged.push(localSentence);
              const uploadData = this.mapSentenceToDb(localSentence, cleanUserName);
              uploadData.id = cloudSentence.id; // 使用云端ID
              toUpload.push(uploadData);
            } else {
              // ✅ 云端更新了，使用云端版本
              merged.push(cloudSentence);
            }
          } else {
            // ✅ 云端不存在，直接上传
            merged.push(localSentence);
            const uploadData = this.mapSentenceToDb(localSentence, cleanUserName);
            // ✅ 修复：检查ID是否与云端冲突，避免ID重复
            if (!this.isValidUUID(localSentence.id)) {
              uploadData.id = this.generateValidUUID();
            } else {
              // ✅ 检查云端是否存在相同ID，避免冲突
              const existingCloudSentence = cloudEnglishMap.get(normalizedEnglish);
              if (existingCloudSentence && existingCloudSentence.id !== localSentence.id) {
                uploadData.id = this.generateValidUUID();
              }
            }
            toUpload.push(uploadData);
          }
        });
        
        // 添加云端独有的句子
        cloudEnglishMap.forEach((cloudSentence) => {
          if (!localEnglishMap.has(cloudSentence.english.trim().toLowerCase())) {
            merged.push(cloudSentence);
          }
        });
        
        // ✅ 全链路 upsert：使用 id 作为冲突键（主键）
        if (toUpload.length > 0) {
          const { error: uploadError } = await this._client
            .from('sentences')
            .upsert(toUpload, { onConflict: 'id' });
          
          if (uploadError) {
            console.error("❌ Upload sentences error:", uploadError.message);
            return { sentences: merged, message: `部分同步失败：${uploadError.message}` };
          }
        }
        return { 
          sentences: merged, 
          message: toUpload.length > 0 ? `成功同步${toUpload.length}条数据` : '数据已最新' 
        };
      } catch (err: any) {
        console.error("❌ Sync sentences failed:", err);
        return { sentences: localSentences, message: `同步异常：${err.message}` };
      }
    });
  }

  private mapSentenceToDb(s: Sentence, username: string) {
    return { 
      id: s.id,
      english: s.english,
      chinese: s.chinese,
      tags: s.tags || '',
      intervalindex: s.intervalIndex,
      addedat: s.addedAt,
      nextreviewdate: s.nextReviewDate,
      lastreviewedat: s.lastReviewedAt,
      timesreviewed: s.timesReviewed,
      ismanual: s.isManual,
      updatedat: s.updatedAt,
      username: username,
      stability: s.stability,
      difficulty: s.difficulty,
      reps: s.reps,
      lapses: s.lapses,
      state: s.state,
      scheduleddays: s.scheduledDays
    };
  }

  async pushStats(stats: UserStats): Promise<SyncResult> {
    if (!this._client || !this.isReady) {
      return { success: false, message: '未配置云同步，跳过统计推送' };
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
      console.log("✅ 统计数据真正同步成功");
      return { success: true, message: '统计数据推送成功' };
    } catch (err: any) {
      console.error("❌ Push stats exception:", err);
      return { success: false, message: `同步异常：${err.message}` };
    }
  }

  // ✅ 新增：批量同步统计数据
  async syncStats(stats: UserStats): Promise<boolean> {
    if (!this._client || !this.isReady) {
      console.warn('❌ Supabase未初始化，同步统计数据失败');
      return false;
    }
    
    return this.enqueueSync(async () => {
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
          console.error("❌ Supabase Stats Sync Error:", error.message);
          return false;
        }
        console.log("✅ 统计数据同步成功");
        return true;
      } catch (err: any) {
        console.error("❌ Sync stats exception:", err);
        return false;
      }
    });
  }

  async pullStats(): Promise<{ stats: UserStats | null, message: string }> {
    if (!this._client || !this.isReady) {
      return { stats: null, message: '未配置云同步' };
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
        updatedAt: data.updated_at || Date.now(),
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
    } catch (err: any) {
      console.error("❌ Pull stats failed:", err);
      return { stats: null, message: `拉取异常：${err.message}` };
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
    } catch (err: any) {
      console.error('❌ 更新句子异常:', err.message);
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
    } catch (err: any) {
      console.error('❌ 添加句子异常:', err.message);
      return false;
    }
  }

  async syncDictationRecord(record: any): Promise<boolean> {
    if (!this._client || !this.isReady) {
      console.warn('❌ Supabase未初始化，同步默写记录失败');
      return false;
    }
    
    return this.enqueueSync(async () => {
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
          // ✅ 检查是否为重复记录错误
          if (error.message.includes('duplicate key')) {
            console.log('默写记录已存在，跳过重复同步');
            return true;
          }
          console.error('❌ 同步默写记录失败:', error.message);
          return false;
        }
        console.log(`✅ 默写记录${dbRecord.id}同步成功`);
        return true;
      } catch (err: any) {
        console.error('❌ 同步默写记录异常:', err.message);
        return false;
      }
    });
  }

  async pushDailySelection(date: string, sentenceIds: string[]): Promise<SyncResult> {
    if (!this._client || !this.isReady) {
      return { success: false, message: '未配置云同步，跳过当日列表推送' };
    }
    try {
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
    } catch (err: any) {
      console.error('❌ 推送当日学习列表异常:', err.message);
      return { success: false, message: `推送异常：${err.message}` };
    }
  }

  async pullDailySelection(date: string): Promise<{ ids: string[] | null, message: string }> {
    if (!this._client || !this.isReady) {
      return { ids: null, message: '未配置云同步，跳过当日列表拉取' };
    }
    try {
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
    } catch (err: any) {
      console.error("❌ 拉取当日学习列表异常:", err.message);
      return { ids: null, message: `拉取异常：${err.message}` };
    }
  }
}

export const supabaseService = new SupabaseService();
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const initializeSupabase = async (userName: string = "张树欢") => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { success: false, message: "环境变量缺失" };
  }
  return await supabaseService.init(SUPABASE_URL, SUPABASE_ANON_KEY, userName);
};