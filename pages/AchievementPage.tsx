import React, { useMemo, useState } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storageService';

// ======================== 常量配置 ========================
const LEVEL_CONFIG = [
  { lv: 1, title: '初级探索者', minPoints: 0, maxPoints: 200, color: 'from-blue-500 to-indigo-400' },
  { lv: 2, title: '新晋学者', minPoints: 200, maxPoints: 600, color: 'from-indigo-500 to-purple-400' },
  { lv: 3, title: '勤奋达人', minPoints: 600, maxPoints: 1200, color: 'from-purple-500 to-pink-400' },
  { lv: 4, title: '语境专家', minPoints: 1200, maxPoints: 2500, color: 'from-pink-500 to-rose-400' },
  { lv: 5, title: '英语大师', minPoints: 2500, maxPoints: 5000, color: 'from-rose-500 to-orange-400' },
  { lv: 6, title: '英语宗师', minPoints: 5000, maxPoints: Infinity, color: 'from-orange-500 to-red-400' },
];

const ACHIEVEMENT_CATEGORIES = {
  streak: { title: '连续学习成就', icon: '🔥', color: 'orange' },
  collection: { title: '词库收藏成就', icon: '📚', color: 'blue' },
  mastery: { title: '掌握程度成就', icon: '🌟', color: 'purple' },
  review: { title: '复习巩固成就', icon: '🔄', color: 'green' },
  dictation: { title: '默写能手成就', icon: '✍️', color: 'teal' },
  points: { title: '积分成长成就', icon: '💎', color: 'amber' },
  monthly: { title: '月度挑战成就', icon: '🗓️', color: 'sky' },
};

const ACHIEVEMENT_MILESTONES = [
  { id: 'streak-7', category: 'streak', title: '滴水穿石', icon: '🔥', target: 7, currentKey: 'streak', desc: '连续 7 天不间断学习' },
  { id: 'streak-30', category: 'streak', title: '百日坚持', icon: '🌱', target: 30, currentKey: 'streak', desc: '连续 30 天不间断学习' },
  { id: 'total-days-100', category: 'streak', title: '日积月累', icon: '📆', target: 100, currentKey: 'totalDaysLearned', desc: '累计学习天数达到 100 天' },
  { id: 'max-streak-50', category: 'streak', title: '连胜王者', icon: '🏆', target: 50, currentKey: 'maxStreak', desc: '历史最高连续学习 50 天' },
  { id: 'collection-100', category: 'collection', title: '厚积薄发', icon: '🎓', target: 100, currentKey: 'sentenceCount', desc: '词库句子总数达到 100' },
  { id: 'collection-500', category: 'collection', title: '学富五车', icon: '📚', target: 500, currentKey: 'sentenceCount', desc: '词库句子总数达到 500' },
  { id: 'mastery-lv4-10', category: 'mastery', title: '初窥门径', icon: '🌟', target: 10, currentKey: 'masteredLv4', desc: '掌握 10 个进阶难度句子' },
  { id: 'mastery-lv4-30', category: 'mastery', title: '进阶掌握', icon: '💪', target: 30, currentKey: 'masteredLv4', desc: '掌握 30 个进阶难度句子' },
  { id: 'mastery-lv7-50', category: 'mastery', title: '完全掌握', icon: '🏆', target: 50, currentKey: 'masteredLv7', desc: '彻底攻克 50 个复杂句子' },
  { id: 'review-50', category: 'review', title: '温故知新', icon: '🔄', target: 50, currentKey: 'totalReviewTimes', desc: '累计复习句子达到 50 次' },
  { id: 'review-200', category: 'review', title: '复习标兵', icon: '🎯', target: 200, currentKey: 'totalReviewTimes', desc: '累计复习句子达到 200 次' },
  { id: 'dictation-50', category: 'dictation', title: '默写能手', icon: '✍️', target: 50, currentKey: 'correctDictationCount', desc: '累计正确默写 50 个句子' },
  { id: 'dictation-200', category: 'dictation', title: '默写大师', icon: '🎨', target: 200, currentKey: 'correctDictationCount', desc: '累计正确默写 200 个句子' },
  { id: 'dictation-accuracy-95', category: 'dictation', title: '默写全对', icon: '💯', target: 95, currentKey: 'dictationAccuracy', desc: '默写正确率达到 95%' },
  { id: 'points-2000', category: 'points', title: '积分巨贾', icon: '💎', target: 2000, currentKey: 'totalPoints', desc: '累计获得超过 2000 积分' },
  { id: 'points-5000', category: 'points', title: '积分富豪', icon: '💰', target: 5000, currentKey: 'totalPoints', desc: '累计获得超过 5000 积分' },
  { id: 'monthly-rate-80', category: 'monthly', title: '月度达标', icon: '📅', target: 80, currentKey: 'monthAvgRate', desc: '月度平均完成率达到 80%' },
  { id: 'monthly-rate-100', category: 'monthly', title: '月度王者', icon: '🏅', target: 100, currentKey: 'monthAvgRate', desc: '月度平均完成率达到 100%' },
];

// ======================== 工具函数 ========================
const formatDate = (date: Date) => date.toISOString().split('T')[0];
const formatMonth = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const getDaysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();

const getRecentDays = (days: number) => {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    return { date: d, dateStr: formatDate(d), day: d.toLocaleDateString('zh-CN', { weekday: 'short' }), target: 3 };
  });
};

const getRecentMonths = (months: number) => {
  return Array.from({ length: months }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - (months - 1 - i));
    const year = d.getFullYear();
    const month = d.getMonth();
    const monthStr = formatMonth(d);
    const monthName = d.toLocaleDateString('zh-CN', { month: 'short' });
    const days = getDaysInMonth(year, month);
    const target = days * 3;
    return { year, month, monthStr, monthName, days, target };
  });
};

const calculateMasteryStats = (sentences: Sentence[]) => {
  if (sentences.length === 0) return { levelCounts: [], needImprove: 0, mastered: 0 };

  const levels = [
    { name: '入门', key: 'lv1', min: 0, max: 1, color: 'bg-gray-100', textColor: 'text-gray-500', bgColor: 'bg-gray-500' },
    { name: '基础', key: 'lv2', min: 2, max: 3, color: 'bg-blue-100', textColor: 'text-blue-500', bgColor: 'bg-blue-500' },
    { name: '进阶', key: 'lv3', min: 4, max: 6, color: 'bg-purple-100', textColor: 'text-purple-500', bgColor: 'bg-purple-500' },
    { name: '精通', key: 'lv4', min: 7, max: Infinity, color: 'bg-green-100', textColor: 'text-green-500', bgColor: 'bg-green-500' },
  ];

  const levelCounts = levels.map(level => {
    const count = sentences.filter(s => s.intervalIndex >= level.min && s.intervalIndex <= level.max).length;
    const ratio = Math.round((count / sentences.length) * 100);
    return { ...level, count, ratio };
  });

  const needImprove = levelCounts.filter(l => l.key === 'lv1' || l.key === 'lv2').reduce((sum, l) => sum + l.count, 0);
  const mastered = levelCounts.find(l => l.key === 'lv4')?.count || 0;

  return { levelCounts, needImprove, mastered };
};

const calculateLevelInfo = (totalPoints: number) => {
  const level = LEVEL_CONFIG.find(level => totalPoints >= level.minPoints && totalPoints < level.maxPoints) || LEVEL_CONFIG[LEVEL_CONFIG.length - 1];
  const nextLevel = LEVEL_CONFIG.find(l => l.lv === level.lv + 1) || level;
  const nextPoints = nextLevel.minPoints > totalPoints ? nextLevel.minPoints : Math.max(totalPoints, 5000);
  
  return {
    ...level,
    nextPoints,
    progress: totalPoints > 0 ? Math.min(100, (totalPoints / nextPoints) * 100) : 0,
  };
};

// ======================== 子组件 ========================
const EmptyState: React.FC<{ icon: string; title: string; desc: string }> = ({ icon, title, desc }) => {
  return (
    <div className="apple-card rounded-xl p-5 text-center space-y-3">
      <div className="text-5xl">{icon}</div>
      <h2 className="text-base font-black text-gray-900 tracking-tight">{title}</h2>
      <p className="text-xs text-gray-400 font-medium">{desc}</p>
    </div>
  );
};

const AchievementCard: React.FC<{
  achievement: any;
  currentValue: number;
  categoryConfig: typeof ACHIEVEMENT_CATEGORIES.streak;
}> = ({ achievement, currentValue, categoryConfig }) => {
  const progress = Math.min(100, (currentValue / achievement.target) * 100);
  const isUnlocked = progress >= 100;
  
  return (
    <div 
      className={`apple-card rounded-lg p-3 transition-all duration-300 border-2 min-h-[80px] ${
        isUnlocked 
          ? `border-${categoryConfig.color}-100 bg-white shadow-md shadow-${categoryConfig.color}-50/20` 
          : 'border-transparent bg-white/40'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div 
          className={`text-lg w-10 h-10 flex items-center justify-center rounded-lg shadow-sm transition-all duration-300 relative ${
            isUnlocked 
              ? `bg-${categoryConfig.color}-600 text-white rotate-0 scale-105` 
              : 'bg-gray-100 text-gray-300 -rotate-8 scale-95'
          }`}
        >
          {achievement.icon}
          {isUnlocked && <div className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-yellow-400 rounded-full flex items-center justify-center text-[10px] font-black">✓</div>}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start mb-1 flex-wrap gap-1">
            <div className="min-w-0">
              <h4 className={`font-black tracking-tight text-xs ${isUnlocked ? 'text-gray-900' : 'text-gray-400'} truncate`}>
                {achievement.title} {isUnlocked && <span className="text-[10px] text-green-500">(已解锁)</span>}
              </h4>
              <p className="text-[8px] text-gray-400 font-medium leading-tight truncate">{achievement.desc}</p>
            </div>
            <span className={`text-[9px] font-black ${isUnlocked ? `text-${categoryConfig.color}-600` : 'text-gray-300'}`}>
              {currentValue} / {achievement.target}
            </span>
          </div>
          <div className="w-full bg-gray-100 h-1 rounded-full overflow-hidden p-0.5">
            <div 
              className={`h-full transition-all duration-800 rounded-full ${
                isUnlocked ? `bg-${categoryConfig.color}-600` : `bg-${categoryConfig.color}-300/30`
              }`} 
              style={{ width: `${progress}%` }} 
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const StatCard: React.FC<{
  icon: string;
  value: number | string;
  label: string;
  bgColor: string;
  textColor?: string;
  tip?: string;
}> = ({ icon, value, label, bgColor, textColor = 'text-gray-900', tip }) => {
  return (
    <div className="apple-card rounded-xl p-3 flex flex-col items-center justify-center text-center space-y-1 group hover:-translate-y-1 transition-all duration-200 min-h-[80px]" title={tip}>
      <div className={`w-8 h-8 bg-${bgColor}-50 rounded-lg flex items-center justify-center text-base group-hover:scale-110 transition-transform`}>
        {icon}
      </div>
      <div>
        <h4 className={`text-lg font-black ${textColor} tracking-tight`}>{value}</h4>
        <p className="text-[7px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">{label}</p>
      </div>
    </div>
  );
};

// ======================== 主组件（优化布局） ========================
const AchievementPage: React.FC<{ sentences: Sentence[] }> = ({ sentences }) => {
  const [filterType, setFilterType] = useState<'all' | 'unlocked' | 'locked'>('all');
  
  // 基础数据
  const rawStats = storageService.getStats() || {};
  const stats = useMemo(() => ({
    streak: rawStats.streak || 0,
    maxStreak: rawStats.maxStreak || rawStats.streak || 0,
    breakTimes: rawStats.breakTimes || 0,
    streakQualified: rawStats.streakQualified || 0,
    totalPoints: rawStats.totalPoints || 0,
    totalDictation: rawStats.totalDictation || 0,
    dictationCount: rawStats.dictationCount || 0,
    totalDaysLearned: rawStats.totalDaysLearned || 0,
    weekDictationCount: rawStats.weekDictationCount || 0,
    maxDailyDictation: rawStats.maxDailyDictation || 0,
  }), [rawStats]);

  // 核心数据计算（精简版）
  const coreData = useMemo(() => {
    const sentenceCount = sentences.length;
    const masteredLv7 = sentences.filter(s => s.intervalIndex >= 7).length;
    const masteredLv4 = sentences.filter(s => s.intervalIndex >= 4).length;
    const totalReviewTimes = sentences.reduce((sum, s) => sum + (s.timesReviewed || 0), 0);
    const learnedTotal = sentences.filter(s => s.intervalIndex > 0).length;
    
    // 本月数据（整合到核心数据）
    const currentMonth = new Date();
    const currentMonthStr = formatMonth(currentMonth);
    const learnedSentences = sentences.filter(s => s.intervalIndex > 0 && s.lastReviewedAt);
    const monthlyCompleteMap = new Map<string, number>();
    learnedSentences.forEach(s => {
      const sMonthStr = formatMonth(new Date(s.lastReviewedAt));
      monthlyCompleteMap.set(sMonthStr, (monthlyCompleteMap.get(sMonthStr) || 0) + 1);
    });
    const currentMonthComplete = monthlyCompleteMap.get(currentMonthStr) || 0;
    const currentMonthTarget = getDaysInMonth(currentMonth.getFullYear(), currentMonth.getMonth()) * 3;
    const currentMonthCompleteRate = currentMonthTarget > 0 ? Math.min(100, Math.round((currentMonthComplete / currentMonthTarget) * 100)) : 0;
    
    // 学习效率
    const avgDailyLearn = stats.totalDaysLearned > 0 ? parseFloat((learnedTotal / stats.totalDaysLearned).toFixed(1)) : 0;
    const qualifiedRate = stats.totalDaysLearned > 0 ? Math.min(100, Math.round((stats.streakQualified / stats.totalDaysLearned) * 100)) : 0;
    
    // 默写统计
    const dictationAccuracy = stats.totalDictation > 0 
      ? Math.min(100, Math.round((stats.dictationCount / stats.totalDictation) * 100)) 
      : learnedTotal > 0 ? Math.round((stats.dictationCount / learnedTotal) * 100) : 0;

    return { 
      sentenceCount, masteredLv7, masteredLv4, totalReviewTimes, learnedTotal,
      currentMonthComplete, currentMonthCompleteRate,
      avgDailyLearn, qualifiedRate, dictationAccuracy
    };
  }, [sentences, stats]);

  const levelInfo = useMemo(() => calculateLevelInfo(stats.totalPoints), [stats.totalPoints]);

  // 周/月数据（合并展示）
  const cycleData = useMemo(() => {
    // 周数据
    const recent7Days = getRecentDays(7);
    const learnedSentences = sentences.filter(s => s.intervalIndex > 0 && s.lastReviewedAt);
    const dailyCompleteMap = new Map<string, number>();
    learnedSentences.forEach(s => {
      const sDateStr = formatDate(new Date(s.lastReviewedAt));
      dailyCompleteMap.set(sDateStr, (dailyCompleteMap.get(sDateStr) || 0) + 1);
    });
    const weekDailyData = recent7Days.map(day => ({ ...day, complete: Math.min(dailyCompleteMap.get(day.dateStr) || 0, day.target) }));
    const weekTotalComplete = weekDailyData.reduce((sum, d) => sum + d.complete, 0);
    const weekTotalTarget = weekDailyData.reduce((sum, d) => sum + d.target, 0);
    const weekCompleteRate = weekTotalTarget > 0 ? Math.min(100, Math.round((weekTotalComplete / weekTotalTarget) * 100)) : 0;

    // 月数据
    const recent6Months = getRecentMonths(6);
    const monthlyCompleteMap = new Map<string, number>();
    learnedSentences.forEach(s => {
      const sMonthStr = formatMonth(new Date(s.lastReviewedAt));
      monthlyCompleteMap.set(sMonthStr, (monthlyCompleteMap.get(sMonthStr) || 0) + 1);
    });
    const monthDailyData = recent6Months.map(month => ({
      ...month,
      complete: Math.min(monthlyCompleteMap.get(month.monthStr) || 0, month.target),
      completeRate: month.target > 0 ? Math.min(100, Math.round((monthlyCompleteMap.get(month.monthStr) || 0) / month.target * 100)) : 0,
    }));
    const monthTotalComplete = monthDailyData.reduce((sum, m) => sum + m.complete, 0);
    const monthTotalTarget = monthDailyData.reduce((sum, m) => sum + m.target, 0);
    const monthAvgRate = monthTotalTarget > 0 ? Math.min(100, Math.round((monthTotalComplete / monthTotalTarget) * 100)) : 0;

    // 热力图数据
    const heatmapData = weekDailyData.map(day => {
      let status: 'none' | 'partial' | 'full' = 'none';
      let icon = '';
      let bgClass = 'bg-gray-100';
      let textClass = 'text-gray-300';

      if (day.complete > 0 && day.complete < day.target) {
        status = 'partial';
        icon = '🔸';
        bgClass = 'bg-amber-100';
        textClass = 'text-amber-500';
      } else if (day.complete >= day.target) {
        status = 'full';
        icon = '💯';
        bgClass = 'bg-green-500';
        textClass = 'text-white';
      }

      return { ...day, status, icon, bgClass, textClass, displayText: day.complete > 0 ? day.complete.toString() : '' };
    });

    return { weekDailyData, weekCompleteRate, monthDailyData, monthAvgRate, heatmapData };
  }, [sentences]);

  // 掌握程度统计
  const masteryStats = useMemo(() => calculateMasteryStats(sentences), [sentences]);

  // 成就数据
  const achievementData = useMemo(() => {
    const valueMap = {
      streak: stats.streak, maxStreak: stats.maxStreak, totalDaysLearned: stats.totalDaysLearned,
      sentenceCount: coreData.sentenceCount, masteredLv4: coreData.masteredLv4, masteredLv7: coreData.masteredLv7,
      totalReviewTimes: coreData.totalReviewTimes, correctDictationCount: stats.dictationCount,
      dictationAccuracy: coreData.dictationAccuracy, totalPoints: stats.totalPoints, monthAvgRate: cycleData.monthAvgRate,
    };

    return ACHIEVEMENT_MILESTONES.map(achievement => ({
      ...achievement,
      currentValue: valueMap[achievement.currentKey as keyof typeof valueMap] || 0,
      isUnlocked: (valueMap[achievement.currentKey as keyof typeof valueMap] || 0) >= achievement.target,
    }));
  }, [stats, coreData, cycleData.monthAvgRate]);

  // 成就筛选
  const filteredAchievements = useMemo(() => {
    switch (filterType) {
      case 'unlocked': return achievementData.filter(ach => ach.isUnlocked);
      case 'locked': return achievementData.filter(ach => !ach.isUnlocked);
      default: return achievementData;
    }
  }, [achievementData, filterType]);

  const groupedAchievements = useMemo(() => {
    const groups: Record<string, typeof filteredAchievements> = {};
    Object.keys(ACHIEVEMENT_CATEGORIES).forEach(category => {
      groups[category] = filteredAchievements.filter(ach => ach.category === category);
    });
    return groups;
  }, [filteredAchievements]);

  // 空状态
  if (sentences.length === 0 && stats.totalPoints === 0) {
    return (
      <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500 px-2">
        <EmptyState icon="🎯" title="暂无学习成就" desc="开始你的英语学习之旅，解锁更多成就吧！" />
      </div>
    );
  }

  // 主渲染（优化后的布局）
  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500 px-2">
      {/* 1. 等级卡片（置顶，突出核心身份） */}
      <div className={`apple-card bg-gradient-to-br ${levelInfo.color} p-5 text-white relative overflow-hidden shadow-lg shadow-blue-200/30 rounded-2xl`}>
        <div className="absolute -right-6 -top-6 w-24 h-24 bg-white/10 rounded-full blur-2xl" />
        <div className="absolute -left-6 -bottom-6 w-24 h-24 bg-black/10 rounded-full blur-2xl" />
        
        <div className="relative z-10 flex items-center gap-4 mb-4 flex-wrap">
          <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-2xl border border-white/40 shadow-inner group transition-transform duration-300 hover:scale-105">
            <span className="text-3xl group-hover:rotate-12 transition-transform">🦁</span>
          </div>
          <div className="space-y-1 flex-1">
            <h2 className="text-xl font-black tracking-tighter uppercase">English Master</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="bg-white/20 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest backdrop-blur-md">Level {levelInfo.lv}</span>
              <span className="text-white/80 text-xs font-bold">{levelInfo.title}</span>
            </div>
          </div>
        </div>

        <div className="relative z-10 space-y-1.5">
          <div className="flex justify-between items-end text-[8px] font-black uppercase tracking-[0.2em] opacity-80 flex-wrap gap-1">
            <span>升级进度</span>
            <span>{stats.totalPoints} / {levelInfo.nextPoints} XP</span>
          </div>
          <div className="w-full bg-black/20 h-2.5 rounded-full overflow-hidden border border-white/20 backdrop-blur-lg p-0.5">
            <div 
              className="h-full bg-white rounded-full transition-all duration-800 shadow-[0_0_10px_rgba(255,255,255,0.8)]"
              style={{ width: `${levelInfo.progress}%` }}
            />
          </div>
        </div>
      </div>

      {/* 2. 核心统计卡片（8个关键指标，分两行4列，最常用数据置顶） */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard icon="🔥" value={stats.streak} label="天连续学习" bgColor="orange" tip="连续学习天数越多，记忆效果越好" />
        <StatCard icon="📚" value={coreData.sentenceCount} label="个句子收藏" bgColor="blue" tip="收藏的句子总数" />
        <StatCard icon="🔄" value={coreData.totalReviewTimes} label="次累计复习" bgColor="purple" tip="艾宾浩斯复习总次数" />
        <StatCard icon="✍️" value={stats.dictationCount} label="个正确默写" bgColor="green" tip="正确默写的句子数量" />
        <StatCard icon="📆" value={stats.totalDaysLearned} label="天累计学习" bgColor="indigo" tip="总共学习的天数" />
        <StatCard icon="🏆" value={stats.maxStreak} label="天最高连胜" bgColor="red" tip="历史最长连续学习记录" />
        <StatCard icon="🌟" value={coreData.masteredLv4} label="个掌握句子" bgColor="pink" tip="达到进阶以上掌握程度的句子" />
        <StatCard icon="🗓️" value={`${coreData.currentMonthCompleteRate}%`} label="本月完成率" bgColor="teal" tip="本月学习目标完成百分比" />
      </div>

      {/* 3. 周/月学习概览（合并展示，减少冗余） */}
      <div className="apple-card rounded-xl p-4 space-y-4">
        <div className="flex justify-between items-center flex-wrap gap-1">
          <h3 className="text-xs font-black text-gray-900 tracking-tight flex items-center gap-1.5">
            <span>📈</span> 学习进度概览
          </h3>
          <div className="flex gap-1">
            <span className="text-[7px] font-black text-green-500 bg-green-50 px-1.5 py-0.5 rounded-full uppercase tracking-widest">
              周完成率 {cycleData.weekCompleteRate}%
            </span>
            <span className="text-[7px] font-black text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded-full uppercase tracking-widest">
              月完成率 {cycleData.monthAvgRate}%
            </span>
          </div>
        </div>

        {/* 周度数据 */}
        <div className="space-y-2">
          <p className="text-[8px] font-black text-gray-500 uppercase tracking-widest">本周学习（目标21个）</p>
          <div className="flex gap-1 overflow-x-auto pb-2">
            {cycleData.weekDailyData.map((day, idx) => (
              <div 
                key={idx} 
                className="flex-shrink-0 w-12 flex flex-col items-center justify-center gap-1 p-1.5 rounded-xl border transition-all min-h-[60px]"
                style={{
                  borderColor: day.complete >= day.target ? '#22c55e' : '#e5e7eb',
                  backgroundColor: day.complete >= day.target ? 'rgba(34, 197, 94, 0.05)' : 'white'
                }}
              >
                <span className={`text-[8px] font-black uppercase tracking-widest ${day.complete >= day.target ? 'text-green-600' : 'text-gray-400'}`}>
                  {day.day}
                </span>
                <span className="text-base font-black text-gray-900">{day.complete}</span>
                <span className="text-[7px] text-gray-300 font-bold">/ {day.target}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 月度数据 */}
        <div className="space-y-2">
          <p className="text-[8px] font-black text-gray-500 uppercase tracking-widest">近6个月学习</p>
          <div className="flex gap-1 overflow-x-auto pb-2">
            {cycleData.monthDailyData.map((month, idx) => (
              <div 
                key={idx} 
                className="flex-shrink-0 w-14 flex flex-col items-center justify-center gap-1 p-1.5 rounded-xl border transition-all min-h-[60px]"
                style={{
                  borderColor: month.completeRate >= 80 ? '#3b82f6' : '#e5e7eb',
                  backgroundColor: month.completeRate >= 80 ? 'rgba(59, 130, 246, 0.05)' : 'white'
                }}
              >
                <span className={`text-[8px] font-black uppercase tracking-widest ${month.completeRate >= 80 ? 'text-blue-600' : 'text-gray-400'}`}>
                  {month.monthName}
                </span>
                <span className="text-sm font-black text-gray-900">{month.complete}</span>
                <span className="text-[7px] text-gray-300 font-bold">/{month.target}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 4. 学习热力图（直观展示学习规律） */}
      {cycleData.heatmapData.some(day => day.complete > 0) ? (
        <div className="apple-card rounded-xl p-4 space-y-4">
          <div className="flex justify-between items-center flex-wrap gap-1">
            <h3 className="text-xs font-black text-gray-900 tracking-tight flex items-center gap-1.5">
              <span>📅</span> 学习热力图
            </h3>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded bg-green-500"></div>
                <span className="text-[7px] font-bold text-gray-500">达标</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded bg-amber-100 border border-amber-300"></div>
                <span className="text-[7px] font-bold text-gray-500">部分</span>
              </div>
            </div>
          </div>
          <div className="flex gap-1 overflow-x-auto pb-2 px-0.5">
            {cycleData.heatmapData.map((item, idx) => (
              <div key={idx} className="flex flex-col items-center gap-1 w-12 flex-shrink-0">
                <span className="text-[8px] font-black uppercase tracking-widest text-gray-500">{item.day}</span>
                <div 
                  className={`w-10 h-10 rounded-xl transition-all duration-200 shadow-sm flex flex-col items-center justify-center ${item.bgClass}`}
                  title={`${item.dateStr}: 完成 ${item.complete} / ${item.target} 个`}
                >
                  <span className={`text-base mb-0.5 ${item.textClass}`}>{item.icon}</span>
                  <span className={`text-xs font-black ${item.textClass}`}>{item.displayText}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 5. 默写专项统计（核心输出能力） */}
      <div className="apple-card rounded-xl p-4 space-y-4">
        <div className="flex justify-between items-center flex-wrap gap-1">
          <h3 className="text-xs font-black text-gray-900 tracking-tight flex items-center gap-1.5">
            <span>✍️</span> 默写专项统计
          </h3>
          <span className="text-[7px] font-black text-green-500 bg-green-50 px-1.5 py-0.5 rounded-full uppercase tracking-widest">
            正确率 {coreData.dictationAccuracy}%
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="p-2 bg-green-50 rounded-lg">
            <p className="text-[8px] text-green-500 font-black uppercase tracking-widest mb-1">累计正确率</p>
            <p className="text-xl font-black text-gray-900">{coreData.dictationAccuracy}%</p>
            <p className="text-[8px] text-gray-400">精准度</p>
          </div>
          <div className="p-2 bg-orange-50 rounded-lg">
            <p className="text-[8px] text-orange-500 font-black uppercase tracking-widest mb-1">单日最高</p>
            <p className="text-xl font-black text-gray-900">{stats.maxDailyDictation}</p>
            <p className="text-[8px] text-gray-400">个正确默写</p>
          </div>
        </div>
      </div>

      {/* 6. 掌握程度统计（学习效果核心指标） */}
      {masteryStats.levelCounts.length > 0 ? (
        <div className="apple-card rounded-xl p-4 space-y-4">
          <div className="flex justify-between items-center flex-wrap gap-1">
            <h3 className="text-xs font-black text-gray-900 tracking-tight flex items-center gap-1.5">
              <span>📊</span> 掌握程度统计
            </h3>
            <span className="text-[7px] font-black text-purple-500 bg-purple-50 px-1.5 py-0.5 rounded-full uppercase tracking-widest">
              待提升 {masteryStats.needImprove} | 已精通 {masteryStats.mastered}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {masteryStats.levelCounts.map((level, idx) => (
              <div key={idx} className={`p-2 rounded-lg ${level.color}`}>
                <p className={`text-[8px] font-black uppercase tracking-widest mb-1 ${level.textColor}`}>{level.name}</p>
                <p className="text-base font-black text-gray-900">{level.count}</p>
                <p className="text-[7px] text-gray-500 font-bold">{level.ratio}%</p>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <p className="text-[8px] font-black uppercase tracking-[0.2em] text-gray-500">掌握等级分布</p>
            <div className="w-full h-1.5 rounded-full overflow-hidden flex">
              {masteryStats.levelCounts.map((level, idx) => (
                <div 
                  key={idx} 
                  className={`h-full ${level.bgColor}`}
                  style={{ width: `${level.ratio}%` }}
                  title={`${level.name}: ${level.count} 个 (${level.ratio}%)`}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* 7. 学习习惯总结（精简版，突出关键信息） */}
      <div className="apple-card rounded-xl p-4 space-y-3">
        <h3 className="text-xs font-black text-gray-900 tracking-tight flex items-center gap-1.5">
          <span>⚡</span> 学习习惯总结
        </h3>
        <div className="grid grid-cols-3 gap-1.5 text-center">
          <div className="p-2 bg-blue-50 rounded-lg">
            <p className="text-[8px] text-blue-500 font-black uppercase tracking-widest mb-1">日均学习</p>
            <p className="text-base font-black text-gray-900">{coreData.avgDailyLearn}</p>
            <p className="text-[7px] text-gray-500">个/天</p>
          </div>
          <div className="p-2 bg-orange-50 rounded-lg">
            <p className="text-[8px] text-orange-500 font-black uppercase tracking-widest mb-1">达标率</p>
            <p className="text-base font-black text-gray-900">{coreData.qualifiedRate}%</p>
            <p className="text-[7px] text-gray-500">总学习</p>
          </div>
          <div className="p-2 bg-red-50 rounded-lg">
            <p className="text-[8px] text-red-500 font-black uppercase tracking-widest mb-1">中断次数</p>
            <p className="text-base font-black text-gray-900">{stats.breakTimes}</p>
            <p className="text-[7px] text-gray-500">次</p>
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded-lg text-xs text-gray-600">
          {coreData.avgDailyLearn >= 3 
            ? '✅ 日均学习量达标，保持当前节奏，继续加油！' 
            : '💡 建议每天固定学习3个句子，提升效率，早日达标！'}
        </div>
      </div>

      {/* 8. 荣誉勋章墙（底部，激励作用） */}
      <div className="space-y-3">
        <div className="flex justify-between items-center flex-wrap gap-2">
          <h3 className="text-[9px] font-black text-gray-400 uppercase tracking-[0.3em] ml-1">荣誉勋章墙</h3>
          <div className="flex bg-gray-100 rounded-full p-0.5">
            {[
              { value: 'all', label: '全部' },
              { value: 'unlocked', label: '已解锁' },
              { value: 'locked', label: '未解锁' },
            ].map((filter) => (
              <button
                key={filter.value}
                onClick={() => setFilterType(filter.value as 'all' | 'unlocked' | 'locked')}
                className={`min-w-[50px] px-2 py-0.5 rounded-full text-xs font-bold transition-all ${
                  filterType === filter.value 
                    ? 'bg-white text-gray-900 shadow-sm' 
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {filteredAchievements.length > 0 ? (
          Object.keys(ACHIEVEMENT_CATEGORIES).map((category) => {
            const categoryAchievements = groupedAchievements[category];
            if (categoryAchievements.length === 0) return null;
            
            const categoryConfig = ACHIEVEMENT_CATEGORIES[category as keyof typeof ACHIEVEMENT_CATEGORIES];
            return (
              <div key={category} className="mb-3">
                <div className="flex items-center gap-1.5 mb-2 ml-1">
                  <span className={`text-${categoryConfig.color}-500`}>{categoryConfig.icon}</span>
                  <h4 className="text-xs font-black text-gray-800">{categoryConfig.title}</h4>
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {categoryAchievements.map((achievement) => (
                    <AchievementCard
                      key={achievement.id}
                      achievement={achievement}
                      currentValue={achievement.currentValue}
                      categoryConfig={categoryConfig}
                    />
                  ))}
                </div>
              </div>
            );
          })
        ) : (
          <EmptyState 
            icon="🏆" 
            title="暂无符合条件的成就" 
            desc={filterType === 'unlocked' ? '继续学习，解锁更多成就吧！' : '你已解锁所有成就，太棒了！'} 
          />
        )}
      </div>

      <div className="text-center pb-4">
        <p className="text-[8px] font-black text-gray-300 uppercase tracking-[0.3em]">End of growth records</p>
      </div>
    </div>
  );
};

export default AchievementPage;