import { Sentence, UserStats, DictationRecord, UserSettings } from '../types';
import { dbService } from './dbService';
import { supabaseService } from './supabaseService';

const STORAGE_KEYS = {
  STATS: 'd3s_user_stats_v3',
  DAILY_SELECTION: 'd3s_daily_selection',
  SETTINGS: 'd3s_settings_v3',
  SYNC_CONFIG: 'd3s_sync_config',
  LAST_SYNC_TIME: 'd3s_last_sync_time' // 新增：存储最后一次全量同步时间，持久化避免刷新丢失
};

/**
 * 艾宾浩斯遗忘曲线科学间隔（单位：天）
 * 0: 新学习, 1: 1天后, 2: 2天后, 3: 4天后, 4: 7天后...
 */
const EBBINGHAUS_INTERVALS = [0, 1, 2, 4, 7, 15, 31, 60, 120, 365];
// 新增：同步节流间隔（手机端设10分钟，避免频繁全量同步）
const SYNC_INTERVAL = 10 * 60 * 1000;

export const storageService = {
  // ==============================================
  // 新增：适配 offlineQueueService 的核心方法（解决 get/save 不存在问题）
  // ==============================================
  /**
   * 从本地存储获取数据（供 offlineQueueService 调用）
   * @param key 存储键名
   * @returns 解析后的对象/数组，无数据返回 null
   */
  get(key: string) {
    try {
      const rawData = localStorage.getItem(key);
      if (!rawData) return null;
      return JSON.parse(rawData);
    } catch (err) {
      if (import.meta.env.DEV) {
        console.error(`❌ 获取本地存储失败 [key: ${key}]`, err);
      }
      return null;
    }
  },

  /**
   * 保存数据到本地存储（供 offlineQueueService 调用）
   * @param key 存储键名
   * @param value 要保存的数据（对象/数组/基本类型）
   */
  save(key: string, value: any) {
    try {
      const stringifiedValue = typeof value === 'string' ? value : JSON.stringify(value);
      localStorage.setItem(key, stringifiedValue);
    } catch (err) {
      if (import.meta.env.DEV) {
        console.error(`❌ 保存本地存储失败 [key: ${key}]`, err);
      }
    }
  },

  // ==============================================
  // 原有逻辑（仅优化 performFullSync 同步节流，其余保留）
  // ==============================================
  // --- 同步逻辑 ---
  initSync: async () => { 
    const config = localStorage.getItem(STORAGE_KEYS.SYNC_CONFIG);
    if (config) {
      const { url, key } = JSON.parse(config);
      const settings = storageService.getSettings();
      const syncResult = await supabaseService.init(url, key, settings.userName);
      if (import.meta.env.DEV) {
        console.log('同步初始化结果：', syncResult);
      }
    }
  },

  performFullSync: async () => {
    if (!supabaseService.isReady) return;
    // 新增：同步节流核心逻辑 - 读取最后同步时间，判断是否超过间隔
    const lastSyncTimeStr = localStorage.getItem(STORAGE_KEYS.LAST_SYNC_TIME);
    const lastSyncTime = lastSyncTimeStr ? Number(lastSyncTimeStr) : 0;
    const now = Date.now();
    // 未到间隔时间，直接跳过全量同步
    if (now - lastSyncTime < SYNC_INTERVAL) {
      if (import.meta.env.DEV) {
        console.log(`🔴 未到同步间隔（${SYNC_INTERVAL/60000}分钟），跳过全量同步`);
      }
      return;
    }

    const local = await dbService.getAll();
    // 同步前先按 addedAt 排序，保证本地数据有序
    const localSorted = local.sort((a, b) => a.addedAt - b.addedAt);
    const synced = await supabaseService.syncSentences(localSorted);
    
    if (synced.sentences.length > local.length) {
      // 同步后的数据先按 addedAt 排序，再保存
      const syncedSorted = synced.sentences.sort((a, b) => a.addedAt - b.addedAt);
      await dbService.putAll(syncedSorted); 
    }
    
    const localStats = storageService.getStats();
    try { 
      const cloudStatsResult = await supabaseService.pullStats(); 
      const cloudStats = cloudStatsResult?.stats; 
      // 优化：兼容 cloudStats 无 updatedAt 字段的情况
      if (cloudStats && cloudStats.lastLearnDate && new Date(cloudStats.lastLearnDate).getTime() > new Date(localStats.lastLearnDate).getTime()) {
        storageService.saveStats(cloudStats, false);
      } else {
        await storageService.saveStats(localStats); 
      }
      // 新增：同步成功后，更新最后同步时间（持久化）
      localStorage.setItem(STORAGE_KEYS.LAST_SYNC_TIME, now.toString());
      if (import.meta.env.DEV) {
        console.log('✅ 全量同步完成，更新最后同步时间');
      }
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn('同步统计数据失败，使用本地数据:', err);
      }
    }
  },

  // --- 基础操作 ---
  // 核心优化：分片加载，先返回前50条避免阻塞渲染，后台加载全量
  getSentences: async (): Promise<Sentence[]> => {
    const allSentences = await dbService.getAll();
    const sortedSentences = allSentences.sort((a, b) => a.addedAt - b.addedAt);
    // 手机端优化：先返回前50条快速渲染，后台异步加载全量并触发事件
    if (sortedSentences.length > 50) {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('sentencesFullLoaded', { 
          detail: sortedSentences 
        }));
        if (import.meta.env.DEV) {
          console.log('✅ 后台加载全量句子完成，触发事件');
        }
      }, 0);
      return sortedSentences.slice(0, 50);
    }
    // 数据量少则直接返回全量
    return sortedSentences;
  },
  
  saveSentences: async (sentences: Sentence[]) => {
    // 保存前先按 addedAt 排序，确保批量保存的顺序正确
    const sortedSentences = sentences.sort((a, b) => a.addedAt - b.addedAt);
    const enriched = sortedSentences.map(s => ({ ...s, updatedAt: Date.now() }));
    await dbService.putAll(enriched);
    if (supabaseService.isReady) supabaseService.syncSentences(enriched);
  },
  
  addSentence: async (sentence: Sentence) => {
    const entry = { ...sentence, updatedAt: Date.now() };
    await dbService.put(entry);
    if (supabaseService.isReady) supabaseService.syncSentences([entry]);
  },
  
  deleteSentence: async (id: string) => {
    await dbService.delete(id);
    if (supabaseService.isReady) {
      const remaining = await dbService.getAll();
      // 删除后同步时也按 addedAt 排序
      const remainingSorted = remaining.sort((a, b) => a.addedAt - b.addedAt);
      supabaseService.syncSentences(remainingSorted);
    }
  },

  getSettings: (): UserSettings => {
    const data = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    const defaultSettings: UserSettings = {
      dailyTarget: 3,
      voiceName: 'Kore',
      showChineseFirst: false,
      autoPlayAudio: true,
      userName: 'English Learner', 
      themeColor: '#f5f5f7',
      updatedAt: Date.now()
    };
    return data ? { ...defaultSettings, ...JSON.parse(data) } : defaultSettings;
  },
  
  saveSettings: (settings: UserSettings) => {
    const updated = { ...settings, updatedAt: Date.now() };
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(updated));
    const syncConfig = localStorage.getItem(STORAGE_KEYS.SYNC_CONFIG);
    if (syncConfig) {
      const { url, key } = JSON.parse(syncConfig);
      supabaseService.init(url, key, updated.userName);
    }
  },
  
  getStats: (): UserStats => {
    const data = localStorage.getItem(STORAGE_KEYS.STATS);
    const defaultStats: UserStats = { 
      id: crypto.randomUUID?.() || `user_${Date.now().toString(36)}`, 
      streak: 0, 
      lastLearnDate: '', 
      totalPoints: 0, 
      dictationCount: 0,
      completionDays: 0,
      lastCompletionDate: '',
      updatedAt: Date.now()
    };
    const parsedStats = data ? JSON.parse(data) : {};
    parsedStats.id = parsedStats.id || defaultStats.id;
    return { ...defaultStats, ...parsedStats };
  },
  
  saveStats: async (stats: UserStats, triggerCloud: boolean = true) => { 
    const updated = { ...stats, updatedAt: Date.now() };
    updated.id = updated.id || crypto.randomUUID?.() || `user_${Date.now().toString(36)}`;
    
    const minimalStats = {
      id: updated.id, 
      streak: updated.streak,
      total_points: updated.totalPoints,       
      updated_at: updated.updatedAt,           
    };

    localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(updated));
    
    if (triggerCloud && supabaseService.isReady) {
      try {
        await supabaseService.pushStats(minimalStats);
        if (import.meta.env.DEV) console.log('✅ 统计数据同步到 Supabase 成功');
      } catch (err) {
        if (import.meta.env.DEV) {
          console.error('❌ 同步失败，本地数据已保存:', err);
        }
      }
    }
  },

  // ==============================================
  // 核心优化：本地优先加载，后台异步拉取云端（解决手机端加载慢）
  // ==============================================
  getTodaySelection: async (): Promise<string[]> => {
    const today = new Date().toISOString().split('T')[0];
    // 核心优化：先读本地数据快速返回，保证页面秒开
    const localData = localStorage.getItem(STORAGE_KEYS.DAILY_SELECTION);
    if (localData) {
      const parsed = JSON.parse(localData);
      if (parsed.date === today && Array.isArray(parsed.ids)) {
        // 云端同步就绪：后台异步拉取，有差异再更新本地，不阻塞页面
        if (supabaseService.isReady) {
          (async () => {
            try {
              const cloudRes = await supabaseService.pullDailySelection(today);
              if (cloudRes.ids && JSON.stringify(cloudRes.ids) !== JSON.stringify(parsed.ids)) {
                // 云端数据不同，更新本地并触发页面更新事件
                storageService.save(STORAGE_KEYS.DAILY_SELECTION, { date: today, ids: cloudRes.ids });
                window.dispatchEvent(new CustomEvent('dailySelectionUpdated', { 
                  detail: cloudRes.ids 
                }));
                if (import.meta.env.DEV) {
                  console.log('✅ 后台拉取云端当日列表，已更新本地');
                }
              }
            } catch (err) {
              if (import.meta.env.DEV) {
                console.warn('❌ 后台拉取云端当日列表失败:', err);
              }
            }
          })();
        }
        // 直接返回本地数据，页面快速渲染
        return parsed.ids;
      }
    }

    // 本地无数据，再拉取云端
    if (supabaseService.isReady) {
      const cloudRes = await supabaseService.pullDailySelection(today);
      if (cloudRes.ids) {
        storageService.save(STORAGE_KEYS.DAILY_SELECTION, { date: today, ids: cloudRes.ids });
        return cloudRes.ids;
      }
    }
    return [];
  },
  
  // ==============================================
  // 原有逻辑：保留不变
  // ==============================================
  saveTodaySelection: async (ids: string[]) => {
    const today = new Date().toISOString().split('T')[0];
    // 先保存到本地
    const saveData = { date: today, ids: ids };
    localStorage.setItem(STORAGE_KEYS.DAILY_SELECTION, JSON.stringify(saveData));
    // 云同步就绪则推送到云端
    if (supabaseService.isReady) {
      await supabaseService.pushDailySelection(today, ids);
    }
  },
  
  getTodayDictations: (): DictationRecord[] => {
    const today = new Date().toISOString().split('T')[0];
    const data = localStorage.getItem(`d3s_dictations_${today}`);
    return data ? JSON.parse(data) : [];
  },
  
  saveTodayDictations: (records: DictationRecord[]) => {
    const today = new Date().toISOString().split('T')[0];
    localStorage.setItem(`d3s_dictations_${today}`, JSON.stringify(records));
  },

  /**
   * 核心复习算法：艾宾浩斯科学排程
   */
  calculateNextReview: (
    currentIntervalIndex: number, 
    feedback: 'easy' | 'hard' | 'forgot',
    timesReviewed: number = 0
  ): { nextIndex: number, nextDate: number | null } => {
    let nextIndex = currentIntervalIndex;

    switch (feedback) {
      case 'easy':
        nextIndex = Math.min(EBBINGHAUS_INTERVALS.length - 1, currentIntervalIndex + 1);
        break;
      case 'hard':
        nextIndex = Math.max(1, currentIntervalIndex);
        break;
      case 'forgot':
        nextIndex = Math.max(1, Math.floor(currentIntervalIndex / 2));
        break;
    }

    if (nextIndex >= EBBINGHAUS_INTERVALS.length - 1 && feedback === 'easy') {
      return { nextIndex, nextDate: null };
    }

    const days = EBBINGHAUS_INTERVALS[nextIndex];
    const date = new Date();
    date.setHours(0, 0, 0, 0); 
    const nextDate = date.getTime() + days * 24 * 60 * 60 * 1000;

    return { nextIndex, nextDate };
  },

  resetSettings: () => localStorage.removeItem(STORAGE_KEYS.SETTINGS),
  
  clearVocabulary: async () => {
    await dbService.clear();
    localStorage.removeItem(STORAGE_KEYS.DAILY_SELECTION);
    // 新增：清除同步时间，下次打开强制同步
    localStorage.removeItem(STORAGE_KEYS.LAST_SYNC_TIME);
    if (supabaseService.isReady) {
      supabaseService.syncSentences([]);
    }
  },
  
  clearAllData: async () => {
    await dbService.clear();
    localStorage.clear();
    supabaseService.clearConfig();
    window.location.reload();
  }
};