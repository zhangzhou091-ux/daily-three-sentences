// 评分类型
export type ReviewRating = 1 | 2 | 3 | 4;

// 卡片状态枚举
export enum CardState {
  New = 0,
  Learning = 1,
  Review = 2,
  Relearning = 3
}

// 句子接口
export interface Sentence {
  id: string;
  english: string;
  chinese: string;
  addedAt: number;
  lastReviewedAt: number | null;
  nextReviewDate: number | null;
  intervalIndex: number;
  masteryLevel: number;
  timesReviewed: number;
  wrongDictations: number;
  tags: string[];
  updatedAt: number;
  isManual?: boolean;
  stability?: number;
  difficulty?: number;
  reps?: number;
  lapses?: number;
  state?: CardState;
  scheduledDays?: number;
  isPendingFirstReview?: boolean;
  learnedAt?: number;
}

// 默写记录接口
export interface DictationRecord {
  sentenceId: string;
  status: 'correct' | 'wrong';
  timestamp: number;
  isFinished: boolean;
}

// 视图类型
export type ViewType = 'study' | 'manage' | 'achievements' | 'settings';

// 学习步骤类型
export type StudyStep = 'learn' | 'review' | 'dictation';

export type TTSEngine = 'edge' | 'webSpeech';

export interface UserSettings {
  dailyTarget: number;
  dailyLearnTarget: number;
  dailyReviewTarget: number;
  voiceName: 'Kore' | 'Puck' | 'Charon' | 'Zephyr' | 'Fenrir';
  edgeVoice: string;
  webSpeechVoice: string;
  ttsEngine: TTSEngine;
  speechRate: number;
  showChineseFirst: boolean;
  autoPlayAudio: boolean;
  userName: string;
  themeColor: string;
  updatedAt: number;
}

// 用户统计接口
export interface UserStats {
  id?: string;
  streak: number;
  lastLearnDate: string;
  totalPoints: number;
  totalSentences?: number;
  dictationCount: number;
  completionDays: number;
  lastCompletionDate: string;
  updatedAt: number;
  maxStreak?: number;
  breakTimes?: number;
  streakQualified?: number;
  totalDaysLearned?: number;
  totalDictation?: number;
  weekDictationCount?: number;
  maxDailyDictation?: number;
  mobileLearnCount?: number;
  mobileReviewCount?: number;
  mobileDictationCount?: number;
  batchSyncCount?: number;
  avgStability?: number;
  totalLapses?: number;
  shareCount?: number;
}

// 同步配置接口
export interface SyncConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export type {
  QueueWarningData,
  SyncStatus,
  SyncEventData,
  SyncEventType,
  SyncEventPayloads,
  HeatmapSentence,
  QueueTask
} from './global';
