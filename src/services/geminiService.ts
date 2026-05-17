/**
 * Gemini Service with ElevenLabs + MiniMax + EdgeTTS + Web Speech API
 * 
 * TTS 调度策略：
 * 1. iOS 设备优先使用本地/云端缓存的 ElevenLabs & MiniMax 音频
 * 2. 优先使用 ElevenLabs API（最高质量，缓存后不消耗额度）
 * 3. ElevenLabs 失败时降级到 MiniMax（直连 API，高质量多语言）
 * 4. MiniMax 不可用时降级到 EdgeTTS（微软免费语音，无需密钥）
 * 5. EdgeTTS 不可用时降级到浏览器原生语音（iOS 自动选择最佳音质）
 */

import { elevenLabsService } from './elevenLabsService';
import { edgeTtsService } from './edgeTtsService';
import { storageService } from './storage';
import { mediaSessionService } from './mediaSessionService';
import { ttsCloudCacheService } from './ttsCloudCacheService';
import { dbService } from './dbService';
import { elevenLabsCacheService } from './elevenLabsCacheService';

const SPEAK_TIMEOUT = 10000;
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

const playCachedBlob = async (blob: Blob, loop: boolean, rate: number): Promise<boolean> => {
  const gen = ++cachedAudioGeneration;
  const isCurrentGen = () => gen === cachedAudioGeneration;

  if (cachedAudioElement) {
    cachedAudioElement.pause();
    cachedAudioElement.src = '';
    cachedAudioElement = null;
  }

  const mimeType = blob.type || 'audio/mpeg';
  const url = URL.createObjectURL(new Blob([blob], { type: mimeType }));
  const audio = new Audio();
  audio.preload = 'auto';
  audio.loop = loop;
  audio.playbackRate = rate;
  cachedAudioElement = audio;

  return new Promise((resolve) => {
    let settled = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 200;

    const cleanup = () => {
      if (cachedAudioElement === audio) cachedAudioElement = null;
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    };

    const attemptPlay = () => {
      if (!isCurrentGen() || settled) return;
      audio.play().then(() => {
        if (loop && !settled) {
          settled = true;
          resolve(true);
        }
      }).catch((err: DOMException) => {
        if (!isCurrentGen() || settled) return;
        if ((err.name === 'NotAllowedError' || err.name === 'AbortError') && isIOS() && retryCount < MAX_RETRIES) {
          retryCount++;
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
      attemptPlay();
    };

    audio.onloadeddata = () => {
      if (!isCurrentGen() || settled) return;
      if (isIOS()) {
        setTimeout(() => {
          if (!isCurrentGen() || settled) return;
          attemptPlay();
        }, 100);
      }
    };

    if (!loop) {
      audio.onended = () => {
        if (!isCurrentGen()) return;
        settled = true;
        cleanup();
        resolve(true);
      };
    }

    audio.onerror = () => {
      if (!isCurrentGen() || settled) return;
      if (isIOS() && retryCount < MAX_RETRIES) {
        retryCount++;
        const retryUrl = URL.createObjectURL(new Blob([blob], { type: mimeType }));
        audio.src = retryUrl;
        audio.load();
        return;
      }
      settled = true;
      cleanup();
      resolve(false);
    };

    audio.src = url;

    if (isIOS()) {
      setTimeout(() => {
        if (!isCurrentGen() || settled) return;
        if (audio.readyState >= 3) {
          attemptPlay();
        } else {
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

    const zoeEnhanced = enVoices.find(v => v.name.includes('Zoe') && isEnhanced(v));
    if (zoeEnhanced) {
      console.log('🎤 ✅ iOS 选择 ZOE (Enhanced) 语音:', zoeEnhanced.name, '| local:', zoeEnhanced.localService, '| lang:', zoeEnhanced.lang);
      return zoeEnhanced;
    }

    const samanthaEnhanced = enVoices.find(v => v.name.includes('Samantha') && isEnhanced(v));
    if (samanthaEnhanced) {
      console.log('🎤 ✅ iOS 选择 Samantha (Enhanced) 语音:', samanthaEnhanced.name, '| local:', samanthaEnhanced.localService, '| lang:', samanthaEnhanced.lang);
      return samanthaEnhanced;
    }

    const zoeVoice = enVoices.find(v => v.name.includes('Zoe'));
    if (zoeVoice) {
      console.log('🎤 ✅ iOS 选择 ZOE 语音:', zoeVoice.name, '| local:', zoeVoice.localService, '| lang:', zoeVoice.lang);
      return zoeVoice;
    }

    const samantha = enVoices.find(v => v.name.includes('Samantha'));
    if (samantha) {
      console.log('🎤 ✅ iOS 选择 Samantha 语音:', samantha.name, '| local:', samantha.localService, '| lang:', samantha.lang);
      return samantha;
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

  if (isIOS()) {
    await new Promise(resolve => setTimeout(resolve, 150));
  }

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

    const timeoutId = setTimeout(() => {
      if (promiseResolved) return;
      promiseResolved = true;
      loopActiveFlag = false;
      window.speechSynthesis.cancel();
      cleanup();
      console.warn('语音合成超时，已取消');
      resolve({ success: false, error: '语音合成超时，请重试' });
    }, loop ? 120000 : SPEAK_TIMEOUT);

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

const tryIOSCacheFirst = async (
  text: string,
  loop: boolean,
  rate: number,
  settings: ReturnType<typeof storageService.getSettings>
): Promise<SpeakResult | null> => {
  const trimmedText = text.trim();
  if (!trimmedText) return null;

  const elVoiceId = settings.elevenLabsVoiceId || elevenLabsService.getDefaultVoiceId();
  const elModelId = 'eleven_multilingual_v2';

  try {
    const elCached = await elevenLabsCacheService.get(trimmedText, elVoiceId, elModelId);
    if (elCached) {
      console.log(`🔊 [iOS缓存优先] ElevenLabs本地缓存命中 | [语音] ${elVoiceId}`);
      const played = await playCachedBlob(elCached, loop, rate);
      if (played) return { success: true };
      console.warn('🔊 [iOS缓存优先] ElevenLabs本地缓存播放失败，继续尝试');
    }
  } catch { /* ignore */ }

  try {
    const { minimaxTtsService } = await import('./minimaxTtsService');
    const mmVoiceId = settings.minimaxVoiceId || minimaxTtsService.getDefaultVoiceId();

    const mmCached = await minimaxTtsService.getCachedAudio(trimmedText, mmVoiceId);
    if (mmCached) {
      console.log(`🔊 [iOS缓存优先] MiniMax本地缓存命中 | [语音] ${mmVoiceId}`);
      const played = await playCachedBlob(mmCached, loop, rate);
      if (played) return { success: true };
      console.warn('🔊 [iOS缓存优先] MiniMax本地缓存播放失败，继续尝试');
    }
  } catch { /* ignore */ }

  try {
    const sentence = await dbService.findByEnglish(trimmedText);
    if (sentence) {
      const cloudPaths: Array<{ path: string; engine: string }> = [];
      if (sentence.ttsAudioPathEl) cloudPaths.push({ path: sentence.ttsAudioPathEl, engine: 'ElevenLabs' });
      if (sentence.ttsAudioPathMm) cloudPaths.push({ path: sentence.ttsAudioPathMm, engine: 'MiniMax' });

      for (const { path, engine } of cloudPaths) {
        try {
          const cloudBlob = await ttsCloudCacheService.downloadByPath(path);
          if (cloudBlob) {
            console.log(`🔊 [iOS缓存优先] ${engine}云端缓存命中 | [路径] ${path}`);

            if (engine === 'ElevenLabs') {
              elevenLabsCacheService.put(trimmedText, elVoiceId, elModelId, cloudBlob).catch(() => {});
            } else {
              try {
                const { minimaxTtsService } = await import('./minimaxTtsService');
                const mmVoiceId = settings.minimaxVoiceId || minimaxTtsService.getDefaultVoiceId();
                minimaxTtsService.setCachedAudio?.(trimmedText, mmVoiceId, cloudBlob).catch(() => {});
              } catch { /* ignore */ }
            }

            const played = await playCachedBlob(cloudBlob, loop, rate);
            if (played) return { success: true };
            console.warn(`🔊 [iOS缓存优先] ${engine}云端缓存播放失败，继续尝试`);
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  console.log('🔊 [iOS缓存优先] 本地/云端缓存均未命中，回退到引擎选择');
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
    const ttsEngine = settings.ttsEngine || 'auto';
    const speechRate = settings.speechRate ?? 1;

    if (isIOS()) {
      const iosResult = await tryIOSCacheFirst(text, loop, speechRate, settings);
      if (iosResult) return iosResult;
    }

    const tryElevenLabs = async (): Promise<SpeakResult> => {
      const apiKey = settings.elevenLabsApiKey;
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
        const apiKey = settings.minimaxApiKey || '';
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

    if (ttsEngine === 'auto') {
      const elResult = await tryElevenLabs();
      if (elResult.success) return elResult;
      console.warn('🔊 [auto] ElevenLabs 不可用，回退到 MiniMax');

      const mmResult = await tryMiniMax();
      if (mmResult.success) return mmResult;
      console.warn('🔊 [auto] MiniMax 不可用，回退到 EdgeTTS');

      const edgeResult = await tryEdgeTts();
      if (edgeResult.success) return edgeResult;
      console.warn('🔊 [auto] EdgeTTS 不可用，回退到 Web Speech API');

      return tryWebSpeech();
    }

    if (ttsEngine === 'elevenlabs') {
      const result = await tryElevenLabs();
      if (result.success) return result;
      console.warn('🔊 ElevenLabs 失败，回退到 MiniMax');
      const mmResult = await tryMiniMax();
      if (mmResult.success) return mmResult;
      console.warn('🔊 MiniMax 失败，回退到 EdgeTTS');
      const edgeResult = await tryEdgeTts();
      if (edgeResult.success) return edgeResult;
      console.warn('🔊 EdgeTTS 失败，回退到 Web Speech API');
      return tryWebSpeech();
    }

    if (ttsEngine === 'minimax') {
      const result = await tryMiniMax();
      if (result.success) return result;
      console.warn('🔊 MiniMax 失败，回退到 EdgeTTS');
      const edgeResult = await tryEdgeTts();
      if (edgeResult.success) return edgeResult;
      console.warn('🔊 EdgeTTS 失败，回退到 Web Speech API');
      return tryWebSpeech();
    }

    if (ttsEngine === 'edgeTts') {
      const result = await tryEdgeTts();
      if (result.success) return result;
      console.warn('🔊 EdgeTTS 失败，回退到 Web Speech API');
      return tryWebSpeech();
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
      cachedAudioElement.src = '';
      cachedAudioElement = null;
    }
    mediaSessionService.stopAll();
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
    const ttsEngine = settings.ttsEngine || 'auto';
    if (ttsEngine === 'auto') {
      const apiKey = settings.elevenLabsApiKey;
      if (apiKey && apiKey.trim()) {
        const voiceId = settings.elevenLabsVoiceId || 'JBFqnCBsd6RMkjVDRZzb';
        const popularVoice = elevenLabsService.getPopularVoices().find(v => v.voice_id === voiceId);
        return { engine: '自动 (ElevenLabs → MiniMax → EdgeTTS → Web Speech)', voiceName: popularVoice?.name || voiceId, isLocal: false };
      }
      return { engine: '自动 (MiniMax → EdgeTTS → Web Speech)', voiceName: settings.minimaxVoiceId || 'English_expressive_narrator', isLocal: false };
    }
    if (ttsEngine === 'elevenlabs') {
      const voiceId = settings.elevenLabsVoiceId || 'JBFqnCBsd6RMkjVDRZzb';
      const apiKey = settings.elevenLabsApiKey;
      if (!apiKey || !apiKey.trim()) {
        return { engine: 'ElevenLabs (未配置，将回退)', voiceName: '未配置', isLocal: false };
      }
      const popularVoice = elevenLabsService.getPopularVoices().find(v => v.voice_id === voiceId);
      return { engine: 'ElevenLabs', voiceName: popularVoice?.name || voiceId, isLocal: false };
    }
    if (ttsEngine === 'minimax') {
      const voiceId = settings.minimaxVoiceId || 'English_expressive_narrator';
      if (!settings.minimaxApiKey || !settings.minimaxApiKey.trim()) {
        return { engine: 'MiniMax (未配置，将回退)', voiceName: '未配置', isLocal: false };
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
    const ttsEngine = settings.ttsEngine || 'auto';

    const tryElevenLabsBlob = async (): Promise<Blob | null> => {
      const apiKey = settings.elevenLabsApiKey;
      const voiceId = settings.elevenLabsVoiceId || elevenLabsService.getDefaultVoiceId();
      if (!apiKey || !apiKey.trim()) return null;
      try {
        console.log(`🔊 [fetchBlob] ElevenLabs | [语音] ${voiceId}`);
        return await elevenLabsService.fetchAudioBlob(text, apiKey, voiceId, undefined);
      } catch (err) {
        console.warn('🔊 [fetchBlob] ElevenLabs 失败:', err instanceof Error ? err.message : String(err));
        return null;
      }
    };

    const tryMiniMaxBlob = async (): Promise<Blob | null> => {
      try {
        const { minimaxTtsService } = await import('./minimaxTtsService');
        const apiKey = settings.minimaxApiKey || '';
        if (!apiKey.trim()) return null;
        const voiceId = settings.minimaxVoiceId || minimaxTtsService.getDefaultVoiceId();
        console.log(`🔊 [fetchBlob] MiniMax | [语音] ${voiceId}`);
        return await minimaxTtsService.fetchAudioBlob(text, apiKey, voiceId);
      } catch (err) {
        console.warn('🔊 [fetchBlob] MiniMax 失败:', err instanceof Error ? err.message : String(err));
        return null;
      }
    };

    const tryEdgeTtsBlob = async (): Promise<Blob | null> => {
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
    };

    if (isIOS()) {
      try {
        const sentence = await dbService.findByEnglish(text.trim());
        if (sentence) {
          const cloudPaths: Array<{ path: string; engine: string }> = [];
          if (sentence.ttsAudioPathEl) cloudPaths.push({ path: sentence.ttsAudioPathEl, engine: 'ElevenLabs' });
          if (sentence.ttsAudioPathMm) cloudPaths.push({ path: sentence.ttsAudioPathMm, engine: 'MiniMax' });

          for (const { path } of cloudPaths) {
            try {
              const cloudBlob = await ttsCloudCacheService.downloadByPath(path);
              if (cloudBlob) {
                console.log(`🔊 [fetchBlob] iOS 云端缓存命中 | [路径] ${path}`);
                return cloudBlob;
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }

    if (ttsEngine === 'auto') {
      const elBlob = await tryElevenLabsBlob();
      if (elBlob) return elBlob;

      const mmBlob = await tryMiniMaxBlob();
      if (mmBlob) return mmBlob;

      const edgeBlob = await tryEdgeTtsBlob();
      if (edgeBlob) return edgeBlob;

      return null;
    }

    if (ttsEngine === 'elevenlabs') {
      const elBlob = await tryElevenLabsBlob();
      if (elBlob) return elBlob;
      const mmBlob = await tryMiniMaxBlob();
      if (mmBlob) return mmBlob;
      const edgeBlob = await tryEdgeTtsBlob();
      if (edgeBlob) return edgeBlob;
      return null;
    }

    if (ttsEngine === 'minimax') {
      const mmBlob = await tryMiniMaxBlob();
      if (mmBlob) return mmBlob;
      const edgeBlob = await tryEdgeTtsBlob();
      if (edgeBlob) return edgeBlob;
      return null;
    }

    if (ttsEngine === 'edgeTts') {
      const edgeBlob = await tryEdgeTtsBlob();
      if (edgeBlob) return edgeBlob;
      return null;
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
