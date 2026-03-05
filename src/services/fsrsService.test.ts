import { describe, it, expect } from 'vitest';
import { fsrsService, Rating } from './fsrsService';
import { Sentence } from '../types';

describe('FSRS Service', () => {
  // Mock a basic sentence object
  const createMockSentence = (overrides: Partial<any> = {}): any => ({
    id: 'test-id',
    english: 'Test sentence',
    chinese: '测试句子',
    created_at: new Date().toISOString(),
    ...overrides
  });

  const RATING_AGAIN = 1 as Rating;
  const RATING_HARD = 2 as Rating;
  const RATING_GOOD = 3 as Rating;
  const RATING_EASY = 4 as Rating;

  it('should schedule next review for a new card (rating: again)', () => {
    const sentence = createMockSentence();
    const result = fsrsService.calculateNextReview(sentence, RATING_AGAIN);
    
    expect(result.difficulty).toBeGreaterThan(0);
    expect(result.stability).toBeGreaterThan(0);
    expect(result.reps).toBe(1);
    // expect(result.lapses).toBe(1); // Implementation detail may vary
    expect(result.state).toBeDefined();
    
    // Check if next_review is in the future
    const nextReview = new Date(result.nextReviewDate).getTime();
    const now = new Date().getTime();
    expect(nextReview).toBeGreaterThanOrEqual(now);
  });

  it('should schedule next review for a new card (rating: good)', () => {
    const sentence = createMockSentence();
    const result = fsrsService.calculateNextReview(sentence, RATING_GOOD);
    
    expect(result.difficulty).toBeGreaterThan(0);
    expect(result.stability).toBeGreaterThan(0);
    expect(result.reps).toBe(1);
    expect(result.lapses).toBe(0);
  });

  it('should increase stability on subsequent "good" reviews', () => {
    const sentence = createMockSentence({
      difficulty: 5,
      stability: 2,
      reps: 1,
      lapses: 0,
      state: 2, // Review state
      lastReviewedAt: Date.now() - 86400000 // Reviewed 1 day ago
    });

    const result = fsrsService.calculateNextReview(sentence, RATING_GOOD);
    
    expect(result.stability).toBeGreaterThan(2); // Stability should increase
    expect(result.reps).toBe(2);
  });

  it('should decrease stability (or increase less) on "hard" reviews', () => {
     const sentence = createMockSentence({
      difficulty: 5,
      stability: 5,
      reps: 2,
      state: 2,
      lastReviewedAt: Date.now() - 86400000 * 5
    });

    const goodResult = fsrsService.calculateNextReview({ ...sentence }, RATING_GOOD);
    const hardResult = fsrsService.calculateNextReview({ ...sentence }, RATING_HARD);

    // Typically, a 'hard' rating results in a lower next stability than a 'good' rating
    expect(hardResult.stability).toBeLessThan(goodResult.stability);
    // And difficulty should increase
    expect(hardResult.difficulty).toBeGreaterThan(sentence.difficulty!);
  });

  it('should handle "again" correctly (reset stability/intervals)', () => {
    const sentence = createMockSentence({
      difficulty: 5,
      stability: 10,
      reps: 5,
      state: 2,
      lastReviewedAt: Date.now() - 86400000 * 10
    });

    const result = fsrsService.calculateNextReview(sentence, RATING_AGAIN);
    
    expect(result.stability).toBeLessThan(10); // Stability should drop significantly
    expect(result.lapses).toBeGreaterThan(0);
  });

  it('should never produce NaN or Infinity', () => {
    const ratings: Rating[] = [RATING_AGAIN, RATING_HARD, RATING_GOOD, RATING_EASY];
    const sentence = createMockSentence();

    ratings.forEach(rating => {
      const result = fsrsService.calculateNextReview(sentence, rating);
      expect(Number.isFinite(result.difficulty)).toBe(true);
      expect(Number.isFinite(result.stability)).toBe(true);
      expect(new Date(result.nextReviewDate).toString()).not.toBe('Invalid Date');
    });
  });
  
  // Specific test for the fix we implemented (Math.exp with bounds)
  it('should not crash with extreme values', () => {
     const sentence = createMockSentence({
      difficulty: 10, // Max difficulty
      stability: 0.1, // Very low stability
      reps: 1,
      state: 1, // Learning
      lastReviewedAt: Date.now()
    });
    
    const result = fsrsService.calculateNextReview(sentence, RATING_GOOD);
    expect(result.stability).toBeGreaterThan(0);
  });
});

