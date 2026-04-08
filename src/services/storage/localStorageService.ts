import { Sentence, UserStats, DictationRecord, UserSettings } from '../../types';
import { DEFAULT_USER_SETTINGS } from '../../constants';
import { smartSyncService } from '../smartSyncService';
import { indexedDBService } from '../indexedDBService';
import { syncQueueService } from '../syncQueueService';
import { getLocalDateString } from '../../utils/date';

const STORAGE_KEYS = {
  STATS: 'd3s_user_stats_v3',
  DAILY_SELECTION: 'd3s_daily_selection',
  SETTINGS: 'd3s_settings_v3',
  SYNC_CONFIG: 'd3s_sync_config',
  LAST_SYNC_TIME: 'd3s_last_sync_time'
};

const STATS_LOCK_NAME = 'd3s_stats_lock';
const STATS_LOCK_TIMEOUT = 5000;
let statsFallbackPromise = Promise.resolve();
const FIXED_DAILY_LEARN_TARGET = DEFAULT_USER_SETTINGS.dailyLearnTarget;

let cachedStorageUsage: { used: number; timestamp: number } | null = null;
const CACHE_TTL = 5000;

function normalizeUserSettings(settings?: Partial<UserSettings> | null): UserSettings {
  return {
    ...DEFAULT_USER_SETTINGS,
    userName: 'English Learner',
    themeColor: '#f5f5f7',
    ...settings,
    dailyLearnTarget: FIXED_DAILY_LEARN_TARGET
  };
}

export const localStorageService = {
  /**
   * 从本地存储获取数据
   * @param key 存储键名
   * @returns 解析后的对象/数组，无数据返回 null
   */
  get<T = unknown>(key: string): T | null {
    try {
      const rawData = localStorage.getItem(key);
      if (!rawData) return null;
      return JSON.parse(rawData) as T;
    } catch (err) {
      if (import.meta.env.DEV) {
        console.error(`❌ 获取本地存储失败 [key: ${key}]`, err);
      }
      return null;
    }
  },

  /**
   * 保存数据到本地存储（增强版）
   * @param key 存储键名
   * @param value 要保存的数据（对象/数组/基本类型）
   * @returns 是否保存成功
   */
  save(key: string, value: unknown): boolean {
    const stringifiedValue = typeof value === 'string' ? value : JSON.stringify(value);

    const dataSize = new Blob([stringifiedValue]).size;
    if (dataSize > 2 * 1024 * 1024) {
      console.warn(`⚠️ 存储数据过大 (${(dataSize / 1024).toFixed(2)}KB): ${key}`);
      
      // 大体积数据建议使用 IndexedDB
      if (key.startsWith('d3s_dictations_')) {
        this.suggestIndexedDBMigration(key, value);
      }
    }

    try {
      localStorage.setItem(key, stringifiedValue);
      return true;
    } catch (err: unknown) {
      if (import.meta.env.DEV) {
        console.error(`❌ 保存本地存储失败 [key: ${key}]`, err instanceof Error ? err.message : err);
      }

      if (err instanceof Error && (err.name === 'QuotaExceededError' || err.message.includes('QuotaExceeded'))) {
        const requiredSize = new Blob([stringifiedValue]).size;
        const cleanupSuccess = this.intelligentCleanup(requiredSize);
        
        if (cleanupSuccess) {
          try {
            localStorage.setItem(key, stringifiedValue);
            if (import.meta.env.DEV) {
              console.log(`✅ 智能清理后保存成功 [key: ${key}]`);
            }
            
            this.triggerDataMigration();
            return true;
          } catch (retryErr) {
            console.error(`❌ 智能清理后仍无法保存 [key: ${key}]`);
          }
        }
        
        this.showStorageFullWarning(key, value);
        return false;
      }
      
      return false;
    }
  },

  /**
   * 智能清理：分级清理策略（先清缓存，保核心数据）
   */
  intelligentCleanup(requiredSize?: number): boolean {
    const targetSize = requiredSize || 100 * 1024;
    
    if (targetSize > 1024 * 1024) {
      console.warn('数据超过 1MB，建议迁移到 IndexedDB');
      this.suggestIndexedDBMigration('large_data', { size: targetSize });
    }
    
    try {
      this.cleanTempData();
      if (this.hasEnoughSpace(targetSize)) return true;
      
      this.cleanOldDictations(14);
      if (this.hasEnoughSpace(targetSize)) return true;
      
      this.cleanNonEssentialStats();
      if (this.hasEnoughSpace(targetSize)) return true;
      
      this.cleanOldDictations(7);
      if (this.hasEnoughSpace(targetSize)) return true;
      
      return this.cleanOldestLearningData(targetSize);
      
    } catch (error) {
      console.error('智能清理失败:', error);
      return false;
    }
  },

  /**
   * 紧急清理：释放存储空间（兼容旧版本）
   */
  emergencyCleanup(): boolean {
    return this.intelligentCleanup();
  },

  /**
   * 分级清理方法
   */
  cleanTempData(): void {
    // 清理sessionStorage和临时缓存
    const tempKeys = Object.keys(localStorage).filter(k => 
      k.includes('temp_') || k.includes('cache_') || k.includes('session_')
    );
    tempKeys.forEach(k => localStorage.removeItem(k));
  },

  cleanOldDictations(daysToKeep: number): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('d3s_dictations_')) {
        const dateMatch = key.match(/d3s_dictations_(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const recordDate = new Date(dateMatch[1]);
          if (recordDate < cutoffDate) {
            localStorage.removeItem(key);
          }
        }
      }
    });
  },

  cleanNonEssentialStats(): boolean {
    const stats = this.getStats();

    const essentialStats: UserStats = {
      ...stats,
      updatedAt: Date.now()
    };

    return this.saveStats(essentialStats);
  },

  cleanOldestLearningData(requiredSize?: number): boolean {
    const syncStatus = syncQueueService.getQueueStatus();
    if (syncStatus.pendingCount > 0) {
      console.warn('[Storage] 检测到待同步数据，跳过清理以保护未同步内容');
      return false;
    }

    const PROTECTED_PREFIXES = [
      'd3s_user_stats',
      'd3s_settings',
      'sync_queue_',
      'd3s_sync_config',
      'd3s_last_sync_time',
      'd3s_daily_selection'
    ];

    const targetSize = requiredSize || 100 * 1024;
    const allKeys = Object.keys(localStorage);
    const learningKeys = allKeys.filter(k => {
      if (!k.startsWith('d3s_')) return false;
      
      const isProtected = PROTECTED_PREFIXES.some(prefix => k.startsWith(prefix));
      if (isProtected) return false;
      
      return true;
    });
    
    learningKeys.sort((a, b) => {
      const timeA = this.extractTimestamp(a);
      const timeB = this.extractTimestamp(b);
      return timeA - timeB;
    });

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const candidateKeys: string[] = [];
    const protectedKeys: string[] = [];
    
    for (const key of learningKeys) {
      const timestamp = this.extractTimestamp(key);
      if (timestamp > 0 && timestamp < thirtyDaysAgo) {
        candidateKeys.push(key);
      } else {
        protectedKeys.push(key);
      }
    }
    
    let removed = 0;
    for (const key of candidateKeys) {
      if (this.hasEnoughSpace(targetSize)) {
        break;
      }
      localStorage.removeItem(key);
      removed++;
    }
    
    if (!this.hasEnoughSpace(targetSize)) {
      if (protectedKeys.length > 0) {
        console.warn('[Storage] 候选集清理后空间仍不足，近期数据受保护无法清理');
      }
      console.warn('[Storage] 存储空间不足，建议手动清理或同步数据');
    }
    
    if (removed > 0) {
      console.log(`[Storage] 清理了 ${removed} 条已同步的旧学习数据以释放空间`);
    }
    
    return this.hasEnoughSpace(targetSize);
  },

  extractTimestamp(key: string): number {
    // 从key中提取时间戳的简单实现
    const match = key.match(/\d+/);
    return match ? parseInt(match[0]) : 0;
  },

  hasEnoughSpace(requiredBytes: number = 100 * 1024): boolean {
    const usage = this.getStorageUsage();
    return usage.available >= requiredBytes;
  },

  getStorageUsage(): { used: number; available: number; percentage: number } {
    const now = Date.now();
    if (cachedStorageUsage && now - cachedStorageUsage.timestamp < CACHE_TTL) {
      const estimatedTotal = 5 * 1024 * 1024;
      return {
        used: cachedStorageUsage.used,
        available: estimatedTotal - cachedStorageUsage.used,
        percentage: (cachedStorageUsage.used / estimatedTotal) * 100
      };
    }

    let used = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        const value = localStorage.getItem(key);
        used += (key.length + (value ? value.length : 0)) * 2;
      }
    }
    
    cachedStorageUsage = { used, timestamp: now };
    
    const estimatedTotal = 5 * 1024 * 1024;
    return {
      used,
      available: estimatedTotal - used,
      percentage: (used / estimatedTotal) * 100
    };
  },

  invalidateStorageCache(): void {
    cachedStorageUsage = null;
  },

  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch (err) {
      if (import.meta.env.DEV) {
        console.error(`❌ 删除本地存储失败 [key: ${key}]`, err);
      }
    }
  },

  /**
   * 获取用户设置
   */
  getSettings(): UserSettings {
    const data = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    const parsedSettings = data ? JSON.parse(data) : null;
    return normalizeUserSettings(parsedSettings);
  },

  /**
   * 保存用户设置
   * @returns 是否保存成功
   */
  saveSettings(settings: UserSettings): boolean {
    const updated = normalizeUserSettings({
      ...settings,
      updatedAt: Date.now()
    });
    const success = this.save(STORAGE_KEYS.SETTINGS, updated);
    if (success) {
      window.dispatchEvent(new CustomEvent<UserSettings>('settingsChanged', { detail: updated }));
    }
    return success;
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
   * @returns 是否保存成功
   */
  saveStats(stats: UserStats): boolean {
    const updated = { ...stats, updatedAt: Date.now() };
    updated.id = updated.id || crypto.randomUUID?.() || String(Date.now());
    const success = this.save(STORAGE_KEYS.STATS, updated);
    if (success) {
      smartSyncService.broadcastStatsUpdate(updated);
    }
    return success;
  },

  /**
   * 安全更新统计数据（使用 Web Locks API 防止跨标签页并发覆盖）
   * @param updater 更新函数，接收当前统计数据，返回更新后的数据
   * @throws 当存储空间不足时抛出错误
   */
  async updateStatsSafely(updater: (stats: UserStats) => UserStats | Promise<UserStats>, triggerCloud: boolean = true): Promise<void> {
    const doUpdate = async () => {
      const currentStats = this.getStats();
      const updatedStats = await updater(currentStats);
      const success = this.saveStats(updatedStats);
      if (!success) {
        throw new Error('STORAGE_WRITE_FAILED');
      }
    };

    if (navigator.locks && navigator.locks.request) {
      try {
        await navigator.locks.request(STATS_LOCK_NAME, async () => {
          await doUpdate();
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'STORAGE_WRITE_FAILED') {
          throw err;
        }
        statsFallbackPromise = statsFallbackPromise.then(doUpdate).catch(() => {});
        await statsFallbackPromise;
      }
    } else {
      statsFallbackPromise = statsFallbackPromise.then(doUpdate).catch(() => {});
      await statsFallbackPromise;
    }
  },

  /**
   * 获取今日选择的句子ID列表
   */
  getTodaySelection(): { date: string; ids: string[] } | null {
    const today = getLocalDateString();
    const data = localStorage.getItem(`${STORAGE_KEYS.DAILY_SELECTION}_${today}`);
    if (!data) {
      const legacyData = localStorage.getItem(STORAGE_KEYS.DAILY_SELECTION);
      if (legacyData) {
        try {
          const parsed = JSON.parse(legacyData);
          if (parsed.date === today && Array.isArray(parsed.ids)) {
            localStorage.setItem(`${STORAGE_KEYS.DAILY_SELECTION}_${today}`, JSON.stringify(parsed.ids));
            return parsed;
          }
        } catch {
          // ignore
        }
      }
      return null;
    }
    try {
      const ids = JSON.parse(data);
      if (Array.isArray(ids)) {
        return { date: today, ids };
      }
    } catch {
      // ignore
    }
    return null;
  },

  getSelectionByDate(date: string): string[] {
    const data = localStorage.getItem(`${STORAGE_KEYS.DAILY_SELECTION}_${date}`);
    if (!data) {
      const legacyData = localStorage.getItem(STORAGE_KEYS.DAILY_SELECTION);
      if (legacyData) {
        try {
          const parsed = JSON.parse(legacyData);
          if (parsed.date === date && Array.isArray(parsed.ids)) {
            return parsed.ids;
          }
        } catch {
          // ignore
        }
      }
      return [];
    }
    try {
      const ids = JSON.parse(data);
      if (Array.isArray(ids)) {
        return ids;
      }
    } catch {
      // ignore
    }
    return [];
  },

  saveTodaySelection(ids: string[]) {
    const today = getLocalDateString();
    localStorage.setItem(`${STORAGE_KEYS.DAILY_SELECTION}_${today}`, JSON.stringify(ids));
    localStorage.setItem(STORAGE_KEYS.DAILY_SELECTION, JSON.stringify({ date: today, ids: ids }));
  },

  /**
   * UI警告相关方法
   */
  showStorageFullWarning(key: string, value: unknown): void {
    const warningData = {
      type: 'storageFull',
      message: '您的本地存储空间已满，本次学习记录无法保存。请前往设置页导出备份并清理旧数据！',
      details: {
        key,
        dataSize: new Blob([JSON.stringify(value)]).size
      }
    };
    
    window.dispatchEvent(new CustomEvent('d3s:storage_warning', { detail: warningData }));
  },

  suggestIndexedDBMigration(key: string, value: unknown): void {
    const suggestionData = {
      type: 'migrationSuggestion',
      message: '检测到大体积数据，建议迁移到更安全的存储空间以获得更好的体验',
      details: {
        key,
        dataSize: new Blob([JSON.stringify(value)]).size
      }
    };
    
    window.dispatchEvent(new CustomEvent('d3s:storage_warning', { detail: suggestionData }));
  },

  async triggerDataMigration(): Promise<void> {
    try {
      // 检查是否需要迁移
      const health = await indexedDBService.checkStorageHealth();
      if (!health.isHealthy) {
        const migrated = await indexedDBService.migrateLargeData();
        if (migrated.migrated > 0) {
          console.log(`✅ 自动迁移了 ${migrated.migrated} 条数据到 IndexedDB`);
        }
      }
    } catch (error) {
      console.warn('数据迁移触发失败:', error);
    }
  },

  /**
   * 初始化存储健康检查
   */
  async initStorageHealthCheck(): Promise<void> {
    try {
      await indexedDBService.init();
      
      // 启动时检查存储健康
      const health = await indexedDBService.checkStorageHealth();
      if (!health.isHealthy) {
        this.showStorageFullWarning('system', { message: '存储空间紧张' });
      }
      
      // 自动迁移大体积数据
      setTimeout(() => {
        this.triggerDataMigration();
      }, 3000); // 延迟3秒执行
      
    } catch (error) {
      console.warn('存储健康检查初始化失败:', error);
    }
  },

  getTodayDictations(): DictationRecord[] {
    const today = getLocalDateString();
    const data = localStorage.getItem(`d3s_dictations_${today}`);
    return data ? JSON.parse(data) : [];
  },

  saveTodayDictations(records: DictationRecord[]) {
    const today = getLocalDateString();
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
  startPeriodicCleanup(): () => void {
    const WEEKLY_INTERVAL = 7 * 24 * 60 * 60 * 1000;
    
    this.cleanupOldDictationRecords();
    
    const intervalId = setInterval(() => {
      this.cleanupOldDictationRecords();
      if (import.meta.env.DEV) {
        console.log('🔄 执行定期默写记录清理');
      }
    }, WEEKLY_INTERVAL);
    
    return () => clearInterval(intervalId);
  },

  /**
   * 清除所有数据
   */
  clearAll() {
    localStorage.clear();
  },

  getYesterdayLearnedCount(): number {
    const yesterday = getLocalDateString(Date.now() - 86400000);
    const data = localStorage.getItem(`d3s_learned_count_${yesterday}`);
    return data ? parseInt(data, 10) : 0;
  },

  saveTodayLearnedCount(count: number): void {
    const today = getLocalDateString();
    localStorage.setItem(`d3s_learned_count_${today}`, count.toString());
  },

  getTodayLearnedCount(): number {
    const today = getLocalDateString();
    const data = localStorage.getItem(`d3s_learned_count_${today}`);
    return data ? parseInt(data, 10) : 0;
  },

  incrementTodayLearnedCount(): number {
    const today = getLocalDateString();
    const currentCount = this.getTodayLearnedCount();
    const newCount = currentCount + 1;
    localStorage.setItem(`d3s_learned_count_${today}`, newCount.toString());
    return newCount;
  }
};
