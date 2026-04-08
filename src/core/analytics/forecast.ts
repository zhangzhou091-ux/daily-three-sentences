import { Sentence } from '../../types';

const formatDate = (date: Date) => date.toISOString().split('T')[0];

export interface ForecastDay {
  date: string;
  label: string;
  count: number;
  isToday: boolean;
}

export interface ForecastAnalysis {
  days: ForecastDay[];
  maxCount: number;
  totalUpcoming: number;
  todayCount: number;
  overdueCount: number;
}

export const computeForecast = (sentences: Sentence[], days: number = 7): ForecastAnalysis => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const dateCounts: Record<string, number> = {};
  let overdueCount = 0;
  const now = Date.now();
  
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dateCounts[formatDate(d)] = 0;
  }
  
  sentences.forEach(s => {
    if (s.nextReviewDate) {
      const reviewDate = new Date(s.nextReviewDate);
      reviewDate.setHours(0, 0, 0, 0);
      const dateStr = formatDate(reviewDate);
      
      if (s.nextReviewDate <= now && s.intervalIndex > 0) {
        overdueCount++;
      }
      
      if (dateCounts[dateStr] !== undefined) {
        dateCounts[dateStr]++;
      }
    }
  });
  
  const daysArray = Object.entries(dateCounts).map(([date, count]) => ({
    date,
    label: new Date(date).toLocaleDateString('zh-CN', { weekday: 'short' }),
    count,
    isToday: date === formatDate(today),
  }));
  
  const maxCount = Math.max(...daysArray.map(d => d.count), 1);
  const todayCount = daysArray.find(d => d.isToday)?.count || 0;
  const totalUpcoming = daysArray.reduce((sum, d) => sum + d.count, 0);
  
  return {
    days: daysArray,
    maxCount,
    totalUpcoming,
    todayCount,
    overdueCount,
  };
};
