/**
 * FSRS 5.0 (Free Spaced Repetition Scheduler) Algorithm Implementation
 * Based on: https://github.com/open-spaced-repetition/fsrs4anki
 * 
 * Rating System:
 * - Again (1): Forgot completely, need to relearn
 * - Hard (2): Remembered with significant difficulty
 * - Good (3): Remembered with some effort (normal)
 * - Easy (4): Remembered effortlessly
 * 
 * Algorithm Overview:
 * FSRS 5.0 uses a multi-factor algorithm to calculate:
 * - Stability: How strong the memory trace is (determines next review interval)
 * - Difficulty: How hard the item is to remember (affects stability growth)
 * - Retrievability: Current recall probability based on elapsed time
 * 
 * Core Formulas:
 * 1. Retrievability: R = (1 + elapsedDays / (stability * FACTOR)) ^ (-DECAY)
 * 2. Stability after review: S = stability * e^(0.1 * (rating - 3) * (10 - difficulty) / 10)
 * 3. Difficulty adjustment: D = D - 0.5 * (rating - 3)
 */

import { CardState } from '../types';
import { FSRS_DEFAULT_PARAMS, FSRS_CONFIG } from '../constants';

export type Rating = 1 | 2 | 3 | 4;
export type ReviewLog = {
  rating: Rating;
  scheduledDays: number;
  elapsedDays: number;
  review: number;
  state: State;
};

// 使用类型别名统一 State 和 CardState，避免重复定义
export type State = CardState;
export const State = CardState;

import { performanceMonitor } from '../utils/performanceMonitor';

// FSRS 调试和错误处理模块
class FSRSErrorHandler {
  private static instance: FSRSErrorHandler;
  private errorCount = 0;
  private maxErrorCount = 100;
  
  static getInstance(): FSRSErrorHandler {
    if (!FSRSErrorHandler.instance) {
      FSRSErrorHandler.instance = new FSRSErrorHandler();
    }
    return FSRSErrorHandler.instance;
  }
  
  logError(errorType: string, details: any): void {
    if (this.errorCount >= this.maxErrorCount) {
      return; // 避免无限错误日志
    }
    
    this.errorCount++;
    
    const errorInfo = {
      timestamp: new Date().toISOString(),
      errorType,
      details,
      errorCount: this.errorCount
    };
    
    console.error(`🚨 FSRS ${errorType}:`, errorInfo);
    
    // 在开发环境下记录更详细的信息
    if (import.meta.env.DEV) {
      console.trace('FSRS 错误堆栈跟踪');
    }
  }
  
  logWarning(warningType: string, details: any): void {
    if (import.meta.env.DEV) {
      console.warn(`⚠️ FSRS ${warningType}:`, details);
    }
  }
  
  resetErrorCount(): void {
    this.errorCount = 0;
  }
}

const fsrsErrorHandler = FSRSErrorHandler.getInstance();

export interface FSRSCard {
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: State;
  last_review: number | null;
}

export interface FSRSParameters {
  w: number[];
  requestRetention: number;
  maximumInterval: number;
  easyBonus: number;
  hardInterval: number;
}

const DEFAULT_PARAMETERS: FSRSParameters = {
  w: FSRS_DEFAULT_PARAMS.w,
  requestRetention: FSRS_DEFAULT_PARAMS.requestRetention,
  maximumInterval: FSRS_DEFAULT_PARAMS.maximumInterval,
  easyBonus: FSRS_DEFAULT_PARAMS.easyBonus,
  hardInterval: FSRS_DEFAULT_PARAMS.hardInterval
};

const FSRS_PARAMS_KEY = FSRS_CONFIG.STORAGE_KEY;

// FSRS 参数 JSON Schema 验证
const FSRS_PARAMS_SCHEMA = {
  type: 'object',
  required: ['w', 'requestRetention', 'maximumInterval', 'easyBonus', 'hardInterval'],
  properties: {
    w: {
      type: 'array',
      minItems: 17,
      maxItems: 17,
      items: { type: 'number' }
    },
    requestRetention: { type: 'number', minimum: 0, maximum: 1 },
    maximumInterval: { type: 'number', minimum: 1 },
    easyBonus: { type: 'number', minimum: 1 },
    hardInterval: { type: 'number', minimum: 0 }
  }
};

// 验证 FSRS 参数是否符合 Schema
function validateFSRSParams(params: unknown): params is FSRSParameters {
  try {
    const parsed = typeof params === 'string' ? JSON.parse(params) : params;
    
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    
    // 验证必需字段
    if (!Array.isArray(parsed.w) || parsed.w.length !== 17) {
      return false;
    }
    
    if (typeof parsed.requestRetention !== 'number' || 
        parsed.requestRetention < 0 || 
        parsed.requestRetention > 1) {
      return false;
    }
    
    if (typeof parsed.maximumInterval !== 'number' || parsed.maximumInterval < 1) {
      return false;
    }
    
    if (typeof parsed.easyBonus !== 'number' || parsed.easyBonus < 1) {
      return false;
    }
    
    if (typeof parsed.hardInterval !== 'number' || parsed.hardInterval < 0) {
      return false;
    }
    
    // 验证 w 数组中的每个值
    for (let i = 0; i < 17; i++) {
      if (typeof parsed.w[i] !== 'number') {
        return false;
      }
    }
    
    return true;
  } catch (e) {
    return false;
  }
}

// 从 localStorage 加载 FSRS 参数
function loadParameters(): FSRSParameters {
  try {
    const saved = localStorage.getItem(FSRS_PARAMS_KEY);
    if (saved) {
      // ✅ 使用 JSON Schema 验证参数完整性
      if (validateFSRSParams(saved)) {
        const parsed = JSON.parse(saved);
        console.log('✅ FSRS 参数验证通过，加载成功');
        return {
          w: parsed.w,
          requestRetention: parsed.requestRetention,
          maximumInterval: parsed.maximumInterval,
          easyBonus: parsed.easyBonus,
          hardInterval: parsed.hardInterval
        };
      }
      console.warn('❌ FSRS 参数验证失败，使用默认值');
    }
  } catch (e) {
    console.warn('加载 FSRS 参数失败，使用默认值', e);
  }
  return { ...DEFAULT_PARAMETERS };
}

// 保存 FSRS 参数到 localStorage
function saveParameters(params: FSRSParameters): void {
  try {
    // 添加版本号
    const paramsWithVersion = {
      ...params,
      version: 1
    };
    localStorage.setItem(FSRS_PARAMS_KEY, JSON.stringify(paramsWithVersion));
  } catch (e) {
    console.warn('保存 FSRS 参数失败', e);
  }
}

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

function constrainDifficulty(d: number): number {
  return Math.min(10, Math.max(1, d));
}

function constrainStability(s: number): number {
  return Math.max(0.1, Math.min(s, 36500));
}

function initStability(r: Rating): number {
  if (import.meta.env.DEV) {
    performanceMonitor.mark('fsrs-initStability-start');
  }
  const result = Math.max(0.1, DEFAULT_PARAMETERS.w[r - 1]);
  if (import.meta.env.DEV) {
    performanceMonitor.measure('fsrs-initStability', 'fsrs-initStability-start');
  }
  return result;
}

function initDifficulty(r: Rating): number {
  const w = DEFAULT_PARAMETERS.w;
  // 计算初始难度：基于评分的难度调整
  // w[4]: 初始难度基准值
  // w[5]: 评分对难度的影响系数
  // 公式：D = w[4] - w[5] * (r - 3)
  // 评分越高（r > 3），难度越低；评分越低（r < 3），难度越高
  if (import.meta.env.DEV) {
    performanceMonitor.mark('fsrs-initDifficulty-start');
  }
  const result = constrainDifficulty(w[4] - w[5] * (r - 3));
  if (import.meta.env.DEV) {
    performanceMonitor.measure('fsrs-initDifficulty', 'fsrs-initDifficulty-start');
  }
  return result;
}

function nextDifficulty(d: number, r: Rating): number {
  const w = DEFAULT_PARAMETERS.w;
  // 计算下一次难度：基于当前难度和评分的调整
  // w[6]: 评分对难度变化的影响系数
  // w[7]: 均值回归系数（控制难度向初始值回归的程度）
  // 公式：D_next = meanReversion(w[4], D - w[6] * (r - 3))
  if (import.meta.env.DEV) {
    performanceMonitor.mark('fsrs-nextDifficulty-start');
  }
  const nextD = d - w[6] * (r - 3);
  const result = constrainDifficulty(meanReversion(w[4], nextD));
  if (import.meta.env.DEV) {
    performanceMonitor.measure('fsrs-nextDifficulty', 'fsrs-nextDifficulty-start');
  }
  return result;
}

function meanReversion(init: number, current: number): number {
  const w = DEFAULT_PARAMETERS.w;
  // 均值回归：将当前值向初始值回归，防止难度过度偏离
  // w[7]: 回归系数（0-1之间）
  // 公式：result = w[7] * init + (1 - w[7]) * current
  // w[7] 越大，回归越强；w[7] 越小，保持当前值越多
  return w[7] * init + (1 - w[7]) * current;
}

function nextStability(d: number, s: number, r: Rating): number {
  const w = DEFAULT_PARAMETERS.w;
  
  if (import.meta.env.DEV) {
    performanceMonitor.mark('fsrs-nextStability-start');
  }
  
  try {
    // ✅ 输入参数边界检查
    const safeDifficulty = constrainDifficulty(d);
    const safeStability = constrainStability(s);
    
    if (r === 1) {
      // ✅ 缓存常用计算结果，避免重复计算
      // 再次评分（忘记）的稳定性计算
      // w[11]: 基础稳定性系数
      // w[12]: 难度对稳定性的影响（负指数）
      // w[13]: 当前稳定性对下一次稳定性的影响
      // w[14]: 指数增长因子
      // 公式：S = w[11] * d^(-w[12]) * (s+1)^w[13] * e^w[14]
      
      // ✅ 使用安全参数进行计算
      const dPow = Math.pow(Math.max(0.1, safeDifficulty), -Math.max(0.1, w[12]));
      const sPow = Math.pow(Math.max(0.1, safeStability) + 1, Math.max(0.1, w[13]));
      const expVal = Math.exp(Math.max(-10, Math.min(10, w[14])));
      const newStability = w[11] * dPow * (sPow - 1) * expVal;
      
      // ✅ 异常处理：检查计算结果是否有效
      if (!isFinite(newStability) || isNaN(newStability) || newStability < 0) {
        fsrsErrorHandler.logError('稳定性计算异常(再次评分)', { 
          difficulty: safeDifficulty, 
          stability: safeStability, 
          rating: r, 
          newStability,
          function: 'nextStability'
        });
        return 0.1;
      }
      
      return constrainStability(newStability);
    }
    
    // 正常复习（Hard/Good/Easy）的稳定性计算
    const hardPenalty = r === 2 ? Math.max(0.1, Math.min(2, w[15])) : 1; // Hard 评分的稳定性惩罚
    const easyBonus = r === 4 ? Math.max(1, Math.min(3, DEFAULT_PARAMETERS.easyBonus)) : 1; // Easy 评分的稳定性奖励
    
    // ✅ 缓存常用计算结果，添加边界保护
    const expW8 = Math.exp(Math.max(-10, Math.min(10, w[8]))); // e^w[8]
    const sPowNeg9 = Math.pow(Math.max(0.1, safeStability), -Math.max(0.1, Math.min(10, w[9]))); // s^(-w[9])
    
    // 修复：使用 (r-2) 替代 (1-r) 以确保稳定性增长（基于 Rating 1-4）
    // r=2(Hard) -> exp(0)-1 = 0
    // r=3(Good) -> exp(w10)-1 > 0
    // r=4(Easy) -> exp(2*w10)-1 > 0
    const expW10 = Math.exp(Math.max(-10, Math.min(10, w[10] * (r - 2)))); 
    
    // 公式：S = s * (1 + e^w[8] * (11-d) * s^(-w[9]) * (e^(w[10]*(r-2)) - 1) * hardPenalty * easyBonus)
    const newStability = safeStability * (1 + expW8 *
      Math.max(1, Math.min(10, 11 - safeDifficulty)) *
      sPowNeg9 *
      Math.max(0, expW10 - 1) * // 确保增益非负
      hardPenalty *
      easyBonus
    );
    
    // ✅ 异常处理：检查计算结果是否有效
    if (!isFinite(newStability) || isNaN(newStability) || newStability < 0) {
      fsrsErrorHandler.logError('稳定性计算异常(正常复习)', { 
        difficulty: safeDifficulty, 
        stability: safeStability, 
        rating: r, 
        hardPenalty, 
        easyBonus, 
        newStability,
        function: 'nextStability'
      });
      return 0.1;
    }
    
    // ✅ 边界保护：确保稳定性不为负值或零
    const finalStability = Math.max(0.1, newStability);
    
    // 只在真正需要保护时输出警告（非预期的小值或异常值）
    if (import.meta.env.DEV && newStability < 0.1) {
      console.warn(`⚠️ FSRS 稳定性边界保护触发: ${newStability.toFixed(4)} → ${finalStability.toFixed(4)}`, {
        difficulty: d.toFixed(2),
        stability: s.toFixed(2),
        rating: r,
        hardPenalty,
        easyBonus
      });
    }
    
    const result = constrainStability(finalStability);
    
    if (import.meta.env.DEV) {
      performanceMonitor.measure('fsrs-nextStability', 'fsrs-nextStability-start');
    }
    
    return result;
  } catch (err) {
    console.error('FSRS稳定性计算错误:', err);
    return 0.1;
  } finally {
    if (import.meta.env.DEV) {
      performanceMonitor.measure('fsrs-nextStability', 'fsrs-nextStability-start');
    }
  }
}

function calculateInterval(stability: number): number {
  if (import.meta.env.DEV) {
    performanceMonitor.mark('fsrs-calculateInterval-start');
  }
  // ✅ 缓存常用计算结果
  const retentionPow = Math.pow(DEFAULT_PARAMETERS.requestRetention, DECAY);
  const interval = (stability / FACTOR) * (retentionPow - 1);
  const result = Math.min(Math.round(interval), DEFAULT_PARAMETERS.maximumInterval);
  if (import.meta.env.DEV) {
    performanceMonitor.measure('fsrs-calculateInterval', 'fsrs-calculateInterval-start');
  }
  return result;
}

function getRetrievability(stability: number, elapsedDays: number): number {
  // ✅ 参数边界检查：确保稳定性为正数，避免除零错误
  if (stability <= 0) {
    fsrsErrorHandler.logWarning('稳定性参数异常', { 
      stability, 
      elapsedDays,
      function: 'getRetrievability'
    });
    return 0.5; // 返回中等回忆成功率
  }
  
  // ✅ 确保经过天数为非负数
  const safeElapsedDays = Math.max(0, elapsedDays);
  
  // ✅ 缓存常用计算结果
  const factorElapsed = FACTOR * safeElapsedDays;
  const base = 1 + factorElapsed / stability;
  
  // ✅ 检查计算结果的有效性
  if (base <= 0) {
    fsrsErrorHandler.logWarning('回忆成功率计算异常', { 
      stability, 
      safeElapsedDays, 
      base,
      factorElapsed,
      function: 'getRetrievability'
    });
    return 0.5;
  }
  
  const retrievability = Math.pow(base, DECAY);
  
  // ✅ 确保回忆成功率在 [0, 1] 范围内
  const finalRetrievability = Math.max(0, Math.min(1, retrievability));
  
  // ✅ 记录异常值（超出正常范围但被修正的情况）
  if (retrievability < 0 || retrievability > 1) {
    fsrsErrorHandler.logWarning('回忆成功率超出范围', {
      original: retrievability,
      corrected: finalRetrievability,
      stability,
      elapsedDays: safeElapsedDays,
      base,
      function: 'getRetrievability'
    });
  }
  
  return finalRetrievability;
}

class FSRSService {
  private params: FSRSParameters;

  constructor() {
    this.params = loadParameters();
  }

  // 获取当前参数
  getParameters(): FSRSParameters {
    return { ...this.params };
  }

  // 更新参数
  setParameters(newParams: Partial<FSRSParameters>): void {
    const validatedParams = {
      ...this.params,
      ...newParams
    };
    
    if (!validateFSRSParams(validatedParams)) {
      console.error('FSRS 参数验证失败，使用默认值');
      return;
    }
    
    this.params = validatedParams;
    saveParameters(this.params);
  }

  // 重置为默认参数
  resetParameters(): void {
    this.params = { ...DEFAULT_PARAMETERS };
    saveParameters(this.params);
  }

  createNewCard(): FSRSCard {
    return {
      due: Date.now(),
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: State.New,
      last_review: null
    };
  }

  repeat(card: FSRSCard, now: number = Date.now()): Map<Rating, { card: FSRSCard; reviewLog: ReviewLog }> {
    const schedulingCards = new Map<Rating, { card: FSRSCard; reviewLog: ReviewLog }>();
    
    if (card.state === State.New) {
      for (const rating of [1, 2, 3, 4] as Rating[]) {
        const newCard = this._createCopy(card);
        this._initCard(newCard, rating, now);
        schedulingCards.set(rating, {
          card: newCard,
          reviewLog: this._createReviewLog(newCard, rating, 0, now)
        });
      }
    } else if (card.state === State.Learning || card.state === State.Relearning) {
      for (const rating of [1, 2, 3, 4] as Rating[]) {
        const newCard = this._createCopy(card);
        this._updateLearningCard(newCard, rating, now);
        schedulingCards.set(rating, {
          card: newCard,
          reviewLog: this._createReviewLog(newCard, rating, newCard.elapsed_days, now)
        });
      }
    } else {
      const elapsedDays = card.last_review 
        ? Math.max(0, Math.floor((now - card.last_review) / (24 * 60 * 60 * 1000)))
        : 0;
      
      for (const rating of [1, 2, 3, 4] as Rating[]) {
        const newCard = this._createCopy(card);
        newCard.elapsed_days = elapsedDays;
        this._updateReviewCard(newCard, rating, now, elapsedDays);
        schedulingCards.set(rating, {
          card: newCard,
          reviewLog: this._createReviewLog(newCard, rating, elapsedDays, now)
        });
      }
    }
    
    return schedulingCards;
  }

  private _createCopy(card: FSRSCard): FSRSCard {
    return { ...card };
  }

  private _initCard(card: FSRSCard, rating: Rating, now: number): void {
    card.difficulty = initDifficulty(rating);
    card.stability = initStability(rating);
    
    if (rating === 1) {
      // Again - 完全忘记，进入学习状态
      card.state = State.Learning;
      card.due = now + this._getLearningInterval(rating);
      card.scheduled_days = 0;
    } else if (rating === 2) {
      // Hard - 记得困难，进入学习状态
      card.state = State.Learning;
      card.due = now + this._getLearningInterval(rating);
      card.scheduled_days = 0;
    } else if (rating === 3) {
      // Good - 正常记得，进入复习状态
      card.scheduled_days = calculateInterval(card.stability);
      card.due = now + card.scheduled_days * 24 * 60 * 60 * 1000;
      card.state = State.Review;
    } else if (rating === 4) {
      // Easy - 轻松记得，进入复习状态并应用 Easy Bonus
      card.scheduled_days = Math.round(calculateInterval(card.stability) * DEFAULT_PARAMETERS.easyBonus);
      card.due = now + card.scheduled_days * 24 * 60 * 60 * 1000;
      card.state = State.Review;
    }
    
    card.reps = 1;
    card.last_review = now;
  }

  private _updateLearningCard(card: FSRSCard, rating: Rating, now: number): void {
    card.difficulty = nextDifficulty(card.difficulty, rating);
    
    if (rating === 1) {
      card.stability = nextStability(card.difficulty, card.stability, rating);
      card.due = now + this._getLearningInterval(rating);
      card.state = State.Learning;
      card.scheduled_days = 0;
    } else if (rating === 2) {
      card.stability = nextStability(card.difficulty, card.stability, rating);
      card.due = now + this._getLearningInterval(rating);
      card.state = State.Learning;
      card.scheduled_days = 0;
    } else {
      card.stability = nextStability(card.difficulty, card.stability, rating);
      card.scheduled_days = calculateInterval(card.stability);
      card.due = now + card.scheduled_days * 24 * 60 * 60 * 1000;
      card.state = State.Review;
    }
    
    card.reps += 1;
    card.last_review = now;
  }

  private _updateReviewCard(card: FSRSCard, rating: Rating, now: number, elapsedDays: number): void {
    card.difficulty = nextDifficulty(card.difficulty, rating);
    
    if (rating === 1) {
      card.lapses += 1;
      card.stability = nextStability(card.difficulty, card.stability, rating);
      card.state = State.Relearning;
      card.due = now + this._getRelearningInterval();
      card.scheduled_days = 0;
    } else {
      card.stability = nextStability(card.difficulty, card.stability, rating);
      
      let intervalMultiplier = 1;
      if (rating === 2) {
        intervalMultiplier = DEFAULT_PARAMETERS.hardInterval;
      } else if (rating === 4) {
        intervalMultiplier = DEFAULT_PARAMETERS.easyBonus;
      }
      
      card.scheduled_days = Math.max(
        1,
        Math.min(
          Math.round(calculateInterval(card.stability) * intervalMultiplier),
          DEFAULT_PARAMETERS.maximumInterval
        )
      );
      card.due = now + card.scheduled_days * 24 * 60 * 60 * 1000;
      card.state = State.Review;
    }
    
    card.reps += 1;
    card.last_review = now;
  }

  private _getLearningInterval(rating: Rating): number {
    const w = this.params.w;
    if (rating === 1) {
      return Math.round(w[16] * 60 * 1000);
    } else if (rating === 2) {
      return Math.round(w[16] * 10 * 60 * 1000);
    }
    return Math.round(w[16] * 10 * 60 * 1000);
  }

  private _getRelearningInterval(): number {
    return Math.round(this.params.w[16] * 10 * 60 * 1000);
  }

  private _createReviewLog(card: FSRSCard, rating: Rating, elapsedDays: number, now: number): ReviewLog {
    return {
      rating,
      scheduledDays: card.scheduled_days,
      elapsedDays,
      review: now,
      state: card.state
    };
  }

  getCardFromSentence(sentence: { 
    stability?: number; 
    difficulty?: number; 
    reps?: number; 
    lapses?: number;
    state?: State;
    lastReviewedAt?: number | null;
    nextReviewDate?: number | null;
  }): FSRSCard {
    const now = Date.now();
    
    if (sentence.stability !== undefined && sentence.difficulty !== undefined) {
      return {
        due: sentence.nextReviewDate || now,
        stability: sentence.stability,
        difficulty: sentence.difficulty,
        elapsed_days: 0,
        scheduled_days: 0,
        reps: sentence.reps || 0,
        lapses: sentence.lapses || 0,
        state: sentence.state !== undefined ? sentence.state : State.Review,
        last_review: sentence.lastReviewedAt || null
      };
    }
    
    return this.createNewCard();
  }

  calculateNextReview(
    sentence: {
      stability?: number;
      difficulty?: number;
      reps?: number;
      lapses?: number;
      state?: State;
      lastReviewedAt?: number | null;
      nextReviewDate?: number | null;
    },
    rating: Rating
  ): {
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
    state: State;
    nextReviewDate: number;
    scheduledDays: number;
  } {
    const card = this.getCardFromSentence(sentence);
    const now = Date.now();
    
    const schedulingCards = this.repeat(card, now);
    const result = schedulingCards.get(rating);
    
    if (!result) {
      throw new Error(`Invalid rating: ${rating}`);
    }
    
    const newCard = result.card;
    
    return {
      stability: newCard.stability,
      difficulty: newCard.difficulty,
      reps: newCard.reps,
      lapses: newCard.lapses,
      state: newCard.state,
      nextReviewDate: newCard.due,
      scheduledDays: newCard.scheduled_days
    };
  }

  getRetrievabilityPercent(stability: number, elapsedDays: number): number {
    return Math.round(getRetrievability(stability, elapsedDays) * 100);
  }
}

export const fsrsService = new FSRSService();
export { DEFAULT_PARAMETERS };
