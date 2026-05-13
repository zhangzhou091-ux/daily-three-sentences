const CACHE_DB_NAME = 'D3S_MiniMax_Cache';
const CACHE_STORE_NAME = 'audio_cache';
const CACHE_DB_VERSION = 2;
const MAX_CACHE_SIZE = 100 * 1024 * 1024;
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const IOS_PLAYBACK_RETRIES = 3;
const IOS_PLAYBACK_DELAY = 200;

import { ttsCloudCacheService } from './ttsCloudCacheService';
import { isIOSAudio } from './audioUnlockService';

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

interface CacheRecord {
  key: string;
  audioData: ArrayBuffer;
  audioType: string;
  textPreview: string;
  voice: string;
  createdAt: number;
  size: number;
  hitCount: number;
  lastHitAt: number;
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
let activePlaybackAudio: HTMLAudioElement | null = null;
let activeLoopUrls: string[] = [];

const blobToArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('FileReader 未返回 ArrayBuffer'));
      }
    };
    reader.onerror = () => reject(new Error('Blob 转 ArrayBuffer 失败'));
    reader.readAsArrayBuffer(blob);
  });
};

const arrayBufferToBlob = (buffer: ArrayBuffer, type: string): Blob => {
  return new Blob([buffer], { type });
};

const generateCacheKey = (text: string, voice: string): string => {
  const raw = `${text.trim()}|minimax|${voice}`;
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(i);
    hash = hash & hash;
  }
  return `mm_${Math.abs(hash).toString(36)}_${raw.length}`;
};

let dbInstance: IDBDatabase | null = null;
let dbInitPromise: Promise<IDBDatabase> | null = null;

const getCacheDB = (): Promise<IDBDatabase> => {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    request.onerror = () => {
      dbInitPromise = null;
      reject(new Error('MiniMax缓存数据库打开失败'));
    };
    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        const store = db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'key' });
        store.createIndex('voice', 'voice', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('lastHitAt', 'lastHitAt', { unique: false });
      } else if (oldVersion < 2) {
        console.log(`🔊 [MiniMax缓存] 数据库升级 v${oldVersion} → v${CACHE_DB_VERSION}，清理旧格式缓存`);
        const tx = (event.target as IDBOpenDBRequest).transaction;
        if (tx) {
          tx.objectStore(CACHE_STORE_NAME).clear();
        }
      }
    };
    request.onblocked = () => {
      dbInitPromise = null;
    };
  });

  return dbInitPromise;
};

const getCachedAudio = async (text: string, voice: string): Promise<Blob | null> => {
  try {
    const db = await getCacheDB();
    const key = generateCacheKey(text, voice);
    return new Promise((resolve) => {
      const tx = db.transaction([CACHE_STORE_NAME], 'readwrite');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result as CacheRecord | undefined;
        if (!record) { resolve(null); return; }
        if (!record.audioData || !(record.audioData instanceof ArrayBuffer) || record.audioData.byteLength === 0) {
          store.delete(key);
          resolve(null);
          return;
        }
        if (Date.now() - record.lastHitAt > CACHE_TTL) {
          store.delete(key);
          console.log(`🔊 [MiniMax缓存] 过期清理 | [key] ${key}`);
          resolve(null);
          return;
        }
        record.hitCount = (record.hitCount || 0) + 1;
        record.lastHitAt = Date.now();
        try { store.put(record); } catch { /* ignore */ }
        const blob = arrayBufferToBlob(record.audioData, record.audioType || 'audio/mpeg');
        console.log(`🔊 [MiniMax缓存] 命中 | [key] ${key} | [大小] ${formatSize(record.size)} | [命中] ${record.hitCount}次`);
        resolve(blob);
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
};

const getStaleCachedAudio = async (text: string, voice: string): Promise<Blob | null> => {
  try {
    const db = await getCacheDB();
    const key = generateCacheKey(text, voice);
    return new Promise((resolve) => {
      const tx = db.transaction([CACHE_STORE_NAME], 'readonly');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result as CacheRecord | undefined;
        if (!record || !record.audioData || !(record.audioData instanceof ArrayBuffer) || record.audioData.byteLength === 0) {
          resolve(null);
          return;
        }
        const blob = arrayBufferToBlob(record.audioData, record.audioType || 'audio/mpeg');
        const ageDays = Math.round((Date.now() - record.createdAt) / (24 * 60 * 60 * 1000));
        console.log(`🔊 [MiniMax缓存] 陈旧缓存回退 | [key] ${key} | [大小] ${formatSize(record.size)} | [已缓存] ${ageDays}天`);
        resolve(blob);
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
};

const verifyCachedAudio = async (key: string): Promise<boolean> => {
  try {
    const db = await getCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction([CACHE_STORE_NAME], 'readonly');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result as CacheRecord | undefined;
        if (!record || !record.audioData || !(record.audioData instanceof ArrayBuffer) || record.audioData.byteLength === 0) {
          resolve(false);
          return;
        }
        resolve(true);
      };
      request.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
};

const setCachedAudio = async (text: string, voice: string, audioBlob: Blob): Promise<boolean> => {
  try {
    if (!audioBlob || audioBlob.size === 0) {
      console.warn('🔊 [MiniMax缓存] 跳过空音频缓存');
      return false;
    }

    const audioData = await blobToArrayBuffer(audioBlob);
    if (!audioData || audioData.byteLength === 0) {
      console.warn('🔊 [MiniMax缓存] Blob 转 ArrayBuffer 失败，跳过缓存');
      return false;
    }

    const db = await getCacheDB();
    const key = generateCacheKey(text, voice);

    const record: CacheRecord = {
      key,
      audioData,
      audioType: audioBlob.type || 'audio/mpeg',
      textPreview: text.trim().slice(0, 80),
      voice,
      createdAt: Date.now(),
      size: audioData.byteLength,
      hitCount: 0,
      lastHitAt: Date.now(),
    };

    return new Promise((resolve) => {
      const tx = db.transaction([CACHE_STORE_NAME], 'readwrite');
      const store = tx.objectStore(CACHE_STORE_NAME);

      const getAllReq = store.getAll();
      getAllReq.onsuccess = () => {
        const records = getAllReq.result as CacheRecord[];
        let totalSize = 0;
        for (const r of records) {
          totalSize += r.size || 0;
        }

        const existingIdx = records.findIndex(r => r.key === key);
        if (existingIdx >= 0) {
          totalSize -= records[existingIdx].size || 0;
        }

        if (totalSize + record.size > MAX_CACHE_SIZE) {
          const sorted = [...records]
            .filter(r => r.key !== key)
            .sort((a, b) => (a.lastHitAt || a.createdAt) - (b.lastHitAt || b.createdAt));

          let freed = 0;
          const toDelete: string[] = [];
          for (const r of sorted) {
            if (totalSize + record.size - freed <= MAX_CACHE_SIZE * 0.8) break;
            freed += r.size || 0;
            toDelete.push(r.key);
          }

          for (const k of toDelete) {
            store.delete(k);
          }

          if (toDelete.length > 0) {
            console.log(`🔊 [MiniMax缓存] LRU淘汰 ${toDelete.length} 条，释放 ${formatSize(freed)}`);
          }
        }

        const putReq = store.put(record);
        putReq.onsuccess = () => {
          console.log(`🔊 [MiniMax缓存] 已存储 | [key] ${key} | [大小] ${formatSize(record.size)}`);
          if (isIOSAudio()) {
            verifyCachedAudio(key).then((valid) => {
              if (!valid) {
                console.warn('🔊 [MiniMax缓存] iOS 写入验证失败，可能存储空间不足');
              }
            });
          }
          resolve(true);
        };
        putReq.onerror = () => {
          console.warn('🔊 [MiniMax缓存] 写入失败');
          resolve(false);
        };
      };
      getAllReq.onerror = () => {
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve(true);
        putReq.onerror = () => resolve(false);
      };
    });
  } catch (err) {
    console.warn('🔊 [MiniMax缓存] put 异常:', err instanceof Error ? err.message : String(err));
    return false;
  }
};

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
    } catch { /* ignore */ }
    activePlaybackAudio = null;
  }
  if (currentAudioElement) {
    try {
      currentAudioElement.pause();
      currentAudioElement.removeAttribute('src');
      currentAudioElement.load();
    } catch { /* ignore */ }
    currentAudioElement = null;
  }
  revokeAllLoopUrls();
};

const playAudioBlob = async (audioBlob: Blob, loop: boolean = false, rate: number = 1): Promise<void> => {
  const gen = ++audioGeneration;
  const isCurrentGen = () => gen === audioGeneration;

  stopCurrentAudio();

  if (!audioBlob || audioBlob.size === 0) {
    throw new Error('音频数据为空');
  }

  const mimeType = audioBlob.type || 'audio/mpeg';
  const url = URL.createObjectURL(new Blob([audioBlob], { type: mimeType }));
  const audio = new Audio();
  audio.preload = 'auto';
  audio.loop = loop;
  audio.playbackRate = rate;
  currentAudioElement = audio;

  const cleanup = () => {
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

      audio.play().then(() => {
        if (!loop) return;
        if (settled) return;
        doResolve();
      }).catch((playErr: DOMException) => {
        if (!isCurrentGen() || settled) return;

        if (playErr.name === 'NotAllowedError') {
          if (isIOSAudio() && playbackRetryCount < IOS_PLAYBACK_RETRIES) {
            playbackRetryCount++;
            console.warn(`🔊 [MiniMax] iOS 播放被阻止，第 ${playbackRetryCount}/${IOS_PLAYBACK_RETRIES} 次重试...`);
            setTimeout(attemptPlay, IOS_PLAYBACK_DELAY * playbackRetryCount);
            return;
          }
          doReject(new Error('请先点击页面后重试（浏览器安全策略）'));
          return;
        }
        doReject(playErr instanceof Error ? playErr : new Error(String(playErr)));
      });
    };

    audio.oncanplay = () => {
      if (!isCurrentGen() || settled) return;
      attemptPlay();
    };

    audio.onloadeddata = () => {
      if (!isCurrentGen() || settled) return;
      if (isIOSAudio()) {
        setTimeout(() => {
          if (!isCurrentGen() || settled) return;
          attemptPlay();
        }, 100);
      }
    };

    if (!loop) {
      audio.onended = () => {
        if (!isCurrentGen()) return;
        doResolve();
      };
    }

    audio.onerror = () => {
      if (!isCurrentGen() || settled) return;
      const mediaError = audio.error;
      let errorMsg = '音频播放失败';
      if (mediaError) {
        switch (mediaError.code) {
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMsg = '音频格式不支持或资源已被回收';
            break;
          case MediaError.MEDIA_ERR_DECODE:
            errorMsg = '音频解码失败';
            break;
          case MediaError.MEDIA_ERR_NETWORK:
            errorMsg = '音频加载网络错误';
            break;
        }
      }
      doReject(new Error(errorMsg));
    };

    audio.onpause = () => {
      if (loop && currentAudioElement !== audio && !settled) {
        if (activePlaybackAudio === audio) {
          activePlaybackAudio = null;
        }
        doResolve();
      }
    };

    audio.src = url;

    if (isIOSAudio()) {
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
    }, loop ? 120000 : 30000);
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

    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

    try {
      const cachedBlob = await getCachedAudio(trimmedText, voiceId);
      if (cachedBlob) {
        console.log(`🔊 [MiniMax] 本地缓存命中 | [语音] ${voiceId}`);
        try {
          await playAudioBlob(cachedBlob, loop, rate);
          return { success: true, fromCache: true };
        } catch (playErr) {
          const msg = playErr instanceof Error ? playErr.message : String(playErr);
          console.warn(`🔊 [MiniMax] 缓存音频播放失败: ${msg}，重新请求API`);
        }
      }

      if (isOffline) {
        const staleBlob = await getStaleCachedAudio(trimmedText, voiceId);
        if (staleBlob) {
          console.log(`🔊 [MiniMax] 离线状态，使用陈旧缓存播放`);
          try {
            await playAudioBlob(staleBlob, loop, rate);
            return { success: true, fromCache: true };
          } catch (playErr) {
            return { success: false, error: '离线状态且缓存音频无法播放，请连接网络后重试' };
          }
        }
        console.log(`🔊 [MiniMax] 离线状态，跳过云端/API请求`);
        return { success: false, error: '当前处于离线状态，且无可用缓存。请连接网络后重试' };
      }

      const cloudBlob = await ttsCloudCacheService.get(trimmedText, voiceId, 'minimax');
      if (cloudBlob) {
        console.log(`🔊 [MiniMax] 云端缓存命中，下载播放 | [语音] ${voiceId}`);
        setCachedAudio(trimmedText, voiceId, cloudBlob).then(() => {
          console.log(`🔊 [MiniMax] 云端音频已同步到本地缓存`);
        });
        try {
          await playAudioBlob(cloudBlob, loop, rate);
          return { success: true, fromCache: true };
        } catch (playErr) {
          console.warn(`🔊 [MiniMax] 云端缓存播放失败，尝试API请求`);
        }
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

      setCachedAudio(trimmedText, voiceId, audioBlob).then((saved) => {
        if (saved) console.log(`🔊 [MiniMax] 音频已缓存到本地`);
      });

      ttsCloudCacheService.put(trimmedText, voiceId, 'minimax', audioBlob, undefined, rate).then((uploaded) => {
        if (uploaded) console.log(`🔊 [MiniMax] 音频已上传到云端`);
      });

      await playAudioBlob(audioBlob, loop, rate);
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
    if (activePlaybackAudio) {
      activePlaybackAudio.playbackRate = rate;
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
