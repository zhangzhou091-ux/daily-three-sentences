import React, { useState, useMemo } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storage';
import { useAnalytics } from '../core/hooks/useAnalytics';
import { 
  ACHIEVEMENT_CATEGORIES, 
  TIER_CONFIG, 
  Achievement, 
  AchievementCategory,
  AchievementTier,
  computeOverallProgress,
  getRecommendations,
  getTotalRewards,
} from '../core/analytics';
import { useAppContext } from '../context/AppContext';
import { 
  getDateRanges, 
  computeTrendData, 
  computeComparison, 
  METRICS,
  DateRange,
} from '../core/analytics/dataStats';
import { loadEvents } from '../core/schedule/scheduleService';
import { 
  exportToCSV, 
  exportToExcel, 
  exportToJson, 
  prepareExportData 
} from '../core/analytics/exportService';
import { SimpleChart, ComparisonCard } from '../components/charts/SimpleChart';
import { ContributionHeatmap, generateHeatmapData } from '../components/charts/ContributionHeatmap';
import { AchievementShareCard } from '../components/achievements/AchievementShareCard';

type TabType = 'stats' | 'achievements' | 'fsrs';

const StatCardSimple = ({ icon, value, label, subValue }: { icon: string, value: string | number, label: string, subValue?: string }) => (
  <div className="bg-white/70 backdrop-blur-md rounded-[24px] p-5 flex flex-col items-center text-center shadow-sm border border-white/40">
    <div className="text-2xl mb-2">{icon}</div>
    <div className="text-2xl font-black text-gray-900 tracking-tight leading-none">{value}</div>
    <div className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mt-2">{label}</div>
    {subValue && <div className="text-[9px] text-blue-500 font-bold mt-1">{subValue}</div>}
  </div>
);

const TABS: { key: TabType; label: string; icon: string }[] = [
  { key: 'stats', label: '数据统计', icon: '📊' },
  { key: 'achievements', label: '成就达成', icon: '🏆' },
  { key: 'fsrs', label: 'FSRS 算法', icon: '🧠' },
];

const MATURE_THRESHOLD = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

const safeNumber = (value: unknown, defaultValue: number = 0): number => {
  if (typeof value === 'number' && !isNaN(value) && isFinite(value)) {
    return Math.max(0, value);
  }
  return defaultValue;
};

const safeDivide = (numerator: number, denominator: number, defaultValue: number = 0): number => {
  if (!denominator || Math.abs(denominator) < 0.0001 || !isFinite(denominator)) {
    return defaultValue;
  }
  const result = numerator / denominator;
  return isFinite(result) ? result : defaultValue;
};

const safePercent = (value: number): number => {
  return Math.max(0, Math.min(100, safeNumber(value, 0)));
};

const AchievementPage: React.FC<{ sentences: Sentence[] }> = ({ sentences }) => {
  const { setView, stats } = useAppContext();
  const { memory, forecast, level, achievements, timeStats } = useAnalytics(sentences, stats);
  const events = useMemo(() => loadEvents(), []);
  const [activeTab, setActiveTab] = useState<TabType>('stats');
  const [activeTimeTab, setActiveTimeTab] = useState<'weekly' | 'monthly' | 'yearly' | 'allTime'>('weekly');
  const [selectedMetric, setSelectedMetric] = useState(METRICS[0].id);
  const [selectedDateRange, setSelectedDateRange] = useState<DateRange>(() => getDateRanges()[0]);
  const chartType = 'area' as const;
  const [retentionFilter, setRetentionFilter] = useState<'unmature' | 'mature' | 'all'>('all');
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [hoveredDay, setHoveredDay] = useState<{ day: number; retention: number } | null>(null);
  const goalRetention = 90;
  const [selectedCategory, setSelectedCategory] = useState<AchievementCategory | 'all'>('all');
  const [selectedTier, setSelectedTier] = useState<AchievementTier | 'all'>('all');
  const [sharingAchievement, setSharingAchievement] = useState<Achievement | null>(null);

  const heatmapData = useMemo(() => {
    return generateHeatmapData(sentences, selectedYear);
  }, [sentences, selectedYear]);

  const currentTimeStats = timeStats[activeTimeTab];
  
  const dateRanges = getDateRanges();
  
  const trendData = useMemo(() => {
    return computeTrendData(sentences, stats, selectedMetric, selectedDateRange, 'day');
  }, [sentences, stats, selectedMetric, selectedDateRange]);
  
  const comparisonData = useMemo(() => {
    return computeComparison(sentences, stats, selectedMetric);
  }, [sentences, stats, selectedMetric]);

  const retentionStats = useMemo(() => {
    const now = Date.now();
    
    const getTimeRange = (type: 'today' | 'yesterday' | 'lastWeek' | 'lastMonth' | 'lastYear') => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      switch (type) {
        case 'today':
          return { start: today.getTime(), end: now };
        case 'yesterday':
          return { start: today.getTime() - DAY_MS, end: today.getTime() };
        case 'lastWeek':
          return { start: today.getTime() - 7 * DAY_MS, end: now };
        case 'lastMonth':
          return { start: today.getTime() - 30 * DAY_MS, end: now };
        case 'lastYear':
          return { start: today.getTime() - 365 * DAY_MS, end: now };
        default:
          return { start: today.getTime(), end: now };
      }
    };

    const calculateRetention = (range: { start: number; end: number }) => {
      let unmatureRecall = 0;
      let unmatureCount = 0;
      let matureRecall = 0;
      let matureCount = 0;

      sentences.forEach(s => {
        const lastReviewed = s.lastReviewedAt || 0;
        if (lastReviewed >= range.start && lastReviewed <= range.end && s.intervalIndex > 0) {
          const stability = s.stability || 0;
          
          if (stability > 0) {
            const elapsedDays = (now - lastReviewed) / DAY_MS;
            const recall = Math.pow(0.9, elapsedDays / stability);
            
            if (stability < MATURE_THRESHOLD) {
              unmatureRecall += recall;
              unmatureCount++;
            } else {
              matureRecall += recall;
              matureCount++;
            }
          }
        }
      });

      const unmatureRate = unmatureCount > 0 ? Math.round(safePercent((unmatureRecall / unmatureCount) * 100)) : 0;
      const matureRate = matureCount > 0 ? Math.round(safePercent((matureRecall / matureCount) * 100)) : 0;
      
      let filteredRate = 0;
      let filteredCount = 0;
      
      if (retentionFilter === 'unmature') {
        filteredRate = unmatureRate;
        filteredCount = unmatureCount;
      } else if (retentionFilter === 'mature') {
        filteredRate = matureRate;
        filteredCount = matureCount;
      } else {
        const totalRecall = unmatureRecall + matureRecall;
        const totalCount = unmatureCount + matureCount;
        filteredRate = totalCount > 0 ? Math.round(safePercent((totalRecall / totalCount) * 100)) : 0;
        filteredCount = totalCount;
      }

      return {
        unmature: { rate: unmatureRate, count: unmatureCount, hasData: unmatureCount > 0 },
        mature: { rate: matureRate, count: matureCount, hasData: matureCount > 0 },
        total: { rate: filteredRate, count: filteredCount, hasData: filteredCount > 0 },
        allCount: unmatureCount + matureCount
      };
    };

    return {
      today: calculateRetention(getTimeRange('today')),
      yesterday: calculateRetention(getTimeRange('yesterday')),
      lastWeek: calculateRetention(getTimeRange('lastWeek')),
      lastMonth: calculateRetention(getTimeRange('lastMonth')),
      lastYear: calculateRetention(getTimeRange('lastYear')),
    };
  }, [sentences, retentionFilter]);

  const hardestSentences = useMemo(() => {
    return sentences
      .filter(s => s.intervalIndex > 0 && (s.difficulty || 5) >= 7 && (s.stability || 0) < 7)
      .map(s => ({
        id: s.id,
        english: s.english,
        chinese: s.chinese,
        difficulty: s.difficulty || 5,
        stability: s.stability || 0,
        lapses: s.lapses || 0,
        reps: s.reps || 0,
      }))
      .sort((a, b) => {
        const scoreA = a.difficulty - a.stability + a.lapses * 0.5;
        const scoreB = b.difficulty - b.stability + b.lapses * 0.5;
        return scoreB - scoreA;
      })
      .slice(0, 5);
  }, [sentences]);

  const forgettingCurveData = useMemo(() => {
    const avgStability = Math.max(0.1, safeNumber(memory.avgStability, 1));
    const curvePoints = [];
    for (let day = 0; day <= 30; day++) {
      const retention = safePercent(Math.pow(0.9, safeDivide(day, avgStability, 1)) * 100);
      curvePoints.push({
        day,
        retention,
      });
    }
    
    const tomorrowRetention = safePercent(Math.pow(0.9, safeDivide(1, avgStability, 1)) * 100);
    const weekRetention = safePercent(Math.pow(0.9, safeDivide(7, avgStability, 1)) * 100);
    const monthRetention = safePercent(Math.pow(0.9, safeDivide(30, avgStability, 1)) * 100);
    
    return {
      curve: curvePoints,
      predictions: {
        tomorrow: Math.round(tomorrowRetention),
        week: Math.round(weekRetention),
        month: Math.round(monthRetention),
      },
      willForgetTomorrow: Math.max(0, Math.round(safeNumber(memory.learned, 0) * (1 - tomorrowRetention / 100))),
    };
  }, [memory.avgStability, memory.learned]);
  
  const handleExport = (format: 'csv' | 'excel' | 'json') => {
    const allTrendData = METRICS.map(metric => 
      computeTrendData(sentences, stats, metric.id, selectedDateRange, 'day')
    );
    const exportData = prepareExportData(sentences, stats, timeStats, events, allTrendData);
    const filename = `daily-three-sentences-${new Date().toISOString().split('T')[0]}`;
    
    switch (format) {
      case 'csv':
        exportToCSV(exportData, filename);
        break;
      case 'excel':
        exportToExcel(exportData, filename);
        break;
      case 'json':
        exportToJson(exportData, filename);
        break;
    }
  };

  const renderStatsTab = () => (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* 等级与 XP */}
      <div className={`relative overflow-hidden rounded-[32px] p-8 text-white bg-gradient-to-br ${level.color} shadow-2xl shadow-indigo-200`}>
        <div className="relative z-10">
          <div className="flex justify-between items-start mb-6">
            <div>
              <h2 className="text-4xl font-black tracking-tighter mb-1">LV.{level.level}</h2>
              <p className="text-sm font-bold opacity-90 tracking-widest uppercase">{level.title}</p>
            </div>
            <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center backdrop-blur-md border border-white/30 text-2xl">
              🦁
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-[10px] font-black uppercase tracking-[0.2em] opacity-80">
              <span>EXP Progress</span>
              <span>{level.currentPoints} XP</span>
            </div>
            <div className="h-2.5 bg-black/10 rounded-full overflow-hidden p-0.5">
              <div className="h-full bg-white rounded-full transition-all duration-1000" style={{ width: `${Math.min(100, level.progress)}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* 核心看板 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCardSimple icon="🔥" value={stats.streak || 0} label="连续天数" />
        <StatCardSimple icon="📚" value={sentences.length} label="词库总量" />
        <div className="relative">
          <StatCardSimple icon="🎯" value={`${memory.retention}%`} label="记忆保留率" subValue="FSRS 核心指标" />
          {memory.retention >= goalRetention ? (
            <span className="absolute -top-1 -right-1 text-[10px] bg-emerald-500 text-white px-1.5 py-0.5 rounded-full font-bold">✓</span>
          ) : (
            <span className="absolute -top-1 -right-1 text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full font-bold">↓</span>
          )}
        </div>
        <StatCardSimple icon="✅" value={memory.learned} label="已学句子" />
      </div>

      {/* 时间维度统计 */}
      <div className="bg-white/60 backdrop-blur-xl rounded-[28px] p-6 border border-white/40">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-black text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-4 bg-purple-500 rounded-full"></span>
            时间维度统计
          </h3>
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
            {[
              { key: 'weekly', label: '周' },
              { key: 'monthly', label: '月' },
              { key: 'yearly', label: '年' },
              { key: 'allTime', label: '累计' },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTimeTab(tab.key as typeof activeTimeTab)}
                className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                  activeTimeTab === tab.key 
                    ? 'bg-white text-purple-600 shadow-sm' 
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        
        {/* 完成率进度条 */}
        <div className="mb-5 p-4 bg-gradient-to-r from-purple-500 to-indigo-500 rounded-2xl text-white">
          <div className="flex justify-between items-center mb-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">📊</span>
              <span className="text-xs font-bold">完成率</span>
            </div>
            <span className="text-lg font-black">{currentTimeStats.completionRate}%</span>
          </div>
          <div className="h-2 bg-white/20 rounded-full overflow-hidden">
            <div 
              className="h-full bg-white rounded-full transition-all duration-700"
              style={{ width: `${currentTimeStats.completionRate}%` }}
            />
          </div>
          <div className="flex justify-between mt-2 text-[10px] opacity-80">
            <span>已完成 {currentTimeStats.completedDays} 天</span>
            <span>共 {currentTimeStats.totalDays} 天</span>
          </div>
        </div>
        
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl p-4 border border-blue-100">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">📝</span>
              <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">新增句子</span>
            </div>
            <div className="text-2xl font-black text-gray-900">{currentTimeStats.newSentences}</div>
          </div>
          
          <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-2xl p-4 border border-green-100">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🔄</span>
              <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">复习次数</span>
            </div>
            <div className="text-2xl font-black text-gray-900">{currentTimeStats.reviewsCompleted}</div>
          </div>
          
          <div className="bg-gradient-to-br from-purple-50 to-violet-50 rounded-2xl p-4 border border-purple-100">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">✍️</span>
              <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">默写次数</span>
            </div>
            <div className="text-2xl font-black text-gray-900">{currentTimeStats.dictationsCompleted}</div>
          </div>
          
          <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl p-4 border border-amber-100">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">💎</span>
              <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">获得积分</span>
            </div>
            <div className="text-2xl font-black text-gray-900">{currentTimeStats.pointsEarned}</div>
          </div>
          
          <div className="bg-gradient-to-br from-cyan-50 to-teal-50 rounded-2xl p-4 border border-cyan-100">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🎯</span>
              <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">记忆保持</span>
            </div>
            <div className="text-2xl font-black text-gray-900">{currentTimeStats.avgRetention}%</div>
          </div>
          
          <div className="bg-gradient-to-br from-rose-50 to-pink-50 rounded-2xl p-4 border border-rose-100">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">📅</span>
              <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">学习天数</span>
            </div>
            <div className="text-2xl font-black text-gray-900">{currentTimeStats.streakDays}</div>
          </div>
        </div>
      </div>

      {/* 趋势分析图表 */}
      <div className="bg-white/60 backdrop-blur-xl rounded-[28px] p-6 border border-white/40">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-black text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-4 bg-blue-500 rounded-full"></span>
            趋势分析
          </h3>
        </div>
        
        <div className="flex flex-wrap gap-2 mb-4">
          {METRICS.map(metric => (
            <button
              key={metric.id}
              onClick={() => setSelectedMetric(metric.id)}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                selectedMetric === metric.id 
                  ? 'text-white shadow-sm' 
                  : 'bg-gray-100 text-gray-600 hover:text-gray-800'
              }`}
              style={selectedMetric === metric.id ? { backgroundColor: metric.color } : {}}
            >
              {metric.icon} {metric.name}
            </button>
          ))}
        </div>
        
        <div className="flex flex-wrap gap-2 mb-4">
          {dateRanges.map(range => (
            <button
              key={range.label}
              onClick={() => setSelectedDateRange(range)}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                selectedDateRange.label === range.label 
                  ? 'bg-blue-500 text-white shadow-sm' 
                  : 'bg-gray-100 text-gray-500 hover:text-gray-700'
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
        
        <div className="mb-4">
          <SimpleChart data={trendData} height={180} type={chartType} />
        </div>
        
        <div className="grid grid-cols-4 gap-2 text-center">
          <div className="bg-gray-50 rounded-xl p-2">
            <div className="text-[10px] text-gray-600">平均</div>
            <div className="text-sm font-black text-gray-900">{trendData.avgValue}</div>
          </div>
          <div className="bg-gray-50 rounded-xl p-2">
            <div className="text-[10px] text-gray-600">最高</div>
            <div className="text-sm font-black text-gray-900">{trendData.maxValue}</div>
          </div>
          <div className="bg-gray-50 rounded-xl p-2">
            <div className="text-[10px] text-gray-600">最低</div>
            <div className="text-sm font-black text-gray-900">{trendData.minValue}</div>
          </div>
          <div className="bg-gray-50 rounded-xl p-2">
            <div className="text-[10px] text-gray-600">趋势</div>
            <div className={`text-sm font-black ${trendData.trend === 'up' ? 'text-green-500' : trendData.trend === 'down' ? 'text-red-500' : 'text-gray-600'}`}>
              {trendData.trend === 'up' ? '↑' : trendData.trend === 'down' ? '↓' : '→'}
            </div>
          </div>
        </div>
      </div>

      {/* 同比环比分析 & 数据导出 */}
      <div className="grid grid-cols-2 gap-4">
        <ComparisonCard
          title="本月数据"
          current={comparisonData.current}
          previous={comparisonData.previous}
          mom={comparisonData.mom}
          yoy={comparisonData.yoy}
        />
        <div className="bg-white/60 backdrop-blur-xl rounded-[28px] p-6 border border-white/40">
          <h3 className="text-sm font-black text-gray-900 mb-4 flex items-center gap-2">
            <span className="w-1.5 h-4 bg-green-500 rounded-full"></span>
            数据导出
          </h3>
          <div className="space-y-2">
            <button
              onClick={() => handleExport('csv')}
              className="w-full py-3 bg-blue-50 text-blue-600 font-bold rounded-xl hover:bg-blue-100 transition-colors text-sm"
            >
              📄 导出 CSV
            </button>
            <button
              onClick={() => handleExport('excel')}
              className="w-full py-3 bg-green-50 text-green-600 font-bold rounded-xl hover:bg-green-100 transition-colors text-sm"
            >
              📊 导出 Excel
            </button>
            <button
              onClick={() => handleExport('json')}
              className="w-full py-3 bg-purple-50 text-purple-600 font-bold rounded-xl hover:bg-purple-100 transition-colors text-sm"
            >
              📋 导出 JSON
            </button>
          </div>
        </div>
      </div>

      {/* 学习热力图 */}
      <ContributionHeatmap data={heatmapData} year={selectedYear} />
    </div>
  );

  const renderAchievementsTab = () => {
    const overallProgress = computeOverallProgress(achievements);
    const recommendations = getRecommendations({ stats, memory, sentenceCount: sentences.length });
    const totalRewards = getTotalRewards(achievements);
    const almostUnlocked = achievements.filter(a => !a.unlocked && a.progress >= 80);

    const filteredAchievements = achievements.filter(a => {
      if (selectedCategory !== 'all' && a.category !== selectedCategory) return false;
      if (selectedTier !== 'all' && a.tier !== selectedTier) return false;
      return true;
    });

    return (
      <div className="space-y-6 animate-in fade-in duration-500">
        {/* 综合进度仪表板 */}
        <div className="bg-gradient-to-br from-amber-500 to-orange-600 rounded-[32px] p-8 text-white shadow-2xl shadow-amber-200">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h2 className="text-3xl font-black tracking-tighter mb-2">成就系统</h2>
              <p className="text-sm font-bold opacity-90">记录你的每一个里程碑</p>
            </div>
            <div className="text-right">
              <div className="text-4xl font-black">{overallProgress.unlocked}</div>
              <div className="text-xs opacity-80">/ {overallProgress.total} 已解锁</div>
            </div>
          </div>
          <div className="mt-4 h-2 bg-white/20 rounded-full overflow-hidden">
            <div 
              className="h-full bg-white rounded-full transition-all duration-700"
              style={{ width: `${overallProgress.percentage}%` }}
            />
          </div>

          {/* 奖励统计 */}
          <div className="grid grid-cols-3 gap-3 mt-6">
            <div className="bg-white/10 backdrop-blur-md rounded-xl p-3 text-center">
              <div className="text-xl font-black">{totalRewards.points}</div>
              <div className="text-[10px] opacity-80">积分奖励</div>
            </div>
            <div className="bg-white/10 backdrop-blur-md rounded-xl p-3 text-center">
              <div className="text-xl font-black">{totalRewards.badges.length}</div>
              <div className="text-[10px] opacity-80">徽章收集</div>
            </div>
            <div className="bg-white/10 backdrop-blur-md rounded-xl p-3 text-center">
              <div className="text-xl font-black">{totalRewards.titles.length}</div>
              <div className="text-[10px] opacity-80">专属称号</div>
            </div>
          </div>
        </div>

        {/* 个性化推荐 */}
        {recommendations.length > 0 && (
          <div className="bg-gradient-to-br from-blue-500 to-indigo-600 rounded-[28px] p-6 text-white shadow-xl shadow-blue-200">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">💡</span>
              <h3 className="text-sm font-black">为你推荐</h3>
              <span className="text-xs opacity-80 ml-auto">基于你的学习进度</span>
            </div>
            <div className="space-y-3">
              {recommendations.slice(0, 3).map((rec) => (
                <div key={rec.achievement.id} className="bg-white/10 backdrop-blur-md rounded-xl p-4 border border-white/20">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center text-lg">
                      {rec.achievement.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-white truncate">{rec.achievement.title}</h4>
                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                          rec.priority === 'high' ? 'bg-red-400/50 text-red-100' :
                          rec.priority === 'medium' ? 'bg-amber-400/50 text-amber-100' :
                          'bg-gray-400/50 text-gray-100'
                        }`}>
                          {rec.priority === 'high' ? '优先' : rec.priority === 'medium' ? '推荐' : '可选'}
                        </span>
                      </div>
                      <p className="text-[10px] text-white/70 mt-0.5">{rec.reason}</p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex-1 h-1 bg-white/20 rounded-full overflow-hidden">
                          <div className="h-full bg-white rounded-full transition-all" style={{ width: `${rec.achievement.progress}%` }} />
                        </div>
                        <span className="text-[10px] font-bold">{rec.achievement.current}/{rec.achievement.target}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 即将达成 - 置顶 */}
        {almostUnlocked.length > 0 && (
          <div className="bg-gradient-to-br from-purple-500 to-indigo-600 rounded-[28px] p-6 text-white shadow-xl shadow-purple-200">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">🚀</span>
              <h3 className="text-sm font-black">即将达成</h3>
              <span className="text-xs opacity-80 ml-auto">{almostUnlocked.length} 个成就即将解锁</span>
            </div>
            <div className="space-y-3">
              {almostUnlocked.slice(0, 3).map((ach) => (
                <div key={ach.id} className="bg-white/10 backdrop-blur-md rounded-xl p-4 border border-white/20">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center text-lg">
                      {ach.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-bold text-white truncate">{ach.title}</h4>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1.5 bg-white/20 rounded-full overflow-hidden">
                          <div className="h-full bg-white rounded-full transition-all" style={{ width: `${ach.progress}%` }} />
                        </div>
                        <span className="text-xs font-bold">{ach.current}/{ach.target}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 筛选器 */}
        <div className="flex flex-wrap gap-2">
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
            <button
              onClick={() => setSelectedCategory('all')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                selectedCategory === 'all' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
              }`}
            >
              全部
            </button>
            {(Object.keys(ACHIEVEMENT_CATEGORIES) as AchievementCategory[]).map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                  selectedCategory === cat ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
                }`}
              >
                {ACHIEVEMENT_CATEGORIES[cat].icon}
              </button>
            ))}
          </div>
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
            <button
              onClick={() => setSelectedTier('all')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                selectedTier === 'all' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
              }`}
            >
              全部
            </button>
            {(Object.keys(TIER_CONFIG) as AchievementTier[]).map(tier => (
              <button
                key={tier}
                onClick={() => setSelectedTier(tier)}
                className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                  selectedTier === tier ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
                }`}
              >
                {TIER_CONFIG[tier].title}
              </button>
            ))}
          </div>
        </div>

        {/* 成就列表 */}
        <div className="space-y-2">
          {filteredAchievements.map((ach) => (
            <div 
              key={ach.id} 
              className={`flex items-center gap-4 p-4 rounded-[20px] transition-all border ${
                ach.unlocked 
                  ? 'bg-white border-amber-100 shadow-sm cursor-pointer hover:shadow-md' 
                  : 'bg-gray-50/50 border-transparent opacity-60'
              }`}
              onClick={() => ach.unlocked && setSharingAchievement(ach)}
            >
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl relative ${
                ach.unlocked ? 'bg-amber-50' : 'bg-gray-100 grayscale'
              }`}>
                {ach.icon}
                {ach.unlocked && (
                  <div className="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
                    <span className="text-[10px] text-white">✓</span>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-black text-gray-900 leading-tight">{ach.title}</h4>
                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                    ach.tier === 'expert' ? 'bg-amber-100 text-amber-700' :
                    ach.tier === 'advanced' ? 'bg-purple-100 text-purple-700' :
                    ach.tier === 'intermediate' ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>
                    {TIER_CONFIG[ach.tier].title}
                  </span>
                </div>
                <p className="text-[10px] text-gray-600 font-medium mb-1.5">{ach.desc}</p>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div 
                    className={`h-full transition-all duration-700 ${
                      ach.unlocked ? 'bg-gradient-to-r from-amber-400 to-orange-500' : 'bg-gray-300'
                    }`} 
                    style={{ width: `${ach.progress}%` }} 
                  />
                </div>
              </div>
              <div className="text-right">
                {ach.unlocked ? (
                  <div className="space-y-1">
                    <div className="text-amber-500 text-xs font-black">已解锁</div>
                    <div className="text-[9px] text-gray-600">点击分享</div>
                  </div>
                ) : (
                  <div className="text-gray-600 text-[10px] font-bold">{ach.current}/{ach.target}</div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 分享卡片弹窗 */}
        {sharingAchievement && (
          <AchievementShareCard
            achievement={sharingAchievement}
            level={level}
            streak={stats.streak || 0}
            onClose={() => setSharingAchievement(null)}
          />
        )}
      </div>
    );
  };

  const renderFSRSTab = () => (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* FSRS 介绍卡片 */}
      <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-[32px] p-8 text-white shadow-2xl shadow-indigo-200">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-3xl font-black tracking-tighter mb-2">FSRS 6.0</h2>
            <p className="text-sm font-bold opacity-90">Free Spaced Repetition Scheduler</p>
          </div>
          <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center backdrop-blur-md border border-white/30 text-2xl">
            🧠
          </div>
        </div>
        <p className="text-xs opacity-80 leading-relaxed">
          FSRS 是基于记忆曲线的科学复习算法，通过稳定性、难度、可回忆性三个核心参数，
          智能预测最佳复习时间，最大化学习效率。
        </p>
      </div>

      {/* 复习预测 - 前置 */}
      <div className="bg-white/60 backdrop-blur-xl rounded-[28px] p-6 border border-white/40">
        <h3 className="text-sm font-black text-gray-900 mb-5 flex items-center gap-2">
          <span className="w-1.5 h-4 bg-blue-500 rounded-full"></span>
          未来 7 天复习预测
        </h3>
        <div className="flex justify-between items-end h-24 gap-2">
          {forecast.days.map((day) => {
            const height = forecast.maxCount > 0 ? (day.count / forecast.maxCount) * 100 : 0;
            return (
              <div key={day.date} className="flex-1 flex flex-col items-center gap-2 group">
                <div className="w-full flex items-end justify-center flex-1">
                  <div 
                    className={`w-full max-w-[12px] rounded-full transition-all duration-500 ${day.isToday ? 'bg-blue-500' : 'bg-gray-200 group-hover:bg-blue-200'}`}
                    style={{ height: `${Math.max(height, 8)}%` }}
                  />
                </div>
                <span className={`text-[9px] font-bold ${day.isToday ? 'text-blue-500' : 'text-gray-600'}`}>
                  {day.label}
                </span>
              </div>
            );
          })}
        </div>
        {forecast.overdueCount > 0 && (
          <div className="mt-4 p-3 bg-orange-50 rounded-xl text-center">
            <span className="text-orange-600 text-xs font-bold">⚠️ 有 {forecast.overdueCount} 个句子待复习</span>
          </div>
        )}
      </div>

      {/* 遗忘曲线投影 - 前置 */}
      <div className="bg-white/60 backdrop-blur-xl rounded-[28px] p-6 border border-white/40">
        <h3 className="text-sm font-black text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-1.5 h-4 bg-red-500 rounded-full"></span>
          遗忘曲线投影
        </h3>
        <p className="text-xs text-gray-600 mb-4">如果不复习，你的记忆将如何衰减</p>

        <div className="relative h-32 mb-4">
          <svg viewBox="0 0 300 100" className="w-full h-full">
            <defs>
              <linearGradient id="forgetGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#EF4444" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#EF4444" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* 90% 目标保留率参考线 */}
            <line
              x1="0"
              y1={100 - goalRetention}
              x2="300"
              y2={100 - goalRetention}
              stroke="#10B981"
              strokeWidth="1.5"
              strokeDasharray="6 3"
            />
            <text x="302" y={100 - goalRetention + 3} fill="#10B981" fontSize="7" fontWeight="bold">
              90%
            </text>

            {/* 网格线 */}
            <line x1="0" y1="90" x2="300" y2="90" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2" />
            <line x1="0" y1="70" x2="300" y2="70" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2" />
            <line x1="0" y1="50" x2="300" y2="50" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2" />
            <line x1="0" y1="30" x2="300" y2="30" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2" />

            {/* 遗忘曲线填充 */}
            <path
              d={`M 0 ${100 - forgettingCurveData.curve[0].retention} ${forgettingCurveData.curve.map((p) => `L ${(p.day / 30) * 300} ${100 - p.retention}`).join(' ')} L 300 100 L 0 100 Z`}
              fill="url(#forgetGradient)"
            />

            {/* 遗忘曲线 */}
            <path
              d={`M 0 ${100 - forgettingCurveData.curve[0].retention} ${forgettingCurveData.curve.map((p) => `L ${(p.day / 30) * 300} ${100 - p.retention}`).join(' ')}`}
              fill="none"
              stroke="#EF4444"
              strokeWidth="2"
            />

            {/* 可hover的热区 */}
            {forgettingCurveData.curve.map((p) => (
              <rect
                key={p.day}
                x={(p.day / 30) * 300 - 10}
                y="0"
                width="20"
                height="100"
                fill="transparent"
                className="cursor-crosshair"
                onMouseEnter={() => setHoveredDay({ day: p.day, retention: p.retention })}
                onMouseLeave={() => setHoveredDay(null)}
              />
            ))}

            {/* 预测点 */}
            <circle cx="10" cy={100 - forgettingCurveData.predictions.tomorrow} r="4" fill="#F59E0B" />
            <circle cx="70" cy={100 - forgettingCurveData.predictions.week} r="4" fill="#F59E0B" />
            <circle cx="300" cy={100 - forgettingCurveData.predictions.month} r="4" fill="#F59E0B" />
          </svg>

          {/* Hover tooltip */}
          {hoveredDay && (
            <div
              className="absolute bg-gray-900 text-white text-[10px] font-bold px-2 py-1 rounded-lg shadow-lg pointer-events-none z-10"
              style={{
                left: `${Math.min((hoveredDay.day / 30) * 100, 85)}%`,
                top: `${100 - hoveredDay.retention - 10}%`,
              }}
            >
              第 {hoveredDay.day} 天: {hoveredDay.retention}%
            </div>
          )}

          <div className="absolute top-0 left-0 text-[8px] text-gray-600">100%</div>
          <div className="absolute bottom-0 left-0 text-[8px] text-gray-600">0%</div>
          <div className="absolute bottom-0 left-0 text-[8px] text-gray-600">今天</div>
          <div className="absolute bottom-0 right-0 text-[8px] text-gray-600">30天</div>
        </div>
        
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-amber-50 rounded-xl p-3 text-center border border-amber-100">
            <div className="text-lg font-black text-amber-600">{forgettingCurveData.predictions.tomorrow}%</div>
            <div className="text-[9px] text-gray-600">明天保留</div>
          </div>
          <div className="bg-orange-50 rounded-xl p-3 text-center border border-orange-100">
            <div className="text-lg font-black text-orange-600">{forgettingCurveData.predictions.week}%</div>
            <div className="text-[9px] text-gray-600">一周后保留</div>
          </div>
          <div className="bg-red-50 rounded-xl p-3 text-center border border-red-100">
            <div className="text-lg font-black text-red-600">{forgettingCurveData.predictions.month}%</div>
            <div className="text-[9px] text-gray-600">一月后保留</div>
          </div>
        </div>
        
        {forgettingCurveData.willForgetTomorrow > 0 && (
          <div className="p-3 bg-gradient-to-r from-red-50 to-orange-50 rounded-xl border border-red-100">
            <div className="flex items-center gap-2">
              <span className="text-lg">⚠️</span>
              <div>
                <div className="text-xs font-bold text-red-600">遗忘预警</div>
                <div className="text-[10px] text-gray-600">
                  如果今天不复习，明天可能会遗忘约 <span className="font-black text-red-600">{forgettingCurveData.willForgetTomorrow}</span> 个句子
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 最顽固句子 - 前置 */}
      {hardestSentences.length > 0 && (
        <div className="bg-white/60 backdrop-blur-xl rounded-[28px] p-6 border border-white/40">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-black text-gray-900 flex items-center gap-2">
              <span className="w-1.5 h-4 bg-orange-500 rounded-full"></span>
              最顽固句子
            </h3>
            <span className="text-[10px] font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded-full">
              高难度 · 低稳定性
            </span>
          </div>
          <p className="text-xs text-gray-600 mb-4">这些句子需要重点关注，建议进行专项特训</p>
          
          <div className="space-y-3">
            {hardestSentences.map((s, index) => (
              <div key={s.id} className="bg-gradient-to-r from-orange-50 to-amber-50 rounded-2xl p-4 border border-orange-100">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-5 h-5 rounded-full bg-orange-500 text-white text-[10px] font-black flex items-center justify-center">
                        {index + 1}
                      </span>
                      <span className="text-sm font-bold text-gray-900 truncate">{s.english}</span>
                    </div>
                    <p className="text-xs text-gray-600 truncate ml-7">{s.chinese}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <div className="flex items-center gap-1">
                      <span className="text-[9px] text-gray-600">难度</span>
                      <span className="text-xs font-black text-orange-600">{s.difficulty.toFixed(1)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-[9px] text-gray-600">稳定</span>
                      <span className="text-xs font-black text-amber-600">{s.stability.toFixed(1)}天</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-[9px] text-gray-600">遗忘</span>
                      <span className="text-xs font-black text-red-600">{s.lapses}次</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          
          <button
            onClick={() => {
              const ids = hardestSentences.map(s => s.id);
              if (ids.length === 0) return;
              sessionStorage.setItem('trainingSession', JSON.stringify(ids));
              setView('study');
            }}
            className="w-full mt-4 py-3 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-bold rounded-xl hover:from-orange-600 hover:to-amber-600 transition-all text-sm shadow-lg shadow-orange-200"
          >
            🎯 开始专项特训
          </button>
        </div>
      )}

      {/* FSRS 核心指标 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl p-4 border border-indigo-100">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">📊</span>
            <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">平均稳定性</span>
          </div>
          <div className="text-2xl font-black text-gray-900">{memory.avgStability}</div>
          <div className="text-[9px] text-gray-600 mt-1">天</div>
        </div>
        
        <div className="bg-gradient-to-br from-purple-50 to-pink-50 rounded-2xl p-4 border border-purple-100">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">⚡</span>
            <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">平均难度</span>
          </div>
          <div className="text-2xl font-black text-gray-900">{memory.avgDifficulty}</div>
          <div className="text-[9px] text-gray-600 mt-1">0-10</div>
        </div>
        
        <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-2xl p-4 border border-green-100">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">🎯</span>
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">记忆保留率</span>
          </div>
          <div className="text-2xl font-black text-gray-900">{memory.retention}%</div>
          <div className="text-[9px] text-gray-600 mt-1">Retrievability</div>
        </div>
        
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl p-4 border border-amber-100">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">🏆</span>
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">永久记忆</span>
          </div>
          <div className="text-2xl font-black text-gray-900">{memory.permanent}</div>
          <div className="text-[9px] text-gray-600 mt-1">90天+</div>
        </div>
      </div>

      {/* 记忆状态统计 */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white/60 backdrop-blur-xl rounded-[24px] p-5 text-center border border-white/40">
          <div className="text-3xl font-black text-blue-600">{memory.total}</div>
          <div className="text-[10px] font-bold text-gray-600 mt-1">总句子数</div>
        </div>
        <div className="bg-white/60 backdrop-blur-xl rounded-[24px] p-5 text-center border border-white/40">
          <div className="text-3xl font-black text-amber-600">{memory.learning}</div>
          <div className="text-[10px] font-bold text-gray-600 mt-1">学习中</div>
        </div>
        <div className="bg-white/60 backdrop-blur-xl rounded-[24px] p-5 text-center border border-white/40">
          <div className="text-3xl font-black text-green-600">{memory.learned}</div>
          <div className="text-[10px] font-bold text-gray-600 mt-1">已掌握</div>
        </div>
      </div>

      {/* 记忆稳定性分布 */}
      {memory.learned > 0 && (
        <div className="bg-white/60 backdrop-blur-xl rounded-[28px] p-6 border border-white/40">
          <h3 className="text-sm font-black text-gray-900 mb-5 flex items-center gap-2">
            <span className="w-1.5 h-4 bg-indigo-500 rounded-full"></span>
            记忆稳定性分布
          </h3>
          <div className="space-y-4">
            <div className="flex h-3 rounded-full overflow-hidden shadow-inner bg-gray-100">
              {memory.distribution.map((item) => (
                <div key={item.key} className={`${item.bgColor} transition-all duration-500`} style={{ width: `${item.ratio}%` }} />
              ))}
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
              {memory.distribution.map((item) => (
                <div key={item.key} className="flex items-center justify-between p-3 rounded-2xl bg-white/40 border border-white/60">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${item.bgColor}`} />
                    <span className="text-[10px] font-bold text-gray-600">{item.name}</span>
                  </div>
                  <span className="text-xs font-black text-gray-800">{item.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 记忆保留率表格 - 折叠 */}
      <details className="bg-white/60 backdrop-blur-xl rounded-[28px] border border-white/40 overflow-hidden">
        <summary className="p-6 cursor-pointer list-none">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-gray-900 flex items-center gap-2">
              <span className="w-1.5 h-4 bg-blue-500 rounded-full"></span>
              记忆保留率详细数据
            </h3>
            <span className="text-xs text-gray-600">点击展开</span>
          </div>
        </summary>
        <div className="px-6 pb-6">
          <p className="text-xs text-gray-600 mb-4">间隔大于 1 天的卡片的通过率</p>
          
          <div className="flex gap-6 mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="radio" 
                name="retentionFilter" 
                value="unmature" 
                checked={retentionFilter === 'unmature'}
                onChange={() => setRetentionFilter('unmature')}
                className="w-4 h-4 text-blue-500"
              />
              <span className="text-xs text-gray-600">欠熟练</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="radio" 
                name="retentionFilter" 
                value="mature" 
                checked={retentionFilter === 'mature'}
                onChange={() => setRetentionFilter('mature')}
                className="w-4 h-4 text-blue-500"
              />
              <span className="text-xs text-gray-600">已熟练</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="radio" 
                name="retentionFilter" 
                value="all" 
                checked={retentionFilter === 'all'}
                onChange={() => setRetentionFilter('all')}
                className="w-4 h-4 text-blue-500"
              />
              <span className="text-xs text-gray-600">所有</span>
            </label>
          </div>
          
          <div className="w-full overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-xs font-bold text-gray-600"></th>
                  <th className="text-center py-3 px-4 text-xs font-bold text-green-600">欠熟练</th>
                  <th className="text-center py-3 px-4 text-xs font-bold text-blue-600">已熟练</th>
                  <th className="text-center py-3 px-4 text-xs font-bold text-purple-600">总计</th>
                  <th className="text-center py-3 px-4 text-xs font-bold text-gray-600">总数</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: '今天', key: 'today' as const },
                  { label: '昨天', key: 'yesterday' as const },
                  { label: '上周', key: 'lastWeek' as const },
                  { label: '上个月', key: 'lastMonth' as const },
                  { label: '近一年', key: 'lastYear' as const }
                ].map((item) => {
                  const data = retentionStats[item.key];
                  return (
                    <tr key={item.key} className="border-b border-gray-100">
                      <td className="py-3 px-4 text-xs font-medium text-gray-700">{item.label}</td>
                      <td className="text-center py-3 px-4 text-xs text-gray-600">
                        {data.unmature.count > 0 ? `${data.unmature.rate}%` : '-'}
                      </td>
                      <td className="text-center py-3 px-4 text-xs text-gray-500">
                        {data.mature.count > 0 ? `${data.mature.rate}%` : '-'}
                      </td>
                      <td className="text-center py-3 px-4 text-xs text-gray-500">
                        {data.total.count > 0 ? `${data.total.rate}%` : '-'}
                      </td>
                      <td className="text-center py-3 px-4 text-xs text-gray-500">{data.allCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      {/* FSRS 算法说明 */}
      <div className="bg-gradient-to-br from-slate-50 to-gray-50 rounded-[24px] p-5 border border-slate-100">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-xl bg-indigo-100 flex items-center justify-center text-sm flex-shrink-0">
            ℹ️
          </div>
          <div>
            <h4 className="text-xs font-black text-gray-700 mb-1">关于 FSRS 算法</h4>
            <p className="text-[10px] text-gray-600 leading-relaxed">
              FSRS (Free Spaced Repetition Scheduler) 是基于记忆曲线的科学复习算法。
              稳定性表示记忆保持时间，难度反映学习难度，保留率衡量记忆效果。
              系统会根据你的复习表现动态调整每句话的复习时间。
            </p>
          </div>
        </div>
      </div>

      <div className="text-center py-4 opacity-20">
        <p className="text-[10px] font-black uppercase tracking-[0.5em]">FSRS 6.0 Memory Core</p>
      </div>
    </div>
  );

  return (
    <div className="px-2 pb-24 max-w-2xl mx-auto animate-in fade-in duration-700">
      {/* 顶部标签页导航 */}
      <div className="sticky top-0 z-20 bg-gray-50/95 backdrop-blur-xl -mx-2 px-2 py-3 mb-6">
        <div className="flex gap-2 bg-white/80 backdrop-blur-xl rounded-2xl p-1.5 shadow-sm border border-white/40">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 text-sm font-bold rounded-xl transition-all ${
                activeTab === tab.key 
                  ? 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-md' 
                  : 'text-gray-600 hover:text-gray-800 hover:bg-gray-100'
              }`}
            >
              <span className="text-lg">{tab.icon}</span>
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 内容区域 */}
      {activeTab === 'stats' && renderStatsTab()}
      {activeTab === 'achievements' && renderAchievementsTab()}
      {activeTab === 'fsrs' && renderFSRSTab()}
    </div>
  );
};

export default AchievementPage;
