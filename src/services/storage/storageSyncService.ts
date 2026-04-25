import { Sentence, UserStats, DictationRecord, UserSettings, ReviewRating, CardState } from '../../types';
import { dbService } from '../dbService';
import { supabaseService, CloudSentenceData } from '../supabaseService';
import { fsrsService, State } from '../fsrsService';
import { localStorageService } from './localStorageService';
import { deviceService } from '../deviceService';

const SYNC_INTERVAL = 10 * 60 * 1000;
const LAST_INCREMENTAL_SYNC_KEY = 'd3s_last_incremental_sync_time';

let isPullingDailySelection = false;

function mapCloudToLocal(db: CloudSentenceData): Sentence {
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
        console.log(`🔴 未到同步间隔（${SYNC_INTERVAL/60000}分钟），跳过同步`);
      }
      return;
    }

    const lastIncrementalStr = localStorage.getItem(LAST_INCREMENTAL_SYNC_KEY);
    const lastIncrementalTime = lastIncrementalStr ? Number(lastIncrementalStr) : 0;
    const hasIncrementalBase = lastIncrementalTime > 0;

    if (hasIncrementalBase) {
      await storageSyncService.performIncrementalSync();
    } else {
      await storageSyncService.performFullSyncForce();
    }

    const localStats = localStorageService.getStats();
    try {
      const cloudStatsResult = await supabaseService.pullStats();
      const cloudStats = cloudStatsResult?.stats;

      if (cloudStats && cloudStats.lastLearnDate && new Date(cloudStats.lastLearnDate).getTime() > new Date(localStats.lastLearnDate).getTime()) {
        localStorageService.saveStats(cloudStats);
      } else if (deviceService.canUploadSync()) {
        localStorageService.saveStats(localStats);
      }

      localStorage.setItem('d3s_last_sync_time', now.toString());
      if (import.meta.env.DEV) {
        console.log('✅ 同步完成，更新最后同步时间');
      }
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn('同步统计数据失败，使用本地数据:', err);
      }
    }
  },

  performFullSyncForce: async () => {
    if (!supabaseService.isReady) return;

    const synced = await supabaseService.syncSentencesWithFreshData(async () => {
      const local = await dbService.getAll();
      return local.sort((a, b) => a.addedAt - b.addedAt);
    });

    if (synced.deletedLocalIds && synced.deletedLocalIds.length > 0) {
      for (const id of synced.deletedLocalIds) {
        await dbService.delete(id);
      }
    }

    if (synced.needsLocalUpdate) {
      const syncedSorted = synced.sentences.sort((a, b) => a.addedAt - b.addedAt);
      await dbService.putAll(syncedSorted);
    }

    localStorage.setItem(LAST_INCREMENTAL_SYNC_KEY, Date.now().toString());
    if (import.meta.env.DEV) {
      console.log('✅ 全量同步完成，已建立增量同步基准');
    }
  },

  performIncrementalSync: async () => {
    if (!supabaseService.isReady) return;

    const lastIncrementalStr = localStorage.getItem(LAST_INCREMENTAL_SYNC_KEY);
    const lastIncrementalTime = lastIncrementalStr ? Number(lastIncrementalStr) : 0;
    if (lastIncrementalTime === 0) return;

    try {
      const client = supabaseService.client;
      if (!client) return;

      const userName = supabaseService.userName;
      const { data: cloudChanges, error } = await client
        .from('sentences')
        .select('*')
        .eq('username', userName)
        .gte('updatedat', lastIncrementalTime - 1000)
        .order('updatedat', { ascending: true });

      if (error) {
        if (import.meta.env.DEV) {
          console.warn('❌ 增量拉取失败，回退全量同步:', error.message);
        }
        await storageSyncService.performFullSyncForce();
        return;
      }

      if (!cloudChanges || cloudChanges.length === 0) {
        if (import.meta.env.DEV) {
          console.log('✅ 增量同步：无变更');
        }
        localStorage.setItem(LAST_INCREMENTAL_SYNC_KEY, Date.now().toString());
        return;
      }

      const localSentences = await dbService.getAll();
      const localMap = new Map<string, Sentence>();
      localSentences.forEach(s => {
        localMap.set(s.id, s);
      });

      const localEnglishMap = new Map<string, Sentence>();
      localSentences.forEach(s => {
        const normalized = s.english.trim().toLowerCase();
        const existing = localEnglishMap.get(normalized);
        if (!existing || (s.updatedAt && (!existing.updatedAt || s.updatedAt > existing.updatedAt))) {
          localEnglishMap.set(normalized, s);
        }
      });

      const toUpdate: Sentence[] = [];
      const cloudIdSet = new Set<string>();

      for (const cloudData of cloudChanges) {
        cloudIdSet.add(cloudData.id);
        const normalizedEnglish = cloudData.english.trim().toLowerCase();
        const localByEnglish = localEnglishMap.get(normalizedEnglish);

        if (localByEnglish && localByEnglish.id === cloudData.id) {
          const localTime = localByEnglish.updatedAt || 0;
          const cloudTime = cloudData.updatedat || 0;
          if (cloudTime > localTime) {
            const mapped = mapCloudToLocal(cloudData);
            toUpdate.push(mapped);
          }
        } else if (!localMap.has(cloudData.id)) {
          const existingByEnglish = localEnglishMap.get(normalizedEnglish);
          if (!existingByEnglish) {
            toUpdate.push(mapCloudToLocal(cloudData));
          } else {
            const localTime = existingByEnglish.updatedAt || 0;
            const cloudTime = cloudData.updatedat || 0;
            if (cloudTime > localTime) {
              toUpdate.push(mapCloudToLocal(cloudData));
            }
          }
        } else {
          const localExisting = localMap.get(cloudData.id)!;
          const localTime = localExisting.updatedAt || 0;
          const cloudTime = cloudData.updatedat || 0;
          if (cloudTime > localTime) {
            toUpdate.push(mapCloudToLocal(cloudData));
          }
        }
      }

      if (toUpdate.length > 0) {
        await dbService.putAll(toUpdate);
        if (import.meta.env.DEV) {
          console.log(`✅ 增量同步：更新 ${toUpdate.length} 条记录`);
        }
      } else {
        if (import.meta.env.DEV) {
          console.log(`✅ 增量同步：${cloudChanges.length} 条变更，本地均已是最新`);
        }
      }

      localStorage.setItem(LAST_INCREMENTAL_SYNC_KEY, Date.now().toString());
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn('❌ 增量同步异常，回退全量同步:', err);
      }
      await storageSyncService.performFullSyncForce();
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
