import { Sentence, UserStats, DictationRecord, UserSettings, ReviewRating, CardState } from '../../types';
import { dbService } from '../dbService';
import { supabaseService } from '../supabaseService';
import { fsrsService, State } from '../fsrsService';
import { localStorageService } from './localStorageService';

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
  saveSentences: async (sentences: Sentence[]) => {
    const dedupeSentences = (sentences: Sentence[]): Sentence[] => {
      const seen = new Map<string, Sentence>();
      sentences.forEach(s => {
        const key = s.english.trim().toLowerCase();
        const existing = seen.get(key);
        if (!existing || (!s.updatedAt || !existing.updatedAt || new Date(s.updatedAt) > new Date(existing.updatedAt))) {
          seen.set(key, s);
        }
      });
      return Array.from(seen.values());
    };

    const uniqueSentences = dedupeSentences(sentences);
    if (uniqueSentences.length !== sentences.length) {
      console.log(`📊 保存去重: ${sentences.length} 条 → ${uniqueSentences.length} 条 (${sentences.length - uniqueSentences.length} 条重复)`);
    }

    const sortedSentences = uniqueSentences.sort((a, b) => a.addedAt - b.addedAt);
    const enriched = sortedSentences.map(s => ({ ...s, updatedAt: Date.now() }));
    await dbService.putAll(enriched);
    if (supabaseService.isReady) supabaseService.syncSentences(enriched);
  },

  /**
   * 添加句子
   */
  addSentence: async (sentence: Sentence, syncToCloud: boolean = true): Promise<{ success: boolean; message: string; duplicate?: Sentence }> => {
    const trimmedEnglish = sentence.english.trim().toLowerCase();
    const existing = await dbService.findByEnglish(trimmedEnglish);

    if (existing) {
      const updatedSentence = {
        ...existing,
        ...sentence,
        id: existing.id,
        english: trimmedEnglish,
        updatedAt: Date.now()
      };

      await dbService.put(updatedSentence);
      if (syncToCloud && supabaseService.isReady) {
        supabaseService.syncSentences([updatedSentence]);
      }

      return {
        success: true,
        message: '句子已存在，已更新',
        duplicate: existing
      };
    }

    const entry = {
      ...sentence,
      english: trimmedEnglish,
      updatedAt: Date.now()
    };
    await dbService.put(entry);
    if (syncToCloud && supabaseService.isReady) supabaseService.syncSentences([entry]);
    return { success: true, message: '添加成功' };
  },

  /**
   * 检查重复
   */
  checkDuplicate: async (english: string): Promise<Sentence | null> => {
    const normalizedEnglish = english.trim().toLowerCase();
    return dbService.findByEnglish(normalizedEnglish);
  },

  /**
   * 查找重复
   */
  findDuplicates: async (): Promise<Map<string, Sentence[]>> => {
    return dbService.findDuplicates();
  },

  /**
   * 删除句子
   */
  deleteSentence: async (id: string) => {
    await dbService.delete(id);
    if (supabaseService.isReady) {
      const remaining = await dbService.getAll();
      const remainingSorted = remaining.sort((a, b) => a.addedAt - b.addedAt);
      supabaseService.syncSentences(remainingSorted);
    }
  },

  /**
   * 清除词汇
   */
  clearVocabulary: async () => {
    await dbService.clear();
    localStorage.removeItem('d3s_daily_selection');
    localStorage.removeItem('d3s_last_sync_time');
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
    window.location.reload();
  }
};
