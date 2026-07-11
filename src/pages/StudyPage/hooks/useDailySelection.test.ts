import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { RefObject } from 'react';
import type { Sentence } from '../../../types';

// ============ vi.hoisted: 声明 mock 状态和函数(在 vi.mock 提升前可用) ============
const { mockState, mocks } = vi.hoisted(() => ({
  mockState: { today: '2026-07-05' },
  mocks: {
    getTodaySelection: vi.fn(),
    getYesterdaySelection: vi.fn(),
    saveTodaySelection: vi.fn(),
    getSentences: vi.fn(),
    checkDuplicate: vi.fn(),
    updateSentenceFields: vi.fn(),
  },
}));

// ============ vi.mock ============
vi.mock('../../../utils/date', () => ({
  getLocalDateString: () => mockState.today,
}));

vi.mock('../../../services/storage', () => ({
  storageService: {
    getTodaySelection: mocks.getTodaySelection,
    getYesterdaySelection: mocks.getYesterdaySelection,
    saveTodaySelection: mocks.saveTodaySelection,
    getSentences: mocks.getSentences,
    checkDuplicate: mocks.checkDuplicate,
    updateSentenceFields: mocks.updateSentenceFields,
  },
}));

// ============ 静态 import(在 mock 设置后,vi.mock 会被提升到此前执行) ============
import { useDailySelection } from './useDailySelection';

// ============ 测试工具 ============
const createSentence = (overrides: Partial<Sentence>): Sentence => ({
  id: overrides.id || 'sentence-1',
  english: overrides.english || 'This is a sample sentence.',
  chinese: overrides.chinese || '这是一个示例句子。',
  addedAt: overrides.addedAt || Date.now(),
  lastReviewedAt: overrides.lastReviewedAt ?? null,
  nextReviewDate: overrides.nextReviewDate ?? null,
  intervalIndex: overrides.intervalIndex ?? 0,
  masteryLevel: overrides.masteryLevel ?? 0,
  timesReviewed: overrides.timesReviewed ?? 0,
  wrongDictations: overrides.wrongDictations ?? 0,
  tags: overrides.tags || [],
  updatedAt: overrides.updatedAt || Date.now(),
  isManual: overrides.isManual,
  scheduledDate: overrides.scheduledDate,
  stability: overrides.stability,
  difficulty: overrides.difficulty,
  learnedAt: overrides.learnedAt,
  ttsAudioPathEl: overrides.ttsAudioPathEl,
  ttsAudioPathMm: overrides.ttsAudioPathMm,
});

// ============ 测试用例 ============
// 测试目标:验证 generateDailySelection 的核心选择逻辑
// 重点覆盖 Bug 1(预约句子未入选)和 Bug 2(已学句子逃逸)的关键分支
let testCounter = 0;

describe('useDailySelection', () => {
  beforeEach(() => {
    testCounter++;
    // 每个测试用不同日期,避免模块级 MEMORY_DAILY_CACHE 污染(缓存 date !== today 会触发重新生成)
    mockState.today = `2026-07-${String(4 + testCounter).padStart(2, '0')}`;

    vi.clearAllMocks();
    localStorage.clear();

    // 默认 mock 返回值:无缓存、无昨日遗留、存储操作成功
    mocks.getTodaySelection.mockResolvedValue([]);
    mocks.getYesterdaySelection.mockReturnValue([]);
    mocks.saveTodaySelection.mockResolvedValue(undefined);
    mocks.getSentences.mockResolvedValue([]);
    mocks.checkDuplicate.mockResolvedValue(null);
    mocks.updateSentenceFields.mockResolvedValue(null);
  });

  // ====== Bug 1 核心分支:预约句子必须入选 ======

  it('Bug1#1 空句子数组 → 空 selection', async () => {
    const isGeneratingRef = { current: false };

    const { result } = renderHook(() => useDailySelection({
      sentences: [],
      isGeneratingRef: isGeneratingRef as RefObject<boolean>,
    }));

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    expect(result.current.dailySelection).toEqual([]);
  });

  it('Bug1#2 今日预约句子 + 无缓存 → 预约句子入选', async () => {
    const scheduled = createSentence({
      id: 'scheduled-1',
      english: 'Scheduled sentence',
      scheduledDate: mockState.today,
      intervalIndex: 0,
      isManual: true,
    });

    const isGeneratingRef = { current: false };

    const { result } = renderHook(() => useDailySelection({
      sentences: [scheduled],
      isGeneratingRef: isGeneratingRef as RefObject<boolean>,
    }));

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    expect(result.current.dailySelection.length).toBeGreaterThan(0);
    expect(result.current.dailySelection[0].id).toBe('scheduled-1');
  });

  it('Bug1#3 过期预约句子(scheduledDate < today) → 仍入选', async () => {
    const expired = createSentence({
      id: 'expired-1',
      english: 'Expired scheduled',
      // 用昨天日期模拟过期(直接用字符串,不依赖 mockState)
      scheduledDate: '2020-01-01',
      intervalIndex: 0,
      isManual: true,
    });

    const isGeneratingRef = { current: false };

    const { result } = renderHook(() => useDailySelection({
      sentences: [expired],
      isGeneratingRef: isGeneratingRef as RefObject<boolean>,
    }));

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    expect(result.current.dailySelection.length).toBeGreaterThan(0);
    expect(result.current.dailySelection[0].id).toBe('expired-1');
  });

  it('Bug1#4 预约日期未到的句子(scheduledDate > today) → 不入选', async () => {
    const future = createSentence({
      id: 'future-1',
      english: 'Future scheduled',
      scheduledDate: '2099-12-31',
      intervalIndex: 0,
      isManual: true,
    });

    const isGeneratingRef = { current: false };

    const { result } = renderHook(() => useDailySelection({
      sentences: [future],
      isGeneratingRef: isGeneratingRef as RefObject<boolean>,
    }));

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    expect(result.current.dailySelection.find(s => s.id === 'future-1')).toBeUndefined();
  });

  // ====== Bug 2 核心分支:已学句子不得逃逸到 selection ======

  it('Bug2#1 已学句子(intervalIndex > 0)不出现在 selection', async () => {
    const learned = createSentence({
      id: 'learned-1',
      english: 'Learned sentence',
      intervalIndex: 2,
      learnedAt: Date.now(),
      isManual: true,
    });

    const isGeneratingRef = { current: false };

    const { result } = renderHook(() => useDailySelection({
      sentences: [learned],
      isGeneratingRef: isGeneratingRef as RefObject<boolean>,
    }));

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    expect(result.current.dailySelection.find(s => s.id === 'learned-1')).toBeUndefined();
  });

  it('Bug2#2 已学+仍有 scheduledDate 的脏数据 → 不入选且不抛错', async () => {
    const dirty = createSentence({
      id: 'dirty-1',
      english: 'Dirty learned',
      intervalIndex: 3,
      scheduledDate: mockState.today,
      learnedAt: Date.now(),
      isManual: true,
    });

    const isGeneratingRef = { current: false };

    const { result } = renderHook(() => useDailySelection({
      sentences: [dirty],
      isGeneratingRef: isGeneratingRef as RefObject<boolean>,
    }));

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    // 已学句子即使有 scheduledDate 也不入选
    expect(result.current.dailySelection.find(s => s.id === 'dirty-1')).toBeUndefined();
  });

  // ====== 缓存路径分支 ======

  it('Cache#1 缓存命中且数据有效 → 维持缓存', async () => {
    const cached = createSentence({
      id: 'cached-1',
      english: 'Cached sentence',
      scheduledDate: mockState.today,
      intervalIndex: 0,
      isManual: true,
    });

    // 模拟缓存命中:storageService.getTodaySelection 返回缓存的 ID
    mocks.getTodaySelection.mockResolvedValue(['cached-1']);
    // getSentences 返回当前句子(用于 learnedButScheduled 清理)
    mocks.getSentences.mockResolvedValue([cached]);

    const isGeneratingRef = { current: false };

    const { result } = renderHook(() => useDailySelection({
      sentences: [cached],
      isGeneratingRef: isGeneratingRef as RefObject<boolean>,
    }));

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    expect(result.current.dailySelection.find(s => s.id === 'cached-1')).toBeDefined();
  });

  // ====== 优先级分支 ======

  it('Priority#1 预约句子优先于普通句子入选', async () => {
    const scheduled = createSentence({
      id: 'scheduled-p1',
      english: 'Scheduled priority',
      scheduledDate: mockState.today,
      intervalIndex: 0,
      isManual: true,
      addedAt: 200,
    });
    const normal = createSentence({
      id: 'normal-p2',
      english: 'Normal sentence',
      intervalIndex: 0,
      isManual: true,
      addedAt: 100,
    });

    const isGeneratingRef = { current: false };

    const { result } = renderHook(() => useDailySelection({
      sentences: [normal, scheduled],
      isGeneratingRef: isGeneratingRef as RefObject<boolean>,
    }));

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    // 两个句子都在 LIMIT=3 内,都应入选
    expect(result.current.dailySelection.length).toBe(2);
    // 预约句子应在普通句子之前(优先级2 < 优先级3)
    expect(result.current.dailySelection[0].id).toBe('scheduled-p1');
    expect(result.current.dailySelection[1].id).toBe('normal-p2');
  });
});
