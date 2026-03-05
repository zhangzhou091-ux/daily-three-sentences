import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Sentence } from '../../../types';
import { storageService } from '../../../services/storage';

interface UseDailySelectionProps {
  sentences: Sentence[];
  isGeneratingRef: React.RefObject<boolean>;
}

export const useDailySelection = ({ sentences, isGeneratingRef }: UseDailySelectionProps) => {
  const [dailySelection, setDailySelection] = useState<Sentence[]>([]);
  const [isDictationRefreshDisabled, setIsDictationRefreshDisabled] = useState(false);
  const dictationRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settings = useMemo(() => storageService.getSettings(), []);

  const generateDailySelection = useCallback(async () => {
    // 防止循环调用
    if (isGeneratingRef.current) return;
    isGeneratingRef.current = true;
    
    try {
      if (!sentences.length) {
        setDailySelection([]);
        return;
      }
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const todayDateStr = now.toISOString().split('T')[0];
      const retainedSentences: Sentence[] = [];

      const savedIds = await storageService.getTodaySelection() || [];
      if (savedIds.length > 0) {
        savedIds.forEach(id => {
          const sentence = sentences.find(s => s.id === id);
          if (!sentence) return;
          const isLearnedToday = sentence.lastReviewedAt 
            ? new Date(sentence.lastReviewedAt).toISOString().split('T')[0] === todayDateStr 
            : false;
          if (sentence.intervalIndex === 0 || isLearnedToday) {
            retainedSentences.push(sentence);
          }
        });
      }

      const learnTarget = settings.dailyLearnTarget === 999 ? Infinity : settings.dailyLearnTarget;
      let needSupplementCount = learnTarget - retainedSentences.length;
      needSupplementCount = needSupplementCount < 0 ? 0 : needSupplementCount;

      if (needSupplementCount > 0) {
        const available = sentences.filter(s => {
          const isInRetained = retainedSentences.some(rs => rs.id === s.id);
          const isManualAddedToday = s.isManual && s.addedAt >= todayStart;
          if (s.intervalIndex > 0 || isManualAddedToday || isInRetained) {
            return false;
          }
          return true;
        });

        const manualSentences = available.filter(s => s.isManual === true);
        const importedSentences = available.filter(s => s.isManual === false || s.isManual === undefined);
        const sortedManual = manualSentences.sort((a, b) => b.addedAt - a.addedAt);
        const sortedImported = importedSentences.sort((a, b) => a.addedAt - b.addedAt);
        const sortedAll = [...sortedManual, ...sortedImported];

        const supplementSentences = sortedAll.slice(0, needSupplementCount);
        retainedSentences.push(...supplementSentences);
      }

      const finalSelection = settings.dailyLearnTarget === 999 
        ? retainedSentences 
        : retainedSentences.slice(0, settings.dailyLearnTarget);
      if (finalSelection.length > 0) {
        await storageService.saveTodaySelection(finalSelection.map(s => s.id));
      }
      setDailySelection(finalSelection);
    } finally {
      isGeneratingRef.current = false;
    }
  }, [sentences, settings.dailyLearnTarget]);

  // 使用 ref 避免循环依赖：只在 sentences 真正变化时重新生成
  const sentencesRef = useRef(sentences);
  const hasGeneratedTodayRef = useRef(false);
  
  useEffect(() => {
    // 检查 sentences 是否真正发生变化（长度或ID集合变化）
    const prevSentences = sentencesRef.current;
    const hasChanged = prevSentences.length !== sentences.length ||
      prevSentences.some((s, i) => sentences[i]?.id !== s.id);
    
    if (hasChanged || !hasGeneratedTodayRef.current) {
      sentencesRef.current = sentences;
      hasGeneratedTodayRef.current = true;
      generateDailySelection();
    }
  }, [sentences, generateDailySelection]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (dictationRefreshTimerRef.current) clearTimeout(dictationRefreshTimerRef.current);
    };
  }, []);

  return {
    dailySelection,
    isDictationRefreshDisabled,
    setIsDictationRefreshDisabled,
    generateDailySelection,
    dictationRefreshTimerRef
  };
};
