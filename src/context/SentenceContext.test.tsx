import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Sentence } from '../types';
import { mergeSentencesByUpdatedAt } from '../context/SentenceContext';

function makeSentence(overrides: Partial<Sentence> & { id: string; english: string; chinese: string }): Sentence {
  const base = Date.now();
  return {
    addedAt: base,
    lastReviewedAt: null,
    nextReviewDate: null,
    intervalIndex: 0,
    masteryLevel: 0,
    timesReviewed: 0,
    wrongDictations: 0,
    tags: [],
    updatedAt: base,
    ...overrides,
  };
}

describe('mergeSentencesByUpdatedAt — 编辑后不丢数据', () => {

  it('Scenario 0（核心回归）：本地和云端时间戳相同时，本地优先（> 而非 >=）', () => {
    const sameTime = 1717000000000;

    const local: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello World', chinese: '你好世界', updatedAt: sameTime }),
    ];
    const cloud: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello', chinese: '你好', updatedAt: sameTime }),
    ];

    const result = mergeSentencesByUpdatedAt(local, cloud);

    expect(result).toHaveLength(1);
    expect(result[0].english).toBe('Hello World');
  });

  it('Scenario 1（正常编辑）：本地编辑后 updatedAt 更新，云端还是旧值 → 本地覆盖', () => {
    const local: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello World', chinese: '你好世界', updatedAt: 1717000002000 }),
    ];
    const cloud: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello', chinese: '你好', updatedAt: 1717000001000 }),
    ];

    const result = mergeSentencesByUpdatedAt(local, cloud);

    expect(result).toHaveLength(1);
    expect(result[0].english).toBe('Hello World');
  });

  it('Scenario 2（他端编辑）：云端 updatedAt 更新，本地还在旧值 → 云端覆盖', () => {
    const local: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello', chinese: '你好', updatedAt: 1717000001000 }),
    ];
    const cloud: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello World (from cloud)', chinese: '来自云端', updatedAt: 1717000002000 }),
    ];

    const result = mergeSentencesByUpdatedAt(local, cloud);

    expect(result).toHaveLength(1);
    expect(result[0].english).toBe('Hello World (from cloud)');
  });

  it('Scenario 3（云端新句子）：云端有本地没有 → 添加', () => {
    const local: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello', chinese: '你好', updatedAt: 1717000001000 }),
    ];
    const cloud: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello', chinese: '你好', updatedAt: 1717000001000 }),
      makeSentence({ id: 's2', english: 'New from cloud', chinese: '云端新增', updatedAt: 1717000002000 }),
    ];

    const result = mergeSentencesByUpdatedAt(local, cloud);

    expect(result).toHaveLength(2);
    expect(result.map(s => s.english)).toContain('Hello');
    expect(result.map(s => s.english)).toContain('New from cloud');
  });

  it('Scenario 4（本地新句子）：本地有云端没有 → 保留本地', () => {
    const local: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello', chinese: '你好', updatedAt: 1717000001000 }),
      makeSentence({ id: 's2', english: 'New local only', chinese: '仅在本地', updatedAt: 1717000002000 }),
    ];
    const cloud: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello', chinese: '你好', updatedAt: 1717000001000 }),
    ];

    const result = mergeSentencesByUpdatedAt(local, cloud);

    expect(result).toHaveLength(2);
    expect(result.map(s => s.english)).toContain('Hello');
    expect(result.map(s => s.english)).toContain('New local only');
  });

  it('Scenario 5（多次编辑模拟）：编辑 → 刷新 → 编辑 → 刷新，每次刷新后本地编辑还在', () => {
    const t0 = 1717000000000;

    let state: Sentence[] = [
      makeSentence({ id: 's1', english: 'Hello', chinese: '你好', updatedAt: t0 }),
    ];

    const simulateRefresh = (cloudData: Sentence[]) => {
      state = mergeSentencesByUpdatedAt(state, cloudData);
    };
    const simulateEdit = (id: string, english: string, chinese: string, at: number) => {
      state = state.map(s =>
        s.id === id ? { ...s, english, chinese, updatedAt: at } : s
      );
    };

    // 第 1 次编辑：改 english
    simulateEdit('s1', 'Hello v1', '你好 v1', t0 + 100);

    // 第 1 次刷新：云端还是旧数据（推送可能延迟/失败）
    simulateRefresh([
      makeSentence({ id: 's1', english: 'Hello', chinese: '你好', updatedAt: t0 }),
    ]);
    expect(state[0].english).toBe('Hello v1');

    // 第 2 次编辑
    simulateEdit('s1', 'Hello v2', '你好 v2', t0 + 200);

    // 第 2 次刷新：云端仍是旧数据
    simulateRefresh([
      makeSentence({ id: 's1', english: 'Hello', chinese: '你好', updatedAt: t0 }),
    ]);
    expect(state[0].english).toBe('Hello v2');

    // 第 3 次编辑
    simulateEdit('s1', 'Hello v3', '你好 v3', t0 + 300);

    // 第 3 次刷新：云端终于同步了 v2（但也可能带着默认 trigger 生成的稍大时间戳）
    simulateRefresh([
      makeSentence({ id: 's1', english: 'Hello v2', chinese: '你好 v2', updatedAt: t0 + 200 }),
    ]);
    expect(state[0].english).toBe('Hello v3');
  });
});