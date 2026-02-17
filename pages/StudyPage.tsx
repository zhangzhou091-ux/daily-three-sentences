import React, { useState, useEffect, useMemo } from 'react';
import { Sentence, StudyStep, DictationRecord } from '../types';
import { geminiService } from '../services/geminiService';
import { storageService } from '../services/storageService';
// 新增：导入supabase实例（路径根据你的项目结构，确保正确）
import { supabase } from '../services/supabase';

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
  
  const settings = storageService.getSettings();

  // 新增：Supabase数据测试函数
  async function fetchSupabaseData() {
    try {
      const { data, error } = await supabase
        .from('daily_sentences')  // 对应你创建的表名
        .select('*');             // 读取所有数据
      
      if (error) {
        console.error('❌ Supabase读取数据失败：', error);
        alert('Supabase连接失败！请查看控制台报错');
      } else {
        console.log('✅ Supabase成功读取数据：', data);
        // 可选：如果需要在页面显示数据，可新增state存储
        // setSupabaseData(data);
      }
    } catch (err) {
      console.error('❌ Supabase请求异常：', err);
    }
  }

  // 新增：页面加载时调用Supabase测试函数
  useEffect(() => {
    fetchSupabaseData();
  }, []);

  const todayStr = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  }, []);

  const dailySelection = useMemo(() => {
    const savedIds = storageService.getTodaySelection();
    
    if (savedIds.length > 0) {
      const selected = sentences.filter(s => savedIds.includes(s.id));
      if (selected.length > 0) return selected;
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const available = sentences.filter(s => {
      if (s.intervalIndex > 0) return false;
      if (s.isManual && s.addedAt >= todayStart) return false; 
      return true;
    });

    const sorted = available.sort((a, b) => a.addedAt - b.addedAt);
    const newSelection = sorted.slice(0, settings.dailyTarget);
    
    if (newSelection.length > 0) {
      storageService.saveTodaySelection(newSelection.map(s => s.id));
    }
    
    return newSelection;
  }, [sentences, settings.dailyTarget]);

  const reviewQueue = useMemo(() => 
    sentences.filter(s => s.nextReviewDate && s.nextReviewDate <= Date.now())
  , [sentences]);

  const dictationPool = useMemo(() => 
    sentences.filter(s => s.intervalIndex > 0)
  , [sentences]);

  useEffect(() => {
    setIsFlipped(false);
  }, [currentIndex, activeTab]);

  useEffect(() => {
    setDictationList(storageService.getTodayDictations());
  }, []);

  useEffect(() => {
    if (activeTab === 'dictation' && !targetDictationId && dictationPool.length > 0) {
      pickNewDictationTarget();
    }
  }, [activeTab, targetDictationId, dictationPool]);

  const pickNewDictationTarget = () => {
    if (dictationPool.length === 0) return;
    const randomIdx = Math.floor(Math.random() * dictationPool.length);
    setTargetDictationId(dictationPool[randomIdx].id);
    setIsFlipped(false);
    setUserInput('');
  };

  const speak = async (text: string) => {
    await geminiService.speak(text);
  };

  const handleMarkLearned = async (id: string) => {
    const sentence = sentences.find(s => s.id === id);
    if (!sentence || sentence.intervalIndex > 0) return;

    setAnimatingLearnedId(id);

    const { nextIndex, nextDate } = storageService.calculateNextReview(0, 'easy');
    const updatedSentence = { 
      ...sentence, 
      intervalIndex: nextIndex, 
      nextReviewDate: nextDate,
      lastReviewedAt: Date.now(),
      updatedAt: Date.now()
    };
    
    await storageService.addSentence(updatedSentence);
    
    setTimeout(async () => {
      await onUpdate();
      setAnimatingLearnedId(null);
      
      const stats = storageService.getStats();
      stats.totalPoints += 15;
      const today = new Date().toISOString().split('T')[0];
      if (stats.lastLearnDate !== today) {
          stats.streak += 1;
          stats.lastLearnDate = today;
      }
      storageService.saveStats(stats);
    }, 800);
  };

  const handleReviewFeedback = async (id: string, feedback: 'easy' | 'hard' | 'forgot') => {
    const sentence = sentences.find(s => s.id === id);
    if (!sentence) return;
    
    const { nextIndex, nextDate } = storageService.calculateNextReview(
      sentence.intervalIndex, 
      feedback,
      sentence.timesReviewed
    );

    const updated = { 
      ...sentence, 
      intervalIndex: nextIndex, 
      nextReviewDate: nextDate,
      lastReviewedAt: Date.now(),
      timesReviewed: sentence.timesReviewed + 1,
      updatedAt: Date.now()
    };
    
    await storageService.addSentence(updated);
    await onUpdate();
    
    if (currentIndex < reviewQueue.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      setCurrentIndex(0);
      setActiveTab('dictation');
    }
  };

  const handleDictationCheck = () => {
    const target = sentences.find(s => s.id === targetDictationId);
    if (!target) return;
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
      stats.dictationCount += 1;
      stats.totalPoints += 20;
      storageService.saveStats(stats);
      setUserInput('');
      setTargetDictationId(null);
    } else {
      setIsFlipped(true);
    }
  };

  const targetSentence = sentences.find(s => s.id === targetDictationId);
  const currentSentence = dailySelection[currentIndex];
  const isCurrentlyLearned = currentSentence && currentSentence.intervalIndex > 0;
  const isAnimating = currentSentence && animatingLearnedId === currentSentence.id;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-700 pb-20">
      {/* 新增：Supabase测试提示（不影响原有UI，可选择保留/删除） */}
      <div className="px-2 text-xs text-blue-500 font-bold">
        🔍 Supabase数据同步测试中 → 按F12打开控制台查看结果
      </div>

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
              <div className="perspective-1000 h-[340px] w-full">
                <div 
                  className={`card-inner apple-card ${isFlipped ? 'card-flipped' : ''}`}
                  onClick={() => setIsFlipped(!isFlipped)}
                >
                  <div className={`card-front p-10 transition-all duration-700 ${isCurrentlyLearned || isAnimating ? 'bg-green-50/20' : ''}`}>
                    {(isCurrentlyLearned || isAnimating) && (
                      <div className="bg-green-100 text-green-600 text-[10px] font-black px-4 py-1.5 rounded-full mb-6 flex items-center gap-2 shadow-sm border border-green-200/50">
                        <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>
                        已进入计划
                      </div>
                    )}
                    
                    <button 
                      onClick={(e) => { e.stopPropagation(); speak(dailySelection[currentIndex].english); }}
                      className="w-20 h-20 rounded-full flex items-center justify-center mb-8 shadow-inner transition-all relative bg-blue-50 text-blue-600 hover:scale-110 active:scale-95 z-20"
                    >
                      <span className="text-3xl">🔊</span>
                      <div className="absolute -inset-1 border-2 border-blue-200/50 rounded-full animate-pulse pointer-events-none"></div>
                    </button>

                    <h3 className="text-2xl font-black text-gray-900 leading-tight mb-2 max-w-sm px-4">
                      {dailySelection[currentIndex].english}
                    </h3>
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-widest mt-6 animate-bounce">点击卡片翻转显示中文</p>
                  </div>

                  <div className="card-back p-10 flex flex-col items-center justify-center">
                    <p className="text-2xl text-gray-800 font-bold leading-relaxed px-6">
                      {dailySelection[currentIndex].chinese}
                    </p>
                    <div className="mt-10 px-6 py-2 bg-gray-100 rounded-full text-[10px] font-black text-gray-400 uppercase tracking-widest">
                      CHINESE MEANING
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                {!isCurrentlyLearned && !isAnimating ? (
                  <button
                    onClick={() => handleMarkLearned(dailySelection[currentIndex].id)}
                    className="w-full bg-black text-white py-5 rounded-[2rem] font-black text-xl shadow-2xl shadow-black/10 hover:bg-gray-800 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                  >
                    <span>标记掌握</span>
                    <span className="text-sm opacity-50">+15 XP</span>
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
                    <button disabled={currentIndex === 0} onClick={() => setCurrentIndex(currentIndex - 1)} className={`text-[11px] font-bold uppercase tracking-widest transition-colors ${currentIndex === 0 ? 'text-gray-200' : 'text-gray-400 hover:text-blue-500'}`}>← Prev</button>
                    <div className="flex items-center gap-2">
                       <span className="text-[11px] text-gray-900 font-black tracking-widest">{currentIndex + 1}</span>
                       <span className="text-[11px] text-gray-300 font-black tracking-widest">/</span>
                       <span className="text-[11px] text-gray-400 font-black tracking-widest">{dailySelection.length}</span>
                    </div>
                    <button disabled={currentIndex === dailySelection.length - 1} onClick={() => setCurrentIndex(currentIndex + 1)} className={`text-[11px] font-bold uppercase tracking-widest transition-colors ${currentIndex === dailySelection.length - 1 ? 'text-gray-200' : 'text-gray-400 hover:text-blue-500'}`}>Next →</button>
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
              <div className="perspective-1000 h-[380px] w-full">
                <div 
                  className={`card-inner apple-card ${isFlipped ? 'card-flipped' : ''}`}
                  onClick={() => setIsFlipped(!isFlipped)}
                >
                  <div className="card-front p-12">
                    <div className="absolute top-8 right-10 flex flex-col items-end">
                      <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-1">Level</span>
                      <div className="flex gap-1">
                        {[...Array(10)].map((_, i) => (
                          <div key={i} className={`w-1.5 h-3 rounded-full ${i < reviewQueue[currentIndex].intervalIndex ? 'bg-blue-500 shadow-[0_0_5px_rgba(59,130,246,0.3)]' : 'bg-gray-100'}`} />
                        ))}
                      </div>
                    </div>
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-[0.2em] mb-4">科学复习卡片</p>
                    <h3 className="text-2xl font-black text-gray-800 max-w-xs leading-snug">
                      {reviewQueue[currentIndex].english}
                    </h3>
                    
                    <button 
                      onClick={(e) => { e.stopPropagation(); speak(reviewQueue[currentIndex].english); }}
                      className="mt-10 w-16 h-16 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-2xl hover:scale-110 active:scale-95 transition-all z-20"
                    >
                      🔊
                    </button>
                    
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-widest mt-12 animate-pulse">点击翻转查看翻译</p>
                  </div>

                  <div className="card-back p-12 flex flex-col items-center justify-center">
                    <h4 className="text-2xl font-bold text-gray-900 mb-6 leading-relaxed">{reviewQueue[currentIndex].chinese}</h4>
                    <div className="bg-blue-50 text-blue-500 px-6 py-2 rounded-full text-[10px] font-black uppercase tracking-[0.2em]">
                      Scientific Review
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <button onClick={() => handleReviewFeedback(reviewQueue[currentIndex].id, 'forgot')} className="bg-white text-red-400 py-5 rounded-[1.8rem] font-bold shadow-sm border border-red-50 hover:bg-red-50 transition-all">不记得</button>
                <button onClick={() => handleReviewFeedback(reviewQueue[currentIndex].id, 'hard')} className="bg-white text-orange-400 py-5 rounded-[1.8rem] font-bold shadow-sm border border-orange-50 hover:bg-orange-50 transition-all">有模糊</button>
                <button onClick={() => handleReviewFeedback(reviewQueue[currentIndex].id, 'easy')} className="bg-blue-600 text-white py-5 rounded-[1.8rem] font-black shadow-xl shadow-blue-200 active:scale-95 transition-all">很简单</button>
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
              <div className="apple-card p-10 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-orange-100/30 rounded-full blur-3xl -mr-10 -mt-10" />
                <div className="flex justify-between items-start mb-8">
                  <div>
                    <h3 className="text-xl font-black text-gray-900 tracking-tight">盲听默写</h3>
                    <p className="text-[10px] font-black text-orange-500 uppercase tracking-widest mt-1">Dictation Challenge</p>
                  </div>
                  <button onClick={pickNewDictationTarget} className="w-10 h-10 flex items-center justify-center bg-orange-50 text-orange-400 rounded-full hover:bg-orange-100 transition-colors">🔄</button>
                </div>
                
                <div className="bg-orange-50/40 p-8 rounded-[2rem] border border-orange-100/50 text-center mb-8">
                  <p className="text-xl font-bold text-gray-700 leading-relaxed italic">"{targetSentence?.chinese}"</p>
                </div>

                <textarea 
                  value={userInput} 
                  onChange={(e) => setUserInput(e.target.value)} 
                  className="w-full p-8 bg-gray-50 rounded-[2rem] border-none focus:ring-4 focus:ring-orange-100 outline-none min-h-[160px] text-lg font-semibold placeholder:text-gray-300 transition-all" 
                  placeholder="请输入听到的内容..." 
                />

                <div className="grid grid-cols-2 gap-4 mt-8">
                  <button onClick={() => { setIsFlipped(!isFlipped); if(!isFlipped) speak(targetSentence?.english || ""); }} className="bg-white text-gray-400 py-5 rounded-[2rem] font-bold border border-gray-100 active:scale-95 transition-all">{isFlipped ? '隐藏答案' : '听音提示'}</button>
                  <button onClick={handleDictationCheck} className="bg-orange-500 text-white py-5 rounded-[2rem] font-black text-lg shadow-xl shadow-orange-200 active:scale-95 transition-all">核对</button>
                </div>

                {isFlipped && targetSentence && (
                  <div className="mt-8 p-8 bg-blue-50 rounded-[2rem] animate-in slide-in-from-top-4">
                    <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2">标准答案</p>
                    <p className="text-blue-800 font-bold text-lg leading-tight">{targetSentence.english}</p>
                    <button onClick={() => speak(targetSentence.english)} className="mt-4 font-bold text-xs flex items-center gap-1.5 text-blue-500 hover:text-blue-700 transition-colors">
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
                  return (
                    <div key={idx} className="apple-card p-5 flex items-center justify-between group bg-white/60 hover:bg-white transition-all">
                      <div className="flex-1 pr-4">
                        <p className="text-sm font-bold text-gray-800 line-clamp-1">{s?.english}</p>
                        <p className="text-[10px] text-gray-400 font-medium">{s?.chinese}</p>
                      </div>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black ${item.status === 'correct' ? 'bg-green-100 text-green-600' : 'bg-red-50 text-red-400'}`}>
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