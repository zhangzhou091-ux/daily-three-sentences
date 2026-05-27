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

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
  }

  isActivated(): boolean {
    return this.active;
  }

  activate(): boolean {
    if (this.active) return true;

    if (!this.initialized && isIOS()) {
      this.initialized = true;
      const unlockSrc = this.audio.src;
      this.audio.src = SILENCE_MP3_BASE64;
      this.audio.volume = 0.01;
      this.audio.play().then(() => {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.audio.volume = 1.0;
        this.audio.removeAttribute('src');
        this.audio.load();
      }).catch(() => {
        this.audio.volume = 1.0;
        this.audio.removeAttribute('src');
      });
    }

    this.active = true;
    this.generation++;
    this.recoveryRetryCount = 0;

    this.setupMediaSession();

    if (isIOS()) {
      const handleInterruption = () => {
        if (this.active && !this.audio.paused) {
          this.audio.play().catch(() => {});
        }
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          handleInterruption();
        }
      });
      this.audio.onpause = this.handleAudioPause;
    }

    console.log('🔊 [连续播放器] 已激活');
    return true;
  }

  deactivate(): void {
    this.generation++;
    this.active = false;
    this.recoveryRetryCount = 0;

    try {
      this.audio.onpause = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.oncanplay = null;
      this.audio.onloadeddata = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch { /* ignore */ }

    this.revokeCurrentUrl();
    this.disconnectGain();
    console.log('🔊 [连续播放器] 已停用');
  }

  async playBlob(blob: Blob): Promise<void> {
    if (!this.active) {
      throw new Error('播放器未激活');
    }

    const gen = this.generation;
    const isCurrentGen = () => gen === this.generation && this.active;

    this.revokeCurrentUrl();

    if (!blob || blob.size === 0) {
      throw new Error('音频数据为空');
    }

    const mimeType = blob.type || 'audio/mpeg';
    const url = URL.createObjectURL(new Blob([blob], { type: mimeType }));
    this.currentBlobUrl = url;

    this.audio.src = url;

    return new Promise((resolve, reject) => {
      let settled = false;
      let retryCount = 0;

      const doResolve = () => {
        if (settled) return;
        settled = true;
        this.revokeCurrentUrl();
        resolve();
      };

      const doReject = (error: Error) => {
        if (settled) return;
        settled = true;
        this.revokeCurrentUrl();
        reject(error);
      };

      const attemptPlay = () => {
        if (!isCurrentGen() || settled) return;

        this.connectGain();

        this.audio.play().catch((err: DOMException) => {
          if (!isCurrentGen() || settled) return;

          if ((err.name === 'NotAllowedError' || err.name === 'AbortError') && isIOS() && retryCount < IOS_PLAY_RETRIES) {
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
        doReject(new Error(errorMsg));
      };

      this.audio.oncanplay = () => {
        if (!isCurrentGen() || settled) return;
        attemptPlay();
      };

      this.audio.onloadeddata = () => {
        if (!isCurrentGen() || settled) return;
        if (isIOS()) {
          setTimeout(() => {
            if (!isCurrentGen() || settled) return;
            if (this.audio.readyState >= 3) {
              attemptPlay();
            }
          }, 100);
        }
      };

      if (isIOS()) {
        setTimeout(() => {
          if (!isCurrentGen() || settled) return;
          if (this.audio.readyState >= 3) {
            attemptPlay();
          } else {
            this.audio.load();
          }
        }, 50);
      } else {
        this.audio.load();
      }

      setTimeout(() => {
        if (!settled && isCurrentGen()) {
          doReject(new Error('音频播放超时'));
        }
      }, PLAY_TIMEOUT);
    });
  }

  stop(): void {
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
  }

  getAudioElement(): HTMLAudioElement {
    return this.audio;
  }

  resumeAudioFocus(): void {
    if (!this.active) return;
    if (this.audio.paused && this.audio.src) {
      this.audio.play().catch(() => {});
    }
  }

  private handleAudioPause = (): void => {
    if (!this.active) return;
    if (!this.audio.src) return;

    if (this.recoveryRetryCount >= PAUSE_RECOVERY_RETRIES) {
      console.warn('🔊 [连续播放器] 恢复重试次数耗尽，放弃当前播放');
      return;
    }

    this.recoveryRetryCount++;
    console.log(`🔊 [连续播放器] 句子音频被中断，第 ${this.recoveryRetryCount}/${PAUSE_RECOVERY_RETRIES} 次尝试恢复...`);

    setTimeout(() => {
      if (!this.active || !this.audio.src) return;
      this.audio.play().then(() => {
        this.recoveryRetryCount = 0;
        console.log('🔊 [连续播放器] 句子音频已恢复');
      }).catch((e) => {
        console.warn('🔊 [连续播放器] 句子恢复失败:', e);
      });
    }, PAUSE_RECOVERY_DELAY_MS);
  };

  private setupMediaSession(): void {
    mediaSessionService.setActionHandlers({
      onPause: () => {
        this.audio.pause();
      },
      onPlay: () => {
        if (this.active && this.audio.src) {
          this.audio.play().catch(() => {});
        }
      },
      onStop: () => {
        this.stop();
      },
    });
  }

  private connectGain(): void {
    if (isIOS()) return;
    if (this.currentSource) return;
    try {
      if (!this.audioContext || this.audioContext.state === 'closed') {
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
    } catch (e) {
      console.warn('🔊 [连续播放器] Web Audio 增益连接失败，使用原始音量:', e);
    }
  }

  private disconnectGain(): void {
    if (this.currentSource) {
      try { this.currentSource.disconnect(); } catch { /* ignore */ }
      this.currentSource = null;
    }
  }

  private revokeCurrentUrl(): void {
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl); } catch { /* ignore */ }
      this.currentBlobUrl = null;
    }
  }
}

export const continuousAudioPlayer = new ContinuousAudioPlayer();