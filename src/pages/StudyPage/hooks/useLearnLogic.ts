import { useState, useEffect, useRef, useCallback, useMemo, type RefObject } from 'react';
import { Sentence, StudyStep } from '../../../types';
import { storageService } from '../../../services/storage';
import { deviceService } from '../../../services/deviceService';
import { syncQueueService } from '../../../services/syncQueueService';
import { LEARN_XP, LEARNED_ANIMATION_DELAY } from '../../../constants';

interface UseLearnLogicProps {
  sentences: Sentence[];
  onUpdate: () => Promise<void>;
  activeTab: StudyStep;
  currentIndex: number;
  setCurrentIndex: (index: number) => void;
  setAnimatingLearnedId: (id: string | null) => void;
  isOnline: boolean;
  isGeneratingRef: RefObject<boolean>;
  isMarkLearnedSubmittingRef: RefObject<boolean>;
  animationTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  dictationPool: Sentence[];
  targetDictationId: string | null;
  setTargetDictationId: (id: string | null) => void;
  isFlipped: boolean;
  setIsFlipped: (flipped: boolean) => void;
  userInput: string;
  setUserInput: (input: string) => void;
  setIsDictationRefreshDisabled: (disabled: boolean) => void;
  dailySelection: Sentence[];
}

export const useLearnLogic = ({
  sentences,
  onUpdate,
  activeTab,
  currentIndex,
  setCurrentIndex,
  setAnimatingLearnedId,
  isOnline,
  isGeneratingRef,
  isMarkLearnedSubmittingRef,
  animationTimerRef,
  dictationPool,
  targetDictationId,
  setTargetDictationId,
  isFlipped,
  setIsFlipped,
  userInput,
  setUserInput,
  setIsDictationRefreshDisabled,
  dailySelection
}: UseLearnLogicProps) => {
  const dictationRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settings = useMemo(() => storageService.getSettings(), []);
  const todayStr = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  }, []);

  // 🔴 修复：学习进度保存错误处理
  useEffect(() => {
    const saveProgress = () => {
      try {
        localStorage.setItem('d3s_learn_index', currentIndex.toString());
        // 同时保存到sessionStorage作为备份
        sessionStorage.setItem('d3s_learn_index', currentIndex.toString());
        if (import.meta.env.DEV) {
          console.log(`💾 学习进度保存成功: 索引 ${currentIndex}`);
        }
      } catch (err) {
        console.warn('学习进度保存失败:', err);
        // 尝试使用降级方案：sessionStorage
        try {
          sessionStorage.setItem('d3s_learn_index', currentIndex.toString());
        } catch (fallbackErr) {
          console.error('学习进度降级保存也失败:', fallbackErr);
        }
      }
    };
    
    // 当切换到学习标签或进度变化时保存
    if (activeTab === 'learn') {
      saveProgress();
    }
    
    // 定期保存（每5次翻页）
    if (activeTab === 'learn' && currentIndex > 0 && currentIndex % 5 === 0) {
      saveProgress();
    }
  }, [currentIndex, activeTab]);

  // 恢复学习进度
  useEffect(() => {
    if (activeTab === 'learn' && currentIndex === 0) {
      // 优先从localStorage读取
      let savedIndex = 0;
      try {
        const saved = localStorage.getItem('d3s_learn_index');
        if (saved) {
          savedIndex = parseInt(saved, 10);
        } else {
          // 降级到sessionStorage
          const sessionSaved = sessionStorage.getItem('d3s_learn_index');
          if (sessionSaved) {
            savedIndex = parseInt(sessionSaved, 10);
          }
        }
      } catch (err) {
        console.warn('读取学习进度失败:', err);
      }
      
      if (savedIndex > 0) {
        const maxIndex = Math.max(0, dailySelection.length - 1);
        setCurrentIndex(Math.min(savedIndex, maxIndex));
      }
    }
  }, [activeTab, dailySelection.length]);

  // 标记掌握
  const handleMarkLearned = async (id: string) => {
    // 防止重复提交
    if (isMarkLearnedSubmittingRef.current) return;
    isMarkLearnedSubmittingRef.current = true;
    
    try {
      // ✅ 修复：优先从 dailySelection 查找句子，确保数据一致性
      const sentence = dailySelection.find(s => s.id === id) || sentences.find(s => s.id === id);
      if (!sentence) {
        console.warn('未找到句子:', id);
        return;
      }
      // ✅ 修复：添加调试信息
      if (sentence.intervalIndex > 0) {
        console.log('句子已学习过，跳过:', sentence.id, 'intervalIndex:', sentence.intervalIndex);
        return;
      }
      setAnimatingLearnedId(id);
      
      const canSubmit = deviceService.canSubmitFeedback();
      const stats = storageService.getStats();
      
      try {
        const { nextIndex, nextDate, fsrsData } = storageService.calculateNextReview(0, 4, 0, sentence);
        const updatedSentence: Sentence = { 
          ...sentence, 
          intervalIndex: nextIndex, 
          nextReviewDate: nextDate,
          lastReviewedAt: Date.now(),
          updatedAt: Date.now(),
          ...fsrsData
        };
        
        await storageService.addSentence(updatedSentence, false);
        
        if (!canSubmit) {
          if (import.meta.env.DEV) {
            console.log('🖥️ 电脑端：仅本地保存，不同步学习反馈到云端');
          }
          animationTimerRef.current = setTimeout(async () => {
            await onUpdate();
            setAnimatingLearnedId(null);
          }, LEARNED_ANIMATION_DELAY);
          return;
        }
        
        stats.totalPoints += LEARN_XP;
        stats.mobileLearnCount = (stats.mobileLearnCount || 0) + 1;
        const today = new Date().toISOString().split('T')[0];
        if (stats.lastLearnDate !== today) {
          stats.streak += 1;
          stats.lastLearnDate = today;
        }
        storageService.saveStats(stats, false);
        
        if (!isOnline) {
          syncQueueService.addMarkLearned(id, updatedSentence);
          
          animationTimerRef.current = setTimeout(async () => {
            await onUpdate();
            setAnimatingLearnedId(null);
          }, LEARNED_ANIMATION_DELAY);
          return;
        }
        
        syncQueueService.addMarkLearned(id, updatedSentence);
        
        animationTimerRef.current = setTimeout(async () => {
          await onUpdate();
          setAnimatingLearnedId(null);
        }, LEARNED_ANIMATION_DELAY);
      } catch (err) {
        console.warn('标记掌握保存失败', err);
      }
    } finally {
      isMarkLearnedSubmittingRef.current = false;
    }
  };

  // 选择新的默写目标
  const pickNewDictationTarget = () => {
    if (dictationPool.length === 0) return;
    const randomIdx = Math.floor(Math.random() * dictationPool.length);
    setTargetDictationId(dictationPool[randomIdx].id);
    setIsFlipped(false);
    setUserInput('');
  };

  // 刷新默写
  const handleDictationRefresh = () => {
    // 1. 安全校验：只有有默写池数据时才执行
    if (dictationPool.length === 0) {
      alert('暂无可默写的句子，请先学习句子');
      return;
    }
    // 2. 防重复点击：禁用按钮0.5秒
    setIsDictationRefreshDisabled(true);
    
    // 3. 强制执行刷新逻辑
    pickNewDictationTarget();
    
    // 4. 清除旧定时器，避免状态异常
    if (dictationRefreshTimerRef.current) clearTimeout(dictationRefreshTimerRef.current);
    dictationRefreshTimerRef.current = setTimeout(() => {
      setIsDictationRefreshDisabled(false);
    }, 500);
    // 调试日志（可选，可删除）
    console.log('🔄 默写按钮点击触发，已刷新新句子');
  };

  // 清理定时器
  useEffect(() => {
    return () => {
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
      if (dictationRefreshTimerRef.current) clearTimeout(dictationRefreshTimerRef.current);
    };
  }, []);

  return {
    dailySelection,
    setIsDictationRefreshDisabled,
    handleMarkLearned,
    handleDictationRefresh,
    pickNewDictationTarget,
    todayStr
  };
};
