import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Sentence, StudyStep, DictationRecord } from '../types';
import { geminiService } from '../services/geminiService';
import { storageService } from '../services/storageService';

// ———— 常量抽离，方便统一修改 ————
const LEARN_XP = 15;
const DICTATION_XP = 20;
const LEARNED_ANIMATION_DELAY = 800;
const MAX_REVIEW_LEVEL = 10;
// 新增：固定每日学习和复习数量
const DAILY_LEARN_TARGET = 3;
const DAILY_REVIEW_TARGET = 3;

interface StudyPageProps {
  sentences: Sentence[];
  onUpdate: () => Promise<void>;
}

const StudyPage: React.FC<StudyPageProps> = ({ sentences, onUpdate }) => {
  const [activeTab, setActiveTab] = useState<StudyStep>('learn');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [userInput, setUserInput] = useState('');
  const [dictationList, setDictationList] = useState<DictationRecord[]>([]);
  const [targetDictationId, setTargetDictationId] = useState<string | null>(null);
  const [animatingLearnedId, setAnimatingLearnedId] = useState<string | null>(null);
  // ———— 新增：按句子ID记录反馈状态 {句子ID: 是否已反馈} ————
  const [reviewFeedbackStatus, setReviewFeedbackStatus] = useState<Record<string, boolean>>({});
  
  // 防内存泄漏：定时器 ref
  const animationTimerRef = useRef<NodeJS.Timeout | null>(null);

  const settings = useMemo(() => storageService.getSettings(), []);

  const todayStr = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  }, []);

  // ———— 核心修改：每日学习列表生成逻辑（手动句子优先插队） ————
  const dailySelection = useMemo(() => {
    const savedIds = storageService.getTodaySelection();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayDateStr = now.toISOString().split('T')[0]; // 当天日期（YYYY-MM-DD）

    // 1. 处理已保存的今日句子：保留「未掌握」或「当天标记掌握」的句子
    const retainedSentences: Sentence[] = [];
    if (savedIds.length > 0) {
      savedIds.forEach(id => {
        const sentence = sentences.find(s => s.id === id);
        if (!sentence) return;

        // 保留规则：
        // - 未标记掌握（intervalIndex=0）→ 一直保留
        // - 已标记掌握但标记时间是当天 → 当天仍保留，次日移除
        const isLearnedToday = sentence.lastReviewedAt 
          ? new Date(sentence.lastReviewedAt).toISOString().split('T')[0] === todayDateStr 
          : false;
        
        if (sentence.intervalIndex === 0 || isLearnedToday) {
          retainedSentences.push(sentence);
        }
      });
    }

    // 2. 如果保留的句子数量不足3个，补充新句子（核心修改：手动句子优先插队）
    const needSupplementCount = DAILY_LEARN_TARGET - retainedSentences.length;
    if (needSupplementCount > 0) {
      // 筛选可补充的新句子：未掌握、非当天手动添加、未在保留列表中
      const available = sentences.filter(s => {
        // 排除条件：
        // - 已掌握（intervalIndex>0）
        // - 当天手动添加的手动句子（s.isManual && s.addedAt >= todayStart）
        // - 已在保留列表中
        const isInRetained = retainedSentences.some(rs => rs.id === s.id);
        if (s.intervalIndex > 0 || (s.isManual && s.addedAt >= todayStart) || isInRetained) {
          return false;
        }
        return true;
      });

      // ———— 关键修改：拆分手动/导入句子，手动句子优先 ————
      // 2.1 筛选手动录入的可补充句子（优先插队）
      const manualSentences = available.filter(s => s.isManual === true);
      // 2.2 筛选导入的可补充句子
      const importedSentences = available.filter(s => s.isManual === false || s.isManual === undefined);
      
      // 2.3 排序规则：手动句子按添加时间倒序（最新录入的优先），导入句子按添加时间正序
      const sortedManual = manualSentences.sort((a, b) => b.addedAt - a.addedAt); // 最新手动录入的优先
      const sortedImported = importedSentences.sort((a, b) => a.addedAt - b.addedAt); // 最早导入的优先
      
      // 2.4 合并：手动句子在前，导入句子在后，确保手动句子优先补充
      const sortedAll = [...sortedManual, ...sortedImported];
      
      // 2.5 补充所需数量的句子
      const supplementSentences = sortedAll.slice(0, needSupplementCount);
      retainedSentences.push(...supplementSentences);
    }

    // 3. 确保最终列表不超过3个，保存最终的今日句子列表
    const finalSelection = retainedSentences.slice(0, DAILY_LEARN_TARGET);
    if (finalSelection.length > 0) {
      storageService.saveTodaySelection(finalSelection.map(s => s.id));
    }
    
    return finalSelection;
  }, [sentences]);

  // ———— 核心修改：复习队列限制为3个句子 ————
  const reviewQueue = useMemo(() => 
    sentences.filter(s => s.nextReviewDate && s.nextReviewDate <= Date.now())
             .slice(0, DAILY_REVIEW_TARGET) // 截取前3个复习句子
  , [sentences]);

  const dictationPool = useMemo(() => 
    sentences.filter(s => s.intervalIndex > 0)
  , [sentences]);

  // 切换句子/标签时重置翻转
  useEffect(() => {
    setIsFlipped(false);
  }, [currentIndex, activeTab]);

  // ———— 新增：切换到复习标签时重置所有句子的反馈状态 ————
  useEffect(() => {
    if (activeTab === 'review') {
      setReviewFeedbackStatus({});
    }
  }, [activeTab]);

  // 初始化今日默写记录
  useEffect(() => {
    setDictationList(storageService.getTodayDictations());
  }, []);

  // 自动选默写目标
  useEffect(() => {
    if (activeTab === 'dictation' && !targetDictationId && dictationPool.length > 0) {
      pickNewDictationTarget();
    }
  }, [activeTab, targetDictationId, dictationPool]);

  // 清理定时器，防内存泄漏
  useEffect(() => {
    return () => {
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
    };
  }, []);

  const pickNewDictationTarget = () => {
    if (dictationPool.length === 0) return;
    const randomIdx = Math.floor(Math.random() * dictationPool.length);
    setTargetDictationId(dictationPool[randomIdx].id);
    setIsFlipped(false);
    setUserInput('');
  };

  // 播放语音（异常捕获）
  const speak = async (text: string) => {
    if (!text?.trim()) return;
    try {
      await geminiService.speak(text);
    } catch (err) {
      console.warn('语音播放失败', err);
    }
  };

  // 标记掌握
  const handleMarkLearned = async (id: string) => {
    const sentence = sentences.find(s => s.id === id);
    if (!sentence || sentence.intervalIndex > 0) return;

    setAnimatingLearnedId(id);

    try {
      const { nextIndex, nextDate } = storageService.calculateNextReview(0, 'easy');
      const updatedSentence: Sentence = { 
        ...sentence, 
        intervalIndex: nextIndex, 
        nextReviewDate: nextDate,
        lastReviewedAt: Date.now(),
        updatedAt: Date.now()
      };
      
      await storageService.addSentence(updatedSentence);
      
      animationTimerRef.current = setTimeout(async () => {
        try {
          await onUpdate();
          setAnimatingLearnedId(null);
          
          const stats = storageService.getStats();
          stats.totalPoints += LEARN_XP;
          const today = new Date().toISOString().split('T')[0];
          if (stats.lastLearnDate !== today) {
            stats.streak += 1;
            stats.lastLearnDate = today;
          }
          storageService.saveStats(stats);
        } catch (err) {
          console.warn('更新学习数据失败', err);
          setAnimatingLearnedId(null);
        }
      }, LEARNED_ANIMATION_DELAY);
    } catch (err) {
      console.warn('标记掌握失败', err);
      setAnimatingLearnedId(null);
    }
  };

  // ———— 核心修改：复习反馈逻辑 ————
  const handleReviewFeedback = async (id: string, feedback: 'easy' | 'hard' | 'forgot') => {
    // 1. 已反馈则直接返回，防止重复操作
    if (reviewFeedbackStatus[id]) return;
    
    const sentence = sentences.find(s => s.id === id);
    if (!sentence) return;

    try {
      const { nextIndex, nextDate } = storageService.calculateNextReview(
        sentence.intervalIndex, 
        feedback,
        sentence.timesReviewed
      );

      const updated: Sentence = { 
        ...sentence, 
        intervalIndex: nextIndex, 
        nextReviewDate: nextDate,
        lastReviewedAt: Date.now(),
        timesReviewed: (sentence.timesReviewed || 0) + 1,
        updatedAt: Date.now()
      };
      
      // 仅写入本地存储，当天reviewQueue仍基于原始sentences，次日生效
      await storageService.addSentence(updated);
      await onUpdate();
      
      // 2. 标记该句子为已反馈（控制按钮禁用）
      setReviewFeedbackStatus(prev => ({
        ...prev,
        [id]: true
      }));

      // 3. 循环切换到下一句，始终留在复习页（移除跳默写逻辑）
      setCurrentIndex(prev => (prev + 1) % reviewQueue.length);
      // 4. 切换后重置卡片翻转状态
      setIsFlipped(false);
    } catch (err) {
      console.warn('复习保存失败', err);
    }
  };

  // 默写核对（空输入拦截）
  const handleDictationCheck = () => {
    if (!userInput.trim()) {
      alert('请输入默写内容后再核对');
      return;
    }

    const target = sentences.find(s => s.id === targetDictationId);
    if (!target) return;
    
    try {
      const isCorrect = userInput.trim().toLowerCase() === target.english.trim().toLowerCase();
      const newRecord: DictationRecord = {
        sentenceId: target.id,
        status: isCorrect ? 'correct' : 'wrong',
        timestamp: Date.now(),
        isFinished: false
      };
      
      const newList = [newRecord, ...dictationList];
      setDictationList(newList);
      storageService.saveTodayDictations(newList);
      
      if (isCorrect) {
        const stats = storageService.getStats();
        stats.dictationCount = (stats.dictationCount || 0) + 1;
        stats.totalPoints += DICTATION_XP;
        storageService.saveStats(stats);
        setUserInput('');
        setTargetDictationId(null);
      } else {
        setIsFlipped(true);
      }
    } catch (err) {
      console.warn('默写核对失败', err);
    }
  };

  // ———— 安全取值，防止页面报错 ————
  const targetSentence = useMemo(() => 
    sentences.find(s => s.id === targetDictationId) || null
  , [sentences, targetDictationId]);
  
  const currentSentence = dailySelection[currentIndex] || null;
  const isCurrentlyLearned = currentSentence?.intervalIndex > 0;
  const isAnimating = currentSentence && animatingLearnedId === currentSentence.id;
  
  // ———— 新增：当前复习句子及反馈状态（用于按钮禁用） ————
  const currentReviewSentence = reviewQueue[currentIndex] || null;
  const isCurrentReviewSentenceFeedbacked = currentReviewSentence 
    ? reviewFeedbackStatus[currentReviewSentence.id] || false 
    : false;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-700 pb-20">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 px-2">
        <div>
          <p className="text-gray-500 text-xs font-bold uppercase tracking-widest mb-1 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
            {todayStr}
          </p>
          <h2 className="text-3xl font-black tracking-tight text-gray-900 leading-tight">
            你好, {settings.userName}
          </h2>
        </div>
        <div className="flex bg-gray-200/50 p-1.5 rounded-[1.5rem] self-start sm:self-auto backdrop-blur-md">
            {(['learn', 'review', 'dictation'] as StudyStep[]).map(tab => (
            <button
                key={tab}
                onClick={() => { setActiveTab(tab); setCurrentIndex(0); setIsFlipped(false); }}
                className={`px-4 py-2 text-[11px] font-black uppercase tracking-wider rounded-[1.2rem] transition-all duration-300 ${
                activeTab === tab ? 'bg-white shadow-sm text-blue-600' : 'text-gray-400 hover:text-gray-600'
                }`}
            >
                {tab === 'learn' ? '学习' : tab === 'review' ? '复习' : '默写'}
            </button>
            ))}
        </div>
      </div>

      <div className="min-h-[460px]">
        {activeTab === 'learn' && (
          dailySelection.length > 0 ? (
            <div className="space-y-8">
              {/* 核心修改：卡片高度从固定h-[340px]改为min-h-[340px]，允许随内容自动扩展 */}
              <div className="perspective-1000 min-h-[340px] w-full">
                <div 
                  className={`card-inner apple-card ${isFlipped ? 'card-flipped' : ''}`}
                  onClick={() => setIsFlipped(!isFlipped)}
                  style={{ position: 'relative', width: '100%', height: 'auto', transformStyle: 'preserve-3d' }}
                >
                  {/* 学习卡片正面 - 仅调大字号（text-base → text-lg）+ 左对齐修改 + 喇叭按钮居中 */}
                  <div 
                    className={`card-front p-4 transition-all duration-700 ${isCurrentlyLearned || isAnimating ? 'bg-green-50/20' : ''}`}
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'relative', 
                      width: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start', // 文字左对齐
                      justifyContent: 'flex-start',
                      minHeight: '340px',
                      textAlign: 'left' // 文字左对齐
                    }}
                  >
                    {(isCurrentlyLearned || isAnimating) && (
                      <div className="bg-green-100 text-green-600 text-[10px] font-black px-4 py-1.5 rounded-full mb-6 flex items-center gap-2 shadow-sm border border-green-200/50">
                        <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>
                        已进入计划
                      </div>
                    )}
                    
                    <button 
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        if (currentSentence) speak(currentSentence.english); 
                      }}
                      className="w-20 h-20 rounded-full flex items-center justify-center mb-8 shadow-inner transition-all relative bg-blue-50 text-blue-600 hover:scale-110 active:scale-95 z-20 self-center" // 关键：self-center 让按钮居中
                    >
                      <span className="text-3xl">🔊</span>
                      <div className="absolute -inset-1 border-2 border-blue-200/50 rounded-full animate-pulse pointer-events-none"></div>
                    </button>

                    {/* 仅修改：text-base → text-lg（字号大一号），其余样式不变 */}
                    <h3 className="text-lg font-normal text-gray-900 leading-normal mb-4 max-w-full px-0" style={{ wordBreak: 'break-word', textAlign: 'left' }}>
                      {currentSentence?.english || ''}
                    </h3>
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-widest mt-auto animate-bounce self-center">点击卡片翻转显示中文</p>
                  </div>

                  {/* 学习卡片背面 - 仅调大字号（text-base → text-lg）+ 左对齐修改 */}
                  <div 
                    className="card-back p-4 flex flex-col items-start justify-center" // 文字左对齐
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'absolute', 
                      inset: 0,
                      transform: 'rotateY(180deg)',
                      minHeight: '340px',
                      textAlign: 'left' // 文字左对齐
                    }}
                  >
                    {/* 仅修改：text-base → text-lg（字号大一号），其余样式不变 */}
                    <p className="text-lg text-gray-800 font-normal leading-normal px-0" style={{ wordBreak: 'break-word', textAlign: 'left' }}>
                      {currentSentence?.chinese || ''}
                    </p>
                    <div className="mt-10 px-6 py-2 bg-gray-100 rounded-full text-[10px] font-black text-gray-400 uppercase tracking-widest self-center">
                      CHINESE MEANING
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                {!isCurrentlyLearned && !isAnimating ? (
                  <button
                    onClick={() => currentSentence && handleMarkLearned(currentSentence.id)}
                    className="w-full bg-black text-white py-5 rounded-[2rem] font-black text-xl shadow-2xl shadow-black/10 hover:bg-gray-800 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                  >
                    <span>标记掌握</span>
                    <span className="text-sm opacity-50">+{LEARN_XP} XP</span>
                  </button>
                ) : (
                  <button
                    onClick={() => {
                        if (currentIndex < dailySelection.length - 1) {
                            setCurrentIndex(currentIndex + 1);
                        } else {
                            setActiveTab('review');
                        }
                    }}
                    className="w-full bg-green-500 text-white py-5 rounded-[2rem] font-black text-xl shadow-xl shadow-green-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                  >
                    <span>{currentIndex < dailySelection.length - 1 ? '继续下一个' : '前往到期复习'}</span>
                    <span className="text-xl">→</span>
                  </button>
                )}
                
                <div className="flex justify-between items-center px-6">
                    <button 
                      disabled={currentIndex === 0} 
                      onClick={() => setCurrentIndex(currentIndex - 1)} 
                      className={`text-[11px] font-bold uppercase tracking-widest transition-colors ${currentIndex === 0 ? 'text-gray-200' : 'text-gray-400 hover:text-blue-500'}`}
                    >
                      ← Prev
                    </button>
                    <div className="flex items-center gap-2">
                       <span className="text-[11px] text-gray-900 font-black tracking-widest">{currentIndex + 1}</span>
                       <span className="text-[11px] text-gray-300 font-black tracking-widest">/</span>
                       <span className="text-[11px] text-gray-400 font-black tracking-widest">{dailySelection.length}</span>
                    </div>
                    <button 
                      disabled={currentIndex === dailySelection.length - 1} 
                      onClick={() => setCurrentIndex(currentIndex + 1)} 
                      className={`text-[11px] font-bold uppercase tracking-widest transition-colors ${currentIndex === dailySelection.length - 1 ? 'text-gray-200' : 'text-gray-400 hover:text-blue-500'}`}
                    >
                      Next →
                    </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="apple-card p-16 text-center space-y-6">
              <div className="text-7xl">🪴</div>
              <h2 className="text-2xl font-black text-gray-900 tracking-tight">库中暂无可学内容</h2>
              <p className="text-gray-400 font-medium">请到仓库页添加新句子。</p>
            </div>
          )
        )}

        {activeTab === 'review' && (
          reviewQueue.length > 0 ? (
            <div className="space-y-8 animate-in slide-in-from-right-4 duration-500">
              {/* 核心修改：复习卡片高度从固定h-[380px]改为min-h-[380px] */}
              <div className="perspective-1000 min-h-[380px] w-full">
                <div 
                  className={`card-inner apple-card ${isFlipped ? 'card-flipped' : ''}`}
                  onClick={() => setIsFlipped(!isFlipped)}
                  style={{ position: 'relative', width: '100%', height: 'auto', transformStyle: 'preserve-3d' }}
                >
                  {/* 复习卡片正面 - 仅调大字号（text-base → text-lg）+ 左对齐修改 + 喇叭按钮居中 */}
                  <div 
                    className="card-front p-4"
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'relative', 
                      width: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start', // 文字左对齐
                      justifyContent: 'flex-start',
                      minHeight: '380px',
                      textAlign: 'left' // 文字左对齐
                    }}
                  >
                    <div className="absolute top-8 right-10 flex flex-col items-end">
                      <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-1">Level</span>
                      <div className="flex gap-1">
                        {[...Array(MAX_REVIEW_LEVEL)].map((_, i) => (
                          <div 
                            key={i} 
                            className={`w-1.5 h-3 rounded-full ${
                              i < (reviewQueue[currentIndex]?.intervalIndex || 0) 
                                ? 'bg-blue-500 shadow-[0_0_5px_rgba(59,130,246,0.3)]' 
                                : 'bg-gray-100'
                            }`} 
                          />
                        ))}
                      </div>
                    </div>
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-[0.2em] mb-6">科学复习卡片</p>
                    {/* 仅修改：text-base → text-lg（字号大一号），其余样式不变 */}
                    <h3 className="text-lg font-normal text-gray-800 max-w-full leading-normal mb-auto" style={{ wordBreak: 'break-word', textAlign: 'left' }}>
                      {reviewQueue[currentIndex]?.english || ''}
                    </h3>
                    
                    <button 
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        const sen = reviewQueue[currentIndex];
                        if (sen) speak(sen.english); 
                      }}
                      className="mt-6 w-16 h-16 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-2xl hover:scale-110 active:scale-95 transition-all z-20 self-center" // 关键：self-center 让按钮居中
                    >
                      🔊
                    </button>
                    
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-widest mt-6 animate-pulse self-center">点击翻转查看翻译</p>
                  </div>

                  {/* 复习卡片背面 - 仅调大字号（text-base → text-lg）+ 左对齐修改 */}
                  <div 
                    className="card-back p-4 flex flex-col items-start justify-center" // 文字左对齐
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'absolute', 
                      inset: 0,
                      transform: 'rotateY(180deg)',
                      minHeight: '380px',
                      textAlign: 'left' // 文字左对齐
                    }}
                  >
                    {/* 仅修改：text-base → text-lg（字号大一号），其余样式不变 */}
                    <h4 className="text-lg font-normal text-gray-900 leading-normal" style={{ wordBreak: 'break-word', textAlign: 'left' }}>
                      {reviewQueue[currentIndex]?.chinese || ''}
                    </h4>
                    <div className="mt-10 px-6 py-2 bg-blue-50 text-blue-500 px-6 py-2 rounded-full text-[10px] font-black uppercase tracking-[0.2em] self-center">
                      Scientific Review
                    </div>
                  </div>
                </div>
              </div>

              {/* ———— 修改：按钮添加禁用状态，根据当前句子反馈状态控制 ———— */}
              <div className="grid grid-cols-3 gap-4">
                <button 
                  onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 'forgot')} 
                  disabled={isCurrentReviewSentenceFeedbacked}
                  className={`bg-white py-5 rounded-[1.8rem] font-bold shadow-sm border transition-all ${
                    isCurrentReviewSentenceFeedbacked 
                      ? 'text-gray-300 border-gray-100 cursor-not-allowed' 
                      : 'text-red-400 border-red-50 hover:bg-red-50'
                  }`}
                >
                  不记得
                </button>
                <button 
                  onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 'hard')} 
                  disabled={isCurrentReviewSentenceFeedbacked}
                  className={`bg-white py-5 rounded-[1.8rem] font-bold shadow-sm border transition-all ${
                    isCurrentReviewSentenceFeedbacked 
                      ? 'text-gray-300 border-gray-100 cursor-not-allowed' 
                      : 'text-orange-400 border-orange-50 hover:bg-orange-50'
                  }`}
                >
                  有模糊
                </button>
                <button 
                  onClick={() => currentReviewSentence && handleReviewFeedback(currentReviewSentence.id, 'easy')} 
                  disabled={isCurrentReviewSentenceFeedbacked}
                  className={`py-5 rounded-[1.8rem] font-black shadow-xl active:scale-95 transition-all ${
                    isCurrentReviewSentenceFeedbacked 
                      ? 'bg-gray-200 text-gray-400 shadow-none cursor-not-allowed' 
                      : 'bg-blue-600 text-white shadow-blue-200'
                  }`}
                >
                  很简单
                </button>
              </div>

              {/* ———— 新增：复习页手动切换句子按钮（优化体验） ———— */}
              <div className="flex justify-between items-center px-6 mt-4">
                <button 
                  onClick={() => setCurrentIndex(prev => (prev - 1 + reviewQueue.length) % reviewQueue.length)}
                  className="text-[11px] font-bold uppercase tracking-widest text-gray-400 hover:text-blue-500 transition-colors"
                >
                  ← 上一句
                </button>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-900 font-black">{currentIndex + 1}</span>
                  <span className="text-[11px] text-gray-300 font-black">/</span>
                  <span className="text-[11px] text-gray-400 font-black">{reviewQueue.length}</span>
                </div>
                <button 
                  onClick={() => setCurrentIndex(prev => (prev + 1) % reviewQueue.length)}
                  className="text-[11px] font-bold uppercase tracking-widest text-gray-400 hover:text-blue-500 transition-colors"
                >
                  下一句 →
                </button>
              </div>
            </div>
          ) : (
            <div className="apple-card p-16 text-center space-y-6">
              <div className="text-7xl">🌊</div>
              <h2 className="text-2xl font-black text-gray-900 tracking-tight">已完成所有复习</h2>
              <p className="text-gray-400 font-medium">今天的记忆任务已圆满完成。</p>
            </div>
          )
        )}

        {activeTab === 'dictation' && (
          <div className="space-y-10 animate-in slide-in-from-left-4 duration-500">
            {dictationPool.length > 0 ? (
              <div className="apple-card p-4 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-orange-100/30 rounded-full blur-3xl -mr-10 -mt-10" />
                <div className="flex justify-between items-start mb-8">
                  <div>
                    <h3 className="text-xl font-black text-gray-900 tracking-tight">盲听默写</h3>
                    <p className="text-[10px] font-black text-orange-500 uppercase tracking-widest mt-1">Dictation Challenge</p>
                  </div>
                  <button 
                    onClick={pickNewDictationTarget} 
                    className="w-10 h-10 flex items-center justify-center bg-orange-50 text-orange-400 rounded-full hover:bg-orange-100 transition-colors"
                  >
                    🔄
                  </button>
                </div>
                
                {/* 默写卡片提示文字 - 仅调大字号（text-base → text-lg）+ 保持左对齐 */}
                <div className="bg-orange-50/40 p-4 rounded-[2rem] border border-orange-100/50 text-left mb-8">
                  {/* 仅修改：text-base → text-lg（字号大一号），其余样式不变 */}
                  <p className="text-lg font-normal text-gray-700 leading-normal italic" style={{ wordBreak: 'break-word', textAlign: 'left' }}>
                    "{targetSentence?.chinese || '暂无题目'}"
                  </p>
                </div>

                <textarea 
                  value={userInput} 
                  onChange={(e) => setUserInput(e.target.value)} 
                  className="w-full p-8 bg-gray-50 rounded-[2rem] border-none focus:ring-4 focus:ring-orange-100 outline-none min-h-[160px] text-lg font-semibold placeholder:text-gray-300 transition-all" 
                  placeholder="请输入听到的内容..." 
                  style={{ textAlign: 'left' }} // 输入框左对齐
                />

                <div className="grid grid-cols-2 gap-4 mt-8">
                  <button 
                    onClick={() => { 
                      setIsFlipped(!isFlipped); 
                      if(!isFlipped && targetSentence) speak(targetSentence.english); 
                    }} 
                    className="bg-white text-gray-400 py-5 rounded-[2rem] font-bold border border-gray-100 active:scale-95 transition-all"
                  >
                    {isFlipped ? '隐藏答案' : '听音提示'}
                  </button>
                  <button 
                    onClick={handleDictationCheck} 
                    className="bg-orange-500 text-white py-5 rounded-[2rem] font-black text-lg shadow-xl shadow-orange-200 active:scale-95 transition-all"
                  >
                    核对
                  </button>
                </div>

                {isFlipped && targetSentence && (
                  <div className="mt-8 p-4 bg-blue-50 rounded-[2rem] animate-in slide-in-from-top-4">
                    <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2">标准答案</p>
                    {/* 仅修改：text-base → text-lg（字号大一号），其余样式不变 */}
                    <p className="text-blue-800 font-normal text-lg leading-normal" style={{ wordBreak: 'break-word', textAlign: 'left' }}>
                      {targetSentence.english}
                    </p>
                    <button 
                      onClick={() => speak(targetSentence.english)} 
                      className="mt-4 font-bold text-xs flex items-center gap-1.5 text-blue-500 hover:text-blue-700 transition-colors"
                    >
                      <span>🔊</span> 再次播放
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="apple-card p-16 text-center space-y-6">
                <div className="text-7xl">🎯</div>
                <h2 className="text-2xl font-black text-gray-900 tracking-tight">默写挑战未开启</h2>
                <p className="text-gray-400 font-medium">至少学习一个句子后开启。</p>
              </div>
            )}
            
            <div className="space-y-4 pb-10">
              <h4 className="text-[11px] font-black text-gray-400 uppercase tracking-widest ml-4">今日成果 ({dictationList.length})</h4>
              <div className="space-y-3">
                {dictationList.map((item, idx) => {
                  const s = sentences.find(sent => sent.id === item.sentenceId);
                  if (!s) return null;
                  return (
                    <div key={idx} className="apple-card p-5 flex items-center justify-between group bg-white/60 hover:bg-white transition-all">
                      <div className="flex-1 pr-4">
                        <p className="text-sm font-bold text-gray-800 line-clamp-1">{s.english}</p>
                        <p className="text-[10px] text-gray-400 font-medium">{s.chinese}</p>
                      </div>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black ${
                        item.status === 'correct' ? 'bg-green-100 text-green-600' : 'bg-red-50 text-red-400'
                      }`}>
                        {item.status === 'correct' ? '✓' : '×'}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default StudyPage;