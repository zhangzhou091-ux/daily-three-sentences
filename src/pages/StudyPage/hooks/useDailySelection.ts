import { useState, useEffect, useRef, useCallback, type RefObject } from 'react';
import { Sentence } from '../../../types';
import { storageService } from '../../../services/storage';
import { getLocalDateString } from '../../../utils/date';
import { DAILY_LEARN_LIMIT } from '../../../constants';

interface UseDailySelectionProps {
  sentences: Sentence[];
  isGeneratingRef: RefObject<boolean>;
}

interface UseDailySelectionReturn {
  dailySelection: Sentence[];
  setDailySelection: React.Dispatch<React.SetStateAction<Sentence[]>>;
  generateDailySelection: () => Promise<void>;
}

export const useDailySelection = ({ 
  sentences, 
  isGeneratingRef 
}: UseDailySelectionProps): UseDailySelectionReturn => {
  const [dailySelection, setDailySelection] = useState<Sentence[]>([]);
  
  const generateVersionRef = useRef(0);
  const sentencesRef = useRef(sentences);
  const hasGeneratedTodayRef = useRef(false);
  const lastGeneratedDateRef = useRef('');
  const lastSentencesKeyRef = useRef('');

  const generateDailySelection = useCallback(async () => {
    if (isGeneratingRef.current) {
      console.log('📚 generateDailySelection: 已有生成任务进行中，跳过');
      return;
    }
    
    isGeneratingRef.current = true;
    const currentVersion = ++generateVersionRef.current;
    
    const sentencesSnapshot = [...sentences];
    const sentenceMap = new Map<string, Sentence>();
    sentencesSnapshot.forEach(s => sentenceMap.set(s.id, s));
    
    try {
      if (!sentencesSnapshot.length) {
        console.log('📚 generateDailySelection: sentences数组为空');
        if (currentVersion === generateVersionRef.current) {
          setDailySelection([]);
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
      
      let forceRegenerate = false;
      if (savedIds.length > 0) {
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
          if (sentence.intervalIndex === 0 || isLearnedToday) {
            retained.push(sentence);
          }
        });
        console.log(`📚 generateDailySelection: 从缓存中加载了 ${retained.length} 个句子`);
        
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
          
          if (hasOutdatedCache) {
            console.log('📚 generateDailySelection: 检测到缓存数据已过期（跨日），强制重新生成');
            forceRegenerate = true;
            retained = [];
          }
        }
      } else {
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
        
        // 优先级2: 今日及过期的预约句子
        if (retained.length < LIMIT) {
          const scheduledSentences = sentencesSnapshot.filter(s => 
            s.scheduledDate && s.scheduledDate <= todayDateStr && 
            s.intervalIndex === 0 && 
            !retainedIdSet.has(s.id)
          ).sort((a, b) => a.addedAt - b.addedAt);
          
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
        if (needCount > 0) {
          const retainedIdSet = new Set(retained.map(r => r.id));
          const sortedAll = filterAndSortAvailable(sentencesSnapshot, retainedIdSet);
          
          const supplementSentences = sortedAll.slice(0, needCount);
          retained.push(...supplementSentences);
        }
      }

      const finalSelection = retained.slice(0, LIMIT);
      
      const finalIdSet = new Set(finalSelection.map(s => s.id));
      const missedScheduled = sentencesSnapshot.filter(s => 
        s.scheduledDate && 
        s.scheduledDate <= todayDateStr && 
        s.intervalIndex === 0 && 
        !finalIdSet.has(s.id)
      );
      
      if (missedScheduled.length > 0) {
        const tomorrowDate = new Date(now);
        tomorrowDate.setDate(tomorrowDate.getDate() + 1);
        const tomorrowStr = getLocalDateString(tomorrowDate);
        
        for (const sentence of missedScheduled) {
          const updated = { ...sentence, scheduledDate: tomorrowStr, updatedAt: Date.now() };
          await storageService.addSentence(updated, false);
        }
        
        console.log(`📚 generateDailySelection: ${missedScheduled.length} 个预约句子顺延至 ${tomorrowStr}`);
      }
      
      console.log(`📚 generateDailySelection: 最终选择=${finalSelection.length}个句子`);
      
      if (finalSelection.length > 0) {
        await storageService.saveTodaySelection(finalSelection.map(s => s.id));
      }
      
      isGeneratingRef.current = false;
      if (currentVersion === generateVersionRef.current) {
        setDailySelection(finalSelection);
        hasGeneratedTodayRef.current = true;
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('生成每日选择失败:', err.message);
      } else {
        console.error('生成每日选择失败:', String(err));
      }
      isGeneratingRef.current = false;
      if (currentVersion === generateVersionRef.current) {
        setDailySelection([]);
      }
    }
  }, [sentences, isGeneratingRef]);

  useEffect(() => {
    const today = getLocalDateString();
    const currentSentencesKey = `${sentences.length}|${sentences.map(s => s.id).join(',')}`;
    const sentencesChanged = lastSentencesKeyRef.current !== currentSentencesKey;
    const isNewDay = lastGeneratedDateRef.current !== '' && lastGeneratedDateRef.current !== today;

    if (isNewDay) {
      console.log('📚 useDailySelection: 检测到跨日，重置生成标志');
      hasGeneratedTodayRef.current = false;
    }

    if (sentencesChanged || isNewDay || !hasGeneratedTodayRef.current) {
      lastSentencesKeyRef.current = currentSentencesKey;
      sentencesRef.current = sentences;
      lastGeneratedDateRef.current = today;
      generateDailySelection();
    }
  }, [sentences, generateDailySelection]);

  return {
    dailySelection,
    setDailySelection,
    generateDailySelection,
  };
};
