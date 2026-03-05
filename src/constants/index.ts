/**
 * 常量定义
 * 集中管理所有应用常量
 */

// 数据库配置
export const DB_CONFIG = {
  VERSION: 5,
  NAME: 'D3S_Database',
  STORE_NAME: 'sentences'
};

// 经验值配置
export const XP_CONFIG = {
  LEARN: 10,
  REVIEW: {
    again: 5,
    hard: 8,
    good: 10,
    easy: 15
  },
  DICTATION: {
    correct: 20,
    wrong: 5
  }
};

// 同步配置
export const SYNC_CONFIG = {
  MESSAGE_DURATION: 3000,
  DEBOUNCE_DELAY: 2000,
  RETRY_COUNT: 3,
  RETRY_DELAY: 1000,
  QUEUE_LIMITS: {
    markLearned: 1000,
    reviewFeedback: 1000,
    addSentence: 500,
    dictationRecord: 500,
    statsSync: 100
  },
  QUEUE_WARN_THRESHOLD: 0.8,
  BATCH_SIZE: 50,
  CONCURRENT_LIMIT: 5
};

// FSRS 参数配置
export const FSRS_CONFIG = {
  VERSION: 1,
  STORAGE_KEY: 'fsrs_parameters_v1'
};

// FSRS 默认参数
export const FSRS_DEFAULT_PARAMS = {
  w: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],
  requestRetention: 0.9,
  maximumInterval: 36500,
  easyBonus: 1.3,
  hardInterval: 1.2
};

// 存储键名
export const STORAGE_KEYS = {
  SENTENCES: 'sentences',
  STATS: 'userStats',
  SETTINGS: 'userSettings',
  TODAY_SELECTION: 'todaySelection',
  TODAY_DICTATIONS: 'todayDictations',
  FSRS_PARAMS: 'fsrs_parameters',
  SYNC_QUEUE_PREFIX: 'sync_queue_',
  STATS_V3: 'd3s_user_stats_v3',
  DAILY_SELECTION: 'd3s_daily_selection',
  SETTINGS_V3: 'd3s_settings_v3',
  SYNC_CONFIG: 'd3s_sync_config',
  LAST_SYNC_TIME: 'd3s_last_sync_time'
};

// 设备检测
export const DEVICE_CONFIG = {
  MOBILE_MAX_WIDTH: 768,
  TABLET_MAX_WIDTH: 1024
};

// ✅ 优化：网络检测使用更可靠的国内可访问URL
export const NETWORK_CONFIG = {
  CONNECTIVITY_CHECK_URLS: [
    'https://www.baidu.com/favicon.ico',      // 百度（国内首选）
    'https://www.cloudflare.com/favicon.ico',  // Cloudflare（全球CDN）
    'https://cdn.jsdelivr.net/npm/@vue/core/dist/vue.global.js', // jsDelivr（国内可访问）
    'https://cdn.staticfile.org/jquery/3.6.0/jquery.min.js'      // 静态文件库（国内可访问）
  ],
  CONNECTIVITY_TIMEOUT: 3000,  // 缩短超时时间
  CHECK_INTERVAL: 60000        // 延长检测间隔，减少不必要的请求
};

// Supabase 配置
export const SUPABASE_CONFIG = {
  TIMEOUT: 30000,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  URL: import.meta.env.VITE_SUPABASE_URL || '',
  KEY: import.meta.env.VITE_SUPABASE_ANON_KEY || ''
};

// 每日目标默认值
export const DEFAULT_DAILY_TARGETS = {
  LEARN: 3,
  REVIEW: 10
};

// 用户设置默认值
export const DEFAULT_USER_SETTINGS = {
  dailyTarget: 3,
  dailyLearnTarget: 3,
  dailyReviewTarget: 10,
  voiceName: 'Kore' as const,
  showChineseFirst: false,
  autoPlayAudio: true,
  userName: '',
  themeColor: '#3b82f6',
  updatedAt: Date.now()
};

// 学习奖励
export const LEARN_XP = 15;
export const DICTATION_XP = 20;
export const LEARNED_ANIMATION_DELAY = 800;
export const MAX_REVIEW_LEVEL = 10;

// 复习奖励映射
export const REVIEW_XP: Record<number, number> = { 1: 5, 2: 10, 3: 15, 4: 20 };

// 同步间隔（10分钟）
export const SYNC_INTERVAL = 10 * 60 * 1000;

// 队列警告阈值
export const QUEUE_WARN_THRESHOLD = 0.8;

// FSRS 评分枚举
export enum Rating {
  Again = 1,
  Hard = 2,
  Good = 3,
  Easy = 4
}

// FSRS 状态枚举
export enum State {
  New = 0,
  Learning = 1,
  Review = 2,
  Relearning = 3
}
