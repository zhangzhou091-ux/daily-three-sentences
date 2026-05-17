import { useState, useRef, useCallback, useEffect } from 'react';
import { Sentence } from '../../../types';
import { geminiService } from '../../../services/geminiService';
import { mediaSessionService } from '../../../services/mediaSessionService';

const REPEATS_PER_SENTENCE = 5;
const INTER_REPEAT_BASE_DELAY = 450;
const INTER_REPEAT_JITTER = 200;
const INTER_SENTENCE_BASE_DELAY = 900;
const INTER_SENTENCE_JITTER = 300;
const MAX_CONSECUTIVE_ERRORS = 3;

const WEIGHT_DIFFICULTY = 2.0;
const WEIGHT_LOW_STABILITY = 1.5;
const WEIGHT_WRONG_DICTATIONS = 1.5;
const WEIGHT_LOW_MASTERY = 1.0;
const WEIGHT_SESSION_FREQUENCY = 2.0;

interface RandomListeningState {
  isActive: boolean;
  currentSentence: Sentence | null;
  currentRepeat: number;
  totalPlayed: number;
  errorMessage: string | null;
}

const jitterDelay = (base: number, jitter: number): number =>
  base + Math.floor(Math.random() * jitter);

const computeWeight = (sentence: Sentence, sessionCounts: Map<string, number>): number => {
  let weight = 1.0;

  const difficulty = sentence.difficulty ?? 0;
  if (difficulty > 0) {
    weight += WEIGHT_DIFFICULTY * (difficulty / 10);
  }

  const stability = sentence.stability ?? 0;
  if (stability > 0 && stability < 30) {
    weight += WEIGHT_LOW_STABILITY * (1 - stability / 30);
  } else if (stability === 0) {
    weight += WEIGHT_LOW_STABILITY;
  }

  const wrongDict = sentence.wrongDictations ?? 0;
  if (wrongDict > 0) {
    weight += WEIGHT_WRONG_DICTATIONS * Math.min(wrongDict, 5) / 5;
  }

  const mastery = sentence.masteryLevel ?? 0;
  if (mastery < 5) {
    weight += WEIGHT_LOW_MASTERY * (1 - mastery / 5);
  }

  const sessionCount = sessionCounts.get(sentence.id) ?? 0;
  if (sessionCount > 0) {
    weight *= 1 / (1 + WEIGHT_SESSION_FREQUENCY * sessionCount);
  }

  return Math.max(weight, 0.1);
};

const weightedRandomPick = (candidates: Sentence[], sessionCounts: Map<string, number>): Sentence => {
  const weights = candidates.map(s => computeWeight(s, sessionCounts));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  let random = Math.random() * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    random -= weights[i];
    if (random <= 0) return candidates[i];
  }

  return candidates[candidates.length - 1];
};

export const useRandomListening = (sentences: Sentence[]) => {
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
  const poolRef = useRef<Sentence[]>(sentences);
  const totalPlayedRef = useRef(0);
  const recentIdsRef = useRef<string[]>([]);
  const sessionCountsRef = useRef<Map<string, number>>(new Map());
  const RECENT_AVOID_COUNT = 3;

  useEffect(() => {
    poolRef.current = sentences;
  }, [sentences]);

  const pickRandomSentence = useCallback((): Sentence | null => {
    const pool = poolRef.current;
    if (pool.length === 0) return null;
    if (pool.length === 1) return pool[0];

    const recentSet = new Set(recentIdsRef.current);
    let candidates = pool.filter(s => !recentSet.has(s.id));

    if (candidates.length === 0) {
      candidates = pool.filter(s => s.id !== lastSentenceIdRef.current);
    }
    if (candidates.length === 0) {
      candidates = pool;
    }

    return weightedRandomPick(candidates, sessionCountsRef.current);
  }, []);

  const playSentenceOnce = useCallback(async (
    sentence: Sentence,
    gen: number
  ): Promise<boolean> => {
    if (!isActiveRef.current || playGenerationRef.current !== gen) return false;

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
          errorMessage: '没有可用的句子，请先添加句子',
        }));
        isActiveRef.current = false;
        break;
      }

      lastSentenceIdRef.current = sentence.id;
      recentIdsRef.current = [
        sentence.id,
        ...recentIdsRef.current.slice(0, RECENT_AVOID_COUNT - 1),
      ];

      const currentCount = sessionCountsRef.current.get(sentence.id) ?? 0;
      sessionCountsRef.current.set(sentence.id, currentCount + 1);

      setState(prev => ({
        ...prev,
        currentSentence: sentence,
        currentRepeat: 0,
        errorMessage: null,
      }));

      let consecutiveErrors = 0;
      let completedRepeats = 0;

      while (completedRepeats < REPEATS_PER_SENTENCE) {
        if (!isActiveRef.current || playGenerationRef.current !== gen) return;

        const success = await playSentenceOnce(sentence, gen);
        if (!isActiveRef.current || playGenerationRef.current !== gen) return;

        if (!success) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            setState(prev => ({
              ...prev,
              isActive: false,
              errorMessage: '语音播放连续失败，请检查TTS设置后重试',
            }));
            isActiveRef.current = false;
            return;
          }
          await new Promise<void>(r => setTimeout(r, 1500));
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
  }, [pickRandomSentence, playSentenceOnce]);

  const startListening = useCallback(() => {
    const pool = poolRef.current;
    if (pool.length === 0) {
      setState(prev => ({
        ...prev,
        errorMessage: '暂无可用句子，请先添加或学习句子',
      }));
      return;
    }

    isActiveRef.current = true;
    totalPlayedRef.current = 0;
    recentIdsRef.current = [];
    sessionCountsRef.current = new Map();
    const gen = ++playGenerationRef.current;

    setState({
      isActive: true,
      currentSentence: null,
      currentRepeat: 0,
      totalPlayed: 0,
      errorMessage: null,
    });

    runListeningLoop(gen);
  }, [runListeningLoop]);

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
    const currentGen = playGenerationRef.current;
    return () => {
      if (isActiveRef.current) {
        isActiveRef.current = false;
        playGenerationRef.current = currentGen + 1;
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
    randomListeningPoolSize: sentences.length,
    toggleRandomListening: toggleListening,
    startRandomListening: startListening,
    stopRandomListening: stopListening,
    REPEATS_PER_SENTENCE,
  };
};
