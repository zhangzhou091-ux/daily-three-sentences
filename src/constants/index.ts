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
  VERSION: 6,
  STORAGE_KEY: 'fsrs_parameters_v6'
};

// FSRS-6 默认参数（21个参数）
export const FSRS_DEFAULT_PARAMS = {
  w: [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 
      1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 
      1.8729, 0.5425, 0.0912, 0.0658, 0.1542],
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

export const getNetworkCheckUrls = (): string[] => {
  const urls: string[] = [];
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  
  if (supabaseUrl) {
    try {
      const url = new URL(supabaseUrl);
      urls.push(`${url.origin}/rest/v1/`);
    } catch {
      // URL 解析失败，跳过
    }
  }
  
  urls.push(
    'https://cdn.bootcdn.net/ajax/libs/vue/3.3.4/vue.global.prod.min.js',
    'https://registry.npmmirror.com/@vue/core',
    'https://cdn.staticfile.org/jquery/3.6.0/jquery.min.js'
  );
  
  return urls;
};

export const NETWORK_CONFIG = {
  get CONNECTIVITY_CHECK_URLS() {
    return getNetworkCheckUrls();
  },
  CONNECTIVITY_TIMEOUT: 5000,
  CHECK_INTERVAL: 60000
};

// Supabase 配置 - 从环境变量读取，避免敏感信息泄露
export const getSupabaseConfig = () => ({
  TIMEOUT: 30000,
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  URL: import.meta.env.VITE_SUPABASE_URL || '',
  ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY || ''
});

// 兼容性导出（保持现有代码不变）
export const SUPABASE_CONFIG = getSupabaseConfig();

// 每日目标默认值
export const DEFAULT_DAILY_TARGETS = {
  LEARN: 3,
  REVIEW: 10
};

// 固定每日学习数量（不可配置）
export const DAILY_LEARN_LIMIT = 3;

// 用户设置默认值
export const DEFAULT_USER_SETTINGS = {
  dailyTarget: 3,
  dailyLearnTarget: 3,
  dailyReviewTarget: 10,
  voiceName: 'Kore' as const,
  edgeVoice: 'en-US-AvaMultilingualNeural',
  webSpeechVoice: '',
  ttsEngine: 'edge' as const,
  speechRate: 1,
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

// 复习时间配置
export const NEXT_DAY_START_HOUR = 4;

export const getNextReviewDate = (): number => {
  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + 1);
  nextDate.setHours(NEXT_DAY_START_HOUR, 0, 0, 0);
  return nextDate.getTime();
};
