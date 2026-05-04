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
 * API文档：https://elevenlabs.io/docs/eleven-api/quickstart
 */

import { elevenLabsCacheService } from './elevenLabsCacheService';

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

const API_BASE = 'https://api.elevenlabs.io';
const DEFAULT_MODEL = 'eleven_v3';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
const SPEAK_TIMEOUT = 15000;
const VOICES_CACHE_TTL = 30 * 60 * 1000;
const VALIDATE_TIMEOUT = 15000;
const VALIDATE_CACHE_TTL = 5 * 60 * 1000;
const API_KEY_PATTERN = /^sk_[a-f0-9]{40,}$/i;

let currentAudioElement: HTMLAudioElement | null = null;
let voicesCache: { voices: ElevenLabsVoice[]; timestamp: number } | null = null;
let validationCache: { key: string; valid: boolean; timestamp: number } | null = null;
let audioGeneration = 0;

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

const playAudioBlob = async (audioBlob: Blob, loop: boolean = false): Promise<void> => {
  return new Promise((resolve, reject) => {
    try {
      const gen = ++audioGeneration;

      if (currentAudioElement) {
        currentAudioElement.pause();
        currentAudioElement.src = '';
        currentAudioElement.load();
        currentAudioElement = null;
      }

      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      audio.loop = loop;
      currentAudioElement = audio;

      const isCurrentGen = () => gen === audioGeneration;

      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (currentAudioElement === audio) currentAudioElement = null;
      };

      audio.oncanplaythrough = () => {
        if (!isCurrentGen()) { cleanup(); resolve(); return; }
        audio.play().then(() => {
          if (loop) resolve();
        }).catch((err) => {
          cleanup();
          reject(new Error(err.name === 'NotAllowedError' ? '请先点击页面后重试' : '播放被阻止'));
        });
      };

      if (!loop) {
        audio.onended = () => {
          if (!isCurrentGen()) return;
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

export const elevenLabsService = {
  async speak(
    text: string,
    apiKey: string,
    voiceId: string,
    loop: boolean = false,
    modelId: string = DEFAULT_MODEL
  ): Promise<SpeakResult> {
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
      const cachedBlob = await elevenLabsCacheService.get(trimmedText, voiceId, modelId);
      if (cachedBlob) {
        console.log(`🔊 [ElevenLabs] 缓存命中，跳过API调用 | [语音] ${voiceId}`);
        await playAudioBlob(cachedBlob, loop);
        return { success: true, fromCache: true };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SPEAK_TIMEOUT);

      const response = await fetch(`${API_BASE}/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey.trim(),
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: trimmedText,
          model_id: modelId,
          output_format: DEFAULT_OUTPUT_FORMAT,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

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

        return { success: false, error: errorMessage };
      }

      const audioBlob = await response.blob();

      if (audioBlob.size === 0) {
        return { success: false, error: '未收到音频数据' };
      }

      elevenLabsCacheService.put(trimmedText, voiceId, modelId, audioBlob).then((saved) => {
        if (saved) {
          console.log(`🔊 [ElevenLabs] 音频已缓存 | [大小] ${elevenLabsCacheService.formatSize(audioBlob.size)}`);
        }
      });

      await playAudioBlob(audioBlob, loop);
      return { success: true, fromCache: false };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { success: false, error: '请求超时，请检查网络连接' };
      }
      if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
        return { success: false, error: '网络连接失败，可能存在跨域限制' };
      }
      const message = err instanceof Error ? err.message : String(err);
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
      console.log('🔊 [ElevenLabs] 使用缓存的验证结果');
      return validationCache.valid
        ? { valid: true }
        : { valid: false, error: 'API 密钥无效（缓存结果）' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT);

      const response = await fetch(`${API_BASE}/v1/user`, {
        method: 'GET',
        headers: {
          'xi-api-key': trimmedKey,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        validationCache = { key: trimmedKey, valid: true, timestamp: Date.now() };
        return { valid: true };
      }

      if (response.status === 401) {
        validationCache = { key: trimmedKey, valid: false, timestamp: Date.now() };
        return { valid: false, error: 'API 密钥无效' };
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.warn('🔊 [ElevenLabs] /v1/user 超时，降级为 TTS 可用性检测');
      } else {
        console.warn('🔊 [ElevenLabs] /v1/user 请求失败，降级为 TTS 可用性检测:', err);
      }
    }

    try {
      console.log('🔊 [ElevenLabs] 降级验证：测试 TTS 接口可用性');
      const testController = new AbortController();
      const testTimeoutId = setTimeout(() => testController.abort(), VALIDATE_TIMEOUT);

      const testResponse = await fetch(`${API_BASE}/v1/text-to-speech/${POPULAR_VOICES[0].voice_id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': trimmedKey,
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: 'Hi',
          model_id: DEFAULT_MODEL,
          output_format: DEFAULT_OUTPUT_FORMAT,
        }),
        signal: testController.signal,
      });

      clearTimeout(testTimeoutId);

      if (testResponse.ok) {
        const testBlob = await testResponse.blob();
        if (testBlob.size > 0) {
          console.log('🔊 [ElevenLabs] TTS 可用性检测通过');
          validationCache = { key: trimmedKey, valid: true, timestamp: Date.now() };
          return { valid: true };
        }
        return { valid: false, error: 'API 返回空音频' };
      }

      if (testResponse.status === 401) {
        validationCache = { key: trimmedKey, valid: false, timestamp: Date.now() };
        return { valid: false, error: 'API 密钥无效' };
      }
      if (testResponse.status === 429) {
        console.log('🔊 [ElevenLabs] 429 限流，密钥有效');
        validationCache = { key: trimmedKey, valid: true, timestamp: Date.now() };
        return { valid: true, error: undefined };
      }

      return { valid: false, error: `TTS 接口异常 (${testResponse.status})` };
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

  stop(): void {
    audioGeneration++;
    if (currentAudioElement) {
      currentAudioElement.pause();
      currentAudioElement.src = '';
      currentAudioElement.load();
      currentAudioElement = null;
    }
  },

  clearVoicesCache(): void {
    voicesCache = null;
  },

  clearValidationCache(): void {
    validationCache = null;
  },
};

export default elevenLabsService;
