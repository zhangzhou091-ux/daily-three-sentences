
import { Sentence, UserStats, DictationRecord, UserSettings } from '../types';
import { dbService } from './dbService';
import { supabaseService } from './supabaseService';

const STORAGE_KEYS = {
  STATS: 'd3s_user_stats_v3',
  DAILY_SELECTION: 'd3s_daily_selection',
  SETTINGS: 'd3s_settings_v3',
  SYNC_CONFIG: 'd3s_sync_config'
};

/**
 * 艾宾浩斯遗忘曲线科学间隔（单位：天）
 * 0: 新学习, 1: 1天后, 2: 2天后, 3: 4天后, 4: 7天后...
 */
const EBBINGHAUS_INTERVALS = [0, 1, 2, 4, 7, 15, 31, 60, 120, 365];

export const storageService = {
  // --- 同步逻辑 ---
  initSync: () => {
    const config = localStorage.getItem(STORAGE_KEYS.SYNC_CONFIG);
    if (config) {
      const { url, key } = JSON.parse(config);
      supabaseService.init(url, key);
    }
  },

  performFullSync: async () => {
    if (!supabaseService.isReady) return;
    const local = await dbService.getAll();
    const synced = await supabaseService.syncSentences(local);
    if (synced.length > local.length || true) {
      await dbService.putAll(synced);
    }
    
    const localStats = storageService.getStats();
    const cloudStats = await supabaseService.pullStats();
    if (cloudStats && cloudStats.updatedAt > localStats.updatedAt) {
      storageService.saveStats(cloudStats, false);
    } else {
      await supabaseService.pushStats(localStats);
    }
  },

  // --- 基础操作 ---
  getSentences: async (): Promise<Sentence[]> => {
    return await dbService.getAll();
  },
  saveSentences: async (sentences: Sentence[]) => {
    const enriched = sentences.map(s => ({ ...s, updatedAt: Date.now() }));
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
  },
  getStats: (): UserStats => {
    const data = localStorage.getItem(STORAGE_KEYS.STATS);
    const defaultStats: UserStats = { 
      streak: 0, 
      lastLearnDate: '', 
      totalPoints: 0, 
      dictationCount: 0,
      completionDays: 0,
      lastCompletionDate: '',
      updatedAt: Date.now()
    };
    return data ? { ...defaultStats, ...JSON.parse(data) } : defaultStats;
  },
  saveStats: (stats: UserStats, triggerCloud: boolean = true) => {
    const updated = { ...stats, updatedAt: Date.now() };
    localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(updated));
    if (triggerCloud && supabaseService.isReady) {
      supabaseService.pushStats(updated);
    }
  },

  getTodaySelection: (): string[] => {
    const today = new Date().toISOString().split('T')[0];
    const data = localStorage.getItem(STORAGE_KEYS.DAILY_SELECTION);
    if (data) {
      const parsed = JSON.parse(data);
      if (parsed.date === today) return parsed.ids;
    }
    return [];
  },
  saveTodaySelection: (ids: string[]) => {
    const today = new Date().toISOString().split('T')[0];
    localStorage.setItem(STORAGE_KEYS.DAILY_SELECTION, JSON.stringify({ date: today, ids }));
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
        // 表现优秀，进入下一个更长的记忆周期
        nextIndex = Math.min(EBBINGHAUS_INTERVALS.length - 1, currentIntervalIndex + 1);
        break;
      case 'hard':
        // 勉强记得，保持当前周期阶段重新计算
        nextIndex = Math.max(1, currentIntervalIndex);
        break;
      case 'forgot':
        // 已遗忘，记忆衰减，回退到早前的复习阶段（回退一半）
        nextIndex = Math.max(1, Math.floor(currentIntervalIndex / 2));
        break;
    }

    // 如果已经达到最大复习间隔（365天），标记为完全掌握，不再安排自动复习
    if (nextIndex >= EBBINGHAUS_INTERVALS.length - 1 && feedback === 'easy') {
      return { nextIndex, nextDate: null };
    }

    const days = EBBINGHAUS_INTERVALS[nextIndex];
    const date = new Date();
    date.setHours(0, 0, 0, 0); // 从今日凌晨开始计算
    const nextDate = date.getTime() + days * 24 * 60 * 60 * 1000;

    return { nextIndex, nextDate };
  },

  resetSettings: () => localStorage.removeItem(STORAGE_KEYS.SETTINGS),
  clearVocabulary: async () => {
    await dbService.clear();
    localStorage.removeItem(STORAGE_KEYS.DAILY_SELECTION);
  },
  clearAllData: async () => {
    await dbService.clear();
    localStorage.clear();
    window.location.reload();
  }
};
