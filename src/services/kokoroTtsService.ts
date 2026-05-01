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
  try {
    const settings = storageService.getSettings();
    storageService.saveSettings({ ...settings, kokoroUseLocal: enabled });
  } catch {
    // ignore
  }
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

      if (url.includes('huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/')) {
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
      { method: 'GET', signal: controller.signal, mode: 'cors' }
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
  { id: 'af_nicole', name: 'Nicole', gender: 'female', accent: 'american', grade: 'B-' },
  { id: 'af_kore', name: 'Kore', gender: 'female', accent: 'american', grade: 'C+' },
  { id: 'am_michael', name: 'Michael', gender: 'male', accent: 'american', grade: 'C+' },
  { id: 'am_fenrir', name: 'Fenrir', gender: 'male', accent: 'american', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', gender: 'male', accent: 'american', grade: 'C+' },
  { id: 'bf_emma', name: 'Emma', gender: 'female', accent: 'british', grade: 'B-' },
  { id: 'bm_george', name: 'George', gender: 'male', accent: 'british', grade: 'C' },
];

let ttsInstance: KokoroTTS | null = null;
let isLoading = false;
let loadError: string | null = null;
let currentAudioElement: HTMLAudioElement | null = null;
let loadProgress: number = 0;

const isSafari = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
};

const isIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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

const playAudioBlob = async (audioBlob: Blob, loop: boolean = false): Promise<void> => {
  return new Promise((resolve, reject) => {
    try {
      if (currentAudioElement) {
        currentAudioElement.pause();
        currentAudioElement.src = '';
        currentAudioElement = null;
      }

      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      audio.loop = loop;
      currentAudioElement = audio;

      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (currentAudioElement === audio) currentAudioElement = null;
      };

      audio.oncanplaythrough = () => {
        audio.play().then(() => {
          if (loop) resolve();
        }).catch((err) => {
          cleanup();
          reject(new Error(err.name === 'NotAllowedError' ? '请先点击页面后重试' : '播放被阻止'));
        });
      };

      if (!loop) {
        audio.onended = () => {
          cleanup();
          resolve();
        };
      }

      audio.onpause = () => {
        if (loop && currentAudioElement !== audio) {
          cleanup();
          resolve();
        }
      };

      audio.onerror = () => {
        cleanup();
        reject(new Error('音频解码失败'));
      };

      audio.load();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
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

    patchVoiceLoading(MIRROR_HOSTS[0]);

    const onSafari = isSafari() || isIOS();
    const hasWebGPU = !onSafari && typeof navigator !== 'undefined' && 'gpu' in navigator;

    const tryLoadLocal = async (): Promise<{ loaded: boolean; error?: string }> => {
      console.log(`🔊 [Kokoro] 尝试从本地路径加载模型: ${LOCAL_MODEL_PATH}`);
      loadProgress = 5;
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
        ttsInstance = null;
        return { loaded: false, error: msg };
      }
    };

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

  async speak(text: string, voice: string = 'af_heart', loop: boolean = false): Promise<KokoroSpeakResult> {
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
        await playAudioBlob(cachedBlob, loop);
        return { success: true };
      }

      console.log(`🔊 [Kokoro] 生成音频 | [语音] ${voice} | [文本] ${trimmedText.slice(0, 40)}...`);
      const audio = await ttsInstance!.generate(trimmedText, { voice: voice as any });

      const audioBlob = new Blob([audio.audio as any], { type: 'audio/wav' });

      if (audioBlob.size === 0) {
        return { success: false, error: '未生成音频数据' };
      }

      setCachedAudio(trimmedText, voice, audioBlob).then(() => {
        console.log(`🔊 [Kokoro] 音频已缓存 | [大小] ${elevenLabsCacheService.formatSize(audioBlob.size)}`);
      });

      await playAudioBlob(audioBlob, loop);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('🔊 [Kokoro] 生成失败:', msg);
      return { success: false, error: msg };
    }
  },

  stop(): void {
    if (currentAudioElement) {
      currentAudioElement.pause();
      currentAudioElement.src = '';
      currentAudioElement = null;
    }
  },

  getVoices(): KokoroVoice[] {
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
