const SILENCE_MP3_BASE64 = 'data:audio/mp3;base64,//OQxAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

let isAudioUnlocked = false;
let unlockPromise: Promise<boolean> | null = null;

export const isIOSAudio = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

export const isAudioEngineUnlocked = (): boolean => isAudioUnlocked;

export const unlockAudioEngine = (): Promise<boolean> => {
  if (isAudioUnlocked) return Promise.resolve(true);
  if (typeof window === 'undefined') return Promise.resolve(false);

  if (unlockPromise) return unlockPromise;

  unlockPromise = new Promise<boolean>((resolve) => {
    try {
      const audio = new Audio();
      audio.src = SILENCE_MP3_BASE64;
      audio.volume = 0.01;
      audio.preload = 'auto';

      const timeout = setTimeout(() => {
        isAudioUnlocked = true;
        resolve(true);
      }, 3000);

      audio.play().then(() => {
        clearTimeout(timeout);
        isAudioUnlocked = true;
        audio.pause();
        audio.src = '';
        console.log('🔊 [AudioUnlock] iOS 音频引擎已解锁');
        resolve(true);
      }).catch(() => {
        clearTimeout(timeout);
        isAudioUnlocked = false;
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });

  return unlockPromise;
};
