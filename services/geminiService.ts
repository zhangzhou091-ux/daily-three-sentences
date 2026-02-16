
import { storageService } from "./storageService";

// 本地静态句库：充当“本地智力中枢”
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
  /**
   * 使用原生 Web Speech API 实现本地 TTS
   * 返回 Promise<null> 以保持与旧代码的调用兼容性
   */
  async speak(text: string): Promise<AudioBuffer | null> {
    if (!('speechSynthesis' in window)) {
      console.warn("此浏览器不支持本地语音合成");
      return null;
    }

    // 取消当前正在播放的语音
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const settings = storageService.getSettings();

    // 筛选美式英语声音
    const voices = window.speechSynthesis.getVoices();
    
    // 尝试寻找高质量美音，如果没有则选第一个 en-US
    const usVoice = voices.find(v => 
      (v.lang === 'en-US' || v.lang === 'en_US') && 
      (v.name.includes('Google') || v.name.includes('Premium'))
    ) || voices.find(v => v.lang.includes('en-US'));

    if (usVoice) {
      utterance.voice = usVoice;
    }

    utterance.lang = 'en-US';
    utterance.rate = 0.9; // 稍慢一点，方便学习
    utterance.pitch = 1.0;

    window.speechSynthesis.speak(utterance);
    
    // 原生 API 播放不需要返回 Buffer 给外部处理
    return null;
  },

  /**
   * 保持兼容性，但不再需要实现逻辑
   */
  async playAudio(buffer: AudioBuffer) {
    // 本地合成在 speak 阶段已完成播放
  },

  /**
   * 本地智力中枢：从内置库中根据关键词进行模糊匹配
   */
  async suggestSentences(topic: string): Promise<{ english: string; chinese: string }[]> {
    const keyword = topic.toLowerCase().trim();
    
    // 简单的关键词/标签匹配算法
    let results = LOCAL_SENTENCE_BANK.filter(item => 
      item.tags.some(tag => tag.includes(keyword)) ||
      item.english.toLowerCase().includes(keyword) ||
      item.chinese.includes(keyword)
    );

    // 如果没搜到，随机给 3 个
    if (results.length === 0) {
      results = [...LOCAL_SENTENCE_BANK].sort(() => 0.5 - Math.random());
    }

    // 仅返回前 3 条，模拟 API 行为
    return results.slice(0, 3).map(({ english, chinese }) => ({ english, chinese }));
  }
};
