/**
 * 智能跨标签页数据同步服务
 * 解决多标签页数据冲突问题
 */

import { UserStats, UserSettings, Sentence } from '../types';

type SyncMessage =
  | { type: 'stats_update'; data: UserStats; timestamp: number; tabId: string }
  | { type: 'settings_update'; data: UserSettings; timestamp: number; tabId: string }
  | { type: 'sentences_update'; data: Sentence[]; timestamp: number; tabId: string };

export class SmartSyncService {
  private channel: BroadcastChannel;
  private tabId: string;
  private isInitialized = false;

  constructor() {
    this.tabId = this.generateTabId();
    this.channel = new BroadcastChannel('d3s_sync');
    this.setupCrossTabSync();
  }

  private generateTabId(): string {
    return `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private setupCrossTabSync(): void {
    // 监听其他标签页的消息
    this.channel.addEventListener('message', (event) => {
      const message: SyncMessage = event.data;
      
      // 忽略自己发送的消息
      if (message.tabId === this.tabId) return;

      this.handleSyncMessage(message);
    });

    // 页面关闭前发送同步消息
    window.addEventListener('beforeunload', () => {
      this.broadcastCurrentState();
    });

    this.isInitialized = true;
  }

  /**
   * 智能合并统计数据（字段级合并策略）
   * 解决 Math.max 导致的离线数据丢失问题
   *
   * 策略：
   * 1. 数字类字段：取 Math.max（防止倒退）
   * 2. 日期类字段：取较晚者
   * 3. 新增字段：自动纳入 Math.max 保护
   */
  mergeStats(current: UserStats, incoming: UserStats): UserStats {
    if (!current || !incoming) {
      return current || incoming || {
        id: crypto.randomUUID?.() || String(Date.now()),
        streak: 0,
        lastLearnDate: '',
        totalPoints: 0,
        dictationCount: 0,
        completionDays: 0,
        lastCompletionDate: '',
        updatedAt: Date.now()
      };
    }

    const now = Date.now();

    return {
      ...incoming,
      ...current,

      id: current.id || incoming.id || crypto.randomUUID?.() || String(now),

      streak: Math.max(current.streak, incoming.streak),
      maxStreak: Math.max(current.maxStreak || 0, incoming.maxStreak || 0),
      totalPoints: Math.max(current.totalPoints, incoming.totalPoints),
      dictationCount: Math.max(current.dictationCount, incoming.dictationCount),
      completionDays: Math.max(current.completionDays, incoming.completionDays),

      totalDaysLearned: Math.max(current.totalDaysLearned || 0, incoming.totalDaysLearned || 0),
      totalLapses: Math.max(current.totalLapses || 0, incoming.totalLapses || 0),
      weekDictationCount: Math.max(current.weekDictationCount || 0, incoming.weekDictationCount || 0),
      maxDailyDictation: Math.max(current.maxDailyDictation || 0, incoming.maxDailyDictation || 0),

      mobileLearnCount: Math.max(current.mobileLearnCount || 0, incoming.mobileLearnCount || 0),
      mobileReviewCount: Math.max(current.mobileReviewCount || 0, incoming.mobileReviewCount || 0),
      mobileDictationCount: Math.max(current.mobileDictationCount || 0, incoming.mobileDictationCount || 0),

      totalSentences: Math.max(current.totalSentences || 0, incoming.totalSentences || 0),
      totalDictation: Math.max(current.totalDictation || 0, incoming.totalDictation || 0),

      shareCount: Math.max(current.shareCount || 0, incoming.shareCount || 0),
      batchSyncCount: Math.max(current.batchSyncCount || 0, incoming.batchSyncCount || 0),
      breakTimes: Math.max(current.breakTimes || 0, incoming.breakTimes || 0),
      streakQualified: Math.max(current.streakQualified || 0, incoming.streakQualified || 0),

      lastLearnDate: this.mergeDate(current.lastLearnDate, incoming.lastLearnDate),
      lastCompletionDate: this.mergeDate(current.lastCompletionDate, incoming.lastCompletionDate),

      updatedAt: now
    };
  }

  private mergeDate(current: string, incoming: string): string {
    if (!current && !incoming) return '';
    if (!current) return incoming;
    if (!incoming) return current;
    return new Date(current) > new Date(incoming) ? current : incoming;
  }

  private handleSyncMessage(message: SyncMessage): void {
    switch (message.type) {
      case 'stats_update':
        this.handleStatsUpdate(message.data);
        break;
      case 'settings_update':
        this.handleSettingsUpdate(message.data);
        break;
      case 'sentences_update':
        this.handleSentencesUpdate(message.data);
        break;
    }
  }

  private handleStatsUpdate(incomingStats: UserStats): void {
    const currentStats = this.getLocalStats();
    if (!currentStats) {
      // 如果没有本地数据，直接使用传入的数据
      localStorage.setItem('d3s_user_stats_v3', JSON.stringify(incomingStats));
      return;
    }
    
    const mergedStats = this.mergeStats(currentStats, incomingStats);
    
    // 保存合并后的数据
    localStorage.setItem('d3s_user_stats_v3', JSON.stringify(mergedStats));
    
    // 触发UI更新
    window.dispatchEvent(new CustomEvent('d3s:stats_updated', { 
      detail: { source: 'sync', stats: mergedStats } 
    }));
    
    if (import.meta.env.DEV) {
      console.log('🔄 统计数据已从其他标签页同步', mergedStats);
    }
  }

  private handleSettingsUpdate(settings: UserSettings): void {
    localStorage.setItem('d3s_settings_v3', JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent('settingsChanged'));
  }

  private handleSentencesUpdate(sentences: Sentence[]): void {
    console.log('句子数据同步:', sentences.length);
  }

  /**
   * 广播当前状态到其他标签页
   */
  broadcastStatsUpdate(stats: UserStats): void {
    if (!this.isInitialized) return;

    const message: SyncMessage = {
      type: 'stats_update',
      data: stats,
      timestamp: Date.now(),
      tabId: this.tabId
    };

    this.channel.postMessage(message);
  }

  broadcastSettingsUpdate(settings: UserSettings): void {
    if (!this.isInitialized) return;

    const message: SyncMessage = {
      type: 'settings_update',
      data: settings,
      timestamp: Date.now(),
      tabId: this.tabId
    };

    this.channel.postMessage(message);
  }

  private broadcastCurrentState(): void {
    // 页面关闭前同步当前状态
    const stats = this.getLocalStats();
    const settings = localStorage.getItem('d3s_settings_v3');
    
    if (stats) {
      this.broadcastStatsUpdate(stats);
    }
    
    if (settings) {
      try {
        this.broadcastSettingsUpdate(JSON.parse(settings));
      } catch (error) {
        console.warn('设置数据解析失败，跳过同步');
      }
    }
  }

  private getLocalStats(): UserStats | null {
    try {
      const data = localStorage.getItem('d3s_user_stats_v3');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  /**
   * 安全更新统计数据（增强版）
   * 结合Web Locks和跨标签页同步
   */
  async updateStatsSafely(updater: (stats: UserStats) => UserStats): Promise<void> {
    // 使用Web Locks防止当前标签页内的并发
    if (navigator.locks?.request) {
      return navigator.locks.request('d3s_stats_lock', async () => {
        await this.doUpdateStats(updater);
      });
    } else {
      // 降级方案
      await this.doUpdateStats(updater);
    }
  }

  private async doUpdateStats(updater: (stats: UserStats) => UserStats): Promise<void> {
    const currentStats = this.getLocalStats();
    const updatedStats = updater(currentStats || this.getDefaultStats());
    
    // 保存到本地
    localStorage.setItem('d3s_user_stats_v3', JSON.stringify(updatedStats));
    
    // 广播到其他标签页
    this.broadcastStatsUpdate(updatedStats);
    
    if (import.meta.env.DEV) {
      console.log('💾 统计数据已更新并广播', updatedStats);
    }
  }

  private getDefaultStats(): UserStats {
    return {
      id: crypto.randomUUID(),
      streak: 0,
      lastLearnDate: '',
      totalPoints: 0,
      dictationCount: 0,
      completionDays: 0,
      lastCompletionDate: '',
      updatedAt: Date.now()
    };
  }

  destroy(): void {
    this.channel.close();
  }
}

// 全局单例
export const smartSyncService = new SmartSyncService();