import { useState, useEffect, useRef, useCallback, type RefObject, type Dispatch, type SetStateAction } from 'react';
import { Sentence } from '../../../types';
import { storageService } from '../../../services/storage';
import { deviceService } from '../../../services/deviceService';
import { syncQueueService } from '../../../services/syncQueueService';
import { getLocalDateString } from '../../../utils/date';
import { LEARN_XP, LEARNED_ANIMATION_DELAY, getNextReviewDate } from '../../../constants';

interface UseLearnLogicProps {
  sentences: Sentence[];
  setDailySelection: Dispatch<SetStateAction<Sentence[]>>;
  onUpdate: () => Promise<void>;
  isOnline: boolean;
  isMountedRef: RefObject<boolean>;
  isMarkLearnedSubmittingRef: RefObject<boolean>;
  animationTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
}

interface UseLearnLogicReturn {
  completedIds: Set<string>;
  isSavingLearned: boolean;
  handleMarkLearned: (id: string) => Promise<void>;
  setAnimatingLearnedId: (id: string | null) => void;
}

export const useLearnLogic = ({
  sentences,
  setDailySelection,
  onUpdate,
  isOnline,
  isMountedRef,
  isMarkLearnedSubmittingRef,
  animationTimerRef,
}: UseLearnLogicProps): UseLearnLogicReturn => {
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [isSavingLearned, setIsSavingLearned] = useState(false);
  const [animatingLearnedId, setAnimatingLearnedId] = useState<string | null>(null);

  const handleMarkLearned = useCallback(async (id: string) => {
    if (isMarkLearnedSubmittingRef.current) return;
    isMarkLearnedSubmittingRef.current = true;
    setIsSavingLearned(true);
    
    try {
      const sentence = sentences.find(s => s.id === id);
      if (!sentence || sentence.intervalIndex > 0) {
        isMarkLearnedSubmittingRef.current = false;
        setIsSavingLearned(false);
        return;
      }
      
      setAnimatingLearnedId(id);
      
      const canSubmit = deviceService.canSubmitFeedback();
      
      const now = Date.now();
      const nextReviewDate = getNextReviewDate();
      
      const updatedSentence: Sentence = { 
        ...sentence, 
        intervalIndex: 1,
        nextReviewDate: nextReviewDate,
        lastReviewedAt: now,
        updatedAt: now,
        isPendingFirstReview: true,
        learnedAt: now
      };
      
      await storageService.addSentence(updatedSentence, false);
      
      storageService.incrementTodayLearnedCount();
      
      if (canSubmit) {
        const today = getLocalDateString();
        await storageService.updateStatsSafely(stats => {
          stats.totalPoints += LEARN_XP;
          stats.mobileLearnCount = (stats.mobileLearnCount || 0) + 1;
          if (stats.lastLearnDate !== today) {
            stats.streak += 1;
            stats.lastLearnDate = today;
          }
          return stats;
        }, false);
        syncQueueService.addMarkLearned(id, updatedSentence);
      }
      
      setCompletedIds(prev => new Set(prev).add(id));
      
      setDailySelection(prev => 
        prev.map(s => s.id === id ? { ...s, intervalIndex: 1 } : s)
      );
      
      try {
        await onUpdate();
      } catch (updateErr: unknown) {
        if (updateErr instanceof Error) {
          console.warn('刷新数据失败:', updateErr.message);
        } else {
          console.warn('刷新数据失败:', String(updateErr));
        }
      }
      
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
      animationTimerRef.current = setTimeout(() => {
        if (!isMountedRef.current) return;
        setAnimatingLearnedId(null);
        isMarkLearnedSubmittingRef.current = false;
        setIsSavingLearned(false);
      }, LEARNED_ANIMATION_DELAY);
      
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('标记掌握失败:', err.message);
      } else {
        console.error('标记掌握失败:', String(err));
      }
      
      setCompletedIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      
      setDailySelection(prev => 
        prev.map(s => s.id === id ? { ...s, intervalIndex: 0 } : s)
      );
      
      setAnimatingLearnedId(null);
      isMarkLearnedSubmittingRef.current = false;
      setIsSavingLearned(false);
      alert('保存失败，请检查网络后重试');
    }
  }, [sentences, setDailySelection, onUpdate, isMountedRef, isMarkLearnedSubmittingRef, animationTimerRef]);

  useEffect(() => {
    return () => {
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
    };
  }, [animationTimerRef]);

  return {
    completedIds,
    isSavingLearned,
    handleMarkLearned,
    setAnimatingLearnedId,
  };
};
