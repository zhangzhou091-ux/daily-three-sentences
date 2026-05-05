import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import { elevenLabsCacheService } from './elevenLabsCacheService';
import { storageService } from './storage';

const MIRROR_HOSTS = [
  'https://hf-mirror.com',
  'https://huggingface.do.mirr.one',
];

const ORIGINAL_HOST = 'https://huggingface.co';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

const BASE_PATH = import.meta.env.BASE_URL || '/daily-three-sentences/';
const LOCAL_MODEL_PATH = `${BASE_PATH}models/`;

env.allowLocalModels = true;
env.localModelPath = LOCAL_MODEL_PATH;

const getStoredUseLocalModels = (): boolean => {
  try {
    const settings = storageService.getSettings();
    return settings.kokoroUseLocal ?? false;
  } catch {
    return false;
  }
};

let useLocalModels = getStoredUseLocalModels();

if (useLocalModels) {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = LOCAL_MODEL_PATH;
}

export const setUseLocalModels = (enabled: boolean): void => {
  useLocalModels = enabled;
  if (enabled) {
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = LOCAL_MODEL_PATH;
    console.log(`🔊 [Kokoro] 切换为本地模型模式，路径: ${LOCAL_MODEL_PATH}`);
  } else {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.remoteHost = MIRROR_HOSTS[0];
    console.log('🔊 [Kokoro] 切换为远程模型模式');
  }
};

export const getUseLocalModels = (): boolean => useLocalModels;

const patchVoiceLoading = (activeHost: string): void => {
  try {
    const originalFetch = window.fetch;
    if ((window as any).__kokoroFetchPatched) {
      updateActiveHost(activeHost);
      return;
    }

    (window as any).__kokoroFetchPatched = true;
    (window as any).__kokoroActiveHost = activeHost;

    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.startsWith('https://huggingface.co') && url.includes('/Kokoro-82M-v1.0-ONNX/resolve/main/voices/')) {
        if (useLocalModels) {
          const voiceMatch = url.match(/voices\/([^/]+\.bin)/);
          const voiceFile = voiceMatch ? voiceMatch[1] : '';
          const localUrl = `${LOCAL_MODEL_PATH}onnx-community/Kokoro-82M-v1.0-ONNX/voices/${voiceFile}`;
          console.log(`🔊 [Kokoro] 本地 voice 加载: ${localUrl}`);
          return originalFetch.call(window, localUrl, init);
        }
        const activeMirror = (window as any).__kokoroActiveHost || MIRROR_HOSTS[0];
        const patchedUrl = url.replace('https://huggingface.co', activeMirror);
        console.log(`🔊 [Kokoro] 拦截 voice 下载: ${url} → ${patchedUrl}`);
        return originalFetch.call(window, patchedUrl, init);
      }

      return originalFetch.call(window, input, init);
    };

    console.log('🔊 [Kokoro] Voice 下载拦截器已安装');
  } catch (err) {
    console.warn('🔊 [Kokoro] Voice 下载拦截器安装失败:', err);
  }
};

const updateActiveHost = (host: string): void => {
  (window as any).__kokoroActiveHost = host;
  env.remoteHost = host;
};

const checkMirrorAvailable = async (host: string): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(
      `${host}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json`,
      { method: 'GET', signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if (!response.ok) return false;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) return false;
    const text = await response.text();
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
};

export interface KokoroVoice {
  id: string;
  name: string;
  gender: 'female' | 'male';
  accent: 'american' | 'british';
  grade: string;
}

export interface KokoroSpeakResult {
  success: boolean;
  error?: string;
}

const CACHE_STORE_NAME = 'kokoro_audio_cache';

const RECOMMENDED_VOICES: KokoroVoice[] = [
  { id: 'af_heart', name: 'Heart', gender: 'female', accent: 'american', grade: 'A' },
  { id: 'af_bella', name: 'Bella', gender: 'female', accent: 'american', grade: 'A-' },
  { id: 'af_alloy', name: 'Alloy', gender: 'female', accent: 'american', grade: 'B+' },
  { id: 'af_nicole', name: 'Nicole', gender: 'female', accent: 'american', grade: 'B-' },
  { id: 'af_kore', name: 'Kore', gender: 'female', accent: 'american', grade: 'C+' },
  { id: 'am_michael', name: 'Michael', gender: 'male', accent: 'american', grade: 'C+' },
  { id: 'am_fenrir', name: 'Fenrir', gender: 'male', accent: 'american', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', gender: 'male', accent: 'american', grade: 'C+' },
  { id: 'bf_emma', name: 'Emma', gender: 'female', accent: 'british', grade: 'B-' },
  { id: 'bm_george', name: 'George', gender: 'male', accent: 'british', grade: 'C' },
];

const LOCAL_VOICE_IDS = new Set(['af_heart', 'af_bella', 'af_alloy', 'am_michael']);

let ttsInstance: KokoroTTS | null = null;
let isLoading = false;
let loadError: string | null = null;
let loadProgress: number = 0;
let audioGeneration = 0;

const isSafari = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
};

const isIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

const collectIOSDiagnostics = (): Record<string, unknown> => {
  const info: Record<string, unknown> = {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'N/A',
    isIOS: isIOS(),
    isSafari: isSafari(),
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false,
    SharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    webAssembly: typeof WebAssembly !== 'undefined',
    indexedDB: typeof indexedDB !== 'undefined',
    maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
    hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0,
    deviceMemory: (navigator as any).deviceMemory || 'unknown',
    onLine: typeof navigator !== 'undefined' ? navigator.onLine : false,
  };

  if (typeof performance !== 'undefined' && (performance as any).memory) {
    const mem = (performance as any).memory;
    info.jsHeapSizeLimitMB = Math.round(mem.jsHeapSizeLimit / 1048576);
    info.totalJSHeapSizeMB = Math.round(mem.totalJSHeapSize / 1048576);
    info.usedJSHeapSizeMB = Math.round(mem.usedJSHeapSize / 1048576);
  }

  return info;
};

const generateKokoroCacheKey = (text: string, voice: string): string => {
  const raw = `${text.trim()}|kokoro|${voice}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `ko_${Math.abs(hash).toString(36)}_${raw.length}`;
};

const getKokoroCacheDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('D3S_Kokoro_Cache', 1);
    request.onerror = () => reject(new Error('Kokoro缓存数据库打开失败'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'key' });
      }
    };
  });
};

const getCachedAudio = async (text: string, voice: string): Promise<Blob | null> => {
  try {
    const db = await getKokoroCacheDB();
    const key = generateKokoroCacheKey(text, voice);
    return new Promise((resolve) => {
      const tx = db.transaction([CACHE_STORE_NAME], 'readonly');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (record && record.audioBlob) {
          resolve(record.audioBlob);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
};

const setCachedAudio = async (text: string, voice: string, audioBlob: Blob): Promise<void> => {
  try {
    const db = await getKokoroCacheDB();
    const key = generateKokoroCacheKey(text, voice);
    return new Promise((resolve) => {
      const tx = db.transaction([CACHE_STORE_NAME], 'readwrite');
      const store = tx.objectStore(CACHE_STORE_NAME);
      store.put({
        key,
        audioBlob,
        textPreview: text.trim().slice(0, 80),
        voice,
        createdAt: Date.now(),
        size: audioBlob.size,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
};

let audioContext: AudioContext | null = null;
let currentSourceNode: AudioBufferSourceNode | null = null;

const getAudioContext = async (): Promise<AudioContext> => {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext({ sampleRate: 24000 });
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  return audioContext;
};

const stopCurrentSource = () => {
  if (currentSourceNode) {
    try {
      currentSourceNode.stop();
      currentSourceNode.disconnect();
    } catch {
      // already stopped
    }
    currentSourceNode = null;
  }
};

const encodeWav16Bit = (samples: Float32Array, sampleRate: number): Blob => {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
};

const playRawAudio = async (samples: Float32Array, sampleRate: number, loop: boolean = false, rate: number = 1): Promise<void> => {
  return new Promise(async (resolve, reject) => {
    try {
      const gen = ++audioGeneration;
      const isCurrentGen = () => gen === audioGeneration;

      stopCurrentSource();

      const ctx = await getAudioContext();
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = loop;
      source.playbackRate.value = rate;
      source.connect(ctx.destination);
      currentSourceNode = source;

      source.onended = () => {
        if (!isCurrentGen()) return;
        if (currentSourceNode === source) currentSourceNode = null;
        resolve();
      };

      source.start();

      if (loop) {
        resolve();
      }
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
};

const playCachedBlob = async (audioBlob: Blob, loop: boolean = false, rate: number = 1): Promise<void> => {
  const gen = ++audioGeneration;
  const isCurrentGen = () => gen === audioGeneration;

  stopCurrentSource();

  const ctx = await getAudioContext();
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  if (!isCurrentGen()) return;

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.loop = loop;
  source.playbackRate.value = rate;
  source.connect(ctx.destination);
  currentSourceNode = source;

  return new Promise((resolve) => {
    source.onended = () => {
      if (!isCurrentGen()) return;
      if (currentSourceNode === source) currentSourceNode = null;
      resolve();
    };
    source.start();
    if (loop) resolve();
  });
};

export const kokoroTtsService = {
  async loadModel(): Promise<{ loaded: boolean; error?: string }> {
    if (ttsInstance) return { loaded: true };
    if (isLoading) {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (!isLoading) {
            clearInterval(check);
            resolve(ttsInstance ? { loaded: true } : { loaded: false, error: loadError || '模型加载失败' });
          }
        }, 200);
        setTimeout(() => {
          clearInterval(check);
          resolve({ loaded: !!ttsInstance, error: loadError || undefined });
        }, 120000);
      });
    }

    isLoading = true;
    loadError = null;
    loadProgress = 0;

    const onIOS = isIOS();
    const onSafari = isSafari() || onIOS;
    const hasWebGPU = !onSafari && typeof navigator !== 'undefined' && 'gpu' in navigator;

    if (onIOS) {
      const diag = collectIOSDiagnostics();
      console.log('🔊 [Kokoro] iOS 环境诊断:', JSON.stringify(diag, null, 2));

      if (!diag.crossOriginIsolated) {
        console.warn('🔊 [Kokoro] iOS SharedArrayBuffer 不可用，切换到单线程 WASM 模式');
        try {
          if ((env as any).backends?.onnx?.wasm) {
            (env as any).backends.onnx.wasm.numThreads = 1;
          }
        } catch (e) {
          console.warn('🔊 [Kokoro] 无法配置单线程模式:', e);
        }
        try {
          if ((env as any).backends?.onnx?.wasm) {
            (env as any).backends.onnx.wasm.initTimeout = 120000;
          }
        } catch (e) {
          // ignore
        }
      }

      if (diag.jsHeapSizeLimitMB !== undefined && (diag.jsHeapSizeLimitMB as number) < 512) {
        console.warn('🔊 [Kokoro] iOS JS 堆内存限制较低 (' + diag.jsHeapSizeLimitMB + 'MB)，模型加载可能失败');
      }
    }

    const checkLocalAvailable = async (): Promise<boolean> => {
      try {
        const configUrl = `${LOCAL_MODEL_PATH}onnx-community/Kokoro-82M-v1.0-ONNX/config.json`;
        const resp = await fetch(configUrl, { method: 'GET' });
        if (!resp.ok) return false;
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('text/html')) return false;
        const text = await resp.text();
        try {
          JSON.parse(text);
          return true;
        } catch {
          return false;
        }
      } catch {
        return false;
      }
    };

    const tryLoadLocal = async (): Promise<{ loaded: boolean; error?: string }> => {
      console.log(`🔊 [Kokoro] 尝试从本地路径加载模型: ${LOCAL_MODEL_PATH}`);
      loadProgress = 5;

      const prevAllowRemote = env.allowRemoteModels;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = LOCAL_MODEL_PATH;

      try {
        const configUrl = `${LOCAL_MODEL_PATH}onnx-community/Kokoro-82M-v1.0-ONNX/config.json`;
        const configResp = await fetch(configUrl);
        if (!configResp.ok) {
          throw new Error(`本地模型文件不存在: config.json (${configResp.status})`);
        }
        console.log('🔊 [Kokoro] 本地模型文件检测通过，开始加载...');
        ttsInstance = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: 'q8',
          device: 'wasm',
          progress_callback: (progress: any) => {
            if (progress?.status === 'progress' && progress.progress) {
              loadProgress = Math.min(10 + Math.round(progress.progress * 0.9), 99);
            }
          },
        } as any);
        console.log('🔊 [Kokoro] 本地模型加载完成');
        loadProgress = 100;
        isLoading = false;
        return { loaded: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`🔊 [Kokoro] 本地模型加载失败: ${msg}`);
        if (onIOS) {
          const diag = collectIOSDiagnostics();
          console.error('🔊 [Kokoro] iOS 加载失败诊断:', JSON.stringify(diag));
          if (msg.includes('Out of memory') || msg.includes('memory')) {
            console.error('🔊 [Kokoro] iOS 内存不足，建议关闭其他标签页后重试');
          }
          if (msg.includes('SharedArrayBuffer')) {
            console.error('🔊 [Kokoro] iOS SharedArrayBuffer 不可用，当前环境不支持多线程 WASM');
          }
        }
        ttsInstance = null;
        env.allowRemoteModels = prevAllowRemote;
        return { loaded: false, error: msg };
      }
    };

    const localAvailable = await checkLocalAvailable();

    if (localAvailable) {
      console.log('🔊 [Kokoro] 检测到本地模型文件，优先使用本地加载');
      patchVoiceLoading('');
      const result = await tryLoadLocal();
      if (result.loaded) return result;
      console.warn('🔊 [Kokoro] 本地加载失败，回退到远程加载');
      isLoading = true;
      loadError = null;
    }

    patchVoiceLoading(MIRROR_HOSTS[0]);

    const tryLoadWithHost = async (host: string, dtype: string, device: string): Promise<{ loaded: boolean; error?: string }> => {
      updateActiveHost(host);
      console.log(`🔊 [Kokoro] 使用镜像源: ${host} | [设备] ${device} | [精度] ${dtype}`);
      loadProgress = 5;
      try {
        ttsInstance = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype,
          device,
          progress_callback: (progress: any) => {
            if (progress?.status === 'progress' && progress.progress) {
              loadProgress = Math.min(10 + Math.round(progress.progress * 0.9), 99);
              console.log(`🔊 [Kokoro] 下载进度: ${loadProgress}%`);
            }
          },
        } as any);
        console.log(`🔊 [Kokoro] 模型加载完成 (${host} | ${device} | ${dtype})`);
        loadProgress = 100;
        isLoading = false;
        return { loaded: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`🔊 [Kokoro] 加载失败 (${host} | ${device} | ${dtype}): ${msg}`);
        if (onIOS) {
          console.error('🔊 [Kokoro] iOS 远程加载失败诊断:', JSON.stringify(collectIOSDiagnostics()));
        }
        ttsInstance = null;
        return { loaded: false, error: msg };
      }
    };

    const isHtmlError = (error?: string): boolean => {
      return !!(error && (error.includes('<!DOCTYPE') || error.includes('<html') || error.includes('Unexpected token')));
    };

    const isCorsError = (error?: string): boolean => {
      return !!(error && (error.includes('CORS') || error.includes('cors') || error.includes('Failed to fetch') || error.includes('NetworkError')));
    };

    const tryLoadWasm = async (): Promise<{ loaded: boolean; error?: string }> => {
      const allHosts = [...MIRROR_HOSTS, ORIGINAL_HOST];
      for (const host of allHosts) {
        console.log(`🔊 [Kokoro] 检查镜像源可用性: ${host}`);
        const available = await checkMirrorAvailable(host);
        if (!available) {
          console.warn(`🔊 [Kokoro] 镜像源不可用，跳过: ${host}`);
          continue;
        }
        const result = await tryLoadWithHost(host, 'q8', 'wasm');
        if (result.loaded) return result;
        if (isHtmlError(result.error) || isCorsError(result.error)) {
          console.warn(`🔊 [Kokoro] 镜像源返回错误，尝试下一个: ${host} - ${result.error}`);
          continue;
        }
        loadError = result.error ?? null;
        isLoading = false;
        return result;
      }
      const msg = '所有镜像源均不可用，请检查网络连接或使用本地模型';
      console.error(`🔊 [Kokoro] ${msg}`);
      loadError = msg;
      isLoading = false;
      return { loaded: false, error: msg };
    };

    if (useLocalModels) {
      patchVoiceLoading('');
      return tryLoadLocal();
    }

    patchVoiceLoading(MIRROR_HOSTS[0]);

    if (onSafari) {
      console.log('🔊 [Kokoro] 检测到 Safari/iOS，跳过 WebGPU，直接使用 WASM q8');
      return tryLoadWasm();
    }

    if (hasWebGPU) {
      const allHosts = [...MIRROR_HOSTS, ORIGINAL_HOST];
      for (const host of allHosts) {
        console.log(`🔊 [Kokoro] 检查镜像源可用性: ${host}`);
        const available = await checkMirrorAvailable(host);
        if (!available) {
          console.warn(`🔊 [Kokoro] 镜像源不可用，跳过: ${host}`);
          continue;
        }
        const result = await tryLoadWithHost(host, 'fp32', 'webgpu');
        if (result.loaded) return result;
        if (isHtmlError(result.error) || isCorsError(result.error)) {
          console.warn(`🔊 [Kokoro] 镜像源返回错误，尝试下一个: ${host}`);
          continue;
        }
        break;
      }
      console.warn('🔊 [Kokoro] WebGPU 加载失败，回退到 WASM q8');
      isLoading = true;
      loadError = null;
      return tryLoadWasm();
    }

    console.log('🔊 [Kokoro] 无 WebGPU 支持，直接使用 WASM q8');
    return tryLoadWasm();
  },

  isModelLoaded(): boolean {
    return ttsInstance !== null;
  },

  isLoadingModel(): boolean {
    return isLoading;
  },

  getLoadProgress(): number {
    return loadProgress;
  },

  getLoadError(): string | null {
    return loadError;
  },

  getIOSDiagnostics(): Record<string, unknown> {
    return collectIOSDiagnostics();
  },

  async speak(text: string, voice: string = 'af_heart', loop: boolean = false, rate: number = 1): Promise<KokoroSpeakResult> {
    if (!text || !text.trim()) {
      return { success: false, error: '发音文本为空' };
    }

    const trimmedText = text.trim();
    if (trimmedText.length > 5000) {
      return { success: false, error: '文本过长，请分段播放' };
    }

    if (!ttsInstance) {
      const loadResult = await this.loadModel();
      if (!loadResult.loaded) {
        return { success: false, error: `模型未加载: ${loadResult.error}` };
      }
    }

    try {
      const cachedBlob = await getCachedAudio(trimmedText, voice);
      if (cachedBlob) {
        console.log(`🔊 [Kokoro] 缓存命中 | [语音] ${voice}`);
        await playCachedBlob(cachedBlob, loop, rate);
        return { success: true };
      }

      console.log(`🔊 [Kokoro] 生成音频 | [语音] ${voice} | [文本] ${trimmedText.slice(0, 40)}...`);
      const audio = await ttsInstance!.generate(trimmedText, { voice: voice as any });

      if (!audio.audio || audio.audio.length === 0) {
        return { success: false, error: '未生成音频数据' };
      }

      const audioBlob = encodeWav16Bit(audio.audio, audio.sampling_rate);

      setCachedAudio(trimmedText, voice, audioBlob).then(() => {
        console.log(`🔊 [Kokoro] 音频已缓存 | [大小] ${elevenLabsCacheService.formatSize(audioBlob.size)}`);
      });

      await playRawAudio(audio.audio, audio.sampling_rate, loop, rate);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('🔊 [Kokoro] 生成失败:', msg);
      return { success: false, error: msg };
    }
  },

  stop(): void {
    audioGeneration++;
    stopCurrentSource();
  },

  setPlaybackRate(rate: number): void {
    if (currentSourceNode) {
      currentSourceNode.playbackRate.value = rate;
    }
  },

  getVoices(): KokoroVoice[] {
    if (useLocalModels) {
      return RECOMMENDED_VOICES.filter(v => LOCAL_VOICE_IDS.has(v.id));
    }
    return RECOMMENDED_VOICES;
  },

  getDefaultVoiceId(): string {
    return 'af_heart';
  },

  async getCacheStats(): Promise<{ count: number; totalSize: number }> {
    try {
      const db = await getKokoroCacheDB();
      return new Promise((resolve) => {
        const tx = db.transaction([CACHE_STORE_NAME], 'readonly');
        const store = tx.objectStore(CACHE_STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => {
          const records = request.result as Array<{ size: number }>;
          let totalSize = 0;
          for (const r of records) {
            totalSize += r.size || 0;
          }
          resolve({ count: records.length, totalSize });
        };
        request.onerror = () => resolve({ count: 0, totalSize: 0 });
      });
    } catch {
      return { count: 0, totalSize: 0 };
    }
  },

  async clearCache(): Promise<number> {
    try {
      const db = await getKokoroCacheDB();
      const stats = await this.getCacheStats();
      return new Promise((resolve) => {
        const tx = db.transaction([CACHE_STORE_NAME], 'readwrite');
        const store = tx.objectStore(CACHE_STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => resolve(stats.count);
        request.onerror = () => resolve(0);
      });
    } catch {
      return 0;
    }
  },
};

export default kokoroTtsService;
