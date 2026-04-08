import { localStorageService } from './localStorageService';
import { storageSyncService } from './storageSyncService';
import { storageSentenceService } from './storageSentenceService';
import { storageFsrsService } from './storageFsrsService';
import { supabaseService } from '../supabaseService';
import { UserStats } from '../../types';
import { getLocalDateString } from '../../utils/date';

export { localStorageService } from './localStorageService';
export { storageFsrsService } from './storageFsrsService';
export { storageSentenceService } from './storageSentenceService';
export { storageSyncService } from './storageSyncService';

export const storageService = {
  // ==============================================
  // 新增：适配 offlineQueueService 的核心方法
  // ==============================================
  /**
   * 从本地存储获取数据（供 offlineQueueService 调用）
   */
  get(key: string) {
    return localStorageService.get(key);
  },

  /**
   * 保存数据到本地存储（供 offlineQueueService 调用）
   */
  save(key: string, value: unknown) {
    localStorageService.save(key, value);
  },

  // ==============================================
  // 同步相关方法
  // ==============================================
  initSync: storageSyncService.initSync,
  performFullSync: storageSyncService.performFullSync,
  pullDailySelectionInBackground: storageSyncService.pullDailySelectionInBackground,

  // ==============================================
  // 句子相关方法
  // ==============================================
  getSentences: storageSentenceService.getSentences,
  saveSentences: storageSentenceService.saveSentences,
  addSentence: storageSentenceService.addSentence,
  checkDuplicate: storageSentenceService.checkDuplicate,
  findDuplicates: storageSentenceService.findDuplicates,
  deleteSentence: storageSentenceService.deleteSentence,
  clearVocabulary: storageSentenceService.clearVocabulary,
  clearAllData: storageSentenceService.clearAllData,

  // ==============================================
  // 设置相关方法
  // ==============================================
  getSettings: localStorageService.getSettings,
  saveSettings: localStorageService.saveSettings,

  // ==============================================
  // 统计相关方法
  // ==============================================
  getStats: localStorageService.getStats,
  saveStats: async (stats: UserStats, triggerCloud: boolean = true) => {
    localStorageService.saveStats(stats);

    if (triggerCloud && supabaseService.isReady) {
      try {
        const result = await supabaseService.pushStats(stats);
        if (result.success) {
          if (import.meta.env.DEV) console.log('✅ 统计数据同步到 Supabase 成功');
        } else {
          if (import.meta.env.DEV) {
            console.warn('❌ 统计数据同步失败，已加入离线队列:', result.message);
          }
          const { syncQueueService } = await import('../syncQueueService');
          syncQueueService.addStatsSync(stats);
        }
      } catch (err) {
        if (import.meta.env.DEV) {
          console.error('❌ 同步失败，已加入离线队列:', err);
        }
        const { syncQueueService } = await import('../syncQueueService');
        syncQueueService.addStatsSync(stats);
      }
    }
  },
  updateStatsSafely: async (updater: (stats: UserStats) => UserStats, triggerCloud: boolean = true): Promise<void> => {
    await localStorageService.updateStatsSafely(updater, triggerCloud);
    
    if (triggerCloud && supabaseService.isReady) {
      try {
        const stats = localStorageService.getStats();
        const result = await supabaseService.pushStats(stats);
        if (!result.success) {
          const { syncQueueService } = await import('../syncQueueService');
          try {
            syncQueueService.addStatsSync(stats);
          } catch (queueErr) {
            console.error('同步队列添加失败，暂存统计数据:', queueErr);
            try {
              const pendingStats = JSON.parse(localStorage.getItem('d3s_pending_stats') || '[]');
              pendingStats.push({ stats, timestamp: Date.now() });
              localStorage.setItem('d3s_pending_stats', JSON.stringify(pendingStats));
            } catch {
              // 忽略存储错误
            }
          }
        }
      } catch (err) {
        const stats = localStorageService.getStats();
        const { syncQueueService } = await import('../syncQueueService');
        try {
          syncQueueService.addStatsSync(stats);
        } catch (queueErr) {
          console.error('同步队列添加失败，暂存统计数据:', queueErr);
          try {
            const pendingStats = JSON.parse(localStorage.getItem('d3s_pending_stats') || '[]');
            pendingStats.push({ stats, timestamp: Date.now() });
            localStorage.setItem('d3s_pending_stats', JSON.stringify(pendingStats));
          } catch {
            // 忽略存储错误
          }
        }
      }
    }
  },

  recoverPendingStats: async (): Promise<void> => {
    try {
      const pendingStats = JSON.parse(localStorage.getItem('d3s_pending_stats') || '[]');
      if (pendingStats.length === 0) return;
      
      console.log(`📊 发现 ${pendingStats.length} 条待恢复统计数据`);
      
      const { syncQueueService } = await import('../syncQueueService');
      let recovered = 0;
      
      for (const item of pendingStats) {
        try {
          if (supabaseService.isReady) {
            const result = await supabaseService.pushStats(item.stats);
            if (result.success) {
              recovered++;
              continue;
            }
          }
          syncQueueService.addStatsSync(item.stats);
          recovered++;
        } catch {
          // 忽略单条恢复失败
        }
      }
      
      if (recovered === pendingStats.length) {
        localStorage.removeItem('d3s_pending_stats');
        console.log(`📊 成功恢复 ${recovered} 条统计数据`);
      }
    } catch {
      // 忽略恢复错误
    }
  },

  // ==============================================
  // 今日选择相关方法
  // ==============================================
  getTodaySelection: async (): Promise<string[]> => {
    const today = getLocalDateString();
    const localData = localStorageService.getTodaySelection();

    if (localData && localData.date === today) {
      if (supabaseService.isReady) {
        storageSyncService.pullDailySelectionInBackground(today);
      }
      const validIds = localData.ids.filter(id => id && typeof id === 'string');
      return validIds;
    }

    if (supabaseService.isReady) {
      storageSyncService.pullDailySelectionInBackground(today);
    }
    return [];
  },

  getYesterdaySelection: (): string[] => {
    const yesterday = getLocalDateString(Date.now() - 86400000);
    return localStorageService.getSelectionByDate(yesterday);
  },

  saveTodaySelection: async (ids: string[]) => {
    localStorageService.saveTodaySelection(ids);
    if (supabaseService.isReady) {
      await supabaseService.pushDailySelection(getLocalDateString(), ids);
    }
  },

  // ==============================================
  // 默写相关方法
  // ==============================================
  getTodayDictations: localStorageService.getTodayDictations,
  saveTodayDictations: localStorageService.saveTodayDictations,

  // ==============================================
  // FSRS 相关方法
  // ==============================================
  calculateNextReview: storageFsrsService.calculateNextReview,
  initFSRSForSentence: storageFsrsService.initFSRSForSentence,
  calculateLevelFromStability: storageFsrsService.calculateLevelFromStability,

  // ==============================================
  // 清理相关方法
  // ==============================================
  cleanupOldDictationRecords: localStorageService.cleanupOldDictationRecords,

  // ==============================================
  // 学习完成数量相关方法
  // ==============================================
  getYesterdayLearnedCount: localStorageService.getYesterdayLearnedCount,
  saveTodayLearnedCount: localStorageService.saveTodayLearnedCount,
  getTodayLearnedCount: localStorageService.getTodayLearnedCount,
  incrementTodayLearnedCount: localStorageService.incrementTodayLearnedCount
};
