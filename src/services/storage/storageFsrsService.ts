import { Sentence, UserStats, DictationRecord, UserSettings, ReviewRating, CardState } from '../../types';
import { fsrsService, State } from '../fsrsService';
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
      const result = fsrsService.calculateNextReview({
        stability: sentence.stability,
        difficulty: sentence.difficulty,
        reps: sentence.reps || 0,
        lapses: sentence.lapses || 0,
        state: sentence.state !== undefined ? cardStateToState(sentence.state) : State.Review,
        lastReviewedAt: sentence.lastReviewedAt,
        nextReviewDate: sentence.nextReviewDate
      }, rating);

      const nextIndex = storageFsrsService.calculateLevelFromStability(result.stability);

      return {
        nextIndex,
        nextDate: result.nextReviewDate,
        fsrsData: {
          stability: result.stability,
          difficulty: result.difficulty,
          reps: result.reps,
          lapses: result.lapses,
          state: stateToCardState(result.state),
          scheduledDays: result.scheduledDays,
          nextReviewDate: result.nextReviewDate
        }
      };
    }

    const result = fsrsService.calculateNextReview({
      reps: timesReviewed,
      state: currentIntervalIndex === 0 ? State.New : State.Review
    }, rating);

    const nextIndex = storageFsrsService.calculateLevelFromStability(result.stability);

    return {
      nextIndex,
      nextDate: result.nextReviewDate,
      fsrsData: {
        stability: result.stability,
        difficulty: result.difficulty,
        reps: result.reps,
        lapses: result.lapses,
        state: result.state as unknown as CardState,
        scheduledDays: result.scheduledDays,
        nextReviewDate: result.nextReviewDate
      }
    };
  },

  /**
   * 初始化新句子的 FSRS 参数
   */
  initFSRSForSentence: (sentence: Sentence, rating: ReviewRating = 3): Sentence => {
    const result = fsrsService.calculateNextReview({
      state: State.New
    }, rating);

    return {
      ...sentence,
      stability: result.stability,
      difficulty: result.difficulty,
      reps: result.reps,
      lapses: result.lapses,
      state: result.state as unknown as CardState,
      scheduledDays: result.scheduledDays,
      nextReviewDate: result.nextReviewDate,
      intervalIndex: storageFsrsService.calculateLevelFromStability(result.stability)
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
