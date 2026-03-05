import { Sentence, UserStats, DictationRecord, UserSettings } from '../../types';
import { DEFAULT_USER_SETTINGS } from '../../constants';

const STORAGE_KEYS = {
  STATS: 'd3s_user_stats_v3',
  DAILY_SELECTION: 'd3s_daily_selection',
  SETTINGS: 'd3s_settings_v3',
  SYNC_CONFIG: 'd3s_sync_config',
  LAST_SYNC_TIME: 'd3s_last_sync_time'
};

export const localStorageService = {
  /**
   * 从本地存储获取数据
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
   * 保存数据到本地存储
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
      try {
        const keysToClear = Object.keys(localStorage).filter(k => k.startsWith('d3s_') && !k.endsWith('_v3'));
        keysToClear.forEach(k => localStorage.removeItem(k));
        
        const stringifiedValue = typeof value === 'string' ? value : JSON.stringify(value);
        localStorage.setItem(key, stringifiedValue);
        if (import.meta.env.DEV) {
          console.log(`✅ 本地存储清理后重试成功 [key: ${key}]`);
        }
      } catch (retryErr: any) {
        console.error(`❌ 本地存储清理后重试失败 [key: ${key}]`, retryErr);
      }
    }
  },

  /**
   * 获取用户设置
   */
  getSettings(): UserSettings {
    const data = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    const defaultSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      userName: 'English Learner',
      themeColor: '#f5f5f7'
    };
    return data ? { ...defaultSettings, ...JSON.parse(data) } : defaultSettings;
  },

  /**
   * 保存用户设置
   */
  saveSettings(settings: UserSettings) {
    const updated = { ...settings, updatedAt: Date.now() };
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(updated));
  },

  /**
   * 获取用户统计
   */
  getStats(): UserStats {
    const data = localStorage.getItem(STORAGE_KEYS.STATS);
    const defaultStats: UserStats = {
      id: crypto.randomUUID(),
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

  /**
   * 保存用户统计
   */
  saveStats(stats: UserStats) {
    const updated = { ...stats, updatedAt: Date.now() };
    updated.id = updated.id || crypto.randomUUID();
    localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(updated));
  },

  /**
   * 获取今日选择的句子ID列表
   */
  getTodaySelection(): { date: string; ids: string[] } | null {
    const data = localStorage.getItem(STORAGE_KEYS.DAILY_SELECTION);
    if (!data) return null;
    const parsed = JSON.parse(data);
    if (parsed.date && Array.isArray(parsed.ids)) {
      return parsed;
    }
    return null;
  },

  /**
   * 保存今日选择的句子ID列表
   */
  saveTodaySelection(ids: string[]) {
    const today = new Date().toISOString().split('T')[0];
    const saveData = { date: today, ids: ids };
    localStorage.setItem(STORAGE_KEYS.DAILY_SELECTION, JSON.stringify(saveData));
  },

  /**
   * 获取今日默写记录
   */
  getTodayDictations(): DictationRecord[] {
    const today = new Date().toISOString().split('T')[0];
    const data = localStorage.getItem(`d3s_dictations_${today}`);
    return data ? JSON.parse(data) : [];
  },

  /**
   * 保存今日默写记录
   */
  saveTodayDictations(records: DictationRecord[]) {
    const today = new Date().toISOString().split('T')[0];
    localStorage.setItem(`d3s_dictations_${today}`, JSON.stringify(records));
  },

  /**
   * 获取最后同步时间
   */
  getLastSyncTime(): number | null {
    const data = localStorage.getItem(STORAGE_KEYS.LAST_SYNC_TIME);
    return data ? Number(data) : null;
  },

  /**
   * 保存最后同步时间
   */
  saveLastSyncTime(time: number) {
    localStorage.setItem(STORAGE_KEYS.LAST_SYNC_TIME, time.toString());
  },

  /**
   * 清理过期的默写记录（超过30天）
   */
  cleanupOldDictationRecords() {
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const MAX_FILE_SIZE = 1024 * 1024; // 1MB

    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('d3s_dictations_')) {
        try {
          const records: DictationRecord[] = JSON.parse(localStorage.getItem(key) || '[]');
          
          // 1. 过滤过期记录
          const validRecords = records.filter(record => {
            const recordDate = new Date(record.timestamp);
            return recordDate >= thirtyDaysAgo;
          });

          if (validRecords.length === 0) {
            localStorage.removeItem(key);
          } else {
            // 2. 检查文件大小
            const recordsString = JSON.stringify(validRecords);
            const fileSize = new Blob([recordsString]).size;
            
            if (fileSize > MAX_FILE_SIZE) {
              // 如果超过大小限制，只保留最近的记录
              const sortedRecords = validRecords.sort((a, b) => 
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
              );
              // 估算保留多少记录
              let trimmedRecords = sortedRecords;
              let trimmedSize = fileSize;
              
              while (trimmedSize > MAX_FILE_SIZE && trimmedRecords.length > 0) {
                trimmedRecords = trimmedRecords.slice(0, trimmedRecords.length - 1);
                trimmedSize = new Blob([JSON.stringify(trimmedRecords)]).size;
              }
              
              localStorage.setItem(key, JSON.stringify(trimmedRecords));
            } else if (validRecords.length !== records.length) {
              localStorage.setItem(key, JSON.stringify(validRecords));
            }
          }
        } catch {
          // 忽略解析错误，删除损坏的记录
          localStorage.removeItem(key);
        }
      }
    });
  },

  /**
   * 启动定期清理任务（每周一次）
   */
  startPeriodicCleanup() {
    // 每周清理一次
    const WEEKLY_INTERVAL = 7 * 24 * 60 * 60 * 1000;
    
    // 立即执行一次清理
    this.cleanupOldDictationRecords();
    
    // 设置定期清理
    setInterval(() => {
      this.cleanupOldDictationRecords();
      if (import.meta.env.DEV) {
        console.log('🔄 执行定期默写记录清理');
      }
    }, WEEKLY_INTERVAL);
  },

  /**
   * 清除所有数据
   */
  clearAll() {
    localStorage.clear();
  }
};
