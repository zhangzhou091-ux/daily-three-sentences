import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Sentence, StudyStep } from '../types';
import { geminiService } from '../services/geminiService';
import { storageService } from '../services/storage';
import { syncQueueService } from '../services/syncQueueService';
import { unlockAudioEngine, isIOSAudio } from '../services/audioUnlockService';
import { continuousAudioPlayer } from '../services/continuousAudioPlayer';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { getLocalDateString } from '../utils/date';
import { LEARN_XP } from '../constants';
import { useDailySelection } from './StudyPage/hooks/useDailySelection';
import { useLearnLogic } from './StudyPage/hooks/useLearnLogic';
import { useProgressRestore } from './StudyPage/hooks/useProgressRestore';
import { useReviewLogic } from './StudyPage/hooks/useReviewLogic';
import { useDictationLogic } from './StudyPage/hooks/useDictationLogic';
import { useRandomListening } from './StudyPage/hooks/useRandomListening';
import { useDictationReading } from './StudyPage/hooks/useDictationReading';
import { LearnCard } from './StudyPage/components/LearnCard';
import { ReviewCard } from './StudyPage/components/ReviewCard';

const SPEECH_RATE_OPTIONS = [
  { value: 0.2, label: '0.2x' },
  { value: 0.7, label: '0.7x' },
  { value: 1, label: '1x' },
];

interface StudyPageProps {
  sentences: Sentence[];
  onUpdate: () => Promise<void>;
}

const STUDY_TAB_KEY = 'd3s_study_tab';

const loadSavedTab = (): StudyStep => {
  try {
    const saved = localStorage.getItem(STUDY_TAB_KEY);
    if (saved) {
      const { date, tab } = JSON.parse(saved);
      if (date === getLocalDateString() && ['learn', 'review', 'dictation'].includes(tab)) {
        return tab as StudyStep;
      }
    }
  } catch { /* ignore */ }
  return 'learn';
};

const saveStudyTab = (tab: StudyStep) => {
  try {
    localStorage.setItem(STUDY_TAB_KEY, JSON.stringify({
      date: getLocalDateString(),
      tab
    }));
  } catch { /* ignore */ }
};

const loadLearnProgressIndex = (): number => {
  try {
    const saved = localStorage.getItem('d3s_learn_progress') ||
                  sessionStorage.getItem('d3s_learn_progress');
    if (!saved) return 0;
    const { index, date } = JSON.parse(saved);
    if (date === getLocalDateString() && typeof index === 'number' && index >= 0) {
      return index;
    }
  } catch { /* ignore */ }
  return 0;
};

const StudyPage: React.FC<StudyPageProps> = ({ sentences, onUpdate }) => {
  const [activeTab, setActiveTabState] = useState<StudyStep>(() => loadSavedTab());
  const [currentIndex, setCurrentIndex] = useState(() => loadLearnProgressIndex());
  const [isFlipped, setIsFlipped] = useState(false);
  
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'failed'>('idle');
  const [syncErrorMsg, setSyncErrorMsg] = useState<string | null>(null);
  const [offlineQueueCount, setOfflineQueueCount] = useState(() => syncQueueService.getPendingOperations().length);
  const isSyncingRef = useRef(false);
  
  const isGeneratingRef = useRef(false);
  const isMountedRef = useRef(true);
  const isMarkLearnedSubmittingRef = useRef(false);
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasTriggeredRegenRef = useRef(false);

  const TAB_ORDER: StudyStep[] = ['learn', 'review', 'dictation'];
  const swipeContainerRef = useRef<HTMLDivElement>(null);
  const [isSwiping, setIsSwiping] = useState(false);
  const isSwipingRef = useRef(false);
  const touchStartRef = useRef({ x: 0, y: 0 });
  const touchCurrentRef = useRef({ x: 0, y: 0 });
  const swipeDirectionRef = useRef<'horizontal' | 'vertical' | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  
  const [progressAdjusted, setProgressAdjusted] = useState(false);
  const [currentDateStr, setCurrentDateStr] = useState(() => getLocalDateString());
  const [speakError, setSpeakError] = useState<string | null>(null);
  const [speakingText, setSpeakingText] = useState<string | null>(null);
  
  const [settings, setSettings] = useState(() => storageService.getSettings());
  const todayStr = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  }, [currentDateStr]);

  const setActiveTab = useCallback((tab: StudyStep) => {
    setActiveTabState(tab);
    saveStudyTab(tab);
  }, []);

  const handleSwipeStart = useCallback((e: React.TouchEvent) => {
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    touchCurrentRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    swipeDirectionRef.current = null;
  }, []);

  const handleSwipeMove = useCallback((e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - touchStartRef.current.x;
    const dy = e.touches[0].clientY - touchStartRef.current.y;

    if (swipeDirectionRef.current === null) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        swipeDirectionRef.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      }
      return;
    }

    if (swipeDirectionRef.current === 'horizontal') {
      isSwipingRef.current = true;
      setIsSwiping(true);
      touchCurrentRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };

      const currentIdx = TAB_ORDER.indexOf(activeTab);
      let offset = dx;
      if ((currentIdx === 0 && dx > 0) || (currentIdx === TAB_ORDER.length - 1 && dx < 0)) {
        offset = dx * 0.3;
      }
      setSwipeOffset(offset);
    }
  }, [activeTab]);

  useEffect(() => {
    const handleSettingsChange = () => {
      setSettings(storageService.getSettings());
    };
    window.addEventListener('settingsChanged', handleSettingsChange);
    return () => window.removeEventListener('settingsChanged', handleSettingsChange);
  }, []);

  useEffect(() => {
    if (!isIOSAudio()) return;
    const unlock = () => {
      unlockAudioEngine();
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
    };
    document.addEventListener('click', unlock, { once: true });
    document.addEventListener('touchstart', unlock, { once: true });
    return () => {
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
    };
  }, []);
  
  const { 
    dailySelection, 
    setDailySelection, 
    generateDailySelection 
  } = useDailySelection({ 
    sentences, 
    isGeneratingRef 
  });

  const { 
    completedIds, 
    isSavingLearned, 
    handleMarkLearned,
    setAnimatingLearnedId 
  } = useLearnLogic({
    sentences,
    setDailySelection,
    onUpdate,
    isOnline,
    isMountedRef,
    isMarkLearnedSubmittingRef,
    animationTimerRef,
  });

  const { currentLearnSentenceRef, saveCurrentLearnProgress } = useProgressRestore({
    activeTab,
    dailySelection,
    currentIndex,
    setCurrentIndex,
    isGeneratingRef,
    isMountedRef,
    setProgressAdjusted,
  });

  const [trainingIds, setTrainingIds] = useState<string[]>(() => {
    try {
      const saved = sessionStorage.getItem('trainingSession');
      if (saved) {
        sessionStorage.removeItem('trainingSession');
        const ids: string[] = JSON.parse(saved);
        if (Array.isArray(ids) && ids.length > 0) {
          return ids;
        }
      }
    } catch { /* ignore */ }
    return [];
  });

  const { 
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
    saveCurrentReviewProgress,
  } = useReviewLogic({
    sentences,
    settings,
    currentDateStr,
    activeTab,
    isMountedRef,
    onUpdate,
    trainingIds: trainingIds.length > 0 ? trainingIds : undefined,
  });

  const { 
    dictationPool,
    targetDictationId,
    dictationList,
    userInput,
    setUserInput,
    isDictationRefreshDisabled,
    isDictationChecking,
    handleDictationRefresh,
    handleDictationCheck,
  } = useDictationLogic({
    sentences,
    isOnline,
    isMountedRef,
  });

  const {
    isRandomListeningActive,
    randomListeningSentence,
    randomListeningRepeat,
    randomListeningTotal,
    randomListeningError,
    randomListeningPoolSize,
    toggleRandomListening,
    stopRandomListening,
    goToPreviousSentence,
    goToNextSentence,
    canGoPrevious,
    canGoNext,
    toggleBlacklist,
    isBlacklisted,
    clearBlacklist,
    blacklistSize,
    REPEATS_PER_SENTENCE,
  } = useRandomListening(sentences);

  const {
    isDictationReadingActive,
    dictationReadingSentence,
    dictationReadingIndex,
    dictationReadingRepeat,
    dictationReadingTotal,
    dictationReadingError,
    dictationReadingPoolSize,
    toggleDictationReading,
    stopDictationReading,
    goToPrevReadingSentence,
    goToNextReadingSentence,
    canGoPrevReadingSentence,
    canGoNextReadingSentence,
    toggleBlacklist: dictationToggleBlacklist,
    isBlacklisted: isDictationBlacklisted,
    clearBlacklist: clearDictationBlacklist,
    blacklistSize: dictationBlacklistSize,
    REPEATS_PER_SENTENCE: DICTATION_READING_REPEATS,
  } = useDictationReading(sentences, dailySelection);

  const [dictationReadingMode, setDictationReadingMode] = useState<'random' | 'sequential'>('sequential');

  const handleToggleRandomListening = useCallback(() => {
    if (isDictationReadingActive) stopDictationReading();
    toggleRandomListening();
  }, [isDictationReadingActive, stopDictationReading, toggleRandomListening]);

  const handleToggleDictationReading = useCallback(() => {
    if (isRandomListeningActive) stopRandomListening();
    toggleDictationReading();
  }, [isRandomListeningActive, stopRandomListening, toggleDictationReading]);

  const handleSwipeEnd = useCallback(() => {
    if (!isSwipingRef.current) {
      swipeDirectionRef.current = null;
      return;
    }
    isSwipingRef.current = false;
    setIsSwiping(false);
    swipeDirectionRef.current = null;

    const dx = touchCurrentRef.current.x - touchStartRef.current.x;
    const currentIdx = TAB_ORDER.indexOf(activeTab);
    const containerWidth = swipeContainerRef.current?.offsetWidth || 375;
    const threshold = containerWidth * 0.3;

    if (Math.abs(dx) > threshold) {
      geminiService.stop();
      setSpeakingText(null);
      if (isRandomListeningActive) stopRandomListening();
      if (isDictationReadingActive) stopDictationReading();

      if (dx < 0 && currentIdx < TAB_ORDER.length - 1) {
        setActiveTab(TAB_ORDER[currentIdx + 1]);
        setCurrentIndex(0);
        setIsFlipped(TAB_ORDER[currentIdx + 1] === 'review');
      } else if (dx > 0 && currentIdx > 0) {
        setActiveTab(TAB_ORDER[currentIdx - 1]);
        setCurrentIndex(0);
        setIsFlipped(TAB_ORDER[currentIdx - 1] === 'review');
      }
    }

    setSwipeOffset(0);
  }, [activeTab, setActiveTab, isRandomListeningActive, stopRandomListening, isDictationReadingActive, stopDictationReading]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentLearnProgress();
        saveCurrentReviewProgress();
      }
      if (document.visibilityState === 'visible') {
        const newDate = getLocalDateString();
        if (newDate !== currentDateStr) {
          console.log('📅 检测到日期变化，触发复习队列重建');
          setCurrentDateStr(newDate);
        }
        if (window.speechSynthesis && window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
        continuousAudioPlayer.resumeAudioFocus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [currentDateStr, saveCurrentLearnProgress, saveCurrentReviewProgress]);

  const [animatingLearnedId, setAnimatingLearnedIdState] = useState<string | null>(null);
  
  useEffect(() => {
    if (trainingIds.length > 0 && activeTab !== 'review') {
      setActiveTab('review');
      setIsFlipped(true);
    }
  }, [trainingIds]);

  const setAnimatingLearnedIdWrapper = useCallback((id: string | null) => {
    setAnimatingLearnedIdState(id);
    setAnimatingLearnedId(id);
  }, [setAnimatingLearnedId]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      geminiService.stop();
    };
  }, []);

  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    if (prevTabRef.current !== activeTab) {
      prevTabRef.current = activeTab;
      geminiService.stop();
      setSpeakingText(null);
    }
  }, [activeTab]);

  const syncOfflineOperations = async () => {
    if (isSyncingRef.current) return;
    
    if (!navigator.onLine) {
      setSyncStatus('failed');
      setSyncErrorMsg('网络连接已断开');
      return;
    }
    isSyncingRef.current = true;
    setSyncStatus('syncing');
    setSyncErrorMsg(null);
    
    try {
      const result = await syncQueueService.syncNow();
      
      if (!result.success) {
        setSyncStatus('failed');
        setSyncErrorMsg(result.message || '部分同步任务失败');
        return;
      }
      
      try {
        await onUpdate();
        setSyncStatus('idle');
      } catch (updateErr: unknown) {
        if (updateErr instanceof Error) {
          console.warn('同步后刷新数据失败:', updateErr.message);
        } else {
          console.warn('同步后刷新数据失败:', String(updateErr));
        }
        setSyncStatus('failed');
        setSyncErrorMsg('数据刷新失败，请手动刷新页面');
      }
    } catch (err: unknown) {
      console.error('同步操作失败:', err);
      setSyncStatus('failed');
      const message = err instanceof Error ? err.message : '网络连接异常，请稍后重试';
      setSyncErrorMsg(message);
    } finally {
      isSyncingRef.current = false;
    }
  };

  useEffect(() => {
    const updateQueueCount = () => {
      setOfflineQueueCount(syncQueueService.getPendingOperations().length);
    };

    updateQueueCount();
    const unsubscribe = syncQueueService.on('queueChanged', updateQueueCount);

    return () => {
      unsubscribe();
    };
  }, []);

  const speak = useCallback(async (text: string, loop: boolean = true) => {
    if (!text?.trim()) return;

    // 同步抢占音频通道，在异步请求前锁定 User Gesture Token
    continuousAudioPlayer.primeAudioChannelWithSilence();

    if (loop && speakingText === text) {
      geminiService.stop();
      setSpeakingText(null);
      return;
    }

    geminiService.stop();
    if (loop) setSpeakingText(text);

    try {
      await geminiService.speak(text, loop);
      if (!loop) setSpeakingText(null);
    } catch (err: unknown) {
      setSpeakingText(null);
      if (err instanceof Error) {
        console.warn('语音播放失败', err.message);
      } else {
        console.warn('语音播放失败', String(err));
      }
      setSpeakError('语音播放失败，请在设置中检查TTS引擎配置');
      setTimeout(() => setSpeakError(null), 3000);
    }
  }, [speakingText]);

  const handleSpeechRateChange = useCallback((rate: number) => {
    const clampedRate = Math.max(0.1, Math.min(10, rate));
    const updated = { ...settings, speechRate: clampedRate, updatedAt: Date.now() };
    storageService.saveSettings(updated);
    setSettings(updated);
    geminiService.setPlaybackRate(clampedRate);
  }, [settings]);

  useEffect(() => {
    if (activeTab !== 'review') return;

    if (reviewQueue.length === 0) {
      return;
    }

    const activeId = currentReviewIdRef.current;
    const foundInQueue = reviewQueue.some(s => s.id === activeId);

    if (!activeId || !foundInQueue) {
      setCurrentReviewId(reviewQueue[0].id);
    }
  }, [reviewQueue, activeTab, currentReviewIdRef, setCurrentReviewId]);
  
  useEffect(() => {
    if (activeTab === 'review' && currentReviewId) {
      setIsFlipped(true);
    }
  }, [activeTab, currentReviewId]);

  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;

  useEffect(() => {
    if (dailySelection.length > 0 && currentIndexRef.current >= dailySelection.length) {
      setCurrentIndex(Math.max(0, dailySelection.length - 1));
    }
  }, [dailySelection.length]);

  const sentenceLookup = useMemo(() => {
    const map = new Map<string, Sentence>();
    sentences.forEach(s => map.set(s.id, s));
    return map;
  }, [sentences]);

  const targetSentence = targetDictationId ? sentenceLookup.get(targetDictationId) || null : null;
  
  const currentSentence = dailySelection[currentIndex] || null;
  const currentSentenceLatest = currentSentence 
    ? sentenceLookup.get(currentSentence.id) || currentSentence 
    : null;
  const isCurrentlyLearned = useMemo(() => {
    if (!currentSentence) return false;
    return currentSentence.intervalIndex > 0 || completedIds.has(currentSentence.id);
  }, [currentSentence, completedIds]);
  const isAnimating = currentSentence && animatingLearnedId === currentSentence.id;
  
  const allLearned = useMemo(() => {
    const todayIds = dailySelection.map(s => s.id);
    if (todayIds.length === 0) return false;
    return todayIds.every(id => {
      const sentence = sentenceLookup.get(id);
      return sentence ? sentence.intervalIndex > 0 : false;
    });
  }, [dailySelection, sentenceLookup]);
  
  useEffect(() => {
    if (!allLearned) {
      hasTriggeredRegenRef.current = false;
      return;
    }
    if (activeTab !== 'learn') return;
    if (isGeneratingRef.current) return;
    if (hasTriggeredRegenRef.current) return;
    if (!sentences.some(s => s.intervalIndex === 0)) return;

    hasTriggeredRegenRef.current = true;
    console.log('🔄 dailySelection 中句子已全部学习，但仍有未学习句子，触发重新生成');
    generateDailySelection();
  }, [allLearned, sentences, generateDailySelection, activeTab]);

  useEffect(() => {
    if (activeTab !== 'learn') return;
    if (dailySelection.length === 0) return;
    if (currentIndex < dailySelection.length) return;
    setCurrentIndex(0);
  }, [dailySelection, currentIndex, activeTab, setCurrentIndex]);

  const currentReviewSentence = useMemo(() => {
    if (reviewQueue.length === 0 || currentReviewIndex < 0) return null;
    return reviewQueue[currentReviewIndex] || null;
  }, [reviewQueue, currentReviewIndex]);
  
  const isCurrentReviewed = useMemo(() => {
    if (!currentReviewSentence) return false;
    
    if (reviewedIds.has(currentReviewSentence.id)) return true;
    
    const today = getLocalDateString();
    const lastReviewed = currentReviewSentence.lastReviewedAt 
      ? getLocalDateString(currentReviewSentence.lastReviewedAt)
      : null;
      
    return lastReviewed === today;
  }, [currentReviewSentence, reviewedIds]);

  const shouldDisableReviewButton = useCallback((sentenceId: string) => {
    if (!sentenceId || isProcessingReview) return true;
    return false;
  }, [isProcessingReview]);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-700 pb-20 max-w-2xl mx-auto">
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
        <div className="bg-red-50 text-red-600 text-sm font-bold px-4 py-2 rounded-lg flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span>⚠️ 同步失败</span>
            <button 
              onClick={syncOfflineOperations}
              className="text-red-700 underline hover:text-red-900"
            >
              点击重试（{offlineQueueCount}个操作）
            </button>
          </div>
          {syncErrorMsg && <span className="text-xs text-red-500">{syncErrorMsg}</span>}
        </div>
      )}
      {progressAdjusted && (
        <div className="bg-yellow-50 text-yellow-700 text-sm font-bold px-4 py-2 rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-300">
          <span>📍 学习列表有变动</span>
          <span>已为你定位到最新进度</span>
        </div>
      )}
      {speakError && (
        <div className="bg-orange-50 text-orange-600 text-sm font-bold px-4 py-2 rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-300">
          <span>🔊 {speakError}</span>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 px-2">
        <div>
          <p className="text-gray-600 text-xs font-bold uppercase tracking-widest mb-1 flex items-center gap-2">
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
                onClick={() => { geminiService.stop(); setSpeakingText(null); if (isRandomListeningActive) stopRandomListening(); if (isDictationReadingActive) stopDictationReading(); setActiveTab(tab); setCurrentIndex(0); setIsFlipped(tab === 'review'); }}
                className={`px-4 py-2 text-[11px] font-black uppercase tracking-wider rounded-[1.2rem] transition-all duration-300 ${
                  activeTab === tab ? 'bg-white shadow-sm text-blue-600' : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                {tab === 'learn' ? '学习' : tab === 'review' ? '复习' : '默写'}
              </button>
            ))}
        </div>
      </div>

      <div
        ref={swipeContainerRef}
        className="min-h-[460px] overflow-hidden"
        style={{ touchAction: 'pan-y' }}
        onTouchStart={handleSwipeStart}
        onTouchMove={handleSwipeMove}
        onTouchEnd={handleSwipeEnd}
      >
        <div
          className="transition-transform duration-300"
          style={{
            transform: `translateX(${swipeOffset}px)`,
            transitionDuration: isSwiping ? '0ms' : '300ms',
          }}
        >
        {activeTab === 'learn' && (
          dailySelection.length > 0 ? (
            (() => {
              if (!currentSentenceLatest) return null;
              const sentence = currentSentenceLatest || currentSentence;
              if (!sentence) return null;
              return (
            <div className="space-y-8">
              <LearnCard
                sentence={sentence}
                onFlip={() => setIsFlipped(!isFlipped)}
                isFlipped={isFlipped}
                onMarkLearned={handleMarkLearned}
                onSpeak={speak}
                isCurrentlyLearned={isCurrentlyLearned}
                isAnimating={isAnimating}
                isSavingLearned={isSavingLearned}
                isSpeaking={speakingText === sentence.english}
                speechRate={settings.speechRate ?? 1}
                onSpeechRateChange={(rate) => {
                  const clampedRate = Math.max(0.1, Math.min(10, rate));
                  const updated = { ...settings, speechRate: clampedRate, updatedAt: Date.now() };
                  storageService.saveSettings(updated);
                  setSettings(updated);
                  geminiService.setPlaybackRate(clampedRate);
                }}
              />
              <div className="flex flex-col gap-4">
                {!isCurrentlyLearned && !isAnimating ? (
                  <>
                    <button
                      onClick={() => handleMarkLearned(sentence.id)}
                      className="w-full bg-black text-white py-5 rounded-[2rem] font-black text-xl shadow-2xl shadow-black/10 hover:bg-gray-800 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                    >
                      <span>标记掌握</span>
                      <span className="text-sm opacity-50">+{LEARN_XP} XP</span>
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => {
                        setIsFlipped(false);
                        if (currentIndex < dailySelection.length - 1) {
                            setCurrentIndex(currentIndex + 1);
                        } else {
                            setCurrentIndex(0);
                        }
                    }}
                    disabled={isSavingLearned}
                    className={`w-full py-5 rounded-[2rem] font-black text-xl shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 ${
                      isSavingLearned 
                        ? 'bg-gray-300 text-gray-500 cursor-not-allowed' 
                        : 'bg-green-500 text-white shadow-green-200'
                    }`}
                  >
                    {isSavingLearned ? (
                      <>
                        <span className="animate-spin">⏳</span>
                        <span>保存中...</span>
                      </>
                    ) : (
                      <>
                        <span>继续下一个</span>
                        <span className="text-xl">→</span>
                      </>
                    )}
                  </button>
                )}
                
                <div className="flex justify-between items-center px-6">
                    <button 
                      onClick={() => { 
                        setIsFlipped(false); 
                        setCurrentIndex((currentIndex - 1 + dailySelection.length) % dailySelection.length); 
                      }} 
                      className="text-lg font-bold uppercase tracking-widest transition-colors text-gray-600 hover:text-blue-500"
                    >
                      ← Prev
                    </button>
                    <div className="flex items-center gap-2">
                       <span className="text-lg text-gray-900 font-black tracking-widest">{currentIndex + 1}</span>
                       <span className="text-lg text-gray-600 font-black tracking-widest">/</span>
                       <span className="text-lg text-gray-600 font-black tracking-widest">{dailySelection.length}</span>
                    </div>
                    <button 
                      onClick={() => { 
                        setIsFlipped(false); 
                        setCurrentIndex((currentIndex + 1) % dailySelection.length); 
                      }} 
                      className="text-lg font-bold uppercase tracking-widest transition-colors text-gray-600 hover:text-blue-500"
                    >
                      Next →
                    </button>
                </div>
              </div>
            </div>
              );
            })()
          ) : (
            <div className="apple-card p-16 text-center space-y-6">
              <div className="text-7xl">🪴</div>
              <h2 className="text-2xl font-black text-gray-900 tracking-tight">库中暂无可学内容</h2>
              <p className="text-gray-600 font-medium">请到仓库页添加新句子。</p>
            </div>
          )
        )}

        {activeTab === 'review' && (
          reviewQueue.length > 0 ? (
            <div className="space-y-8 animate-in slide-in-from-right-4 duration-500">
              {trainingIds.length > 0 && (
                <div className="bg-gradient-to-r from-orange-50 to-amber-50 text-orange-700 text-sm font-bold px-4 py-2 rounded-lg flex items-center justify-between border border-orange-100">
                  <span className="flex items-center gap-2">
                    <span>🎯</span>
                    <span>专项特训模式 · {trainingIds.length} 个顽固句子</span>
                  </span>
                  <button
                    onClick={() => setTrainingIds([])}
                    className="text-orange-500 hover:text-orange-700 text-xs font-black underline"
                  >
                    退出特训
                  </button>
                </div>
              )}
              <ReviewCard
                sentence={reviewQueue[currentReviewIndex]!}
                onFlip={() => setIsFlipped(!isFlipped)}
                isFlipped={isFlipped}
                onSpeak={speak}
                scheduledDays={reviewQueue[currentReviewIndex]?.scheduledDays}
                reps={reviewQueue[currentReviewIndex]?.reps || 0}
                isSpeaking={speakingText === reviewQueue[currentReviewIndex]?.english}
                speechRate={settings.speechRate ?? 1}
                onSpeechRateChange={(rate) => {
                  const clampedRate = Math.max(0.1, Math.min(10, rate));
                  const updated = { ...settings, speechRate: clampedRate, updatedAt: Date.now() };
                  storageService.saveSettings(updated);
                  setSettings(updated);
                  geminiService.setPlaybackRate(clampedRate);
                }}
              />

              {!isCurrentReviewed ? (
                <div className={`grid grid-cols-4 gap-3 transition-opacity duration-300 ${isProcessingReview ? 'opacity-50 pointer-events-none grayscale' : ''}`}>
                  <button 
                    onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 1)} 
                    disabled={shouldDisableReviewButton(currentReviewSentence?.id || '')}
                    className={`bg-white py-4 rounded-[1.5rem] font-bold shadow-sm border transition-all ${
                      shouldDisableReviewButton(currentReviewSentence?.id || '')
                        ? 'text-gray-400 border-gray-100 cursor-not-allowed bg-gray-50' 
                        : 'text-red-400 border-red-50 hover:bg-red-50 active:scale-95'
                    }`}
                  >
                    <div className="text-lg">忘记</div>
                    <div className="text-xs opacity-60">Again</div>
                  </button>
                  <button 
                    onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 2)} 
                    disabled={shouldDisableReviewButton(currentReviewSentence?.id || '')}
                    className={`bg-white py-4 rounded-[1.5rem] font-bold shadow-sm border transition-all ${
                      shouldDisableReviewButton(currentReviewSentence?.id || '')
                        ? 'text-gray-400 border-gray-100 cursor-not-allowed bg-gray-50' 
                        : 'text-orange-400 border-orange-50 hover:bg-orange-50 active:scale-95'
                    }`}
                  >
                    <div className="text-lg">困难</div>
                    <div className="text-xs opacity-60">Hard</div>
                  </button>
                  <button 
                    onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 3)} 
                    disabled={shouldDisableReviewButton(currentReviewSentence?.id || '')}
                    className={`bg-white py-4 rounded-[1.5rem] font-bold shadow-sm border transition-all ${
                      shouldDisableReviewButton(currentReviewSentence?.id || '')
                        ? 'text-gray-400 border-gray-100 cursor-not-allowed bg-gray-50' 
                        : 'text-blue-500 border-blue-50 hover:bg-blue-50 active:scale-95'
                    }`}
                  >
                    <div className="text-lg">一般</div>
                    <div className="text-xs opacity-60">Good</div>
                  </button>
                  <button 
                    onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 4)} 
                    disabled={shouldDisableReviewButton(currentReviewSentence?.id || '')}
                    className={`py-4 rounded-[1.5rem] font-black shadow-xl transition-all ${
                      shouldDisableReviewButton(currentReviewSentence?.id || '')
                        ? 'bg-gray-200 text-gray-500 shadow-none cursor-not-allowed' 
                        : 'bg-green-500 text-white shadow-green-200 active:scale-95'
                    }`}
                  >
                    <div className="text-lg">简单</div>
                    <div className="text-xs opacity-80">Easy</div>
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setIsFlipped(true);
                    if (currentReviewIndex < reviewQueue.length - 1) {
                      goToReviewIndex(currentReviewIndex + 1);
                    } else {
                      goToReviewIndex(0);
                      setIsFlipped(true);
                    }
                  }}
                  className="w-full bg-green-500 text-white py-5 rounded-[2rem] font-black text-xl shadow-xl shadow-green-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                >
                  <span>继续下一个</span>
                  <span className="text-xl">→</span>
                </button>
              )}
              
              <div className="flex justify-between items-center px-4 mt-2">
                <button 
                  onClick={() => goToReviewIndex(currentReviewIndex - 1)}
                  disabled={isProcessingReview}
                  className={`group flex items-center gap-3 px-6 py-4 rounded-2xl transition-all active:scale-95 ${
                    isProcessingReview
                      ? 'text-gray-300 cursor-not-allowed'
                      : 'text-gray-500 hover:bg-white hover:text-blue-600 hover:shadow-md'
                  }`}
                >
                  <span className="text-2xl group-hover:-translate-x-1 transition-transform">←</span>
                  <span className="text-lg font-black uppercase tracking-widest">Prev</span>
                </button>
                
                <div className="flex flex-col items-center gap-1">
                  <span className="text-2xl font-black text-gray-900 leading-none">{currentReviewIndex + 1}</span>
                  <div className="h-0.5 w-8 bg-gray-100 rounded-full">
                    <div 
                      className="h-full bg-blue-500 rounded-full transition-all duration-300"
                      style={{ width: `${((currentReviewIndex + 1) / reviewQueue.length) * 100}%` }}
                    />
                  </div>
                </div>

                <button 
                  onClick={() => goToReviewIndex(currentReviewIndex + 1)}
                  disabled={isProcessingReview}
                  className={`group flex items-center gap-3 px-6 py-4 rounded-2xl transition-all active:scale-95 ${
                    isProcessingReview
                      ? 'text-gray-300 cursor-not-allowed'
                      : 'text-gray-500 hover:bg-white hover:text-blue-600 hover:shadow-md'
                  }`}
                >
                  <span className="text-lg font-black uppercase tracking-widest">Next</span>
                  <span className="text-2xl group-hover:translate-x-1 transition-transform">→</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="text-7xl mb-6">✨</div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">暂无待复习内容</h3>
              <p className="text-gray-500 text-center max-w-xs mb-4">
                你已经完成了所有待复习的句子，做得太棒了！请明天再来。
              </p>
              <div className="flex gap-3">
                <button 
                  onClick={() => { setActiveTab('learn'); }}
                  className="px-6 py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors"
                >
                  去学习新句子
                </button>
                <button 
                  onClick={() => { setActiveTab('dictation'); }}
                  className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors"
                >
                  去默写挑战
                </button>
              </div>
            </div>
          )
        )}

        {activeTab === 'dictation' && (
          <div className="space-y-10 animate-in slide-in-from-left-4 duration-500 safe-area-bottom">
            {/* 合并朗读卡片：随机/顺序 模式切换 */}
            <div className="apple-card p-6 relative overflow-hidden" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start', textAlign: 'left', paddingTop: '20px', paddingBottom: '20px' }}>
              {/* 顶部栏：模式切换 + 语速 + 信息 */}
              <div className="w-full flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-3">
                {/* 模式切换 */}
                <div className="flex bg-gray-200/50 p-1 rounded-[1.2rem] self-start">
                  <button
                    onClick={() => { if (isRandomListeningActive) stopRandomListening(); if (isDictationReadingActive) stopDictationReading(); setDictationReadingMode('random'); }}
                    className={`px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-[1rem] transition-all duration-200 ${
                      dictationReadingMode === 'random' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    随机
                  </button>
                  <button
                    onClick={() => { if (isRandomListeningActive) stopRandomListening(); if (isDictationReadingActive) stopDictationReading(); setDictationReadingMode('sequential'); }}
                    className={`px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-[1rem] transition-all duration-200 ${
                      dictationReadingMode === 'sequential' ? 'bg-white shadow-sm text-green-600' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    顺序
                  </button>
                </div>
                {/* 语速 + 信息 */}
                <div className="flex items-center gap-2 flex-wrap">
                  {SPEECH_RATE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        const clampedRate = Math.max(0.1, Math.min(10, opt.value));
                        const updated = { ...settings, speechRate: clampedRate, updatedAt: Date.now() };
                        storageService.saveSettings(updated);
                        setSettings(updated);
                        geminiService.setPlaybackRate(clampedRate);
                      }}
                      className={`px-2.5 py-0.5 rounded-full text-xs font-bold transition-all ${
                        (settings.speechRate ?? 1) === opt.value
                          ? 'bg-blue-500 text-white shadow-sm'
                          : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                  {(dictationReadingMode === 'random' ? blacklistSize : dictationBlacklistSize) > 0 && (
                    <button
                      onClick={() => {
                        if (dictationReadingMode === 'random') {
                          clearBlacklist();
                        } else {
                          clearDictationBlacklist();
                        }
                      }}
                      className="text-xs font-bold text-gray-400 hover:text-red-500 transition-colors ml-1"
                    >
                      清除排除({dictationReadingMode === 'random' ? blacklistSize : dictationBlacklistSize})
                    </button>
                  )}
                  <span className="text-xs font-bold text-gray-400 ml-1">
                    {dictationReadingMode === 'random' ? randomListeningPoolSize : dictationReadingPoolSize} 句可用
                  </span>
                </div>
              </div>

              {/* 句子内容区 */}
              <div className="mt-[1.5em] flex flex-col items-center w-full flex-1 overflow-y-auto min-h-0">
                {dictationReadingMode === 'random' ? (
                  /* === 随机朗读 === */
                  isRandomListeningActive && randomListeningSentence ? (
                    <>
                      <div className="w-full text-left space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <h3 className={`text-lg font-normal leading-normal w-full break-words whitespace-pre-wrap ${
                              isBlacklisted(randomListeningSentence.id) ? 'text-gray-300 line-through' : 'text-gray-900'
                            }`}>
                              {randomListeningSentence.english}
                            </h3>
                            <p className={`text-sm leading-normal break-words ${
                              isBlacklisted(randomListeningSentence.id) ? 'text-gray-200 line-through' : 'text-gray-400'
                            }`}>
                              {randomListeningSentence.chinese}
                            </p>
                          </div>
                          <button
                            onClick={() => toggleBlacklist(randomListeningSentence.id)}
                            className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs transition-all ${
                              isBlacklisted(randomListeningSentence.id)
                                ? 'bg-red-100 text-red-500 hover:bg-red-200'
                                : 'bg-gray-100 text-gray-400 hover:bg-gray-200 hover:text-gray-600'
                            }`}
                            title={isBlacklisted(randomListeningSentence.id) ? '取消排除' : '排除此句'}
                          >
                            {isBlacklisted(randomListeningSentence.id) ? '🚫' : '⊘'}
                          </button>
                        </div>
                      </div>
                      <div className="mt-auto flex flex-col items-center w-full">
                        <div className="flex items-center gap-2 w-full mb-4">
                          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-500 rounded-full transition-all duration-500 ease-out"
                              style={{ width: `${(randomListeningRepeat / REPEATS_PER_SENTENCE) * 100}%` }}
                            />
                          </div>
                          <span className="text-xs font-bold text-gray-500 min-w-[2.5rem] text-right">
                            {randomListeningRepeat}/{REPEATS_PER_SENTENCE}
                          </span>
                        </div>
                        <div className="flex items-center justify-center gap-4 w-full">
                          <button
                            onClick={() => goToPreviousSentence()}
                            disabled={!canGoPrevious}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                              canGoPrevious
                                ? 'bg-gray-100 text-gray-600 hover:bg-gray-200 active:scale-90'
                                : 'bg-gray-50 text-gray-300 cursor-not-allowed'
                            }`}
                            title="上一句" aria-label="上一句"
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>
                          </button>
                          <button
                            onClick={handleToggleRandomListening}
                            className="w-14 h-14 rounded-full flex items-center justify-center transition-all z-20 bg-red-50 text-red-500 hover:scale-110 active:scale-95"
                            title="停止" aria-label="停止朗读"
                          >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                          </button>
                          <button
                            onClick={() => goToNextSentence()}
                            disabled={!canGoNext}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                              canGoNext
                                ? 'bg-gray-100 text-gray-600 hover:bg-gray-200 active:scale-90'
                                : 'bg-gray-50 text-gray-300 cursor-not-allowed'
                            }`}
                            title="下一句" aria-label="下一句"
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
                          </button>
                        </div>
                        <p className="text-xs font-black text-gray-600 uppercase tracking-wide mt-4">
                          第 {randomListeningTotal + 1} 句 · 已朗读 {randomListeningTotal} 遍
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center flex-1 w-full">
                      <button
                        onClick={handleToggleRandomListening}
                        className="w-16 h-16 rounded-full flex items-center justify-center transition-all z-20 bg-blue-50 text-blue-600 hover:scale-110 active:scale-95"
                        title="开始随机朗读" aria-label="开始随机朗读"
                      >
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg>
                      </button>
                      <p className="text-xs font-black text-gray-600 uppercase tracking-wide mt-6">
                        点击开始随机朗读
                      </p>
                      <p className="text-xs text-gray-400 mt-2">
                        每句连续朗读 {REPEATS_PER_SENTENCE} 遍后自动切换
                      </p>
                    </div>
                  )
                ) : (
                  /* === 顺序朗读 === */
                  isDictationReadingActive && dictationReadingSentence ? (
                    <>
                      <div className="w-full text-left space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <h3 className={`text-lg font-normal leading-normal w-full break-words whitespace-pre-wrap ${
                              isDictationBlacklisted(dictationReadingSentence.id) ? 'text-gray-300 line-through' : 'text-gray-900'
                            }`}>
                              {dictationReadingSentence.english}
                            </h3>
                            <p className={`text-sm leading-normal break-words ${
                              isDictationBlacklisted(dictationReadingSentence.id) ? 'text-gray-200 line-through' : 'text-gray-400'
                            }`}>
                              {dictationReadingSentence.chinese}
                            </p>
                          </div>
                          <button
                            onClick={() => dictationToggleBlacklist(dictationReadingSentence.id)}
                            className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs transition-all ${
                              isDictationBlacklisted(dictationReadingSentence.id)
                                ? 'bg-red-100 text-red-500 hover:bg-red-200'
                                : 'bg-gray-100 text-gray-400 hover:bg-gray-200 hover:text-gray-600'
                            }`}
                            title={isDictationBlacklisted(dictationReadingSentence.id) ? '取消排除' : '排除此句'}
                          >
                            {isDictationBlacklisted(dictationReadingSentence.id) ? '🚫' : '⊘'}
                          </button>
                        </div>
                      </div>
                      <div className="mt-auto flex flex-col items-center w-full">
                        <div className="flex items-center gap-2 w-full mb-4">
                          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-green-500 rounded-full transition-all duration-500 ease-out"
                              style={{ width: `${(dictationReadingRepeat / DICTATION_READING_REPEATS) * 100}%` }}
                            />
                          </div>
                          <span className="text-xs font-bold text-gray-500 min-w-[2.5rem] text-right">
                            {dictationReadingRepeat}/{DICTATION_READING_REPEATS}
                          </span>
                        </div>
                        <div className="flex items-center justify-center gap-4 w-full">
                          <button
                            onClick={() => goToPrevReadingSentence()}
                            disabled={!canGoPrevReadingSentence}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                              canGoPrevReadingSentence
                                ? 'bg-gray-100 text-gray-600 hover:bg-gray-200 active:scale-90'
                                : 'bg-gray-50 text-gray-300 cursor-not-allowed'
                            }`}
                            title="上一句" aria-label="上一句"
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>
                          </button>
                          <button
                            onClick={handleToggleDictationReading}
                            className="w-14 h-14 rounded-full flex items-center justify-center transition-all z-20 bg-red-50 text-red-500 hover:scale-110 active:scale-95"
                            title="停止" aria-label="停止朗读"
                          >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                          </button>
                          <button
                            onClick={() => goToNextReadingSentence()}
                            disabled={!canGoNextReadingSentence}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                              canGoNextReadingSentence
                                ? 'bg-gray-100 text-gray-600 hover:bg-gray-200 active:scale-90'
                                : 'bg-gray-50 text-gray-300 cursor-not-allowed'
                            }`}
                            title="下一句" aria-label="下一句"
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
                          </button>
                        </div>
                        <p className="text-xs font-black text-gray-600 uppercase tracking-wide mt-4">
                          第 {dictationReadingIndex + 1}/{dictationReadingPoolSize} 句 · 已朗读 {dictationReadingTotal} 遍
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center flex-1 w-full">
                      <button
                        onClick={handleToggleDictationReading}
                        className="w-16 h-16 rounded-full flex items-center justify-center transition-all z-20 bg-green-50 text-green-600 hover:scale-110 active:scale-95"
                        title="开始顺序朗读" aria-label="开始顺序朗读"
                      >
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg>
                      </button>
                      <p className="text-xs font-black text-gray-600 uppercase tracking-wide mt-6">
                        点击开始顺序朗读
                      </p>
                      <p className="text-xs text-gray-400 mt-2">
                        朗读今日学习与复习句子，每句 {DICTATION_READING_REPEATS} 遍后自动切换，循环播放
                      </p>
                    </div>
                  )
                )}
              </div>

              {/* 错误提示（两种模式共享） */}
              {dictationReadingMode === 'random' && randomListeningError && (
                <div className="mt-2 p-3 bg-red-50 rounded-xl border border-red-100 w-full">
                  <p className="text-sm text-red-600 font-medium text-center">{randomListeningError}</p>
                </div>
              )}
              {dictationReadingMode === 'sequential' && dictationReadingError && (
                <div className="mt-2 p-3 bg-red-50 rounded-xl border border-red-100 w-full">
                  <p className="text-sm text-red-600 font-medium text-center">{dictationReadingError}</p>
                </div>
              )}
            </div>
            {dictationPool.length > 0 ? (
              <div className="apple-card p-4 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-orange-100/30 rounded-full blur-3xl -mr-10 -mt-10" />
                <div className="flex justify-between items-start mb-8">
                  <div>
                    <h3 className="text-xl font-black text-gray-900 tracking-tight">盲听默写</h3>
                    <p className="text-xs font-black text-orange-500 uppercase tracking-widest mt-1">Dictation Challenge</p>
                  </div>
                  <button 
                    onClick={handleDictationRefresh}
                    disabled={isDictationRefreshDisabled}
                    className="w-12 h-12 flex items-center justify-center bg-orange-50 text-orange-500 rounded-full hover:bg-orange-100 hover:text-orange-600 active:scale-90 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    style={{ 
                      zIndex: 100,
                      pointerEvents: isDictationRefreshDisabled ? 'none' : 'auto',
                      cursor: isDictationRefreshDisabled ? 'not-allowed' : 'pointer'
                    }}
                    aria-label="刷新默写题目"
                  >
                    🔄
                  </button>
                </div>
                
                <div className="bg-orange-50/40 p-4 rounded-[2rem] border border-orange-100/50 text-left mb-8">
                  <p className="text-lg font-normal text-gray-700 leading-normal italic break-words text-left">
                    "{targetSentence?.chinese || '暂无题目'}"
                  </p>
                </div>
                <textarea
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value.slice(0, 1000))}
                  maxLength={1000}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="w-full p-8 bg-gray-50 rounded-[2rem] border-none focus:ring-4 focus:ring-orange-100 outline-none min-h-[160px] text-lg font-semibold placeholder:text-gray-500 transition-all text-left"
                  placeholder="请输入听到的内容..."
                />
                <div className="text-[10px] text-gray-400 text-right mt-1">
                  {userInput.length}/1000
                </div>
                <div className="grid grid-cols-3 gap-3 mt-8">
                  <button 
                    onClick={() => { 
                      if (isRandomListeningActive) stopRandomListening();
                      if (isDictationReadingActive) stopDictationReading();
                      if(targetSentence) speak(targetSentence.english); 
                    }} 
                    className="bg-white text-gray-600 py-5 rounded-[2rem] font-bold border border-gray-100 active:scale-95 transition-all"
                  >
                    听音提示
                  </button>
                  <button 
                    onClick={() => setIsFlipped(!isFlipped)}
                    className="bg-white text-gray-600 py-5 rounded-[2rem] font-bold border border-gray-100 active:scale-95 transition-all"
                  >
                    {isFlipped ? '隐藏答案' : '查看答案'}
                  </button>
                  <button 
                    onClick={handleDictationCheck} 
                    disabled={isDictationChecking}
                    className={`py-5 rounded-[2rem] font-black text-lg shadow-xl shadow-orange-200 active:scale-95 transition-all ${
                      isDictationChecking 
                        ? 'bg-gray-400 text-gray-200 cursor-not-allowed' 
                        : 'bg-orange-500 text-white'
                    }`}
                  >
                    {isDictationChecking ? '核对中...' : '核对'}
                  </button>
                </div>
                {isFlipped && targetSentence && (
                  <div className="mt-8 p-4 bg-blue-50 rounded-[2rem] animate-in slide-in-from-top-4">
                    <p className="text-xs font-black text-blue-400 uppercase tracking-widest mb-2">标准答案</p>
                    <p className="text-blue-800 font-normal text-lg leading-normal break-words text-left">
                      {targetSentence.english}
                    </p>
                    <button 
                      onClick={() => { if (isRandomListeningActive) stopRandomListening(); if (isDictationReadingActive) stopDictationReading(); speak(targetSentence.english); }} 
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
                <p className="text-gray-600 font-medium">至少学习一个句子后开启。</p>
                <button 
                  onClick={handleDictationRefresh}
                  className="mt-4 bg-orange-100 text-orange-500 py-3 px-6 rounded-full font-bold text-sm"
                >
                  刷新试试
                </button>
              </div>
            )}
            
            <div className="space-y-4 pb-10">
              <h4 className="text-[11px] font-black text-gray-600 uppercase tracking-widest ml-4">今日成果 ({dictationList.filter(item => sentences.some(s => s.id === item.sentenceId)).length})</h4>
              <div className="space-y-3">
                {dictationList.filter(item => sentences.some(s => s.id === item.sentenceId)).map((item) => {
                  const s = sentences.find(sent => sent.id === item.sentenceId);
                  if (!s) return null;
                  return (
                    <div key={`${item.sentenceId}-${item.timestamp}`} className="apple-card p-5 flex items-center justify-between group bg-white/60 hover:bg-white transition-all">
                      <div className="flex-1 pr-4">
                        <p className="text-sm font-bold text-gray-800 line-clamp-1">{s.english}</p>
                        <p className="text-xs text-gray-600 font-medium">{s.chinese}</p>
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
    </div>
  );
};

const StudyPageWithErrorBoundary: React.FC<StudyPageProps> = (props) => {
  const fallback = (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center space-y-6">
        <div className="text-6xl">😵</div>
        <h1 className="text-2xl font-bold text-gray-900">学习页面出错了</h1>
        <p className="text-gray-600 text-sm">
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
