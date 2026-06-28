import { useState, useEffect, useRef, useCallback } from 'react';

// 定时时长选项（分钟），0 表示关闭
export const TIMER_DURATION_OPTIONS = [
  { value: 0, label: '关' },
  { value: 5, label: '5分' },
  { value: 10, label: '10分' },
  { value: 15, label: '15分' },
  { value: 30, label: '30分' },
  { value: 60, label: '60分' },
] as const;

export const formatTimer = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

interface UseDictationTimerOptions {
  /** 到期回调：由外部停止两个朗读 hook */
  onExpire: () => void;
}

/**
 * 默写页面朗读定时器 hook
 *
 * 设计要点：
 * - 自管理 start/stop，外部通过监听"任一朗读激活"的合并状态调用，避免模式切换时定时器重置
 * - 用 Date.now() 计算剩余时间，不受 iOS 后台 setInterval 节流影响
 * - 监听 visibilitychange：iOS 后台定时器被冻结，回前台时立即检查并触发到期
 * - isExpiredRef 守卫：防止 onExpire 重复触发
 */
export const useDictationTimer = ({ onExpire }: UseDictationTimerOptions) => {
  const [durationMin, setDurationMin] = useState<number>(0); // 0 = 关闭
  const [remainingSec, setRemainingSec] = useState(0);
  const [isRunning, setIsRunning] = useState(false);

  const endTimeRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isExpiredRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    const remaining = Math.max(0, Math.ceil((endTimeRef.current - Date.now()) / 1000));
    setRemainingSec(remaining);
    if (remaining <= 0 && !isExpiredRef.current) {
      isExpiredRef.current = true;
      clearTimer();
      setIsRunning(false);
      onExpireRef.current();
    }
  }, [clearTimer]);

  /** 启动定时器（仅当 durationMin > 0 时生效；已运行则忽略，避免模式切换时重置） */
  const start = useCallback(() => {
    if (durationMin <= 0) return;
    // 已在运行中（模式切换场景）：不重置，保持原 endTime
    if (isRunning) return;
    // 上次已到期但未重置标志：重新启动时清除
    isExpiredRef.current = false;
    endTimeRef.current = Date.now() + durationMin * 60 * 1000;
    setRemainingSec(durationMin * 60);
    setIsRunning(true);
    clearTimer();
    intervalRef.current = setInterval(tick, 1000);
  }, [durationMin, isRunning, clearTimer, tick]);

  /** 停止并重置定时器 */
  const stop = useCallback(() => {
    clearTimer();
    isExpiredRef.current = false;
    setIsRunning(false);
    setRemainingSec(0);
  }, [clearTimer]);

  /** 切换时长：运行中改变会停止当前定时器，需等下次播放开始才重新计时 */
  const changeDuration = useCallback((min: number) => {
    setDurationMin(min);
    // 改时长时停止当前计时（避免用旧时长继续跑），下次播放启动时重新开始
    clearTimer();
    isExpiredRef.current = false;
    setIsRunning(false);
    setRemainingSec(0);
  }, [clearTimer]);

  // iOS 后台防护：页面从隐藏回到可见时立即检查是否到期
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && isRunning && !isExpiredRef.current) {
        tick();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [isRunning, tick]);

  // 卸载清理
  useEffect(() => clearTimer, [clearTimer]);

  return {
    durationMin,
    remainingSec,
    isRunning,
    start,
    stop,
    changeDuration,
  };
};
