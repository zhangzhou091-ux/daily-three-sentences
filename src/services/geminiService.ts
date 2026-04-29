/**
 * Gemini Service with ElevenLabs + Kokoro + Web Speech API
 * 
 * TTS 调度策略：
 * 1. 优先使用 ElevenLabs API（最高质量，缓存后不消耗额度）
 * 2. ElevenLabs 失败时降级到 Kokoro-82M（本地运行，免费无限使用）
 * 3. Kokoro 不可用时降级到浏览器原生语音（iOS 自动选择最佳音质）
 */

import { elevenLabsService } from './elevenLabsService';
import { storageService } from './storage';

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

  if (window.speechSynthesis.paused) {
    window.speechSynthesis.resume();
  }

  if (isIOS()) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const gen = ++speakGeneration;

  const utterance = new SpeechSynthesisUtterance(text);
  currentUtterance = utterance;

  const bestVoice = await selectBestUsVoice();
  if (bestVoice) {
    utterance.voice = bestVoice;
  }

  utterance.lang = 'en-US';
  utterance.rate = rate;
  utterance.pitch = rate < 0.5 ? 0.95 : 1.0;
  utterance.volume = 1.0;

  return new Promise((resolve) => {
    let promiseResolved = false;
    let retryCount = 0;
    const MAX_LOOP_RETRIES = 3;
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
      
      const pitch = rate < 0.5 ? 0.95 : 1.0;
      const delay = isIOS() ? 200 : 50;

      setTimeout(() => {
        if (isCurrentGen() && loopActiveFlag && !promiseResolved) {
          const newUtterance = new SpeechSynthesisUtterance(text);
          newUtterance.voice = utterance.voice;
          newUtterance.lang = 'en-US';
          newUtterance.rate = rate;
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
        console.warn(`iOS 循环播放中断，第 ${retryCount} 次重试...`);
        setTimeout(() => {
          if (isCurrentGen() && loopActiveFlag && !promiseResolved) {
            startSpeak();
          }
        }, 200);
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

    window.speechSynthesis.speak(utterance);
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

export const geminiService = {
  async speak(text: string, voice?: string, loop: boolean = false): Promise<SpeakResult> {
    const settings = storageService.getSettings();
    let ttsEngine = settings.ttsEngine || 'elevenlabs';
    const speechRate = settings.speechRate ?? 1;

    if (ttsEngine === 'elevenlabs') {
      const apiKey = settings.elevenLabsApiKey;
      const voiceId = settings.elevenLabsVoiceId || elevenLabsService.getDefaultVoiceId();

      if (apiKey && apiKey.trim()) {
        try {
          console.log(`🔊 [引擎] ElevenLabs | [语音] ${voiceId} | [循环] ${loop}`);
          const result = await elevenLabsService.speak(text, apiKey, voiceId, loop);
          if (result.success) {
            return result;
          }
          console.warn('ElevenLabs 播放失败，回退到 Kokoro:', result.error);
        } catch (err) {
          console.warn('ElevenLabs 出错，回退到 Kokoro:', err);
        }
      } else {
        console.warn('未配置 ElevenLabs API 密钥，尝试 Kokoro');
      }
    }

    if (ttsEngine === 'elevenlabs' || ttsEngine === 'kokoro') {
      try {
        const { kokoroTtsService: kokoro } = await import('./kokoroTtsService');
        const kokoroVoice = settings.kokoroVoice || kokoro.getDefaultVoiceId();
        console.log(`🔊 [引擎] Kokoro-82M | [语音] ${kokoroVoice} | [循环] ${loop}`);
        const result = await kokoro.speak(text, kokoroVoice, loop);
        if (result.success) {
          return { success: true };
        }
        console.warn('Kokoro 播放失败，回退到浏览器原生语音:', result.error);
      } catch (err) {
        console.warn('Kokoro 出错，回退到浏览器原生语音:', err);
      }
    }
    
    const selectedVoice = await selectBestUsVoice();
    console.log(`🔊 [引擎] Web Speech API | [语音] ${selectedVoice?.name || '默认'} | [local] ${selectedVoice?.localService} | [语速] ${speechRate} | [循环] ${loop}`);
    return new Promise((resolve, reject) => {
      taskQueue.push({ text, loop, rate: speechRate, resolve, reject });
      processQueue();
    });
  },

  stop(): void {
    speakGeneration++;
    loopActiveFlag = false;
    elevenLabsService.stop();
    import('./kokoroTtsService').then(({ kokoroTtsService }) => kokoroTtsService.stop()).catch(() => {});
    window.speechSynthesis.cancel();
    currentUtterance = null;
    taskQueue = [];
    isProcessing = false;
  },

  getAvailableVoices: getVoices,

  getSelectedVoice: selectBestUsVoice,

  getCurrentEngineInfo(): { engine: string; voiceName: string; isLocal: boolean } {
    const settings = storageService.getSettings();
    const ttsEngine = settings.ttsEngine || 'elevenlabs';
    if (ttsEngine === 'elevenlabs') {
      const voiceId = settings.elevenLabsVoiceId || 'JBFqnCBsd6RMkjVDRZzb';
      const apiKey = settings.elevenLabsApiKey;
      if (!apiKey || !apiKey.trim()) {
        return { engine: 'ElevenLabs (未配置，回退)', voiceName: '未配置', isLocal: false };
      }
      const popularVoice = elevenLabsService.getPopularVoices().find(v => v.voice_id === voiceId);
      return { engine: 'ElevenLabs', voiceName: popularVoice?.name || voiceId, isLocal: false };
    }
    if (ttsEngine === 'kokoro') {
      const voiceId = settings.kokoroVoice || 'af_heart';
      return { engine: 'Kokoro-82M', voiceName: voiceId, isLocal: true };
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
  }
};
