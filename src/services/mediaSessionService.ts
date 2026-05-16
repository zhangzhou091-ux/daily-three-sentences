const SILENCE_MP3_BASE64 = 'data:audio/mp3;base64,//OQxAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

const isIOSAudio = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

let silenceAudio: HTMLAudioElement | null = null;
let isHolding = false;
let currentMetadataText: string | null = null;

const ensureSilenceAudio = (): HTMLAudioElement => {
  if (!silenceAudio) {
    silenceAudio = new Audio(SILENCE_MP3_BASE64);
    silenceAudio.loop = true;
    silenceAudio.volume = 0.01;
    silenceAudio.preload = 'auto';
  }
  return silenceAudio;
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

  stopAll(): void {
    if (silenceAudio) {
      silenceAudio.pause();
      silenceAudio.currentTime = 0;
    }
    isHolding = false;
    currentMetadataText = null;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('stop', null);
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

  setActionHandlers(handlers: { onPlay?: () => void; onPause?: () => void; onStop?: () => void }): void {
    if (!('mediaSession' in navigator)) return;
    try {
      if (handlers.onPlay) navigator.mediaSession.setActionHandler('play', handlers.onPlay);
      if (handlers.onPause) navigator.mediaSession.setActionHandler('pause', handlers.onPause);
      if (handlers.onStop) navigator.mediaSession.setActionHandler('stop', handlers.onStop);
    } catch {}
  },

  isHoldingAudioFocus(): boolean {
    return isHolding;
  },

  getCurrentMetadataText(): string | null {
    return currentMetadataText;
  },
};
