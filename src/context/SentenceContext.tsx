import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storage';
import { supabaseService } from '../services/supabaseService';
import { useSync } from './SyncContext';
import { useAppContext } from './AppContext';
import { getLocalDateString } from '../utils/date';

interface SentenceContextType {
  sentences: Sentence[];
  refreshSentences: (opts?: { forceSync?: boolean }) => Promise<void>;
  isSyncing: boolean;
  syncMessage: string;
  isInitialLoading: boolean;
  syncError: string | null;
}

const SentenceContext = createContext<SentenceContextType | undefined>(undefined);

export function mergeSentencesByUpdatedAt(
  existing: Sentence[], 
  incoming: Sentence[]
): Sentence[] {
  const map = new Map<string, Sentence>();
  
  existing.forEach(s => {
    if (s && s.id) {
      map.set(s.id, s);
    }
  });
  
  incoming.forEach(s => {
    if (s && s.id) {
      const existingSentence = map.get(s.id);
      if (!existingSentence) {
        map.set(s.id, s);
      } else {
        const existingTime = existingSentence.updatedAt || 0;
        const incomingTime = s.updatedAt || 0;
        if (incomingTime > existingTime) {
          // 守卫：云端数据不可用未学状态覆盖本地已学状态
          if (existingSentence.intervalIndex > 0 && (s.intervalIndex ?? 0) === 0) {
            console.log('[TRACE-CACHE] mergeSentencesByUpdatedAt守卫 | 阻止云端覆盖本地已学状态 | id=' + s.id + ' | english="' + ((s.english || '').substring(0, 20)) + '" | localIntervalIndex=' + existingSentence.intervalIndex + ' | cloudIntervalIndex=' + (s.intervalIndex ?? 0) + ' | localUpdatedAt=' + existingTime + ' | cloudUpdatedAt=' + incomingTime);
            map.set(s.id, {
              ...s,
              intervalIndex: existingSentence.intervalIndex,
              reps: existingSentence.reps,
              timesReviewed: existingSentence.timesReviewed,
              stability: existingSentence.stability,
              difficulty: existingSentence.difficulty,
              lapses: existingSentence.lapses,
              state: existingSentence.state,
              isPendingFirstReview: existingSentence.isPendingFirstReview,
              learnedAt: existingSentence.learnedAt,
              lastReviewedAt: existingSentence.lastReviewedAt,
              nextReviewDate: existingSentence.nextReviewDate,
              scheduledDays: existingSentence.scheduledDays,
              masteryLevel: existingSentence.masteryLevel,
              wrongDictations: existingSentence.wrongDictations,
              isManual: existingSentence.isManual,
              ttsAudioPathEl: existingSentence.ttsAudioPathEl,
              ttsAudioPathMm: existingSentence.ttsAudioPathMm,
              scheduledDate: undefined
            });
          } else {
            // 双方都已学或本地未学：用云端数据，但清除已学句子的脏 scheduledDate
            map.set(s.id, (s.intervalIndex ?? 0) > 0 && s.scheduledDate
              ? { ...s, scheduledDate: undefined }
              : s
            );
          }
        } else if (incomingTime === existingTime) {
          // 时间戳相同，保留已学状态更高的版本
          if ((s.intervalIndex || 0) > (existingSentence.intervalIndex || 0)) {
            console.log('[TRACE-CACHE] mergeSentencesByUpdatedAt | 时间戳相同，保留已学更高版本 | id=' + s.id + ' | english="' + ((s.english || '').substring(0, 20)) + '" | localIntervalIndex=' + (existingSentence.intervalIndex || 0) + ' | cloudIntervalIndex=' + (s.intervalIndex || 0));
            map.set(s.id, s);
          }
        }
      }
    }
  });
  
  return Array.from(map.values()).sort((a, b) => a.addedAt - b.addedAt);
}

export const SentenceProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const { isOnline, isConfigured } = useAppContext();
  const { syncData, isSyncing, syncMessage } = useSync();
  
  const lastRequestId = useRef(0);
  const previousSentencesRef = useRef<Sentence[]>([]);
  const dataVersionRef = useRef(0);
  const isConfiguredRef = useRef(isConfigured);
  const isOnlineRef = useRef(isOnline);
  isConfiguredRef.current = isConfigured;
  isOnlineRef.current = isOnline;

  // 跨日检测相关 ref
  const lastCrossDayDateRef = useRef<string>(getLocalDateString());
  // F4: 记录后台时间戳,用于识别"从后台恢复"场景以跳过日节流强制拉取云端
  const lastBackgroundTimestampRef = useRef(0);

  const refreshSentences = useCallback(async (opts?: { forceSync?: boolean }) => {
    const currentRequestId = ++lastRequestId.current;
    const currentVersion = ++dataVersionRef.current;

    try {
      console.log('📚 SentenceContext: 开始加载本地句子...');
      const localData = await storageService.getSentences();

      if (currentRequestId !== lastRequestId.current) {
        console.log('📚 SentenceContext: 检测到新请求，放弃当前本地数据更新');
        return;
      }

      console.log(`📚 SentenceContext: 本地句子加载完成，共${localData.length}条`);
      const localScheduled = localData.filter(s => s.scheduledDate);
      if (localScheduled.length > 0) {
        console.log('[TRACE-SCHEDULE] SentenceContext本地数据 | 预约句子=' + localScheduled.length + '条');
        localScheduled.forEach(s => {
          console.log('[TRACE-SCHEDULE]   本地: english="' + (s.english || '').substring(0, 30) + '" | scheduledDate=' + s.scheduledDate + ' | intervalIndex=' + s.intervalIndex);
        });
      }

      if (localData.length > 0 || previousSentencesRef.current.length === 0) {
        setSentences(localData);
        previousSentencesRef.current = localData;
      }

      setSyncError(null);
      setIsInitialLoading(false);

      if (isConfiguredRef.current && isOnlineRef.current) {
        const LAST_SYNC_DATE_KEY = 'd3s_last_sync_date';
        const today = getLocalDateString();
        const lastSyncDate = localStorage.getItem(LAST_SYNC_DATE_KEY);

        if (lastSyncDate === today && localData.length > 0 && !opts?.forceSync) {
          console.log('📚 SentenceContext: 今日已同步，跳过云端同步');
          return;
        }
        if (opts?.forceSync && lastSyncDate === today) {
          console.log('📚 SentenceContext: forceSync=true,跳过日节流强制拉取云端新数据');
        }

        console.log('📚 SentenceContext: 开始云端同步...');
        const result = await syncData(localData);

        if (Array.isArray(result) && result.length > 0) {
          console.log(`📚 SentenceContext: 云端同步完成，共${result.length}条`);

          const mergedData = mergeSentencesByUpdatedAt(
            previousSentencesRef.current,
            result
          );
          
          // 埋点：检测云端同步是否覆盖了本地数据
          const localMap = new Map(previousSentencesRef.current.map(s => [s.id, s]));
          const mergedScheduled = mergedData.filter(s => s.scheduledDate);
          const localScheduled = previousSentencesRef.current.filter(s => s.scheduledDate);
          console.log('[TRACE-SCHEDULE] SentenceContext云端合并 | 合并前预约=' + localScheduled.length + '条 | 合并后预约=' + mergedScheduled.length + '条');
          
          // 检测学习状态是否被覆盖
          result.forEach(cloudSentence => {
            const localSentence = localMap.get(cloudSentence.id);
            if (localSentence && localSentence.intervalIndex > 0 && cloudSentence.intervalIndex === 0) {
              console.warn('[TRACE-SCHEDULE] ⚠️ 云端同步可能覆盖了学习状态 | english="' + (cloudSentence.english || '').substring(0, 30) + '" | local.intervalIndex=' + localSentence.intervalIndex + ' | cloud.intervalIndex=' + cloudSentence.intervalIndex + ' | cloud.updatedAt=' + (cloudSentence.updatedAt || 0) + ' | local.updatedAt=' + (localSentence.updatedAt || 0));
            }
          });

          previousSentencesRef.current = mergedData;

          if (currentRequestId === lastRequestId.current && currentVersion === dataVersionRef.current) {
            console.log('📚 SentenceContext: 当前请求为最新，更新UI');
            setSentences(mergedData);
            setSyncError(null);
          } else {
            console.log('📚 SentenceContext: 请求已过期，同步结果已缓存但不更新UI');
            console.log(`📚 SentenceContext: 缓存版本=${currentVersion}, 最新版本=${dataVersionRef.current}`);
          }

          // 只有同步成功且有数据时才标记今日已同步，防止失败后下次打开跳过同步
          localStorage.setItem(LAST_SYNC_DATE_KEY, today);
        } else if (result === undefined) {
          console.warn('📚 SentenceContext: 云端同步未执行（未配置或离线），保持本地数据');
          if (currentRequestId === lastRequestId.current) {
            setSyncError('同步未执行，显示本地数据');
          }
        }

      } else {
        console.log('📚 SentenceContext: 跳过云端同步', { isConfigured: isConfiguredRef.current, isOnline: isOnlineRef.current });
      }
    } catch (err: unknown) {
      console.error('📚 SentenceContext: 加载句子失败:', err);
      
      if (currentRequestId === lastRequestId.current) {
        setSyncError(err instanceof Error ? err.message : '加载失败');
        setIsInitialLoading(false);
        
        if (previousSentencesRef.current.length > 0) {
          console.log('📚 SentenceContext: 恢复到上一次的有效数据');
          setSentences(previousSentencesRef.current);
        }
      }
    }
  }, [syncData]);

  const refreshSentencesRef = useRef(refreshSentences);
  refreshSentencesRef.current = refreshSentences;

  // 防线A：信号消费必须在同步前
  // 先消费跨设备信号 → 覆盖本地 → 再 refreshSentences（加载已覆盖的本地数据 + 同步云端）
  // 若 initSync 先跑，守卫会在信号消费前触发回推，污染云端
  // 信号消费失败不阻塞主流程（防线C 会兜底：守卫检查未消费信号 → 跳过回推）
  const consumeOverwriteSignalsBeforeSync = useCallback(async (): Promise<number> => {
    if (!isConfiguredRef.current || !isOnlineRef.current) return 0;
    if (!supabaseService.isReady) return 0;

    try {
      const signals = await supabaseService.checkAndConsumeSyncSignals();
      if (!signals || signals.length === 0) return 0;

      console.log(`[OVERWRITE-SIGNAL] 发现 ${signals.length} 条待消费的单句覆盖信号`);

      // 顺带异步清理过期信号（30天前），避免 sync_signals 表无限增长
      // 防线B：30天窗口，给离线设备充足时间消费信号
      // 不阻塞当前流程，静默失败
      supabaseService.cleanupExpiredSyncSignals(30).catch(() => { /* ignore */ });

      let appliedCount = 0;
      for (const signal of signals) {
        // 拉取云端句子最新数据
        const cloudSentence = await supabaseService.fetchSingleCloudSentence(
          signal.sentenceId,
          signal.english
        );
        if (!cloudSentence) {
          console.warn(`[OVERWRITE-SIGNAL] 云端未找到句子: ${signal.sentenceId}`);
          continue;
        }

        // 检查1：信号时间 vs 云端当前时间
        // 若云端 updatedAt > 信号 originalUpdatedAt，说明信号已陈旧
        if (signal.originalUpdatedAt > 0 &&
            cloudSentence.updatedAt > signal.originalUpdatedAt) {
          console.log(`[OVERWRITE-SIGNAL] 信号已陈旧(检查1) | english="${signal.english.substring(0, 20)}" | signalTime=${signal.originalUpdatedAt} | cloudTime=${cloudSentence.updatedAt}`);
          continue;
        }

        // 检查2：本地 updatedAt vs 云端当前 updatedAt
        // 若本地 updatedAt > 云端 updatedAt，说明本地有更新的进度，跳过保护
        const localSentences = await storageService.getSentences();
        const localSentence = localSentences.find(s =>
          s.id === signal.sentenceId ||
          s.english.trim().toLowerCase() === signal.english.trim().toLowerCase()
        );
        if (localSentence && cloudSentence.updatedAt > 0) {
          if (localSentence.updatedAt > cloudSentence.updatedAt) {
            console.log(`[OVERWRITE-SIGNAL] 本地进度更新(检查2) | english="${signal.english.substring(0, 20)}" | localTime=${localSentence.updatedAt} | cloudTime=${cloudSentence.updatedAt}`);
            continue;
          }
        }

        // 双重检查通过，执行静默覆盖
        await storageService.overwriteSingleSentence(cloudSentence);
        appliedCount++;
        console.log(`[OVERWRITE-SIGNAL] 静默覆盖完成 | english="${signal.english.substring(0, 20)}"`);
      }

      return appliedCount;
    } catch (err) {
      console.error('[OVERWRITE-SIGNAL] 信号检查失败:', err instanceof Error ? err.message : String(err));
      return 0;
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      if (previousSentencesRef.current.length > 0) {
        console.log('📚 SentenceContext: 使用缓存数据立即渲染');
        setSentences(previousSentencesRef.current);
        setIsInitialLoading(false);
      }

      // 防线A：先消费跨设备覆盖信号，再执行同步
      // 原因：若同步先跑，守卫会在信号消费前触发回推，污染云端
      // 信号消费失败不阻塞主流程（防线C 会兜底）
      const appliedCount = await consumeOverwriteSignalsBeforeSync();
      if (appliedCount > 0) {
        console.log(`[OVERWRITE-SIGNAL] 共静默覆盖 ${appliedCount} 条句子，继续执行同步`);
      }

      refreshSentences();
    };
    init();
  }, [isConfigured, isOnline, refreshSentences, consumeOverwriteSignalsBeforeSync]);

  // 跨日检测：用户切回标签页或定时检查时，若日期变更则重新加载数据
  // F4/F5/F6: 补充 pageshow/focus 监听 + 后台恢复 forceSync + 60s 间隔
  useEffect(() => {
    const BACKGROUND_RESUME_WINDOW_MS = 10000;

    const isRecentBackgroundResume = () => {
      const now = Date.now();
      return lastBackgroundTimestampRef.current > 0 &&
             (now - lastBackgroundTimestampRef.current) < BACKGROUND_RESUME_WINDOW_MS;
    };

    const checkCrossDay = () => {
      const today = getLocalDateString();
      const isNewDay = lastCrossDayDateRef.current !== today;
      const shouldForceSync = isRecentBackgroundResume();

      if (isNewDay) {
        console.log(`📚 SentenceContext: 检测到跨日（${lastCrossDayDateRef.current} → ${today}），触发数据刷新`);
        lastCrossDayDateRef.current = today;
        refreshSentencesRef.current({ forceSync: shouldForceSync });
      } else if (shouldForceSync) {
        console.log('📚 SentenceContext: 后台恢复(同日),forceSync=true 强制拉取云端新数据');
        refreshSentencesRef.current({ forceSync: true });
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastBackgroundTimestampRef.current = Date.now();
      } else if (document.visibilityState === 'visible') {
        checkCrossDay();
      }
    };

    // F6: pageshow 无条件触发,覆盖 BFCache 恢复和非 BFCache 恢复
    const handlePageShow = () => {
      checkCrossDay();
    };

    // F6: focus 作为第三道防线
    const handleFocus = () => {
      checkCrossDay();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('focus', handleFocus);
    // F5: 5min → 60s,与 useDailySelection 保持一致
    const intervalId = setInterval(checkCrossDay, 60 * 1000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('focus', handleFocus);
      clearInterval(intervalId);
    };
  }, []);

  // 注：原"延迟2秒检查信号"的 useEffect 已移除，改为防线A（信号消费前置在 refreshSentences 之前）
  // 详见上方 consumeOverwriteSignalsBeforeSync + init useEffect

  return (
    <SentenceContext.Provider value={{ sentences, refreshSentences, isSyncing, syncMessage, isInitialLoading, syncError }}>
      {children}
    </SentenceContext.Provider>
  );
};

export const useSentenceContext = () => {
  const context = useContext(SentenceContext);
  if (!context) throw new Error('useSentenceContext must be used within SentenceProvider');
  return context;
};
