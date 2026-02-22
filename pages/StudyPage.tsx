import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Sentence, StudyStep, DictationRecord } from '../types';
import { geminiService } from '../services/geminiService';
import { storageService } from '../services/storageService';
import { offlineQueueService, OfflineOperation } from '../services/offlineQueueService';
import { supabaseService } from '../services/supabaseService';
// 常量抽离
const LEARN_XP = 15;
const DICTATION_XP = 20;
const LEARNED_ANIMATION_DELAY = 800;
const MAX_REVIEW_LEVEL = 10;
const DAILY_LEARN_TARGET = 3; // 学习数量硬约束：固定3个【不可修改】
const DAILY_REVIEW_TARGET = 3; // 复习数量硬约束：固定3个
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
  const [reviewFeedbackStatus, setReviewFeedbackStatus] = useState<Record<string, boolean>>({});
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'failed'>('idle');
  const isSyncingRef = useRef(false);
  
  // ========== 核心修复1：彻底简化刷新按钮禁用逻辑，初始值强制为false ==========
  const [isDictationRefreshDisabled, setIsDictationRefreshDisabled] = useState(false);
  // ★★★ 核心修改1：将dailySelection改为useState，异步生成，解决Promise获取ID的BUG ★★★
  const [dailySelection, setDailySelection] = useState<Sentence[]>([]);
  
  // 定时器ref
  const animationTimerRef = useRef<NodeJS.Timeout | null>(null);
  const dictationRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  const settings = useMemo(() => storageService.getSettings(), []);
  const todayStr = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  }, []);
  // ★★★ 核心修改2：新增useEffect，异步生成当日学习列表，全程硬锁3个数量 ★★★
  useEffect(() => {
    // 生成当日学习列表的核心函数（异步）
    const generateDailySelection = async () => {
      if (!sentences.length) {
        setDailySelection([]);
        return;
      }
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const todayDateStr = now.toISOString().split('T')[0];
      const retainedSentences: Sentence[] = [];

      // 1. 异步获取云端/本地保存的当日ID（解决核心Promise BUG）
      const savedIds = await storageService.getTodaySelection() || [];
      // 过滤有效ID，仅保留存在的、未学完/今日学过的句子
      if (savedIds.length > 0) {
        savedIds.forEach(id => {
          const sentence = sentences.find(s => s.id === id);
          if (!sentence) return;
          const isLearnedToday = sentence.lastReviewedAt 
            ? new Date(sentence.lastReviewedAt).toISOString().split('T')[0] === todayDateStr 
            : false;
          if (sentence.intervalIndex === 0 || isLearnedToday) {
            retainedSentences.push(sentence);
          }
        });
      }

      // 2. 计算需要补充的数量，严格限制：最多补到3个，负数直接置0
      let needSupplementCount = DAILY_LEARN_TARGET - retainedSentences.length;
      needSupplementCount = needSupplementCount < 0 ? 0 : needSupplementCount;

      // 3. 补充新句子：仅筛选符合条件的未学句子，且只补需要的数量
      if (needSupplementCount > 0) {
        const available = sentences.filter(s => {
          const isInRetained = retainedSentences.some(rs => rs.id === s.id);
          const isManualAddedToday = s.isManual && s.addedAt >= todayStart;
          // 排除：已学过、今日手动添加、已在保留列表的句子
          if (s.intervalIndex > 0 || isManualAddedToday || isInRetained) {
            return false;
          }
          return true;
        });

        // 按规则排序：手动添加优先，再按导入时间排序
        const manualSentences = available.filter(s => s.isManual === true);
        const importedSentences = available.filter(s => s.isManual === false || s.isManual === undefined);
        const sortedManual = manualSentences.sort((a, b) => b.addedAt - a.addedAt);
        const sortedImported = importedSentences.sort((a, b) => a.addedAt - b.addedAt);
        const sortedAll = [...sortedManual, ...sortedImported];

        // 仅补充需要的数量，绝不超额
        const supplementSentences = sortedAll.slice(0, needSupplementCount);
        retainedSentences.push(...supplementSentences);
      }

      // 4. 最后一道防线：强制截取前3个，彻底锁死数量，无任何例外
      const finalSelection = retainedSentences.slice(0, DAILY_LEARN_TARGET);
      // 5. 保存到本地+云端，确保跨设备同步的也是3个
      if (finalSelection.length > 0) {
        await storageService.saveTodaySelection(finalSelection.map(s => s.id));
      }
      // 6. 更新学习列表
      setDailySelection(finalSelection);
    };

    // 执行生成逻辑
    generateDailySelection();
  }, [sentences]); // 句子列表变化时重新生成

  // 复习队列【保持不变，已默认限制3个】
  const reviewQueue = useMemo(() => 
    sentences.filter(s => s.nextReviewDate && s.nextReviewDate <= Date.now())
             .slice(0, DAILY_REVIEW_TARGET)
  , [sentences]);
  const dictationPool = useMemo(() => 
    sentences.filter(s => s.intervalIndex > 0)
  , [sentences]);
  // 切换句子/标签时重置翻转
  useEffect(() => {
    setIsFlipped(false);
  }, [currentIndex, activeTab]);
  // 切换到复习标签时重置反馈状态
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
  // 清理定时器
  useEffect(() => {
    return () => {
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
      if (dictationRefreshTimerRef.current) clearTimeout(dictationRefreshTimerRef.current);
    };
  }, []);
  // 网络状态监听 + 离线同步
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      console.log('🔌 网络已恢复，开始同步离线操作');
      syncOfflineOperations();
    };
    const handleOffline = () => {
      setIsOnline(false);
      console.log('📴 网络已断开，操作将存入离线队列');
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    setIsOnline(navigator.onLine);
    syncOfflineOperations();
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
  // 离线操作同步核心函数
  const syncOfflineOperations = async () => {
    if (isSyncingRef.current || !isOnline) return;
    
    const pendingOps = offlineQueueService.getPendingOperations();
    if (pendingOps.length === 0) {
      setSyncStatus('idle');
      return;
    }
    isSyncingRef.current = true;
    setSyncStatus('syncing');
    console.log(`📤 开始同步${pendingOps.length}个离线操作`);
    for (const op of pendingOps) {
      try {
        offlineQueueService.updateOperationStatus(op.id, 'syncing');
        
        let syncSuccess = false;
        switch (op.type) {
          case 'markLearned':
            syncSuccess = await supabaseService.updateSentence(op.payload.updatedSentence!);
            break;
          case 'reviewFeedback':
            syncSuccess = await supabaseService.updateSentence(op.payload.updatedSentence!);
            break;
          case 'addSentence':
            syncSuccess = await supabaseService.addSentence(op.payload.sentence!);
            break;
          case 'dictationRecord':
            syncSuccess = await supabaseService.syncDictationRecord(op.payload.record!);
            break;
          default:
            console.warn('⚠️ 未知操作类型，跳过同步:', op.type);
            syncSuccess = false;
        }
        if (syncSuccess) {
          offlineQueueService.removeOperation(op.id);
        } else {
          offlineQueueService.updateOperationStatus(op.id, 'failed');
          throw new Error(`操作${op.id}同步失败`);
        }
      } catch (err) {
        console.error(`❌ 同步操作失败: ${op.id}`, err);
        offlineQueueService.updateOperationStatus(op.id, 'failed');
        if (op.retryCount < 3) {
          setTimeout(() => syncOfflineOperations(), 1000 * (op.retryCount + 1));
        }
      }
    }
    await onUpdate();
    isSyncingRef.current = false;
    
    const remainingOps = offlineQueueService.getPendingOperations().length;
    setSyncStatus(remainingOps > 0 ? 'failed' : 'idle');
    console.log(`✅ 离线操作同步完成，剩余${remainingOps}个失败操作`);
  };
  // 离线队列数量
  const offlineQueueCount = useMemo(() => {
    return offlineQueueService.getPendingOperations().length;
  }, [syncStatus]);
  // 选择新的默写目标
  const pickNewDictationTarget = () => {
    if (dictationPool.length === 0) return;
    const randomIdx = Math.floor(Math.random() * dictationPool.length);
    setTargetDictationId(dictationPool[randomIdx].id);
    setIsFlipped(false);
    setUserInput('');
  };
  // ========== 核心修复2：重写刷新按钮逻辑，移除复杂判断，确保点击必触发 ==========
  const handleDictationRefresh = () => {
    // 1. 安全校验：只有有默写池数据时才执行
    if (dictationPool.length === 0) {
      alert('暂无可默写的句子，请先学习句子');
      return;
    }
    // 2. 防重复点击：禁用按钮0.5秒
    setIsDictationRefreshDisabled(true);
    
    // 3. 强制执行刷新逻辑
    pickNewDictationTarget();
    
    // 4. 清除旧定时器，避免状态异常
    if (dictationRefreshTimerRef.current) clearTimeout(dictationRefreshTimerRef.current);
    dictationRefreshTimerRef.current = setTimeout(() => {
      setIsDictationRefreshDisabled(false);
    }, 500);
    // 调试日志（可选，可删除）
    console.log('🔄 默写按钮点击触发，已刷新新句子');
  };
  // 播放语音
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
      
      if (!isOnline) {
        offlineQueueService.addOperation({
          type: 'markLearned',
          payload: { id, updatedSentence }
        });
        
        animationTimerRef.current = setTimeout(async () => {
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
        }, LEARNED_ANIMATION_DELAY);
        return;
      }
      animationTimerRef.current = setTimeout(async () => {
        try {
          const syncSuccess = await supabaseService.updateSentence(updatedSentence);
          if (!syncSuccess) {
            offlineQueueService.addOperation({
              type: 'markLearned',
              payload: { id, updatedSentence }
            });
          }
          
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
          console.warn('标记掌握-云端同步失败，已加入离线队列', err);
          offlineQueueService.addOperation({
            type: 'markLearned',
            payload: { id, updatedSentence }
          });
          setAnimatingLearnedId(null);
        }
      }, LEARNED_ANIMATION_DELAY);
    } catch (err) {
      console.warn('标记掌握失败', err);
      setAnimatingLearnedId(null);
    }
  };
  // 复习反馈
  const handleReviewFeedback = async (id: string, feedback: 'easy' | 'hard' | 'forgot') => {
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
      
      await storageService.addSentence(updated);
      
      if (!isOnline) {
        offlineQueueService.addOperation({
          type: 'reviewFeedback',
          payload: { id, updatedSentence: updated, feedback }
        });
        
        setReviewFeedbackStatus(prev => ({ ...prev, [id]: true }));
        setCurrentIndex(prev => (prev + 1) % reviewQueue.length);
        setIsFlipped(false);
        await onUpdate();
        return;
      }
      try {
        const syncSuccess = await supabaseService.updateSentence(updated);
        if (!syncSuccess) {
          offlineQueueService.addOperation({
            type: 'reviewFeedback',
            payload: { id, updatedSentence: updated, feedback }
          });
        }
        
        setReviewFeedbackStatus(prev => ({
          ...prev,
          [id]: true
        }));
        setCurrentIndex(prev => (prev + 1) % reviewQueue.length);
        setIsFlipped(false);
        await onUpdate();
      } catch (err) {
        console.warn('复习反馈-云端同步失败，已加入离线队列', err);
        offlineQueueService.addOperation({
          type: 'reviewFeedback',
          payload: { id, updatedSentence: updated, feedback }
        });
      }
    } catch (err) {
      console.warn('复习保存失败', err);
    }
  };
  // 默写核对
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
      
      if (!isOnline) {
        offlineQueueService.addOperation({
          type: 'dictationRecord',
          payload: { record: newRecord }
        });
      } else {
        supabaseService.syncDictationRecord(newRecord).catch(err => {
          console.warn('默写记录-云端同步失败，已加入离线队列', err);
          offlineQueueService.addOperation({
            type: 'dictationRecord',
            payload: { record: newRecord }
          });
        });
      }
      
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
  // 安全取值
  const targetSentence = useMemo(() => 
    sentences.find(s => s.id === targetDictationId) || null
  , [sentences, targetDictationId]);
  
  const currentSentence = dailySelection[currentIndex] || null;
  const isCurrentlyLearned = currentSentence?.intervalIndex > 0;
  const isAnimating = currentSentence && animatingLearnedId === currentSentence.id;
  
  const currentReviewSentence = reviewQueue[currentIndex] || null;
  const isCurrentReviewSentenceFeedbacked = currentReviewSentence 
    ? reviewFeedbackStatus[currentReviewSentence.id] || false 
    : false;
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-700 pb-20">
      {/* 网络和同步状态提示 */}
      {!isOnline && (
        <div className="bg-orange-50 text-orange-600 text-sm font-bold px-4 py-2 rounded-lg flex items-center gap-2">
          <span>📴 离线模式</span>
          <span>操作将在网络恢复后自动同步</span>
        </div>
      )}
      {isOnline && syncStatus === 'syncing' && (
        <div className="bg-blue-50 text-blue-600 text-sm font-bold px-4 py-2 rounded-lg flex items-center gap-2">
          <span>🔄 同步中</span>
          <span>正在同步{offlineQueueCount}个离线操作</span>
        </div>
      )}
      {isOnline && syncStatus === 'failed' && offlineQueueCount > 0 && (
        <div className="bg-red-50 text-red-600 text-sm font-bold px-4 py-2 rounded-lg flex items-center gap-2">
          <span>⚠️ 同步失败</span>
          <button 
            onClick={syncOfflineOperations}
            className="text-red-700 underline hover:text-red-900"
          >
            点击重试（{offlineQueueCount}个操作）
          </button>
        </div>
      )}
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
              <div className="perspective-1000 min-h-[340px] w-full">
                <div 
                  className={`card-inner apple-card ${isFlipped ? 'card-flipped' : ''}`}
                  onClick={() => setIsFlipped(!isFlipped)}
                  style={{ position: 'relative', width: '100%', height: 'auto', transformStyle: 'preserve-3d' }}
                >
                  <div 
                    className={`card-front p-6 transition-all duration-700 ${isCurrentlyLearned || isAnimating ? 'bg-green-50/20' : ''}`}
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'relative', 
                      width: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      justifyContent: 'flex-start',
                      minHeight: '340px',
                      textAlign: 'left',
                      paddingTop: '20px',
                      paddingBottom: '20px'
                    }}
                  >
                    {(isCurrentlyLearned || isAnimating) && (
                      <div className="bg-green-100 text-green-600 text-[10px] font-black px-4 py-1.5 rounded-full mb-4 flex items-center gap-2 shadow-sm border border-green-200/50">
                        <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>
                        已进入计划
                      </div>
                    )}
                    
                    <button 
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        if (currentSentence) speak(currentSentence.english); 
                      }}
                      className="w-20 h-20 rounded-full flex items-center justify-center mb-6 shadow-inner transition-all relative bg-blue-50 text-blue-600 hover:scale-110 active:scale-95 z-20 self-center"
                    >
                      <span className="text-3xl">🔊</span>
                      <div className="absolute -inset-1 border-2 border-blue-200/50 rounded-full animate-pulse pointer-events-none"></div>
                    </button>
                    <h3 className="text-lg font-normal text-gray-900 leading-normal mt-0 max-w-full px-0" style={{ wordBreak: 'break-word', textAlign: 'left', margin: 0, padding: 0 }}>
                      {currentSentence?.english || ''}
                    </h3>
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-widest mt-auto animate-bounce self-center">点击卡片翻转显示中文</p>
                  </div>
                  {/* ========== 修改1：学习卡片反面样式调整 - 对齐文字起始行 ========== */}
                  <div 
                    className="card-back p-6 flex flex-col items-start justify-start"  // 关键：将justify-center改为justify-start
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'absolute', 
                      inset: 0,
                      transform: 'rotateY(180deg)',
                      minHeight: '340px',
                      textAlign: 'left',
                      paddingTop: '20px',
                      paddingBottom: '20px'
                    }}
                  >
                    {/* 占位：和正面的"已进入计划"标签对齐 */}
                    {(isCurrentlyLearned || isAnimating) && (
                      <div className="opacity-0 mb-4 pointer-events-none">占位</div>
                    )}
                    
                    {/* 占位：和正面的播放按钮对齐 */}
                    <div className="w-20 h-20 mb-6 opacity-0 pointer-events-none self-center"></div>
                    
                    <p className="text-lg text-gray-800 font-normal leading-normal px-0" style={{ wordBreak: 'break-word', textAlign: 'left', margin: 0, padding: 0 }}>
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
              <div className="perspective-1000 min-h-[380px] w-full">
                <div 
                  className={`card-inner apple-card ${isFlipped ? 'card-flipped' : ''}`}
                  onClick={() => setIsFlipped(!isFlipped)}
                  style={{ position: 'relative', width: '100%', height: 'auto', transformStyle: 'preserve-3d' }}
                >
                  <div 
                    className="card-front p-6"
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'relative', 
                      width: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      justifyContent: 'flex-start',
                      minHeight: '380px',
                      textAlign: 'left',
                      paddingTop: '20px',
                      paddingBottom: '20px'
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
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-[0.2em] mb-4">科学复习卡片</p>
                    <h3 className="text-lg font-normal text-gray-800 max-w-full leading-normal mt-0" style={{ wordBreak: 'break-word', textAlign: 'left', margin: 0, padding: 0 }}>
                      {reviewQueue[currentIndex]?.english || ''}
                    </h3>
                    
                    <button 
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        const sen = reviewQueue[currentIndex];
                        if (sen) speak(sen.english); 
                      }}
                      className="mt-6 w-16 h-16 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-2xl hover:scale-110 active:scale-95 transition-all z-20 self-center"
                    >
                      🔊
                    </button>
                    
                    <p className="text-[10px] font-black text-gray-300 uppercase tracking-widest mt-6 animate-pulse self-center">点击翻转查看翻译</p>
                  </div>
                  {/* ========== 修改2：复习卡片反面样式调整 - 对齐文字起始行 ========== */}
                  <div 
                    className="card-back p-6 flex flex-col items-start justify-start"  // 关键：将justify-center改为justify-start
                    style={{ 
                      backfaceVisibility: 'hidden', 
                      position: 'absolute', 
                      inset: 0,
                      transform: 'rotateY(180deg)',
                      minHeight: '380px',
                      textAlign: 'left',
                      paddingTop: '20px',
                      paddingBottom: '20px'
                    }}
                  >
                    {/* 占位：和正面的Level标签对齐 */}
                    <div className="absolute top-8 right-10 opacity-0 pointer-events-none">占位</div>
                    
                    {/* 占位：和正面的"科学复习卡片"文字对齐 */}
                    <p className="text-[10px] opacity-0 mb-4 pointer-events-none">占位</p>
                    
                    {/* 核心文字 - 现在和正面文字起始行完全对齐 */}
                    <h4 className="text-lg font-normal text-gray-900 leading-normal" style={{ wordBreak: 'break-word', textAlign: 'left', margin: 0, padding: 0 }}>
                      {reviewQueue[currentIndex]?.chinese || ''}
                    </h4>
                    
                    {/* 占位：和正面的播放按钮对齐 */}
                    <div className="w-16 h-16 mt-6 opacity-0 pointer-events-none self-center"></div>
                    
                    <div className="mt-10 px-6 py-2 bg-blue-50 text-blue-500 px-6 py-2 rounded-full text-[10px] font-black uppercase tracking-[0.2em] self-center">
                      Scientific Review
                    </div>
                  </div>
                </div>
              </div>
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
                  {/* ========== 核心修复3：重构刷新按钮样式，确保可点击 ========== */}
                  <button 
                    onClick={handleDictationRefresh}
                    disabled={isDictationRefreshDisabled}
                    // 关键修改：提升z-index + 扩大点击区域 + 确保pointer-events + 明确的hover/active样式
                    className="w-12 h-12 flex items-center justify-center bg-orange-50 text-orange-500 rounded-full hover:bg-orange-100 hover:text-orange-600 active:scale-90 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    style={{ 
                      zIndex: 100, // 确保层级最高，不被遮挡
                      pointerEvents: isDictationRefreshDisabled ? 'none' : 'auto', // 明确点击事件
                      cursor: isDictationRefreshDisabled ? 'not-allowed' : 'pointer' // 明确光标样式
                    }}
                    aria-label="刷新默写题目"
                  >
                    🔄
                  </button>
                </div>
                
                <div className="bg-orange-50/40 p-4 rounded-[2rem] border border-orange-100/50 text-left mb-8">
                  <p className="text-lg font-normal text-gray-700 leading-normal italic" style={{ wordBreak: 'break-word', textAlign: 'left' }}>
                    "{targetSentence?.chinese || '暂无题目'}"
                  </p>
                </div>
                <textarea 
                  value={userInput} 
                  onChange={(e) => setUserInput(e.target.value)} 
                  className="w-full p-8 bg-gray-50 rounded-[2rem] border-none focus:ring-4 focus:ring-orange-100 outline-none min-h-[160px] text-lg font-semibold placeholder:text-gray-300 transition-all" 
                  placeholder="请输入听到的内容..." 
                  style={{ textAlign: 'left' }}
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
                {/* 新增：无数据时按钮也能点击，提示用户 */}
                <button 
                  onClick={handleDictationRefresh}
                  className="mt-4 bg-orange-100 text-orange-500 py-3 px-6 rounded-full font-bold text-sm"
                >
                  刷新试试
                </button>
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