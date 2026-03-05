import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Sentence, StudyStep, DictationRecord, ReviewRating } from '../types';
import { geminiService } from '../services/geminiService';
import { storageService } from '../services/storage';
import { supabaseService } from '../services/supabaseService';
import { deviceService } from '../services/deviceService';
import { syncQueueService } from '../services/syncQueueService';
import { ErrorBoundary } from '../components/ErrorBoundary';

import { LEARN_XP, DICTATION_XP, LEARNED_ANIMATION_DELAY, MAX_REVIEW_LEVEL, REVIEW_XP } from '../constants';

interface StudyPageProps {
  sentences: Sentence[];
  onUpdate: () => Promise<void>;
}

const StudyPage: React.FC<StudyPageProps> = ({ sentences, onUpdate }) => {
  const [activeTab, setActiveTab] = useState<StudyStep>('learn');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [userInput, setUserInput] = useState('');
  const [dictationList, setDictationList] = useState<DictationRecord[]>([]);
  const [targetDictationId, setTargetDictationId] = useState<string | null>(null);
  const [animatingLearnedId, setAnimatingLearnedId] = useState<string | null>(null);
  const [reviewFeedbackStatus, setReviewFeedbackStatus] = useState<Record<string, boolean>>({});
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'failed'>('idle');
  const isSyncingRef = useRef(false);
  
  // ========== 核心修复1：彻底简化刷新按钮禁用逻辑，初始值强制为false ==========
  const [isDictationRefreshDisabled, setIsDictationRefreshDisabled] = useState(false);
  // ★★★ 核心修改1：将dailySelection改为useState，异步生成，解决Promise获取ID的BUG ★★★
  const [dailySelection, setDailySelection] = useState<Sentence[]>([]);
  
  // 防止循环刷新标志
  const isGeneratingRef = useRef(false);
  
  // ========== 核心修复3：添加学习反馈提交状态锁，防止重复提交 ==========
  const isMarkLearnedSubmittingRef = useRef(false);
  const isReviewFeedbackSubmittingRef = useRef(false);
  const [isReviewSubmitting, setIsReviewSubmitting] = useState(false);
  

  
  // 定时器ref
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    
    // 页面卸载时保存
    const handleBeforeUnload = () => {
      if (activeTab === 'learn') {
        saveProgress();
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
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

  // ✅ 修复：使用更稳定的复习队列索引管理
  const [currentReviewIndex, setCurrentReviewIndex] = useState(0);
  const currentReviewIdRef = useRef<string | null>(null);
  const prevReviewQueueLength = useRef(0);
  
  const reviewQueue = useMemo(() => {
    const todayDateStr = new Date().toISOString().split('T')[0];
    const reviewTarget = settings.dailyReviewTarget;
    
    const dueForReview = sentences.filter(s => 
      s.nextReviewDate && s.nextReviewDate <= Date.now()
    );
    
    const reviewedToday = sentences.filter(s => {
      if (s.intervalIndex === 0) return false;
      if (!s.lastReviewedAt) return false;
      return new Date(s.lastReviewedAt).toISOString().split('T')[0] === todayDateStr;
    });
    
    const combinedMap = new Map<string, Sentence>();
    [...dueForReview, ...reviewedToday].forEach(s => {
      if (!combinedMap.has(s.id)) {
        combinedMap.set(s.id, s);
      }
    });
    
    const allReviewSentences = Array.from(combinedMap.values());
    const result = reviewTarget === 999 ? allReviewSentences : allReviewSentences.slice(0, reviewTarget);
    
    return result;
  }, [sentences, settings.dailyReviewTarget]);
  
  // ✅ 修复：复习队列变化时验证并修正索引
  useEffect(() => {
    // 队列长度变化时检查索引有效性
    if (reviewQueue.length !== prevReviewQueueLength.current) {
      prevReviewQueueLength.current = reviewQueue.length;
      
      // 如果当前索引超出范围，重置到最后一个有效位置
      if (currentReviewIndex >= reviewQueue.length) {
        setCurrentReviewIndex(Math.max(0, reviewQueue.length - 1));
        currentReviewIdRef.current = reviewQueue.length > 0 ? reviewQueue[reviewQueue.length - 1]?.id || null : null;
      }
    }
    
    // 更新当前复习句子ID
    if (reviewQueue[currentReviewIndex]) {
      currentReviewIdRef.current = reviewQueue[currentReviewIndex].id;
    }
  }, [reviewQueue, currentReviewIndex]);
  
  // ✅ 修复：切换到复习标签时重置索引和反馈状态
  useEffect(() => {
    if (activeTab === 'review') {
      setCurrentReviewIndex(0);
      setReviewFeedbackStatus({});
      currentReviewIdRef.current = reviewQueue[0]?.id || null;
    }
  }, [activeTab, reviewQueue]);
  
  const dictationPool = useMemo(() => 
    sentences.filter(s => s.intervalIndex > 0)
  , [sentences]);

  // 切换句子/标签时设置翻转状态
  // 学习模式：默认展示正面（英文）
  // 复习模式：默认展示背面（中文）
  useEffect(() => {
    setIsFlipped(activeTab === 'review');
  }, [currentIndex, activeTab]);

  // ✅ 已合并到上面的复习队列索引管理 useEffect 中

  // 初始化今日默写记录
  useEffect(() => {
    setDictationList(storageService.getTodayDictations());
  }, []);

  // 自动选默写目标
  useEffect(() => {
    if (activeTab === 'dictation' && !targetDictationId && dictationPool.length > 0) {
      pickNewDictationTarget();
    }
  }, [activeTab, targetDictationId, dictationPool]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
      if (dictationRefreshTimerRef.current) clearTimeout(dictationRefreshTimerRef.current);
    };
  }, []);

  // ★★★ 新增核心优化：监听PWA缓存更新、全量句子加载、当日列表云端更新 ★★★
  // 使用 ref 存储 onUpdate，避免依赖变化导致重复绑定事件
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  
  useEffect(() => {
    // 监听全量句子加载完成（配合storageService的分片加载）
    const handleSentencesFullLoaded = async (e: CustomEvent) => {
      await onUpdateRef.current();
      if (import.meta.env.DEV) {
        console.log('📥 全量句子加载完成，页面已刷新');
      }
    };

    // 监听当日列表云端更新（配合storageService的本地优先）
    const handleDailySelectionUpdated = async (e: CustomEvent) => {
      // 避免循环刷新：如果正在生成中，则跳过
      if (isGeneratingRef.current) {
        if (import.meta.env.DEV) {
          console.log('⏭️ 跳过云端更新事件，正在生成中');
        }
        return;
      }
      await generateDailySelection(); // 重新生成当日列表
      if (import.meta.env.DEV) {
        console.log('☁️ 当日列表云端更新，页面已刷新');
      }
    };

    // 监听PWA Service Worker更新（解决PWA缓存导致的更新不生效问题）
    const handleSwUpdate = async (e: Event) => {
      if (import.meta.env.DEV) {
        console.log('🔄 PWA有新版本更新，正在刷新缓存');
      }
      // 触发页面全量刷新，加载最新资源
      await onUpdateRef.current();
      window.location.reload();
    };

    // 绑定事件监听
    window.addEventListener('sentencesFullLoaded', handleSentencesFullLoaded as EventListener);
    window.addEventListener('dailySelectionUpdated', handleDailySelectionUpdated as EventListener);
    navigator.serviceWorker?.addEventListener('controllerchange', handleSwUpdate);

    // 清理函数
    return () => {
      window.removeEventListener('sentencesFullLoaded', handleSentencesFullLoaded as EventListener);
      window.removeEventListener('dailySelectionUpdated', handleDailySelectionUpdated as EventListener);
      navigator.serviceWorker?.removeEventListener('controllerchange', handleSwUpdate);
    };
  // 空依赖数组，只在组件挂载时绑定一次
  }, []);

  // 网络状态监听 + 离线同步
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      console.log('🔌 网络已恢复，开始同步离线操作');
      syncOfflineOperations();
    };
    const handleOffline = () => {
      setIsOnline(false);
      console.log('📴 网络已断开，操作将存入离线队列');
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    setIsOnline(navigator.onLine);
    syncOfflineOperations();
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const syncOfflineOperations = async () => {
    if (isSyncingRef.current || !isOnline) return;
    
    const pendingOps = syncQueueService.getPendingOperations();
    if (pendingOps.length === 0) {
      setSyncStatus('idle');
      return;
    }
    isSyncingRef.current = true;
    setSyncStatus('syncing');
    console.log(`📤 开始同步${pendingOps.length}个离线操作`);
    
    const result = await syncQueueService.syncNow();
    
    await onUpdate();
    isSyncingRef.current = false;
    
    setSyncStatus(result.success ? 'idle' : 'failed');
    console.log(`✅ 离线操作同步完成: ${result.message}`);
  };

  const offlineQueueCount = useMemo(() => {
    return syncQueueService.getPendingOperations().length;
  }, [syncStatus]);

  // 选择新的默写目标
  const pickNewDictationTarget = () => {
    if (dictationPool.length === 0) return;
    const randomIdx = Math.floor(Math.random() * dictationPool.length);
    setTargetDictationId(dictationPool[randomIdx].id);
    setIsFlipped(false);
    setUserInput('');
  };

  // ========== 核心修复2：重写刷新按钮逻辑，移除复杂判断，确保点击必触发 ==========
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

  // 播放语音
  const speak = async (text: string) => {
    if (!text?.trim()) return;
    try {
      await geminiService.speak(text);
    } catch (err) {
      console.warn('语音播放失败', err);
    }
  };

  // 标记掌握
  const handleMarkLearned = async (id: string) => {
    // 防止重复提交
    if (isMarkLearnedSubmittingRef.current) return;
    isMarkLearnedSubmittingRef.current = true;
    
    try {
      const sentence = sentences.find(s => s.id === id);
      if (!sentence || sentence.intervalIndex > 0) return;
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

  // 复习反馈
  const handleReviewFeedback = async (id: string, rating: ReviewRating) => {
    // 防止重复提交
    if (isReviewFeedbackSubmittingRef.current) return;
    if (reviewFeedbackStatus[id]) return;
    
    isReviewFeedbackSubmittingRef.current = true;
    setIsReviewSubmitting(true);
    
    try {
      const sentence = sentences.find(s => s.id === id);
      if (!sentence) return;
      
      const canSubmit = deviceService.canSubmitFeedback();
      
      try {
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
          ...fsrsData
        };
        
        await storageService.addSentence(updated, false);
        
        if (!canSubmit) {
          if (import.meta.env.DEV) {
            console.log('🖥️ 电脑端：仅本地保存，不同步复习反馈到云端');
          }
          setReviewFeedbackStatus(prev => ({ ...prev, [id]: true }));
          setCurrentIndex(prev => {
            const nextIndex = prev + 1;
            return reviewQueue.length > 0 ? Math.min(nextIndex, reviewQueue.length - 1) : 0;
          });
          setIsFlipped(true);
          await onUpdate();
          return;
        }
        
        const stats = storageService.getStats();
        stats.mobileReviewCount = (stats.mobileReviewCount || 0) + 1;
        stats.totalPoints += REVIEW_XP[rating];
        storageService.saveStats(stats, false);
        
        if (!isOnline) {
          syncQueueService.addReviewFeedback(id, updated, rating);
          
          setReviewFeedbackStatus(prev => ({ ...prev, [id]: true }));
          setCurrentIndex(prev => {
            const nextIndex = prev + 1;
            return reviewQueue.length > 0 ? Math.min(nextIndex, reviewQueue.length - 1) : 0;
          });
          setIsFlipped(true);
          await onUpdate();
          return;
        }
        
        syncQueueService.addReviewFeedback(id, updated, rating);
        
        setReviewFeedbackStatus(prev => ({ ...prev, [id]: true }));
        setCurrentIndex(prev => {
          const nextIndex = prev + 1;
          const newIndex = reviewQueue.length > 0 ? Math.min(nextIndex, reviewQueue.length - 1) : 0;
          // 更新当前复习句子ID
          if (reviewQueue[newIndex]) {
            currentReviewIdRef.current = reviewQueue[newIndex].id;
          }
          return newIndex;
        });
        setIsFlipped(true);
        await onUpdate();
      } catch (err) {
        console.warn('复习保存失败', err);
      }
    } finally {
      isReviewFeedbackSubmittingRef.current = false;
      setIsReviewSubmitting(false);
    }
  };

  // 默写核对
  const handleDictationCheck = () => {
    if (!userInput.trim()) {
      alert('请输入默写内容后再核对');
      return;
    }
    const target = sentences.find(s => s.id === targetDictationId);
    if (!target) return;
    
    try {
      const isCorrect = userInput.trim().toLowerCase() === target.english.trim().toLowerCase();
      const newRecord: DictationRecord = {
        sentenceId: target.id,
        status: isCorrect ? 'correct' : 'wrong',
        timestamp: Date.now(),
        isFinished: false
      };
      
      // ✅ 修复：增强去重检查，延长时间窗口并添加完成状态检查
      const DUPLICATE_TIME_WINDOW = 5000; // 5秒去重窗口
      
      const existingRecord = dictationList.find(
        r => r.sentenceId === target.id && 
             r.timestamp > Date.now() - DUPLICATE_TIME_WINDOW && 
             !r.isFinished
      );
      
      // 检查是否已有该句子的正确完成记录
      const hasCompletedCorrectly = dictationList.some(
        r => r.sentenceId === target.id && 
             r.status === 'correct' && 
             r.timestamp > Date.now() - 24 * 60 * 60 * 1000 // 24小时内
      );
      
      if (existingRecord) {
        console.log('该句子正在处理中，请稍后再试');
        alert('该句子正在处理中，请稍后再试');
        return;
      }
      
      if (hasCompletedCorrectly) {
        console.log('该句子今日已完成默写');
        alert('该句子今日已完成默写，将为您切换到下一句');
        setUserInput('');
        setTargetDictationId(null);
        pickNewDictationTarget();
        return;
      }
      
      const newList = [newRecord, ...dictationList];
      setDictationList(newList);
      storageService.saveTodayDictations(newList);
      
      if (!isOnline) {
        syncQueueService.addDictationRecord(newRecord);
      } else {
        supabaseService.syncDictationRecord(newRecord).catch(err => {
          console.warn('默写记录-云端同步失败，已加入离线队列', err);
          syncQueueService.addDictationRecord(newRecord);
        });
      }
      
      if (isCorrect) {
        const stats = storageService.getStats();
        stats.dictationCount = (stats.dictationCount || 0) + 1;
        stats.totalPoints += DICTATION_XP;
        if (deviceService.canSubmitFeedback()) {
          stats.mobileDictationCount = (stats.mobileDictationCount || 0) + 1;
        }
        storageService.saveStats(stats);
        setUserInput('');
        setTargetDictationId(null);
      } else {
        setIsFlipped(true);
      }
    } catch (err) {
      console.warn('默写核对失败', err);
    }
  };

  // 安全取值
  const targetSentence = useMemo(() => 
    sentences.find(s => s.id === targetDictationId) || null
  , [sentences, targetDictationId]);
  
  const currentSentence = dailySelection[currentIndex] || null;
  const currentSentenceLatest = currentSentence 
    ? sentences.find(s => s.id === currentSentence.id) || currentSentence 
    : null;
  const isCurrentlyLearned = currentSentenceLatest?.intervalIndex > 0;
  const isAnimating = currentSentence && animatingLearnedId === currentSentence.id;
  
  const currentReviewSentence = reviewQueue[currentIndex] || null;
  const isCurrentReviewSentenceFeedbacked = currentReviewSentence 
    ? reviewFeedbackStatus[currentReviewSentence.id] || false 
    : false;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-700 pb-20 max-w-2xl mx-auto">
      {/* 网络和同步状态提示 */}
      {!isOnline && (
        <div className="bg-orange-50 text-orange-600 text-sm font-bold px-4 py-2 rounded-lg flex items-center gap-2">
          <span>📴 离线模式</span>
          <span>操作将在网络恢复后自动同步</span>
        </div>
      )}
      {isOnline && syncStatus === 'syncing' && (
        <div className="bg-blue-50 text-blue-600 text-sm font-bold px-4 py-2 rounded-lg flex items-center gap-2">
          <span>🔄 同步中</span>
          <span>正在同步{offlineQueueCount}个离线操作</span>
        </div>
      )}
      {isOnline && syncStatus === 'failed' && offlineQueueCount > 0 && (
        <div className="bg-red-50 text-red-600 text-sm font-bold px-4 py-2 rounded-lg flex items-center gap-2">
          <span>⚠️ 同步失败</span>
          <button 
            onClick={syncOfflineOperations}
            className="text-red-700 underline hover:text-red-900"
          >
            点击重试（{offlineQueueCount}个操作）
          </button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 px-2">
        <div>
          <p className="text-gray-500 text-xs font-bold uppercase tracking-widest mb-1 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
            {todayStr}
          </p>
          <h2 className="text-3xl font-black tracking-tight text-gray-900 leading-tight">
            你好, {settings.userName}
          </h2>
        </div>
        <div className="flex bg-gray-200/50 p-1.5 rounded-[1.5rem] self-end sm:self-auto backdrop-blur-md">
            {(['learn', 'review', 'dictation'] as StudyStep[]).map(tab => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); setCurrentIndex(0); setIsFlipped(tab === 'review'); }}
                className={`px-4 py-2 text-[11px] font-black uppercase tracking-wider rounded-[1.2rem] transition-all duration-300 ${
                  activeTab === tab ? 'bg-white shadow-sm text-blue-600' : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                {tab === 'learn' ? '学习' : tab === 'review' ? '复习' : '默写'}
              </button>
            ))}
        </div>
      </div>

      <div className="min-h-[460px]">
        {activeTab === 'learn' && (
          dailySelection.length > 0 ? (
            <div className="space-y-8">
              <div className="perspective-1000 min-h-[340px] w-full">
                <div 
                  className={`card-inner apple-card ${isFlipped ? 'card-flipped' : ''}`}
                  onClick={() => setIsFlipped(!isFlipped)}
                  style={{ position: 'relative', width: '100%', height: 'auto', transformStyle: 'preserve-3d' }}
                >
                  <div 
                    className={`card-front p-6 transition-all duration-700 ${isCurrentlyLearned || isAnimating ? 'bg-green-50/20' : ''}`}
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'relative', 
                      width: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      justifyContent: 'flex-start',
                      minHeight: '340px',
                      textAlign: 'left',
                      paddingTop: '20px',
                      paddingBottom: '20px',
                      overflow: 'hidden'
                    }}
                  >
                    {(isCurrentlyLearned || isAnimating) && (
                      <div className="bg-green-100 text-green-600 text-[10px] font-black px-4 py-1.5 rounded-full mb-4 flex items-center gap-2 shadow-sm border border-green-200/50">
                        <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>
                        已进入计划
                      </div>
                    )}
                    
                    <h3 className="text-lg font-normal text-gray-900 leading-normal w-full" style={{ wordBreak: 'break-word', overflowWrap: 'break-word', textAlign: 'left', margin: 0, padding: 0, overflow: 'hidden' }}>
                      {currentSentence?.english || ''}
                    </h3>
                    
                    <button 
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        if (currentSentence) speak(currentSentence.english); 
                      }}
                      className="mt-6 w-16 h-16 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-2xl hover:scale-110 active:scale-95 transition-all z-20 self-center"
                    >
                      🔊
                    </button>
                    
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-widest mt-6 animate-pulse self-center">点击卡片翻转显示中文</p>
                  </div>
                  <div 
                    className="card-back p-6 flex flex-col items-start justify-start"
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'absolute', 
                      inset: 0,
                      transform: 'rotateY(180deg)',
                      minHeight: '340px',
                      textAlign: 'left',
                      paddingTop: '20px',
                      paddingBottom: '20px',
                      overflow: 'hidden'
                    }}
                  >
                    {(isCurrentlyLearned || isAnimating) && (
                      <div className="opacity-0 mb-4 pointer-events-none">占位</div>
                    )}
                    
                    <p className="text-lg text-gray-800 font-normal leading-normal w-full" style={{ wordBreak: 'break-word', overflowWrap: 'break-word', textAlign: 'left', margin: 0, padding: 0, overflow: 'hidden' }}>
                      {currentSentence?.chinese || ''}
                    </p>
                    
                    <div className="w-16 h-16 mt-6 opacity-0 pointer-events-none self-center"></div>
                    
                    <div className="mt-10 px-6 py-2 bg-gray-100 rounded-full text-[10px] font-black text-gray-400 uppercase tracking-widest self-center">
                      CHINESE MEANING
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-4">
                {!isCurrentlyLearned && !isAnimating ? (
                  <button
                    onClick={() => currentSentence && handleMarkLearned(currentSentence.id)}
                    className="w-full bg-black text-white py-5 rounded-[2rem] font-black text-xl shadow-2xl shadow-black/10 hover:bg-gray-800 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                  >
                    <span>标记掌握</span>
                    <span className="text-sm opacity-50">+{LEARN_XP} XP</span>
                  </button>
                ) : (
                  <button
                    onClick={() => {
                        if (currentIndex < dailySelection.length - 1) {
                            setCurrentIndex(currentIndex + 1);
                        } else {
                            setActiveTab('review');
                            setCurrentIndex(0);
                            setIsFlipped(true);
                        }
                    }}
                    className="w-full bg-green-500 text-white py-5 rounded-[2rem] font-black text-xl shadow-xl shadow-green-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                  >
                    <span>{currentIndex < dailySelection.length - 1 ? '继续下一个' : '前往到期复习'}</span>
                    <span className="text-xl">→</span>
                  </button>
                )}
                
                <div className="flex justify-between items-center px-6">
                    <button 
                      disabled={currentIndex === 0} 
                      onClick={() => setCurrentIndex(currentIndex - 1)} 
                      className={`text-[11px] font-bold uppercase tracking-widest transition-colors ${currentIndex === 0 ? 'text-gray-200' : 'text-gray-400 hover:text-blue-500'}`}
                    >
                      ← Prev
                    </button>
                    <div className="flex items-center gap-2">
                       <span className="text-[11px] text-gray-900 font-black tracking-widest">{currentIndex + 1}</span>
                       <span className="text-[11px] text-gray-300 font-black tracking-widest">/</span>
                       <span className="text-[11px] text-gray-400 font-black tracking-widest">{dailySelection.length}</span>
                    </div>
                    <button 
                      disabled={currentIndex === dailySelection.length - 1} 
                      onClick={() => setCurrentIndex(currentIndex + 1)} 
                      className={`text-[11px] font-bold uppercase tracking-widest transition-colors ${currentIndex === dailySelection.length - 1 ? 'text-gray-200' : 'text-gray-400 hover:text-blue-500'}`}
                    >
                      Next →
                    </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="apple-card p-16 text-center space-y-6">
              <div className="text-7xl">🪴</div>
              <h2 className="text-2xl font-black text-gray-900 tracking-tight">库中暂无可学内容</h2>
              <p className="text-gray-400 font-medium">请到仓库页添加新句子。</p>
            </div>
          )
        )}

        {activeTab === 'review' && (
          reviewQueue.length > 0 ? (
            <div className="space-y-8 animate-in slide-in-from-right-4 duration-500">
              <div className="perspective-1000 min-h-[380px] w-full">
                <div 
                  className={`card-inner apple-card ${isFlipped ? 'card-flipped' : ''}`}
                  onClick={() => setIsFlipped(!isFlipped)}
                  style={{ position: 'relative', width: '100%', height: 'auto', transformStyle: 'preserve-3d' }}
                >
                  <div 
                    className="card-front p-6"
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'relative', 
                      width: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      justifyContent: 'flex-start',
                      minHeight: '380px',
                      textAlign: 'left',
                      paddingTop: '20px',
                      paddingBottom: '20px',
                      overflow: 'hidden'
                    }}
                  >
                    <div className="absolute top-3 right-3 flex flex-col items-end bg-white/80 backdrop-blur-sm px-2 py-1 rounded-lg shadow-sm">
                      <span className="text-[8px] font-black text-blue-500 uppercase tracking-widest mb-0.5">Level</span>
                      <div className="flex gap-0.5">
                        {[...Array(MAX_REVIEW_LEVEL)].map((_, i) => (
                          <div 
                            key={i} 
                            className={`w-1 h-2 rounded-full ${
                              i < storageService.calculateLevelFromStability(reviewQueue[currentIndex]?.stability) 
                                ? 'bg-blue-500 shadow-[0_0_5px_rgba(59,130,246,0.3)]' 
                                : 'bg-gray-100'
                            }`} 
                          />
                        ))}
                      </div>
                    </div>
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-[0.2em] mb-4 pr-16">科学复习卡片</p>
                    <h3 className="text-lg font-normal text-gray-800 w-full leading-normal mt-0 pr-16" style={{ wordBreak: 'break-word', overflowWrap: 'break-word', textAlign: 'left', margin: 0, padding: 0, overflow: 'hidden' }}>
                      {reviewQueue[currentIndex]?.english || ''}
                    </h3>
                    
                    <button 
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        const sen = reviewQueue[currentIndex];
                        if (sen) speak(sen.english); 
                      }}
                      className="mt-6 w-16 h-16 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-2xl hover:scale-110 active:scale-95 transition-all z-20 self-center"
                    >
                      🔊
                    </button>
                    
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-widest mt-6 animate-pulse self-center">点击翻转查看翻译</p>
                  </div>
                  <div 
                    className="card-back p-6 flex flex-col items-start justify-start"
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'absolute', 
                      inset: 0,
                      transform: 'rotateY(180deg)',
                      minHeight: '380px',
                      textAlign: 'left',
                      paddingTop: '20px',
                      paddingBottom: '20px',
                      overflow: 'hidden'
                    }}
                  >
                    <div className="absolute top-3 right-3 opacity-0 pointer-events-none">占位</div>
                    
                    <p className="text-[10px] opacity-0 mb-4 pointer-events-none pr-16">占位</p>
                    
                    <h4 className="text-lg font-normal text-gray-900 leading-normal w-full pr-16" style={{ wordBreak: 'break-word', overflowWrap: 'break-word', textAlign: 'left', margin: 0, padding: 0, overflow: 'hidden' }}>
                      {reviewQueue[currentIndex]?.chinese || ''}
                    </h4>
                    
                    <div className="w-16 h-16 mt-6 opacity-0 pointer-events-none self-center"></div>
                    
                    <div className="mt-10 px-6 py-2 bg-blue-50 text-blue-500 px-6 py-2 rounded-full text-[10px] font-black uppercase tracking-[0.2em] self-center">
                      Scientific Review
                    </div>
                  </div>
                </div>
              </div>
              <div className={`grid grid-cols-4 gap-3 transition-opacity duration-300 ${isReviewSubmitting ? 'opacity-50 pointer-events-none grayscale' : ''}`}>
                <button 
                  onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 1)} 
                  disabled={isReviewSubmitting || isCurrentReviewSentenceFeedbacked}
                  className={`bg-white py-4 rounded-[1.5rem] font-bold shadow-sm border transition-all ${
                    (isReviewSubmitting || isCurrentReviewSentenceFeedbacked)
                      ? 'text-gray-300 border-gray-100 cursor-not-allowed bg-gray-50' 
                      : 'text-red-400 border-red-50 hover:bg-red-50 active:scale-95'
                  }`}
                >
                  <div className="text-lg">忘记</div>
                  <div className="text-[10px] opacity-60">Again</div>
                </button>
                <button 
                  onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 2)} 
                  disabled={isReviewSubmitting || isCurrentReviewSentenceFeedbacked}
                  className={`bg-white py-4 rounded-[1.5rem] font-bold shadow-sm border transition-all ${
                    (isReviewSubmitting || isCurrentReviewSentenceFeedbacked)
                      ? 'text-gray-300 border-gray-100 cursor-not-allowed bg-gray-50' 
                      : 'text-orange-400 border-orange-50 hover:bg-orange-50 active:scale-95'
                  }`}
                >
                  <div className="text-lg">困难</div>
                  <div className="text-[10px] opacity-60">Hard</div>
                </button>
                <button 
                  onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 3)} 
                  disabled={isReviewSubmitting || isCurrentReviewSentenceFeedbacked}
                  className={`bg-white py-4 rounded-[1.5rem] font-bold shadow-sm border transition-all ${
                    (isReviewSubmitting || isCurrentReviewSentenceFeedbacked)
                      ? 'text-gray-300 border-gray-100 cursor-not-allowed bg-gray-50' 
                      : 'text-blue-500 border-blue-50 hover:bg-blue-50 active:scale-95'
                  }`}
                >
                  <div className="text-lg">一般</div>
                  <div className="text-[10px] opacity-60">Good</div>
                </button>
                <button 
                  onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 4)} 
                  disabled={isReviewSubmitting || isCurrentReviewSentenceFeedbacked}
                  className={`py-4 rounded-[1.5rem] font-black shadow-xl transition-all ${
                    (isReviewSubmitting || isCurrentReviewSentenceFeedbacked)
                      ? 'bg-gray-200 text-gray-400 shadow-none cursor-not-allowed' 
                      : 'bg-green-500 text-white shadow-green-200 active:scale-95'
                  }`}
                >
                  <div className="text-lg">简单</div>
                  <div className="text-[10px] opacity-80">Easy</div>
                </button>
              </div>
              
              <div className="flex justify-between items-center px-4 mt-8 pt-6 border-t border-gray-100/50">
                <button 
                  onClick={() => setCurrentIndex(prev => (prev - 1 + reviewQueue.length) % reviewQueue.length)}
                  className="group flex items-center gap-2 px-4 py-3 rounded-2xl text-gray-400 hover:bg-white hover:text-blue-600 hover:shadow-md transition-all active:scale-95"
                >
                  <span className="text-xl group-hover:-translate-x-1 transition-transform">←</span>
                  <span className="text-[10px] font-black uppercase tracking-widest">Prev</span>
                </button>
                
                <div className="flex flex-col items-center gap-1">
                  <span className="text-2xl font-black text-gray-900 leading-none">{currentIndex + 1}</span>
                  <div className="h-0.5 w-8 bg-gray-100 rounded-full">
                    <div 
                      className="h-full bg-blue-500 rounded-full transition-all duration-300"
                      style={{ width: `${((currentIndex + 1) / reviewQueue.length) * 100}%` }}
                    />
                  </div>
                </div>

                <button 
                  onClick={() => setCurrentIndex(prev => (prev + 1) % reviewQueue.length)}
                  className="group flex items-center gap-2 px-4 py-3 rounded-2xl text-gray-400 hover:bg-white hover:text-blue-600 hover:shadow-md transition-all active:scale-95"
                >
                  <span className="text-[10px] font-black uppercase tracking-widest">Next</span>
                  <span className="text-xl group-hover:translate-x-1 transition-transform">→</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="apple-card p-16 text-center space-y-6">
              <div className="text-7xl">🌊</div>
              <h2 className="text-2xl font-black text-gray-900 tracking-tight">已完成所有复习</h2>
              <p className="text-gray-400 font-medium">今天的记忆任务已圆满完成。</p>
            </div>
          )
        )}

        {activeTab === 'dictation' && (
          <div className="space-y-10 animate-in slide-in-from-left-4 duration-500">
            {dictationPool.length > 0 ? (
              <div className="apple-card p-4 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-orange-100/30 rounded-full blur-3xl -mr-10 -mt-10" />
                <div className="flex justify-between items-start mb-8">
                  <div>
                    <h3 className="text-xl font-black text-gray-900 tracking-tight">盲听默写</h3>
                    <p className="text-[10px] font-black text-orange-500 uppercase tracking-widest mt-1">Dictation Challenge</p>
                  </div>
                  {/* ========== 核心修复3：重构刷新按钮样式，确保可点击 ========== */}
                  <button 
                    onClick={handleDictationRefresh}
                    disabled={isDictationRefreshDisabled}
                    // 关键修改：提升z-index + 扩大点击区域 + 确保pointer-events + 明确的hover/active样式
                    className="w-12 h-12 flex items-center justify-center bg-orange-50 text-orange-500 rounded-full hover:bg-orange-100 hover:text-orange-600 active:scale-90 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    style={{ 
                      zIndex: 100, // 确保层级最高，不被遮挡
                      pointerEvents: isDictationRefreshDisabled ? 'none' : 'auto', // 明确点击事件
                      cursor: isDictationRefreshDisabled ? 'not-allowed' : 'pointer' // 明确光标样式
                    }}
                    aria-label="刷新默写题目"
                  >
                    🔄
                  </button>
                </div>
                
                <div className="bg-orange-50/40 p-4 rounded-[2rem] border border-orange-100/50 text-left mb-8">
                  <p className="text-lg font-normal text-gray-700 leading-normal italic" style={{ wordBreak: 'break-word', textAlign: 'left' }}>
                    "{targetSentence?.chinese || '暂无题目'}"
                  </p>
                </div>
                <textarea 
                  value={userInput} 
                  onChange={(e) => setUserInput(e.target.value)} 
                  className="w-full p-8 bg-gray-50 rounded-[2rem] border-none focus:ring-4 focus:ring-orange-100 outline-none min-h-[160px] text-lg font-semibold placeholder:text-gray-300 transition-all" 
                  placeholder="请输入听到的内容..." 
                  style={{ textAlign: 'left' }}
                />
                <div className="grid grid-cols-2 gap-4 mt-8">
                  <button 
                    onClick={() => { 
                      setIsFlipped(!isFlipped); 
                      if(!isFlipped && targetSentence) speak(targetSentence.english); 
                    }} 
                    className="bg-white text-gray-400 py-5 rounded-[2rem] font-bold border border-gray-100 active:scale-95 transition-all"
                  >
                    {isFlipped ? '隐藏答案' : '听音提示'}
                  </button>
                  <button 
                    onClick={handleDictationCheck} 
                    className="bg-orange-500 text-white py-5 rounded-[2rem] font-black text-lg shadow-xl shadow-orange-200 active:scale-95 transition-all"
                  >
                    核对
                  </button>
                </div>
                {isFlipped && targetSentence && (
                  <div className="mt-8 p-4 bg-blue-50 rounded-[2rem] animate-in slide-in-from-top-4">
                    <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2">标准答案</p>
                    <p className="text-blue-800 font-normal text-lg leading-normal" style={{ wordBreak: 'break-word', textAlign: 'left' }}>
                      {targetSentence.english}
                    </p>
                    <button 
                      onClick={() => speak(targetSentence.english)} 
                      className="mt-4 font-bold text-xs flex items-center gap-1.5 text-blue-500 hover:text-blue-700 transition-colors"
                    >
                      <span>🔊</span> 再次播放
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="apple-card p-16 text-center space-y-6">
                <div className="text-7xl">🎯</div>
                <h2 className="text-2xl font-black text-gray-900 tracking-tight">默写挑战未开启</h2>
                <p className="text-gray-400 font-medium">至少学习一个句子后开启。</p>
                {/* 新增：无数据时按钮也能点击，提示用户 */}
                <button 
                  onClick={handleDictationRefresh}
                  className="mt-4 bg-orange-100 text-orange-500 py-3 px-6 rounded-full font-bold text-sm"
                >
                  刷新试试
                </button>
              </div>
            )}
            
            <div className="space-y-4 pb-10">
              <h4 className="text-[11px] font-black text-gray-400 uppercase tracking-widest ml-4">今日成果 ({dictationList.length})</h4>
              <div className="space-y-3">
                {dictationList.map((item, idx) => {
                  const s = sentences.find(sent => sent.id === item.sentenceId);
                  if (!s) return null;
                  return (
                    <div key={idx} className="apple-card p-5 flex items-center justify-between group bg-white/60 hover:bg-white transition-all">
                      <div className="flex-1 pr-4">
                        <p className="text-sm font-bold text-gray-800 line-clamp-1">{s.english}</p>
                        <p className="text-[10px] text-gray-400 font-medium">{s.chinese}</p>
                      </div>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black ${
                        item.status === 'correct' ? 'bg-green-100 text-green-600' : 'bg-red-50 text-red-400'
                      }`}>
                        {item.status === 'correct' ? '✓' : '×'}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const StudyPageWithErrorBoundary: React.FC<StudyPageProps> = (props) => {
  const fallback = (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center space-y-6">
        <div className="text-6xl">😵</div>
        <h1 className="text-2xl font-bold text-gray-900">学习页面出错了</h1>
        <p className="text-gray-500 text-sm">
          学习页面遇到了意外错误，请尝试刷新页面。
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
        >
          刷新页面
        </button>
      </div>
    </div>
  );

  return (
    <ErrorBoundary fallback={fallback}>
      <StudyPage {...props} />
    </ErrorBoundary>
  );
};

export default StudyPageWithErrorBoundary;