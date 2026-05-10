const API_BASE = 'https://api.ttsmaker.cn/v1';
const DEMO_TOKEN = 'ttsmaker_demo_token';
const CACHE_DB_NAME = 'D3S_TTSMaker_Cache';
const CACHE_STORE_NAME = 'audio_cache';
const CACHE_DB_VERSION = 1;

export interface TTSMakerVoice {
  id: number;
  name: string;
  language: string;
  gender: string;
  limitText: number;
}

export interface TTSMakerSpeakResult {
  success: boolean;
  error?: string;
  fromCache?: boolean;
}

export interface TTSMakerTokenStatus {
  valid: boolean;
  error?: string;
  maxCharacters?: number;
  usedCharacters?: number;
  availableCharacters?: number;
  resetDays?: number;
}

const DEFAULT_VOICES: TTSMakerVoice[] = [
  { id: 663, name: 'David (美式男声·长文本)', language: 'en', gender: 'male', limitText: 50000 },
  { id: 666, name: 'Mia (美式女声·长文本)', language: 'en', gender: 'female', limitText: 50000 },
  { id: 14801, name: 'Alayna v2 (美式女声·快速)', language: 'en', gender: 'female', limitText: 8000 },
  { id: 27001, name: 'Liam v2 (美式男声·快速)', language: 'en', gender: 'male', limitText: 8000 },
  { id: 2594, name: 'Olivia (美式女声)', language: 'en', gender: 'female', limitText: 6000 },
  { id: 2593, name: 'Matthew (美式男声)', language: 'en', gender: 'male', limitText: 6000 },
  { id: 2597, name: 'Aria (美式女声)', language: 'en', gender: 'female', limitText: 6000 },
  { id: 2702, name: 'Ethan (美式男声·长文本)', language: 'en', gender: 'male', limitText: 9000 },
];

let cachedVoices: TTSMakerVoice[] | null = null;
let voicesLoading: Promise<TTSMakerVoice[]> | null = null;

let audioGeneration = 0;
let currentAudioElement: HTMLAudioElement | null = null;

const generateCacheKey = (text: string, voice: number): string => {
  const raw = `${text.trim()}|ttsmaker|${voice}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `tm_${Math.abs(hash).toString(36)}_${raw.length}`;
};

const getCacheDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    request.onerror = () => reject(new Error('TTSMaker缓存数据库打开失败'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'key' });
      }
    };
  });
};

const getCachedAudio = async (text: string, voice: number): Promise<Blob | null> => {
  try {
    const db = await getCacheDB();
    const key = generateCacheKey(text, voice);
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

const setCachedAudio = async (text: string, voice: number, audioBlob: Blob): Promise<void> => {
  try {
    const db = await getCacheDB();
    const key = generateCacheKey(text, voice);
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

export const ttsMakerService = {
  async speak(
    text: string,
    token: string,
    voiceId: number,
    loop: boolean = false,
    rate: number = 1
  ): Promise<TTSMakerSpeakResult> {
    if (!text || !text.trim()) {
      return { success: false, error: '发音文本为空' };
    }

    const effectiveToken = (token && token.trim()) ? token.trim() : DEMO_TOKEN;

    const trimmedText = text.trim();
    const voices = this.getVoices();
    const voice = voices.find(v => v.id === voiceId);
    const maxChars = voice?.limitText || 50000;
    if (trimmedText.length > maxChars) {
      return { success: false, error: `文本过长（限制 ${maxChars} 字符），请分段播放` };
    }

    try {
      const cachedBlob = await getCachedAudio(trimmedText, voiceId);
      if (cachedBlob) {
        console.log(`🔊 [TTSMaker] 缓存命中 | [语音] ${voiceId}`);
        await playAudioBlob(cachedBlob, loop, rate);
        return { success: true, fromCache: true };
      }

      console.log(`🔊 [TTSMaker] 请求合成 | [语音] ${voiceId} | [语速] ${rate} | [文本] ${trimmedText.slice(0, 40)}...`);

      const createResp = await fetch(`${API_BASE}/create-tts-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          token: effectiveToken,
          text: trimmedText,
          voice_id: voiceId,
          audio_format: 'mp3',
          audio_speed: 1,
          audio_volume: 0,
          text_paragraph_pause_time: 0,
        }),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`🔊 [TTSMaker] 创建订单失败 ${createResp.status}: ${errText}`);
        return { success: false, error: `创建订单失败 (${createResp.status})` };
      }

      const createData = await createResp.json();
      console.log('🔊 [TTSMaker] 订单响应:', createData.status, createData.error_details || '');

      if (createData.status !== 'success') {
        const errMsg = createData.error_details || createData.error_code || '订单创建失败';
        if (createData.error_code === 'TOKEN_ERROR') {
          return { success: false, error: 'Token 无效，请检查或更换 Token' };
        }
        if (createData.error_code === 'VOICE_ID_ERROR') {
          console.warn('🔊 [TTSMaker] 语音ID无效，尝试刷新语音列表...');
          cachedVoices = null;
          return { success: false, error: '语音 ID 无效或已下架，请刷新语音列表后重新选择' };
        }
        if (createData.error_code === 'TEXT_LENGTH_ERROR') {
          return { success: false, error: '文本长度无效' };
        }
        if (createData.error_code === 'TOTAL_TOKEN_CHARACTERS_EXCEED_LIMIT') {
          const tokenStatus = createData.token_status;
          const resetDays = tokenStatus?.token_next_reset_time || tokenStatus?.remaining_days_to_reset_quota;
          const resetInfo = resetDays ? `（约 ${Math.ceil(resetDays)} 天后重置）` : '';
          return { success: false, error: `Token 字符配额已用完${resetInfo}，请等待重置或更换 Token` };
        }
        if (createData.error_code === 'TTS_GENERATION_ERROR') {
          return { success: false, error: `语音合成失败：${errMsg}` };
        }
        return { success: false, error: errMsg };
      }

      const audioFileUrl = createData.audio_file_url;
      if (!audioFileUrl) {
        return { success: false, error: '未获取到音频文件地址' };
      }

      console.log(`🔊 [TTSMaker] 下载音频 | [耗时] ${createData.tts_elapsed_time || 'N/A'}`);

      const audioResp = await fetch(audioFileUrl);
      if (!audioResp.ok) {
        return { success: false, error: '音频文件下载失败' };
      }

      const audioBlob = await audioResp.blob();
      if (!audioBlob || audioBlob.size === 0) {
        return { success: false, error: '下载的音频文件为空' };
      }

      console.log(`🔊 [TTSMaker] 合成完成 | [大小] ${formatSize(audioBlob.size)}`);

      setCachedAudio(trimmedText, voiceId, audioBlob).then(() => {
        console.log(`🔊 [TTSMaker] 音频已缓存`);
      });

      await playAudioBlob(audioBlob, loop, rate);
      return { success: true };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { success: false, error: '请求超时，请检查网络连接后重试' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Failed to fetch') {
        return { success: false, error: '网络请求失败，可能存在跨域限制。如在中国大陆，请检查网络代理设置' };
      }
      console.error('🔊 [TTSMaker] 合成失败:', msg);
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

  getVoices(): TTSMakerVoice[] {
    return cachedVoices || DEFAULT_VOICES;
  },

  getDefaultVoiceId(): number {
    return (cachedVoices || DEFAULT_VOICES)[0].id;
  },

  getDemoToken(): string {
    return DEMO_TOKEN;
  },

  async fetchVoices(token?: string, forceRefresh: boolean = false): Promise<TTSMakerVoice[]> {
    if (cachedVoices && !forceRefresh) return cachedVoices;

    if (voicesLoading && !forceRefresh) return voicesLoading;

    if (forceRefresh) {
      cachedVoices = null;
    }

    const effectiveToken = (token && token.trim()) ? token.trim() : DEMO_TOKEN;

    voicesLoading = (async () => {
      try {
        console.log(`🔊 [TTSMaker] ${forceRefresh ? '强制刷新' : '从 API 获取'}语音列表...`);
        const resp = await fetch(`${API_BASE}/get-voice-list?token=${encodeURIComponent(effectiveToken)}&language=en`, {
          method: 'GET',
        });

        if (!resp.ok) {
          console.warn('🔊 [TTSMaker] 获取语音列表失败，使用默认列表');
          return DEFAULT_VOICES;
        }

        const data = await resp.json();

        if (data.status !== 'success' || !data.voices_detailed_list) {
          console.warn('🔊 [TTSMaker] 语音列表响应异常，使用默认列表');
          return DEFAULT_VOICES;
        }

        const apiVoices: TTSMakerVoice[] = data.voices_detailed_list
          .filter((v: { is_need_queue: boolean; text_characters_limit: number }) => !v.is_need_queue && v.text_characters_limit >= 3000)
          .map((v: { id: number; name: string; language: string; gender: number; text_characters_limit: number }) => ({
            id: v.id,
            name: v.name
              .replace(/[\u{1F525}\u{1F1FA}\u{1F1F8}\u{1F1EC}\u{1F1E7}\u{1F1E6}\u{1F1FA}\u{1F1EE}\u{1F1EA}\u{1F1E8}\u{1F1ED}\u{1F1F0}\u{1F1EE}\u{1F1F3}\u{1F1F3}\u{1F1FF}\u{1F1F8}\u{1F1EC}\u{1F1F5}\u{1F1ED}\u{1F1F0}\u{1F1EA}\u{1F1F3}\u{1F1EC}\u{1F1F9}\u{1F1FF}\u{1F1E6}\u{1F467}]/gu, '')
              .replace(/-/g, ' ')
              .replace(/\s+/g, ' ')
              .trim(),
            language: v.language,
            gender: v.gender === 1 ? 'male' : 'female',
            limitText: v.text_characters_limit,
          }))
          .sort((a: TTSMakerVoice, b: TTSMakerVoice) => b.limitText - a.limitText);

        if (apiVoices.length === 0) {
          console.warn('🔊 [TTSMaker] API 返回空语音列表，使用默认列表');
          return DEFAULT_VOICES;
        }

        console.log(`🔊 [TTSMaker] 获取到 ${apiVoices.length} 个语音`);
        cachedVoices = apiVoices;
        return apiVoices;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('🔊 [TTSMaker] 获取语音列表失败:', msg);
        return DEFAULT_VOICES;
      } finally {
        voicesLoading = null;
      }
    })();

    return voicesLoading;
  },

  async checkDemoTokenStatus(): Promise<TTSMakerTokenStatus> {
    return this.validateToken(DEMO_TOKEN);
  },

  async validateToken(token: string): Promise<TTSMakerTokenStatus> {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      return { valid: false, error: 'Token 为空' };
    }

    try {
      console.log('🔊 [TTSMaker] 验证 Token...');
      const resp = await fetch(`${API_BASE}/get-token-status?token=${encodeURIComponent(trimmedToken)}`, {
        method: 'GET',
      });

      const data = await resp.json();

      if (data.status === 'success') {
        const status = data.token_status;
        const available = status?.current_cycle_characters_available ?? status?.token_current_period_characters_available ?? 0;
        const max = status?.current_cycle_max_characters ?? status?.token_max_period_characters ?? 0;
        const used = status?.current_cycle_characters_used ?? status?.token_current_period_characters_used ?? 0;
        const resetDays = status?.remaining_days_to_reset_quota ?? status?.token_next_reset_time ?? 0;

        console.log(`🔊 [TTSMaker] Token 验证通过 | [可用] ${available} / ${max} 字符 | [重置] ${resetDays} 天`);

        if (available <= 0) {
          return {
            valid: true,
            error: `Token 配额已用完（${used}/${max}），约 ${Math.ceil(resetDays)} 天后重置`,
            maxCharacters: max,
            usedCharacters: used,
            availableCharacters: available,
            resetDays,
          };
        }

        return {
          valid: true,
          maxCharacters: max,
          usedCharacters: used,
          availableCharacters: available,
          resetDays,
        };
      }

      if (data.error_code === 'TOKEN_ERROR') {
        return { valid: false, error: 'Token 无效' };
      }

      return { valid: false, error: data.msg || data.error_details || '验证失败' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('🔊 [TTSMaker] Token 验证失败:', msg);
      return { valid: false, error: msg };
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

export default ttsMakerService;
