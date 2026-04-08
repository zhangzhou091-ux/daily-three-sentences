import { useState, useMemo, useRef, useCallback, useEffect, type RefObject } from 'react';
import { Sentence, ReviewRating } from '../../../types';
import { storageService } from '../../../services/storage';
import { deviceService } from '../../../services/deviceService';
import { syncQueueService } from '../../../services/syncQueueService';
import { getLocalDateString } from '../../../utils/date';
import { REVIEW_XP } from '../../../constants';

const REVIEWED_TODAY_KEY = 'd3s_reviewed_today';

const saveReviewedToday = (ids: Set<string>) => {
  try {
    localStorage.setItem(REVIEWED_TODAY_KEY, JSON.stringify({
      date: getLocalDateString(),
      ids: Array.from(ids)
    }));
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.warn('保存复习记录失败:', err.message);
    } else {
      console.warn('保存复习记录失败:', String(err));
    }
  }
};

const loadReviewedToday = (): Set<string> => {
  try {
    const saved = localStorage.getItem(REVIEWED_TODAY_KEY);
    if (!saved) return new Set();
    
    const { date, ids } = JSON.parse(saved);
    if (date === getLocalDateString()) {
      return new Set(ids);
    }
    localStorage.removeItem(REVIEWED_TODAY_KEY);
    return new Set();
  } catch {
    return new Set();
  }
};

interface UseReviewLogicProps {
  sentences: Sentence[];
  settings: { dailyReviewTarget: number };
  currentDateStr: string;
  activeTab: string;
  isMountedRef: RefObject<boolean>;
  onUpdate: () => Promise<void>;
}

interface UseReviewLogicReturn {
  reviewQueue: Sentence[];
  currentReviewIndex: number;
  currentReviewId: string | null;
  setCurrentReviewId: (id: string | null) => void;
  reviewedIds: Set<string>;
  isProcessingReview: boolean;
  isProcessingReviewRef: RefObject<boolean>;
  currentReviewIdRef: RefObject<string | null>;
  reviewQueueLengthRef: RefObject<number>;
  handleReviewFeedback: (id: string, rating: ReviewRating) => Promise<void>;
  goToReviewIndex: (nextIndex: number) => void;
}

export const useReviewLogic = ({
  sentences,
  settings,
  currentDateStr,
  activeTab,
  isMountedRef,
  onUpdate,
}: UseReviewLogicProps): UseReviewLogicReturn => {
  const [currentReviewId, setCurrentReviewId] = useState<string | null>(null);
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(() => loadReviewedToday());
  const [isProcessingReview, setIsProcessingReview] = useState(false);
  
  const currentReviewIdRef = useRef<string | null>(null);
  const reviewOrderRef = useRef<string[]>([]);
  const stableReviewOrderRef = useRef<string[]>([]);
  const stableOrderDateRef = useRef<string>('');
  const reviewQueueLengthRef = useRef(0);
  const isProcessingReviewRef = useRef(false);

  currentReviewIdRef.current = currentReviewId;

  const reviewQueue = useMemo(() => {
    const todayStr = currentDateStr;
    const reviewTarget = settings.dailyReviewTarget;
    const activeReviewId = currentReviewIdRef.current;
    
    const filtered = sentences.filter(s => {
      if (s.intervalIndex === 0) return false;
      
      const isLearnedToday = s.learnedAt && getLocalDateString(s.learnedAt) === todayStr;
      if (s.isPendingFirstReview && isLearnedToday) {
        return false;
      }
      
      const isDue = s.nextReviewDate && s.nextReviewDate <= Date.now();
      const reviewedToday = s.lastReviewedAt && getLocalDateString(s.lastReviewedAt) === todayStr;
      return isDue || reviewedToday;
    });
    
    const uniqueMap = new Map<string, Sentence>();
    filtered.forEach(s => {
      if (!uniqueMap.has(s.id)) {
        uniqueMap.set(s.id, s);
      }
    });
    
    if (activeReviewId && !uniqueMap.has(activeReviewId)) {
      currentReviewIdRef.current = null;
    }
    
    const needsRegenerate = stableOrderDateRef.current !== todayStr || stableReviewOrderRef.current.length === 0;
    
    if (needsRegenerate) {
      const sorted = Array.from(uniqueMap.values()).sort((a, b) => {
        return (a.nextReviewDate || 0) - (b.nextReviewDate || 0);
      });
      
      stableReviewOrderRef.current = sorted.map(s => s.id);
      stableOrderDateRef.current = todayStr;
      console.log(`📚 reviewQueue: 重新生成稳定顺序，共 ${stableReviewOrderRef.current.length} 个句子`);
    }
    
    let orderedQueue: Sentence[] = [];
    const seenIds = new Set<string>();
    
    stableReviewOrderRef.current.forEach(id => {
      const s = uniqueMap.get(id);
      if (s && !seenIds.has(id)) {
        orderedQueue.push(s);
        seenIds.add(id);
      }
    });
    
    let finalQueue = orderedQueue;
    if (reviewTarget !== 999) {
      let limited = orderedQueue.slice(0, reviewTarget);
      
      if (activeTab === 'review' && activeReviewId && !limited.some(s => s.id === activeReviewId)) {
        const activeSentence = orderedQueue.find(s => s.id === activeReviewId);
        if (activeSentence) {
          limited = [activeSentence, ...limited.filter(s => s.id !== activeReviewId)];
        }
      }
      finalQueue = limited;
    }

    const newOrder = finalQueue.map(s => s.id);
    const orderChanged = reviewOrderRef.current.length !== newOrder.length || 
      reviewOrderRef.current.some((id, idx) => id !== newOrder[idx]);
    
    if (orderChanged) {
      reviewOrderRef.current = newOrder;
    }
    
    reviewQueueLengthRef.current = finalQueue.length;
    
    return finalQueue;
  }, [sentences, settings.dailyReviewTarget, activeTab, currentDateStr]);

  const currentReviewIndex = useMemo(() => {
    if (!currentReviewId) return 0;
    if (reviewQueue.length === 0) return 0;
    const index = reviewQueue.findIndex(s => s.id === currentReviewId);
    return index >= 0 ? index : 0;
  }, [reviewQueue, currentReviewId]);

  const goToReviewIndex = useCallback((nextIndex: number) => {
    if (reviewQueue.length === 0) {
      setCurrentReviewId(null);
      return;
    }
    if (isProcessingReview) return;
    
    const normalizedIndex = Math.max(0, Math.min(nextIndex, reviewQueue.length - 1));
    const nextSentence = reviewQueue[normalizedIndex];
    
    if (!nextSentence || !nextSentence.id) {
      console.warn('复习队列索引异常，重置到第一个');
      setCurrentReviewId(reviewQueue[0]?.id || null);
      return;
    }
    
    setCurrentReviewId(nextSentence.id);
  }, [reviewQueue, isProcessingReview]);

  const handleReviewFeedback = useCallback(async (id: string, rating: ReviewRating) => {
    if (isProcessingReviewRef.current) return;
    if (isProcessingReview) return;
    
    isProcessingReviewRef.current = true;
    
    const sentence = sentences.find(s => s.id === id);
    if (!sentence) {
      isProcessingReviewRef.current = false;
      alert('句子不存在');
      return;
    }
    
    setIsProcessingReview(true);
    
    try {
      currentReviewIdRef.current = id;
      
      const canSubmit = deviceService.canSubmitFeedback();
      const { nextIndex, nextDate, fsrsData } = storageService.calculateNextReview(
        sentence.intervalIndex, 
        rating,
        sentence.timesReviewed,
        sentence
      );
      
      const updated: Sentence = { 
        ...sentence, 
        intervalIndex: nextIndex, 
        nextReviewDate: nextDate,
        lastReviewedAt: Date.now(),
        timesReviewed: (sentence.timesReviewed || 0) + 1,
        updatedAt: Date.now(),
        ...(sentence.isPendingFirstReview === true ? { isPendingFirstReview: false } : {}),
        ...fsrsData
      };

      await storageService.addSentence(updated, false);
      
      if (canSubmit) {
        await storageService.updateStatsSafely(stats => {
          stats.mobileReviewCount = (stats.mobileReviewCount || 0) + 1;
          stats.totalPoints += REVIEW_XP[rating];
          return stats;
        }, false);
        syncQueueService.addReviewFeedback(id, updated, rating);
      }
      
      setReviewedIds(prev => {
        const next = new Set(prev);
        next.add(id);
        saveReviewedToday(next);
        return next;
      });
      
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.warn('复习保存失败', err.message);
      } else {
        console.warn('复习保存失败', String(err));
      }
      
      setReviewedIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        saveReviewedToday(next);
        return next;
      });
      
      alert('评分保存失败，请重试');
    } finally {
      isProcessingReviewRef.current = false;
      setIsProcessingReview(false);
      
      try {
        await onUpdate();
      } catch (updateErr: unknown) {
        if (updateErr instanceof Error) {
          console.warn('复习后刷新全局状态失败:', updateErr.message);
        } else {
          console.warn('复习后刷新全局状态失败:', String(updateErr));
        }
      }
    }
  }, [sentences, isProcessingReview, onUpdate]);

  return {
    reviewQueue,
    currentReviewIndex,
    currentReviewId,
    setCurrentReviewId,
    reviewedIds,
    isProcessingReview,
    isProcessingReviewRef,
    currentReviewIdRef,
    reviewQueueLengthRef,
    handleReviewFeedback,
    goToReviewIndex,
  };
};
