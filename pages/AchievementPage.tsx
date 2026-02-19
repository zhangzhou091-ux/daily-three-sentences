import React, { useMemo } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storageService';

interface AchievementPageProps {
  sentences: Sentence[];
}

// 工具函数：格式化日期为 YYYY-MM-DD
const formatDate = (date: Date) => {
  return date.toISOString().split('T')[0];
};

// 工具函数：格式化日期为 YYYY-MM（用于月度统计）
const formatMonth = (date: Date) => {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

// 工具函数：获取月份的天数
const getDaysInMonth = (year: number, month: number) => {
  return new Date(year, month + 1, 0).getDate();
};

// 工具函数：获取最近N天的日期数组（含格式化日期、星期）
const getRecentDays = (days: number) => {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    return {
      date: d,
      dateStr: formatDate(d),
      day: d.toLocaleDateString('zh-CN', { weekday: 'short' }),
      target: 3 // 每日固定目标3个
    };
  });
};

// 工具函数：获取最近N个月的数组（含年月、月份名称、当月天数）
const getRecentMonths = (months: number) => {
  return Array.from({ length: months }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - (months - 1 - i));
    const year = d.getFullYear();
    const month = d.getMonth();
    const monthStr = formatMonth(d);
    const monthName = d.toLocaleDateString('zh-CN', { month: 'short' });
    const days = getDaysInMonth(year, month);
    const target = days * 3; // 每月目标=当月天数*3
    
    return {
      year,
      month,
      monthStr,
      monthName,
      days,
      target
    };
  });
};

// 工具函数：按掌握等级分组统计
const getMasteryLevelStats = (sentences: Sentence[]) => {
  // 定义掌握等级映射
  const levels = [
    { name: '入门', key: 'lv1', min: 0, max: 1, color: 'bg-gray-100', textColor: 'text-gray-500' },
    { name: '基础', key: 'lv2', min: 2, max: 3, color: 'bg-blue-100', textColor: 'text-blue-500' },
    { name: '进阶', key: 'lv3', min: 4, max: 6, color: 'bg-purple-100', textColor: 'text-purple-500' },
    { name: '精通', key: 'lv4', min: 7, max: Infinity, color: 'bg-green-100', textColor: 'text-green-500' },
  ];

  // 统计各等级数量
  const levelCounts = levels.map(level => {
    const count = sentences.filter(s => 
      s.intervalIndex >= level.min && s.intervalIndex <= level.max
    ).length;
    const total = sentences.length;
    const ratio = total > 0 ? Math.round((count / total) * 100) : 0;
    return { ...level, count, ratio };
  });

  // 待提升（入门+基础）、已精通数量
  const needImprove = levelCounts.filter(l => l.key === 'lv1' || l.key === 'lv2').reduce((sum, l) => sum + l.count, 0);
  const mastered = levelCounts.find(l => l.key === 'lv4')?.count || 0;

  return { levelCounts, needImprove, mastered };
};

const AchievementPage: React.FC<AchievementPageProps> = ({ sentences }) => {
  const stats = storageService.getStats();
  
  // 补充默认值（避免字段缺失导致报错）
  const totalDictation = stats.totalDictation || 0; // 总默记数（需在存储中补充）
  const maxStreak = stats.maxStreak || stats.streak; // 历史最高连胜
  const breakTimes = stats.breakTimes || 0; // 中断次数（需在存储中补充）
  const streakQualified = stats.streakQualified || 0; // 连续达标天数（需在存储中补充）
  
  // 原有核心数据计算
  const masteredLv7 = sentences.filter(s => s.intervalIndex >= 7).length;
  const masteredLv4 = sentences.filter(s => s.intervalIndex >= 4).length;
  const totalReviewTimes = sentences.reduce((sum, s) => sum + (s.timesReviewed || 0), 0);
  const correctDictationCount = stats.dictationCount || 0;
  const totalDaysLearned = stats.totalDaysLearned || 0;
  const learnedTotal = sentences.filter(s => s.intervalIndex > 0).length;

  // 周度学习统计（最近7天，每日3个目标）
  const weekLearnData = useMemo(() => {
    const recent7Days = getRecentDays(7);
    const learnedSentences = sentences.filter(s => s.intervalIndex > 0 && s.lastReviewedAt);
    const dailyCompleteMap = new Map<string, number>();

    learnedSentences.forEach(s => {
      const sDateStr = formatDate(new Date(s.lastReviewedAt));
      dailyCompleteMap.set(sDateStr, (dailyCompleteMap.get(sDateStr) || 0) + 1);
    });

    const dailyData = recent7Days.map(day => ({
      ...day,
      complete: Math.min(dailyCompleteMap.get(day.dateStr) || 0, day.target)
    }));

    const weekTotalComplete = dailyData.reduce((sum, d) => sum + d.complete, 0);
    const weekTotalTarget = dailyData.reduce((sum, d) => sum + d.target, 0);
    const weekCompleteRate = Math.min(100, Math.round((weekTotalComplete / weekTotalTarget) * 100));

    return { dailyData, weekTotalComplete, weekTotalTarget, weekCompleteRate };
  }, [sentences]);

  // 🔥 新增：月度学习统计（最近6个月，每月目标=当月天数*3）
  const monthLearnData = useMemo(() => {
    const recent6Months = getRecentMonths(6);
    const learnedSentences = sentences.filter(s => s.intervalIndex > 0 && s.lastReviewedAt);
    const monthlyCompleteMap = new Map<string, number>();

    // 按年月分组统计每月完成数
    learnedSentences.forEach(s => {
      const sMonthStr = formatMonth(new Date(s.lastReviewedAt));
      monthlyCompleteMap.set(sMonthStr, (monthlyCompleteMap.get(sMonthStr) || 0) + 1);
    });

    // 组装6个月数据（匹配年月，补全0完成）
    const monthlyData = recent6Months.map(month => ({
      ...month,
      complete: Math.min(monthlyCompleteMap.get(month.monthStr) || 0, month.target),
      completeRate: month.target > 0 ? Math.min(100, Math.round((monthlyCompleteMap.get(month.monthStr) || 0) / month.target * 100)) : 0
    }));

    // 月度汇总
    const monthTotalComplete = monthlyData.reduce((sum, m) => sum + m.complete, 0);
    const monthTotalTarget = monthlyData.reduce((sum, m) => sum + m.target, 0);
    const monthAvgRate = monthTotalTarget > 0 ? Math.min(100, Math.round((monthTotalComplete / monthTotalTarget) * 100)) : 0;

    // 趋势判断
    let monthTrend = '📊 平稳';
    const latest2Months = monthlyData.slice(-2);
    if (latest2Months.length === 2) {
      const prevRate = latest2Months[0].completeRate;
      const currRate = latest2Months[1].completeRate;
      if (currRate - prevRate > 10) monthTrend = '📈 上升';
      if (currRate - prevRate < -10) monthTrend = '📉 下降';
    }

    return { monthlyData, monthTotalComplete, monthTotalTarget, monthAvgRate, monthTrend };
  }, [sentences]);

  // 默写专项统计
  const dictationStats = useMemo(() => {
    // 默写正确率（无总默记数则用已学习数替代）
    const dictationAccuracy = totalDictation > 0 
      ? Math.min(100, Math.round((correctDictationCount / totalDictation) * 100)) 
      : learnedTotal > 0 ? Math.round((correctDictationCount / learnedTotal) * 100) : 0;
    
    // 周默写完成量（取最近7天默写数，无则用周学习数替代）
    const weekDictationComplete = stats.weekDictationCount || weekLearnData.weekTotalComplete;
    const weekDictationTarget = 21; // 每日3个，周21个
    const weekDictationRate = Math.min(100, Math.round((weekDictationComplete / weekDictationTarget) * 100));
    
    // 单日最高正确默写数（需在存储中补充，无则用当前正确数）
    const maxDailyDictation = stats.maxDailyDictation || correctDictationCount;
    
    return {
      dictationAccuracy,
      weekDictationComplete,
      weekDictationRate,
      maxDailyDictation
    };
  }, [correctDictationCount, totalDictation, learnedTotal, stats, weekLearnData.weekTotalComplete]);

  // 掌握程度精细化统计
  const masteryStats = useMemo(() => {
    return getMasteryLevelStats(sentences);
  }, [sentences]);

  // 连续学习精细化统计
  const streakStats = useMemo(() => {
    // 达标率（累计达标天数/累计学习天数）
    const qualifiedRate = totalDaysLearned > 0 
      ? Math.min(100, Math.round((streakQualified / totalDaysLearned) * 100)) 
      : 0;
    
    // 趋势标签
    let streakTrend = '📊 平稳';
    if (stats.streak > maxStreak * 0.8) streakTrend = '📈 持续提升';
    if (stats.streak < maxStreak * 0.3) streakTrend = '📉 需加油';

    return {
      currentStreak: stats.streak,
      maxStreak,
      breakTimes,
      streakQualified,
      qualifiedRate,
      streakTrend
    };
  }, [stats.streak, maxStreak, breakTimes, streakQualified, totalDaysLearned]);

  // 学习效率统计（原阅读统计调整）
  const learnEfficiencyStats = useMemo(() => {
    // 平均每日学习数
    const avgDailyLearn = totalDaysLearned > 0 
      ? parseFloat((learnedTotal / totalDaysLearned).toFixed(1)) 
      : 0;
    
    // 学习达标率（达标天数/总学习天数）
    const learnQualifiedRate = totalDaysLearned > 0 
      ? Math.min(100, Math.round((streakQualified / totalDaysLearned) * 100)) 
      : 0;
    
    // 低效学习天数（从周度数据提取）
    const lowEfficiencyDays = weekLearnData.dailyData.filter(d => d.complete < 1).length;
    
    // 效率标签
    let efficiencyTag = '💪 高效';
    if (avgDailyLearn < 1) efficiencyTag = '⏳ 待提升';
    else if (avgDailyLearn < 3) efficiencyTag = '⚡ 中等';

    return {
      avgDailyLearn,
      learnQualifiedRate,
      lowEfficiencyDays,
      efficiencyTag
    };
  }, [learnedTotal, totalDaysLearned, streakQualified, weekLearnData.dailyData]);

  const levelData = useMemo(() => {
    const points = stats.totalPoints;
    if (points < 200) return { lv: 1, title: '初级探索者', next: 200, color: 'from-blue-500 to-indigo-400' };
    if (points < 600) return { lv: 2, title: '新晋学者', next: 600, color: 'from-indigo-500 to-purple-400' };
    if (points < 1200) return { lv: 3, title: '勤奋达人', next: 1200, color: 'from-purple-500 to-pink-400' };
    if (points < 2500) return { lv: 4, title: '语境专家', next: 2500, color: 'from-pink-500 to-rose-400' };
    return { lv: 5, title: '英语大师', next: Math.max(points, 5000), color: 'from-rose-500 to-orange-400' };
  }, [stats.totalPoints]);

  const progressXP = (stats.totalPoints / levelData.next) * 100;

  // 热力图数据
  const heatmapData = useMemo(() => {
    return weekLearnData.dailyData.map(day => {
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

      return {
        ...day,
        status,
        icon,
        bgClass,
        textClass,
        displayText: day.complete > 0 ? day.complete.toString() : ''
      };
    });
  }, [weekLearnData.dailyData]);

  // 成就勋章（新增默写/学习效率相关成就）
  const milestones = [
    // 连续学习类
    { title: '滴水穿石', icon: '🔥', target: 7, current: stats.streak, desc: '连续 7 天不间断学习' },
    { title: '百日坚持', icon: '🌱', target: 30, current: stats.streak, desc: '连续 30 天不间断学习' },
    { title: '日积月累', icon: '📆', target: 100, current: totalDaysLearned, desc: '累计学习天数达到 100 天' },
    { title: '连胜王者', icon: '🏆', target: 50, current: maxStreak, desc: '历史最高连续学习 50 天' },
    // 词库收藏类
    { title: '厚积薄发', icon: '🎓', target: 100, current: sentences.length, desc: '词库句子总数达到 100' },
    { title: '学富五车', icon: '📚', target: 500, current: sentences.length, desc: '词库句子总数达到 500' },
    // 掌握程度类
    { title: '初窥门径', icon: '🌟', target: 10, current: masteredLv4, desc: '掌握 10 个进阶难度句子' },
    { title: '进阶掌握', icon: '💪', target: 30, current: masteredLv4, desc: '掌握 30 个进阶难度句子' },
    { title: '完全掌握', icon: '🏆', target: 50, current: masteredLv7, desc: '彻底攻克 50 个复杂句子' },
    { title: '精通达人', icon: '👑', target: 100, current: masteredLv7, desc: '彻底攻克 100 个复杂句子' },
    // 复习类
    { title: '温故知新', icon: '🔄', target: 50, current: totalReviewTimes, desc: '累计复习句子达到 50 次' },
    { title: '复习标兵', icon: '🎯', target: 200, current: totalReviewTimes, desc: '累计复习句子达到 200 次' },
    // 默写类
    { title: '默写能手', icon: '✍️', target: 50, current: correctDictationCount, desc: '累计正确默写 50 个句子' },
    { title: '默写大师', icon: '🎨', target: 200, current: correctDictationCount, desc: '累计正确默写 200 个句子' },
    { title: '默写全对', icon: '💯', target: 95, current: dictationStats.dictationAccuracy, desc: '默写正确率达到 95%' },
    // 积分类
    { title: '积分巨贾', icon: '💎', target: 2000, current: stats.totalPoints, desc: '累计获得超过 2000 积分' },
    { title: '积分富豪', icon: '💰', target: 5000, current: stats.totalPoints, desc: '累计获得超过 5000 积分' },
    // 学习效率类
    { title: '高效学习', icon: '⚡', target: 3, current: learnEfficiencyStats.avgDailyLearn, desc: '日均学习达到 3 个句子' },
    { title: '达标达人', icon: '✅', target: 90, current: learnEfficiencyStats.learnQualifiedRate, desc: '学习达标率达到 90%' },
    // 新增月度成就
    { title: '月度达标', icon: '📅', target: 80, current: monthLearnData.monthAvgRate, desc: '月度平均完成率达到 80%' },
    { title: '月度王者', icon: '🏅', target: 100, current: monthLearnData.monthAvgRate, desc: '月度平均完成率达到 100%' },
  ];

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-700 px-2 sm:px-0">
      {/* 等级头卡片 */}
      <div className={`apple-card bg-gradient-to-br ${levelData.color} p-10 text-white relative overflow-hidden shadow-2xl shadow-blue-200/50`}>
        <div className="absolute -right-12 -top-12 w-48 h-48 bg-white/10 rounded-full blur-3xl" />
        <div className="absolute -left-12 -bottom-12 w-48 h-48 bg-black/10 rounded-full blur-3xl" />
        
        <div className="relative z-10 flex items-center gap-8 mb-10">
          <div className="w-24 h-24 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-2xl border border-white/40 shadow-inner group transition-transform duration-500 hover:scale-105">
            <span className="text-5xl group-hover:rotate-12 transition-transform">🦁</span>
          </div>
          <div className="space-y-1">
            <h2 className="text-3xl font-black tracking-tighter uppercase">English Master</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="bg-white/20 px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-widest backdrop-blur-md">Level {levelData.lv}</span>
              <span className="text-white/80 text-xs font-bold">{levelData.title}</span>
            </div>
          </div>
        </div>

        <div className="relative z-10 space-y-3">
          <div className="flex justify-between items-end text-[10px] font-black uppercase tracking-[0.2em] opacity-80">
            <span>Progress to Next Level</span>
            <span>{stats.totalPoints} / {levelData.next} XP</span>
          </div>
          <div className="w-full bg-black/20 h-4 rounded-full overflow-hidden border border-white/20 backdrop-blur-lg p-0.5">
            <div 
              className="h-full bg-white rounded-full transition-all duration-1000 shadow-[0_0_20px_rgba(255,255,255,0.8)]"
              style={{ width: `${Math.min(100, progressXP)}%` }}
            />
          </div>
        </div>
      </div>

      {/* 核心统计卡片 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="apple-card p-8 flex flex-col items-center justify-center text-center space-y-3 group hover:-translate-y-1">
          <div className="w-14 h-14 bg-orange-50 rounded-[1.5rem] flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">🔥</div>
          <div>
            <h4 className="text-2xl font-black text-gray-900 tracking-tight">{stats.streak}</h4>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">天连续学习</p>
          </div>
        </div>
        <div className="apple-card p-8 flex flex-col items-center justify-center text-center space-y-3 group hover:-translate-y-1">
          <div className="w-14 h-14 bg-blue-50 rounded-[1.5rem] flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">📚</div>
          <div>
            <h4 className="text-2xl font-black text-gray-900 tracking-tight">{sentences.length}</h4>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">个句子收藏</p>
          </div>
        </div>
        <div className="apple-card p-8 flex flex-col items-center justify-center text-center space-y-3 group hover:-translate-y-1">
          <div className="w-14 h-14 bg-purple-50 rounded-[1.5rem] flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">🔄</div>
          <div>
            <h4 className="text-2xl font-black text-gray-900 tracking-tight">{totalReviewTimes}</h4>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">次累计复习</p>
          </div>
        </div>
        <div className="apple-card p-8 flex flex-col items-center justify-center text-center space-y-3 group hover:-translate-y-1">
          <div className="w-14 h-14 bg-green-50 rounded-[1.5rem] flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">✍️</div>
          <div>
            <h4 className="text-2xl font-black text-gray-900 tracking-tight">{correctDictationCount}</h4>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">个正确默写</p>
          </div>
        </div>
      </div>

      {/* 学习热力图 */}
      <div className="apple-card p-8 space-y-8">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-black text-gray-900 tracking-tight flex items-center gap-2">
            <span>📅</span> 学习热力图
          </h3>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-green-500"></div>
              <span className="text-[9px] font-bold text-gray-500">达标(3)</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-amber-100 border border-amber-300"></div>
              <span className="text-[9px] font-bold text-gray-500">部分</span>
            </div>
          </div>
        </div>
        <div className="flex justify-between px-4">
          {heatmapData.map((item, idx) => (
            <div key={idx} className="flex flex-col items-center gap-2 w-16">
              <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                {item.day}
              </span>
              <div 
                className={`w-14 h-14 rounded-2xl transition-all duration-300 shadow-sm flex flex-col items-center justify-center ${item.bgClass}`}
                title={`${item.dateStr}: 完成 ${item.complete} / ${item.target} 个`}
              >
                <span className={`text-xl mb-1 ${item.textClass}`}>{item.icon}</span>
                <span className={`text-sm font-black ${item.textClass}`}>{item.displayText}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 周度学习统计 */}
      <div className="apple-card p-8 space-y-8">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-black text-gray-900 tracking-tight flex items-center gap-2">
            <span>📈</span> 周度学习统计
          </h3>
          <span className="text-[9px] font-black text-green-500 bg-green-50 px-3 py-1 rounded-full uppercase tracking-widest">
            每日目标 3 个 | 周目标 21 个
          </span>
        </div>
        <div className="flex justify-between items-center gap-2 overflow-x-auto pb-4">
          {weekLearnData.dailyData.map((day, idx) => (
            <div 
              key={idx} 
              className="flex-shrink-0 w-16 flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border transition-all"
              style={{
                borderColor: day.complete >= day.target ? '#22c55e' : '#e5e7eb',
                backgroundColor: day.complete >= day.target ? 'rgba(34, 197, 94, 0.05)' : 'white'
              }}
            >
              <span className={`text-[10px] font-black uppercase tracking-widest ${day.complete >= day.target ? 'text-green-600' : 'text-gray-400'}`}>
                {day.day}
              </span>
              <span className="text-xl font-black text-gray-900">{day.complete}</span>
              <span className="text-[9px] text-gray-300 font-bold">/ {day.target}</span>
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <div className="flex justify-between items-end text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
            <span>周度完成率</span>
            <span className="text-gray-900">{weekLearnData.weekTotalComplete} / {weekLearnData.weekTotalTarget} 个</span>
          </div>
          <div className="w-full bg-gray-100 h-4 rounded-full overflow-hidden p-0.5">
            <div 
              className="h-full bg-green-500 rounded-full transition-all duration-1000 shadow-[0_0_10px_rgba(34,197,94,0.4)]"
              style={{ width: `${weekLearnData.weekCompleteRate}%` }}
            />
          </div>
          <div className="text-right text-sm font-black text-green-600">
            完成率：{weekLearnData.weekCompleteRate}%
          </div>
        </div>
      </div>

      {/* 🔥 新增：月度学习统计模块 */}
      <div className="apple-card p-8 space-y-8">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-black text-gray-900 tracking-tight flex items-center gap-2">
            <span>🗓️</span> 月度学习统计
          </h3>
          <span className="text-[9px] font-black text-blue-500 bg-blue-50 px-3 py-1 rounded-full uppercase tracking-widest">
            {monthLearnData.monthTrend} | 平均完成率 {monthLearnData.monthAvgRate}%
          </span>
        </div>
        {/* 月度卡片横向滚动 */}
        <div className="flex justify-between items-center gap-2 overflow-x-auto pb-4">
          {monthLearnData.monthlyData.map((month, idx) => (
            <div 
              key={idx} 
              className="flex-shrink-0 w-20 flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border transition-all"
              style={{
                borderColor: month.completeRate >= 80 ? '#3b82f6' : '#e5e7eb',
                backgroundColor: month.completeRate >= 80 ? 'rgba(59, 130, 246, 0.05)' : 'white'
              }}
            >
              <span className={`text-[10px] font-black uppercase tracking-widest ${month.completeRate >= 80 ? 'text-blue-600' : 'text-gray-400'}`}>
                {month.monthName}
              </span>
              <span className="text-lg font-black text-gray-900">{month.complete}</span>
              <span className="text-[8px] text-gray-300 font-bold">/{month.target}</span>
              <span className="text-[9px] font-bold text-gray-500">{month.completeRate}%</span>
            </div>
          ))}
        </div>
        {/* 月度汇总进度 */}
        <div className="space-y-3">
          <div className="flex justify-between items-end text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
            <span>近6个月完成率</span>
            <span className="text-gray-900">{monthLearnData.monthTotalComplete} / {monthLearnData.monthTotalTarget} 个</span>
          </div>
          <div className="w-full bg-gray-100 h-4 rounded-full overflow-hidden p-0.5">
            <div 
              className="h-full bg-blue-500 rounded-full transition-all duration-1000 shadow-[0_0_10px_rgba(59,130,246,0.4)]"
              style={{ width: `${monthLearnData.monthAvgRate}%` }}
            />
          </div>
          <div className="text-right text-sm font-black text-blue-600">
            平均完成率：{monthLearnData.monthAvgRate}%
          </div>
        </div>
        {/* 月度提示 */}
        <div className="p-3 bg-blue-50 rounded-xl flex items-center gap-3">
          <span className="text-blue-500 text-lg">💡</span>
          <div>
            <p className="text-[10px] font-black text-gray-900">月度学习建议</p>
            <p className="text-[9px] text-gray-500 leading-relaxed">
              {monthLearnData.monthAvgRate >= 80 
                ? '你的月度学习完成率优秀，保持稳定的学习节奏！' 
                : '建议每月制定学习计划，优先完成当月80%以上的目标，提升长期学习效果。'}
            </p>
          </div>
        </div>
      </div>

      {/* 默写专项统计 */}
      <div className="apple-card p-8 space-y-8">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-black text-gray-900 tracking-tight flex items-center gap-2">
            <span>✍️</span> 默写专项统计
          </h3>
          <span className="text-[9px] font-black text-green-500 bg-green-50 px-3 py-1 rounded-full uppercase tracking-widest">
            正确率 {dictationStats.dictationAccuracy}%
          </span>
        </div>
        {/* 核心数据卡片 */}
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="p-4 bg-green-50 rounded-2xl">
            <p className="text-[10px] text-green-500 font-black uppercase tracking-widest mb-2">累计正确率</p>
            <p className="text-2xl font-black text-gray-900">{dictationStats.dictationAccuracy}%</p>
            <p className="text-[10px] text-gray-400">精准度</p>
          </div>
          <div className="p-4 bg-orange-50 rounded-2xl">
            <p className="text-[10px] text-orange-500 font-black uppercase tracking-widest mb-2">单日最高</p>
            <p className="text-2xl font-black text-gray-900">{dictationStats.maxDailyDictation}</p>
            <p className="text-[10px] text-gray-400">个正确默写</p>
          </div>
          <div className="p-4 bg-blue-50 rounded-2xl">
            <p className="text-[10px] text-blue-500 font-black uppercase tracking-widest mb-2">周完成量</p>
            <p className="text-2xl font-black text-gray-900">{dictationStats.weekDictationComplete}</p>
            <p className="text-[10px] text-gray-400">/ 21 个目标</p>
          </div>
        </div>
        {/* 周默写完成率进度条 */}
        <div className="space-y-3">
          <div className="flex justify-between items-end text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
            <span>周默写完成率</span>
            <span className="text-gray-900">{dictationStats.weekDictationRate}%</span>
          </div>
          <div className="w-full bg-gray-100 h-4 rounded-full overflow-hidden p-0.5">
            <div 
              className="h-full bg-green-500 rounded-full transition-all duration-1000 shadow-[0_0_10px_rgba(34,197,94,0.4)]"
              style={{ width: `${dictationStats.weekDictationRate}%` }}
            />
          </div>
        </div>
      </div>

      {/* 掌握程度精细化统计 */}
      <div className="apple-card p-8 space-y-8">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-black text-gray-900 tracking-tight flex items-center gap-2">
            <span>📊</span> 掌握程度统计
          </h3>
          <span className="text-[9px] font-black text-purple-500 bg-purple-50 px-3 py-1 rounded-full uppercase tracking-widest">
            待提升 {masteryStats.needImprove} 个 | 已精通 {masteryStats.mastered} 个
          </span>
        </div>
        {/* 各等级占比卡片 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {masteryStats.levelCounts.map((level, idx) => (
            <div key={idx} className={`p-4 rounded-2xl ${level.color}`}>
              <p className={`text-[10px] font-black uppercase tracking-widest mb-2 ${level.textColor}`}>{level.name}</p>
              <p className="text-xl font-black text-gray-900">{level.count}</p>
              <p className="text-[9px] text-gray-500 font-bold">{level.ratio}%</p>
            </div>
          ))}
        </div>
        {/* 等级分布进度条 */}
        <div className="space-y-2">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">掌握等级分布</p>
          <div className="w-full h-3 rounded-full overflow-hidden flex">
            {masteryStats.levelCounts.map((level, idx) => (
              <div 
                key={idx} 
                className={`h-full ${level.color.replace('bg-', 'bg-').replace('-100', '-500')}`}
                style={{ width: `${level.ratio}%` }}
                title={`${level.name}: ${level.count} 个 (${level.ratio}%)`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* 连续学习精细化统计 */}
      <div className="apple-card p-8 space-y-8">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-black text-gray-900 tracking-tight flex items-center gap-2">
            <span>🔥</span> 连续学习统计
          </h3>
          <span className="text-[9px] font-black text-orange-500 bg-orange-50 px-3 py-1 rounded-full uppercase tracking-widest">
            {streakStats.streakTrend}
          </span>
        </div>
        {/* 核心数据卡片 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-4 bg-orange-50 rounded-2xl text-center">
            <p className="text-[10px] text-orange-500 font-black uppercase tracking-widest mb-2">当前连胜</p>
            <p className="text-xl font-black text-gray-900">{streakStats.currentStreak}</p>
            <p className="text-[9px] text-gray-500">天</p>
          </div>
          <div className="p-4 bg-red-50 rounded-2xl text-center">
            <p className="text-[10px] text-red-500 font-black uppercase tracking-widest mb-2">历史最高</p>
            <p className="text-xl font-black text-gray-900">{streakStats.maxStreak}</p>
            <p className="text-[9px] text-gray-500">天</p>
          </div>
          <div className="p-4 bg-blue-50 rounded-2xl text-center">
            <p className="text-[10px] text-blue-500 font-black uppercase tracking-widest mb-2">连续达标</p>
            <p className="text-xl font-black text-gray-900">{streakStats.streakQualified}</p>
            <p className="text-[9px] text-gray-500">天</p>
          </div>
          <div className="p-4 bg-green-50 rounded-2xl text-center">
            <p className="text-[10px] text-green-500 font-black uppercase tracking-widest mb-2">达标率</p>
            <p className="text-xl font-black text-gray-900">{streakStats.qualifiedRate}%</p>
            <p className="text-[9px] text-gray-500">总学习</p>
          </div>
        </div>
        {/* 中断次数提示 */}
        <div className="p-3 bg-gray-50 rounded-xl flex items-center gap-3">
          <span className="text-red-500 text-lg">⚠️</span>
          <div>
            <p className="text-[10px] font-black text-gray-900">历史中断 {streakStats.breakTimes} 次</p>
            <p className="text-[9px] text-gray-500">保持连续学习，解锁更多勋章</p>
          </div>
        </div>
      </div>

      {/* 学习效率统计 */}
      <div className="apple-card p-8 space-y-8">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-black text-gray-900 tracking-tight flex items-center gap-2">
            <span>⚡</span> 学习效率统计
          </h3>
          <span className="text-[9px] font-black text-blue-500 bg-blue-50 px-3 py-1 rounded-full uppercase tracking-widest">
            {learnEfficiencyStats.efficiencyTag}
          </span>
        </div>
        {/* 核心数据 */}
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="p-4 bg-blue-50 rounded-2xl">
            <p className="text-[10px] text-blue-500 font-black uppercase tracking-widest mb-2">日均学习</p>
            <p className="text-2xl font-black text-gray-900">{learnEfficiencyStats.avgDailyLearn}</p>
            <p className="text-[10px] text-gray-400">个句子</p>
          </div>
          <div className="p-4 bg-orange-50 rounded-2xl">
            <p className="text-[10px] text-orange-500 font-black uppercase tracking-widest mb-2">达标率</p>
            <p className="text-2xl font-black text-gray-900">{learnEfficiencyStats.learnQualifiedRate}%</p>
            <p className="text-[10px] text-gray-400">累计学习</p>
          </div>
          <div className="p-4 bg-purple-50 rounded-2xl">
            <p className="text-[10px] text-purple-500 font-black uppercase tracking-widest mb-2">低效天数</p>
            <p className="text-2xl font-black text-gray-900">{learnEfficiencyStats.lowEfficiencyDays}</p>
            <p className="text-[10px] text-gray-400">近7天</p>
          </div>
        </div>
        {/* 效率建议 */}
        <div className="p-4 bg-white border border-gray-100 rounded-xl">
          <p className="text-[10px] font-black text-gray-900 mb-2">📝 学习效率建议</p>
          <p className="text-[9px] text-gray-500 leading-relaxed">
            {learnEfficiencyStats.avgDailyLearn >= 3 
              ? '你的日均学习量已达标，保持当前节奏，继续加油！' 
              : '建议每天固定学习3个句子，提升学习效率，早日达标！'}
          </p>
        </div>
      </div>

      {/* 荣誉勋章墙（新增月度成就） */}
      <div className="space-y-6">
        <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.3em] ml-6">荣誉勋章墙</h3>
        <div className="grid grid-cols-1 gap-4">
          {milestones.map((m, i) => {
            const progress = Math.min(100, (m.current / m.target) * 100);
            const isUnlocked = progress >= 100;
            return (
              <div key={i} className={`apple-card p-6 transition-all duration-500 border-2 ${isUnlocked ? 'border-blue-100 bg-white' : 'border-transparent bg-white/40'}`}>
                <div className="flex items-center gap-6">
                  <div className={`text-2xl w-16 h-16 flex items-center justify-center rounded-[1.5rem] shadow-sm ${isUnlocked ? 'bg-blue-600 text-white rotate-0' : 'bg-gray-100 text-gray-300 -rotate-12'}`}>
                    {m.icon}
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between items-end mb-2.5">
                      <div>
                        <h4 className={`font-black tracking-tight text-sm ${isUnlocked ? 'text-gray-900' : 'text-gray-400'}`}>{m.title}</h4>
                        <p className="text-[10px] text-gray-400 font-medium leading-tight max-w-[200px]">{m.desc}</p>
                      </div>
                      <span className={`text-[11px] font-black ${isUnlocked ? 'text-blue-600' : 'text-gray-300'}`}>{m.current} / {m.target}</span>
                    </div>
                    <div className="w-full bg-gray-100 h-1.5 rounded-full overflow-hidden p-0.5">
                      <div 
                        className={`h-full transition-all duration-1000 rounded-full ${isUnlocked ? 'bg-blue-600' : 'bg-blue-300/30'}`} 
                        style={{ width: `${progress}%` }} 
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="text-center pb-8">
        <p className="text-[10px] font-black text-gray-300 uppercase tracking-[0.3em]">End of growth records</p>
      </div>
    </div>
  );
};

export default AchievementPage;