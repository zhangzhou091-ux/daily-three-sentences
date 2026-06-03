/**
 * ElevenLabs TTS Service
 *
 * 特点：
 * - 高质量自然语音，接近真人发音
 * - 需要API密钥（免费套餐每月有配额）
 * - 前端直接调用REST API，无需后端
 * - 自动降级：API调用失败时回退到其他引擎
 * - 音频缓存：相同文本+语音只调用一次API，后续从本地缓存播放
 *
 * iOS Safari 兼容性：
 * - iOS 要求音频播放必须由用户手势触发
 * - 使用 Audio 元素 + Blob URL 播放，兼容 iOS Safari
 * - 增加 iOS 专用延迟和重试机制
 * - 网络状态检测增强：navigator.onLine + 实际连通性检测
 *
 * API文档：https://elevenlabs.io/docs/eleven-api/quickstart
 */

import { elevenLabsCacheService } from './elevenLabsCacheService';
import { ttsCloudCacheService } from './ttsCloudCacheService';

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

export interface SpeakResult {
  success: boolean;
  error?: string;
  fromCache?: boolean;
}

export type NetworkQuality = 'good' | 'medium' | 'weak' | 'offline' | 'unknown';

interface NetworkQualitySnapshot {
  quality: NetworkQuality;
  latency: number;
  timestamp: number;
}

interface PendingSpeakRequest {
  text: string;
  apiKey: string;
  voiceId: string;
  loop: boolean;
  modelId: string;
  rate: number;
  resolve: (result: SpeakResult) => void;
}

const API_BASE = 'https://api.elevenlabs.io';
const DEFAULT_MODEL = 'eleven_v3';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
const BASE_SPEAK_TIMEOUT = 20000;
const VOICES_CACHE_TTL = 30 * 60 * 1000;
const VALIDATE_TIMEOUT = 15000;
const VALIDATE_CACHE_TTL = 5 * 60 * 1000;
const API_KEY_PATTERN = /^sk_[a-f0-9]{40,}$/i;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const IOS_PLAYBACK_RETRIES = 3;
const IOS_PLAYBACK_DELAY = 200;
const WEAK_NETWORK_LATENCY_THRESHOLD = 2000;
const MEDIUM_NETWORK_LATENCY_THRESHOLD = 800;
const CONNECTIVITY_CHECK_INTERVAL = 30000;
const MAX_PENDING_REQUESTS = 3;

let currentAudioElement: HTMLAudioElement | null = null;
let activePlaybackAudio: HTMLAudioElement | null = null;
let voicesCache: { voices: ElevenLabsVoice[]; timestamp: number } | null = null;
let validationCache: { key: string; valid: boolean; timestamp: number } | null = null;
let audioGeneration = 0;
let activeLoopUrls: string[] = [];

let networkOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
let lastConnectivityCheck = 0;
let connectivityCheckResult: boolean | null = null;
let lastNetworkQuality: NetworkQualitySnapshot | null = null;
let pendingRequests: PendingSpeakRequest[] = [];

const isIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

const updateNetworkStatus = (online: boolean) => {
  const wasOffline = !networkOnline;
  networkOnline = online;
  console.log(`🔊 [ElevenLabs] 网络状态: ${online ? '在线' : '离线'}`);

  if (online && wasOffline && pendingRequests.length > 0) {
    console.log(`🔊 [ElevenLabs] 网络恢复，处理 ${pendingRequests.length} 个待重试请求`);
    processPendingRequests();
  }
};

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => updateNetworkStatus(true));
  window.addEventListener('offline', () => updateNetworkStatus(false));
}

const measureNetworkQuality = async (): Promise<NetworkQualitySnapshot> => {
  if (!navigator.onLine) {
    lastNetworkQuality = { quality: 'offline', latency: Infinity, timestamp: Date.now() };
    return lastNetworkQuality;
  }

  const now = Date.now();
  if (lastNetworkQuality && now - lastNetworkQuality.timestamp < CONNECTIVITY_CHECK_INTERVAL / 2) {
    return lastNetworkQuality;
  }

  try {
    const start = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    await fetch(`${API_BASE}/v1/voices`, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latency = performance.now() - start;

    let quality: NetworkQuality;
    if (latency < MEDIUM_NETWORK_LATENCY_THRESHOLD) {
      quality = 'good';
    } else if (latency < WEAK_NETWORK_LATENCY_THRESHOLD) {
      quality = 'medium';
    } else {
      quality = 'weak';
    }

    connectivityCheckResult = true;
    lastConnectivityCheck = now;
    lastNetworkQuality = { quality, latency, timestamp: now };

    console.log(`🔊 [ElevenLabs] 网络质量: ${quality} | 延迟: ${Math.round(latency)}ms`);
    return lastNetworkQuality;
  } catch {
    connectivityCheckResult = false;
    lastConnectivityCheck = now;
    lastNetworkQuality = { quality: 'unknown', latency: Infinity, timestamp: now };
    console.log('🔊 [ElevenLabs] 网络探测失败，标记为 unknown，仍将尝试 API 调用');
    return lastNetworkQuality;
  }
};

const checkConnectivity = async (): Promise<boolean> => {
  const snapshot = await measureNetworkQuality();
  return snapshot.quality !== 'offline';
};

const getAdaptiveTimeout = (quality: NetworkQuality): number => {
  switch (quality) {
    case 'good': return BASE_SPEAK_TIMEOUT;
    case 'medium': return BASE_SPEAK_TIMEOUT * 2;
    case 'weak': return BASE_SPEAK_TIMEOUT * 3;
    case 'offline': return BASE_SPEAK_TIMEOUT;
    case 'unknown': return BASE_SPEAK_TIMEOUT;
  }
};

const getAdaptiveRetries = (quality: NetworkQuality): number => {
  switch (quality) {
    case 'good': return MAX_RETRIES;
    case 'medium': return MAX_RETRIES + 1;
    case 'weak': return MAX_RETRIES + 2;
    case 'offline': return 0;
    case 'unknown': return MAX_RETRIES;
  }
};

const processPendingRequests = () => {
  const requests = pendingRequests.splice(0, MAX_PENDING_REQUESTS);
  for (const req of requests) {
    elevenLabsService.speak(req.text, req.apiKey, req.voiceId, req.loop, req.modelId, req.rate)
      .then(req.resolve);
  }
};

const POPULAR_VOICES: ElevenLabsVoice[] = [
  { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', labels: { accent: 'american', gender: 'male' } },
  { voice_id: 'cjVigY5qzO86Huf0OWal', name: 'Eric', labels: { accent: 'american', gender: 'male' } },
  { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', labels: { accent: 'british', gender: 'male' } },
  { voice_id: 'ThT5KcBeYPX3keUQqHPh', name: 'Dorothy', labels: { accent: 'american', gender: 'female' } },
  { voice_id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', labels: { accent: 'british', gender: 'female' } },
  { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', labels: { accent: 'american', gender: 'male' } },
  { voice_id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam', labels: { accent: 'american', gender: 'male' } },
  { voice_id: 'jBpfuIE2acCO8z3wKNLl', name: 'Gigi', labels: { accent: 'american', gender: 'female' } },
  { voice_id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', labels: { accent: 'american', gender: 'male' } },
  { voice_id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', labels: { accent: 'british', gender: 'female' } },
];

const revokeAllLoopUrls = (): void => {
  for (const url of activeLoopUrls) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  activeLoopUrls = [];
};

const stopCurrentAudio = (): void => {
  if (activePlaybackAudio) {
    try {
      activePlaybackAudio.pause();
      activePlaybackAudio.removeAttribute('src');
      activePlaybackAudio.load();
    } catch {
      // ignore
    }
    activePlaybackAudio = null;
  }
  if (currentAudioElement) {
    try {
      currentAudioElement.pause();
      currentAudioElement.removeAttribute('src');
      currentAudioElement.load();
    } catch {
      // ignore
    }
    currentAudioElement = null;
  }
  revokeAllLoopUrls();
};

const AUDIO_GAIN = 1.5;

let audioContext: AudioContext | null = null;
let gainNode: GainNode | null = null;
let currentSource: MediaElementAudioSourceNode | null = null;

const getAudioContext = (): { ctx: AudioContext; gain: GainNode } => {
  if (isIOS()) {
    throw new Error('iOS 不使用 AudioContext');
  }
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
    gainNode = audioContext.createGain();
    gainNode.gain.value = AUDIO_GAIN;
    gainNode.connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  return { ctx: audioContext, gain: gainNode! };
};

const disconnectSource = () => {
  if (currentSource) {
    try { currentSource.disconnect(); } catch { /* ignore */ }
    currentSource = null;
  }
};

const playAudioBlob = async (audioBlob: Blob, loop: boolean = false, rate: number = 1): Promise<void> => {
  const gen = ++audioGeneration;
  const isCurrentGen = () => gen === audioGeneration;
  const ios = isIOS();

  console.log(`🔊 [ElevenLabs] playAudioBlob 开始 | [iOS] ${ios} | [Blob大小] ${audioBlob.size} | [Blob类型] ${audioBlob.type} | [循环] ${loop} | [语速] ${rate} | [代数] ${gen}`);

  stopCurrentAudio();
  disconnectSource();

  if (!audioBlob || audioBlob.size === 0) {
    throw new Error('音频数据为空');
  }

  const mimeType = audioBlob.type || 'audio/mpeg';
  console.log(`🔊 [ElevenLabs] MIME类型 | [iOS] ${ios} | [类型] ${audioBlob.type} | [最终] ${mimeType}`);

  const url = URL.createObjectURL(audioBlob);
  console.log(`🔊 [ElevenLabs] Blob URL 已创建 | [iOS] ${ios} | [url] blob:...`);
  const audio = new Audio();
  audio.preload = 'auto';
  audio.loop = loop;
  audio.playbackRate = rate;
  if (!ios) {
    audio.crossOrigin = 'anonymous';
  }
  console.log(`🔊 [ElevenLabs] Audio元素创建 | [iOS] ${ios} | [crossOrigin] ${ios ? '未设置' : 'anonymous'} | [src] blob:...`);
  currentAudioElement = audio;

  let sourceConnected = false;

  const connectToGain = () => {
    if (sourceConnected) return;
    if (isIOS()) {
      console.log(`🔊 [ElevenLabs] connectToGain 跳过 (iOS)`);
      sourceConnected = true;
      return;
    }
    try {
      const { gain } = getAudioContext();
      const source = getAudioContext().ctx.createMediaElementSource(audio);
      source.connect(gain);
      currentSource = source;
      sourceConnected = true;
      console.log(`🔊 [ElevenLabs] connectToGain 成功 | [AudioContext状态] ${getAudioContext().ctx.state}`);
    } catch (e) {
      console.warn('🔊 [ElevenLabs] Web Audio 增益连接失败，使用原始音量:', e);
    }
  };

  const cleanup = () => {
    console.log(`🔊 [ElevenLabs] cleanup | [iOS] ${ios} | [代数] ${gen} | [loop] ${loop}`);
    if (currentAudioElement === audio) {
      currentAudioElement = null;
    }
    if (activePlaybackAudio === audio) {
      activePlaybackAudio = null;
    }
    if (loop) {
      const idx = activeLoopUrls.indexOf(url);
      if (idx >= 0) activeLoopUrls.splice(idx, 1);
    }
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let playbackRetryCount = 0;

    const doReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const doResolve = () => {
      if (settled) return;
      settled = true;
      if (loop && audio && !audio.paused) {
        activePlaybackAudio = audio;
        if (currentAudioElement === audio) {
          currentAudioElement = null;
        }
        if (!activeLoopUrls.includes(url)) {
          activeLoopUrls.push(url);
        }
      } else {
        cleanup();
      }
      resolve();
    };

    const attemptPlay = () => {
      if (!isCurrentGen() || settled) return;

      console.log(`🔊 [ElevenLabs] audio.play() 调用 | [iOS] ${ios} | [readyState] ${audio.readyState} | [paused] ${audio.paused} | [currentSrc] ${audio.currentSrc ? 'blob:...' : 'empty'}`);

      audio.play().then(() => {
        console.log(`🔊 [ElevenLabs] audio.play() 成功 | [iOS] ${ios}`);
        if (!loop) return;
        if (settled) return;
        doResolve();
      }).catch((playErr: DOMException) => {
        if (!isCurrentGen() || settled) return;

        console.warn(`🔊 [ElevenLabs] audio.play() 失败 | [iOS] ${ios} | [错误名] ${playErr.name} | [错误信息] ${playErr.message}`);

        if (playErr.name === 'NotAllowedError') {
          if (isIOS() && playbackRetryCount < IOS_PLAYBACK_RETRIES) {
            playbackRetryCount++;
            console.warn(`🔊 [ElevenLabs] iOS 播放被阻止，第 ${playbackRetryCount}/${IOS_PLAYBACK_RETRIES} 次重试...`);
            setTimeout(attemptPlay, IOS_PLAYBACK_DELAY * playbackRetryCount);
            return;
          }
          doReject(new Error('请先点击页面后重试（浏览器安全策略）'));
          return;
        }

        if (playErr.name === 'AbortError') {
          if (isIOS() && playbackRetryCount < IOS_PLAYBACK_RETRIES) {
            playbackRetryCount++;
            console.warn(`🔊 [ElevenLabs] iOS 播放中断，第 ${playbackRetryCount}/${IOS_PLAYBACK_RETRIES} 次重试...`);
            setTimeout(attemptPlay, IOS_PLAYBACK_DELAY * playbackRetryCount);
            return;
          }
          doReject(new Error('播放被中断'));
          return;
        }

        doReject(new Error(`播放失败: ${playErr.message || playErr.name}`));
      });
    };

    audio.oncanplay = () => {
      if (!isCurrentGen() || settled) return;
      console.log(`🔊 [ElevenLabs] oncanplay 触发 | [iOS] ${ios} | [readyState] ${audio.readyState} | [duration] ${audio.duration}`);
      connectToGain();
      attemptPlay();
    };

    audio.onloadeddata = () => {
      if (!isCurrentGen() || settled) return;
      console.log(`🔊 [ElevenLabs] onloadeddata 触发 | [iOS] ${ios} | [readyState] ${audio.readyState} | [duration] ${audio.duration}`);

      if (isIOS()) {
        setTimeout(() => {
          if (!isCurrentGen() || settled) return;
          console.log(`🔊 [ElevenLabs] iOS onloadeddata 延迟播放 | [readyState] ${audio.readyState}`);
          connectToGain();
          attemptPlay();
        }, 100);
      }
    };

    if (!loop) {
      audio.onended = () => {
        if (!isCurrentGen()) return;
        console.log(`🔊 [ElevenLabs] onended 触发 | [iOS] ${ios} | [代数] ${gen}`);
        doResolve();
      };
    }

    audio.onerror = () => {
      if (!isCurrentGen() || settled) return;

      const mediaError = audio.error;
      let errorMsg = '音频解码失败';

      if (mediaError) {
        switch (mediaError.code) {
          case MediaError.MEDIA_ERR_ABORTED:
            errorMsg = '音频加载被中断';
            break;
          case MediaError.MEDIA_ERR_NETWORK:
            errorMsg = '音频网络加载失败';
            break;
          case MediaError.MEDIA_ERR_DECODE:
            errorMsg = '音频解码失败（格式可能不受此浏览器支持）';
            break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMsg = '音频格式不受支持';
            break;
        }
      }

      console.error(`🔊 [ElevenLabs] onerror 触发 | [iOS] ${ios} | [错误码] ${mediaError?.code} | [错误信息] ${errorMsg} | [MIME] ${mimeType} | [Blob大小] ${audioBlob.size}`);

      if (mediaError?.code === MediaError.MEDIA_ERR_NETWORK && isIOS() && playbackRetryCount < IOS_PLAYBACK_RETRIES) {
        playbackRetryCount++;
        console.warn(`🔊 [ElevenLabs] iOS 网络错误，第 ${playbackRetryCount}/${IOS_PLAYBACK_RETRIES} 次重试...`);
        const retryUrl = URL.createObjectURL(audioBlob);
        console.log(`🔊 [ElevenLabs] onerror 重试 Blob URL 已创建`);
        audio.src = retryUrl;
        console.log(`🔊 [ElevenLabs] onerror 重试 audio.src 已设置`);
        audio.load();
        return;
      }

      doReject(new Error(errorMsg));
    };

    audio.onpause = () => {
      if (loop && currentAudioElement !== audio && !settled) {
        console.log(`🔊 [ElevenLabs] onpause 触发 (loop, 非当前元素) | [iOS] ${ios}`);
        if (activePlaybackAudio === audio) {
          activePlaybackAudio = null;
        }
        doResolve();
      }
    };

    audio.src = url;
    console.log(`🔊 [ElevenLabs] audio.src 已设置 | [iOS] ${ios} | [MIME] ${mimeType}`);

    if (isIOS()) {
      setTimeout(() => {
        if (!isCurrentGen() || settled) return;
        console.log(`🔊 [ElevenLabs] iOS 延迟加载 | [readyState] ${audio.readyState}`);
        if (audio.readyState >= 3) {
          attemptPlay();
        } else {
          console.log(`🔊 [ElevenLabs] iOS audio.load() 调用`);
          audio.load();
        }
      }, 50);
    } else {
      console.log(`🔊 [ElevenLabs] audio.load() 调用 (非iOS)`);
      audio.load();
    }

    setTimeout(() => {
      if (!settled && isCurrentGen()) {
        console.warn(`🔊 [ElevenLabs] 播放超时 | [iOS] ${ios} | [超时] ${loop ? 120000 : BASE_SPEAK_TIMEOUT}ms | [readyState] ${audio.readyState}`);
        doReject(new Error('音频播放超时'));
      }
    }, loop ? 120000 : BASE_SPEAK_TIMEOUT);
  });
};

export const elevenLabsService = {
  async speak(
    text: string,
    apiKey: string,
    voiceId: string,
    loop: boolean = false,
    modelId: string = DEFAULT_MODEL,
    rate: number = 1
  ): Promise<SpeakResult> {
    const ios = isIOS();
    console.log(`🔊 [ElevenLabs] speak() 开始 | [iOS] ${ios} | [模型] ${modelId} | [语音] ${voiceId} | [文本长度] ${text?.length} | [循环] ${loop} | [语速] ${rate}`);

    if (!text || typeof text !== 'string' || !text.trim()) {
      return { success: false, error: '发音文本为空' };
    }

    if (!apiKey || !apiKey.trim()) {
      return { success: false, error: '未配置 ElevenLabs API 密钥' };
    }

    if (!voiceId) {
      return { success: false, error: '未选择 ElevenLabs 语音' };
    }

    const trimmedText = text.trim();
    if (trimmedText.length > 5000) {
      return { success: false, error: '文本过长，请分段播放' };
    }

    try {
      const networkSnapshot = await measureNetworkQuality();
      const networkQuality = networkSnapshot.quality;

      const cachedBlob = await elevenLabsCacheService.get(trimmedText, voiceId, modelId);
      if (cachedBlob) {
        console.log(`🔊 [ElevenLabs] 本地缓存命中，跳过API调用 | [语音] ${voiceId}`);
        try {
          await playAudioBlob(cachedBlob, loop, rate);
          return { success: true, fromCache: true };
        } catch (playErr) {
          const msg = playErr instanceof Error ? playErr.message : String(playErr);
          console.warn(`🔊 [ElevenLabs] 缓存音频播放失败: ${msg}，重新请求API`);
        }
      }

      if (networkQuality === 'weak' || networkQuality === 'medium') {
        const staleBlob = await elevenLabsCacheService.getStale(trimmedText, voiceId, modelId);
        if (staleBlob) {
          console.log(`🔊 [ElevenLabs] 弱网环境，使用陈旧缓存播放 | [质量] ${networkQuality}`);
          try {
            await playAudioBlob(staleBlob, loop, rate);
            return { success: true, fromCache: true };
          } catch (playErr) {
            console.warn(`🔊 [ElevenLabs] 陈旧缓存播放失败，尝试API请求`);
          }
        }
      }

      if (networkQuality === 'offline') {
        const staleBlob = await elevenLabsCacheService.getStale(trimmedText, voiceId, modelId);
        if (staleBlob) {
          console.log(`🔊 [ElevenLabs] 离线状态，使用陈旧缓存播放`);
          try {
            await playAudioBlob(staleBlob, loop, rate);
            return { success: true, fromCache: true };
          } catch (playErr) {
            return { success: false, error: '离线状态且缓存音频无法播放，请连接网络后重试' };
          }
        }

        if (pendingRequests.length < MAX_PENDING_REQUESTS) {
          return new Promise<SpeakResult>((resolve) => {
            pendingRequests.push({ text: trimmedText, apiKey, voiceId, loop, modelId, rate, resolve });
            console.log(`🔊 [ElevenLabs] 离线状态，请求已加入待重试队列 (${pendingRequests.length}/${MAX_PENDING_REQUESTS})`);
          });
        }

        return { success: false, error: '当前处于离线状态，且无可用缓存。请连接网络后重试' };
      }

      if (networkQuality === 'weak') {
        const cloudBlob = await ttsCloudCacheService.get(trimmedText, voiceId, 'elevenlabs', modelId);
        if (cloudBlob) {
          console.log(`🔊 [ElevenLabs] 弱网环境，优先使用云端缓存 | [语音] ${voiceId}`);
          elevenLabsCacheService.put(trimmedText, voiceId, modelId, cloudBlob).catch(() => {});
          try {
            await playAudioBlob(cloudBlob, loop, rate);
            return { success: true, fromCache: true };
          } catch (playErr) {
            console.warn(`🔊 [ElevenLabs] 云端缓存播放失败，尝试API请求`);
          }
        }
      } else {
        const cloudBlob = await ttsCloudCacheService.get(trimmedText, voiceId, 'elevenlabs', modelId);
        if (cloudBlob) {
          console.log(`🔊 [ElevenLabs] 云端缓存命中，下载播放 | [语音] ${voiceId}`);
          elevenLabsCacheService.put(trimmedText, voiceId, modelId, cloudBlob).then(() => {
            console.log(`🔊 [ElevenLabs] 云端音频已同步到本地缓存`);
          }).catch(() => {});
          try {
            await playAudioBlob(cloudBlob, loop, rate);
            return { success: true, fromCache: true };
          } catch (playErr) {
            const msg = playErr instanceof Error ? playErr.message : String(playErr);
            console.warn(`🔊 [ElevenLabs] 云端缓存音频播放失败: ${msg}，重新请求API`);
          }
        }
      }

      console.log(`🔊 [ElevenLabs] 本地/云端缓存均未命中，调用API | [语音] ${voiceId} | [网络] ${networkQuality}`);

      const adaptiveTimeout = getAdaptiveTimeout(networkQuality);
      const adaptiveRetries = getAdaptiveRetries(networkQuality);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), adaptiveTimeout);

      let response: Response | undefined;
      let lastError: unknown = null;

      for (let attempt = 0; attempt < adaptiveRetries; attempt++) {
        try {
          if (attempt > 0) {
            console.log(`🔊 [ElevenLabs] 第 ${attempt + 1}/${adaptiveRetries} 次请求...`);
          }

          const requestBody = {
            text: trimmedText,
            model_id: modelId,
            output_format: DEFAULT_OUTPUT_FORMAT,
          };
          console.log(`🔊 [ElevenLabs] API 请求 | [尝试] ${attempt + 1}/${adaptiveRetries} | [文本长度] ${trimmedText.length} | [模型] ${modelId} | [语音] ${voiceId} | [格式] ${DEFAULT_OUTPUT_FORMAT} | [超时] ${adaptiveTimeout}ms`);

          response = await fetch(`${API_BASE}/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': apiKey.trim(),
              Accept: 'audio/mpeg',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
          break;
        } catch (fetchErr) {
          lastError = fetchErr;
          if (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') {
            break;
          }
          if (attempt < adaptiveRetries - 1) {
            const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
            console.log(`🔊 [ElevenLabs] 请求失败，${delay}ms 后第 ${attempt + 2}/${adaptiveRetries} 次重试...`);
            await new Promise(r => setTimeout(r, delay));

            const currentQuality = await measureNetworkQuality();
            if (currentQuality.quality === 'offline') {
              console.log(`🔊 [ElevenLabs] 请求期间网络断开`);
              const staleBlob = await elevenLabsCacheService.getStale(trimmedText, voiceId, modelId);
              if (staleBlob) {
                try {
                  await playAudioBlob(staleBlob, loop, rate);
                  return { success: true, fromCache: true };
                } catch {
                  // continue to error
                }
              }
              break;
            }
          }
        }
      }

      clearTimeout(timeoutId);

      if (!response) {
        if (lastError instanceof DOMException && (lastError as DOMException).name === 'AbortError') {
          const staleBlob = await elevenLabsCacheService.getStale(trimmedText, voiceId, modelId);
          if (staleBlob) {
            try {
              await playAudioBlob(staleBlob, loop, rate);
              return { success: true, fromCache: true };
            } catch {
              // continue to error
            }
          }
          return { success: false, error: `请求超时（${adaptiveTimeout / 1000}秒），请检查网络连接` };
        }
        if (lastError instanceof TypeError && (lastError as TypeError).message.includes('Failed to fetch')) {
          return { success: false, error: '网络连接失败，请检查网络或代理设置' };
        }
        const message = lastError instanceof Error ? (lastError as Error).message : String(lastError);
        return { success: false, error: `请求失败（已重试${adaptiveRetries}次）: ${message}` };
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        let errorMessage = `API 错误 (${response.status})`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.detail?.message || errorJson.detail || errorJson.message || errorMessage;
        } catch {
          // ignore parse error
        }

        if (response.status === 401) {
          errorMessage = 'API 密钥无效，请检查设置';
        } else if (response.status === 429) {
          errorMessage = 'API 调用配额已用尽，请稍后再试';
        } else if (response.status === 422) {
          errorMessage = '请求参数错误，请检查语音设置';
        }

        console.error(`🔊 [ElevenLabs] API 响应错误 | [状态码] ${response.status} | [模型] ${modelId} | [语音] ${voiceId} | [错误] ${errorMessage}`);
        return { success: false, error: errorMessage };
      }

      console.log(`🔊 [ElevenLabs] API 响应成功 | [状态码] ${response.status} | [Content-Type] ${response.headers.get('content-type')} | [Content-Length] ${response.headers.get('content-length') || '未知'} | [模型] ${modelId}`);

      const ios = isIOS();
      const contentType = response.headers.get('content-type') || 'audio/mpeg';
      let audioBlob: Blob;

      if (ios) {
        const buffer = await response.arrayBuffer();
        console.log(`🔊 [ElevenLabs] response.arrayBuffer() | [iOS] true | [byteLength] ${buffer.byteLength}`);
        audioBlob = new Blob([buffer], { type: contentType });
        console.log(`🔊 [ElevenLabs] Blob 手动构造 | [iOS] true | [大小] ${audioBlob.size} | [类型] ${audioBlob.type}`);
      } else {
        try {
          audioBlob = await response.blob();
          console.log(`🔊 [ElevenLabs] response.blob() 成功 | [大小] ${audioBlob.size} | [类型] ${audioBlob.type}`);
        } catch (blobErr) {
          console.warn(`🔊 [ElevenLabs] response.blob() 失败，降级为 arrayBuffer | [错误] ${blobErr instanceof Error ? blobErr.message : String(blobErr)}`);
          const buffer = await response.arrayBuffer();
          audioBlob = new Blob([buffer], { type: 'audio/mpeg' });
          console.log(`🔊 [ElevenLabs] arrayBuffer 降级成功 | [大小] ${audioBlob.size} | [类型] ${audioBlob.type}`);
        }
      }

      if (!audioBlob || audioBlob.size === 0) {
        return { success: false, error: '未收到音频数据' };
      }

      console.log(`🔊 [ElevenLabs] 合成完成 | [大小] ${elevenLabsCacheService.formatSize(audioBlob.size)} | [类型] ${audioBlob.type}`);

      elevenLabsCacheService.put(trimmedText, voiceId, modelId, audioBlob).then((saved) => {
        if (saved) {
          console.log(`🔊 [ElevenLabs] 音频已缓存到本地`);
        }
      }).catch(() => {});

      ttsCloudCacheService.put(trimmedText, voiceId, 'elevenlabs', audioBlob, modelId, rate).then((uploaded) => {
        if (uploaded) {
          console.log(`🔊 [ElevenLabs] 音频已上传到云端`);
        }
      }).catch(() => {});

      await playAudioBlob(audioBlob, loop, rate);
      return { success: true, fromCache: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('🔊 [ElevenLabs] 合成失败:', message);
      return { success: false, error: `播放失败: ${message}` };
    }
  },

  async fetchVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
    if (!apiKey || !apiKey.trim()) {
      return POPULAR_VOICES;
    }

    if (voicesCache && Date.now() - voicesCache.timestamp < VOICES_CACHE_TTL) {
      return voicesCache.voices;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(`${API_BASE}/v1/voices`, {
        method: 'GET',
        headers: {
          'xi-api-key': apiKey.trim(),
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn('ElevenLabs 语音列表获取失败，使用预设列表');
        return POPULAR_VOICES;
      }

      const data = await response.json();
      const voices: ElevenLabsVoice[] = (data.voices || []).map((v: { voice_id: string; name: string; labels?: Record<string, string>; preview_url?: string }) => ({
        voice_id: v.voice_id,
        name: v.name,
        labels: v.labels,
        preview_url: v.preview_url,
      }));

      if (voices.length > 0) {
        voicesCache = { voices, timestamp: Date.now() };
        return voices;
      }

      return POPULAR_VOICES;
    } catch {
      console.warn('ElevenLabs 语音列表获取失败，使用预设列表');
      return POPULAR_VOICES;
    }
  },

  async validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    if (!apiKey || !apiKey.trim()) {
      return { valid: false, error: '请输入 API 密钥' };
    }

    const trimmedKey = apiKey.trim();

    if (!API_KEY_PATTERN.test(trimmedKey)) {
      return { valid: false, error: 'API 密钥格式不正确，应以 sk_ 开头后跟十六进制字符' };
    }

    if (validationCache &&
        validationCache.key === trimmedKey &&
        Date.now() - validationCache.timestamp < VALIDATE_CACHE_TTL) {
      if (validationCache.valid) {
        console.log('🔊 [ElevenLabs] 使用缓存的验证结果（有效）');
        return { valid: true };
      }
      if (Date.now() - validationCache.timestamp > 30 * 1000 && navigator.onLine) {
        console.log('🔊 [ElevenLabs] invalid 缓存已过期（>30s），清除后重新验证');
        validationCache = null;
      } else {
        console.log('🔊 [ElevenLabs] 使用缓存的验证结果（无效）');
        return { valid: false, error: 'API 密钥无效（缓存结果）' };
      }
    }

    try {
      const validateVoiceId = POPULAR_VOICES[0].voice_id;
      console.log('🔊 [ElevenLabs] 验证密钥：合成最小音频 "Hi" (约 1 字符配额)');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT);

      const response = await fetch(`${API_BASE}/v1/text-to-speech/${validateVoiceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': trimmedKey,
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: 'Hi',
          model_id: DEFAULT_MODEL,
          output_format: DEFAULT_OUTPUT_FORMAT,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        console.log('🔊 [ElevenLabs] /v1/text-to-speech 验证通过 (200 OK)');
        validationCache = { key: trimmedKey, valid: true, timestamp: Date.now() };
        return { valid: true };
      }

      if (response.status === 401) {
        console.warn('🔊 [ElevenLabs] /v1/text-to-speech 返回 401，密钥无 TTS 权限');
        validationCache = { key: trimmedKey, valid: false, timestamp: Date.now() };
        return { valid: false, error: 'API 密钥无效' };
      }

      if (response.status === 429) {
        console.log('🔊 [ElevenLabs] 429 限流，密钥有效');
        validationCache = { key: trimmedKey, valid: true, timestamp: Date.now() };
        return { valid: true };
      }

      if (response.status === 400) {
        console.warn('🔊 [ElevenLabs] /v1/text-to-speech 返回 400，请求参数错误（模型或语音不兼容）');
        validationCache = { key: trimmedKey, valid: true, timestamp: Date.now() };
        return { valid: true, error: '请求参数错误，请检查模型设置' };
      }

      if (response.status === 422) {
        console.warn('🔊 [ElevenLabs] /v1/text-to-speech 返回 422，语音或模型不兼容，但密钥有效');
        validationCache = { key: trimmedKey, valid: true, timestamp: Date.now() };
        return { valid: true, error: '语音或模型不兼容，但密钥有效' };
      }

      return { valid: false, error: `验证接口异常 (${response.status})` };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { valid: false, error: '网络连接超时，请检查网络或代理设置' };
      }
      return { valid: false, error: '网络连接失败，请检查网络或代理设置' };
    }
  },

  getPopularVoices(): ElevenLabsVoice[] {
    return POPULAR_VOICES;
  },

  getDefaultVoiceId(): string {
    return POPULAR_VOICES[0].voice_id;
  },

  getDefaultModel(): string {
    return DEFAULT_MODEL;
  },

  stop(): void {
    audioGeneration++;
    stopCurrentAudio();
  },

  setPlaybackRate(rate: number): void {
    if (currentAudioElement) {
      currentAudioElement.playbackRate = rate;
    }
    if (activePlaybackAudio) {
      activePlaybackAudio.playbackRate = rate;
    }
  },

  clearVoicesCache(): void {
    voicesCache = null;
  },

  clearValidationCache(): void {
    validationCache = null;
  },

  getNetworkQuality(): NetworkQuality {
    return lastNetworkQuality?.quality ?? (networkOnline ? 'good' : 'offline');
  },

  getPendingRequestCount(): number {
    return pendingRequests.length;
  },

  clearPendingRequests(): void {
    pendingRequests = [];
  },

  async fetchAudioBlob(
    text: string,
    apiKey: string,
    voiceId: string,
    modelId?: string
  ): Promise<Blob | null> {
    if (!text || !text.trim()) return null;
    if (!apiKey || !apiKey.trim()) return null;
    if (!voiceId) return null;

    const trimmedText = text.trim();
    const model = modelId || DEFAULT_MODEL;

    try {
      const cachedBlob = await elevenLabsCacheService.get(trimmedText, voiceId, model);
      if (cachedBlob) {
        console.log(`🔊 [ElevenLabs] fetchAudioBlob: 本地缓存命中 | [语音] ${voiceId}`);
        return cachedBlob;
      }
    } catch { /* ignore */ }

    try {
      const cloudBlob = await ttsCloudCacheService.get(trimmedText, voiceId, 'elevenlabs', model);
      if (cloudBlob) {
        console.log(`🔊 [ElevenLabs] fetchAudioBlob: 云端缓存命中 | [语音] ${voiceId}`);
        elevenLabsCacheService.put(trimmedText, voiceId, model, cloudBlob).catch(() => {});
        return cloudBlob;
      }
    } catch { /* ignore */ }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), BASE_SPEAK_TIMEOUT);

      const response = await fetch(`${API_BASE}/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey.trim(),
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: trimmedText,
          model_id: model,
          output_format: DEFAULT_OUTPUT_FORMAT,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`🔊 [ElevenLabs] fetchAudioBlob: API 返回 ${response.status}`);
        return null;
      }

      const ios = isIOS();
      const contentType = response.headers.get('content-type') || 'audio/mpeg';
      let blob: Blob;

      if (ios) {
        const buffer = await response.arrayBuffer();
        console.log(`🔊 [ElevenLabs] fetchAudioBlob: response.arrayBuffer() | [iOS] true | [byteLength] ${buffer.byteLength}`);
        blob = new Blob([buffer], { type: contentType });
        console.log(`🔊 [ElevenLabs] fetchAudioBlob: Blob 手动构造 | [iOS] true | [大小] ${blob.size} | [类型] ${blob.type}`);
      } else {
        blob = await response.blob();
        console.log(`🔊 [ElevenLabs] fetchAudioBlob: response.blob() | [大小] ${blob.size} | [类型] ${blob.type}`);
      }

      if (!blob || blob.size === 0) {
        console.warn('🔊 [ElevenLabs] fetchAudioBlob: API 返回空音频');
        return null;
      }

      console.log(`🔊 [ElevenLabs] fetchAudioBlob: 合成完成 | [大小] ${(blob.size / 1024).toFixed(1)} KB`);

      elevenLabsCacheService.put(trimmedText, voiceId, model, blob).catch(() => {});
      ttsCloudCacheService.put(trimmedText, voiceId, 'elevenlabs', blob, model).catch(() => {});

      return blob;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`🔊 [ElevenLabs] fetchAudioBlob 失败: ${msg}`);
      return null;
    }
  },
};

export default elevenLabsService;
