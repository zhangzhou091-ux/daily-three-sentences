import { describe, it, expect } from 'vitest';
import { fsrsService, Rating, FSRSCard } from './fsrsService';
import { CardState } from '../types';

describe('FSRS Service', () => {
  const createMockFSRSCard = (overrides: Partial<FSRSCard> = {}): FSRSCard => ({
    due: Date.now(),
    stability: 1,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: CardState.New,
    last_review: null,
    is_pending_first_review: true,
    ...overrides
  });

  const RATING_AGAIN = 1 as Rating;
  const RATING_HARD = 2 as Rating;
  const RATING_GOOD = 3 as Rating;
  const RATING_EASY = 4 as Rating;

  it('should schedule next review for a new card (rating: again)', () => {
    const card = createMockFSRSCard();
    const result = fsrsService.calculateNextReview(card, RATING_AGAIN);
    
    expect(result.difficulty).toBeGreaterThan(0);
    expect(result.stability).toBeGreaterThan(0);
    expect(result.reps).toBe(1);
    expect(result.state).toBeDefined();
    
    const nextReview = new Date(result.due).getTime();
    const now = new Date().getTime();
    expect(nextReview).toBeGreaterThanOrEqual(now);
  });

  it('should schedule next review for a new card (rating: good)', () => {
    const card = createMockFSRSCard();
    const result = fsrsService.calculateNextReview(card, RATING_GOOD);
    
    expect(result.difficulty).toBeGreaterThan(0);
    expect(result.stability).toBeGreaterThan(0);
    expect(result.reps).toBe(1);
    expect(result.lapses).toBe(0);
  });

  it('should increase stability on subsequent "good" reviews', () => {
    const card = createMockFSRSCard({
      difficulty: 5,
      stability: 2,
      reps: 1,
      lapses: 0,
      state: CardState.Review,
      last_review: Date.now() - 86400000,
      is_pending_first_review: false
    });

    const result = fsrsService.calculateNextReview(card, RATING_GOOD);
    
    expect(result.stability).toBeGreaterThan(2);
    expect(result.reps).toBe(2);
  });

  it('should decrease stability (or increase less) on "hard" reviews', () => {
    const card = createMockFSRSCard({
      difficulty: 5,
      stability: 5,
      reps: 2,
      state: CardState.Review,
      last_review: Date.now() - 86400000 * 5,
      is_pending_first_review: false
    });

    const goodResult = fsrsService.calculateNextReview({ ...card }, RATING_GOOD);
    const hardResult = fsrsService.calculateNextReview({ ...card }, RATING_HARD);

    expect(hardResult.stability).toBeLessThan(goodResult.stability);
    expect(hardResult.difficulty).toBeGreaterThan(card.difficulty);
  });

  it('should handle "again" correctly (reset stability/intervals)', () => {
    const card = createMockFSRSCard({
      difficulty: 5,
      stability: 10,
      reps: 5,
      state: CardState.Review,
      last_review: Date.now() - 86400000 * 10,
      is_pending_first_review: false
    });

    const result = fsrsService.calculateNextReview(card, RATING_AGAIN);
    
    expect(result.stability).toBeLessThan(10);
    expect(result.lapses).toBeGreaterThan(0);
  });

  it('should never produce NaN or Infinity', () => {
    const ratings: Rating[] = [RATING_AGAIN, RATING_HARD, RATING_GOOD, RATING_EASY];
    const card = createMockFSRSCard();

    ratings.forEach(rating => {
      const result = fsrsService.calculateNextReview(card, rating);
      expect(Number.isFinite(result.difficulty)).toBe(true);
      expect(Number.isFinite(result.stability)).toBe(true);
      expect(new Date(result.due).toString()).not.toBe('Invalid Date');
    });
  });
  
  it('should not crash with extreme values', () => {
    const card = createMockFSRSCard({
      difficulty: 10,
      stability: 0.1,
      reps: 1,
      state: CardState.Learning,
      last_review: Date.now(),
      is_pending_first_review: false
    });
    
    const result = fsrsService.calculateNextReview(card, RATING_GOOD);
    expect(result.stability).toBeGreaterThan(0);
  });
});

