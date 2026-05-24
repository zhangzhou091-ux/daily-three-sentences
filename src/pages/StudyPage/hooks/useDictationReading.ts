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
const MAX_CONSECUTIVE_ERRORS = 3;
const PLAY_TIMEOUT_MS = 8000;

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
        await continuousAudioPlayer.playBlob(cachedBlob);
        if (!isActiveRef.current || playGenerationRef.current !== gen) return false;
        return true;
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

    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), PLAY_TIMEOUT_MS);
    });

    const result = await Promise.race([doPlay(), timeoutPromise]);

    if (!result) {
      geminiService.stop();
      continuousAudioPlayer.stop();
    }

    return result;
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

      const startIndex = fromIndex !== undefined ? fromIndex : startIdxRef.current;
      fromIndex = undefined;
      startIdxRef.current = 0;

      for (let i = startIndex; i < pool.length; i++) {
        if (!isActiveRef.current || playGenerationRef.current !== gen) return;

        const sentence = pool[i];

        setState(prev => ({
          ...prev,
          currentIndex: i,
          currentRepeat: 0,
          errorMessage: null,
        }));

        let audioBlob: Blob | null = null;
        try {
          audioBlob = await geminiService.fetchAudioBlob(sentence.english);
        } catch {
          audioBlob = null;
        }
        if (!isActiveRef.current || playGenerationRef.current !== gen) return;

        let consecutiveErrors = 0;
        let completedRepeats = 0;

        while (completedRepeats < REPEATS_PER_SENTENCE) {
          if (!isActiveRef.current || playGenerationRef.current !== gen) return;

          const success = await playSentenceOnce(sentence, gen, audioBlob);
          if (!isActiveRef.current || playGenerationRef.current !== gen) return;

          if (!success) {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              break;
            }
            await new Promise<void>(r => setTimeout(r, 500));
            continue;
          }

          consecutiveErrors = 0;
          completedRepeats++;
          totalPlayedRef.current++;

          setState(prev => ({ ...prev, currentRepeat: completedRepeats }));

          if (completedRepeats < REPEATS_PER_SENTENCE) {
            mediaSessionService.holdAudioFocus();
            await new Promise<void>(r =>
              setTimeout(r, jitterDelay(INTER_REPEAT_BASE_DELAY, INTER_REPEAT_JITTER))
            );
          }
        }

        if (!isActiveRef.current || playGenerationRef.current !== gen) return;

        setState(prev => ({ ...prev, totalPlayed: totalPlayedRef.current }));

        mediaSessionService.holdAudioFocus();
        await new Promise<void>(r =>
          setTimeout(r, jitterDelay(INTER_SENTENCE_BASE_DELAY, INTER_SENTENCE_JITTER))
        );
      }

      if (!isActiveRef.current || playGenerationRef.current !== gen) return;
    }
  }, [getReadingPool, playSentenceOnce]);

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

    isActiveRef.current = true;
    totalPlayedRef.current = 0;

    const gen = ++playGenerationRef.current;

    setState({
      isActive: true,
      currentIndex: 0,
      currentRepeat: 0,
      totalPlayed: 0,
      errorMessage: null,
    });

    runReadingLoop(gen, 0);
  }, [runReadingLoop, getReadingPool]);

  const stopReading = useCallback(() => {
    isActiveRef.current = false;
    playGenerationRef.current++;
    geminiService.stop();
    geminiService.stopSpeechSynthesisKeepAlive();
    continuousAudioPlayer.deactivate();

    setState(prev => ({
      ...prev,
      isActive: false,
      currentRepeat: 0,
    }));
  }, []);

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
    const currentGen = playGenerationRef.current;
    return () => {
      if (isActiveRef.current) {
        isActiveRef.current = false;
        playGenerationRef.current = currentGen + 1;
        geminiService.stop();
        geminiService.stopSpeechSynthesisKeepAlive();
        continuousAudioPlayer.deactivate();
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
