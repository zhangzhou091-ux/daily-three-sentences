import { useEffect, useLayoutEffect, useRef, useCallback, type RefObject } from 'react';
import { Sentence } from '../../../types';
import { getLocalDateString } from '../../../utils/date';

interface UseProgressRestoreProps {
  activeTab: string;
  dailySelection: Sentence[];
  currentIndex: number;
  setCurrentIndex: (index: number) => void;
  isGeneratingRef: RefObject<boolean>;
  isMountedRef: RefObject<boolean>;
  setProgressAdjusted: (adjusted: boolean) => void;
}

interface UseProgressRestoreReturn {
  currentLearnSentenceRef: RefObject<Sentence | null>;
  saveCurrentLearnProgress: () => void;
}

export const useProgressRestore = ({
  activeTab,
  dailySelection,
  currentIndex,
  setCurrentIndex,
  isGeneratingRef,
  isMountedRef,
  setProgressAdjusted,
}: UseProgressRestoreProps): UseProgressRestoreReturn => {
  const hasRestoredLearnProgressRef = useRef(false);
  const restoreVersionRef = useRef(0);
  const currentLearnSentenceRef = useRef<Sentence | null>(null);
  const prevActiveTabRef = useRef(activeTab);

  useEffect(() => {
    currentLearnSentenceRef.current = dailySelection[currentIndex] || null;
  }, [dailySelection, currentIndex]);

  const saveCurrentLearnProgress = useCallback(() => {
    const currentSentence = currentLearnSentenceRef.current;
    if (!currentSentence) return;
    
    const today = getLocalDateString();
    
    try {
      const progressData = {
        sentenceId: currentSentence.id,
        sentenceEnglish: currentSentence.english,
        date: today,
        index: currentIndex
      };
      
      localStorage.setItem('d3s_learn_progress', JSON.stringify(progressData));
      sessionStorage.setItem('d3s_learn_progress', JSON.stringify(progressData));
      
      if (import.meta.env.DEV) {
        console.log(`💾 学习进度保存成功: 句子ID ${currentSentence.id}, 日期 ${today}`);
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.warn('学习进度保存失败:', err.message);
      } else {
        console.warn('学习进度保存失败:', String(err));
      }
    }
  }, [currentIndex]);

  useEffect(() => {
    if (activeTab === 'learn') {
      saveCurrentLearnProgress();
    } else if (prevActiveTabRef.current === 'learn') {
      saveCurrentLearnProgress();
    }
    prevActiveTabRef.current = activeTab;
  }, [currentIndex, activeTab, saveCurrentLearnProgress]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      saveCurrentLearnProgress();
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [saveCurrentLearnProgress]);

  useLayoutEffect(() => {
    if (activeTab !== 'learn') {
      hasRestoredLearnProgressRef.current = false;
      return;
    }

    if (isGeneratingRef.current) {
      return;
    }

    if (dailySelection.length === 0) {
      return;
    }

    if (hasRestoredLearnProgressRef.current) return;

    const currentRestoreVersion = ++restoreVersionRef.current;
    
    if (currentRestoreVersion !== restoreVersionRef.current) {
      console.log('📚 进度恢复：检测到新的恢复请求，放弃当前恢复');
      return;
    }
    
    if (!isMountedRef.current) return;
    
    hasRestoredLearnProgressRef.current = true;
      
    let savedProgress: { sentenceId: string; sentenceEnglish: string; date: string; index: number } | null = null;
    
    try {
      const saved = localStorage.getItem('d3s_learn_progress') || 
                    sessionStorage.getItem('d3s_learn_progress');
      if (saved) {
        savedProgress = JSON.parse(saved);
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.warn('读取学习进度失败:', err.message);
      } else {
        console.warn('读取学习进度失败:', String(err));
      }
    }
    
    if (!savedProgress) return;
    
    const today = getLocalDateString();
    
    if (savedProgress.date !== today) {
      console.log('📅 学习进度已过期，重置');
      try {
        localStorage.removeItem('d3s_learn_progress');
        sessionStorage.removeItem('d3s_learn_progress');
      } catch (e: unknown) {
        if (e instanceof Error) {
          console.warn('清除过期进度失败:', e.message);
        } else {
          console.warn('清除过期进度失败:', String(e));
        }
      }
      return;
    }
    
    let foundIndex = dailySelection.findIndex(s => s.id === savedProgress.sentenceId);
    let wasAdjusted = false;
    let contentChanged = false;
    
    if (foundIndex < 0) {
      foundIndex = dailySelection.findIndex(s => s.english === savedProgress.sentenceEnglish);
      if (foundIndex >= 0) {
        console.log(`📍 ID 丢失但内容匹配，重新定位: 索引 ${foundIndex}`);
        wasAdjusted = true;
      } else {
        console.log(`📍 句子已被删除，清除进度并重置`);
        try {
          localStorage.removeItem('d3s_learn_progress');
          sessionStorage.removeItem('d3s_learn_progress');
        } catch {
        }
        setCurrentIndex(0);
        return;
      }
    } else {
      const currentSentence = dailySelection[foundIndex];
      if (currentSentence.english !== savedProgress.sentenceEnglish) {
        contentChanged = true;
        console.log(`📍 句子内容已变化，提示用户`);
      }
    }
    
    if (foundIndex >= 0 && foundIndex < dailySelection.length) {
      if (foundIndex !== savedProgress.index) {
        wasAdjusted = true;
      }
      
      setCurrentIndex(foundIndex);
      if (wasAdjusted || contentChanged) {
        setProgressAdjusted(true);
        setTimeout(() => setProgressAdjusted(false), 3000);
        
        const adjustedProgress = {
          sentenceId: dailySelection[foundIndex].id,
          sentenceEnglish: dailySelection[foundIndex].english,
          date: today,
          index: foundIndex
        };
        localStorage.setItem('d3s_learn_progress', JSON.stringify(adjustedProgress));
        sessionStorage.setItem('d3s_learn_progress', JSON.stringify(adjustedProgress));
      }
      console.log(`✅ 学习进度恢复成功: 索引 ${foundIndex}`);
    } else {
      console.log(`📍 进度索引超出范围，重置到第一个`);
      setCurrentIndex(0);
    }
  }, [activeTab, dailySelection, setCurrentIndex, isGeneratingRef, isMountedRef, setProgressAdjusted]);

  return {
    currentLearnSentenceRef,
    saveCurrentLearnProgress,
  };
};
