import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Sentence, UserStats, UserSettings } from '../types';

// 🔴 新增：统一的同步结果类型
export interface SyncResult {
  success: boolean;
  message: string;
  errorType?: string;
}

class SupabaseService {
  private client: SupabaseClient | null = null;
  private isConfigured: boolean = false;
  // 🔴 新增：用户名（用于数据隔离，替代原user_id）
  private userName: string = '';

  // 🔴 核心修改：改为async方法，支持用户名绑定，防止重复创建
  async init(url: string, key: string, userName: string): Promise<SyncResult> {
    // 检查是否已有相同用户的有效客户端，避免重复创建
    if (this.client && this.isConfigured && this.userName === userName) {
      return {
        success: true,
        message: `✅ 已使用现有配置，用户：${userName}`
      };
    }

    // 基础校验
    if (!url || !key) {
      this.isConfigured = false;
      this.client = null;
      this.userName = '';
      return {
        success: false,
        message: 'URL或KEY不能为空，请检查配置',
        errorType: 'invalid_config'
      };
    }
    if (!userName) {
      this.isConfigured = false;
      this.client = null;
      this.userName = '';
      return {
        success: false,
        message: '用户名不能为空（用于数据隔离）',
        errorType: 'empty_username'
      };
    }

    try {
      // 先清除旧客户端，避免多实例冲突
      this.clearConfig();
      // 创建新客户端
      this.client = createClient(url, key);
      
      // 绑定用户名到Supabase上下文（需提前创建set_config函数）
      try {
        await this.client.rpc('set_config', {
          config_key: 'app.current_user_name',
          config_value: userName
        });
        if (import.meta.env.DEV) {
          console.log(`✅ 用户名【${userName}】已绑定到Supabase上下文`);
        }
      } catch (contextErr) {
        if (import.meta.env.DEV) {
          console.error('❌ 绑定用户名上下文失败：', contextErr);
        }
        return {
          success: false,
          message: '配置成功，但用户名绑定失败（请检查Supabase是否创建set_config函数）',
          errorType: 'context_failed'
        };
      }

      // 更新配置状态
      this.isConfigured = true;
      this.userName = userName;
      if (import.meta.env.DEV) {
        console.log(`✅ Supabase配置成功，用户名：${this.userName}`);
      }
      return {
        success: true,
        message: `配置成功！将同步【${userName}】的专属数据`
      };
    } catch (err: any) {
      // 初始化失败，清空配置
      this.isConfigured = false;
      this.client = null;
      this.userName = '';
      if (import.meta.env.DEV) {
        console.error('❌ Supabase初始化失败：', err);
      }
      return {
        success: false,
        message: `URL或KEY格式错误：${err.message || '请检查（比如是否多了空格/少了字符）'}`,
        errorType: 'invalid_config'
      };
    }
  }

  // 🔴 新增：清空配置，解决多实例问题
  clearConfig(): void {
    this.client = null;
    this.isConfigured = false;
    this.userName = '';
    if (import.meta.env.DEV) {
      console.log('ℹ️ Supabase配置已清空');
    }
  }

  // 🔴 保留：就绪状态判断
  get isReady() {
    return this.isConfigured && this.client !== null && !!this.userName;
  }

  // 🔴 移除：登录相关方法（不再需要）
  // async signUp(email: string, pass: string) { ... }
  // async signIn(email: string, pass: string) { ... }
  // async signOut() { ... }
  // async getSession() { ... }

  // --- 同步核心逻辑（修改为用户名隔离）---
  async syncSentences(localSentences: Sentence[]): Promise<{ sentences: Sentence[], message: string }> {
    // 未配置则直接返回本地数据
    if (!this.client || !this.isReady) {
      return { sentences: localSentences, message: '未配置云同步，使用本地数据' };
    }

    try {
      // 1. 获取云端最新数据（按userName隔离）
      const { data: cloudData, error } = await this.client
        .from('sentences')
        .select('*')
        .eq('user_name', this.userName); // 🔴 替换为user_name

      if (error) {
        console.error("Fetch cloud sentences error:", error);
        return { sentences: localSentences, message: `同步失败：${error.message}` };
      }

      // 2. 合并本地与云端数据（Last-Write-Wins策略）
      const cloudMap = new Map<string, Sentence>((cloudData || []).map((s: any) => [String(s.id), s as Sentence]));
      const localMap = new Map<string, Sentence>(localSentences.map(s => [s.id, s]));
      const merged: Sentence[] = [];
      const toUpload: any[] = [];

      // 遍历所有ID，合并数据
      const allIds = new Set<string>([...cloudMap.keys(), ...localMap.keys()]);
      for (const id of allIds) {
        const local = localMap.get(id);
        const cloud = cloudMap.get(id);

        if (local && cloud) {
          // 本地更新时间更新则用本地，否则用云端
          if (local.updatedAt > cloud.updatedAt) {
            merged.push(local);
            toUpload.push({ ...local, user_name: this.userName }); // 🔴 加入user_name
          } else {
            merged.push(cloud);
          }
        } else if (local) {
          // 本地有、云端无，加入上传列表
          merged.push(local);
          toUpload.push({ ...local, user_name: this.userName }); // 🔴 加入user_name
        } else if (cloud) {
          // 云端有、本地无，加入合并结果
          merged.push(cloud);
        }
      }

      // 3. 批量上传变更数据到云端
      if (toUpload.length > 0) {
        const { error: uploadError } = await this.client.from('sentences').upsert(toUpload);
        if (uploadError) {
          console.error("Upload sentences error:", uploadError);
          return { sentences: merged, message: `部分同步：${uploadError.message}` };
        }
      }

      const syncMsg = toUpload.length > 0 
        ? `成功同步${toUpload.length}条数据到云端` 
        : '数据已最新，无需同步';
      return { sentences: merged, message: syncMsg };
    } catch (err: any) {
      console.error("Sync sentences failed:", err);
      return { sentences: localSentences, message: `同步异常：${err.message}` };
    }
  }

  // 🔴 修改：推送统计数据（按userName隔离）
  async pushStats(stats: UserStats): Promise<SyncResult> {
    if (!this.client || !this.isReady) {
      return { success: false, message: '未配置云同步，跳过统计推送' };
    }

    try {
      await this.client.from('user_stats').upsert({ 
        ...stats, 
        user_name: this.userName // 🔴 替换为user_name
      });
      return { success: true, message: '统计数据推送成功' };
    } catch (err: any) {
      console.error("Push stats error:", err);
      return { success: false, message: `统计推送失败：${err.message}` };
    }
  }

  // 🔴 修改：拉取统计数据（按userName隔离）
  async pullStats(): Promise<{ stats: UserStats | null, message: string }> {
    if (!this.client || !this.isReady) {
      return { stats: null, message: '未配置云同步，使用本地统计' };
    }

    try {
      const { data, error } = await this.client
        .from('user_stats')
        .select('*')
        .eq('user_name', this.userName) // 🔴 替换为user_name
        .single();

      if (error) {
        return { stats: null, message: `暂无云端统计：${error.message}` };
      }
      return { stats: data as UserStats, message: '统计数据拉取成功' };
    } catch (err: any) {
      console.error("Pull stats error:", err);
      return { stats: null, message: `统计拉取失败：${err.message}` };
    }
  }
}

// 导出单例实例
export const supabaseService = new SupabaseService();