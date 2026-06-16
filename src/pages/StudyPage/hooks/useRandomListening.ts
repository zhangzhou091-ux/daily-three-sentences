import { useState, useRef, useCallback, useEffect } from 'react';
import { Sentence } from '../../../types';
import { geminiService } from '../../../services/geminiService';
import { mediaSessionService } from '../../../services/mediaSessionService';
import { continuousAudioPlayer } from '../../../services/continuousAudioPlayer';
import { blacklistStorage } from '../../../services/blacklistStorage';

const REPEATS_PER_SENTENCE = 5;
const INTER_REPEAT_BASE_DELAY = 450;
const INTER_REPEAT_JITTER = 200;
const INTER_SENTENCE_BASE_DELAY = 900;
const INTER_SENTENCE_JITTER = 300;
const MAX_CONSECUTIVE_ERRORS = 5;
const PLAY_TIMEOUT_MS = 15000;
const PLAY_TIMEOUT_PER_CHAR_MS = 250;
const SESSION_RESET_INTERVAL = 14 * 24 * 60 * 60 * 1000;

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
const SESSION_RESET_KEY = 'd3s_random_listening_session_reset';
const PRELOAD_LOOKAHEAD = 2;

const WEIGHT_DIFFICULTY = 2.0;
const WEIGHT_LOW_STABILITY = 1.5;
const WEIGHT_WRONG_DICTATIONS = 1.5;
const WEIGHT_LOW_MASTERY = 1.0;
const WEIGHT_HAS_AUDIO = 1.0;

interface RandomListeningState {
  isActive: boolean;
  currentSentence: Sentence | null;
  currentRepeat: number;
  totalPlayed: number;
  errorMessage: string | null;
  blacklist: Set<string>;
  history: Sentence[];
  historyIndex: number;
}

const jitterDelay = (base: number, jitter: number): number =>
  base + Math.floor(Math.random() * jitter);

const hasAudioCache = (sentence: Sentence): boolean => {
  return !!(sentence.ttsAudioPathEl || sentence.ttsAudioPathMm);
};

const isLearned = (sentence: Sentence): boolean => {
  return !!sentence.learnedAt;
};

const computeWeight = (sentence: Sentence, sessionCounts: Map<string, number>): number => {
  let weight = 1.0;

  if (hasAudioCache(sentence)) {
    weight += WEIGHT_HAS_AUDIO;
  }

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
    weight *= Math.pow(0.15, sessionCount);
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
  const [state, setState] = useState<RandomListeningState>(() => ({
    isActive: false,
    currentSentence: null,
    currentRepeat: 0,
    totalPlayed: 0,
    errorMessage: null,
    blacklist: blacklistStorage.getBlacklist(),
    history: [],
    historyIndex: -1,
  }));

  const isActiveRef = useRef(false);
  const lastSentenceIdRef = useRef<string | null>(null);
  const playGenerationRef = useRef(0);
  const poolRef = useRef<Sentence[]>(sentences);
  const totalPlayedRef = useRef(0);
  const recentIdsRef = useRef<string[]>([]);
  const sessionCountsRef = useRef<Map<string, number>>(new Map());
  const historyRef = useRef<Sentence[]>([]);
  const historyIndexRef = useRef(-1);
  const preloadCacheRef = useRef<Map<string, Blob>>(new Map());
  const goToPrevRef = useRef<(() => void) | null>(null);
  const goToNextRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    poolRef.current = sentences;
  }, [sentences]);

  const getEligiblePool = useCallback((): Sentence[] => {
    const blacklist = state.blacklist;
    return poolRef.current.filter(s => isLearned(s) && !blacklist.has(s.id));
  }, [state.blacklist]);

  const pickRandomSentence = useCallback((): Sentence | null => {
    const eligiblePool = getEligiblePool();
    if (eligiblePool.length === 0) return null;
    if (eligiblePool.length === 1) return eligiblePool[0];

    const recentSet = new Set(recentIdsRef.current);
    let candidates = eligiblePool.filter(s => !recentSet.has(s.id));

    if (candidates.length === 0) {
      candidates = eligiblePool.filter(s => s.id !== lastSentenceIdRef.current);
    }
    if (candidates.length === 0) {
      candidates = eligiblePool;
    }

    const withAudio = candidates.filter(hasAudioCache);
    const withoutAudio = candidates.filter(s => !hasAudioCache(s));

    if (withAudio.length > 0 && withoutAudio.length > 0) {
      const audioRatio = withAudio.length / candidates.length;
      const pickAudioProbability = Math.min(0.85, audioRatio + 0.15);
      if (Math.random() < pickAudioProbability) {
        return weightedRandomPick(withAudio, sessionCountsRef.current);
      } else {
        return weightedRandomPick(withoutAudio, sessionCountsRef.current);
      }
    }

    return weightedRandomPick(candidates, sessionCountsRef.current);
  }, [getEligiblePool]);

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
          console.warn('🔊 [随机朗读] playBlob 失败:', err instanceof Error ? err.message : String(err));
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

        console.log('🔊 [随机朗读] Blob 获取失败，回退到 geminiService.speak');
        geminiService.startSpeechSynthesisKeepAlive();
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

  const addToHistory = useCallback((sentence: Sentence) => {
    const currentHistory = historyRef.current;
    const currentIndex = historyIndexRef.current;

    if (currentIndex >= 0 && currentIndex < currentHistory.length && currentHistory[currentIndex].id === sentence.id) {
      return;
    }

    const newHistory = currentHistory.slice(0, currentIndex + 1);
    newHistory.push(sentence);

    if (newHistory.length > 200) {
      newHistory.shift();
    }

    historyRef.current = newHistory;
    historyIndexRef.current = newHistory.length - 1;

    setState(prev => ({
      ...prev,
      history: newHistory,
      historyIndex: newHistory.length - 1,
    }));
  }, []);

  const runListeningLoop = useCallback(async (gen: number) => {
    while (isActiveRef.current && playGenerationRef.current === gen) {
      const sentence = pickRandomSentence();
      if (!sentence) {
        const eligiblePool = getEligiblePool();
        const message = eligiblePool.length === 0
          ? '没有已学习的句子，请先学习句子后再使用随机朗读'
          : '没有可用的句子，请先添加句子';

        setState(prev => ({
          ...prev,
          isActive: false,
          errorMessage: message,
        }));
        isActiveRef.current = false;
        break;
      }

      lastSentenceIdRef.current = sentence.id;
      const dynamicAvoidCount = Math.min(Math.floor(getEligiblePool().length * 0.6), 50);
      recentIdsRef.current = [
        sentence.id,
        ...recentIdsRef.current.slice(0, dynamicAvoidCount - 1),
      ];

      const currentCount = sessionCountsRef.current.get(sentence.id) ?? 0;
      sessionCountsRef.current.set(sentence.id, currentCount + 1);

      addToHistory(sentence);

      mediaSessionService.updateMetadata(sentence.english);
      mediaSessionService.setActionHandlers({
        onPause: () => { geminiService.stop(); continuousAudioPlayer.stop(); isActiveRef.current = false; },
        onStop: () => { geminiService.stop(); continuousAudioPlayer.stop(); isActiveRef.current = false; },
        onPrevTrack: () => { goToPrevRef.current?.(); },
        onNextTrack: () => { goToNextRef.current?.(); },
      });

      setState(prev => ({
        ...prev,
        currentSentence: sentence,
        currentRepeat: 0,
        errorMessage: null,
      }));

      let audioBlob: Blob | null = preloadCacheRef.current.get(sentence.id) || null;

      if (audioBlob) {
        preloadCacheRef.current.delete(sentence.id);
        console.log(`🔊 [随机朗读] 使用预加载缓存: "${sentence.english.slice(0, 30)}..."`);
      } else {
        try {
          audioBlob = await geminiService.fetchAudioBlob(sentence.english);
        } catch {
          audioBlob = null;
        }
      }
      if (!isActiveRef.current || playGenerationRef.current !== gen) return;

      let consecutiveErrors = 0;
      let completedRepeats = 0;
      let preloadTriggered = false;

      while (completedRepeats < REPEATS_PER_SENTENCE) {
        if (!isActiveRef.current || playGenerationRef.current !== gen) return;

        if (blacklistStorage.isBlacklisted(sentence.id)) {
          break;
        }

        if (!preloadTriggered) {
          preloadTriggered = true;
          const nextSentence = pickRandomSentence();
          if (nextSentence && nextSentence.id !== sentence.id) {
            geminiService.fetchAudioBlob(nextSentence.english).then(blob => {
              if (blob && isActiveRef.current && playGenerationRef.current === gen) {
                preloadCacheRef.current.set(nextSentence.id, blob);
                console.log(`🔊 [随机朗读] 预加载完成: "${nextSentence.english.slice(0, 30)}..."`);
              }
            }).catch(() => {});
          }
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
  }, [pickRandomSentence, playSentenceOnce, getEligiblePool, addToHistory]);

  const startListening = useCallback(() => {
    const eligiblePool = getEligiblePool();
    if (eligiblePool.length === 0) {
      const totalPool = poolRef.current;
      const message = totalPool.length === 0
        ? '暂无可用句子，请先添加或学习句子'
        : '暂无已学习的句子，请先学习句子后再使用随机朗读';

      setState(prev => ({
        ...prev,
        errorMessage: message,
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

    const now = Date.now();
    const lastReset = parseInt(localStorage.getItem(SESSION_RESET_KEY) || '0', 10);
    if (now - lastReset >= SESSION_RESET_INTERVAL) {
      recentIdsRef.current = [];
      sessionCountsRef.current = new Map();
      localStorage.setItem(SESSION_RESET_KEY, String(now));
    }

    const gen = ++playGenerationRef.current;

    setState({
      isActive: true,
      currentSentence: null,
      currentRepeat: 0,
      totalPlayed: 0,
      errorMessage: null,
      blacklist: state.blacklist,
      history: historyRef.current,
      historyIndex: historyIndexRef.current,
    });

    runListeningLoop(gen);
  }, [runListeningLoop, getEligiblePool, state.blacklist]);

  const stopListening = useCallback(() => {
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
  }, []);

  const toggleListening = useCallback(() => {
    if (state.isActive) {
      stopListening();
    } else {
      startListening();
    }
  }, [state.isActive, startListening, stopListening]);

  const goToPreviousSentence = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx <= 0) return;

    const wasActive = isActiveRef.current;
    if (wasActive) {
      isActiveRef.current = false;
      playGenerationRef.current++;
      geminiService.stop();
      continuousAudioPlayer.stop();
    }

    const newIdx = idx - 1;
    historyIndexRef.current = newIdx;
    const sentence = historyRef.current[newIdx];

    lastSentenceIdRef.current = sentence.id;

    setState(prev => ({
      ...prev,
      currentSentence: sentence,
      currentRepeat: 0,
      historyIndex: newIdx,
      errorMessage: null,
    }));

    if (wasActive) {
      const gen = ++playGenerationRef.current;
      isActiveRef.current = true;
      runListeningLoop(gen);
    }
  }, [runListeningLoop]);

  const goToNextSentence = useCallback(() => {
    const idx = historyIndexRef.current;
    const histLen = historyRef.current.length;

    if (idx < histLen - 1) {
      const wasActive = isActiveRef.current;
      if (wasActive) {
        isActiveRef.current = false;
        playGenerationRef.current++;
        geminiService.stop();
        continuousAudioPlayer.stop();
      }

      const newIdx = idx + 1;
      historyIndexRef.current = newIdx;
      const sentence = historyRef.current[newIdx];

      lastSentenceIdRef.current = sentence.id;

      setState(prev => ({
        ...prev,
        currentSentence: sentence,
        currentRepeat: 0,
        historyIndex: newIdx,
        errorMessage: null,
      }));

      if (wasActive) {
        const gen = ++playGenerationRef.current;
        isActiveRef.current = true;
        runListeningLoop(gen);
      }
    } else {
      if (!isActiveRef.current) {
        const sentence = pickRandomSentence();
        if (sentence) {
          lastSentenceIdRef.current = sentence.id;
          addToHistory(sentence);
          setState(prev => ({
            ...prev,
            currentSentence: sentence,
            currentRepeat: 0,
            errorMessage: null,
          }));
        }
      }
    }
  }, [runListeningLoop, pickRandomSentence, addToHistory]);

  useEffect(() => {
    goToPrevRef.current = goToPreviousSentence;
    goToNextRef.current = goToNextSentence;
  }, [goToPreviousSentence, goToNextSentence]);

  const toggleBlacklist = useCallback((sentenceId: string) => {
    const currentBlacklist = state.blacklist;
    let newBlacklist: Set<string>;

    if (currentBlacklist.has(sentenceId)) {
      newBlacklist = blacklistStorage.removeSentence(sentenceId);
    } else {
      newBlacklist = blacklistStorage.addSentence(sentenceId);
    }

    setState(prev => ({
      ...prev,
      blacklist: new Set(newBlacklist),
    }));

    if (state.currentSentence?.id === sentenceId && !newBlacklist.has(sentenceId)) {
      return;
    }

    if (state.isActive && newBlacklist.has(sentenceId) && state.currentSentence?.id === sentenceId) {
      const eligiblePool = poolRef.current.filter(s => isLearned(s) && !newBlacklist.has(s.id));
      if (eligiblePool.length === 0) {
        stopListening();
        setState(prev => ({
          ...prev,
          errorMessage: '所有句子已被排除，请取消部分排除后再试',
        }));
      }
    }
  }, [state.blacklist, state.currentSentence, state.isActive, stopListening]);

  const isBlacklisted = useCallback((sentenceId: string): boolean => {
    return state.blacklist.has(sentenceId);
  }, [state.blacklist]);

  const clearBlacklist = useCallback(() => {
    blacklistStorage.clearBlacklist();
    setState(prev => ({
      ...prev,
      blacklist: new Set(),
    }));
  }, []);

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

  const eligibleCount = getEligiblePool().length;
  const canGoPrevious = state.historyIndex > 0;
  const canGoNext = state.historyIndex < state.history.length - 1 || state.isActive;

  return {
    isRandomListeningActive: state.isActive,
    randomListeningSentence: state.currentSentence,
    randomListeningRepeat: state.currentRepeat,
    randomListeningTotal: state.totalPlayed,
    randomListeningError: state.errorMessage,
    randomListeningPoolSize: eligibleCount,
    toggleRandomListening: toggleListening,
    startRandomListening: startListening,
    stopRandomListening: stopListening,
    goToPreviousSentence,
    goToNextSentence,
    canGoPrevious,
    canGoNext,
    toggleBlacklist,
    isBlacklisted,
    clearBlacklist,
    blacklistSize: state.blacklist.size,
    REPEATS_PER_SENTENCE,
  };
};
