/**
 * Kokoro TTS Service
 *
 * 基于 Kokoro-82M 模型的本地 TTS 服务
 * - 82M 参数轻量模型，浏览器本地运行，无需网络
 * - 支持 WebGPU 加速 + WASM 兼容回退
 * - 27 种美式/英式英语语音
 * - 首次加载约 82MB (q8 量化)，后续自动缓存
 */

import { KokoroTTS } from 'kokoro-js';
import { elevenLabsCacheService } from './elevenLabsCacheService';

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

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
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
        }, 60000);
      });
    }

    isLoading = true;
    loadError = null;

    try {
      const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
      const device = hasWebGPU ? 'webgpu' : 'wasm';
      const dtype = hasWebGPU ? 'fp32' : 'q8';

      console.log(`🔊 [Kokoro] 开始加载模型 | [设备] ${device} | [精度] ${dtype}`);
      ttsInstance = await KokoroTTS.from_pretrained(MODEL_ID, { dtype, device } as any);
      console.log('🔊 [Kokoro] 模型加载完成');
      isLoading = false;
      return { loaded: true };
    } catch (err) {
      if (String(err).includes('webgpu') || String(err).includes('WebGPU')) {
        console.warn('🔊 [Kokoro] WebGPU 不可用，回退到 WASM');
        try {
          ttsInstance = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' } as any);
          console.log('🔊 [Kokoro] WASM 模式加载完成');
          isLoading = false;
          return { loaded: true };
        } catch (wasmErr) {
          const msg = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
          console.error('🔊 [Kokoro] WASM 模式也加载失败:', msg);
          loadError = msg;
          isLoading = false;
          return { loaded: false, error: msg };
        }
      }

      const msg = err instanceof Error ? err.message : String(err);
      console.error('🔊 [Kokoro] 模型加载失败:', msg);
      loadError = msg;
      isLoading = false;
      return { loaded: false, error: msg };
    }
  },

  isModelLoaded(): boolean {
    return ttsInstance !== null;
  },

  isLoadingModel(): boolean {
    return isLoading;
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
