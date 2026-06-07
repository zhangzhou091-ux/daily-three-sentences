import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Sentence } from '../../../types';
import { __randomListeningTestUtils } from './useRandomListening';

const createSentence = (overrides: Partial<Sentence>): Sentence => ({
  id: overrides.id || 'sentence-1',
  english: overrides.english || 'This is a sample sentence.',
  chinese: overrides.chinese || '这是一个示例句子。',
  addedAt: overrides.addedAt || Date.now(),
  lastReviewedAt: overrides.lastReviewedAt ?? null,
  nextReviewDate: overrides.nextReviewDate ?? null,
  intervalIndex: overrides.intervalIndex ?? 1,
  masteryLevel: overrides.masteryLevel ?? 3,
  timesReviewed: overrides.timesReviewed ?? 1,
  wrongDictations: overrides.wrongDictations ?? 0,
  tags: overrides.tags || [],
  updatedAt: overrides.updatedAt || Date.now(),
  learnedAt: overrides.learnedAt || Date.now(),
  stability: overrides.stability ?? 30,
  difficulty: overrides.difficulty ?? 5,
  ttsAudioPathEl: overrides.ttsAudioPathEl,
  ttsAudioPathMm: overrides.ttsAudioPathMm,
});

describe('useRandomListening sentence selection strategy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('按 30% 计算最近避让窗口，并限制最大值为 8', () => {
    expect(__randomListeningTestUtils.getRecentAvoidCount(1)).toBe(0);
    expect(__randomListeningTestUtils.getRecentAvoidCount(2)).toBe(1);
    expect(__randomListeningTestUtils.getRecentAvoidCount(10)).toBe(3);
    expect(__randomListeningTestUtils.getRecentAvoidCount(40)).toBe(8);
  });

  it('会把句子分到重点、普通、轻松三个桶', () => {
    const focus = createSentence({ id: 'focus', wrongDictations: 2, masteryLevel: 1, stability: 8 });
    const easy = createSentence({
      id: 'easy',
      english: 'Short easy line.',
      masteryLevel: 5,
      stability: 35,
      difficulty: 2,
    });
    const regular = createSentence({
      id: 'regular',
      english: 'This sentence is long enough to avoid easy bucket classification.',
      masteryLevel: 3,
      stability: 28,
      difficulty: 5,
    });

    expect(__randomListeningTestUtils.classifySentenceBucket(focus)).toBe('focus');
    expect(__randomListeningTestUtils.classifySentenceBucket(easy)).toBe('easy');
    expect(__randomListeningTestUtils.classifySentenceBucket(regular)).toBe('regular');
  });

  it('优先避开最近听过的句子，并在重点桶内抽取', () => {
    const recentFocus = createSentence({ id: 'focus-recent', wrongDictations: 3, masteryLevel: 1, stability: 5 });
    const nextFocus = createSentence({ id: 'focus-next', wrongDictations: 2, masteryLevel: 2, stability: 12 });
    const easy = createSentence({
      id: 'easy',
      english: 'Easy sentence.',
      masteryLevel: 5,
      stability: 40,
      difficulty: 1,
    });

    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.2);

    const selected = __randomListeningTestUtils.selectRandomListeningSentence(
      [recentFocus, nextFocus, easy],
      ['focus-recent'],
      'focus-recent',
      new Map()
    );

    expect(selected?.id).toBe('focus-next');
  });

  it('会对本轮已经播放过的句子施加强惩罚', () => {
    const repeated = createSentence({
      id: 'repeated',
      wrongDictations: 2,
      masteryLevel: 1,
      stability: 10,
      ttsAudioPathEl: '/audio/repeated.mp3',
    });
    const fresh = createSentence({
      id: 'fresh',
      wrongDictations: 2,
      masteryLevel: 1,
      stability: 10,
      ttsAudioPathEl: '/audio/fresh.mp3',
    });

    const repeatedWeight = __randomListeningTestUtils.computeWeight(repeated, new Map([['repeated', 1]]));
    const freshWeight = __randomListeningTestUtils.computeWeight(fresh, new Map());

    expect(repeatedWeight).toBeLessThan(freshWeight * 0.2);
  });
});
