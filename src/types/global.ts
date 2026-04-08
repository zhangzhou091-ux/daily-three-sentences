import { UserSettings, UserStats, Sentence } from './index';

export interface QueueWarningData {
  level: 'safe' | 'warning' | 'critical' | 'circuit_breaker';
  count: number;
  storageBytes: number;
  message: string;
}

export interface SyncStatus {
  pendingCount: number;
  markLearnedCount: number;
  reviewFeedbackCount: number;
  addSentenceCount: number;
  dictationRecordCount: number;
  statsSyncCount: number;
  isSyncing: boolean;
  lastSyncTime: number | null;
  nextSyncTime: number | null;
  lastSyncError: string | null;
}

export type SyncEventData = 
  | { count: number }
  | { count: number; message: string }
  | { message: string; retryCount?: number; maxRetriesReached?: boolean; errorType?: string; maxRetries?: number }
  | SyncStatus;

export type SyncEventType = 'syncStart' | 'syncSuccess' | 'syncError' | 'queueChanged' | 'queueWarning';

export interface SyncEventPayloads {
  syncStart: { count: number };
  syncSuccess: { count: number; message: string };
  syncError: { message: string; retryCount?: number; maxRetriesReached?: boolean; errorType?: string; maxRetries?: number };
  queueChanged: SyncStatus;
  queueWarning: QueueWarningData;
}

export interface StorageWarningData {
  type: 'storageFull' | 'migrationError' | 'truncationWarning' | 'migrationWarning' | 'migrationSuccess';
  message: string;
  details?: {
    totalSource?: number;
    totalMigrated?: number;
    truncated?: boolean;
  };
}

declare global {
  interface WindowEventMap {
    sentencesFullLoaded: CustomEvent<Sentence[]>;
    dailySelectionUpdated: CustomEvent<string[]>;
    settingsChanged: CustomEvent<UserSettings>;
    statsChanged: CustomEvent<UserStats>;
    'd3s:storage_warning': CustomEvent<StorageWarningData>;
  }
}

export interface HeatmapSentence {
  id: string;
  english: string;
  chinese: string;
  addedAt: number;
  lastReviewedAt: number | undefined;
  intervalIndex: number;
}

export interface QueueTask<T = void> {
  id: string;
  type: 'sentence' | 'stats' | 'dictation' | 'dailySelection';
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  createdAt: number;
  timeout: number;
}
