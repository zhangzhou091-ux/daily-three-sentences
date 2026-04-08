import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ManagePage from './ManagePage';
import { Sentence } from '../types';

const mockCheckDuplicate = vi.fn();
const mockAddSentence = vi.fn();

vi.mock('../services/storage', () => ({
  storageService: {
    checkDuplicate: (...args: unknown[]) => mockCheckDuplicate(...args),
    addSentence: (...args: unknown[]) => mockAddSentence(...args),
    deleteSentence: vi.fn(),
    saveSentences: vi.fn()
  }
}));

vi.mock('../components/manage/StatisticsSection', () => ({
  StatisticsSection: () => <div data-testid="statistics-section" />
}));

vi.mock('../components/manage/SentenceList', () => ({
  SentenceList: () => <div data-testid="sentence-list" />
}));

describe('ManagePage duplicate guard', () => {
  const existingSentence: Sentence = {
    id: 'existing-1',
    english: 'hello world',
    chinese: '你好，世界',
    addedAt: Date.now(),
    lastReviewedAt: null,
    nextReviewDate: null,
    intervalIndex: 0,
    masteryLevel: 0,
    timesReviewed: 0,
    wrongDictations: 0,
    tags: ['greeting'],
    updatedAt: Date.now(),
    isManual: true
  };

  beforeEach(() => {
    mockCheckDuplicate.mockReset();
    mockAddSentence.mockReset();
  });

  it('检测到重复英文时仅提示冲突，不覆盖旧数据', async () => {
    mockCheckDuplicate.mockResolvedValue(existingSentence);

    render(<ManagePage sentences={[existingSentence]} onUpdate={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('录入精彩英文句子...'), {
      target: { value: 'Hello World' }
    });
    fireEvent.change(screen.getByPlaceholderText('中文翻译'), {
      target: { value: '新的翻译' }
    });
    fireEvent.click(screen.getByText('保存单条到数据库'));

    expect(await screen.findByText('该英文句子已存在')).toBeInTheDocument();
    expect(screen.getByText('已有翻译：你好，世界')).toBeInTheDocument();
    expect(mockAddSentence).not.toHaveBeenCalled();
  });
});
