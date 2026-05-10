const CACHE_DB_NAME = 'D3S_MiniMax_Cache';
const CACHE_STORE_NAME = 'audio_cache';
const CACHE_DB_VERSION = 1;

import { ttsCloudCacheService } from './ttsCloudCacheService';

export interface MiniMaxVoice {
  id: string;
  title: string;
  language: string;
  gender: string;
  description: string;
}

export interface MiniMaxSpeakResult {
  success: boolean;
  error?: string;
  fromCache?: boolean;
}

const API_BASE = 'https://api.minimaxi.com';
const SPEAK_TIMEOUT = 30000;
const VALIDATE_TIMEOUT = 15000;

const RECOMMENDED_VOICES: MiniMaxVoice[] = [
  { id: 'English_expressive_narrator', title: 'Expressive Narrator', language: 'en', gender: 'female', description: '英语表现力旁白，适合朗读' },
  { id: 'English_Trustworth_Man', title: 'Trustworthy Man', language: 'en', gender: 'male', description: '英语可信男声' },
  { id: 'English_CalmWoman', title: 'Calm Woman', language: 'en', gender: 'female', description: '英语沉稳女声' },
  { id: 'English_Gentle-voiced_man', title: 'Gentle Man', language: 'en', gender: 'male', description: '英语温和男声' },
  { id: 'English_Whispering_girl', title: 'Whispering Girl', language: 'en', gender: 'female', description: '英语轻声女声' },
  { id: 'English_CaptivatingStoryteller', title: 'Storyteller', language: 'en', gender: 'female', description: '英语迷人叙述者' },
  { id: 'male-qn-jingying', title: '精英青年', language: 'zh', gender: 'male', description: '中文精英青年音色' },
  { id: 'female-shaonv', title: '少女', language: 'zh', gender: 'female', description: '中文少女音色' },
  { id: 'female-yujie', title: '御姐', language: 'zh', gender: 'female', description: '中文御姐音色' },
  { id: 'female-tianmei', title: '甜美女性', language: 'zh', gender: 'female', description: '中文甜美女性音色' },
  { id: 'male-qn-qingse', title: '青涩青年', language: 'zh', gender: 'male', description: '中文青涩青年音色' },
  { id: 'presenter_female', title: '女性主持人', language: 'zh', gender: 'female', description: '中文女性主持人音色' },
  { id: 'presenter_male', title: '男性主持人', language: 'zh', gender: 'male', description: '中文男性主持人音色' },
  { id: 'audiobook_male_1', title: '有声书男声1', language: 'zh', gender: 'male', description: '中文有声书男声' },
  { id: 'audiobook_female_1', title: '有声书女声1', language: 'zh', gender: 'female', description: '中文有声书女声' },
];

let audioGeneration = 0;
let currentAudioElement: HTMLAudioElement | null = null;

const generateCacheKey = (text: string, voice: string, rate: number): string => {
  const raw = `${text.trim()}|minimax|${voice}|${rate}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `mm_${Math.abs(hash).toString(36)}_${raw.length}`;
};

const getCacheDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    request.onerror = () => reject(new Error('MiniMax缓存数据库打开失败'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'key' });
      }
    };
  });
};

const getCachedAudio = async (text: string, voice: string, rate: number): Promise<Blob | null> => {
  try {
    const db = await getCacheDB();
    const key = generateCacheKey(text, voice, rate);
    return new Promise((resolve) => {
      const tx = db.transaction([CACHE_STORE_NAME], 'readonly');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        resolve(record?.audioBlob || null);
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
};

const setCachedAudio = async (text: string, voice: string, rate: number, audioBlob: Blob): Promise<void> => {
  try {
    const db = await getCacheDB();
    const key = generateCacheKey(text, voice, rate);
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

const stopCurrentAudio = (): void => {
  if (currentAudioElement) {
    try {
      currentAudioElement.pause();
      currentAudioElement.src = '';
      currentAudioElement.load();
    } catch {
      // ignore
    }
    currentAudioElement = null;
  }
};

const playAudioBlob = async (audioBlob: Blob, loop: boolean = false, rate: number = 1): Promise<void> => {
  const gen = ++audioGeneration;
  const isCurrentGen = () => gen === audioGeneration;

  stopCurrentAudio();

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(audioBlob);
    const audio = new Audio(url);
    audio.loop = loop;
    audio.playbackRate = rate;
    currentAudioElement = audio;

    const cleanup = () => {
      if (currentAudioElement === audio) currentAudioElement = null;
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    };

    audio.onended = () => {
      if (!isCurrentGen()) return;
      cleanup();
      resolve();
    };

    audio.onerror = () => {
      if (!isCurrentGen()) return;
      cleanup();
      reject(new Error('音频播放失败'));
    };

    audio.play().then(() => {
      if (!isCurrentGen()) { cleanup(); return; }
      if (loop) {
        resolve();
      }
    }).catch((err) => {
      if (!isCurrentGen()) return;
      cleanup();
      reject(err);
    });
  });
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
};

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export const minimaxTtsService = {
  async speak(
    text: string,
    apiKey: string,
    voiceId: string,
    loop: boolean = false,
    rate: number = 1
  ): Promise<MiniMaxSpeakResult> {
    if (!text || !text.trim()) {
      return { success: false, error: '发音文本为空' };
    }

    if (!apiKey || !apiKey.trim()) {
      return { success: false, error: '未配置 MiniMax API 密钥，请在设置中填写' };
    }

    if (!voiceId) {
      return { success: false, error: '未选择 MiniMax 语音' };
    }

    const trimmedText = text.trim();
    if (trimmedText.length > 10000) {
      return { success: false, error: '文本过长，请分段播放' };
    }

    try {
      const cachedBlob = await getCachedAudio(trimmedText, voiceId, rate);
      if (cachedBlob) {
        console.log(`🔊 [MiniMax] 本地缓存命中 | [语音] ${voiceId}`);
        await playAudioBlob(cachedBlob, loop, 1);
        return { success: true, fromCache: true };
      }

      const cloudBlob = await ttsCloudCacheService.get(trimmedText, voiceId, 'minimax');
      if (cloudBlob) {
        console.log(`🔊 [MiniMax] 云端缓存命中，下载播放 | [语音] ${voiceId}`);
        setCachedAudio(trimmedText, voiceId, rate, cloudBlob).then(() => {
          console.log(`🔊 [MiniMax] 云端音频已同步到本地缓存`);
        });
        await playAudioBlob(cloudBlob, loop, 1);
        return { success: true, fromCache: true };
      }

      console.log(`🔊 [MiniMax] 本地/云端缓存均未命中，请求合成 | [语音] ${voiceId} | [文本] ${trimmedText.slice(0, 40)}...`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SPEAK_TIMEOUT);

      let response: Response;
      try {
        response = await fetch(`${API_BASE}/v1/t2a_v2`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'speech-02-hd',
            text: trimmedText,
            stream: false,
            voice_setting: {
              voice_id: voiceId,
              speed: Math.max(0.5, Math.min(2.0, rate)),
              vol: 1,
              pitch: 0,
            },
            audio_setting: {
              sample_rate: 32000,
              bitrate: 128000,
              format: 'mp3',
              channel: 1,
            },
            language_boost: 'auto',
            output_format: 'hex',
          }),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        if (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') {
          return { success: false, error: '请求超时，请检查网络连接后重试' };
        }
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (msg === 'Failed to fetch') {
          return { success: false, error: '网络请求失败，可能存在跨域限制。如在中国大陆，请检查网络代理设置' };
        }
        return { success: false, error: `网络错误: ${msg}` };
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        let errorMessage = `MiniMax API 错误 (${response.status})`;
        try {
          const errorData = await response.json();
          if (errorData?.base_resp?.status_msg) {
            errorMessage = errorData.base_resp.status_msg;
          } else if (errorData?.message) {
            errorMessage = errorData.message;
          }
        } catch {
          // ignore parse error
        }

        if (response.status === 401) {
          errorMessage = 'MiniMax API 密钥无效，请检查设置';
        } else if (response.status === 429) {
          errorMessage = 'MiniMax API 调用频率超限，请稍后再试';
        } else if (response.status === 402) {
          errorMessage = 'MiniMax API 余额不足，请前往 platform.minimaxi.com 充值';
        }

        console.error(`🔊 [MiniMax] API 返回 ${response.status}:`, errorMessage);
        return { success: false, error: errorMessage };
      }

      const result = await response.json();

      if (result?.base_resp?.status_code !== 0) {
        const errMsg = result?.base_resp?.status_msg || 'MiniMax API 返回错误';
        console.error('🔊 [MiniMax] API base_resp 错误:', errMsg);
        return { success: false, error: errMsg };
      }

      let audioBlob: Blob;

      if (result?.data?.audio) {
        const audioBytes = hexToBytes(result.data.audio);
        audioBlob = new Blob([audioBytes], { type: 'audio/mpeg' });
      } else if (result?.audio_file) {
        const audioBytes = base64ToBytes(result.audio_file);
        audioBlob = new Blob([audioBytes], { type: 'audio/mpeg' });
      } else {
        return { success: false, error: 'MiniMax 返回空音频数据' };
      }

      if (audioBlob.size === 0) {
        return { success: false, error: 'MiniMax 返回空音频数据' };
      }

      console.log(`🔊 [MiniMax] 合成完成 | [大小] ${formatSize(audioBlob.size)}`);

      setCachedAudio(trimmedText, voiceId, rate, audioBlob).then(() => {
        console.log(`🔊 [MiniMax] 音频已缓存到本地`);
      });

      ttsCloudCacheService.put(trimmedText, voiceId, 'minimax', audioBlob).then((uploaded) => {
        if (uploaded) {
          console.log(`🔊 [MiniMax] 音频已上传到云端`);
        }
      });

      await playAudioBlob(audioBlob, loop, 1);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('🔊 [MiniMax] 合成失败:', msg);
      return { success: false, error: msg };
    }
  },

  stop(): void {
    audioGeneration++;
    stopCurrentAudio();
  },

  setPlaybackRate(rate: number): void {
    if (currentAudioElement) {
      currentAudioElement.playbackRate = rate;
    }
  },

  getVoices(): MiniMaxVoice[] {
    return RECOMMENDED_VOICES;
  },

  getDefaultVoiceId(): string {
    return RECOMMENDED_VOICES[0].id;
  },

  isConfigured(): boolean {
    return true;
  },

  async validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    if (!apiKey || !apiKey.trim()) {
      return { valid: false, error: '请输入 MiniMax API 密钥' };
    }

    try {
      console.log('🔊 [MiniMax] 验证 API 密钥...');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT);

      const response = await fetch(`${API_BASE}/v1/t2a_v2`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'speech-02-hd',
          text: 'Hi',
          stream: false,
          voice_setting: {
            voice_id: RECOMMENDED_VOICES[0].id,
            speed: 1,
            vol: 1,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: 'mp3',
            channel: 1,
          },
          language_boost: 'auto',
          output_format: 'hex',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const result = await response.json();
        if (result?.base_resp?.status_code === 0) {
          console.log('🔊 [MiniMax] API 密钥验证通过');
          return { valid: true };
        }
        const errMsg = result?.base_resp?.status_msg || 'MiniMax API 返回错误';
        return { valid: false, error: errMsg };
      }

      let errorMessage = `API 错误 (${response.status})`;
      try {
        const errorData = await response.json();
        if (errorData?.base_resp?.status_msg) {
          errorMessage = errorData.base_resp.status_msg;
        } else if (errorData?.message) {
          errorMessage = errorData.message;
        }
      } catch {
        // ignore
      }

      if (response.status === 401) {
        errorMessage = 'API 密钥无效，请检查密钥是否正确';
      } else if (response.status === 429) {
        console.log('🔊 [MiniMax] 429 限流，密钥有效');
        return { valid: true };
      } else if (response.status === 402) {
        errorMessage = 'API 余额不足，请前往 platform.minimaxi.com 充值';
      }

      return { valid: false, error: errorMessage };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { valid: false, error: '验证请求超时，请检查网络连接' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Failed to fetch') {
        return { valid: false, error: '无法连接 MiniMax API，请检查网络连接或代理设置' };
      }
      return { valid: false, error: `验证失败: ${msg}` };
    }
  },

  async getCacheStats(): Promise<{ count: number; totalSize: number }> {
    try {
      const db = await getCacheDB();
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
      const db = await getCacheDB();
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

  formatSize,
};

export default minimaxTtsService;
