const SILENCE_MP3_BASE64 = 'data:audio/mp3;base64,//OQxAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

const isIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

const IOS_PLAY_RETRIES = 3;
const IOS_PLAY_RETRY_DELAY = 200;
const PLAY_TIMEOUT = 60000;

class ContinuousAudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private active: boolean = false;
  private generation: number = 0;
  private currentBlobUrl: string | null = null;

  isActivated(): boolean {
    return this.active;
  }

  activate(): boolean {
    if (this.active) return true;

    this.active = true;
    this.generation++;

    this.audio = new Audio();
    this.audio.preload = 'auto';

    if (isIOS() && this.audio) {
      const unlockAudio = this.audio;
      unlockAudio.src = SILENCE_MP3_BASE64;
      unlockAudio.volume = 0.01;
      unlockAudio.play().then(() => {
        unlockAudio.pause();
        unlockAudio.currentTime = 0;
        unlockAudio.volume = 1.0;
        unlockAudio.removeAttribute('src');
        unlockAudio.load();
      }).catch(() => {});
    }

    console.log('🔊 [连续播放器] 已激活');
    return true;
  }

  deactivate(): void {
    this.generation++;
    this.active = false;

    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.onended = null;
        this.audio.onerror = null;
        this.audio.oncanplay = null;
        this.audio.onloadeddata = null;
        this.audio.removeAttribute('src');
        this.audio.load();
      } catch { /* ignore */ }
      this.audio = null;
    }

    this.revokeCurrentUrl();
    console.log('🔊 [连续播放器] 已停用');
  }

  async playBlob(blob: Blob): Promise<void> {
    if (!this.active || !this.audio) {
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

    const audio = this.audio;
    audio.src = url;

    return new Promise((resolve, reject) => {
      let settled = false;
      let retryCount = 0;

      const doResolve = () => {
        if (settled) return;
        settled = true;
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

        audio.play().catch((err: DOMException) => {
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

      audio.onended = () => {
        if (!isCurrentGen()) return;
        this.revokeCurrentUrl();
        doResolve();
      };

      audio.onerror = () => {
        if (!isCurrentGen() || settled) return;
        const mediaError = audio.error;
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

      audio.oncanplay = () => {
        if (!isCurrentGen() || settled) return;
        attemptPlay();
      };

      audio.onloadeddata = () => {
        if (!isCurrentGen() || settled) return;
        if (isIOS()) {
          setTimeout(() => {
            if (!isCurrentGen() || settled) return;
            if (audio.readyState >= 3) {
              attemptPlay();
            }
          }, 100);
        }
      };

      if (isIOS()) {
        setTimeout(() => {
          if (!isCurrentGen() || settled) return;
          if (audio.readyState >= 3) {
            attemptPlay();
          } else {
            audio.load();
          }
        }, 50);
      } else {
        audio.load();
      }

      setTimeout(() => {
        if (!settled && isCurrentGen()) {
          doReject(new Error('音频播放超时'));
        }
      }, PLAY_TIMEOUT);
    });
  }

  stop(): void {
    this.generation++;
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
      } catch { /* ignore */ }
    }
    this.revokeCurrentUrl();
  }

  getAudioElement(): HTMLAudioElement | null {
    return this.audio;
  }

  private revokeCurrentUrl(): void {
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl); } catch { /* ignore */ }
      this.currentBlobUrl = null;
    }
  }
}

export const continuousAudioPlayer = new ContinuousAudioPlayer();
