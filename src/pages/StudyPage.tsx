import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Sentence, StudyStep } from '../types';
import { geminiService } from '../services/geminiService';
import { storageService } from '../services/storage';
import { syncQueueService } from '../services/syncQueueService';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { getLocalDateString } from '../utils/date';
import { LEARN_XP } from '../constants';
import { useDailySelection } from './StudyPage/hooks/useDailySelection';
import { useLearnLogic } from './StudyPage/hooks/useLearnLogic';
import { useProgressRestore } from './StudyPage/hooks/useProgressRestore';
import { useReviewLogic } from './StudyPage/hooks/useReviewLogic';
import { useDictationLogic } from './StudyPage/hooks/useDictationLogic';
import { LearnCard } from './StudyPage/components/LearnCard';
import { ReviewCard } from './StudyPage/components/ReviewCard';

interface StudyPageProps {
  sentences: Sentence[];
  onUpdate: () => Promise<void>;
}

const StudyPage: React.FC<StudyPageProps> = ({ sentences, onUpdate }) => {
  const [activeTab, setActiveTab] = useState<StudyStep>('learn');
  const [currentIndex, setCurrentIndex] = useState(0);
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
  
  const [progressAdjusted, setProgressAdjusted] = useState(false);
  const [currentDateStr, setCurrentDateStr] = useState(() => getLocalDateString());
  const [speakError, setSpeakError] = useState<string | null>(null);
  
  const [settings, setSettings] = useState(() => storageService.getSettings());
  const todayStr = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  }, [currentDateStr]);
  
  useEffect(() => {
    const handleSettingsChange = () => {
      setSettings(storageService.getSettings());
    };
    window.addEventListener('settingsChanged', handleSettingsChange);
    return () => window.removeEventListener('settingsChanged', handleSettingsChange);
  }, []);
  
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const newDate = getLocalDateString();
        if (newDate !== currentDateStr) {
          console.log('📅 检测到日期变化，触发复习队列重建');
          setCurrentDateStr(newDate);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [currentDateStr]);

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

  useProgressRestore({
    activeTab,
    dailySelection,
    currentIndex,
    setCurrentIndex,
    isGeneratingRef,
    isMountedRef,
    setProgressAdjusted,
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
  } = useReviewLogic({
    sentences,
    settings,
    currentDateStr,
    activeTab,
    isMountedRef,
    onUpdate,
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

  const [animatingLearnedId, setAnimatingLearnedIdState] = useState<string | null>(null);
  
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
    };
  }, []);

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

  const speak = async (text: string) => {
    if (!text?.trim()) return;
    try {
      await geminiService.speak(text);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.warn('语音播放失败', err.message);
      } else {
        console.warn('语音播放失败', String(err));
      }
      setSpeakError('语音播放失败，请检查网络');
      setTimeout(() => setSpeakError(null), 3000);
    }
  };

  useEffect(() => {
    if (activeTab !== 'review') return;

    if (reviewQueue.length === 0) {
      setCurrentReviewId(null);
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

  const targetSentence = useMemo(() => 
    sentences.find(s => s.id === targetDictationId) || null,
    [sentences, targetDictationId]
  );
  
  const currentSentence = dailySelection[currentIndex] || null;
  const currentSentenceLatest = currentSentence 
    ? sentences.find(s => s.id === currentSentence.id) || currentSentence 
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
      const sentence = sentences.find(s => s.id === id);
      return sentence ? sentence.intervalIndex > 0 : false;
    });
  }, [dailySelection, sentences]);
  
  useEffect(() => {
    if (allLearned && sentences.some(s => s.intervalIndex === 0)) {
      console.log('🔄 dailySelection 中句子已全部学习，但仍有未学习句子，触发重新生成');
      generateDailySelection();
    }
  }, [allLearned, sentences, generateDailySelection]);
  
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

  const isReviewButtonDisabled = useCallback((sentenceId: string) => {
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
                onClick={() => { setActiveTab(tab); setCurrentIndex(0); setIsFlipped(tab === 'review'); }}
                className={`px-4 py-2 text-[11px] font-black uppercase tracking-wider rounded-[1.2rem] transition-all duration-300 ${
                  activeTab === tab ? 'bg-white shadow-sm text-blue-600' : 'text-gray-600 hover:text-gray-800'
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
              <LearnCard
                sentence={currentSentenceLatest || currentSentence!}
                onFlip={() => setIsFlipped(!isFlipped)}
                isFlipped={isFlipped}
                onMarkLearned={handleMarkLearned}
                onSpeak={speak}
                isCurrentlyLearned={isCurrentlyLearned}
                isAnimating={isAnimating}
                isSavingLearned={isSavingLearned}
              />
              <div className="flex flex-col gap-4">
                {!isCurrentlyLearned && !isAnimating ? (
                  <>
                    <button
                      onClick={() => currentSentence && handleMarkLearned(currentSentence.id)}
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
                      disabled={currentIndex === 0} 
                      onClick={() => { setIsFlipped(false); setCurrentIndex(currentIndex - 1); }} 
                      className={`text-lg font-bold uppercase tracking-widest transition-colors ${currentIndex === 0 ? 'text-gray-500' : 'text-gray-600 hover:text-blue-500'}`}
                    >
                      ← Prev
                    </button>
                    <div className="flex items-center gap-2">
                       <span className="text-lg text-gray-900 font-black tracking-widest">{currentIndex + 1}</span>
                       <span className="text-lg text-gray-600 font-black tracking-widest">/</span>
                       <span className="text-lg text-gray-600 font-black tracking-widest">{dailySelection.length}</span>
                    </div>
                    <button 
                      disabled={currentIndex === dailySelection.length - 1} 
                      onClick={() => { setIsFlipped(false); setCurrentIndex(currentIndex + 1); }} 
                      className={`text-lg font-bold uppercase tracking-widest transition-colors ${currentIndex === dailySelection.length - 1 ? 'text-gray-500' : 'text-gray-600 hover:text-blue-500'}`}
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
              <p className="text-gray-600 font-medium">请到仓库页添加新句子。</p>
            </div>
          )
        )}

        {activeTab === 'review' && (
          reviewQueue.length > 0 ? (
            <div className="space-y-8 animate-in slide-in-from-right-4 duration-500">
              <ReviewCard
                sentence={reviewQueue[currentReviewIndex]!}
                onFlip={() => setIsFlipped(!isFlipped)}
                isFlipped={isFlipped}
                onSpeak={speak}
                scheduledDays={reviewQueue[currentReviewIndex]?.scheduledDays}
                reps={reviewQueue[currentReviewIndex]?.reps || 0}
              />
              
              {!isCurrentReviewed ? (
                <div className={`grid grid-cols-4 gap-3 transition-opacity duration-300 ${isProcessingReview ? 'opacity-50 pointer-events-none grayscale' : ''}`}>
                  <button 
                    onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 1)} 
                    disabled={isReviewButtonDisabled(currentReviewSentence?.id || '')}
                    className={`bg-white py-4 rounded-[1.5rem] font-bold shadow-sm border transition-all ${
                      isReviewButtonDisabled(currentReviewSentence?.id || '')
                        ? 'text-gray-400 border-gray-100 cursor-not-allowed bg-gray-50' 
                        : 'text-red-400 border-red-50 hover:bg-red-50 active:scale-95'
                    }`}
                  >
                    <div className="text-lg">忘记</div>
                    <div className="text-xs opacity-60">Again</div>
                  </button>
                  <button 
                    onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 2)} 
                    disabled={isReviewButtonDisabled(currentReviewSentence?.id || '')}
                    className={`bg-white py-4 rounded-[1.5rem] font-bold shadow-sm border transition-all ${
                      isReviewButtonDisabled(currentReviewSentence?.id || '')
                        ? 'text-gray-400 border-gray-100 cursor-not-allowed bg-gray-50' 
                        : 'text-orange-400 border-orange-50 hover:bg-orange-50 active:scale-95'
                    }`}
                  >
                    <div className="text-lg">困难</div>
                    <div className="text-xs opacity-60">Hard</div>
                  </button>
                  <button 
                    onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 3)} 
                    disabled={isReviewButtonDisabled(currentReviewSentence?.id || '')}
                    className={`bg-white py-4 rounded-[1.5rem] font-bold shadow-sm border transition-all ${
                      isReviewButtonDisabled(currentReviewSentence?.id || '')
                        ? 'text-gray-400 border-gray-100 cursor-not-allowed bg-gray-50' 
                        : 'text-blue-500 border-blue-50 hover:bg-blue-50 active:scale-95'
                    }`}
                  >
                    <div className="text-lg">一般</div>
                    <div className="text-xs opacity-60">Good</div>
                  </button>
                  <button 
                    onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 4)} 
                    disabled={isReviewButtonDisabled(currentReviewSentence?.id || '')}
                    className={`py-4 rounded-[1.5rem] font-black shadow-xl transition-all ${
                      isReviewButtonDisabled(currentReviewSentence?.id || '')
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
                  disabled={currentReviewIndex === 0 || isProcessingReview}
                  className={`group flex items-center gap-3 px-6 py-4 rounded-2xl transition-all active:scale-95 ${
                    currentReviewIndex === 0 || isProcessingReview
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
                  disabled={currentReviewIndex >= reviewQueue.length - 1 || isProcessingReview}
                  className={`group flex items-center gap-3 px-6 py-4 rounded-2xl transition-all active:scale-95 ${
                    currentReviewIndex >= reviewQueue.length - 1 || isProcessingReview
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
                  onClick={() => setActiveTab('learn')}
                  className="px-6 py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors"
                >
                  去学习新句子
                </button>
                <button 
                  onClick={() => setActiveTab('dictation')}
                  className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors"
                >
                  去默写挑战
                </button>
              </div>
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
                  className="w-full p-8 bg-gray-50 rounded-[2rem] border-none focus:ring-4 focus:ring-orange-100 outline-none min-h-[160px] text-lg font-semibold placeholder:text-gray-500 transition-all text-left" 
                  placeholder="请输入听到的内容..." 
                />
                <div className="text-[10px] text-gray-400 text-right mt-1">
                  {userInput.length}/1000
                </div>
                <div className="grid grid-cols-2 gap-4 mt-8">
                  <button 
                    onClick={() => { 
                      setIsFlipped(!isFlipped); 
                      if(!isFlipped && targetSentence) speak(targetSentence.english); 
                    }} 
                    className="bg-white text-gray-600 py-5 rounded-[2rem] font-bold border border-gray-100 active:scale-95 transition-all"
                  >
                    {isFlipped ? '隐藏答案' : '听音提示'}
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
