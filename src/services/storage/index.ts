import { localStorageService } from './localStorageService';
import { storageSyncService } from './storageSyncService';
import { storageSentenceService } from './storageSentenceService';
import { storageFsrsService } from './storageFsrsService';
import { supabaseService } from '../supabaseService';
import { UserStats } from '../../types';

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
  save(key: string, value: any) {
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

  // ==============================================
  // 今日选择相关方法
  // ==============================================
  getTodaySelection: async (): Promise<string[]> => {
    const today = new Date().toISOString().split('T')[0];
    const localData = localStorageService.getTodaySelection();

    if (localData && localData.date === today) {
      if (supabaseService.isReady) {
        storageSyncService.pullDailySelectionInBackground(today);
      }
      return localData.ids;
    }

    if (supabaseService.isReady) {
      storageSyncService.pullDailySelectionInBackground(today);
    }
    return [];
  },

  saveTodaySelection: async (ids: string[]) => {
    localStorageService.saveTodaySelection(ids);
    if (supabaseService.isReady) {
      await supabaseService.pushDailySelection(new Date().toISOString().split('T')[0], ids);
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
  cleanupOldDictationRecords: localStorageService.cleanupOldDictationRecords
};
