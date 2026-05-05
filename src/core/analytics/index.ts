import { Sentence, UserStats } from '../../types';
import { computeMemoryAnalysis, MemoryAnalysis } from './memory';
import { computeForecast, ForecastAnalysis } from './forecast';
import { computeLevelInfo, LevelInfo, LEVEL_CONFIG } from './level';
import { 
  computeAchievements, 
  Achievement, 
  AchievementContext, 
  ACHIEVEMENT_CATEGORIES, 
  ACHIEVEMENT_RULES, 
  AchievementRule,
  AchievementTier,
  AchievementCategory,
  AchievementReward,
  AchievementRecommendation,
  TIER_CONFIG,
  getUnlockedCount,
  getByCategory,
  getByTier,
  getAlmostUnlocked,
  getRecentlyUnlocked,
  getRecommendations,
  computeOverallProgress,
  getNextMilestone,
  getTotalRewards,
  detectNewAchievements,
  persistAchievementUnlock,
} from './achievements';
import { computeTimePeriodStats, TimePeriodStats } from './timeStats';

export interface AnalyticsResult {
  memory: MemoryAnalysis;
  forecast: ForecastAnalysis;
  level: LevelInfo;
  achievements: Achievement[];
  unlockedCount: number;
  timeStats: {
    weekly: TimePeriodStats;
    monthly: TimePeriodStats;
    yearly: TimePeriodStats;
    allTime: TimePeriodStats;
  };
}

const formatDate = (date: Date) => date.toISOString().split('T')[0];

export const computeAllAnalytics = (
  sentences: Sentence[], 
  stats: UserStats, 
  forecastDays: number = 7
): AnalyticsResult => {
  const memory = computeMemoryAnalysis(sentences);
  const forecast = computeForecast(sentences, forecastDays);
  const level = computeLevelInfo(stats.totalPoints || 0);
  const timeStats = computeTimePeriodStats(sentences, stats);
  
  const ctx: AchievementContext = {
    stats,
    memory,
    sentenceCount: sentences.length,
  };
  
  const achievements = computeAchievements(ctx);
  const unlockedCount = achievements.filter(a => a.unlocked).length;
  
  return {
    memory,
    forecast,
    level,
    achievements,
    unlockedCount,
    timeStats,
  };
};

export { 
  computeMemoryAnalysis, 
  computeForecast, 
  computeLevelInfo, 
  computeAchievements,
  computeTimePeriodStats,
  LEVEL_CONFIG,
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_RULES,
  TIER_CONFIG,
  getUnlockedCount,
  getByCategory,
  getByTier,
  getAlmostUnlocked,
  getRecentlyUnlocked,
  getRecommendations,
  computeOverallProgress,
  getNextMilestone,
  getTotalRewards,
  detectNewAchievements,
  persistAchievementUnlock,
};

export type { 
  MemoryAnalysis, 
  ForecastAnalysis, 
  LevelInfo, 
  Achievement, 
  AchievementRule,
  AchievementContext,
  AchievementTier,
  AchievementCategory,
  AchievementReward,
  AchievementRecommendation,
  TimePeriodStats,
};
