import { Sentence, UserStats, UserSettings } from '../../types';

export interface TimePeriodStats {
  label: string;
  newSentences: number;
  reviewsCompleted: number;
  dictationsCompleted: number;
  pointsEarned: number;
  avgRetention: number;
  streakDays: number;
  completionRate: number;
  totalDays: number;
  completedDays: number;
}

const getWeekStart = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
};

const getMonthStart = (date: Date): Date => {
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

const getYearStart = (date: Date): Date => {
  return new Date(date.getFullYear(), 0, 1);
};

const isWithinPeriod = (timestamp: number, startDate: Date): boolean => {
  return timestamp >= startDate.getTime();
};

const getDaysPassedInWeek = (): number => {
  const now = new Date();
  const day = now.getDay();
  return day === 0 ? 7 : day;
};

const getDaysPassedInMonth = (): number => {
  return new Date().getDate();
};

const getDaysPassedInYear = (): number => {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};

export const computeWeeklyStats = (sentences: Sentence[], stats: UserStats): TimePeriodStats => {
  const now = new Date();
  const weekStart = getWeekStart(now);
  weekStart.setHours(0, 0, 0, 0);
  
  let newSentences = 0;
  let reviewsCompleted = 0;
  let dictationsCompleted = 0;
  let totalReps = 0;
  let totalLapses = 0;
  
  sentences.forEach(s => {
    if (s.addedAt && isWithinPeriod(s.addedAt, weekStart)) {
      newSentences++;
    }
    if (s.learnedAt && isWithinPeriod(s.learnedAt, weekStart)) {
      reviewsCompleted++;
    }
    if (s.lastReviewedAt && s.lastReviewedAt > 0 && isWithinPeriod(s.lastReviewedAt, weekStart)) {
      reviewsCompleted++;
    }
    totalReps += s.reps || 0;
    totalLapses += s.lapses || 0;
  });
  
  dictationsCompleted = stats.weekDictationCount || 0;
  
  const avgRetention = totalReps > 0 
    ? Math.round(((totalReps - totalLapses) / totalReps) * 100) 
    : 100;
  
  const totalDays = getDaysPassedInWeek();
  const completedDays = Math.min(stats.streak || 0, totalDays);
  const completionRate = totalDays > 0 ? Math.round((completedDays / totalDays) * 100) : 0;
  
  return {
    label: '本周',
    newSentences,
    reviewsCompleted,
    dictationsCompleted,
    pointsEarned: 0,
    avgRetention,
    streakDays: stats.streak || 0,
    completionRate,
    totalDays,
    completedDays,
  };
};

export const computeMonthlyStats = (sentences: Sentence[], stats: UserStats): TimePeriodStats => {
  const now = new Date();
  const monthStart = getMonthStart(now);
  monthStart.setHours(0, 0, 0, 0);
  
  let newSentences = 0;
  let reviewsCompleted = 0;
  let totalReps = 0;
  let totalLapses = 0;
  
  sentences.forEach(s => {
    if (s.addedAt && isWithinPeriod(s.addedAt, monthStart)) {
      newSentences++;
    }
    if (s.learnedAt && isWithinPeriod(s.learnedAt, monthStart)) {
      reviewsCompleted++;
    }
    if (s.lastReviewedAt && s.lastReviewedAt > 0 && isWithinPeriod(s.lastReviewedAt, monthStart)) {
      reviewsCompleted++;
    }
    totalReps += s.reps || 0;
    totalLapses += s.lapses || 0;
  });
  
  const dictationsCompleted = stats.dictationCount || 0;
  
  const avgRetention = totalReps > 0 
    ? Math.round(((totalReps - totalLapses) / totalReps) * 100) 
    : 100;
  
  const totalDays = getDaysPassedInMonth();
  const completedDays = Math.min(stats.streak || 0, totalDays);
  const completionRate = totalDays > 0 ? Math.round((completedDays / totalDays) * 100) : 0;
  
  return {
    label: '本月',
    newSentences,
    reviewsCompleted,
    dictationsCompleted,
    pointsEarned: 0,
    avgRetention,
    streakDays: stats.streak || 0,
    completionRate,
    totalDays,
    completedDays,
  };
};

export const computeYearlyStats = (sentences: Sentence[], stats: UserStats): TimePeriodStats => {
  const now = new Date();
  const yearStart = getYearStart(now);
  yearStart.setHours(0, 0, 0, 0);
  
  let newSentences = 0;
  let reviewsCompleted = 0;
  let totalReps = 0;
  let totalLapses = 0;
  
  sentences.forEach(s => {
    if (s.addedAt && isWithinPeriod(s.addedAt, yearStart)) {
      newSentences++;
    }
    if (s.learnedAt && isWithinPeriod(s.learnedAt, yearStart)) {
      reviewsCompleted++;
    }
    if (s.lastReviewedAt && s.lastReviewedAt > 0 && isWithinPeriod(s.lastReviewedAt, yearStart)) {
      reviewsCompleted++;
    }
    totalReps += s.reps || 0;
    totalLapses += s.lapses || 0;
  });
  
  const dictationsCompleted = stats.dictationCount || 0;
  
  const avgRetention = totalReps > 0 
    ? Math.round(((totalReps - totalLapses) / totalReps) * 100) 
    : 100;
  
  const totalDays = getDaysPassedInYear();
  const completedDays = stats.totalDaysLearned || 0;
  const completionRate = totalDays > 0 ? Math.round((completedDays / totalDays) * 100) : 0;
  
  return {
    label: '本年',
    newSentences,
    reviewsCompleted,
    dictationsCompleted,
    pointsEarned: stats.totalPoints || 0,
    avgRetention,
    streakDays: stats.totalDaysLearned || 0,
    completionRate,
    totalDays,
    completedDays,
  };
};

export const computeAllTimeStats = (sentences: Sentence[], stats: UserStats): TimePeriodStats => {
  let totalReps = 0;
  let totalLapses = 0;
  
  sentences.forEach(s => {
    totalReps += s.reps || 0;
    totalLapses += s.lapses || 0;
  });
  
  const avgRetention = totalReps > 0 
    ? Math.round(((totalReps - totalLapses) / totalReps) * 100) 
    : 100;
  
  const totalDays = stats.totalDaysLearned || 0;
  const completedDays = totalDays;
  const completionRate = 100;
  
  return {
    label: '累计',
    newSentences: sentences.length,
    reviewsCompleted: sentences.filter(s => s.intervalIndex > 0).length,
    dictationsCompleted: stats.dictationCount || 0,
    pointsEarned: stats.totalPoints || 0,
    avgRetention,
    streakDays: stats.totalDaysLearned || 0,
    completionRate,
    totalDays,
    completedDays,
  };
};

export const computeTimePeriodStats = (sentences: Sentence[], stats: UserStats) => {
  return {
    weekly: computeWeeklyStats(sentences, stats),
    monthly: computeMonthlyStats(sentences, stats),
    yearly: computeYearlyStats(sentences, stats),
    allTime: computeAllTimeStats(sentences, stats),
  };
};
