/**
 * Gemini Service with ElevenLabs + MiniMax + EdgeTTS + Web Speech API
 *
 * TTS 调度策略：
 * 1. 缓存预检：本地缓存 → 云端缓存（仅当前选中引擎）
 * 2. 缓存未命中时，按用户选择的引擎调用 API
 * 3. 引擎失败直接报错，不自动降级
 */

import { TTSEngine } from '../types';
import { elevenLabsService } from './elevenLabsService';
import { edgeTtsService } from './edgeTtsService';
import { storageService } from './storage';
import { mediaSessionService } from './mediaSessionService';
import { continuousAudioPlayer } from './continuousAudioPlayer';
import { ttsCloudCacheService } from './ttsCloudCacheService';
import { dbService } from './dbService';
import { elevenLabsCacheService } from './elevenLabsCacheService';
import { cryptoService } from './cryptoService';

const SPEAK_TIMEOUT = 15000;

/** 解密 API Key（若已加密），未加密时直接返回原值 */
async function decryptApiKey(key: string | undefined): Promise<string> {
  if (!key) return '';
  if (key.startsWith('aes:')) {
    const decrypted = await cryptoService.decrypt(key);
    return decrypted || '';
  }
  return key;
}
const SPEAK_TIMEOUT_PER_CHAR_MS = 250;
const SUGGEST_TIMEOUT = 5000;

const isIOS = (): boolean => {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

interface SpeakTask {
  text: string;
  loop: boolean;
  rate: number;
  resolve: (result: { success: boolean; error?: string }) => void;
  reject: (error: Error) => void;
}

let taskQueue: SpeakTask[] = [];
let isProcessing = false;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let loopActiveFlag = false;
let speakGeneration = 0;
let currentWebSpeechRate: number = 1;
let cachedAudioElement: HTMLAudioElement | null = null;
let cachedAudioGeneration = 0;
let speechSynthesisKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
let cachedAudioObjectUrl: string | null = null;

const revokeCachedAudioUrl = (): void => {
  if (!cachedAudioObjectUrl) return;
  try {
    URL.revokeObjectURL(cachedAudioObjectUrl);
  } catch {
    // ignore cleanup failure
  }
  cachedAudioObjectUrl = null;
};

const playCachedBlob = async (blob: Blob, loop: boolean, rate: number): Promise<boolean> => {
  const ios = isIOS();
  console.log(`🔊 [缓存播放] 开始 | [iOS] ${ios} | [Blob大小] ${blob.size} | [Blob类型] ${blob.type} | [循环] ${loop} | [语速] ${rate}`);

  if (continuousAudioPlayer.isActivated()) {
    try {
      console.log(`🔊 [缓存播放] 使用 continuousAudioPlayer`);
      if (loop) {
        continuousAudioPlayer.getAudioElement().loop = true;
        continuousAudioPlayer.getAudioElement().playbackRate = rate;
        await continuousAudioPlayer.playBlob(blob);
        return true;
      }
      continuousAudioPlayer.getAudioElement().loop = false;
      continuousAudioPlayer.getAudioElement().playbackRate = rate;
      await continuousAudioPlayer.playBlob(blob);
      return true;
    } catch (err) {
      console.warn('🔊 [缓存播放] continuousAudioPlayer 播放失败，回退独立 Audio:', err instanceof Error ? err.message : String(err));
    }
  }

  const gen = ++cachedAudioGeneration;
  const isCurrentGen = () => gen === cachedAudioGeneration;

  if (cachedAudioElement) {
    cachedAudioElement.pause();
    cachedAudioElement.removeAttribute('src');
    cachedAudioElement.load();
    cachedAudioElement = null;
    revokeCachedAudioUrl();
  }

  const url = URL.createObjectURL(blob);
  cachedAudioObjectUrl = url;
  console.log(`🔊 [缓存播放] Blob URL 已创建 | [代数] ${gen}`);
  const audio = new Audio();
  audio.preload = 'auto';
  audio.loop = loop;
  audio.playbackRate = rate;
  cachedAudioElement = audio;
  console.log(`🔊 [缓存播放] Audio 元素已创建 | [iOS] ${ios}`);

  return new Promise((resolve) => {
    let settled = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 200;

    const cleanup = () => {
      console.log(`🔊 [缓存播放] cleanup | [代数] ${gen}`);
      if (cachedAudioElement === audio) cachedAudioElement = null;
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch {
        // ignore cleanup failure
      }
      revokeCachedAudioUrl();
    };

    const attemptPlay = () => {
      if (!isCurrentGen() || settled) return;
      console.log(`🔊 [缓存播放] audio.play() 调用 | [iOS] ${ios} | [readyState] ${audio.readyState} | [paused] ${audio.paused}`);
      audio.play().then(() => {
        console.log(`🔊 [缓存播放] audio.play() 成功`);
        if (loop && !settled) {
          settled = true;
          resolve(true);
        }
      }).catch((err: DOMException) => {
        if (!isCurrentGen() || settled) return;
        console.warn(`🔊 [缓存播放] audio.play() 失败 | [错误名] ${err.name} | [错误信息] ${err.message}`);
        if ((err.name === 'NotAllowedError' || err.name === 'AbortError') && ios && retryCount < MAX_RETRIES) {
          retryCount++;
          console.warn(`🔊 [缓存播放] iOS 重试 ${retryCount}/${MAX_RETRIES}...`);
          setTimeout(attemptPlay, RETRY_DELAY * retryCount);
          return;
        }
        settled = true;
        cleanup();
        resolve(false);
      });
    };

    audio.oncanplay = () => {
      if (!isCurrentGen() || settled) return;
      console.log(`🔊 [缓存播放] oncanplay 触发 | [readyState] ${audio.readyState} | [duration] ${audio.duration}`);
      attemptPlay();
    };

    audio.onloadeddata = () => {
      if (!isCurrentGen() || settled) return;
      console.log(`🔊 [缓存播放] onloadeddata 触发 | [iOS] ${ios} | [readyState] ${audio.readyState} | [duration] ${audio.duration}`);
      if (ios) {
        setTimeout(() => {
          if (!isCurrentGen() || settled) return;
          console.log(`🔊 [缓存播放] iOS onloadeddata 延迟播放 | [readyState] ${audio.readyState}`);
          attemptPlay();
        }, 100);
      }
    };

    if (!loop) {
      audio.onended = () => {
        if (!isCurrentGen()) return;
        console.log(`🔊 [缓存播放] onended 触发 | [代数] ${gen}`);
        settled = true;
        cleanup();
        resolve(true);
      };
    }

    audio.onerror = () => {
      if (!isCurrentGen() || settled) return;
      const mediaError = audio.error;
      console.error(`🔊 [缓存播放] onerror 触发 | [错误码] ${mediaError?.code} | [Blob大小] ${blob.size}`);
      if (ios && retryCount < MAX_RETRIES) {
        retryCount++;
        console.warn(`🔊 [缓存播放] iOS 错误重试 ${retryCount}/${MAX_RETRIES}...`);
          revokeCachedAudioUrl();
        const retryUrl = URL.createObjectURL(blob);
          cachedAudioObjectUrl = retryUrl;
        console.log(`🔊 [缓存播放] onerror 重试 Blob URL 已创建`);
        audio.src = retryUrl;
        audio.load();
        return;
      }
      settled = true;
      cleanup();
      resolve(false);
    };

    audio.src = url;
    console.log(`🔊 [缓存播放] audio.src 已设置 | [iOS] ${ios}`);

    if (ios) {
      setTimeout(() => {
        if (!isCurrentGen() || settled) return;
        console.log(`🔊 [缓存播放] iOS 延迟加载 | [readyState] ${audio.readyState}`);
        if (audio.readyState >= 3) {
          attemptPlay();
        } else {
          console.log(`🔊 [缓存播放] iOS audio.load() 调用`);
          audio.load();
        }
      }, 150);
    }
  });
};

const LOCAL_SENTENCE_BANK = [
  { english: "Could you please clarify that point?", chinese: "能请你澄清一下那一点吗？", tags: ["work", "meeting"] },
  { english: "I'd like to follow up on our last conversation.", chinese: "我想跟进一下我们上次的谈话。", tags: ["work", "business"] },
  { english: "Let's touch base again next week.", chinese: "我们下周再联系。", tags: ["work", "social"] },
  { english: "I'm sorry, I didn't catch that.", chinese: "抱歉，我没听清。", tags: ["social", "communication"] },
  { english: "Could we reschedule our meeting?", chinese: "我们能重新安排会议时间吗？", tags: ["work", "meeting"] },
  { english: "I'm looking forward to our collaboration.", chinese: "我期待我们的合作。", tags: ["business", "work"] },
  { english: "What do you recommend on the menu?", chinese: "菜单上你有什么推荐的吗？", tags: ["food", "travel"] },
  { english: "Could we have the check, please?", chinese: "请买单。", tags: ["food", "travel"] },
  { english: "Is there a pharmacy nearby?", chinese: "这附近有药店吗？", tags: ["travel", "life"] },
  { english: "I'd like to make a reservation for two.", chinese: "我想预订两个人的位子。", tags: ["food", "travel"] },
  { english: "The weather is lovely today, isn't it?", chinese: "今天天气很好，不是吗？", tags: ["social", "smalltalk"] },
  { english: "How have you been lately?", chinese: "你最近怎么样？", tags: ["social", "greeting"] },
  { english: "That sounds like a great plan.", chinese: "听起来是个很棒的计划。", tags: ["social", "agreement"] },
  { english: "I'll get back to you as soon as possible.", chinese: "我会尽快回复你。", tags: ["work", "business"] },
  { english: "Could you give me a hand with this?", chinese: "你能帮我个忙吗？", tags: ["life", "social"] }
];

export interface SpeakResult {
  success: boolean;
  error?: string;
}

const getVoices = (): Promise<SpeechSynthesisVoice[]> => {
  return new Promise((resolve) => {
    let resolved = false;

    const doResolve = (voices: SpeechSynthesisVoice[]) => {
      if (resolved) return;
      resolved = true;
      resolve(voices);
    };

    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      doResolve(voices);
      return;
    }

    window.speechSynthesis.addEventListener('voiceschanged', () => {
      doResolve(window.speechSynthesis.getVoices());
    }, { once: true });

    setTimeout(() => {
      doResolve(window.speechSynthesis.getVoices());
    }, 3000);
  });
};

const selectBestUsVoice = async (): Promise<SpeechSynthesisVoice | null> => {
  const voices = await getVoices();
  const settings = storageService.getSettings();
  
  if (!voices.length) {
    console.warn('未找到任何可用语音');
    return null;
  }

  if (settings.webSpeechVoice) {
    const userVoice = voices.find(v => v.name === settings.webSpeechVoice);
    if (userVoice) {
      console.log(`🎤 ✅ 使用用户选择的语音: ${userVoice.name} | local: ${userVoice.localService}`);
      return userVoice;
    }
    console.warn(`🎤 用户选择的语音 "${settings.webSpeechVoice}" 未找到，回退自动选择`);
  }

  const enVoices = voices.filter(v => v.lang.startsWith('en'));
  const enUsVoices = enVoices.filter(v => v.lang === 'en-US' || v.lang === 'en_US');
  console.log(`🎤 语音诊断: 共${voices.length}个语音, 英语: ${enVoices.length}个, en-US: ${enUsVoices.length}个`);
  enVoices.forEach(v => {
    console.log(`  - ${v.name} | local:${v.localService} | lang:${v.lang}`);
  });

  if (isIOS()) {
    console.log('🎤 iOS 设备，按优先级选择语音...');

    const isEnhanced = (v: SpeechSynthesisVoice) =>
      v.name.includes('Enhanced') || v.name.includes('Premium') || v.name.includes('增强版') || v.name.includes('优化');

    // Samantha 是 macOS/iOS 上质量最高的标准美式英语女声，优先于 Zoe（African American 口音）
    const samanthaEnhanced = enVoices.find(v => v.name.includes('Samantha') && isEnhanced(v));
    if (samanthaEnhanced) {
      console.log('🎤 ✅ iOS 选择 Samantha (Enhanced) 语音:', samanthaEnhanced.name, '| local:', samanthaEnhanced.localService, '| lang:', samanthaEnhanced.lang);
      return samanthaEnhanced;
    }

    const samantha = enVoices.find(v => v.name.includes('Samantha'));
    if (samantha) {
      console.log('🎤 ✅ iOS 选择 Samantha 语音:', samantha.name, '| local:', samantha.localService, '| lang:', samantha.lang);
      return samantha;
    }

    const zoeEnhanced = enVoices.find(v => v.name.includes('Zoe') && isEnhanced(v));
    if (zoeEnhanced) {
      console.log('🎤 ✅ iOS 选择 ZOE (Enhanced) 语音:', zoeEnhanced.name, '| local:', zoeEnhanced.localService, '| lang:', zoeEnhanced.lang);
      return zoeEnhanced;
    }

    const zoeVoice = enVoices.find(v => v.name.includes('Zoe'));
    if (zoeVoice) {
      console.log('🎤 ✅ iOS 选择 ZOE 语音:', zoeVoice.name, '| local:', zoeVoice.localService, '| lang:', zoeVoice.lang);
      return zoeVoice;
    }

    const premiumVoice = enVoices.find(v => isEnhanced(v));
    if (premiumVoice) {
      console.log('🎤 ✅ iOS 选择 Enhanced/Premium 语音:', premiumVoice.name, '| local:', premiumVoice.localService);
      return premiumVoice;
    }

    const alex = enVoices.find(v => v.name.includes('Alex'));
    if (alex) {
      console.log('🎤 ✅ iOS 选择 Alex 语音:', alex.name, '| local:', alex.localService);
      return alex;
    }

    console.warn('🎤 iOS 未找到优选语音，回退通用逻辑');
  }
  
  if (!enUsVoices.length) {
    if (enVoices.length) {
      console.warn('未找到美式英语语音，使用其他英语语音');
      return (
        enVoices.find(v => v.name.includes('Samantha')) ||
        enVoices.find(v => v.localService === true) ||
        enVoices[0]
      );
    }
    console.warn('未找到任何英语语音');
    return null;
  }

  const premiumVoice = enUsVoices.find(v => v.name.includes('Premium') || v.name.includes('Enhanced'));
  if (premiumVoice) {
    console.log('🎤 选择 Premium/Enhanced 语音:', premiumVoice.name);
    return premiumVoice;
  }

  return (
    enUsVoices.find(v => v.name.includes('Samantha')) ||
    enUsVoices.find(v => v.name.includes('Alex')) ||
    enUsVoices.find(v => v.name.includes('Karen')) ||
    enUsVoices.find(v => v.name.includes('Google') && v.localService === false) ||
    enUsVoices.find(v => v.name.includes('Google')) ||
    enUsVoices.find(v => v.name.includes('Microsoft') && v.name.includes('Natural')) ||
    enUsVoices.find(v => v.name.includes('Microsoft')) ||
    enUsVoices.find(v => v.localService === true) ||
    enUsVoices[0]
  );
};

const getPitchForRate = (rate: number): number => {
  if (rate <= 0.3) return 0.90;
  if (rate < 0.5) return 0.95;
  if (rate <= 1.5) return 1.0;
  if (rate <= 2.5) return 1.05;
  return 1.10;
};

const executeSpeak = async (text: string, loop: boolean = false, rate: number = 1): Promise<SpeakResult> => {
  if (!text || typeof text !== 'string' || !text.trim()) {
    console.warn('发音文本为空');
    return { success: false, error: '发音文本为空' };
  }

  if (!('speechSynthesis' in window)) {
    console.warn('此浏览器不支持本地语音合成');
    return { success: false, error: '此浏览器不支持语音合成' };
  }

  window.speechSynthesis.cancel();

  const gen = ++speakGeneration;
  currentWebSpeechRate = rate;

  const utterance = new SpeechSynthesisUtterance(text);
  currentUtterance = utterance;

  const bestVoice = await selectBestUsVoice();
  if (bestVoice) {
    utterance.voice = bestVoice;
    console.log(`🔊 [WebSpeech] 使用语音: ${bestVoice.name} | lang: ${bestVoice.lang} | local: ${bestVoice.localService}`);
  } else {
    utterance.lang = 'en-US';
    console.warn('🔊 [WebSpeech] 未找到合适语音，使用默认 en-US');
  }

  utterance.lang = bestVoice?.lang || 'en-US';
  utterance.rate = rate;
  utterance.pitch = getPitchForRate(rate);
  utterance.volume = 1.0;

  return new Promise((resolve) => {
    let promiseResolved = false;
    let retryCount = 0;
    const MAX_LOOP_RETRIES = 5;
    loopActiveFlag = loop;
    
    const isCurrentGen = () => gen === speakGeneration;

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (currentUtterance === utterance) {
        currentUtterance = null;
      }
    };

    const timeoutMs = Math.max(SPEAK_TIMEOUT, text.length * SPEAK_TIMEOUT_PER_CHAR_MS);
    const timeoutId = setTimeout(() => {
      if (promiseResolved) return;
      promiseResolved = true;
      loopActiveFlag = false;
      window.speechSynthesis.cancel();
      cleanup();
      console.warn('语音合成超时，已取消');
      resolve({ success: false, error: '语音合成超时，请重试' });
    }, loop ? 120000 : timeoutMs);

    const startSpeak = () => {
      if (!isCurrentGen() || (!loopActiveFlag && !promiseResolved)) {
        cleanup();
        promiseResolved = true;
        resolve({ success: true });
        return;
      }
      
      const activeRate = currentWebSpeechRate;
      const pitch = getPitchForRate(activeRate);
      const delay = isIOS() ? 250 : 50;

      setTimeout(() => {
        if (isCurrentGen() && loopActiveFlag && !promiseResolved) {
          const newUtterance = new SpeechSynthesisUtterance(text);
          newUtterance.voice = utterance.voice;
          newUtterance.lang = utterance.lang;
          newUtterance.rate = activeRate;
          newUtterance.pitch = pitch;
          newUtterance.volume = 1.0;
          newUtterance.onend = handleEnd;
          newUtterance.onerror = handleError;
          currentUtterance = newUtterance;
          window.speechSynthesis.speak(newUtterance);
        }
      }, delay);
    };

    const handleEnd = () => {
      if (!isCurrentGen()) return;
      if (promiseResolved) return;
      if (loopActiveFlag) {
        retryCount = 0;
        startSpeak();
        return;
      }
      promiseResolved = true;
      cleanup();
      resolve({ success: true });
    };

    const handleError = (event: SpeechSynthesisErrorEvent) => {
      if (!isCurrentGen()) return;
      if (promiseResolved) return;
      
      if (loopActiveFlag && (event.error === 'interrupted' || event.error === 'canceled') && retryCount < MAX_LOOP_RETRIES) {
        retryCount++;
        const backoffDelay = Math.min(200 * Math.pow(2, retryCount - 1), 3000);
        console.warn(`iOS 循环播放中断 (${event.error})，第 ${retryCount}/${MAX_LOOP_RETRIES} 次重试，延迟 ${backoffDelay}ms...`);
        setTimeout(() => {
          if (isCurrentGen() && loopActiveFlag && !promiseResolved) {
            startSpeak();
          }
        }, backoffDelay);
        return;
      }
      
      promiseResolved = true;
      loopActiveFlag = false;
      cleanup();
      console.warn('语音合成错误:', event.error);
      resolve({ success: false, error: `语音播放失败: ${event.error}` });
    };

    utterance.onend = handleEnd;
    utterance.onerror = handleError;

    if (isIOS()) {
      setTimeout(() => {
        if (isCurrentGen() && !promiseResolved) {
          window.speechSynthesis.speak(utterance);
        }
      }, 100);
    } else {
      window.speechSynthesis.speak(utterance);
    }
  });
};

const processQueue = async () => {
  if (isProcessing || taskQueue.length === 0) return;
  
  isProcessing = true;

  const task = taskQueue.shift()!;
  try {
    const result = await executeSpeak(task.text, task.loop, task.rate);
    task.resolve(result);
  } catch (err) {
    task.reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    isProcessing = false;
    if (taskQueue.length > 0) {
      processQueue();
    }
  }
};

const syncToLocalCache = async (
  text: string,
  blob: Blob,
  engine: 'elevenlabs' | 'minimax',
  settings: ReturnType<typeof storageService.getSettings>
): Promise<void> => {
  const trimmedText = text.trim();
  if (engine === 'elevenlabs') {
    const elVoiceId = settings.elevenLabsVoiceId || elevenLabsService.getDefaultVoiceId();
    const elModelId = elevenLabsService.getDefaultModel();
    elevenLabsCacheService.put(trimmedText, elVoiceId, elModelId, blob).catch(() => {});
  } else {
    try {
      const { minimaxTtsService } = await import('./minimaxTtsService');
      const mmVoiceId = settings.minimaxVoiceId || minimaxTtsService.getDefaultVoiceId();
      minimaxTtsService.setCachedAudio(trimmedText, mmVoiceId, blob).catch(() => {});
    } catch { /* ignore */ }
  }
};

const tryUnifiedCacheFirst = async (
  text: string,
  loop: boolean,
  rate: number,
  settings: ReturnType<typeof storageService.getSettings>,
  engine: TTSEngine
): Promise<SpeakResult | null> => {
  const trimmedText = text.trim();
  if (!trimmedText) return null;

  if (engine === 'edgeTts' || engine === 'webSpeech') return null;

  const elVoiceId = settings.elevenLabsVoiceId || elevenLabsService.getDefaultVoiceId();
  const elModelId = elevenLabsService.getDefaultModel();

  try {
    const elCached = await elevenLabsCacheService.get(trimmedText, elVoiceId, elModelId);
    if (elCached) {
      console.log(`🔊 [缓存] ElevenLabs 本地精确命中 | [语音] ${elVoiceId}`);
      const played = await playCachedBlob(elCached, loop, rate);
      if (played) return { success: true };
    }
  } catch { /* ignore */ }

  try {
    const elFuzzy = await elevenLabsCacheService.findByText(trimmedText);
    if (elFuzzy) {
      console.log(`🔊 [缓存] ElevenLabs 本地模糊命中`);
      const played = await playCachedBlob(elFuzzy, loop, rate);
      if (played) return { success: true };
    }
  } catch { /* ignore */ }

  try {
    const { minimaxTtsService } = await import('./minimaxTtsService');
    const mmVoiceId = settings.minimaxVoiceId || minimaxTtsService.getDefaultVoiceId();
    const mmCached = await minimaxTtsService.getCachedAudio(trimmedText, mmVoiceId);
    if (mmCached) {
      console.log(`🔊 [缓存] MiniMax 本地精确命中 | [语音] ${mmVoiceId}`);
      const played = await playCachedBlob(mmCached, loop, rate);
      if (played) return { success: true };
    }
  } catch { /* ignore */ }

  try {
    const { minimaxTtsService } = await import('./minimaxTtsService');
    const mmFuzzy = await minimaxTtsService.findByText(trimmedText);
    if (mmFuzzy) {
      console.log(`🔊 [缓存] MiniMax 本地模糊命中`);
      const played = await playCachedBlob(mmFuzzy, loop, rate);
      if (played) return { success: true };
    }
  } catch { /* ignore */ }

  try {
    const sentence = await dbService.findByEnglish(trimmedText);
    if (sentence) {
      if (sentence.ttsAudioPathEl) {
        try {
          const cloudBlob = await ttsCloudCacheService.downloadByPath(sentence.ttsAudioPathEl);
          if (cloudBlob) {
            console.log(`🔊 [缓存] ElevenLabs 云端命中 | [路径] ${sentence.ttsAudioPathEl}`);
            syncToLocalCache(trimmedText, cloudBlob, 'elevenlabs', settings);
            const played = await playCachedBlob(cloudBlob, loop, rate);
            if (played) return { success: true };
          }
        } catch { /* ignore */ }
      }
      if (sentence.ttsAudioPathMm) {
        try {
          const cloudBlob = await ttsCloudCacheService.downloadByPath(sentence.ttsAudioPathMm);
          if (cloudBlob) {
            console.log(`🔊 [缓存] MiniMax 云端命中 | [路径] ${sentence.ttsAudioPathMm}`);
            syncToLocalCache(trimmedText, cloudBlob, 'minimax', settings);
            const played = await playCachedBlob(cloudBlob, loop, rate);
            if (played) return { success: true };
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  console.log(`🔊 [缓存] 全部未命中，进入 API 路径`);
  return null;
};

export const geminiService = {
  async speak(text: string, loop: boolean = false): Promise<SpeakResult> {
    mediaSessionService.holdAudioFocus();
    mediaSessionService.updateMetadata(text);
    mediaSessionService.setActionHandlers({
      onPause: () => { geminiService.stop(); },
      onStop: () => { geminiService.stop(); },
    });

    const settings = storageService.getSettings();
    const ttsEngine: TTSEngine = settings.ttsEngine || 'elevenlabs';
    const speechRate = settings.speechRate ?? 1;

    const cacheResult = await tryUnifiedCacheFirst(text, loop, speechRate, settings, ttsEngine);
    if (cacheResult) return cacheResult;

    const tryElevenLabs = async (): Promise<SpeakResult> => {
      const apiKey = await decryptApiKey(settings.elevenLabsApiKey);
      const voiceId = settings.elevenLabsVoiceId || elevenLabsService.getDefaultVoiceId();
      if (!apiKey || !apiKey.trim()) {
        return { success: false, error: '未配置 ElevenLabs API 密钥' };
      }
      try {
        console.log(`🔊 [引擎] ElevenLabs | [语音] ${voiceId} | [循环] ${loop} | [语速] ${speechRate}`);
        const result = await elevenLabsService.speak(text, apiKey, voiceId, loop, undefined, speechRate);
        if (result.success) return result;
        console.warn('🔊 ElevenLabs 播放失败:', result.error);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('🔊 ElevenLabs 出错:', msg);
        return { success: false, error: msg };
      }
    };

    const tryMiniMax = async (): Promise<SpeakResult> => {
      try {
        const { minimaxTtsService } = await import('./minimaxTtsService');
        const apiKey = await decryptApiKey(settings.minimaxApiKey);
        if (!apiKey.trim()) {
          return { success: false, error: '未配置 MiniMax API 密钥' };
        }
        const voiceId = settings.minimaxVoiceId || minimaxTtsService.getDefaultVoiceId();
        console.log(`🔊 [引擎] MiniMax | [语音] ${voiceId} | [循环] ${loop} | [语速] ${speechRate}`);
        const result = await minimaxTtsService.speak(text, apiKey, voiceId, loop, speechRate);
        if (result.success) return { success: true };
        console.warn('🔊 MiniMax 播放失败:', result.error);
        return { success: false, error: result.error };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('🔊 MiniMax 出错:', msg);
        return { success: false, error: msg };
      }
    };

    const tryEdgeTts = async (): Promise<SpeakResult> => {
      try {
        const voice = settings.edgeTtsVoiceId || edgeTtsService.getDefaultVoice();
        const rateSSML = edgeTtsService.speechRateToSSML(speechRate);
        console.log(`🔊 [引擎] EdgeTTS | [语音] ${voice} | [循环] ${loop} | [语速] ${rateSSML}`);
        const result = await edgeTtsService.speak(text, voice, rateSSML, loop, speechRate);
        if (result.success) return { success: true };
        console.warn('🔊 EdgeTTS 播放失败:', result.error);
        return { success: false, error: result.error };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('🔊 EdgeTTS 出错:', msg);
        return { success: false, error: msg };
      }
    };

    const tryWebSpeech = async (): Promise<SpeakResult> => {
      const selectedVoice = await selectBestUsVoice();
      console.log(`🔊 [引擎] Web Speech API | [语音] ${selectedVoice?.name || '默认'} | [local] ${selectedVoice?.localService} | [语速] ${speechRate} | [循环] ${loop}`);
      return new Promise((resolve, reject) => {
        taskQueue.push({ text, loop, rate: speechRate, resolve, reject });
        processQueue();
      });
    };

    if (ttsEngine === 'elevenlabs') {
      const result = await tryElevenLabs();
      if (result.success) return result;
      console.error(`🔊 [ElevenLabs] 调用失败: ${result.error}`);
      return { success: false, error: result.error || 'ElevenLabs 生成失败，不降级' };
    }

    if (ttsEngine === 'minimax') {
      const result = await tryMiniMax();
      if (result.success) return result;
      return { success: false, error: 'MiniMax 生成失败，不降级' };
    }

    if (ttsEngine === 'edgeTts') {
      const result = await tryEdgeTts();
      if (result.success) return result;
      return { success: false, error: 'EdgeTTS 生成失败，不降级' };
    }

    if (ttsEngine === 'webSpeech') {
      return tryWebSpeech();
    }

    return tryWebSpeech();
  },

  stop(): void {
    speakGeneration++;
    cachedAudioGeneration++;
    loopActiveFlag = false;
    elevenLabsService.stop();
    edgeTtsService.stop();
    import('./minimaxTtsService').then(({ minimaxTtsService }) => minimaxTtsService.stop()).catch(() => {});
    window.speechSynthesis.cancel();
    currentUtterance = null;
    taskQueue = [];
    isProcessing = false;
    if (cachedAudioElement) {
      cachedAudioElement.pause();
      cachedAudioElement.removeAttribute('src');
      cachedAudioElement.load();
      cachedAudioElement = null;
    }
    revokeCachedAudioUrl();
    mediaSessionService.stopAll();
  },

  /**
   * 轻量停止：仅停止正在进行的语音合成/播放，不清理 MediaSession 和 silenceAudio 保活。
   * 用于播放循环中的错误恢复，避免打断后台音频保活。
   */
  stopLight(): void {
    speakGeneration++;
    cachedAudioGeneration++;
    loopActiveFlag = false;
    elevenLabsService.stop();
    edgeTtsService.stop();
    import('./minimaxTtsService').then(({ minimaxTtsService }) => minimaxTtsService.stop()).catch(() => {});
    window.speechSynthesis.cancel();
    currentUtterance = null;
    taskQueue = [];
    isProcessing = false;
    if (cachedAudioElement) {
      cachedAudioElement.pause();
      cachedAudioElement.removeAttribute('src');
      cachedAudioElement.load();
      cachedAudioElement = null;
    }
    revokeCachedAudioUrl();
  },

  setPlaybackRate(rate: number): void {
    const clampedRate = Math.max(0.1, Math.min(10, rate));
    currentWebSpeechRate = clampedRate;
    elevenLabsService.setPlaybackRate(clampedRate);
    edgeTtsService.setPlaybackRate(clampedRate);
    import('./minimaxTtsService').then(({ minimaxTtsService }) => minimaxTtsService.setPlaybackRate(clampedRate)).catch(() => {});
    if (currentUtterance) {
      currentUtterance.rate = clampedRate;
      currentUtterance.pitch = getPitchForRate(clampedRate);
    }
    if (cachedAudioElement) {
      cachedAudioElement.playbackRate = clampedRate;
    }
  },

  getAvailableVoices: getVoices,

  getSelectedVoice: selectBestUsVoice,

  getCurrentEngineInfo(): { engine: string; voiceName: string; isLocal: boolean } {
    const settings = storageService.getSettings();
    const ttsEngine: TTSEngine = settings.ttsEngine || 'elevenlabs';
    if (ttsEngine === 'elevenlabs') {
      const voiceId = settings.elevenLabsVoiceId || elevenLabsService.getDefaultVoiceId();
      const apiKey = settings.elevenLabsApiKey;
      // 检查加密或明文 API Key 是否存在
      const hasKey = apiKey && (apiKey.startsWith('aes:') || apiKey.trim());
      if (!hasKey) {
        return { engine: 'ElevenLabs (未配置)', voiceName: '未配置', isLocal: false };
      }
      const popularVoice = elevenLabsService.getPopularVoices().find(v => v.voice_id === voiceId);
      return { engine: 'ElevenLabs', voiceName: popularVoice?.name || voiceId, isLocal: false };
    }
    if (ttsEngine === 'minimax') {
      const voiceId = settings.minimaxVoiceId || 'English_expressive_narrator';
      const miniKey = settings.minimaxApiKey;
      const hasKey = miniKey && (miniKey.startsWith('aes:') || miniKey.trim());
      if (!hasKey) {
        return { engine: 'MiniMax (未配置)', voiceName: '未配置', isLocal: false };
      }
      return { engine: 'MiniMax (直连)', voiceName: voiceId, isLocal: false };
    }
    if (ttsEngine === 'edgeTts') {
      const voice = settings.edgeTtsVoiceId || edgeTtsService.getDefaultVoice();
      const edgeVoice = edgeTtsService.getVoices().find(v => v.shortName === voice);
      return { engine: 'EdgeTTS', voiceName: edgeVoice?.friendlyName || voice, isLocal: false };
    }
    return { engine: 'Web Speech API', voiceName: settings.webSpeechVoice || '自动选择', isLocal: true };
  },

  async suggestSentences(topic: string): Promise<{ english: string; chinese: string }[]> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.warn('句子推荐超时，返回默认结果');
        resolve(LOCAL_SENTENCE_BANK.slice(0, 3).map(({ english, chinese }) => ({ english, chinese })));
      }, SUGGEST_TIMEOUT);

      try {
        const keyword = (topic || '').toLowerCase().trim();
        
        let results = LOCAL_SENTENCE_BANK.filter(item => 
          item.tags.some(tag => tag.includes(keyword)) ||
          item.english.toLowerCase().includes(keyword) ||
          item.chinese.includes(keyword)
        );

        if (results.length === 0) {
          results = [...LOCAL_SENTENCE_BANK].sort(() => 0.5 - Math.random());
        }

        clearTimeout(timeoutId);
        resolve(results.slice(0, 3).map(({ english, chinese }) => ({ english, chinese })));
      } catch (err) {
        clearTimeout(timeoutId);
        resolve(LOCAL_SENTENCE_BANK.slice(0, 3).map(({ english, chinese }) => ({ english, chinese })));
      }
    });
  },

  async fetchAudioBlob(text: string): Promise<Blob | null> {
    if (!text || !text.trim()) return null;

    const settings = storageService.getSettings();
    const ttsEngine: TTSEngine = settings.ttsEngine || 'elevenlabs';
    const trimmedText = text.trim();

    // 第一阶段：精确匹配并行（IndexedDB 读取，几乎无网络开销）
    try {
      const elVoiceId = settings.elevenLabsVoiceId || elevenLabsService.getDefaultVoiceId();
      const elModelId = elevenLabsService.getDefaultModel();
      const { minimaxTtsService } = await import('./minimaxTtsService');
      const mmVoiceId = settings.minimaxVoiceId || minimaxTtsService.getDefaultVoiceId();

      const [elExact, mmExact] = await Promise.all([
        elevenLabsCacheService.get(trimmedText, elVoiceId, elModelId).catch(() => null),
        minimaxTtsService.getCachedAudio(trimmedText, mmVoiceId).catch(() => null),
      ]);
      if (elExact) { console.log(`🔊 [fetchBlob] ElevenLabs 本地精确命中`); return elExact; }
      if (mmExact) { console.log(`🔊 [fetchBlob] MiniMax 本地精确命中`); return mmExact; }
    } catch { /* ignore */ }

    // 第二阶段：模糊匹配 + 云端并行
    try {
      const { minimaxTtsService } = await import('./minimaxTtsService');

      const [elFuzzy, mmFuzzy, cloudSentence] = await Promise.all([
        elevenLabsCacheService.findByText(trimmedText).catch(() => null),
        minimaxTtsService.findByText(trimmedText).catch(() => null),
        dbService.findByEnglish(trimmedText).catch(() => null),
      ]);
      if (elFuzzy) { console.log(`🔊 [fetchBlob] ElevenLabs 本地模糊命中`); return elFuzzy; }
      if (mmFuzzy) { console.log(`🔊 [fetchBlob] MiniMax 本地模糊命中`); return mmFuzzy; }
      if (cloudSentence) {
        if (cloudSentence.ttsAudioPathEl) {
          try {
            const cloudBlob = await ttsCloudCacheService.downloadByPath(cloudSentence.ttsAudioPathEl);
            if (cloudBlob) {
              console.log(`🔊 [fetchBlob] ElevenLabs 云端命中 | [路径] ${cloudSentence.ttsAudioPathEl}`);
              syncToLocalCache(trimmedText, cloudBlob, 'elevenlabs', settings).catch(() => {});
              return cloudBlob;
            }
          } catch { /* ignore */ }
        }
        if (cloudSentence.ttsAudioPathMm) {
          try {
            const cloudBlob = await ttsCloudCacheService.downloadByPath(cloudSentence.ttsAudioPathMm);
            if (cloudBlob) {
              console.log(`🔊 [fetchBlob] MiniMax 云端命中 | [路径] ${cloudSentence.ttsAudioPathMm}`);
              syncToLocalCache(trimmedText, cloudBlob, 'minimax', settings).catch(() => {});
              return cloudBlob;
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    if (ttsEngine === 'minimax') {
      try {
        const { minimaxTtsService } = await import('./minimaxTtsService');
        const apiKey = await decryptApiKey(settings.minimaxApiKey);
        if (!apiKey.trim()) return null;
        const voiceId = settings.minimaxVoiceId || minimaxTtsService.getDefaultVoiceId();
        console.log(`🔊 [fetchBlob] MiniMax | [语音] ${voiceId}`);
        return await minimaxTtsService.fetchAudioBlob(text, apiKey, voiceId);
      } catch (err) {
        console.warn('🔊 [fetchBlob] MiniMax 失败:', err instanceof Error ? err.message : String(err));
        return null;
      }
    }

    if (ttsEngine === 'elevenlabs') {
      const apiKey = await decryptApiKey(settings.elevenLabsApiKey);
      const voiceId = settings.elevenLabsVoiceId || elevenLabsService.getDefaultVoiceId();
      if (!apiKey || !apiKey.trim()) return null;
      try {
        console.log(`🔊 [fetchBlob] ElevenLabs | [语音] ${voiceId}`);
        return await elevenLabsService.fetchAudioBlob(text, apiKey, voiceId, undefined);
      } catch (err) {
        console.warn('🔊 [fetchBlob] ElevenLabs 失败:', err instanceof Error ? err.message : String(err));
        return null;
      }
    }

    if (ttsEngine === 'edgeTts') {
      try {
        const voice = settings.edgeTtsVoiceId || edgeTtsService.getDefaultVoice();
        const speechRate = settings.speechRate ?? 1;
        const rateSSML = edgeTtsService.speechRateToSSML(speechRate);
        console.log(`🔊 [fetchBlob] EdgeTTS | [语音] ${voice}`);
        return await edgeTtsService.fetchAudioBlob(text, voice, rateSSML);
      } catch (err) {
        console.warn('🔊 [fetchBlob] EdgeTTS 失败:', err instanceof Error ? err.message : String(err));
        return null;
      }
    }

    return null;
  },

  startSpeechSynthesisKeepAlive(): void {
    if (speechSynthesisKeepAliveTimer) return;
    if (!isIOS()) return;
    if (!('speechSynthesis' in window)) return;

    console.log('🔊 [speechSynthesis] 启动 iOS 保活定时器');
    speechSynthesisKeepAliveTimer = setInterval(() => {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.resume();
      }
    }, 10000);
  },

  stopSpeechSynthesisKeepAlive(): void {
    if (speechSynthesisKeepAliveTimer) {
      clearInterval(speechSynthesisKeepAliveTimer);
      speechSynthesisKeepAliveTimer = null;
      console.log('🔊 [speechSynthesis] 停止 iOS 保活定时器');
    }
  },
};
