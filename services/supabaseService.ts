
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Sentence, UserStats, UserSettings } from '../types';

class SupabaseService {
  private client: SupabaseClient | null = null;
  private isConfigured: boolean = false;

  init(url: string, key: string) {
    if (!url || !key) return;
    this.client = createClient(url, key);
    this.isConfigured = true;
  }

  get isReady() {
    return this.isConfigured && this.client !== null;
  }

  async signUp(email: string, pass: string) {
    if (!this.client) throw new Error("Supabase not configured");
    return await this.client.auth.signUp({ email, password: pass });
  }

  async signIn(email: string, pass: string) {
    if (!this.client) throw new Error("Supabase not configured");
    return await this.client.auth.signInWithPassword({ email, password: pass });
  }

  async signOut() {
    if (!this.client) return;
    await this.client.auth.signOut();
  }

  async getSession() {
    if (!this.client) return null;
    const { data } = await this.client.auth.getSession();
    return data.session;
  }

  // --- 同步核心逻辑 ---

  async syncSentences(localSentences: Sentence[]): Promise<Sentence[]> {
    if (!this.client) return localSentences;
    const session = await this.getSession();
    if (!session) return localSentences;

    const user_id = session.user.id;

    // 1. 获取云端最新数据
    const { data: cloudData, error } = await this.client
      .from('sentences')
      .select('*')
      .eq('user_id', user_id);

    if (error) {
      console.error("Fetch cloud sentences error:", error);
      return localSentences;
    }

    // Fix: Explicitly type maps to avoid unknown types
    const cloudMap = new Map<string, Sentence>((cloudData || []).map((s: any) => [String(s.id), s as Sentence]));
    const localMap = new Map<string, Sentence>(localSentences.map(s => [s.id, s]));
    const merged: Sentence[] = [];
    const toUpload: any[] = [];

    // 处理本地与云端的合并
    // 使用 updatedAt (Last-Write-Wins)
    // Fix: Explicitly type the set to string
    const allIds = new Set<string>([...cloudMap.keys(), ...localMap.keys()]);

    for (const id of allIds) {
      const local = localMap.get(id);
      const cloud = cloudMap.get(id);

      if (local && cloud) {
        if (local.updatedAt > cloud.updatedAt) {
          merged.push(local);
          toUpload.push({ ...local, user_id });
        } else {
          merged.push(cloud);
        }
      } else if (local) {
        merged.push(local);
        toUpload.push({ ...local, user_id });
      } else if (cloud) {
        merged.push(cloud);
      }
    }

    // 2. 批量上传变更
    if (toUpload.length > 0) {
      await this.client.from('sentences').upsert(toUpload);
    }

    return merged;
  }

  async pushStats(stats: UserStats) {
    if (!this.client) return;
    const session = await this.getSession();
    if (!session) return;
    await this.client.from('user_stats').upsert({ ...stats, user_id: session.user.id });
  }

  async pullStats(): Promise<UserStats | null> {
    if (!this.client) return null;
    const session = await this.getSession();
    if (!session) return null;
    const { data, error } = await this.client
      .from('user_stats')
      .select('*')
      .eq('user_id', session.user.id)
      .single();
    if (error) return null;
    return data as UserStats;
  }
}

export const supabaseService = new SupabaseService();
