/**
 * Gemini Service with EdgeTTS
 * 
 * TTS 智能调度策略：
 * 1. 用户选择 edge → 先检测可用性，可用则用 EdgeTTS，不可用则自动回退
 * 2. 用户选择 webSpeech → 直接使用浏览器原生语音
 * 3. EdgeTTS 失败后自动缓存不可用状态（5分钟），避免重复尝试
 */

import { edgeTtsService, checkEdgeTtsAvailability, SpeakResult as EdgeSpeakResult } from './edgeTtsService';
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
    let voices = window.speechSynthesis.getVoices();
    if (voices.length) {
      resolve(voices);
      return;
    }

    let resolved = false;
    const timer = setInterval(() => {
      voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        clearInterval(timer);
        resolved = true;
        resolve(voices);
      }
    }, 100);

    setTimeout(() => {
      if (!resolved) {
        clearInterval(timer);
        console.warn('获取语音列表超时，返回空数组');
        resolve([]);
      }
    }, 3000);

    window.speechSynthesis.addEventListener('voiceschanged', () => {
      if (!resolved) {
        clearInterval(timer);
        resolved = true;
        voices = window.speechSynthesis.getVoices();
        resolve(voices);
      }
    }, { once: true });
  });
};

const selectBestUsVoice = async (): Promise<SpeechSynthesisVoice | null> => {
  const voices = await getVoices();
  
  if (!voices.length) {
    console.warn('未找到任何可用语音');
    return null;
  }

  if (isIOS()) {
    const zoeVoice = voices.find(v =>
      (v.lang === 'en-US' || v.lang === 'en_US') && v.name.includes('Zoe')
    );
    if (zoeVoice) {
      console.log('🎤 iOS 选择 ZOE 语音:', zoeVoice.name);
      return zoeVoice;
    }

    const samantha = voices.find(v =>
      (v.lang === 'en-US' || v.lang === 'en_US') && v.name.includes('Samantha')
    );
    if (samantha) {
      console.log('🎤 iOS 选择 Samantha 语音:', samantha.name);
      return samantha;
    }

    const premiumVoice = voices.find(v =>
      (v.lang === 'en-US' || v.lang === 'en_US') &&
      (v.name.includes('Premium') || v.name.includes('Enhanced'))
    );
    if (premiumVoice) {
      console.log('🎤 iOS 选择 Premium/Enhanced 语音:', premiumVoice.name);
      return premiumVoice;
    }

    const alex = voices.find(v =>
      (v.lang === 'en-US' || v.lang === 'en_US') && v.name.includes('Alex')
    );
    if (alex) {
      console.log('🎤 iOS 选择 Alex 语音:', alex.name);
      return alex;
    }
  }
  
  const usVoices = voices.filter(v => v.lang === 'en-US' || v.lang === 'en_US');
  
  if (!usVoices.length) {
    const enVoices = voices.filter(v => v.lang.startsWith('en'));
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

  const premiumVoice = usVoices.find(v => v.name.includes('Premium') || v.name.includes('Enhanced'));
  if (premiumVoice) {
    console.log('🎤 选择 Premium/Enhanced 语音:', premiumVoice.name);
    return premiumVoice;
  }

  return (
    usVoices.find(v => v.name.includes('Samantha')) ||
    usVoices.find(v => v.name.includes('Alex')) ||
    usVoices.find(v => v.name.includes('Karen')) ||
    usVoices.find(v => v.name.includes('Google') && v.localService === false) ||
    usVoices.find(v => v.name.includes('Google')) ||
    usVoices.find(v => v.name.includes('Microsoft') && v.name.includes('Natural')) ||
    usVoices.find(v => v.name.includes('Microsoft')) ||
    usVoices.find(v => v.localService === true) ||
    usVoices[0]
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
    let loopActive = loop;
    let retryCount = 0;
    const MAX_LOOP_RETRIES = 3;
    
    const cleanup = () => {
      clearTimeout(timeoutId);
      if (currentUtterance === utterance) {
        currentUtterance = null;
      }
    };

    const timeoutId = setTimeout(() => {
      if (promiseResolved) return;
      promiseResolved = true;
      loopActive = false;
      window.speechSynthesis.cancel();
      cleanup();
      console.warn('语音合成超时，已取消');
      resolve({ success: false, error: '语音合成超时，请重试' });
    }, loop ? 120000 : SPEAK_TIMEOUT);

    const startSpeak = () => {
      if (!loopActive && !promiseResolved) {
        cleanup();
        promiseResolved = true;
        resolve({ success: true });
        return;
      }
      
      const pitch = rate < 0.5 ? 0.95 : 1.0;

      if (isIOS()) {
        window.speechSynthesis.cancel();
        setTimeout(() => {
          if (loopActive && !promiseResolved) {
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
        }, 50);
      } else {
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
    };

    const handleEnd = () => {
      if (promiseResolved) return;
      if (loopActive) {
        retryCount = 0;
        startSpeak();
        return;
      }
      promiseResolved = true;
      cleanup();
      resolve({ success: true });
    };

    const handleError = (event: SpeechSynthesisErrorEvent) => {
      if (promiseResolved) return;
      
      if (loopActive && (event.error === 'interrupted' || event.error === 'canceled') && retryCount < MAX_LOOP_RETRIES) {
        retryCount++;
        console.warn(`iOS 循环播放中断，第 ${retryCount} 次重试...`);
        setTimeout(() => {
          if (loopActive && !promiseResolved) {
            startSpeak();
          }
        }, 200);
        return;
      }
      
      promiseResolved = true;
      loopActive = false;
      cleanup();
      console.warn('语音合成错误:', event.error);
      resolve({ success: false, error: `语音播放失败: ${event.error}` });
    };

    utterance.onend = handleEnd;
    utterance.onerror = handleError;

    window.speechSynthesis.speak(utterance);

    if (loop) {
      setTimeout(() => {
        if (!promiseResolved) {
          promiseResolved = true;
        }
      }, 200);
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

export const geminiService = {
  async speak(text: string, voice?: string, loop: boolean = false): Promise<SpeakResult> {
    const settings = storageService.getSettings();
    const ttsEngine = settings.ttsEngine || 'edge';
    const speechRate = settings.speechRate ?? 1;
    
    const edgeRate = speechRate === 0.2 ? '-80%' : speechRate === 0.5 ? '-50%' : '+0%';
    
    if (ttsEngine === 'edge') {
      const isAvailable = await checkEdgeTtsAvailability();
      
      if (isAvailable) {
        try {
          console.log('🔊 使用 EdgeTTS 播放语音...');
          const edgeVoice = voice || settings.edgeVoice;
          const result = await edgeTtsService.speak(text, edgeVoice, edgeRate, loop);
          if (result.success) {
            return result;
          }
          console.warn('EdgeTTS 播放失败，回退到 Web Speech API:', result.error);
        } catch (err) {
          console.warn('EdgeTTS 出错，回退到 Web Speech API:', err);
        }
      } else {
        console.warn('EdgeTTS 不可用（网络限制），自动使用 Web Speech API');
      }
    }
    
    console.log('🔊 使用 Web Speech API 播放语音...');
    return new Promise((resolve, reject) => {
      taskQueue.push({ text, loop, rate: speechRate, resolve, reject });
      processQueue();
    });
  },

  stop(): void {
    edgeTtsService.stop();
    window.speechSynthesis.cancel();
    currentUtterance = null;
    taskQueue = [];
    isProcessing = false;
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
