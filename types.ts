
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
  updatedAt: number; // 用于云端同步冲突处理
  isManual?: boolean; // 标记是否为手动录入
}

export interface DictationRecord {
  sentenceId: string;
  status: 'correct' | 'wrong';
  timestamp: number;
  isFinished: boolean;
}

export type ViewType = 'study' | 'manage' | 'achievements' | 'settings';
export type StudyStep = 'learn' | 'review' | 'dictation';

export interface UserSettings {
  dailyTarget: number;
  voiceName: 'Kore' | 'Puck' | 'Charon' | 'Zephyr' | 'Fenrir';
  showChineseFirst: boolean;
  autoPlayAudio: boolean;
  userName: string;
  themeColor: string;
  updatedAt: number;
}

export interface UserStats {
  streak: number;
  lastLearnDate: string;
  totalPoints: number;
  dictationCount: number;
  completionDays: number;
  lastCompletionDate: string;
  updatedAt: number;
}

export interface SyncConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}
