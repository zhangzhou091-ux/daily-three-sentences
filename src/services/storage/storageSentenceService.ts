import { Sentence, UserStats, DictationRecord, UserSettings, ReviewRating, CardState } from '../../types';
import { dbService } from '../dbService';
import { supabaseService } from '../supabaseService';
import { fsrsService, State } from '../fsrsService';
import { localStorageService } from './localStorageService';
import { normalizeEnglish, dedupeSentencesUtil } from '../../utils/validators';

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

export const storageSentenceService = {
  /**
   * 获取所有句子（按添加时间排序）
   */
  getSentences: async (): Promise<Sentence[]> => {
    const allSentences = await dbService.getAll();
    return allSentences.sort((a, b) => a.addedAt - b.addedAt);
  },

  /**
   * 保存句子（带去重）
   */
  saveSentences: async (sentences: Sentence[]): Promise<{ saved: number; duplicates: number; skippedIds: string[] }> => {
    console.log('📥 接收到的待保存数据:', sentences);

    if (!Array.isArray(sentences)) {
      console.error('❌ 错误：传入的 sentences 不是数组');
      return { saved: 0, duplicates: 0, skippedIds: [] };
    }

    const result = dedupeSentencesUtil(sentences);
    
    const uniqueSentences = result?.unique || [];
    const skippedIds = result?.skippedIds || [];
    const duplicatesCount = sentences.length - uniqueSentences.length;

    if (duplicatesCount > 0 && import.meta.env.DEV) {
      console.log(`📊 保存去重: ${sentences.length} 条 → ${uniqueSentences.length} 条 (${duplicatesCount} 条重复)`);
    }

    const sortedSentences = uniqueSentences.sort((a, b) => a.addedAt - b.addedAt);
    const enriched = sortedSentences.map(s => ({ ...s, updatedAt: Date.now() }));
    
    await dbService.putAll(enriched);
    
    // 修复F：有数据写入时更新驱逐检测基线
    if (enriched.length > 0) {
      try { localStorage.setItem('d3s_has_data', '1'); } catch { /* ignore */ }
    }
    
    if (supabaseService.isReady) {
      try {
        await supabaseService.syncSentences(enriched);
        console.log('✅ Supabase 同步成功');
      } catch (err) {
        console.error('❌ Supabase 同步过程出错:', err);
      }
    }

    return { saved: enriched.length, duplicates: duplicatesCount, skippedIds };
  },

  /**
   * 添加句子
   */
  addSentence: async (sentence: Sentence, syncToCloud: boolean = true): Promise<{ success: boolean; message: string; duplicate?: Sentence }> => {
    const normalizedEnglish = sentence.english.trim().toLowerCase();
    const existing = await dbService.findByEnglish(normalizedEnglish);

    if (existing) {
      console.log('[TRACE-SCHEDULE] addSentence | 句子已存在，执行合并 | english="' + (sentence.english || '').substring(0, 30) + '" | existing.intervalIndex=' + existing.intervalIndex + ' | existing.scheduledDate=' + (existing.scheduledDate || '无') + ' | new.scheduledDate=' + (sentence.scheduledDate || '无') + ' | new.intervalIndex=' + (sentence.intervalIndex ?? 'undefined'));
      const updatedSentence = {
        ...existing,
        ...sentence,
        id: existing.id,
        english: sentence.english.trim(),
        updatedAt: Date.now()
      };

      // 守卫：已学句子的 intervalIndex 不允许被重置为 0，scheduledDate 必须清除
      if (existing.intervalIndex > 0 && updatedSentence.intervalIndex === 0) {
        console.warn('[TRACE-SCHEDULE] ⚠️ addSentence覆盖了学习状态 | english="' + (sentence.english || '').substring(0, 30) + '" | intervalIndex: ' + existing.intervalIndex + ' → 0 | scheduledDate: ' + (existing.scheduledDate || '无') + ' → ' + (updatedSentence.scheduledDate || '无'));
        console.log('[TRACE-CACHE] addSentence守卫触发 | 阻止覆盖已学状态 | oldIntervalIndex=' + existing.intervalIndex + ' | newIntervalIndex=0 | 保留intervalIndex=' + existing.intervalIndex + ' | 清除scheduledDate');
        updatedSentence.intervalIndex = existing.intervalIndex;
        updatedSentence.scheduledDate = undefined;
      }
      // 守卫：已学句子不允许保留 scheduledDate
      if (updatedSentence.intervalIndex > 0 && updatedSentence.scheduledDate) {
        console.log('[TRACE-CACHE] addSentence守卫 | 清除已学句子的scheduledDate | english="' + (sentence.english || '').substring(0, 30) + '" | scheduledDate=' + updatedSentence.scheduledDate + ' → undefined');
        updatedSentence.scheduledDate = undefined;
      }
      console.log('[TRACE-SCHEDULE] addSentence合并结果 | intervalIndex=' + updatedSentence.intervalIndex + ' | scheduledDate=' + (updatedSentence.scheduledDate || '无'));

      await dbService.put(updatedSentence);
      // 修复F：写入驱逐检测基线标记
      try { localStorage.setItem('d3s_has_data', '1'); } catch { /* ignore */ }
      if (syncToCloud && supabaseService.isReady) {
        supabaseService.syncSentences([updatedSentence]);
      }

      return {
        success: true,
        message: '句子已存在，已更新',
        duplicate: existing
      };
    }

    console.log('[TRACE-SCHEDULE] addSentence | 新句子 | english="' + (sentence.english || '').substring(0, 30) + '" | scheduledDate=' + (sentence.scheduledDate || '无') + ' | intervalIndex=' + (sentence.intervalIndex ?? 'undefined'));
    const entry = {
      ...sentence,
      english: sentence.english.trim(),
      updatedAt: Date.now()
    };
    await dbService.put(entry);
    // 修复F：写入驱逐检测基线标记
    try { localStorage.setItem('d3s_has_data', '1'); } catch { /* ignore */ }
    if (syncToCloud && supabaseService.isReady) supabaseService.syncSentences([entry]);
    return { success: true, message: '添加成功' };
  },

  /**
   * 检查重复
   */
  checkDuplicate: async (english: string, skipCache: boolean = false): Promise<Sentence | null> => {
    const normalizedEnglish = english.trim().toLowerCase();
    return dbService.findByEnglish(normalizedEnglish, skipCache);
  },

  /**
   * 查找重复
   */
  findDuplicates: async (): Promise<Map<string, Sentence[]>> => {
    return dbService.findDuplicates();
  },

  /**
   * 删除句子（同时从本地和云端删除）
   */
  deleteSentence: async (id: string) => {
    const sentence = (await dbService.getAll()).find(s => s.id === id);
    await dbService.delete(id);
    
    if (supabaseService.isReady && sentence) {
      await supabaseService.deleteSentence(id, sentence.english);
    }
  },

  /**
   * 局部字段更新：仅更新指定字段，保留 existing 的 intervalIndex 等学习状态。
   * 与 addSentence（全量 spread merge）不同，此方法不会用旧快照覆盖已变更的字段。
   */
  updateSentenceFields: async (english: string, fields: Partial<Sentence>, syncToCloud: boolean = true): Promise<Sentence | null> => {
    const normalizedEnglish = english.trim().toLowerCase();
    const existing = await dbService.findByEnglish(normalizedEnglish);
    if (!existing) return null;

    const updated: Sentence = {
      ...existing,
      ...fields,
      id: existing.id,
      english: existing.english,
      updatedAt: Date.now(),
    };

    // 守卫：已学句子不允许设有 scheduledDate，防止脏数据写入
    if (updated.intervalIndex > 0 && updated.scheduledDate) {
      console.warn('[TRACE-SCHEDULE] ⚠️ updateSentenceFields守卫触发 | english="' + (updated.english || '').substring(0, 30) + '" | intervalIndex=' + updated.intervalIndex + ' | 清除scheduledDate=' + updated.scheduledDate);
      console.warn('⚠️ updateSentenceFields: 已学句子不允许设置 scheduledDate，已自动清除', {
        english: updated.english,
        intervalIndex: updated.intervalIndex,
      });
      updated.scheduledDate = undefined;
    }
    
    console.log('[TRACE-SCHEDULE] updateSentenceFields | english="' + (updated.english || '').substring(0, 30) + '" | 更新字段: ' + JSON.stringify(Object.keys(fields)) + ' | 结果intervalIndex=' + updated.intervalIndex + ' | 结果scheduledDate=' + (updated.scheduledDate || '无'));

    await dbService.put(updated);

    if (syncToCloud && supabaseService.isReady) {
      supabaseService.syncSentences([updated]).catch(err => {
        console.warn('⚠️ updateSentenceFields 同步 Supabase 失败:', err instanceof Error ? err.message : String(err));
      });
    }

    return updated;
  },

  updateSentence: async (id: string, updates: Partial<Sentence>): Promise<Sentence | null> => {
    const all = await dbService.getAll();
    const sentence = all.find(s => s.id === id);
    if (!sentence) return null;

    const updated: Sentence = {
      ...sentence,
      ...updates,
      id: sentence.id,
      updatedAt: Date.now(),
    };

    await dbService.put(updated);

    if (supabaseService.isReady) {
      await supabaseService.syncSentences([updated]).catch(err => {
        console.warn('⚠️ 句子更新后同步 Supabase 失败:', err instanceof Error ? err.message : String(err));
      });
    }

    return updated;
  },

  clearSentenceAudio: async (id: string): Promise<Sentence | null> => {
    const all = await dbService.getAll();
    const sentence = all.find(s => s.id === id);
    if (!sentence) return null;

    const updated: Sentence = {
      ...sentence,
      ttsAudioPathEl: undefined,
      ttsAudioPathMm: undefined,
      updatedAt: Date.now(),
    };

    await dbService.put(updated);

    if (supabaseService.isReady) {
      await supabaseService.syncSentences([updated]).catch(err => {
        console.warn('⚠️ 清除音频后同步 Supabase 失败:', err instanceof Error ? err.message : String(err));
      });
    }

    return updated;
  },

  /**
   * 清除词汇
   */
  clearVocabulary: async () => {
    await dbService.clear();
    localStorage.removeItem('d3s_daily_selection');
    localStorage.removeItem('d3s_last_sync_time');
    localStorage.removeItem('d3s_last_incremental_sync_time');
    // 修复F：数据已清除，移除驱逐检测基线
    localStorage.removeItem('d3s_has_data');
    if (supabaseService.isReady) {
      supabaseService.syncSentences([]);
    }
  },

  /**
   * 清除所有数据
   */
  clearAllData: async () => {
    await dbService.clear();
    localStorage.clear();
    supabaseService.clearConfig();
  }
};
