import { useState, useMemo, useRef, useCallback, useEffect, type RefObject } from 'react';
import { Sentence, DictationRecord } from '../../../types';
import { storageService } from '../../../services/storage';
import { deviceService } from '../../../services/deviceService';
import { syncQueueService } from '../../../services/syncQueueService';
import { supabaseService } from '../../../services/supabaseService';
import { getLocalDateString } from '../../../utils/date';
import { DICTATION_XP } from '../../../constants';

interface UseDictationLogicProps {
  sentences: Sentence[];
  isOnline: boolean;
  isMountedRef: RefObject<boolean>;
}

interface UseDictationLogicReturn {
  dictationPool: Sentence[];
  targetDictationId: string | null;
  dictationList: DictationRecord[];
  userInput: string;
  setUserInput: (input: string) => void;
  isDictationRefreshDisabled: boolean;
  isDictationChecking: boolean;
  handleDictationRefresh: () => void;
  handleDictationCheck: () => Promise<void>;
}

export const useDictationLogic = ({
  sentences,
  isOnline,
  isMountedRef,
}: UseDictationLogicProps): UseDictationLogicReturn => {
  const [dictationList, setDictationList] = useState<DictationRecord[]>(() => 
    storageService.getTodayDictations()
  );
  const [targetDictationId, setTargetDictationId] = useState<string | null>(null);
  const [isFlipped, setIsFlipped] = useState(false);
  const [userInput, setUserInput] = useState('');
  const [isDictationRefreshDisabled, setIsDictationRefreshDisabled] = useState(false);
  const [isDictationChecking, setIsDictationChecking] = useState(false);
  
  const isDictationCheckingRef = useRef(false);
  const dictationRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dictationPoolRef = useRef<Sentence[]>([]);
  const dictationDateRef = useRef(getLocalDateString());

  const dictationPool = useMemo(() => {
    return sentences.filter(s => s.intervalIndex > 0);
  }, [sentences]);

  useEffect(() => {
    dictationPoolRef.current = dictationPool;
  }, [dictationPool]);

  useEffect(() => {
    const today = getLocalDateString();
    if (dictationDateRef.current !== today) {
      dictationDateRef.current = today;
      setDictationList(storageService.getTodayDictations());
    }
  }, []);

  const pickNewDictationTarget = useCallback(() => {
    if (dictationPool.length === 0) return;
    const randomIdx = Math.floor(Math.random() * dictationPool.length);
    setTargetDictationId(dictationPool[randomIdx].id);
    setIsFlipped(false);
    setUserInput('');
  }, [dictationPool]);

  const handleDictationRefresh = useCallback(() => {
    if (dictationPool.length === 0) {
      alert('暂无可默写的句子，请先学习句子');
      return;
    }
    setIsDictationRefreshDisabled(true);
    pickNewDictationTarget();
    
    if (dictationRefreshTimerRef.current) clearTimeout(dictationRefreshTimerRef.current);
    dictationRefreshTimerRef.current = setTimeout(() => {
      setIsDictationRefreshDisabled(false);
    }, 1000);
  }, [dictationPool, pickNewDictationTarget]);

  const DICTATION_CHECK_TIMEOUT = 10000;
  const dictationCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDictationCheck = useCallback(async () => {
    if (isDictationCheckingRef.current) return;
    
    const currentTargetId = targetDictationId;
    const currentInput = userInput.trim();
    
    if (!currentInput) {
      alert('请输入默写内容后再核对');
      return;
    }

    if (!currentTargetId) {
      alert('目标句子不存在');
      return;
    }

    isDictationCheckingRef.current = true;
    setIsDictationChecking(true);

    if (dictationCheckTimeoutRef.current) clearTimeout(dictationCheckTimeoutRef.current);
    dictationCheckTimeoutRef.current = setTimeout(() => {
      if (isDictationCheckingRef.current) {
        isDictationCheckingRef.current = false;
        setIsDictationChecking(false);
        alert('核对超时，请重试');
      }
    }, DICTATION_CHECK_TIMEOUT);

    
    try {
      const target = sentences.find(s => s.id === currentTargetId);
      if (!target) {
        throw new Error('目标句子不存在');
      }

      const normalize = (str: string) => str.replace(/[^\w\s]/g, '').replace(/\s{2,}/g, ' ').trim().toLowerCase();
      const isCorrect = normalize(currentInput) === normalize(target.english);

      const latestDictationList = storageService.getTodayDictations();
      const hasCompletedCorrectly = latestDictationList.some(
        r => r.sentenceId === currentTargetId && r.status === 'correct'
      );

      if (hasCompletedCorrectly) {
        throw new Error('该句子今日已完成默写，将为您切换到下一句');
      }

      const newRecord: DictationRecord = {
        sentenceId: currentTargetId,
        status: isCorrect ? 'correct' : 'wrong',
        timestamp: Date.now(),
        isFinished: true
      };

      const newList = [newRecord, ...latestDictationList];
      storageService.saveTodayDictations(newList);
      setDictationList(newList);

      if (isCorrect) {
        setUserInput('');
        
        const currentPool = dictationPoolRef.current;
        const remainingPool = currentPool.filter(s => s.id !== currentTargetId);
        
        if (remainingPool.length > 0) {
          const todayCorrectIds = new Set(
            latestDictationList.filter(r => r.status === 'correct').map(r => r.sentenceId)
          );
          const unlearnedToday = remainingPool.filter(s => !todayCorrectIds.has(s.id));
          
          if (unlearnedToday.length > 0) {
            const nextIdx = Math.floor(Math.random() * unlearnedToday.length);
            setTargetDictationId(unlearnedToday[nextIdx].id);
          } else {
            const nextIdx = Math.floor(Math.random() * remainingPool.length);
            setTargetDictationId(remainingPool[nextIdx].id);
          }
          setIsFlipped(false);
        } else {
          setTargetDictationId(null);
        }
        
        try {
          await storageService.updateStatsSafely(stats => {
            stats.dictationCount = (stats.dictationCount || 0) + 1;
            stats.totalPoints += DICTATION_XP;
            if (deviceService.canSubmitFeedback()) {
              stats.mobileDictationCount = (stats.mobileDictationCount || 0) + 1;
            }
            return stats;
          });
        } catch (statsErr: unknown) {
          if (statsErr instanceof Error) {
            console.warn('更新统计失败，默写记录已保存:', statsErr.message);
          } else {
            console.warn('更新统计失败，默写记录已保存:', String(statsErr));
          }
        }
      } else {
        setIsFlipped(true);
      }

      if (!isOnline) {
        syncQueueService.addDictationRecord(newRecord);
      } else {
        supabaseService.syncDictationRecord(newRecord).catch((err: unknown) => {
          if (err instanceof Error) {
            console.warn('默写记录-云端同步失败，已加入离线队列', err.message);
          } else {
            console.warn('默写记录-云端同步失败，已加入离线队列', String(err));
          }
          syncQueueService.addDictationRecord(newRecord);
        });
      }

    } catch (err: unknown) {
      if (err instanceof Error) {
        console.warn('默写核对过程中发生异常:', err.message);
        alert(err.message);
      } else {
        console.warn('默写核对过程中发生异常:', String(err));
        alert('默写核对失败，请重试');
      }
      
      if (err instanceof Error && err.message.includes('已完成默写')) {
        const currentPool = dictationPoolRef.current;
        const remainingPool = currentPool.filter(s => s.id !== currentTargetId);
        if (remainingPool.length > 0) {
          const nextIdx = Math.floor(Math.random() * remainingPool.length);
          setTargetDictationId(remainingPool[nextIdx].id);
          setIsFlipped(false);
          setUserInput('');
        }
      }
    } finally {
      if (dictationCheckTimeoutRef.current) {
        clearTimeout(dictationCheckTimeoutRef.current);
        dictationCheckTimeoutRef.current = null;
      }
      isDictationCheckingRef.current = false;
      setIsDictationChecking(false);
    }
  }, [userInput, sentences, targetDictationId, isOnline]);

  useEffect(() => {
    return () => {
      if (dictationRefreshTimerRef.current) clearTimeout(dictationRefreshTimerRef.current);
    };
  }, []);

  return {
    dictationPool,
    targetDictationId,
    dictationList,
    userInput,
    setUserInput,
    isDictationRefreshDisabled,
    isDictationChecking,
    handleDictationRefresh,
    handleDictationCheck,
  };
};
