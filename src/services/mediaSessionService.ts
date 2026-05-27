const SILENCE_MP3_BASE64 = 'data:audio/mp3;base64,//OQxAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

const isIOSAudio = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

let silenceAudio: HTMLAudioElement | null = null;
let isHolding = false;
let isKeepAliveActive = false;
let currentMetadataText: string | null = null;
let recoveryRetryCount = 0;
const MAX_RECOVERY_RETRIES = 20;
const RECOVERY_RETRY_DELAY_MS = 500;

const ensureSilenceAudio = (): HTMLAudioElement => {
  if (!silenceAudio) {
    silenceAudio = new Audio(SILENCE_MP3_BASE64);
    silenceAudio.loop = true;
    silenceAudio.volume = 0.01;
    silenceAudio.preload = 'auto';
    silenceAudio.onpause = handleSilencePause;
    silenceAudio.onended = handleSilenceEnded;
  }
  return silenceAudio;
};

const handleSilencePause = (): void => {
  if (!isKeepAliveActive) return;
  if (!silenceAudio) return;

  if (recoveryRetryCount >= MAX_RECOVERY_RETRIES) {
    console.warn('🔊 [MediaSession] 静音恢复重试次数已耗尽，放弃保活');
    isKeepAliveActive = false;
    return;
  }

  recoveryRetryCount++;
  console.log(`🔊 [MediaSession] 静音音频被中断，第 ${recoveryRetryCount}/${MAX_RECOVERY_RETRIES} 次尝试恢复...`);

  setTimeout(() => {
    if (!isKeepAliveActive || !silenceAudio) return;
    silenceAudio.play().then(() => {
      recoveryRetryCount = 0;
      console.log('🔊 [MediaSession] 静音音频已恢复');
    }).catch((e) => {
      console.warn('🔊 [MediaSession] 静音恢复失败，将继续重试:', e);
    });
  }, RECOVERY_RETRY_DELAY_MS);
};

const handleSilenceEnded = (): void => {
  if (!isKeepAliveActive || !silenceAudio) return;
  if (silenceAudio.loop) return;
  console.log('🔊 [MediaSession] 静音音频结束（非循环模式），重新播放');
  silenceAudio.play().catch(() => {});
};

export const mediaSessionService = {
  holdAudioFocus(): void {
    if (!isIOSAudio() || isHolding) return;
    try {
      const audio = ensureSilenceAudio();
      audio.play().catch(() => {});
      isHolding = true;
    } catch {}
  },

  releaseAudioFocus(): void {
    isHolding = false;
  },

  startSilenceKeepAlive(): void {
    if (!isIOSAudio()) return;
    if (isKeepAliveActive) return;
    try {
      recoveryRetryCount = 0;
      const audio = ensureSilenceAudio();
      audio.loop = true;
      audio.onpause = handleSilencePause;
      audio.onended = handleSilenceEnded;
      audio.play().catch(e => console.warn('无声音频播放失败，可能缺少用户交互', e));
      isHolding = true;
      isKeepAliveActive = true;
      console.log('🔊 [MediaSession] 静音保活已启动');
    } catch {}
  },

  stopSilenceKeepAlive(): void {
    isKeepAliveActive = false;
    recoveryRetryCount = 0;
    if (silenceAudio) {
      try {
        silenceAudio.onpause = null;
        silenceAudio.onended = null;
        silenceAudio.pause();
      } catch {}
    }
    console.log('🔊 [MediaSession] 静音保活已停止');
  },

  isKeepAliveActive(): boolean {
    return isKeepAliveActive;
  },

  stopAll(): void {
    recoveryRetryCount = 0;
    if (silenceAudio) {
      silenceAudio.onpause = null;
      silenceAudio.onended = null;
      silenceAudio.pause();
      silenceAudio.currentTime = 0;
    }
    isHolding = false;
    isKeepAliveActive = false;
    currentMetadataText = null;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('stop', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
      } catch {}
    }
  },

  updateMetadata(text: string): void {
    if (!('mediaSession' in navigator)) return;
    currentMetadataText = text;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: text.length > 30 ? text.substring(0, 30) + '...' : text,
        artist: '每日三句',
        album: '英语学习',
      });
    } catch {}
  },

  setActionHandlers(handlers: { onPlay?: () => void; onPause?: () => void; onStop?: () => void; onPrevTrack?: () => void; onNextTrack?: () => void }): void {
    if (!('mediaSession' in navigator)) return;
    try {
      if (handlers.onPlay) navigator.mediaSession.setActionHandler('play', handlers.onPlay);
      if (handlers.onPause) navigator.mediaSession.setActionHandler('pause', handlers.onPause);
      if (handlers.onStop) navigator.mediaSession.setActionHandler('stop', handlers.onStop);
      if (handlers.onPrevTrack) navigator.mediaSession.setActionHandler('previoustrack', handlers.onPrevTrack);
      if (handlers.onNextTrack) navigator.mediaSession.setActionHandler('nexttrack', handlers.onNextTrack);
    } catch {}
  },

  isHoldingAudioFocus(): boolean {
    return isHolding;
  },

  getCurrentMetadataText(): string | null {
    return currentMetadataText;
  },
};
