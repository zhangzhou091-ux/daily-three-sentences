import { useState, useEffect, useRef, useCallback, type RefObject } from 'react';
import { Sentence } from '../../../types';
import { storageService } from '../../../services/storage';
import { getLocalDateString } from '../../../utils/date';
import { DAILY_LEARN_LIMIT } from '../../../constants';

// 模块级内存缓存：切换标签页时避免重新计算，0ms 渲染
let MEMORY_DAILY_CACHE: { date: string; data: Sentence[] } | null = null;

/**
 * 读取当前 MEMORY_DAILY_CACHE（只读，供诊断面板使用）。
 */
export function getMemoryDailyCache(): { date: string; data: Sentence[] } | null {
  return MEMORY_DAILY_CACHE;
}

/**
 * 外部同步更新 MEMORY_DAILY_CACHE。
 * 用于 useLearnLogic 等外部模块在更新 dailySelection state 时同步更新模块级缓存，
 * 防止组件重新挂载时从旧缓存中读取过期数据（如已学句子仍显示为未学）。
 */
export function syncMemoryDailyCache(updater: (data: Sentence[]) => Sentence[], caller?: string): void {
  const today = getLocalDateString();
  if (MEMORY_DAILY_CACHE && MEMORY_DAILY_CACHE.date === today) {
    const before = MEMORY_DAILY_CACHE.data.map(s => ({ id: s.id, english: (s.english || '').substring(0, 20), intervalIndex: s.intervalIndex, scheduledDate: s.scheduledDate }));
    MEMORY_DAILY_CACHE = { date: today, data: updater(MEMORY_DAILY_CACHE.data) };
    const after = MEMORY_DAILY_CACHE.data.map(s => ({ id: s.id, english: (s.english || '').substring(0, 20), intervalIndex: s.intervalIndex, scheduledDate: s.scheduledDate }));
    const changed = before.filter((b, i) => {
      const a = after[i];
      return a && (b.intervalIndex !== a.intervalIndex || b.scheduledDate !== a.scheduledDate);
    });
    if (changed.length > 0) {
      console.log('[TRACE-CACHE] syncMemoryDailyCache | caller=' + (caller || 'unknown') + ' | 变更=' + changed.length + '条 | before=' + JSON.stringify(before) + ' | after=' + JSON.stringify(after));
    } else {
      console.log('[TRACE-CACHE] syncMemoryDailyCache | caller=' + (caller || 'unknown') + ' | 无变更 | 缓存共' + after.length + '条');
    }
  } else {
    console.log('[TRACE-CACHE] syncMemoryDailyCache | caller=' + (caller || 'unknown') + ' | 跳过: 缓存不存在或日期不匹配 | cacheDate=' + (MEMORY_DAILY_CACHE?.date || 'null') + ' | today=' + today);
  }
}

interface UseDailySelectionProps {
  sentences: Sentence[];
  isGeneratingRef: RefObject<boolean>;
}

interface UseDailySelectionReturn {
  dailySelection: Sentence[];
  setDailySelection: React.Dispatch<React.SetStateAction<Sentence[]>>;
  generateDailySelection: () => Promise<void>;
  isGenerating: boolean;
}

export const useDailySelection = ({ 
  sentences, 
  isGeneratingRef 
}: UseDailySelectionProps): UseDailySelectionReturn => {
  const generateVersionRef = useRef(0);
  const sentencesRef = useRef(sentences);
  const hasGeneratedTodayRef = useRef(false);
  // RC#3 埋点：lastGeneratedDateRef 仅内存，PWA 冷启动后丢失
  const persistedLastGenDate = (() => {
    try { return localStorage.getItem('d3s_last_gen_date') || ''; } catch { return ''; }
  })();
  const lastGeneratedDateRef = useRef(persistedLastGenDate);
  const lastSentencesKeyRef = useRef('');
  // RC#3 埋点：记录冷启动时 lastGeneratedDateRef 的状态
  if (persistedLastGenDate) {
    const today = getLocalDateString();
    console.log('[TRACE-CROSSDAY] RC#3 | lastGeneratedDateRef 持久化恢复 | persisted=' + persistedLastGenDate + ' | today=' + today + ' | isNewDay=' + (persistedLastGenDate !== today));
  } else {
    console.log('[TRACE-CROSSDAY] RC#3 | lastGeneratedDateRef 无持久化记录 | PWA冷启动/首次使用 | 若今日缓存存在，将跳过跨日重生成');
  }

  const [dailySelection, setDailySelection] = useState<Sentence[]>(() => {
    const today = getLocalDateString();
    if (MEMORY_DAILY_CACHE && MEMORY_DAILY_CACHE.date === today) {
      hasGeneratedTodayRef.current = true;
      const cached = MEMORY_DAILY_CACHE.data;
      console.log('[TRACE-CACHE] useState从缓存初始化 | date=' + today + ' | 缓存条数=' + cached.length + ' | 明细=' + JSON.stringify(cached.map(s => ({ id: s.id, english: (s.english || '').substring(0, 20), intervalIndex: s.intervalIndex, scheduledDate: s.scheduledDate }))));
      return cached;
    }
    console.log('[TRACE-CACHE] useState初始化为空 | date=' + today + ' | cacheDate=' + (MEMORY_DAILY_CACHE?.date || 'null'));
    return [];
  });
  const [isGenerating, setIsGenerating] = useState(!hasGeneratedTodayRef.current);

  const generateDailySelection = useCallback(async () => {
    if (isGeneratingRef.current) {
      const blockedScheduled = sentences.filter(s => s.scheduledDate).length;
      console.log('[TRACE-SCHEDULE] 竞态锁阻挡 | 已有生成任务进行中 | 当前sentences含预约句子数=' + blockedScheduled + ' | 本次调用被丢弃');
      console.log('📚 generateDailySelection: 已有生成任务进行中，跳过');
      return;
    }
    
    isGeneratingRef.current = true;
    setIsGenerating(true);
    const currentVersion = ++generateVersionRef.current;
    
    const sentencesSnapshot = [...sentences];
    const sentenceMap = new Map<string, Sentence>();
    sentencesSnapshot.forEach(s => sentenceMap.set(s.id, s));
    
    // 埋点：记录 snapshots 中所有预约句子
    const snapScheduled = sentencesSnapshot.filter(s => s.scheduledDate);
    if (snapScheduled.length > 0) {
      console.log('[TRACE-SCHEDULE] sentencesSnapshot快照 | 预约句子共' + snapScheduled.length + '条');
      snapScheduled.forEach(s => {
        console.log('[TRACE-SCHEDULE]   快照中: english="' + (s.english || '').substring(0, 30) + '" | scheduledDate=' + s.scheduledDate + ' | intervalIndex=' + s.intervalIndex + ' | id=' + s.id);
      });
    }
    
    try {
      if (!sentencesSnapshot.length) {
        console.log('📚 generateDailySelection: sentences数组为空');
        if (currentVersion === generateVersionRef.current) {
          setDailySelection([]);
          setIsGenerating(false);
          hasGeneratedTodayRef.current = true;
          isGeneratingRef.current = false;
        }
        return;
      }
      
      const LIMIT = DAILY_LEARN_LIMIT;
      const totalSentences = sentencesSnapshot.length;
      const unlearnedSentences = sentencesSnapshot.filter(s => s.intervalIndex === 0);
      const learnedSentences = sentencesSnapshot.filter(s => s.intervalIndex > 0);
      console.log(`📚 generateDailySelection: 总句子数=${totalSentences}, 未学习=${unlearnedSentences.length}, 已学习=${learnedSentences.length}`);
      
      const now = new Date();
      const todayDateStr = getLocalDateString(now);
      console.log('[TRACE-SCHEDULE] generateDailySelection开始 | todayDateStr=' + todayDateStr + ' | 总句子=' + totalSentences + ' | 未学=' + unlearnedSentences.length + ' | 已学=' + learnedSentences.length);
      
      const filterAndSortAvailable = (pool: Sentence[], excludeIds: Set<string>): Sentence[] => {
        const available = pool.filter(s => 
          s.intervalIndex === 0 && 
          !excludeIds.has(s.id) &&
          (!s.scheduledDate || s.scheduledDate <= todayDateStr)
        );
        const scheduled = available.filter(s => !!s.scheduledDate);
        const manualNotScheduled = available.filter(s => !s.scheduledDate && s.isManual === true);
        const importedNotScheduled = available.filter(s => !s.scheduledDate && (s.isManual === false || s.isManual === undefined));
        return [
          ...scheduled.sort((a, b) => a.addedAt - b.addedAt),
          ...manualNotScheduled.sort((a, b) => a.addedAt - b.addedAt),
          ...importedNotScheduled.sort((a, b) => a.addedAt - b.addedAt),
        ];
      };

      let retained: Sentence[] = [];

      const savedIds = await storageService.getTodaySelection();
      console.log('[TRACE-SCHEDULE] savedIds加载 | 缓存ID数=' + savedIds.length + ' | ids=[' + savedIds.join(',') + ']');
      
      let forceRegenerate = false;
      if (savedIds.length > 0) {
        console.log('[TRACE-SCHEDULE] 进入缓存路径 | 将逐条检查缓存句子的有效性');
        savedIds.forEach((id: string) => {
          const sentence = sentenceMap.get(id);
          if (!sentence) {
            console.log(`📚 generateDailySelection: 跳过已删除的句子ID: ${id}`);
            return;
          }
          if (sentence.scheduledDate && sentence.scheduledDate > todayDateStr) {
            console.log(`📚 generateDailySelection: 跳过预约日期未到的句子: ${id}`);
            return;
          }
          const isLearnedToday = sentence.lastReviewedAt
            ? getLocalDateString(new Date(sentence.lastReviewedAt)) === todayDateStr
            : false;
          if (sentence.intervalIndex === 0) {
            retained.push(sentence);
          } else if (isLearnedToday && !sentence.scheduledDate) {
            retained.push(sentence);
          }
        });
        console.log(`📚 generateDailySelection: 从缓存中加载了 ${retained.length} 个句子`);
        console.log('[TRACE-SCHEDULE] 缓存路径结果 | retained=' + retained.length + ' | forceRegenerate=' + forceRegenerate);
        
        if (retained.length === 0 && sentencesSnapshot.length > 0) {
          console.log('📚 generateDailySelection: 缓存为空但有新句子，强制重新生成');
          forceRegenerate = true;
        }
        
        if (!forceRegenerate && retained.length > 0) {
          const hasOutdatedCache = retained.some(s => {
            if (s.learnedAt) {
              const learnedDate = getLocalDateString(new Date(s.learnedAt));
              if (learnedDate !== todayDateStr && s.intervalIndex > 0) {
                return true;
              }
            }
            return false;
          });
          
          console.log('[TRACE-SCHEDULE] hasOutdatedCache检查 | 结果=' + hasOutdatedCache + ' | retained句子的intervalIndex=[' + retained.map(s => s.intervalIndex).join(',') + '] | learnedAt=[' + retained.map(s => s.learnedAt ? getLocalDateString(new Date(s.learnedAt)) : 'null').join(',') + ']');
          
          // RC#1 埋点：检查缓存里是否有新预约句子未被包含
          if (!hasOutdatedCache && retained.length >= LIMIT) {
            const cachedIdSet = new Set(retained.map(r => r.id));
            const newScheduledToday = sentencesSnapshot.filter(s =>
              s.scheduledDate && s.scheduledDate <= todayDateStr &&
              s.intervalIndex === 0 && !cachedIdSet.has(s.id)
            );
            if (newScheduledToday.length > 0) {
              console.log('[TRACE-SCHEDULE] RC#1 ⚠️ 缓存路径缺失新预约句子 | 有' + newScheduledToday.length + '条今日/过期预约句子不在缓存中 | retained=' + retained.length + '/' + LIMIT + ' | forceRegenerate=false 导致被跳过');
              newScheduledToday.forEach(s => {
                console.log('[TRACE-SCHEDULE]   RC#1 ⚠️ 缺失: english="' + (s.english || '').substring(0, 30) + '" | scheduledDate=' + s.scheduledDate + ' | todayDateStr=' + todayDateStr + ' | intervalIndex=' + s.intervalIndex + ' | 未进入retained');
              });
            }
          }
          
          if (hasOutdatedCache) {
            console.log('📚 generateDailySelection: 检测到缓存数据已过期（跨日），强制重新生成');
            console.log('[TRACE-SCHEDULE] 触发forceRegenerate | 原因: hasOutdatedCache=true');
            forceRegenerate = true;
            retained = [];
          } else {
            console.log('[TRACE-SCHEDULE] 维持缓存路径 | forceRegenerate=false | 不重新检查优先级');
          }
        }
      } else {
        console.log('[TRACE-SCHEDULE] savedIds为空 | 触发forceRegenerate');
        forceRegenerate = true;
      }

      if (forceRegenerate) {
        retained = [];
        const retainedIdSet = new Set<string>();
        
        const yesterdayIds = storageService.getYesterdaySelection();
        console.log(`📚 generateDailySelection: 昨日学习列表=${yesterdayIds.length}个句子`);
        
        // 优先级1: 昨日遗留的未学句子（最高优先）
        yesterdayIds.forEach(id => {
          if (retained.length >= LIMIT) return;
          const s = sentenceMap.get(id);
          if (!s) {
            console.log(`📚 generateDailySelection: 跳过昨日已删除的句子ID: ${id}`);
            return;
          }
          if (s.scheduledDate && s.scheduledDate > todayDateStr) {
            console.log(`📚 generateDailySelection: 跳过预约日期未到的继承句子: ${id}`);
            return;
          }
          if (s.intervalIndex === 0) {
            retained.push(s);
            retainedIdSet.add(s.id);
          }
        });
        
        console.log(`📚 generateDailySelection: 优先级1 昨日遗留=${retained.length}个`);
        
        // RC#2 埋点：昨日遗留是否挤占了所有名额
        if (retained.length >= LIMIT) {
          const todayScheduled = sentencesSnapshot.filter(s =>
            s.scheduledDate && s.scheduledDate <= todayDateStr &&
            s.intervalIndex === 0
          );
          if (todayScheduled.length > 0) {
            console.log('[TRACE-SCHEDULE] RC#2 ⚠️ 昨日遗留挤占全部名额 | 昨日遗留=' + retained.length + '/' + LIMIT + ' | 今日/过期预约句子=' + todayScheduled.length + '条被挤出 | 预约句: ' + todayScheduled.map(s => '"' + (s.english || '').substring(0, 20) + '"(' + s.scheduledDate + ')').join(', '));
          }
        }
        
        // 优先级2: 今日及过期的预约句子
        if (retained.length < LIMIT) {
          const scheduledSentences = sentencesSnapshot.filter(s => 
            s.scheduledDate && s.scheduledDate <= todayDateStr && 
            s.intervalIndex === 0 && 
            !retainedIdSet.has(s.id)
          ).sort((a, b) => a.addedAt - b.addedAt);
          
          console.log('[TRACE-SCHEDULE] 优先级2候选 | 今日及过期预约句子=' + scheduledSentences.length + '条 | 当前retained=' + retained.length + '/' + LIMIT);
          scheduledSentences.forEach(s => {
            const willSelect = retained.length < LIMIT;
            console.log('[TRACE-SCHEDULE]   优先级2: english="' + (s.english || '').substring(0, 30) + '" | scheduledDate=' + s.scheduledDate + ' | ' + (willSelect ? '✅入选' : '❌跳过(已满)'));
          });
          
          for (const s of scheduledSentences) {
            if (retained.length >= LIMIT) break;
            retained.push(s);
            retainedIdSet.add(s.id);
          }
          
          console.log(`📚 generateDailySelection: 优先级2 今日预约 补充后总计=${retained.length}个`);
        }
        
        // 优先级3: 无预约日期的普通句子（手动录入优先）
        if (retained.length < LIMIT) {
          const manualSentences = sentencesSnapshot.filter(s => 
            !s.scheduledDate && 
            s.intervalIndex === 0 &&
            s.isManual === true &&
            !retainedIdSet.has(s.id)
          ).sort((a, b) => a.addedAt - b.addedAt);
          
          for (const s of manualSentences) {
            if (retained.length >= LIMIT) break;
            retained.push(s);
            retainedIdSet.add(s.id);
          }
        }
        
        if (retained.length < LIMIT) {
          const importedSentences = sentencesSnapshot.filter(s => 
            !s.scheduledDate && 
            s.intervalIndex === 0 &&
            (s.isManual === false || s.isManual === undefined) &&
            !retainedIdSet.has(s.id)
          ).sort((a, b) => a.addedAt - b.addedAt);
          
          for (const s of importedSentences) {
            if (retained.length >= LIMIT) break;
            retained.push(s);
            retainedIdSet.add(s.id);
          }
        }
        
        console.log(`📚 generateDailySelection: 优先级3 普通句子 最终总计=${retained.length}个`);
      } else {
        let needCount = LIMIT - retained.length;
        console.log('[TRACE-SCHEDULE] 缓存路径补充 | 需要补充=' + needCount + '条 | 当前retained=' + retained.length + '/' + LIMIT);
        if (needCount > 0) {
          const retainedIdSet = new Set(retained.map(r => r.id));
          const sortedAll = filterAndSortAvailable(sentencesSnapshot, retainedIdSet);
          
          const supplementSentences = sortedAll.slice(0, needCount);
          console.log('[TRACE-SCHEDULE] 补充结果 | 补充了' + supplementSentences.length + '条 | 句子=[' + supplementSentences.map(s => (s.english || '').substring(0, 20)).join(',') + ']');
          retained.push(...supplementSentences);
        }
      }

      const finalSelection = retained.slice(0, LIMIT);
      
      console.log('[TRACE-SCHEDULE] finalSelection | 共' + finalSelection.length + '条');
      finalSelection.forEach((s, i) => {
        console.log('[TRACE-SCHEDULE]   #' + (i + 1) + ': english="' + (s.english || '').substring(0, 30) + '" | scheduledDate=' + (s.scheduledDate || '无') + ' | intervalIndex=' + s.intervalIndex + ' | id=' + s.id);
      });
      
      const finalIdSet = new Set(finalSelection.map(s => s.id));
      const missedScheduled = sentencesSnapshot.filter(s => 
        s.scheduledDate && 
        s.scheduledDate <= todayDateStr && 
        s.intervalIndex === 0 && 
        !finalIdSet.has(s.id)
      );
      
      console.log(`📚 generateDailySelection: 最终选择=${finalSelection.length}个句子`);
      console.log('[TRACE-SCHEDULE] missedScheduled检测 | 候选=' + missedScheduled.length + '条 | finalIdSet=[' + [...finalIdSet].join(',') + ']');
      missedScheduled.forEach(s => {
        console.log('[TRACE-SCHEDULE]   missedScheduled: english="' + (s.english || '').substring(0, 30) + '" | scheduledDate=' + s.scheduledDate + ' | todayDateStr=' + todayDateStr);
      });
      
      // 1. 先更新 UI 状态，让页面立即渲染
      if (currentVersion === generateVersionRef.current) {
        setDailySelection(finalSelection);
        hasGeneratedTodayRef.current = true;
        console.log('[TRACE-CACHE] generateDailySelection更新缓存 | date=' + todayDateStr + ' | 条数=' + finalSelection.length + ' | 明细=' + JSON.stringify(finalSelection.map(s => ({ id: s.id, english: (s.english || '').substring(0, 20), intervalIndex: s.intervalIndex, scheduledDate: s.scheduledDate }))));
        MEMORY_DAILY_CACHE = { date: todayDateStr, data: finalSelection };
      }

      // 2. 等待数据库写入完成后再释放锁，防止竞态导致数据错乱
      if (finalSelection.length > 0) {
        console.log('[TRACE-SCHEDULE] saveTodaySelection | date=' + todayDateStr + ' | ids=[' + finalSelection.map(s => s.id).join(',') + ']');
        await storageService.saveTodaySelection(finalSelection.map(s => s.id));
      }

      if (missedScheduled.length > 0) {
        console.log('[TRACE-SCHEDULE] 开始顺延处理 | missedScheduled共' + missedScheduled.length + '条');
        const tomorrowDate = new Date(now);
        tomorrowDate.setDate(tomorrowDate.getDate() + 1);
        const tomorrowStr = getLocalDateString(tomorrowDate);

        let rescheduledCount = 0;
        let skippedCount = 0;

        for (const sentence of missedScheduled) {
          // 方案A：顺延前用最新数据校验，避免过期快照覆盖已学状态
          const latest = await storageService.checkDuplicate(sentence.english, true);
          if (latest && latest.intervalIndex > 0) {
            // 句子已被学习，不再顺延，并确保 scheduledDate 清空
            console.log('[TRACE-SCHEDULE] 顺延跳过(已学) | english="' + (sentence.english || '').substring(0, 30) + '" | latest.intervalIndex=' + latest.intervalIndex);
            await storageService.updateSentenceFields(sentence.english, { scheduledDate: undefined });
            skippedCount++;
            continue;
          }
          // 方案B：仅更新 scheduledDate 字段，不覆盖 intervalIndex 等学习状态
          console.log('[TRACE-SCHEDULE] 顺延执行 | english="' + (sentence.english || '').substring(0, 30) + '" | 原scheduledDate=' + sentence.scheduledDate + ' → 新scheduledDate=' + tomorrowStr);
          await storageService.updateSentenceFields(sentence.english, { scheduledDate: tomorrowStr });
          rescheduledCount++;
        }

        if (rescheduledCount > 0 || skippedCount > 0) {
          console.log(`📚 后台静默处理：${rescheduledCount} 个预约句子顺延至 ${tomorrowStr}，${skippedCount} 个已学句子跳过顺延`);
        }
      }

      // 方案C：清理基于最新库数据，不使用过期快照
      const allDbSentences = await storageService.getSentences();
      const learnedButScheduled = allDbSentences.filter(s =>
        s.scheduledDate &&
        s.intervalIndex > 0
      );

      if (learnedButScheduled.length > 0) {
        console.log('[TRACE-SCHEDULE] learnedButScheduled脏数据清理 | 共' + learnedButScheduled.length + '条');
        learnedButScheduled.forEach(s => {
          console.log('[TRACE-SCHEDULE]   脏数据: english="' + (s.english || '').substring(0, 30) + '" | intervalIndex=' + s.intervalIndex + ' | scheduledDate=' + s.scheduledDate);
        });
        const clearPromises = learnedButScheduled.map(sentence =>
          storageService.updateSentenceFields(sentence.english, { scheduledDate: undefined })
        );
        await Promise.all(clearPromises);
        console.log(`📚 后台静默清理：${learnedButScheduled.length} 个已学句子的预约日期已清除`);
      } else {
        console.log('[TRACE-SCHEDULE] learnedButScheduled检查 | 无脏数据 ✅');
      }
      
      console.log('[TRACE-SCHEDULE] generateDailySelection完成 | finalSelection=[' + finalSelection.map(s => (s.english || '').substring(0, 20)).join(',') + ']');
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('生成每日选择失败:', err.message);
      } else {
        console.error('生成每日选择失败:', String(err));
      }
      if (currentVersion === generateVersionRef.current) {
        setDailySelection([]);
      }
    } finally {
      // 无论成功还是异常，都在 finally 中统一释放锁并更新 loading 状态
      isGeneratingRef.current = false;
      setIsGenerating(false);
    }
  }, [sentences, isGeneratingRef]);

  useEffect(() => {
    const today = getLocalDateString();
    // RC#5 埋点：sentencesChanged 签名计算
    const updatedAtSum = sentences.reduce((sum, s) => sum + (s.updatedAt || 0), 0);
    const scheduledSig = sentences
      .filter(s => s.scheduledDate)
      .map(s => s.id + ':' + s.scheduledDate)
      .sort()
      .join('|');
    const currentSentencesKey = `${sentences.length}|${updatedAtSum}|${scheduledSig}`;
    const sentencesChanged = lastSentencesKeyRef.current !== currentSentencesKey;
    const isNewDay = lastGeneratedDateRef.current !== '' && lastGeneratedDateRef.current !== today;

    // RC#5 埋点：输出 sentencesChanged 签名详情
    console.log('[TRACE-SENTINEL] RC#5 | sentencesChanged=' + sentencesChanged + ' | isNewDay=' + isNewDay + ' | hasGenerated=' + hasGeneratedTodayRef.current + ' | len=' + sentences.length + ' | updatedAtSum=' + updatedAtSum + ' | scheduledSig=' + (scheduledSig || '(空)') + ' | lastKey=' + lastSentencesKeyRef.current + ' → newKey=' + currentSentencesKey);

    if (isNewDay) {
      console.log('📚 useDailySelection: 检测到跨日，重置生成标志');
      console.log('[TRACE-SCHEDULE] useEffect触发 | 原因: 跨日 | lastGenerated=' + lastGeneratedDateRef.current + ' → today=' + today);
      hasGeneratedTodayRef.current = false;
    }

    if (sentencesChanged || isNewDay || !hasGeneratedTodayRef.current) {
      const triggerReason = isNewDay ? '跨日' : (sentencesChanged ? 'sentences变化' : '首次生成');
      console.log('[TRACE-SCHEDULE] useEffect触发generateDailySelection | 原因: ' + triggerReason + ' | sentences数=' + sentences.length + ' | hasGenerated=' + hasGeneratedTodayRef.current);
      lastSentencesKeyRef.current = currentSentencesKey;
      sentencesRef.current = sentences;
      lastGeneratedDateRef.current = today;
      // RC#3 埋点：持久化 lastGeneratedDate
      try { localStorage.setItem('d3s_last_gen_date', today); } catch { /* ignore */ }
      generateDailySelection();
    }
  }, [sentences, generateDailySelection]);

  // 跨日检测：独立 Effect，不依赖 sentences。
  // 解决 SPA 跨夜场景：用户不刷新页面跨过午夜后，原 useEffect 因 [sentences, generateDailySelection]
  // 依赖未变化而不再执行，isNewDay 检测形同虚设，导致今日预约句子不出现、昨日数据被沿用。
  // 双保险：
  //   1. visibilitychange — 用户从后台/息屏切回前台时立即检测（覆盖手机端最常见的场景）
  //   2. setInterval(60s) — 即使用户一直停留前台也能在 1 分钟内感知跨日
  // RC#4 埋点：记录每次跨日检测触发方式
  useEffect(() => {
    let lastCheckTime = Date.now();
    
    const checkCrossDay = () => {
      if (isGeneratingRef.current) {
        console.log('[TRACE-CROSSDAY] RC#4 | 跨日检测跳过 | 原因: isGenerating=true');
        return;
      }

      const now = Date.now();
      const elapsed = now - lastCheckTime;
      lastCheckTime = now;
      const today = getLocalDateString();
      // 仅在已生成过（lastGeneratedDateRef 非空）且日期不一致时触发
      if (lastGeneratedDateRef.current && lastGeneratedDateRef.current !== today) {
        console.log(`[TRACE-CROSSDAY] RC#4 | 跨日检测命中 | 距上次检测=${elapsed}ms | 上次生成=${lastGeneratedDateRef.current} | 今天=${today} | 触发重新生成`);
        console.log(`📚 useDailySelection: 检测到跨日（上次生成日期: ${lastGeneratedDateRef.current}，今天: ${today}），触发重新生成`);
        console.log('[TRACE-SCHEDULE] crossDayEffect触发 | 上次=' + lastGeneratedDateRef.current + ' | 今天=' + today);
        hasGeneratedTodayRef.current = false;
        lastGeneratedDateRef.current = today;
        generateDailySelection();
      } else {
        console.log('[TRACE-CROSSDAY] RC#4 | 跨日检测未命中 | 距上次检测=' + elapsed + 'ms | lastGenerated=' + (lastGeneratedDateRef.current || '(空)') + ' | today=' + today);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      console.log('[TRACE-CROSSDAY] RC#4 | visibilitychange触发 | visibilityState=' + document.visibilityState);
      checkCrossDay();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // RC#4 埋点：pageshow 事件覆盖 BFCache 恢复场景
    const handlePageShow = (event: PageTransitionEvent) => {
      console.log('[TRACE-CROSSDAY] RC#4 | pageshow触发 | persisted=' + event.persisted + ' | 从BFCache恢复=' + (event.persisted ? '是' : '否'));
      if (event.persisted) {
        checkCrossDay();
      }
    };
    window.addEventListener('pageshow', handlePageShow);

    const intervalId = window.setInterval(() => {
      console.log('[TRACE-CROSSDAY] RC#4 | setInterval(60s) 定时检测触发');
      checkCrossDay();
    }, 60000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
      window.clearInterval(intervalId);
    };
  }, [generateDailySelection]);

  return {
    dailySelection,
    setDailySelection,
    generateDailySelection,
    isGenerating,
  };
};
