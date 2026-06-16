import { useState, useRef, useCallback, useEffect } from 'react';
import { Sentence } from '../../../types';
import { geminiService } from '../../../services/geminiService';
import { mediaSessionService } from '../../../services/mediaSessionService';
import { continuousAudioPlayer } from '../../../services/continuousAudioPlayer';
import { getLocalDateString } from '../../../utils/date';

const REPEATS_PER_SENTENCE = 5;
const INTER_REPEAT_BASE_DELAY = 450;
const INTER_REPEAT_JITTER = 200;
const INTER_SENTENCE_BASE_DELAY = 900;
const INTER_SENTENCE_JITTER = 300;
const MAX_CONSECUTIVE_ERRORS = 5;
const PLAY_TIMEOUT_MS = 15000;
const PLAY_TIMEOUT_PER_CHAR_MS = 250;
const READING_PROGRESS_KEY = 'd3s_dictation_reading_progress';

// 纯延迟：不受 iOS 后台定时器节流影响（setTimeout 在后台的最小间隔 ~1s，不会像 waitVisible 那样阻塞 3s+）
const waitDelay = (ms: number): Promise<void> =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

// 仅用于错误恢复后的等待：需要等用户回到前台再继续
const waitVisible = (ms: number): Promise<void> =>
  new Promise<void>(resolve => {
    setTimeout(() => {
      if (document.visibilityState === 'visible') {
        resolve();
        return;
      }
      const forceResolveTimer = setTimeout(() => {
        document.removeEventListener('visibilitychange', onVisible);
        resolve();
      }, 3000);
      const onVisible = () => {
        clearTimeout(forceResolveTimer);
        document.removeEventListener('visibilitychange', onVisible);
        resolve();
      };
      document.addEventListener('visibilitychange', onVisible);
    }, ms);
  });
const PRELOAD_LOOKAHEAD = 2;

const saveReadingProgress = (sentenceId: string, index: number): void => {
  try {
    const today = getLocalDateString();
    const progress = { sentenceId, index, date: today };
    localStorage.setItem(READING_PROGRESS_KEY, JSON.stringify(progress));
  } catch { /* ignore */ }
};

const loadReadingProgress = (): { sentenceId: string; index: number; date: string } | null => {
  try {
    const raw = localStorage.getItem(READING_PROGRESS_KEY);
    if (!raw) return null;
    const progress = JSON.parse(raw);
    if (progress && typeof progress.date === 'string' && typeof progress.index === 'number') {
      return progress;
    }
    return null;
  } catch {
    return null;
  }
};

interface DictationReadingState {
  isActive: boolean;
  currentIndex: number;
  currentRepeat: number;
  totalPlayed: number;
  errorMessage: string | null;
}

const jitterDelay = (base: number, jitter: number): number =>
  base + Math.floor(Math.random() * jitter);

export const useDictationReading = (
  sentences: Sentence[],
  dailySelection: Sentence[]
) => {
  const [state, setState] = useState<DictationReadingState>({
    isActive: false,
    currentIndex: 0,
    currentRepeat: 0,
    totalPlayed: 0,
    errorMessage: null,
  });

  const isActiveRef = useRef(false);
  const playGenerationRef = useRef(0);
  const totalPlayedRef = useRef(0);
  const sentencesRef = useRef(sentences);
  const dailySelectionRef = useRef(dailySelection);
  const startIdxRef = useRef(0);
  const preloadCacheRef = useRef<Map<number, Blob>>(new Map());
  const preloadGenRef = useRef(0);
  const goToPrevRef = useRef<(() => void) | null>(null);
  const goToNextRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    sentencesRef.current = sentences;
  }, [sentences]);

  useEffect(() => {
    dailySelectionRef.current = dailySelection;
  }, [dailySelection]);

  const getReadingPool = useCallback((): Sentence[] => {
    const todayStr = getLocalDateString();
    const seen = new Set<string>();
    const pool: Sentence[] = [];

    for (const s of dailySelectionRef.current) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        pool.push(s);
      }
    }

    const reviewSentences = sentencesRef.current.filter(s => {
      if (s.intervalIndex === 0) return false;
      if (seen.has(s.id)) return false;
      const isLearnedToday = s.learnedAt && getLocalDateString(s.learnedAt) === todayStr;
      if (s.isPendingFirstReview && isLearnedToday) return false;
      const isDue = s.nextReviewDate && s.nextReviewDate <= Date.now();
      const reviewedToday = s.lastReviewedAt && getLocalDateString(s.lastReviewedAt) === todayStr;
      return isDue || reviewedToday;
    });

    for (const s of reviewSentences) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        pool.push(s);
      }
    }

    return pool;
  }, []);

  const playSentenceOnce = useCallback(async (
    sentence: Sentence,
    gen: number,
    cachedBlob?: Blob | null
  ): Promise<boolean> => {
    if (!isActiveRef.current || playGenerationRef.current !== gen) return false;

    const doPlay = async (): Promise<boolean> => {
      if (cachedBlob) {
        try {
          await continuousAudioPlayer.playBlob(cachedBlob);
          if (!isActiveRef.current || playGenerationRef.current !== gen) return false;
          return true;
        } catch (err) {
          if (!isActiveRef.current || playGenerationRef.current !== gen) return false;
          console.warn('🔊 [默写朗读] playBlob 失败:', err instanceof Error ? err.message : String(err));
          return false;
        }
      }

      try {
        const blob = await geminiService.fetchAudioBlob(sentence.english);
        if (!isActiveRef.current || playGenerationRef.current !== gen) return false;

        if (blob) {
          await continuousAudioPlayer.playBlob(blob);
          if (!isActiveRef.current || playGenerationRef.current !== gen) return false;
          return true;
        }

        geminiService.startSpeechSynthesisKeepAlive();
        const result = await geminiService.speak(sentence.english, false);
        if (!isActiveRef.current || playGenerationRef.current !== gen) return false;
        if (!result.success) {
          console.warn(`🔊 [默写朗读] 播放失败: ${result.error}`);
          return false;
        }
        return true;
      } catch (err) {
        if (!isActiveRef.current || playGenerationRef.current !== gen) return false;
        console.warn('🔊 [默写朗读] 播放异常:', err instanceof Error ? err.message : String(err));

        if (continuousAudioPlayer.isActivated()) {
          try {
            geminiService.startSpeechSynthesisKeepAlive();
            const fallbackResult = await geminiService.speak(sentence.english, false);
            if (!isActiveRef.current || playGenerationRef.current !== gen) return false;
            return fallbackResult.success;
          } catch {
            return false;
          }
        }
        return false;
      }
    };

    const timeoutMs = Math.max(PLAY_TIMEOUT_MS, sentence.english.length * PLAY_TIMEOUT_PER_CHAR_MS);
    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    });

    const result = await Promise.race([doPlay(), timeoutPromise]);

    if (!result) {
      geminiService.stop();
      continuousAudioPlayer.stop();
    }

    return result;
  }, []);

  const preloadNextSentences = useCallback(async (
    pool: Sentence[],
    currentIdx: number,
    gen: number
  ): Promise<void> => {
    if (!isActiveRef.current || playGenerationRef.current !== gen) return;

    const preloadStart = currentIdx + 1;
    const preloadEnd = Math.min(currentIdx + 1 + PRELOAD_LOOKAHEAD, pool.length);

    for (let i = preloadStart; i < preloadEnd; i++) {
      if (!isActiveRef.current || playGenerationRef.current !== gen) return;
      if (preloadCacheRef.current.has(i)) continue;

      const sentence = pool[i];
      try {
        const blob = await geminiService.fetchAudioBlob(sentence.english);
        if (!isActiveRef.current || playGenerationRef.current !== gen) return;
        if (blob) {
          preloadCacheRef.current.set(i, blob);
          console.log(`🔊 [默写朗读] 预加载完成: 第 ${i + 1} 句 "${sentence.english.slice(0, 30)}..."`);
        }
      } catch {
        // preload failure is non-critical
      }
    }
  }, []);

  const runReadingLoop = useCallback(async (gen: number, fromIndex?: number) => {
    while (isActiveRef.current && playGenerationRef.current === gen) {
      const pool = getReadingPool();
      if (pool.length === 0) {
        setState(prev => ({
          ...prev,
          isActive: false,
          errorMessage: '暂无可朗读的句子，请先学习或复习句子',
        }));
        isActiveRef.current = false;
        break;
      }

      preloadCacheRef.current.clear();

      const startIndex = fromIndex !== undefined ? fromIndex : startIdxRef.current;
      fromIndex = undefined;
      startIdxRef.current = 0;

      for (let i = startIndex; i < pool.length; i++) {
        if (!isActiveRef.current || playGenerationRef.current !== gen) return;

        const sentence = pool[i];
        saveReadingProgress(sentence.id, i);

        mediaSessionService.updateMetadata(sentence.english);
        mediaSessionService.setActionHandlers({
          onPause: () => { geminiService.stop(); continuousAudioPlayer.stop(); isActiveRef.current = false; },
          onStop: () => { geminiService.stop(); continuousAudioPlayer.stop(); isActiveRef.current = false; },
          onPrevTrack: () => { goToPrevRef.current?.(); },
          onNextTrack: () => { goToNextRef.current?.(); },
        });

        setState(prev => ({
          ...prev,
          currentIndex: i,
          currentRepeat: 0,
          errorMessage: null,
        }));

        let audioBlob: Blob | null = preloadCacheRef.current.get(i) || null;

        if (!audioBlob) {
          try {
            audioBlob = await geminiService.fetchAudioBlob(sentence.english);
          } catch {
            audioBlob = null;
          }
          if (!isActiveRef.current || playGenerationRef.current !== gen) return;
        } else {
          console.log(`🔊 [默写朗读] 使用预加载缓存: 第 ${i + 1} 句`);
          preloadCacheRef.current.delete(i);
        }

        let consecutiveErrors = 0;
        let completedRepeats = 0;
        let preloadTriggered = false;

        while (completedRepeats < REPEATS_PER_SENTENCE) {
          if (!isActiveRef.current || playGenerationRef.current !== gen) return;

          if (!preloadTriggered) {
            preloadTriggered = true;
            preloadNextSentences(pool, i, gen);
          }

          const success = await playSentenceOnce(sentence, gen, audioBlob);
          if (!isActiveRef.current || playGenerationRef.current !== gen) return;

          if (!success) {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              break;
            }
            await waitDelay(500);
          continue;
        }

        consecutiveErrors = 0;
        completedRepeats++;
        totalPlayedRef.current++;

          setState(prev => ({ ...prev, currentRepeat: completedRepeats }));

          if (completedRepeats < REPEATS_PER_SENTENCE) {
            mediaSessionService.holdAudioFocus();
            await waitDelay(jitterDelay(INTER_REPEAT_BASE_DELAY, INTER_REPEAT_JITTER));
          }
        }

        if (!isActiveRef.current || playGenerationRef.current !== gen) return;

        setState(prev => ({ ...prev, totalPlayed: totalPlayedRef.current }));

        // 句子切换：用静音保持主音频通道，防止 iOS 回收音频会话
        continuousAudioPlayer.beginTransition();
        continuousAudioPlayer.primeAudioChannelWithSilence();
        mediaSessionService.holdAudioFocus();
        await waitDelay(jitterDelay(INTER_SENTENCE_BASE_DELAY, INTER_SENTENCE_JITTER));
        continuousAudioPlayer.endTransition();
      }

      if (!isActiveRef.current || playGenerationRef.current !== gen) return;
    }
  }, [getReadingPool, playSentenceOnce, preloadNextSentences]);

  const startReading = useCallback(() => {
    const pool = getReadingPool();
    if (pool.length === 0) {
      setState(prev => ({
        ...prev,
        errorMessage: '暂无可朗读的句子，请先学习或复习句子',
      }));
      return;
    }

    continuousAudioPlayer.activate();
    mediaSessionService.startSilenceKeepAlive();

    // 通知系统这是音频应用，需要后台播放权限
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }

    isActiveRef.current = true;
    totalPlayedRef.current = 0;

    const gen = ++playGenerationRef.current;

    let startIndex = 0;
    const savedProgress = loadReadingProgress();
    if (savedProgress && savedProgress.date === getLocalDateString()) {
      const foundIndex = pool.findIndex(s => s.id === savedProgress.sentenceId);
      if (foundIndex >= 0) {
        startIndex = foundIndex;
        totalPlayedRef.current = savedProgress.index;
      }
    }

    setState({
      isActive: true,
      currentIndex: startIndex,
      currentRepeat: 0,
      totalPlayed: totalPlayedRef.current,
      errorMessage: null,
    });

    startIdxRef.current = startIndex;
    runReadingLoop(gen, startIndex);
  }, [runReadingLoop, getReadingPool]);

  const stopReading = useCallback(() => {
    if (isActiveRef.current) {
      const pool = getReadingPool();
      const currentIdx = state.currentIndex;
      if (currentIdx >= 0 && currentIdx < pool.length) {
        saveReadingProgress(pool[currentIdx].id, currentIdx);
      }
    }

    isActiveRef.current = false;
    playGenerationRef.current++;
    geminiService.stop();
    geminiService.stopSpeechSynthesisKeepAlive();
    continuousAudioPlayer.deactivate();
    mediaSessionService.stopSilenceKeepAlive();

    // 通知系统播放已停止
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }

    setState(prev => ({
      ...prev,
      isActive: false,
      currentRepeat: 0,
    }));
  }, [state.currentIndex, getReadingPool]);

  const toggleReading = useCallback(() => {
    if (state.isActive) {
      stopReading();
    } else {
      startReading();
    }
  }, [state.isActive, startReading, stopReading]);

  const goToPrevSentence = useCallback(() => {
    if (!state.isActive) return;
    const pool = getReadingPool();
    if (pool.length === 0) return;

    const wasActive = isActiveRef.current;
    if (wasActive) {
      isActiveRef.current = false;
      playGenerationRef.current++;
      geminiService.stop();
      continuousAudioPlayer.stop();
    }

    const newIdx = state.currentIndex > 0 ? state.currentIndex - 1 : pool.length - 1;
    saveReadingProgress(pool[newIdx].id, newIdx);

    setState(prev => ({
      ...prev,
      currentIndex: newIdx,
      currentRepeat: 0,
      errorMessage: null,
    }));

    if (wasActive) {
      isActiveRef.current = true;
      const gen = ++playGenerationRef.current;
      runReadingLoop(gen, newIdx);
    }
  }, [state.isActive, state.currentIndex, getReadingPool, runReadingLoop]);

  const goToNextSentence = useCallback(() => {
    if (!state.isActive) return;
    const pool = getReadingPool();
    if (pool.length === 0) return;

    const wasActive = isActiveRef.current;
    if (wasActive) {
      isActiveRef.current = false;
      playGenerationRef.current++;
      geminiService.stop();
      continuousAudioPlayer.stop();
    }

    const newIdx = state.currentIndex < pool.length - 1 ? state.currentIndex + 1 : 0;
    saveReadingProgress(pool[newIdx].id, newIdx);

    setState(prev => ({
      ...prev,
      currentIndex: newIdx,
      currentRepeat: 0,
      errorMessage: null,
    }));

    if (wasActive) {
      isActiveRef.current = true;
      const gen = ++playGenerationRef.current;
      runReadingLoop(gen, newIdx);
    }
  }, [state.isActive, state.currentIndex, getReadingPool, runReadingLoop]);

  useEffect(() => {
    goToPrevRef.current = goToPrevSentence;
    goToNextRef.current = goToNextSentence;
  }, [goToPrevSentence, goToNextSentence]);

  useEffect(() => {
    const currentGen = playGenerationRef.current;
    return () => {
      if (isActiveRef.current) {
        isActiveRef.current = false;
        playGenerationRef.current = currentGen + 1;
        geminiService.stop();
        geminiService.stopSpeechSynthesisKeepAlive();
        continuousAudioPlayer.deactivate();
        mediaSessionService.stopSilenceKeepAlive();
      }
    };
  }, []);

  const pool = getReadingPool();
  const currentSentence = pool[state.currentIndex] || null;
  const canGoPrev = pool.length > 1;
  const canGoNext = pool.length > 1;

  return {
    isDictationReadingActive: state.isActive,
    dictationReadingSentence: currentSentence,
    dictationReadingIndex: state.currentIndex,
    dictationReadingRepeat: state.currentRepeat,
    dictationReadingTotal: state.totalPlayed,
    dictationReadingError: state.errorMessage,
    dictationReadingPoolSize: pool.length,
    toggleDictationReading: toggleReading,
    startDictationReading: startReading,
    stopDictationReading: stopReading,
    goToPrevReadingSentence: goToPrevSentence,
    goToNextReadingSentence: goToNextSentence,
    canGoPrevReadingSentence: canGoPrev,
    canGoNextReadingSentence: canGoNext,
    REPEATS_PER_SENTENCE,
  };
};
