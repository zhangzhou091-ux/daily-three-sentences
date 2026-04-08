/**
 * 优化版 FSRS 6.0 服务实现
 * 功能：学习页强制次日复习 + 复习页延迟激活算法
 */
import { CardState } from '../types';
import { FSRS_DEFAULT_PARAMS, FSRS_CONFIG } from '../constants';

export type Rating = 1 | 2 | 3 | 4;
export { CardState as State };

export interface FSRSCard {
  due: number;           // 下次复习时间戳
  stability: number;     // 稳定性
  difficulty: number;    // 难度
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: CardState;
  last_review: number | null;
  // 关键自定义字段：标记是否为新学待首次复习的内容
  is_pending_first_review: boolean; 
}

export interface FSRSParameters {
  w: number[];
  requestRetention: number;
  maximumInterval: number;
  easyBonus: number;
  hardInterval: number;
}

// ==============================
// 算法辅助函数 (保持 FSRS 6.0 核心公式)
// ==============================

function constrainDifficulty(d: number): number {
  return Math.min(10, Math.max(1, d));
}

function constrainStability(s: number): number {
  return Math.max(0.01, Math.min(s, 36500));
}

function initStability(r: Rating, params: FSRSParameters): number {
  return Math.max(0.01, params.w[r - 1]);
}

function initDifficulty(r: Rating, params: FSRSParameters): number {
  return constrainDifficulty(params.w[4] - params.w[5] * (r - 3));
}

function nextDifficulty(d: number, r: Rating, params: FSRSParameters): number {
  const w = params.w;
  const D0_Easy = w[4] - w[5] * (4 - 3);
  const delta = w[6] * (r - 3) * (10 - d) / 9;
  return constrainDifficulty(w[7] * D0_Easy + (1 - w[7]) * (d - delta));
}

function getRetrievability(s: number, t: number, params: FSRSParameters): number {
  const S = Math.max(0.01, s);
  const w20 = params.w[20];
  return Math.pow(1 + (19 / 81) * (t / S), -w20);
}

function nextStability(
  d: number, s: number, r: Rating, elapsed: number, params: FSRSParameters
): number {
  const w = params.w;
  const D = constrainDifficulty(d);
  const S = Math.max(0.01, s);
  const R = getRetrievability(S, elapsed, params);

  if (r === 1) {
    const sNew = w[11] * Math.pow(D, -w[12]) * (Math.pow(S + 1, w[13]) - 1) * Math.exp((1 - R) * w[14]);
    return constrainStability(Math.min(sNew, S / Math.exp(w[17] * w[18])));
  }

  const hardPenalty = r === 2 ? w[15] : 1;
  const sNew = S * (1 + Math.exp(w[8]) * (11 - D) * Math.pow(S, -w[9]) * (Math.exp((1 - R) * w[10]) - 1) * hardPenalty);
  return constrainStability(sNew);
}

function calculateInterval(s: number, params: FSRSParameters): number {
  const w20 = params.w[20];
  const raw = s * (81 / 19) * (Math.pow(params.requestRetention, -1 / w20) - 1);
  return Math.min(Math.max(1, Math.round(raw)), params.maximumInterval);
}

// ==============================
// 核心服务类
// ==============================

export class FSRSService {
  private params: FSRSParameters;

  constructor() {
    this.params = this.loadParameters();
  }

  /**
   * 功能 1: 学习页面专用 - 禁用算法，强制设定次日复习
   */
  processNewLearning(card: Partial<FSRSCard> | null | undefined): FSRSCard {
    const now = Date.now();
    const nextDay = new Date(now);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(4, 0, 0, 0);

    if (!card || typeof card !== 'object') {
      return {
        due: nextDay.getTime(),
        stability: 0,
        difficulty: 0,
        elapsed_days: 0,
        scheduled_days: 1,
        reps: 0,
        lapses: 0,
        state: CardState.Learning,
        last_review: now,
        is_pending_first_review: true
      };
    }

    return {
      due: nextDay.getTime(),
      stability: typeof card.stability === 'number' && !isNaN(card.stability) ? card.stability : 0,
      difficulty: typeof card.difficulty === 'number' && !isNaN(card.difficulty) ? constrainDifficulty(card.difficulty) : 0,
      elapsed_days: typeof card.elapsed_days === 'number' && !isNaN(card.elapsed_days) ? card.elapsed_days : 0,
      scheduled_days: 1,
      reps: typeof card.reps === 'number' && !isNaN(card.reps) ? card.reps : 0,
      lapses: typeof card.lapses === 'number' && !isNaN(card.lapses) ? card.lapses : 0,
      state: CardState.Learning,
      last_review: now,
      is_pending_first_review: true
    };
  }

  /**
   * 功能 2 & 3: 复习页面专用 - 首次强制复习后才激活 FSRS
   */
  calculateNextReview(card: FSRSCard, rating: Rating): FSRSCard {
    const now = Date.now();
    
    let validatedRating = rating;
    if (![1, 2, 3, 4].includes(rating)) {
      console.warn(`[FSRS] Invalid rating: ${rating}, using default value 3 (Good)`);
      validatedRating = 3 as Rating;
    }
    
    const normalizedCard: FSRSCard = {
      due: typeof card.due === 'number' && !isNaN(card.due) ? card.due : now,
      stability: typeof card.stability === 'number' && !isNaN(card.stability) && card.stability > 0 ? card.stability : 1,
      difficulty: typeof card.difficulty === 'number' && !isNaN(card.difficulty) ? constrainDifficulty(card.difficulty) : 5,
      elapsed_days: typeof card.elapsed_days === 'number' && !isNaN(card.elapsed_days) ? card.elapsed_days : 0,
      scheduled_days: typeof card.scheduled_days === 'number' && !isNaN(card.scheduled_days) ? card.scheduled_days : 0,
      reps: typeof card.reps === 'number' && !isNaN(card.reps) ? card.reps : 0,
      lapses: typeof card.lapses === 'number' && !isNaN(card.lapses) ? card.lapses : 0,
      state: Object.values(CardState).includes(card.state) ? card.state : CardState.New,
      last_review: typeof card.last_review === 'number' && !isNaN(card.last_review) ? card.last_review : null,
      is_pending_first_review: typeof card.is_pending_first_review === 'boolean' 
        ? card.is_pending_first_review 
        : (card.reps === 0 && card.state === CardState.New)
    };
    
    const newCard = { ...normalizedCard };
    const elapsed = normalizedCard.last_review ? Math.max(0, (now - normalizedCard.last_review) / 86400000) : 0;

    if (normalizedCard.is_pending_first_review && normalizedCard.reps === 0) {
      newCard.difficulty = initDifficulty(validatedRating, this.params);
      newCard.stability = initStability(validatedRating, this.params);
      newCard.is_pending_first_review = false;
      newCard.state = validatedRating === 1 ? CardState.Relearning : CardState.Review;
      newCard.reps = 1;
    } 
    else {
      newCard.difficulty = nextDifficulty(normalizedCard.difficulty, validatedRating, this.params);
      newCard.stability = nextStability(newCard.difficulty, normalizedCard.stability, validatedRating, elapsed, this.params);
      newCard.reps += 1;
      if (validatedRating === 1) {
        newCard.lapses += 1;
        newCard.state = CardState.Relearning;
      } else {
        newCard.state = CardState.Review;
      }
    }

    let interval = calculateInterval(newCard.stability, this.params);
    if (validatedRating === 2) interval = Math.max(1, Math.round(interval * this.params.hardInterval));
    if (validatedRating === 4) interval = Math.round(interval * this.params.easyBonus);

    newCard.scheduled_days = interval;
    newCard.due = now + interval * 86400000;
    newCard.last_review = now;

    return newCard;
  }

  private loadParameters(): FSRSParameters {
    const defaultParameters = {
      w: FSRS_DEFAULT_PARAMS.w,
      requestRetention: FSRS_DEFAULT_PARAMS.requestRetention,
      maximumInterval: FSRS_DEFAULT_PARAMS.maximumInterval,
      easyBonus: FSRS_DEFAULT_PARAMS.easyBonus,
      hardInterval: FSRS_DEFAULT_PARAMS.hardInterval
    };

    try {
      const saved = localStorage.getItem(FSRS_CONFIG.STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch {
      return defaultParameters;
    }
    return defaultParameters;
  }
}

export const fsrsService = new FSRSService();
