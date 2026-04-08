import { Sentence, UserStats } from '../../types';

export interface DataPoint {
  date: string;
  value: number;
  label?: string;
}

export interface TrendData {
  label: string;
  data: DataPoint[];
  trend: 'up' | 'down' | 'stable';
  changePercent: number;
  avgValue: number;
  maxValue: number;
  minValue: number;
}

export interface MetricConfig {
  id: string;
  name: string;
  icon: string;
  unit: string;
  color: string;
  calculate: (sentences: Sentence[], stats: UserStats, startDate: Date, endDate: Date) => number;
}

export interface DateRange {
  start: Date;
  end: Date;
  label: string;
}

const formatDate = (date: Date): string => date.toISOString().split('T')[0];

export const METRICS: MetricConfig[] = [
  {
    id: 'newSentences',
    name: '新增句子',
    icon: '📝',
    unit: '个',
    color: '#3B82F6',
    calculate: (sentences, _stats, start, end) => {
      return sentences.filter(s => {
        const addedAt = s.addedAt;
        return addedAt >= start.getTime() && addedAt <= end.getTime();
      }).length;
    },
  },
  {
    id: 'reviewsCompleted',
    name: '复习完成',
    icon: '🔄',
    unit: '次',
    color: '#10B981',
    calculate: (sentences, _stats, start, end) => {
      return sentences.filter(s => {
        const reviewedAt = s.lastReviewedAt;
        return reviewedAt && reviewedAt > 0 && reviewedAt >= start.getTime() && reviewedAt <= end.getTime();
      }).length;
    },
  },
  {
    id: 'dictationsCompleted',
    name: '默写完成',
    icon: '✍️',
    unit: '次',
    color: '#8B5CF6',
    calculate: (_sentences, stats, start, end) => {
      const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      return Math.floor((stats.dictationCount || 0) * (daysDiff / 30));
    },
  },
  {
    id: 'pointsEarned',
    name: '获得积分',
    icon: '💎',
    unit: '分',
    color: '#F59E0B',
    calculate: (_sentences, stats, start, end) => {
      const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      return Math.floor((stats.totalPoints || 0) * (daysDiff / 30));
    },
  },
  {
    id: 'retention',
    name: '记忆保留率',
    icon: '🎯',
    unit: '%',
    color: '#06B6D4',
    calculate: (sentences, _stats, start, end) => {
      const reviewedInPeriod = sentences.filter(s => {
        const reviewedAt = s.lastReviewedAt;
        return reviewedAt && reviewedAt > 0 && reviewedAt >= start.getTime() && reviewedAt <= end.getTime();
      });
      
      if (reviewedInPeriod.length === 0) return 100;
      
      const now = Date.now();
      let totalRecall = 0;
      let count = 0;
      
      reviewedInPeriod.forEach(s => {
        const stability = s.stability || 0;
        if (stability > 0 && s.lastReviewedAt) {
          const elapsedDays = (now - s.lastReviewedAt) / (1000 * 60 * 60 * 24);
          const recall = Math.pow(0.9, elapsedDays / stability);
          totalRecall += recall;
          count++;
        }
      });
      
      return count > 0 ? Math.round((totalRecall / count) * 100) : 100;
    },
  },
  {
    id: 'stability',
    name: '平均稳定性',
    icon: '📊',
    unit: '天',
    color: '#EC4899',
    calculate: (sentences) => {
      const learned = sentences.filter(s => s.intervalIndex > 0);
      if (learned.length === 0) return 0;
      const totalStability = learned.reduce((sum, s) => sum + (s.stability || 0), 0);
      return Math.round((totalStability / learned.length) * 10) / 10;
    },
  },
];

export const getDateRanges = (): DateRange[] => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const last7Days = new Date(today);
  last7Days.setDate(last7Days.getDate() - 6);
  
  const last30Days = new Date(today);
  last30Days.setDate(last30Days.getDate() - 29);
  
  const thisWeekStart = new Date(today);
  const dayOfWeek = thisWeekStart.getDay();
  thisWeekStart.setDate(thisWeekStart.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  
  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  
  const thisYearStart = new Date(today.getFullYear(), 0, 1);
  
  return [
    { start: last7Days, end: today, label: '近7天' },
    { start: last30Days, end: today, label: '近30天' },
    { start: thisWeekStart, end: today, label: '本周' },
    { start: thisMonthStart, end: today, label: '本月' },
    { start: thisYearStart, end: today, label: '本年' },
  ];
};

export const computeTrendData = (
  sentences: Sentence[],
  stats: UserStats,
  metricId: string,
  dateRange: DateRange,
  granularity: 'day' | 'week' | 'month' = 'day'
): TrendData => {
  const metric = METRICS.find(m => m.id === metricId);
  if (!metric) {
    return {
      label: 'Unknown',
      data: [],
      trend: 'stable',
      changePercent: 0,
      avgValue: 0,
      maxValue: 0,
      minValue: 0,
    };
  }

  const data: DataPoint[] = [];
  const current = new Date(dateRange.start);
  const end = new Date(dateRange.end);
  
  while (current <= end) {
    let periodEnd: Date;
    
    if (granularity === 'day') {
      periodEnd = new Date(current);
      periodEnd.setHours(23, 59, 59, 999);
    } else if (granularity === 'week') {
      periodEnd = new Date(current);
      periodEnd.setDate(periodEnd.getDate() + 6);
      periodEnd.setHours(23, 59, 59, 999);
    } else {
      periodEnd = new Date(current.getFullYear(), current.getMonth() + 1, 0, 23, 59, 59, 999);
    }
    
    if (periodEnd > end) periodEnd = end;
    
    const value = metric.calculate(sentences, stats, current, periodEnd);
    
    data.push({
      date: formatDate(current),
      value,
      label: granularity === 'day' 
        ? `${current.getMonth() + 1}/${current.getDate()}`
        : granularity === 'week'
          ? `W${Math.ceil(current.getDate() / 7)}`
          : `${current.getMonth() + 1}月`,
    });
    
    if (granularity === 'day') {
      current.setDate(current.getDate() + 1);
    } else if (granularity === 'week') {
      current.setDate(current.getDate() + 7);
    } else {
      current.setMonth(current.getMonth() + 1);
    }
  }

  const values = data.map(d => d.value);
  const avgValue = values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : 0;
  const maxValue = values.length > 0 ? Math.max(...values) : 0;
  const minValue = values.length > 0 ? Math.min(...values) : 0;
  
  let trend: 'up' | 'down' | 'stable' = 'stable';
  let changePercent = 0;
  
  if (data.length >= 2) {
    const firstHalf = data.slice(0, Math.floor(data.length / 2));
    const secondHalf = data.slice(Math.floor(data.length / 2));
    
    const firstAvg = firstHalf.reduce((sum, d) => sum + d.value, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, d) => sum + d.value, 0) / secondHalf.length;
    
    if (firstAvg > 0) {
      changePercent = Math.round(((secondAvg - firstAvg) / firstAvg) * 100);
      trend = changePercent > 5 ? 'up' : changePercent < -5 ? 'down' : 'stable';
    }
  }

  return {
    label: metric.name,
    data,
    trend,
    changePercent,
    avgValue,
    maxValue,
    minValue,
  };
};

export const computeComparison = (
  sentences: Sentence[],
  stats: UserStats,
  metricId: string
): { current: number; previous: number; yoy: number; mom: number } => {
  const metric = METRICS.find(m => m.id === metricId);
  if (!metric) return { current: 0, previous: 0, yoy: 0, mom: 0 };

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const thisMonthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
  
  const lastYearStart = new Date(today.getFullYear() - 1, today.getMonth(), 1);
  const lastYearEnd = new Date(today.getFullYear() - 1, today.getMonth() + 1, 0);
  
  const current = metric.calculate(sentences, stats, thisMonthStart, thisMonthEnd);
  const previous = metric.calculate(sentences, stats, lastMonthStart, lastMonthEnd);
  const lastYear = metric.calculate(sentences, stats, lastYearStart, lastYearEnd);
  
  const mom = previous > 0 ? Math.round(((current - previous) / previous) * 100) : 0;
  const yoy = lastYear > 0 ? Math.round(((current - lastYear) / lastYear) * 100) : 0;

  return { current, previous, yoy, mom };
};
