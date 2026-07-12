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
  },

  // ==============================================
  // 单句覆盖相关方法
  // ==============================================

  /**
   * 用云端句子覆盖本地数据（绕过守卫，直接 dbService.put）
   *
   * 关键设计：
   * 1. 直接调用 dbService.put，绕过 addSentence/updateSentenceFields 的已学守卫
   *    （这是用户主动确认的覆盖操作，允许重置学习状态）
   * 2. 保留本地音频缓存路径（ttsAudioPathEl/ttsAudioPathMm）
   *    避免覆盖后丢失已下载的音频文件
   * 3. 已学句子（intervalIndex > 0）清除 scheduledDate，避免脏预约数据
   * 4. 返回备份快照，供 5 秒撤销使用
   * 5. 不覆盖 updatedAt：由调用方控制，使本地与云端 updatedAt 一致
   *    （配合乐观锁 Push，保证本地=云端的时间戳）
   *
   * @param cloudSentence 云端拉取的句子数据（updatedAt 应为调用方设定的值）
   * @returns 备份快照（覆盖前的本地数据）；若本地无此句子则返回 null
   */
  overwriteSingleSentence: async (cloudSentence: Sentence): Promise<Sentence | null> => {
    const normalizedEnglish = cloudSentence.english.trim().toLowerCase();
    const existing = await dbService.findByEnglish(normalizedEnglish);

    // 若本地无此句子，无法覆盖（也无撤销需求），直接写入新条目
    if (!existing) {
      const newEntry: Sentence = {
        ...cloudSentence,
        english: cloudSentence.english.trim(),
        // 保留传入的 updatedAt（与乐观锁 Push 的时间戳一致）
      };
      // 已学句子清除脏 scheduledDate
      if ((newEntry.intervalIndex ?? 0) > 0 && newEntry.scheduledDate) {
        newEntry.scheduledDate = undefined;
      }
      await dbService.put(newEntry);
      try { localStorage.setItem('d3s_has_data', '1'); } catch { /* ignore */ }
      return null;
    }

    // 备份覆盖前的本地状态，用于撤销
    const backup: Sentence = { ...existing };

    // 构造覆盖后的数据
    // 关键：保留本地音频路径 + 不覆盖 updatedAt（由调用方控制）
    const overwritten: Sentence = {
      ...cloudSentence,
      // 保留本地 ID（避免 ID 不一致）
      id: existing.id,
      // 保留本地音频缓存路径
      ttsAudioPathEl: existing.ttsAudioPathEl ?? cloudSentence.ttsAudioPathEl,
      ttsAudioPathMm: existing.ttsAudioPathMm ?? cloudSentence.ttsAudioPathMm,
      // 已学句子清除脏 scheduledDate（单次清除，不重复）
      scheduledDate: (cloudSentence.intervalIndex ?? 0) > 0 ? undefined : cloudSentence.scheduledDate,
      // 保留传入的 updatedAt（与乐观锁 Push 一致，不再 Date.now() 覆盖）
    };

    await dbService.put(overwritten);
    try { localStorage.setItem('d3s_has_data', '1'); } catch { /* ignore */ }

    // 不主动推送 supabaseService.syncSentences：避免覆盖后立即又被云端拉回原状态
    // 云端数据已是最新版本，无需推送

    console.log('[OVERWRITE] 单句覆盖完成 | english="' + (overwritten.english || '').substring(0, 30) + '" | intervalIndex=' + existing.intervalIndex + ' → ' + overwritten.intervalIndex);
    return backup;
  },

  /**
   * 撤销单句覆盖：用备份快照恢复本地数据
   * 同样使用 dbService.put 直接写入（绕过守卫）
   *
   * 关键：updatedAt 必须对齐云端值（cloudUpdatedAt），而非 Date.now()。
   * 若用 Date.now()，会导致 localTime > cloudTime，下次同步时将
   * backup（旧本地数据）反向推送到云端，污染其他设备。
   * 对齐后 localTime == cloudTime，同步逻辑（localTime > cloudTime 严格大于才推送）
   * 不会触发反向推送，本地保留 backup 数据、云端保持恢复数据，分歧符合预期。
   *
   * @param backup 覆盖前的本地快照
   * @param cloudUpdatedAt 恢复操作时云端/最终句子的 updatedAt（用于对齐，避免反向推送）
   */
  undoRestoreSingleSentence: async (backup: Sentence, cloudUpdatedAt?: number): Promise<void> => {
    const restored: Sentence = {
      ...backup,
      updatedAt: cloudUpdatedAt && cloudUpdatedAt > 0 ? cloudUpdatedAt : backup.updatedAt,
    };
    await dbService.put(restored);
    console.log('[OVERWRITE] 撤销单句覆盖 | english="' + (restored.english || '').substring(0, 30) + '" | intervalIndex=' + restored.intervalIndex + ' | updatedAt=' + restored.updatedAt + (cloudUpdatedAt ? ' (对齐云端)' : ' (保留原值)'));
  },
};
