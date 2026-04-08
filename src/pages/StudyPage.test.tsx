import { useState, type ReactNode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import StudyPage from './StudyPage';
import { Sentence } from '../types';

const mockGetTodayDictations = vi.fn();
const mockGetTodaySelection = vi.fn();
const mockSyncQueueOn = vi.fn();
const mockAddSentence = vi.fn();
const mockUpdateStatsSafely = vi.fn();
const mockCalculateNextReview = vi.fn();

vi.mock('../services/geminiService', () => ({
  geminiService: {
    speak: vi.fn()
  }
}));

vi.mock('../services/storage', () => ({
  storageService: {
    getSettings: () => ({
      dailyTarget: 3,
      dailyLearnTarget: 3,
      dailyReviewTarget: 10,
      voiceName: 'Kore',
      showChineseFirst: false,
      autoPlayAudio: true,
      userName: 'Tester',
      themeColor: '#3b82f6',
      updatedAt: Date.now()
    }),
    getTodaySelection: () => mockGetTodaySelection(),
    saveTodaySelection: vi.fn(),
    getTodayDictations: () => mockGetTodayDictations(),
    saveTodayDictations: vi.fn(),
    addSentence: (...args: unknown[]) => mockAddSentence(...args),
    updateStatsSafely: (...args: unknown[]) => mockUpdateStatsSafely(...args),
    calculateNextReview: (...args: unknown[]) => mockCalculateNextReview(...args),
    getYesterdaySelection: () => [],
    getYesterdayLearnedCount: () => 0,
    incrementTodayLearnedCount: vi.fn()
  }
}));

vi.mock('../services/supabaseService', () => ({
  supabaseService: {
    syncDictationRecord: vi.fn(() => Promise.resolve()),
    isReady: false
  }
}));

vi.mock('../services/deviceService', () => ({
  deviceService: {
    canSubmitFeedback: vi.fn(() => false)
  }
}));

vi.mock('../services/syncQueueService', () => ({
  syncQueueService: {
    getPendingOperations: vi.fn(() => []),
    syncNow: vi.fn(() => Promise.resolve({ success: true, message: 'ok' })),
    on: (...args: unknown[]) => mockSyncQueueOn(...args),
    addDictationRecord: vi.fn(),
    addMarkLearned: vi.fn(),
    addReviewFeedback: vi.fn()
  }
}));

vi.mock('../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>
}));

describe('StudyPage dictation rollover', () => {
  const sentence: Sentence = {
    id: 'sentence-1',
    english: 'hello world',
    chinese: '你好，世界',
    addedAt: Date.now(),
    lastReviewedAt: Date.now(),
    nextReviewDate: Date.now(),
    intervalIndex: 1,
    masteryLevel: 1,
    timesReviewed: 1,
    wrongDictations: 0,
    tags: [],
    updatedAt: Date.now(),
    state: 2
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-27T10:00:00.000Z'));
    mockGetTodaySelection.mockResolvedValue([]);
    mockSyncQueueOn.mockReset();
    mockSyncQueueOn.mockReturnValue(() => undefined);
    mockAddSentence.mockReset();
    mockAddSentence.mockResolvedValue({ success: true });
    mockUpdateStatsSafely.mockReset();
    mockUpdateStatsSafely.mockResolvedValue(undefined);
    mockCalculateNextReview.mockReset();
    mockCalculateNextReview.mockReturnValue({
      nextIndex: 2,
      nextDate: new Date('2026-03-28T10:00:00.000Z').getTime(),
      fsrsData: {
        scheduledDays: 1,
        reps: 1,
        stability: 2,
        difficulty: 4,
        lapses: 0,
        state: 2
      }
    });
    mockGetTodayDictations.mockImplementation(() => {
      const today = new Date().toISOString().split('T')[0];
      if (today === '2026-03-27') {
        return [{
          sentenceId: 'sentence-1',
          status: 'correct',
          timestamp: new Date('2026-03-27T09:00:00.000Z').getTime(),
          isFinished: true
        }];
      }
      return [];
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('跨天后会自动切换到新的今日默写记录', async () => {
    render(<StudyPage sentences={[sentence]} onUpdate={vi.fn(() => Promise.resolve())} />);

    await act(async () => {
      fireEvent.click(screen.getByText('默写'));
      await Promise.resolve();
    });

    expect(screen.getByText('今日成果 (1)')).toBeInTheDocument();

    await act(async () => {
      vi.setSystemTime(new Date('2026-03-28T00:01:00.000Z'));
      vi.advanceTimersByTime(60000);
    });

    expect(screen.getByText('今日成果 (0)')).toBeInTheDocument();
  });

  it('复习评分后保留当前卡片并显示继续下一个按钮', async () => {
    let latestUpdatedSentence: Sentence | null = null;

    mockAddSentence.mockImplementation(async (sentence: Sentence) => {
      latestUpdatedSentence = sentence;
      return { success: true };
    });

    const reviewSentences = Array.from({ length: 11 }, (_, index) => ({
      id: `review-${index + 1}`,
      english: `review sentence ${index + 1}`,
      chinese: `复习句子 ${index + 1}`,
      addedAt: Date.now() - 100000 - index,
      lastReviewedAt: new Date('2026-03-26T10:00:00.000Z').getTime(),
      nextReviewDate: new Date('2026-03-27T08:00:00.000Z').getTime(),
      intervalIndex: 1,
      masteryLevel: 1,
      timesReviewed: 1,
      wrongDictations: 0,
      tags: [],
      updatedAt: new Date('2026-03-26T10:00:00.000Z').getTime(),
      state: 2 as const
    }));

    const ReviewHarness = () => {
      const [items, setItems] = useState<Sentence[]>(reviewSentences);

      const handleUpdate = async () => {
        if (!latestUpdatedSentence) return;
        setItems(prev => prev.map(item => (
          item.id === latestUpdatedSentence?.id ? latestUpdatedSentence : item
        )));
      };

      return <StudyPage sentences={items} onUpdate={handleUpdate} />;
    };

    render(<ReviewHarness />);

    await act(async () => {
      fireEvent.click(screen.getByText('复习'));
      await Promise.resolve();
    });

    expect(screen.getByText('review sentence 1')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('一般'));
      await Promise.resolve();
    });

    expect(screen.getByText('review sentence 1')).toBeInTheDocument();
    expect(screen.getByText('继续下一个')).toBeInTheDocument();
  });
});
