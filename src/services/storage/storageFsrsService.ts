import { Sentence, UserStats, DictationRecord, UserSettings, ReviewRating, CardState } from '../../types';
import { fsrsService, State, FSRSCard } from '../fsrsService';
import { localStorageService } from './localStorageService';

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

function sentenceToFSRSCard(sentence: Partial<Sentence>): FSRSCard {
  const now = Date.now();
  return {
    due: sentence.nextReviewDate || now,
    stability: sentence.stability || 0,
    difficulty: sentence.difficulty || 0,
    elapsed_days: 0,
    scheduled_days: sentence.scheduledDays || 0,
    reps: sentence.reps || 0,
    lapses: sentence.lapses || 0,
    state: sentence.state !== undefined ? sentence.state : CardState.New,
    last_review: sentence.lastReviewedAt || null,
    is_pending_first_review: sentence.isPendingFirstReview ?? false
  };
}

export const storageFsrsService = {
  /**
   * 计算下次复习时间
   */
  calculateNextReview: (
    currentIntervalIndex: number,
    rating: ReviewRating,
    timesReviewed: number = 0,
    sentence?: Partial<Sentence>
  ): { nextIndex: number, nextDate: number | null, fsrsData: Partial<Sentence> } => {
    const now = Date.now();

    if (sentence && sentence.stability !== undefined && sentence.difficulty !== undefined) {
      const fsrsCard = sentenceToFSRSCard(sentence);
      const result = fsrsService.calculateNextReview(fsrsCard, rating);

      const nextIndex = storageFsrsService.calculateLevelFromStability(result.stability);

      return {
        nextIndex,
        nextDate: result.due,
        fsrsData: {
          stability: result.stability,
          difficulty: result.difficulty,
          reps: result.reps,
          lapses: result.lapses,
          state: result.state,
          scheduledDays: result.scheduled_days,
          nextReviewDate: result.due,
          isPendingFirstReview: result.is_pending_first_review
        }
      };
    }

    const result = fsrsService.calculateNextReview({
      due: now,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: timesReviewed,
      lapses: 0,
      state: currentIntervalIndex === 0 ? CardState.New : CardState.Review,
      last_review: null,
      is_pending_first_review: false
    }, rating);

    const nextIndex = storageFsrsService.calculateLevelFromStability(result.stability);

    return {
      nextIndex,
      nextDate: result.due,
      fsrsData: {
        stability: result.stability,
        difficulty: result.difficulty,
        reps: result.reps,
        lapses: result.lapses,
        state: result.state,
        scheduledDays: result.scheduled_days,
        nextReviewDate: result.due,
        isPendingFirstReview: result.is_pending_first_review
      }
    };
  },

  /**
   * 初始化新句子的 FSRS 参数
   */
  initFSRSForSentence: (sentence: Sentence, rating: ReviewRating = 3): Sentence => {
    const result = fsrsService.processNewLearning({
      due: Date.now(),
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: CardState.New,
      last_review: null,
      is_pending_first_review: true
    });

    return {
      ...sentence,
      stability: result.stability,
      difficulty: result.difficulty,
      reps: result.reps,
      lapses: result.lapses,
      state: result.state,
      scheduledDays: result.scheduled_days,
      nextReviewDate: result.due,
      intervalIndex: storageFsrsService.calculateLevelFromStability(result.stability),
      isPendingFirstReview: result.is_pending_first_review
    };
  },

  /**
   * 根据 FSRS stability 参数计算 Level（1-10）
   */
  calculateLevelFromStability: (stability: number | undefined): number => {
    if (stability === undefined || stability <= 0) return 1;

    if (stability < 1) return 1;
    if (stability < 3) return 2;
    if (stability < 7) return 3;
    if (stability < 14) return 4;
    if (stability < 30) return 5;
    if (stability < 60) return 6;
    if (stability < 120) return 7;
    if (stability < 180) return 8;
    if (stability < 365) return 9;
    return 10;
  }
};
