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
    const validSentenceIds = new Set(sentencesSnapshot.map(s => s.id));
    
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
      let retained: Sentence[] = [];

      const savedIds = await storageService.getTodaySelection();
      
      let forceRegenerate = false;
      if (savedIds.length > 0) {
        savedIds.forEach((id: string) => {
          if (!validSentenceIds.has(id)) {
            console.log(`📚 generateDailySelection: 跳过已删除的句子ID: ${id}`);
            return;
          }
          const sentence = sentencesSnapshot.find(s => s.id === id);
          if (!sentence) return;
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
        
        const yesterdayIds = storageService.getYesterdaySelection();
        console.log(`📚 generateDailySelection: 昨日学习列表=${yesterdayIds.length}个句子`);
        
        yesterdayIds.forEach(id => {
          if (!validSentenceIds.has(id)) {
            console.log(`📚 generateDailySelection: 跳过昨日已删除的句子ID: ${id}`);
            return;
          }
          const s = sentencesSnapshot.find(s => s.id === id);
          if (s && s.intervalIndex === 0) {
            retained.push(s);
          }
        });
        
        console.log(`📚 generateDailySelection: 保留昨日未学句子=${retained.length}个`);
        
        if (retained.length > LIMIT) {
          retained = retained.slice(0, LIMIT);
        }
        
        const yesterdayLearnedCount = storageService.getYesterdayLearnedCount();
        console.log(`📚 generateDailySelection: 昨日完成学习=${yesterdayLearnedCount}个句子`);
        
        let needCount = LIMIT - retained.length;
        
        let supplementCountFromYesterday = Math.min(needCount, yesterdayLearnedCount);
        
        if (supplementCountFromYesterday > 0) {
          const available = sentencesSnapshot.filter(s => 
            s.intervalIndex === 0 && 
            !retained.some(r => r.id === s.id)
          );
          const manualSentences = available.filter(s => s.isManual === true);
          const importedSentences = available.filter(s => s.isManual === false || s.isManual === undefined);
          const sortedManual = manualSentences.sort((a, b) => a.addedAt - b.addedAt);
          const sortedImported = importedSentences.sort((a, b) => a.addedAt - b.addedAt);
          const sorted = [...sortedManual, ...sortedImported];
          
          const supplementList = sorted.slice(0, supplementCountFromYesterday);
          retained.push(...supplementList);
          needCount = LIMIT - retained.length;
          
          console.log(`📚 generateDailySelection: 根据昨日完成数量补充 ${supplementList.length} 个句子`);
        }
        
        if (needCount > 0) {
          const moreAvailable = sentencesSnapshot.filter(s => 
            s.intervalIndex === 0 && 
            !retained.some(r => r.id === s.id)
          );
          const manualSentences = moreAvailable.filter(s => s.isManual === true);
          const importedSentences = moreAvailable.filter(s => s.isManual === false || s.isManual === undefined);
          const sortedManual = manualSentences.sort((a, b) => a.addedAt - b.addedAt);
          const sortedImported = importedSentences.sort((a, b) => a.addedAt - b.addedAt);
          const sortedMore = [...sortedManual, ...sortedImported];
          
          const additional = sortedMore.slice(0, needCount);
          retained.push(...additional);
          
          console.log(`📚 generateDailySelection: 补满到${LIMIT}个，额外补充 ${additional.length} 个句子`);
        }
      } else {
        let needCount = LIMIT - retained.length;
        if (needCount > 0) {
          const available = sentencesSnapshot.filter(s => 
            s.intervalIndex === 0 && 
            !retained.some(r => r.id === s.id)
          );
          const manualSentences = available.filter(s => s.isManual === true);
          const importedSentences = available.filter(s => s.isManual === false || s.isManual === undefined);
          const sortedManual = manualSentences.sort((a, b) => a.addedAt - b.addedAt);
          const sortedImported = importedSentences.sort((a, b) => a.addedAt - b.addedAt);
          const sortedAll = [...sortedManual, ...sortedImported];
          
          const supplementSentences = sortedAll.slice(0, needCount);
          retained.push(...supplementSentences);
        }
      }

      const finalSelection = retained.slice(0, LIMIT);
      
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
    const currentSentencesKey = `${sentences.length}|${sentences.map(s => s.id).sort().join(',')}`;
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
