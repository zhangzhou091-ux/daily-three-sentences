import { useState, useRef, useCallback, useEffect } from 'react';
import { Sentence } from '../../../types';
import { geminiService } from '../../../services/geminiService';
import { storageService } from '../../../services/storage';

const REPEATS_PER_SENTENCE = 5;

interface RandomListeningState {
  isActive: boolean;
  currentSentence: Sentence | null;
  currentRepeat: number;
  totalPlayed: number;
  errorMessage: string | null;
}

export const useRandomListening = (dictationPool: Sentence[]) => {
  const [state, setState] = useState<RandomListeningState>({
    isActive: false,
    currentSentence: null,
    currentRepeat: 0,
    totalPlayed: 0,
    errorMessage: null,
  });

  const isActiveRef = useRef(false);
  const lastSentenceIdRef = useRef<string | null>(null);
  const playGenerationRef = useRef(0);
  const poolRef = useRef<Sentence[]>([]);
  const totalPlayedRef = useRef(0);

  useEffect(() => {
    poolRef.current = dictationPool;
  }, [dictationPool]);

  const pickRandomSentence = useCallback((): Sentence | null => {
    const pool = poolRef.current;
    if (pool.length === 0) return null;

    if (pool.length === 1) return pool[0];

    const candidates = pool.filter(s => s.id !== lastSentenceIdRef.current);
    if (candidates.length === 0) return pool[Math.floor(Math.random() * pool.length)];

    return candidates[Math.floor(Math.random() * candidates.length)];
  }, []);

  const playSentenceOnce = useCallback(async (
    sentence: Sentence,
    gen: number
  ): Promise<boolean> => {
    if (!isActiveRef.current || playGenerationRef.current !== gen) return false;

    const settings = storageService.getSettings();
    const speechRate = settings.speechRate ?? 1;

    try {
      const result = await geminiService.speak(sentence.english, false);
      if (!isActiveRef.current || playGenerationRef.current !== gen) return false;
      if (!result.success) {
        console.warn(`🔊 [随机朗读] 播放失败: ${result.error}`);
        return false;
      }
      return true;
    } catch (err) {
      if (!isActiveRef.current || playGenerationRef.current !== gen) return false;
      console.warn('🔊 [随机朗读] 播放异常:', err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  const runListeningLoop = useCallback(async (gen: number) => {
    while (isActiveRef.current && playGenerationRef.current === gen) {
      const sentence = pickRandomSentence();
      if (!sentence) {
        setState(prev => ({
          ...prev,
          isActive: false,
          errorMessage: '没有可用的学习句子',
        }));
        isActiveRef.current = false;
        break;
      }

      lastSentenceIdRef.current = sentence.id;
      setState(prev => ({
        ...prev,
        currentSentence: sentence,
        currentRepeat: 0,
        errorMessage: null,
      }));

      let consecutiveErrors = 0;

      for (let i = 0; i < REPEATS_PER_SENTENCE; i++) {
        if (!isActiveRef.current || playGenerationRef.current !== gen) return;

        setState(prev => ({ ...prev, currentRepeat: i + 1 }));

        const success = await playSentenceOnce(sentence, gen);
        if (!isActiveRef.current || playGenerationRef.current !== gen) return;

        if (!success) {
          consecutiveErrors++;
          if (consecutiveErrors >= 3) {
            setState(prev => ({
              ...prev,
              isActive: false,
              errorMessage: '语音播放连续失败，请检查TTS设置后重试',
            }));
            isActiveRef.current = false;
            return;
          }
          await new Promise<void>(r => setTimeout(r, 1500));
          i--;
          continue;
        }

        consecutiveErrors = 0;
        totalPlayedRef.current++;

        if (i < REPEATS_PER_SENTENCE - 1) {
          await new Promise<void>(r => setTimeout(r, 800));
        }
      }

      if (!isActiveRef.current || playGenerationRef.current !== gen) return;

      setState(prev => ({ ...prev, totalPlayed: totalPlayedRef.current }));

      await new Promise<void>(r => setTimeout(r, 1200));
    }
  }, [pickRandomSentence, playSentenceOnce]);

  const startListening = useCallback(() => {
    if (dictationPool.length === 0) {
      setState(prev => ({
        ...prev,
        errorMessage: '暂无已学习的句子，请先学习后再使用随机朗读',
      }));
      return;
    }

    isActiveRef.current = true;
    totalPlayedRef.current = 0;
    const gen = ++playGenerationRef.current;

    setState({
      isActive: true,
      currentSentence: null,
      currentRepeat: 0,
      totalPlayed: 0,
      errorMessage: null,
    });

    runListeningLoop(gen);
  }, [dictationPool.length, runListeningLoop]);

  const stopListening = useCallback(() => {
    isActiveRef.current = false;
    playGenerationRef.current++;
    geminiService.stop();

    setState(prev => ({
      ...prev,
      isActive: false,
      currentRepeat: 0,
    }));
  }, []);

  const toggleListening = useCallback(() => {
    if (state.isActive) {
      stopListening();
    } else {
      startListening();
    }
  }, [state.isActive, startListening, stopListening]);

  useEffect(() => {
    return () => {
      if (isActiveRef.current) {
        isActiveRef.current = false;
        playGenerationRef.current++;
        geminiService.stop();
      }
    };
  }, []);

  return {
    isRandomListeningActive: state.isActive,
    randomListeningSentence: state.currentSentence,
    randomListeningRepeat: state.currentRepeat,
    randomListeningTotal: state.totalPlayed,
    randomListeningError: state.errorMessage,
    toggleRandomListening: toggleListening,
    startRandomListening: startListening,
    stopRandomListening: stopListening,
    REPEATS_PER_SENTENCE,
  };
};
