import { mediaSessionService, createSilenceWavBlob } from './mediaSessionService';
import { unlockAudioEngine } from './audioUnlockService';

const isIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

const IOS_PLAY_RETRIES = 3;
const IOS_PLAY_RETRY_DELAY = 200;
const PLAY_TIMEOUT = 120000;
const AUDIO_GAIN = 1.0;
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
  private primeInProgress: boolean = false;
  private transitionInProgress: boolean = false;
  private freezeHandler: (() => void) | null = null;
  private resumeHandler: (() => void) | null = null;
  private wasActiveBeforeFreeze: boolean = false;

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
      console.log('🔊 [连续播放器] 首次激活，调用 unlockAudioEngine 解锁 iOS 音频引擎...');
      // 使用独立的解锁服务：解锁在临时 Audio 元素上进行，绝不触碰 this.audio（主播放元素）
      // 之前内联解锁在 this.audio 上 play() → .then() 异步 pause()/removeAttribute('src')/load()，
      // 会与随后的 primeAudioChannelWithSilence / playBlob 产生竞态：
      //   1. removeAttribute('src') 覆盖 playBlob 刚设置的 blobUrl → 播放失败（发音按钮需点 2 次）
      //   2. pause() 触发 handleAudioPause 误恢复机制 → 500ms × 多次重试累加（首句 5 遍中的长暂停）
      // 改用独立元素解锁后，this.audio 始终保持干净状态，彻底消除两类竞态。
      // unlockAudioEngine 是幂等的，已在页面首次点击时被调用过，重复调用无副作用。
      try {
        unlockAudioEngine().then((ok: boolean) => {
          console.log(`🔊 [连续播放器] unlockAudioEngine 完成 | [成功] ${ok}`);
        }).catch((e: any) => {
          console.warn(`🔊 [连续播放器] unlockAudioEngine 异常 | [错误] ${e?.name}: ${e?.message}`);
        });
      } catch (e: any) {
        console.warn(`🔊 [连续播放器] unlockAudioEngine 调用异常 | [错误] ${e?.message}`);
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

    // Page Lifecycle API: freeze/resume 事件（iOS Safari 页面冻结/解冻）
    if ('onfreeze' in document || 'onresume' in document) {
      const handleFreeze = () => {
        this.wasActiveBeforeFreeze = this.active;
        console.log(`🔊 [连续播放器] 页面冻结 | [active] ${this.active} | [paused] ${this.audio.paused}`);
      };
      const handleResume = () => {
        console.log(`🔊 [连续播放器] 页面解冻 | [active] ${this.active} | [wasActiveBeforeFreeze] ${this.wasActiveBeforeFreeze} | [paused] ${this.audio.paused}`);
        if (this.active && this.wasActiveBeforeFreeze) {
          // 恢复音频上下文
          if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume().catch(() => {});
          }
          // 如果主音频有 src 且处于暂停状态，尝试恢复
          if (this.audio.src && !this.audio.ended) {
            this.audio.play().then(() => {
              console.log('🔊 [连续播放器] 解冻后恢复播放成功 ✅');
            }).catch((e) => {
              console.warn(`🔊 [连续播放器] 解冻后恢复播放失败 | [错误] ${e?.name}: ${e?.message}`);
            });
          }
        }
        this.wasActiveBeforeFreeze = false;
      };
      this.freezeHandler = handleFreeze;
      this.resumeHandler = handleResume;
      document.addEventListener('freeze', handleFreeze);
      document.addEventListener('resume', handleResume);
      console.log('🔊 [连续播放器] freeze/resume 监听器已注册');
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

    if (this.freezeHandler) {
      document.removeEventListener('freeze', this.freezeHandler);
      this.freezeHandler = null;
    }
    if (this.resumeHandler) {
      document.removeEventListener('resume', this.resumeHandler);
      this.resumeHandler = null;
    }
    this.wasActiveBeforeFreeze = false;
    this.transitionInProgress = false;

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

    // 恢复音量到 1.0：primeAudioChannelWithSilence 循环静音时会把 volume 压到 0.01，
    // 这里在播放真句子前恢复，确保正式播放音量正常
    this.audio.volume = 1.0;

    // 递增 generation，使之前 handleAudioPause 中遗留的 setTimeout 回调失效
    this.generation++;
    // 每次新播放重置恢复重试计数，防止跨句子累积耗尽
    this.recoveryRetryCount = 0;

    const gen = this.generation;
    const isCurrentGen = () => gen === this.generation && this.active;

    console.log(`🔊 [连续播放器] playBlob 开始 | [iOS] ${ios} | [Blob大小] ${blob.size} | [Blob类型] ${blob.type} | [代数] ${gen} | [generation] ${this.generation} | [recoveryRetryCount] ${this.recoveryRetryCount}`);

    this.revokeCurrentUrl();

    // 如果静音接力正在进行，先清理 loop 状态避免与正式播放冲突
    if (this.primeInProgress) {
      this.primeInProgress = false;
      console.log('🔊 [连续播放器] 检测到静音接力标记，清理 loop 状态');
      try {
        this.audio.loop = false;
        this.audio.onpause = null;
        this.audio.onended = null;
        this.audio.onerror = null;
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
      } catch { /* ignore */ }
    }

    if (!blob || blob.size === 0) {
      throw new Error('音频数据为空');
    }

    const url = URL.createObjectURL(blob);
    this.currentBlobUrl = url;
    console.log(`🔊 [连续播放器] Blob URL 已创建`);

    this.audio.src = url;
    console.log(`🔊 [连续播放器] audio.src 已设置 | [iOS] ${ios}`);

    // 每次 playBlob 都重新绑定 onpause，因为在 doResolve/stopLight 中可能被移除
    this.audio.onpause = this.handleAudioPause;

    return new Promise((resolve, reject) => {
      let settled = false;
      let retryCount = 0;

      const doResolve = () => {
        if (settled) return;
        settled = true;
        this.pendingPlayResolve = null;
        console.log(`🔊 [连续播放器] doResolve | [代数] ${gen}`);
        resolve();
      };

      const doReject = (error: Error) => {
        if (settled) return;
        settled = true;
        this.pendingPlayResolve = null;
        console.warn(`🔊 [连续播放器] doReject | [代数] ${gen} | [错误] ${error.message}`);
        // 使用闭包捕获的 url 而非 this.currentBlobUrl，防止旧 Promise 的定时器/回调
        // 在下一轮 playBlob 之后才触发，错误地吊销了新 play 的 Blob URL
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
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
        // 音频已自然结束，不调用 pause()/currentTime=0 避免 iOS 末端瞬态杂音
        // 只解绑 onpause 防止 handleAudioPause 误恢复
        try {
          this.audio.onpause = null;
        } catch { /* ignore */ }
        this.revokeCurrentUrl();
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

  // 轻量停止：不递增 generation，用于超时等需要清理但保留当前代数场景
  stopLight(): void {
    console.log(`🔊 [连续播放器] stopLight() 调用 | [active] ${this.active} | [代数] ${this.generation}`);
    this.primeInProgress = false;
    try {
      this.audio.onpause = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch { /* ignore */ }
    this.revokeCurrentUrl();
    console.log('🔊 [连续播放器] stopLight() 完成');
  }

  getAudioElement(): HTMLAudioElement {
    return this.audio;
  }

  // 句子切换期间暂停恢复，防止 handleAudioPause 误触发
  beginTransition(): void {
    this.transitionInProgress = true;
    console.log('🔊 [连续播放器] 句子切换开始，暂停恢复已抑制');
  }

  endTransition(): void {
    this.transitionInProgress = false;
    console.log('🔊 [连续播放器] 句子切换结束，暂停恢复已恢复');
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

  async primeAudioChannelWithSilence(): Promise<void> {
    console.log(`🔊 [连续播放器] primeAudioChannelWithSilence | [active] ${this.active} | [src] ${!!this.audio.src}`);

    // 先显式 resolve 任何 pending 的 playBlob Promise，避免因 onended 被清除导致悬挂
    if (this.pendingPlayResolve) {
      console.log('🔊 [连续播放器] 清理 pending playBlob Promise');
      this.pendingPlayResolve();
    }

    this.generation++;
    this.recoveryRetryCount = 0;
    this.primeInProgress = true;

    try {
      this.audio.onpause = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.oncanplay = null;
      this.audio.onloadeddata = null;
      this.audio.pause();
      this.audio.currentTime = 0;
      this.revokeCurrentUrl();
      this.audio.removeAttribute('src');
      this.audio.loop = true;
      // 硬件释放等待：iOS audio session 从"播放句子"切到"播放静音"时，
      // 若不等待硬件状态归零就切 src，可能在切换瞬间产生瞬态杂音（click/pop）。
      // 80ms 是经验值，足够让 iOS 完成硬件状态切换，又不明显影响句间延迟体感。
      await new Promise(r => setTimeout(r, 80));
      // 使用 WAV 静音替代 MP3：MP3 有编码器延迟/尾部 padding，loop=true 时每个循环
      // 边界都会产生瞬态 discontinuity（"哒"的点击声），WAV 无此问题，循环无缝。
      const silenceBlob = createSilenceWavBlob(1000);
      const url = URL.createObjectURL(silenceBlob);
      this.currentBlobUrl = url;
      this.audio.src = url;
      // 循环静音期间压低音量到 0.01，避免静音 WAV 启动瞬间的残余噪声 bleed 到断句位置
      this.audio.volume = 0.01;
      this.audio.load();
      this.audio.onpause = this.handleAudioPause;
      this.audio.play().then(() => {
        console.log('🔊 [连续播放器] 静音接力已启动 ✅ | [WAV] [volume=0.01] | [硬件释放等待] 80ms');
      }).catch((e) => {
        console.warn(`🔊 [连续播放器] 静音接力启动失败 | [错误] ${e?.name}: ${e?.message}`);
        this.primeInProgress = false;
        // 失败时恢复音量，避免影响下次 playBlob
        this.audio.volume = 1.0;
      });
    } catch (e) {
      console.warn('🔊 [连续播放器] primeAudioChannelWithSilence 异常:', e);
      this.primeInProgress = false;
      this.audio.volume = 1.0;
    }
  }

  private handleAudioPause = (): void => {
    const genAtPause = this.generation;
    console.log(`🔊 [连续播放器] onpause 触发 | [gen] ${genAtPause} | [active] ${this.active} | [src] ${!!this.audio.src} | [ended] ${this.audio.ended} | [transition] ${this.transitionInProgress} | [recoveryRetryCount] ${this.recoveryRetryCount} | [visibilityState] ${document.visibilityState}`);
    if (!this.active) return;
    // 句子切换期间暂停恢复，避免与新的播放操作竞争
    if (this.transitionInProgress) {
      console.log('🔊 [连续播放器] onpause: 句子切换中，跳过恢复');
      return;
    }
    if (!this.audio.src) {
      console.log('🔊 [连续播放器] onpause: 无 src，跳过恢复');
      return;
    }
    if (this.audio.ended) {
      console.log('🔊 [连续播放器] onpause: 音频已结束，跳过恢复');
      // 音频已自然结束，只解绑 onpause 防止循环触发，不调用 pause()/currentTime=0 避免 iOS 瞬态杂音
      try {
        this.audio.onpause = null;
      } catch { /* ignore */ }
      // iOS: onended 可能不触发，onpause 检测到 ended 时兜底 resolve
      if (this.pendingPlayResolve) {
        this.pendingPlayResolve();
      }
      return;
    }

    if (this.recoveryRetryCount >= PAUSE_RECOVERY_RETRIES) {
      console.warn('🔊 [连续播放器] 恢复重试次数耗尽，放弃当前播放');
      return;
    }

    // 记录被暂停时的播放位置，用于判断是否已接近末尾
    const currentTime = this.audio.currentTime;
    const duration = this.audio.duration;

    // 如果音频已播到末尾 0.5 秒内，说明是自然结束前的暂停，不恢复。
    // 阈值从 0.3s 放宽到 0.5s：更早跳过恢复，减少末尾瞬态。
    if (duration && Number.isFinite(duration) && currentTime > duration - 0.5) {
      console.log(`🔊 [连续播放器] 音频已接近末尾（剩余<0.5s），跳过恢复 | [当前] ${currentTime.toFixed(2)}s [时长] ${duration.toFixed(2)}s`);
      return;
    }

    // iOS 兜底：Blob URL 的 duration 经常是 NaN/Infinity（iOS Safari 已知行为），
    // 此时上面的 duration 保护失效。如果 currentTime 已超过 0.5s，
    // 保守判断为"自然结束前的暂停"（iOS 正常播放中极少无故暂停，大概率是即将结束），
    // 跳过恢复避免末尾瞬态 play() 产生杂音。
    // 第一句特殊：iOS 首次解析 Blob URL 时 duration 元数据可能尚未就绪（NaN），
    // 这里是第一句杂音的主要来源。
    if (isIOS() && (!duration || !Number.isFinite(duration)) && currentTime > 0.5) {
      console.log(`🔊 [连续播放器] iOS: duration 不可靠 (${duration}) 且 currentTime=${currentTime.toFixed(2)}s > 0.5s，判定为接近末尾，跳过恢复`);
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
      // 如果在此期间新的 playBlob 已开始（generation 已递增），放弃旧的回调
      if (genAtPause !== this.generation) {
        console.log(`🔊 [连续播放器] 恢复回调: 代数已过期 (${genAtPause} → ${this.generation})，跳过恢复`);
        return;
      }
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
