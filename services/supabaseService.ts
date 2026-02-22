import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Sentence, UserStats, UserSettings } from '../types'; 

// 统一的同步结果类型
export interface SyncResult {
  success: boolean;
  message: string;
  errorType?: string;
}

// 新增：当日学习列表的云端数据类型
export interface CloudDailySelection {
  user_name: string;
  date: string;
  sentence_ids: string[];
  updated_at: string;
}

class SupabaseService {
  private client: SupabaseClient | null = null;
  private isConfigured: boolean = false;
  private userName: string = '';
  private isInitializing: boolean = false;

  private isValidUUID(id: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
  }

  private generateValidUUID(): string {
    return crypto.randomUUID();
  }

  private cleanUserName(name: string): string {
    return name.replace(/"/g, '');
  }

  async init(url: string, key: string, userName: string): Promise<SyncResult> {
    if (this.isInitializing) {
      return { success: false, message: '正在初始化Supabase，请稍后重试', errorType: 'concurrent_init' };
    }
    this.isInitializing = true;
    const cleanName = this.cleanUserName(userName);
    if (this.client && this.isConfigured && this.userName === cleanName) {
      this.isInitializing = false;
      return { success: true, message: `✅ 已使用现有配置，用户：${cleanName}` };
    }
    if (!url || !key || !userName) {
      this.isConfigured = false;
      this.client = null;
      this.userName = '';
      this.isInitializing = false;
      return { success: false, message: '配置信息不完整', errorType: 'invalid_config' };
    }
    try {
      this.clearConfig();
      this.client = createClient(url, key);
      this.userName = cleanName;
      this.isConfigured = true;
      this.isInitializing = false;
      return { success: true, message: `配置成功！将同步【${this.userName}】的专属数据` };
    } catch (err: any) {
      this.isConfigured = false;
      this.client = null;
      this.userName = '';
      this.isInitializing = false;
      return { success: false, message: `初始化失败：${err.message}`, errorType: 'invalid_config' };
    }
  }

  clearConfig(): void {
    if (this.client) {
      (this.client as any).auth = null;
      (this.client as any).rest = null;
      this.client = null;
    }
    this.isConfigured = false;
    this.userName = '';
    this.isInitializing = false;
  }

  get isReady() {
    return this.isConfigured && this.client !== null && !!this.userName;
  }

  async syncSentences(localSentences: Sentence[]): Promise<{ sentences: Sentence[], message: string }> {
    if (!this.client || !this.isReady) {
      return { sentences: localSentences, message: '未配置云同步，使用本地数据' };
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
      const cleanUserName = this.userName;
      const { data: cloudData, error } = await this.client
        .from('sentences')
        .select('*')
        .eq('username', cleanUserName); 
      if (error) {
        console.error("❌ Fetch cloud sentences error:", error.message);
        return { sentences: validLocalSentences, message: `同步失败：${error.message}` };
      }
      const cloudMap = new Map<string, Sentence>((cloudData || []).map((s: any) => [String(s.id), {
        ...s,
        intervalIndex: s.intervalindex,
        addedAt: s.addedat,
        nextReviewDate: s.nextreviewdate,
        lastReviewedAt: s.lastreviewedat,
        timesReviewed: s.timesreviewed,
        isManual: s.ismanual,
        updatedAt: s.updatedat
      } as Sentence]));
      const localMap = new Map<string, Sentence>(validLocalSentences.map(s => [s.id, s]));
      const merged: Sentence[] = [];
      const toUpload: any[] = [];
      const allIds = new Set<string>([...cloudMap.keys(), ...localMap.keys()]);
      for (const id of allIds) {
        const local = localMap.get(id);
        const cloud = cloudMap.get(id);
        if (local && cloud) {
          if (local.updatedAt > cloud.updatedAt) {
            merged.push(local);
            toUpload.push(this.mapSentenceToDb(local, cleanUserName)); 
          } else {
            merged.push(cloud);
          }
        } else if (local) {
          merged.push(local);
          toUpload.push(this.mapSentenceToDb(local, cleanUserName)); 
        } else if (cloud) {
          merged.push(cloud);
        }
      }
      if (toUpload.length > 0) {
        const { error: uploadError } = await this.client
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
      username: username
    };
  }

  // 推送统计数据：严格匹配截图中的 user_stats 表结构
  async pushStats(stats: UserStats): Promise<SyncResult> {
    if (!this.client || !this.isReady) {
      return { success: false, message: '未配置云同步，跳过统计推送' };
    }
    try {
      const cleanUserName = this.userName;
      // 核心修改：映射到截图所示的列名
      const dbStats = {
        user_name: cleanUserName,             // 对应截图 user_name
        total_sentences: stats.totalSentences || 0, // 对应截图 total_sentences
        completed_count: stats.dictationCount || 0, // 映射到截图 completed_count
        favorite_count: 0,                    // 对应截图 favorite_count
        last_sync: new Date().toISOString()   // 对应截图 last_sync
      };
      // 注意：由于你的 id 是 int4 (整数) 且由数据库生成，
      // 我们在 upsert 时不能传 UUID 字符串 id。
      // 我们使用 user_name 作为冲突判断依据（需确保该列在 Supabase 有 Unique 约束）
      const { error } = await this.client
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

  // 拉取统计数据：严格从截图字段转回本地类型
  async pullStats(): Promise<{ stats: UserStats | null, message: string }> {
    if (!this.client || !this.isReady) {
      return { stats: null, message: '未配置云同步' };
    }
    try {
      const { data, error } = await this.client
        .from('user_stats')
        .select('*')
        .eq('user_name', this.userName)
        .maybeSingle();
      if (error) {
        console.error("❌ Pull stats error:", error.message);
        return { stats: null, message: `获取云端统计失败：${error.message}` };
      }
      if (!data) return { stats: null, message: '云端暂无数据' };
      // 将数据库字段映射回本地 UserStats 类型
      const mappedStats: UserStats = {
        id: String(data.id), // int4 转 string 适配类型
        totalPoints: 0,      // 表中没有此项，默认0
        totalSentences: data.total_sentences || 0,
        dictationCount: data.completed_count || 0,
        streak: 0,           // 表中没有此项，默认0
        lastLearnDate: data.last_sync || ''
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
  /**
   * 更新句子（用于markLearned/reviewFeedback同步）
   * @param sentence 待更新的句子
   */
  async updateSentence(sentence: Sentence): Promise<boolean> {
    if (!this.client || !this.isReady) {
      console.warn('❌ Supabase未初始化，更新句子失败');
      return false;
    }
    try {
      const cleanUserName = this.userName;
      const dbSentence = this.mapSentenceToDb(sentence, cleanUserName);
      const { error } = await this.client
        .from('sentences')
        .update(dbSentence)
        .eq('id', sentence.id)
        .eq('username', cleanUserName); // 增加用户名过滤，确保数据隔离
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

  /**
   * 添加新句子（用于addSentence同步）
   * @param sentence 新句子
   */
  async addSentence(sentence: Sentence): Promise<boolean> {
    if (!this.client || !this.isReady) {
      console.warn('❌ Supabase未初始化，添加句子失败');
      return false;
    }
    try {
      // 确保ID合法
      const validSentence = this.isValidUUID(sentence.id) 
        ? sentence 
        : { ...sentence, id: this.generateValidUUID() };
      
      const cleanUserName = this.userName;
      const dbSentence = this.mapSentenceToDb(validSentence, cleanUserName);
      const { error } = await this.client
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

  /**
   * 同步默写记录
   * @param record 默写记录（需确保你的Supabase有dictation_records表）
   */
  async syncDictationRecord(record: any): Promise<boolean> {
    if (!this.client || !this.isReady) {
      console.warn('❌ Supabase未初始化，同步默写记录失败');
      return false;
    }
    try {
      const cleanUserName = this.userName;
      // 适配数据库字段（建议dictation_records表包含以下字段）
      const dbRecord = {
        id: this.generateValidUUID(), // 生成唯一ID
        sentence_id: record.sentenceId,
        status: record.status, // correct/wrong
        timestamp: record.timestamp,
        is_finished: record.isFinished || false,
        username: cleanUserName // 关联用户名，确保数据隔离
      };
      const { error } = await this.client
        .from('dictation_records')
        .insert([dbRecord]);
      if (error) {
        console.error('❌ 同步默写记录失败:', error.message);
        return false;
      }
      console.log(`✅ 默写记录${dbRecord.id}同步成功`);
      return true;
    } catch (err: any) {
      console.error('❌ 同步默写记录异常:', err.message);
      return false;
    }
  }

  // ======================================
  // 新增：当日学习列表 云端推拉方法（核心）
  // ======================================
  /**
   * 推送当日学习列表到云端
   * @param date 当日日期（ISO格式：2026-02-22）
   * @param sentenceIds 句子ID数组
   */
  async pushDailySelection(date: string, sentenceIds: string[]): Promise<SyncResult> {
    if (!this.client || !this.isReady) {
      return { success: false, message: '未配置云同步，跳过当日列表推送' };
    }
    try {
      const cleanUserName = this.userName;
      const dbData = {
        user_name: cleanUserName,
        date: date,
        sentence_ids: sentenceIds,
        updated_at: new Date().toISOString()
      };
      // 按user_name+date做冲突更新，保证一个用户一天只有一条数据
      // 修复：去掉列名之间的空格，兼容Supabase语法
      const { error } = await this.client
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

  /**
   * 从云端拉取当日学习列表
   * @param date 当日日期（ISO格式：2026-02-22）
   */
  async pullDailySelection(date: string): Promise<{ ids: string[] | null, message: string }> {
    if (!this.client || !this.isReady) {
      return { ids: null, message: '未配置云同步，跳过当日列表拉取' };
    }
    try {
      const cleanUserName = this.userName;
      const { data, error } = await this.client
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