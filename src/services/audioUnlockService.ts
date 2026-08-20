import { createSilenceWavBlob } from './mediaSessionService';

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

      // 解锁用静音音频：全零采样 WAV（复用 createSilenceWavBlob）。
      // 之前用"1 个有效 MP3 帧 + 0xAA 填充字节"的 hack 文件循环维持会话，有两个问题：
      // 1. iOS Safari 忽略 HTMLAudioElement.volume，"压低音量"写法无效，
      //    填充字节被解码成持续底噪，表现为第一句发音尾部有杂音
      //    （解锁后的 10 秒维持窗口恰好覆盖第一句的播放）；
      // 2. MP3 loop 边界存在瞬态不连续（click）。
      // 全零 WAV 任何音量下都无声、循环无缝，不依赖被 iOS 忽略的 volume，从根上消除杂音。
      let audio: HTMLAudioElement;
      let silenceUrl: string;
      try {
        audio = new Audio();
        silenceUrl = URL.createObjectURL(createSilenceWavBlob(1000));
        audio.src = silenceUrl;
        audio.loop = true;
        audio.preload = 'auto';
      } catch (e) {
        // 创建失败早退：保证本 Promise 永远走 resolve 而非 reject（调用方契约：始终返回 boolean）
        console.error('🔊 [AudioUnlock] 静音音频创建异常 ❌:', e);
        unlockPromise = null;
        resolve(false);
        return;
      }
      console.log('🔊 [AudioUnlock] HTMLAudioElement 已创建（全零 WAV 静音源），准备播放静音解锁...');

      // 统一清理：暂停 + 释放 src + 回收 blob URL（超时/失败/维持结束三条路径共用）
      const cleanupSilence = () => {
        try {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        } catch { /* ignore */ }
        try { URL.revokeObjectURL(silenceUrl); } catch { /* ignore */ }
      };

      const timeout = setTimeout(() => {
        console.warn('🔊 [AudioUnlock] 3秒超时，音频引擎未能解锁（可能是iOS静音模式或用户未交互）');
        unlockPromise = null;
        cleanupSilence();
        resolve(false);
      }, 3000);

      audio.play().then(() => {
        clearTimeout(timeout);
        isAudioUnlocked = true;
        console.log('🔊 [AudioUnlock] iOS 音频引擎已成功解锁 ✅');
        // 不立即 pause()！iOS 上 pause()+removeAttribute('src') 会让系统认为音频会话已结束，
        // 重新锁定音频，导致后续 TTS 的 play() 被拒绝（发音按钮需点 2 次）。
        // 改为循环静音维持 10 秒，确保 TTS 网络请求返回后 play() 不被拒绝。
        // （全零 WAV 本身无声，无需依赖 iOS 上不可靠的 volume 压低）
        // 10 秒后自动清理（足够 TTS 网络请求完成并接管播放）
        setTimeout(() => {
          cleanupSilence();
          console.log('🔊 [AudioUnlock] 静音维持定时器已清理');
        }, 10000);
        resolve(true);
      }).catch((e) => {
        clearTimeout(timeout);
        isAudioUnlocked = false;
        unlockPromise = null;
        cleanupSilence();
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
