
import { storageService } from "./storage";

/**
 * Mock Gemini Service
 * Currently uses Web Speech API for TTS and local bank for suggestions.
 * TODO: Integrate real Google Gemini API.
 */

const SPEAK_TIMEOUT = 10000;
const SUGGEST_TIMEOUT = 5000;

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

export const geminiService = {
  async speak(text: string): Promise<AudioBuffer | null> {
    if (!('speechSynthesis' in window)) {
      console.warn("此浏览器不支持本地语音合成");
      return null;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const settings = storageService.getSettings();

    const voices = window.speechSynthesis.getVoices();
    
    const usVoice = voices.find(v => 
      (v.lang === 'en-US' || v.lang === 'en_US') && 
      (v.name.includes('Google') || v.name.includes('Premium'))
    ) || voices.find(v => v.lang.includes('en-US'));

    if (usVoice) {
      utterance.voice = usVoice;
    }

    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    utterance.pitch = 1.0;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        window.speechSynthesis.cancel();
        console.warn('语音合成超时，已取消');
        resolve(null);
      }, SPEAK_TIMEOUT);

      utterance.onend = () => {
        clearTimeout(timeoutId);
        resolve(null);
      };

      utterance.onerror = (event) => {
        clearTimeout(timeoutId);
        console.warn('语音合成错误:', event.error);
        resolve(null);
      };

      window.speechSynthesis.speak(utterance);
    });
  },

  async playAudio(buffer: AudioBuffer) {
  },

  async suggestSentences(topic: string): Promise<{ english: string; chinese: string }[]> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.warn('句子推荐超时，返回默认结果');
        resolve(LOCAL_SENTENCE_BANK.slice(0, 3).map(({ english, chinese }) => ({ english, chinese })));
      }, SUGGEST_TIMEOUT);

      try {
        const keyword = topic.toLowerCase().trim();
        
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
