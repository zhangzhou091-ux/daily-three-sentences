import { Sentence, UserStats, DictationRecord, UserSettings, ReviewRating, CardState } from '../../types';
import { dbService } from '../dbService';
import { supabaseService } from '../supabaseService';
import { fsrsService, State } from '../fsrsService';
import { localStorageService } from './localStorageService';

const SYNC_INTERVAL = 10 * 60 * 1000;

// 防止重复拉取标志
let isPullingDailySelection = false;

function stateToCardState(state: State): CardState {
  const mapping: Record<number, CardState> = {
    [State.New]: CardState.New,
    [State.Learning]: CardState.Learning,
    [State.Review]: CardState.Review,
    [State.Relearning]: CardState.Relearning
  };
  return mapping[state] ?? CardState.New;
}

function cardStateToState(cardState: CardState): State {
  const mapping: Record<number, State> = {
    [CardState.New]: State.New,
    [CardState.Learning]: State.Learning,
    [CardState.Review]: State.Review,
    [CardState.Relearning]: State.Relearning
  };
  return mapping[cardState] ?? State.New;
}

export const storageSyncService = {
  /**
   * 初始化同步配置
   */
  initSync: async () => {
    const settings = localStorageService.getSettings();
    if (settings.userName) {
      await supabaseService.setUserName(settings.userName);
      if (import.meta.env.DEV) {
        console.log('同步用户已设置:', settings.userName);
      }
    }
  },

  /**
   * 执行全量同步（带节流）
   */
  performFullSync: async () => {
    if (!supabaseService.isReady) return;

    const lastSyncTimeStr = localStorage.getItem('d3s_last_sync_time');
    const lastSyncTime = lastSyncTimeStr ? Number(lastSyncTimeStr) : 0;
    const now = Date.now();

    if (now - lastSyncTime < SYNC_INTERVAL) {
      if (import.meta.env.DEV) {
        console.log(`🔴 未到同步间隔（${SYNC_INTERVAL/60000}分钟），跳过全量同步`);
      }
      return;
    }

    const synced = await supabaseService.syncSentencesWithFreshData(async () => {
      const local = await dbService.getAll();
      return local.sort((a, b) => a.addedAt - b.addedAt);
    });

    // 删除云端已删除的本地句子
    if (synced.deletedLocalIds && synced.deletedLocalIds.length > 0) {
      for (const id of synced.deletedLocalIds) {
        await dbService.delete(id);
      }
    }

    if (synced.needsLocalUpdate) {
      const syncedSorted = synced.sentences.sort((a, b) => a.addedAt - b.addedAt);
      await dbService.putAll(syncedSorted);
    }

    const localStats = localStorageService.getStats();
    try {
      const cloudStatsResult = await supabaseService.pullStats();
      const cloudStats = cloudStatsResult?.stats;

      if (cloudStats && cloudStats.lastLearnDate && new Date(cloudStats.lastLearnDate).getTime() > new Date(localStats.lastLearnDate).getTime()) {
        localStorageService.saveStats(cloudStats);
      } else {
        localStorageService.saveStats(localStats);
      }

      localStorage.setItem('d3s_last_sync_time', now.toString());
      if (import.meta.env.DEV) {
        console.log('✅ 全量同步完成，更新最后同步时间');
      }
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn('同步统计数据失败，使用本地数据:', err);
      }
    }
  },

  /**
   * 后台拉取云端当日选择（不阻塞页面）
   */
  pullDailySelectionInBackground: async (today: string) => {
    if (supabaseService.isReady && !isPullingDailySelection) {
      isPullingDailySelection = true;
      try {
        const cloudRes = await supabaseService.pullDailySelection(today);
        if (cloudRes.ids && Array.isArray(cloudRes.ids) && cloudRes.ids.length > 0) {
          const localData = localStorageService.getTodaySelection();
          if (!localData || !localData.ids || localData.ids.length === 0) {
            localStorageService.saveTodaySelection(cloudRes.ids);
            if (import.meta.env.DEV) {
              console.log('✅ 后台拉取云端当日列表，本地为空，已更新');
            }
            window.dispatchEvent(new CustomEvent('dailySelectionUpdated'));
          } else {
            if (import.meta.env.DEV) {
              console.log('⏭️ 后台拉取云端当日列表，本地已有数据，跳过覆盖');
            }
          }
        }
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn('❌ 后台拉取云端当日列表失败:', err);
        }
      } finally {
        setTimeout(() => {
          isPullingDailySelection = false;
        }, 5000);
      }
    }
  }
};
