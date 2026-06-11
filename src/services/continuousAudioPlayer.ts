import { mediaSessionService } from './mediaSessionService';

const SILENCE_MP3_BASE64 = 'data:audio/mp3;base64,//OQxAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

const isIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

const IOS_PLAY_RETRIES = 3;
const IOS_PLAY_RETRY_DELAY = 200;
const PLAY_TIMEOUT = 120000;
const AUDIO_GAIN = 1.5;
const PAUSE_RECOVERY_RETRIES = 20;
const PAUSE_RECOVERY_DELAY_MS = 500;

class ContinuousAudioPlayer {
  private audio: HTMLAudioElement;
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private currentSource: MediaElementAudioSourceNode | null = null;
  private active: boolean = false;
  private generation: number = 0;
  private currentBlobUrl: string | null = null;
  private initialized: boolean = false;
  private recoveryRetryCount: number = 0;
  private visibilityHandler: (() => void) | null = null;
  private pendingPlayResolve: (() => void) | null = null;
  private resolving: boolean = false;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
  }

  isActivated(): boolean {
    return this.active;
  }

  async activate(): Promise<boolean> {
    if (this.active) {
      console.log('🔊 [连续播放器] 已在激活状态，跳过重复激活');
      return true;
    }

    const ios = isIOS();
    console.log(`🔊 [连续播放器] 开始激活 | [iOS] ${ios} | [已初始化] ${this.initialized} | [visibilityState] ${document.visibilityState}`);

    if (!this.initialized && ios) {
      this.initialized = true;
      console.log('🔊 [连续播放器] 首次激活，执行 iOS 原生解锁...');
      this.audio.src = SILENCE_MP3_BASE64;
      this.audio.volume = 0.01;
      try {
        await this.audio.play();
        this.audio.pause();
        this.audio.currentTime = 0;
        this.audio.volume = 1.0;
        this.audio.removeAttribute('src');
        this.audio.load();
        console.log('🔊 [连续播放器] iOS 原生解锁成功 ✅');
      } catch (e: any) {
        this.audio.volume = 1.0;
        this.audio.removeAttribute('src');
        console.warn(`🔊 [连续播放器] iOS 原生解锁失败 | [错误] ${e?.name}: ${e?.message}`);
      }
    }

    this.active = true;
    this.generation++;
    this.recoveryRetryCount = 0;
    console.log(`🔊 [连续播放器] 代数更新为 ${this.generation}`);

    this.setupMediaSession();

    if (ios) {
      const handleInterruption = () => {
        console.log(`🔊 [连续播放器] 中断恢复检查 | [active] ${this.active} | [paused] ${this.audio.paused} | [src] ${!!this.audio.src}`);
        if (this.active && !this.audio.paused) {
          this.audio.play().catch((e) => {
            console.warn(`🔊 [连续播放器] 中断恢复 play() 失败 | [错误] ${e?.name}: ${e?.message}`);
          });
        }
      };
      this.visibilityHandler = () => {
        console.log(`🔊 [连续播放器] visibilitychange | [新状态] ${document.visibilityState} | [active] ${this.active} | [paused] ${this.audio.paused}`);
        if (document.visibilityState === 'visible') {
          handleInterruption();
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      this.audio.onpause = this.handleAudioPause;
      console.log('🔊 [连续播放器] iOS: visibilitychange 监听器已注册 | onpause 处理器已绑定');
    }

    console.log(`🔊 [连续播放器] 已激活 ✅ | [代数] ${this.generation}`);
    return true;
  }

  deactivate(): void {
    console.log(`🔊 [连续播放器] 开始停用 | [代数] ${this.generation} | [active] ${this.active} | [recoveryRetryCount] ${this.recoveryRetryCount}`);
    this.generation++;
    this.active = false;
    this.recoveryRetryCount = 0;

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
      console.log('🔊 [连续播放器] visibilitychange 监听器已移除');
    }

    try {
      this.audio.onpause = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.oncanplay = null;
      this.audio.onloadeddata = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      console.log('🔊 [连续播放器] audio 元素已清理');
    } catch { /* ignore */ }

    this.revokeCurrentUrl();
    this.disconnectGain();
    console.log('🔊 [连续播放器] 已停用 ✅');
  }

  async playBlob(blob: Blob): Promise<void> {
    const ios = isIOS();
    if (!this.active) {
      throw new Error('播放器未激活');
    }

    const gen = this.generation;
    const isCurrentGen = () => gen === this.generation && this.active;

    console.log(`🔊 [连续播放器] playBlob 开始 | [iOS] ${ios} | [Blob大小] ${blob.size} | [Blob类型] ${blob.type} | [代数] ${gen}`);

    this.revokeCurrentUrl();

    if (!blob || blob.size === 0) {
      throw new Error('音频数据为空');
    }

    const url = URL.createObjectURL(blob);
    this.currentBlobUrl = url;
    console.log(`🔊 [连续播放器] Blob URL 已创建`);

    this.audio.src = url;
    console.log(`🔊 [连续播放器] audio.src 已设置 | [iOS] ${ios}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      let retryCount = 0;

      const doResolve = () => {
        if (settled) return;
        settled = true;
        this.pendingPlayResolve = null;
        console.log(`🔊 [连续播放器] doResolve | [代数] ${gen}`);
        // 设置 resolving 标志，防止 handleAudioPause 在 pause() 期间触发恢复
        this.resolving = true;
        // iOS: 先移除 onpause 防止 pause() 触发恢复逻辑
        if (isIOS()) {
          this.audio.onpause = null;
        }
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
        this.revokeCurrentUrl();
        this.resolving = false;
        resolve();
      };

      const doReject = (error: Error) => {
        if (settled) return;
        settled = true;
        this.pendingPlayResolve = null;
        console.warn(`🔊 [连续播放器] doReject | [代数] ${gen} | [错误] ${error.message}`);
        this.revokeCurrentUrl();
        reject(error);
      };

      this.pendingPlayResolve = () => doResolve();

      const attemptPlay = () => {
        if (!isCurrentGen() || settled) return;

        console.log(`🔊 [连续播放器] audio.play() 调用 | [iOS] ${ios} | [readyState] ${this.audio.readyState} | [paused] ${this.audio.paused}`);

        this.connectGain();

        this.audio.play().then(() => {
          console.log(`🔊 [连续播放器] audio.play() 成功`);
        }).catch((err: DOMException) => {
          if (!isCurrentGen() || settled) return;

          console.warn(`🔊 [连续播放器] audio.play() 失败 | [错误名] ${err.name} | [错误信息] ${err.message}`);

          if ((err.name === 'NotAllowedError' || err.name === 'AbortError') && ios && retryCount < IOS_PLAY_RETRIES) {
            retryCount++;
            console.warn(`🔊 [连续播放器] iOS 播放被阻止，第 ${retryCount}/${IOS_PLAY_RETRIES} 次重试...`);
            setTimeout(attemptPlay, IOS_PLAY_RETRY_DELAY * retryCount);
            return;
          }

          doReject(new Error(err.name === 'NotAllowedError' ? '播放被浏览器阻止' : (err.message || '播放失败')));
        });
      };

      this.audio.onended = () => {
        if (!isCurrentGen()) return;
        console.log(`🔊 [连续播放器] onended 触发 | [代数] ${gen}`);
        doResolve();
      };

      this.audio.onerror = () => {
        if (!isCurrentGen() || settled) return;
        const mediaError = this.audio.error;
        let errorMsg = '音频播放失败';
        if (mediaError) {
          switch (mediaError.code) {
            case MediaError.MEDIA_ERR_DECODE:
              errorMsg = '音频解码失败';
              break;
            case MediaError.MEDIA_ERR_NETWORK:
              errorMsg = '音频网络错误';
              break;
            case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
              errorMsg = '音频格式不支持';
              break;
          }
        }
        console.error(`🔊 [连续播放器] onerror 触发 | [错误码] ${mediaError?.code} | [Blob大小] ${blob.size} | [错误] ${errorMsg}`);
        doReject(new Error(errorMsg));
      };

      console.log(`🔊 [连续播放器] audio.load() 调用`);
      this.audio.load();

      // iOS: 不依赖 oncanplay 异步回调，直接短轮询 readyState 在用户手势延续中 play()
      const tryPlaySync = async () => {
        if (!isCurrentGen() || settled) return;

        console.log(`🔊 [连续播放器] tryPlaySync 开始 | [readyState] ${this.audio.readyState} | [networkState] ${this.audio.networkState}`);

        if (this.audio.readyState >= 2) {
          console.log(`🔊 [连续播放器] readyState 已就绪，直接播放`);
          attemptPlay();
          return;
        }

        // 短轮询，最多等 500ms，确保在 iOS 手势窗口内
        const maxWait = 500;
        const pollInterval = 50;
        let waited = 0;
        let lastReadyState = this.audio.readyState;
        await new Promise<void>(r => {
          const poll = () => {
            if (!isCurrentGen() || settled) { 
              console.log(`🔊 [连续播放器] tryPlaySync 轮询提前终止 | [代数过期] ${!isCurrentGen()} | [settled] ${settled}`);
              r(); 
              return; 
            }
            if (this.audio.readyState >= 2 || waited >= maxWait) {
              console.log(`🔊 [连续播放器] tryPlaySync 轮询结束 | [readyState] ${this.audio.readyState} | [等待耗时] ${waited}ms | [reason] ${this.audio.readyState >= 2 ? '就绪' : '超时'}`);
              r();
              return;
            }
            if (this.audio.readyState !== lastReadyState) {
              console.log(`🔊 [连续播放器] tryPlaySync readyState 变化 | [${lastReadyState}] → [${this.audio.readyState}] | [已等待] ${waited}ms`);
              lastReadyState = this.audio.readyState;
            }
            waited += pollInterval;
            setTimeout(poll, pollInterval);
          };
          poll();
        });

        if (!isCurrentGen() || settled) return;
        console.log(`🔊 [连续播放器] tryPlaySync 完成，调用 attemptPlay | [readyState] ${this.audio.readyState} | [networkState] ${this.audio.networkState}`);
        attemptPlay();
      };
      tryPlaySync();

      setTimeout(() => {
        if (!settled && isCurrentGen()) {
          console.warn(`🔊 [连续播放器] 播放超时 | [超时] ${PLAY_TIMEOUT}ms | [readyState] ${this.audio.readyState}`);
          doReject(new Error('音频播放超时'));
        }
      }, PLAY_TIMEOUT);
    });
  }

  stop(): void {
    console.log(`🔊 [连续播放器] stop() 调用 | [active] ${this.active} | [代数] ${this.generation} | [recoveryRetryCount] ${this.recoveryRetryCount}`);
    this.recoveryRetryCount = 0;
    this.generation++;
    try {
      this.audio.onpause = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch { /* ignore */ }
    this.revokeCurrentUrl();
    this.disconnectGain();
    console.log('🔊 [连续播放器] stop() 完成');
  }

  getAudioElement(): HTMLAudioElement {
    return this.audio;
  }

  resumeAudioFocus(): void {
    console.log(`🔊 [连续播放器] resumeAudioFocus | [active] ${this.active} | [paused] ${this.audio.paused} | [src] ${!!this.audio.src} | [visibilityState] ${document.visibilityState}`);
    if (!this.active) return;
    if (this.audio.paused && this.audio.src) {
      this.audio.play().then(() => {
        console.log('🔊 [连续播放器] resumeAudioFocus play() 成功');
      }).catch((e) => {
        console.warn(`🔊 [连续播放器] resumeAudioFocus play() 失败 | [错误] ${e?.name}: ${e?.message}`);
      });
    }
  }

  primeAudioChannelWithSilence(): void {
    console.log(`🔊 [连续播放器] primeAudioChannelWithSilence | [active] ${this.active} | [src] ${!!this.audio.src}`);
    if (!this.active) return;

    // 先显式 resolve 任何 pending 的 playBlob Promise，避免因 onended 被清除导致悬挂
    if (this.pendingPlayResolve) {
      console.log('🔊 [连续播放器] 清理 pending playBlob Promise');
      this.pendingPlayResolve();
    }

    this.generation++;
    this.recoveryRetryCount = 0;

    try {
      this.audio.onpause = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.oncanplay = null;
      this.audio.onloadeddata = null;
      this.audio.pause();
      this.revokeCurrentUrl();
      this.audio.removeAttribute('src');
      this.audio.loop = true;
      this.audio.src = SILENCE_MP3_BASE64;
      this.audio.load();
      this.audio.onpause = this.handleAudioPause;
      this.audio.play().then(() => {
        console.log('🔊 [连续播放器] 静音接力已启动 ✅');
      }).catch((e) => {
        console.warn(`🔊 [连续播放器] 静音接力启动失败 | [错误] ${e?.name}: ${e?.message}`);
      });
    } catch (e) {
      console.warn('🔊 [连续播放器] primeAudioChannelWithSilence 异常:', e);
    }
  }

  private handleAudioPause = (): void => {
    console.log(`🔊 [连续播放器] onpause 触发 | [active] ${this.active} | [src] ${!!this.audio.src} | [ended] ${this.audio.ended} | [resolving] ${this.resolving} | [recoveryRetryCount] ${this.recoveryRetryCount} | [visibilityState] ${document.visibilityState}`);
    if (!this.active) return;
    // 如果 doResolve 正在清理，不恢复 — 这是正常结束而非意外中断
    if (this.resolving) {
      console.log('🔊 [连续播放器] onpause: doResolve 正在处理，跳过恢复');
      return;
    }
    if (!this.audio.src) {
      console.log('🔊 [连续播放器] onpause: 无 src，跳过恢复');
      return;
    }
    if (this.audio.ended) {
      console.log('🔊 [连续播放器] onpause: 音频已结束，跳过恢复');
      return;
    }

    if (this.recoveryRetryCount >= PAUSE_RECOVERY_RETRIES) {
      console.warn('🔊 [连续播放器] 恢复重试次数耗尽，放弃当前播放');
      return;
    }

    // 记录被暂停时的播放位置，用于判断是否已接近末尾
    const currentTime = this.audio.currentTime;
    const duration = this.audio.duration;

    // 如果音频已播到末尾 0.3 秒内，说明是自然结束前的暂停，不恢复
    if (duration && currentTime > duration - 0.3) {
      console.log('🔊 [连续播放器] 音频已接近末尾（剩余<0.3s），跳过恢复');
      return;
    }

    this.recoveryRetryCount++;
    // 渐进式延迟：后台模式下用更长的间隔
    const isBackground = document.visibilityState === 'hidden';
    const delay = isBackground
      ? PAUSE_RECOVERY_DELAY_MS * Math.min(this.recoveryRetryCount, 4)  // 后台最多 2 秒间隔
      : PAUSE_RECOVERY_DELAY_MS;
    console.log(`🔊 [连续播放器] 句子音频被中断（${currentTime.toFixed(1)}s / ${duration ? duration.toFixed(1) + 's' : '未知'}），第 ${this.recoveryRetryCount}/${PAUSE_RECOVERY_RETRIES} 次尝试恢复... [后台:${isBackground}] [延迟:${delay}ms]`);

    setTimeout(() => {
      if (!this.active || !this.audio.src) {
        console.log(`🔊 [连续播放器] 恢复重试时状态已变 | [active] ${this.active} | [src] ${!!this.audio.src}`);
        return;
      }
      // 二次检查：音频可能已在等待期间自然结束
      if (this.audio.ended) {
        console.log('🔊 [连续播放器] 音频已自然结束，无需恢复');
        return;
      }
      console.log(`🔊 [连续播放器] 尝试恢复播放 | [currentTime] ${this.audio.currentTime.toFixed(1)}s | [readyState] ${this.audio.readyState} | [paused] ${this.audio.paused}`);
      this.audio.play().then(() => {
        this.recoveryRetryCount = 0;
        console.log('🔊 [连续播放器] 句子音频已恢复 ✅');
      }).catch((e) => {
        console.warn(`🔊 [连续播放器] 句子恢复失败 | [错误] ${e?.name}: ${e?.message} | [后台] ${isBackground} | [剩余重试] ${PAUSE_RECOVERY_RETRIES - this.recoveryRetryCount}`);
        // 后台模式下即使 play() 失败也继续重试，但加入强制冷却延迟防止快速耗尽
        if (isBackground && this.active && this.audio.src) {
          setTimeout(() => {
            this.handleAudioPause();
          }, PAUSE_RECOVERY_DELAY_MS);
        }
      });
    }, delay);
  };

  private setupMediaSession(): void {
    console.log('🔊 [连续播放器] 注册 MediaSession 操作处理器');
    mediaSessionService.setActionHandlers({
      onPause: () => {
        console.log('🔊 [连续播放器] MediaSession: 用户点击暂停');
        this.audio.pause();
      },
      onPlay: () => {
        console.log(`🔊 [连续播放器] MediaSession: 用户点击播放 | [active] ${this.active} | [src] ${!!this.audio.src}`);
        if (this.active && this.audio.src) {
          this.audio.play().catch((e) => {
            console.warn(`🔊 [连续播放器] MediaSession play() 失败 | [错误] ${e?.name}: ${e?.message}`);
          });
        }
      },
      onStop: () => {
        console.log('🔊 [连续播放器] MediaSession: 用户点击停止');
        this.stop();
      },
    });
  }

  private connectGain(): void {
    if (isIOS()) return;

    if (this.audioContext) {
      if (this.audioContext.state === 'suspended') {
        console.log('🔊 [连续播放器] AudioContext 处于 suspended，尝试 resume...');
        this.audioContext.resume();
      } else if (this.audioContext.state === 'closed') {
        console.log('🔊 [连续播放器] AudioContext 已关闭，重新创建');
        this.audioContext = null;
        this.gainNode = null;
        this.currentSource = null;
      }
    }

    if (this.currentSource) return;

    try {
      if (!this.audioContext) {
        console.log('🔊 [连续播放器] 创建 AudioContext + GainNode');
        this.audioContext = new AudioContext();
        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = AUDIO_GAIN;
        this.gainNode.connect(this.audioContext.destination);
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }
      this.currentSource = this.audioContext.createMediaElementSource(this.audio);
      this.currentSource.connect(this.gainNode!);
      console.log('🔊 [连续播放器] Web Audio 增益已连接');
    } catch (e) {
      console.warn('🔊 [连续播放器] Web Audio 增益连接失败，使用原始音量:', e);
    }
  }

  private disconnectGain(): void {
    if (this.currentSource) {
      try { this.currentSource.disconnect(); } catch { /* ignore */ }
      this.currentSource = null;
      console.log('🔊 [连续播放器] Web Audio 增益已断开');
    }
  }

  private revokeCurrentUrl(): void {
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl); } catch { /* ignore */ }
      console.log('🔊 [连续播放器] Blob URL 已回收');
      this.currentBlobUrl = null;
    }
  }
}

export const continuousAudioPlayer = new ContinuousAudioPlayer();
