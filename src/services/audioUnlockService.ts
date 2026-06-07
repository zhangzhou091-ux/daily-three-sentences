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
  if (isAudioUnlocked) {
    console.log('🔊 [AudioUnlock] 音频引擎已解锁，跳过重复解锁');
    return Promise.resolve(true);
  }
  if (typeof window === 'undefined') {
    console.warn('🔊 [AudioUnlock] window 未定义，无法解锁');
    return Promise.resolve(false);
  }

  if (unlockPromise) {
    console.log('🔊 [AudioUnlock] 解锁正在进行中，复用已有 Promise');
    return unlockPromise;
  }

  console.log('🔊 [AudioUnlock] 开始解锁 iOS 音频引擎...');
  unlockPromise = new Promise<boolean>((resolve) => {
    try {
      // 同时解锁 AudioContext（与 HTMLAudioElement 是两套独立子系统）
      try {
        const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextCtor) {
          const ctx = new AudioContextCtor();
          console.log(`🔊 [AudioUnlock] AudioContext 已创建，当前状态: ${ctx.state}`);
          if (ctx.state === 'suspended') {
            ctx.resume().then(() => {
              console.log(`🔊 [AudioUnlock] AudioContext 已恢复，新状态: ${ctx.state}`);
            }).catch((e) => {
              console.warn(`🔊 [AudioUnlock] AudioContext.resume() 失败:`, e);
            });
          }
        } else {
          console.log('🔊 [AudioUnlock] 当前环境不支持 AudioContext');
        }
      } catch (e) {
        console.warn('🔊 [AudioUnlock] AudioContext 解锁异常:', e);
      }

      const audio = new Audio();
      audio.src = SILENCE_MP3_BASE64;
      audio.volume = 0.01;
      audio.preload = 'auto';
      console.log('🔊 [AudioUnlock] HTMLAudioElement 已创建，准备播放静音解锁...');

      const timeout = setTimeout(() => {
        console.warn('🔊 [AudioUnlock] 3秒超时，强制标记为已解锁（兜底）');
        isAudioUnlocked = true;
        resolve(true);
      }, 3000);

      audio.play().then(() => {
        clearTimeout(timeout);
        isAudioUnlocked = true;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        console.log('🔊 [AudioUnlock] iOS 音频引擎已成功解锁 ✅');
        resolve(true);
      }).catch((e) => {
        clearTimeout(timeout);
        isAudioUnlocked = false;
        unlockPromise = null;
        console.error(`🔊 [AudioUnlock] 解锁失败 ❌ | [错误] ${e?.name || 'unknown'}: ${e?.message || '未知错误'}`);
        resolve(false);
      });
    } catch (e) {
      unlockPromise = null;
      console.error('🔊 [AudioUnlock] 解锁过程异常 ❌:', e);
      resolve(false);
    }
  });

  return unlockPromise;
};
