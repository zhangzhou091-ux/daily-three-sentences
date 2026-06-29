const SILENCE_MP3_BASE64 = 'data:audio/mp3;base64,//OQxAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

const isIOSAudio = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

let silenceAudio: HTMLAudioElement | null = null;
let delayAudio: HTMLAudioElement | null = null;
let isHolding = false;
let isKeepAliveActive = false;
let currentMetadataText: string | null = null;
let recoveryRetryCount = 0;
let delayGeneration = 0;
let currentDelayUrl: string | null = null;
const MAX_RECOVERY_RETRIES = 20;
const RECOVERY_RETRY_DELAY_MS = 500;
const MIN_DELAY_MS = 100;
const DELAY_ROUNDING_MS = 50;

const revokeDelayUrl = (): void => {
  if (!currentDelayUrl) return;
  try {
    URL.revokeObjectURL(currentDelayUrl);
  } catch {
    // ignore cleanup failure
  }
  currentDelayUrl = null;
};

const clearDelayAudio = (): void => {
  if (!delayAudio) {
    revokeDelayUrl();
    return;
  }
  try {
    delayAudio.onended = null;
    delayAudio.onerror = null;
    delayAudio.pause();
    delayAudio.removeAttribute('src');
    delayAudio.load();
  } catch {
    // ignore cleanup failure
  }
  revokeDelayUrl();
};

const ensureDelayAudio = (): HTMLAudioElement => {
  if (!delayAudio) {
    delayAudio = new Audio();
    delayAudio.preload = 'auto';
    delayAudio.volume = 0.01;
  }
  return delayAudio;
};

// 导出供 continuousAudioPlayer 复用，避免重复实现
export const createSilenceWavBlob = (durationMs: number): Blob => {
  const sampleRate = 8000;
  const channelCount = 1;
  const bytesPerSample = 2;
  const roundedDurationMs = Math.max(MIN_DELAY_MS, Math.round(durationMs / DELAY_ROUNDING_MS) * DELAY_ROUNDING_MS);
  const sampleCount = Math.max(1, Math.ceil(sampleRate * roundedDurationMs / 1000));
  const dataSize = sampleCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  return new Blob([buffer], { type: 'audio/wav' });
};

const playBackgroundDelay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const audio = ensureDelayAudio();
    const gen = ++delayGeneration;
    let settled = false;

    const finish = () => {
      if (settled || gen !== delayGeneration) return;
      settled = true;
      clearDelayAudio();
      resolve();
    };

    clearDelayAudio();
    audio.loop = false;
    currentDelayUrl = URL.createObjectURL(createSilenceWavBlob(ms));
    audio.src = currentDelayUrl;
    audio.onended = finish;
    audio.onerror = finish;
    audio.load();
    audio.play().catch(() => {
      // iOS 17 后台可能拒绝新的 Audio.play()，使用 setTimeout 兜底保证句子间延迟
      console.log(`🔊 [AudioKeepAlive] 后台延迟音频播放失败，使用 setTimeout 兜底 ${ms}ms`);
      setTimeout(finish, ms);
    });
  });

// 循环保活用的静音 WAV URL（懒加载，永久持有；WAV 无编码器延迟，loop 边界无缝，
// 不会产生 MP3 循环时的 click/pop 杂音）。页面卸载时由浏览器自动清理。
let silenceWavUrl: string | null = null;
const getSilenceWavUrl = (): string => {
  if (!silenceWavUrl) {
    silenceWavUrl = URL.createObjectURL(createSilenceWavBlob(1000));
    console.log(`🔊 [AudioKeepAlive] 创建静音 WAV URL（循环保活用）| [url] ${silenceWavUrl}`);
  }
  return silenceWavUrl;
};

const ensureSilenceAudio = (): HTMLAudioElement => {
  if (!silenceAudio) {
    console.log(`🔊 [AudioKeepAlive] 创建 silenceAudio 实例 | [iOS] ${isIOSAudio()} | [visibilityState] ${document.visibilityState} | [src=WAV]`);
    silenceAudio = new Audio(getSilenceWavUrl());
    silenceAudio.loop = true;
    silenceAudio.volume = 0.01;
    silenceAudio.preload = 'auto';
    silenceAudio.onpause = handleSilencePause;
    silenceAudio.onended = handleSilenceEnded;
    console.log(`🔊 [AudioKeepAlive] silenceAudio 创建完成 | [loop] ${silenceAudio.loop} | [volume] ${silenceAudio.volume} | [preload] ${silenceAudio.preload}`);
  } else {
    console.log(`🔊 [AudioKeepAlive] 复用已有 silenceAudio | [paused] ${silenceAudio.paused} | [loop] ${silenceAudio.loop} | [src] ${!!silenceAudio.src}`);
  }
  return silenceAudio;
};

const handleSilencePause = (): void => {
  console.log(`🔊 [AudioKeepAlive] onpause 触发 | [isKeepAliveActive] ${isKeepAliveActive} | [silenceAudio] ${!!silenceAudio} | [paused] ${silenceAudio?.paused} | [ended] ${silenceAudio?.ended} | [visibilityState] ${document.visibilityState} | [retryCount] ${recoveryRetryCount}`);

  if (!isKeepAliveActive) {
    console.log(`🔊 [AudioKeepAlive] onpause: 保活已关闭，跳过恢复`);
    return;
  }
  if (!silenceAudio) {
    console.warn(`🔊 [AudioKeepAlive] onpause: silenceAudio 为 null，无法恢复`);
    return;
  }

  if (recoveryRetryCount >= MAX_RECOVERY_RETRIES) {
    console.warn(`🔊 [AudioKeepAlive] 静音恢复重试次数已耗尽 (${recoveryRetryCount}/${MAX_RECOVERY_RETRIES})，放弃保活`);
    isKeepAliveActive = false;
    return;
  }

  recoveryRetryCount++;
  console.log(`🔊 [AudioKeepAlive] 静音音频被中断，第 ${recoveryRetryCount}/${MAX_RECOVERY_RETRIES} 次尝试恢复... | [delay] ${RECOVERY_RETRY_DELAY_MS}ms | [background] ${document.visibilityState !== 'visible'}`);

  setTimeout(() => {
    if (!isKeepAliveActive || !silenceAudio) {
      console.log(`🔊 [AudioKeepAlive] 恢复定时器触发时状态已变 | [isKeepAliveActive] ${isKeepAliveActive} | [silenceAudio] ${!!silenceAudio}`);
      return;
    }
    console.log(`🔊 [AudioKeepAlive] 尝试恢复 silenceAudio.play() | [paused] ${silenceAudio.paused} | [ended] ${silenceAudio.ended} | [visibilityState] ${document.visibilityState}`);
    silenceAudio.play().then(() => {
      recoveryRetryCount = 0;
      console.log(`🔊 [AudioKeepAlive] 静音音频已恢复 ✅ | [paused] ${silenceAudio!.paused} | [loop] ${silenceAudio!.loop}`);
    }).catch((e) => {
      console.warn(`🔊 [AudioKeepAlive] 静音恢复失败 ${e?.name}: ${e?.message} | [visibilityState] ${document.visibilityState} | [剩余重试] ${MAX_RECOVERY_RETRIES - recoveryRetryCount}`);
    });
  }, RECOVERY_RETRY_DELAY_MS);
};

const handleSilenceEnded = (): void => {
  console.log(`🔊 [AudioKeepAlive] onended 触发 | [isKeepAliveActive] ${isKeepAliveActive} | [silenceAudio] ${!!silenceAudio} | [loop] ${silenceAudio?.loop} | [visibilityState] ${document.visibilityState}`);
  if (!isKeepAliveActive || !silenceAudio) {
    console.log(`🔊 [AudioKeepAlive] onended: 保活已关闭或无实例，跳过`);
    return;
  }
  if (silenceAudio.loop) {
    console.log(`🔊 [AudioKeepAlive] onended: loop=true 但 onended 被触发（异常），可能是 iOS 强制中断了循环`);
    // loop 模式下 onended 不应该触发，如果触发了说明 iOS 强制结束了循环播放，需要重新播放
    silenceAudio.play().catch((e) => {
      console.warn(`🔊 [AudioKeepAlive] onended 重新播放失败 ${e?.name}: ${e?.message}`);
    });
    return;
  }
  console.log('🔊 [AudioKeepAlive] 静音音频结束（非循环模式），重新播放');
  silenceAudio.play().catch((e) => {
    console.warn(`🔊 [AudioKeepAlive] onended 重新播放失败 ${e?.name}: ${e?.message}`);
  });
};

export const mediaSessionService = {
  holdAudioFocus(): void {
    const ios = isIOSAudio();
    console.log(`🔊 [AudioKeepAlive] holdAudioFocus | [iOS] ${ios} | [isHolding] ${isHolding} | [isKeepAliveActive] ${isKeepAliveActive} | [visibilityState] ${document.visibilityState}`);
    if (!ios) {
      console.log(`🔊 [AudioKeepAlive] holdAudioFocus: 非 iOS 跳过`);
      return;
    }
    if (isHolding) {
      console.log(`🔊 [AudioKeepAlive] holdAudioFocus: 已在持有，跳过`);
      return;
    }
    try {
      const audio = ensureSilenceAudio();
      console.log(`🔊 [AudioKeepAlive] holdAudioFocus: 播放 silenceAudio | [paused] ${audio.paused}`);
      audio.play().then(() => {
        isHolding = true;
        console.log(`🔊 [AudioKeepAlive] holdAudioFocus: silenceAudio.play() 成功 | [paused] ${audio.paused} | isHolding = true`);
      }).catch((e) => {
        isHolding = false;
        console.warn(`🔊 [AudioKeepAlive] holdAudioFocus: silenceAudio.play() 失败 ${e?.name}: ${e?.message} | isHolding = false`);
      });
    } catch (e) {
      console.warn(`🔊 [AudioKeepAlive] holdAudioFocus 异常:`, e);
    }
  },

  releaseAudioFocus(): void {
    console.log(`🔊 [AudioKeepAlive] releaseAudioFocus | [isHolding] ${isHolding} | [isKeepAliveActive] ${isKeepAliveActive}`);
    isHolding = false;
  },

  startSilenceKeepAlive(): void {
    const ios = isIOSAudio();
    console.log(`🔊 [AudioKeepAlive] startSilenceKeepAlive | [iOS] ${ios} | [isKeepAliveActive] ${isKeepAliveActive} | [isHolding] ${isHolding} | [visibilityState] ${document.visibilityState}`);
    if (!ios) {
      console.log(`🔊 [AudioKeepAlive] startSilenceKeepAlive: 非 iOS 跳过`);
      return;
    }
    if (isKeepAliveActive) {
      console.log(`🔊 [AudioKeepAlive] startSilenceKeepAlive: 保活已激活，跳过重复启动`);
      return;
    }
    try {
      recoveryRetryCount = 0;
      const audio = ensureSilenceAudio();
      audio.loop = true;
      audio.onpause = handleSilencePause;
      audio.onended = handleSilenceEnded;
      console.log(`🔊 [AudioKeepAlive] 准备播放 silenceAudio | [loop] ${audio.loop} | [paused] ${audio.paused} | [readyState] ${audio.readyState} | [networkState] ${audio.networkState}`);
      audio.play().then(() => {
        console.log(`🔊 [AudioKeepAlive] silenceAudio.play() 成功 | [paused] ${audio.paused} | [loop] ${audio.loop} | [currentTime] ${audio.currentTime.toFixed(2)}s`);
      }).catch((e) => {
        console.warn(`🔊 [AudioKeepAlive] silenceAudio.play() 失败 | ${e?.name}: ${e?.message} | [visibilityState] ${document.visibilityState} | 可能缺少用户交互`);
      });
      isHolding = true;
      isKeepAliveActive = true;

      // 监听音频会话中断（电话、闹钟等），中断结束后恢复保活
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', () => {
          console.log(`🔊 [AudioKeepAlive] MediaSession play action | [isKeepAliveActive] ${isKeepAliveActive} | [silenceAudio] ${!!silenceAudio} | [paused] ${silenceAudio?.paused}`);
          if (isKeepAliveActive && silenceAudio) {
            silenceAudio.play().then(() => {
              console.log(`🔊 [AudioKeepAlive] MediaSession play: silenceAudio 恢复成功`);
            }).catch((e) => {
              console.warn(`🔊 [AudioKeepAlive] MediaSession play: silenceAudio 恢复失败 ${e?.name}: ${e?.message}`);
            });
          }
        });
      }
      console.log(`🔊 [AudioKeepAlive] 静音保活已启动 ✅ | [isKeepAliveActive] ${isKeepAliveActive} | [isHolding] ${isHolding} | [loop] ${audio.loop}`);
    } catch (e) {
      console.warn(`🔊 [AudioKeepAlive] startSilenceKeepAlive 异常:`, e);
    }
  },

  stopSilenceKeepAlive(): void {
    console.log(`🔊 [AudioKeepAlive] stopSilenceKeepAlive | [isKeepAliveActive] ${isKeepAliveActive} | [isHolding] ${isHolding} | [recoveryRetryCount] ${recoveryRetryCount} | [visibilityState] ${document.visibilityState}`);
    isKeepAliveActive = false;
    recoveryRetryCount = 0;
    if (silenceAudio) {
      try {
        console.log(`🔊 [AudioKeepAlive] 清理 silenceAudio | [paused] ${silenceAudio.paused} | [loop] ${silenceAudio.loop} | [currentTime] ${silenceAudio.currentTime.toFixed(2)}s`);
        silenceAudio.onpause = null;
        silenceAudio.onended = null;
        silenceAudio.pause();
        console.log(`🔊 [AudioKeepAlive] silenceAudio 已暂停`);
      } catch (e) {
        console.warn(`🔊 [AudioKeepAlive] silenceAudio 清理异常:`, e);
      }
    }
    clearDelayAudio();
    console.log(`🔊 [AudioKeepAlive] 静音保活已停止 ✅`);
  },

  isKeepAliveActive(): boolean {
    return isKeepAliveActive;
  },

  stopAll(): void {
    console.log(`🔊 [AudioKeepAlive] stopAll | [isKeepAliveActive] ${isKeepAliveActive} | [isHolding] ${isHolding} | [recoveryRetryCount] ${recoveryRetryCount} | [hasMetadata] ${!!currentMetadataText}`);
    recoveryRetryCount = 0;
    if (silenceAudio) {
      console.log(`🔊 [AudioKeepAlive] stopAll: 清理 silenceAudio | [paused] ${silenceAudio.paused} | [loop] ${silenceAudio.loop}`);
      silenceAudio.onpause = null;
      silenceAudio.onended = null;
      silenceAudio.pause();
      silenceAudio.currentTime = 0;
    }
    clearDelayAudio();
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
    console.log(`🔊 [AudioKeepAlive] stopAll 完成 ✅`);
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
      console.log(`🔊 [AudioKeepAlive] updateMetadata | [title] "${text.slice(0, 30)}${text.length > 30 ? '...' : ''}"`);
    } catch (e) {
      console.warn(`🔊 [AudioKeepAlive] updateMetadata failed:`, e);
    }
  },

  setActionHandlers(handlers: { onPlay?: () => void; onPause?: () => void; onStop?: () => void; onPrevTrack?: () => void; onNextTrack?: () => void }): void {
    if (!('mediaSession' in navigator)) return;
    console.log(`🔊 [AudioKeepAlive] setActionHandlers | [hasPlay] ${!!handlers.onPlay} | [hasPause] ${!!handlers.onPause} | [hasStop] ${!!handlers.onStop} | [hasPrev] ${!!handlers.onPrevTrack} | [hasNext] ${!!handlers.onNextTrack}`);
    try {
      if (handlers.onPlay) navigator.mediaSession.setActionHandler('play', handlers.onPlay);
      if (handlers.onPause) navigator.mediaSession.setActionHandler('pause', handlers.onPause);
      if (handlers.onStop) navigator.mediaSession.setActionHandler('stop', handlers.onStop);
      if (handlers.onPrevTrack) navigator.mediaSession.setActionHandler('previoustrack', handlers.onPrevTrack);
      if (handlers.onNextTrack) navigator.mediaSession.setActionHandler('nexttrack', handlers.onNextTrack);
    } catch (e) {
      console.warn(`🔊 [AudioKeepAlive] setActionHandlers failed:`, e);
    }
  },

  isHoldingAudioFocus(): boolean {
    return isHolding;
  },

  getCurrentMetadataText(): string | null {
    return currentMetadataText;
  },

  waitForPlaybackGap(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (document.visibilityState === 'visible') {
      return new Promise<void>(resolve => {
        setTimeout(resolve, ms);
      });
    }
    return playBackgroundDelay(ms);
  },
};
