import { UserStats } from '../../types';
import { MemoryAnalysis } from './memory';

export type AchievementTier = 'beginner' | 'intermediate' | 'advanced' | 'expert';
export type AchievementCategory = 'daily' | 'mastery' | 'streak' | 'challenge' | 'social' | 'fsrs';

export interface AchievementReward {
  type: 'badge' | 'points' | 'title' | 'resource';
  value: string | number;
  description: string;
}

export interface Achievement {
  id: string;
  category: AchievementCategory;
  tier: AchievementTier;
  title: string;
  icon: string;
  target: number;
  current: number;
  desc: string;
  unlocked: boolean;
  progress: number;
  unlockedAt?: number;
  rewards: AchievementReward[];
  nextTierId?: string;
  prevTierId?: string;
}

export interface AchievementContext {
  stats: UserStats;
  memory: MemoryAnalysis;
  sentenceCount: number;
}

export interface AchievementRule {
  id: string;
  category: AchievementCategory;
  tier: AchievementTier;
  title: string;
  icon: string;
  target: number;
  desc: string;
  getValue: (ctx: AchievementContext) => number;
  rewards: AchievementReward[];
  nextTierId?: string;
  prevTierId?: string;
}

export interface AchievementRecommendation {
  achievement: Achievement;
  priority: 'high' | 'medium' | 'low';
  reason: string;
}

export const ACHIEVEMENT_CATEGORIES: Record<AchievementCategory, { title: string; icon: string; color: string; desc: string }> = {
  daily: { title: '每日学习', icon: '📅', color: 'blue', desc: '坚持每日学习，养成良好习惯' },
  mastery: { title: '知识掌握', icon: '🎯', color: 'purple', desc: '深入学习，掌握更多知识' },
  streak: { title: '连续打卡', icon: '🔥', color: 'orange', desc: '保持连续学习，挑战最长记录' },
  challenge: { title: '挑战成就', icon: '🏆', color: 'amber', desc: '完成特殊挑战，获得荣誉勋章' },
  social: { title: '社交互动', icon: '👥', color: 'green', desc: '分享学习成果，激励他人' },
  fsrs: { title: 'FSRS 记忆', icon: '🧠', color: 'indigo', desc: '优化记忆算法，提升学习效率' },
};

export const TIER_CONFIG: Record<AchievementTier, { title: string; multiplier: number; color: string }> = {
  beginner: { title: '初级', multiplier: 1, color: 'gray' },
  intermediate: { title: '中级', multiplier: 1.5, color: 'blue' },
  advanced: { title: '高级', multiplier: 2, color: 'purple' },
  expert: { title: '专家', multiplier: 3, color: 'amber' },
};

const createReward = (type: AchievementReward['type'], value: string | number, description: string): AchievementReward => ({
  type,
  value,
  description,
});

export const ACHIEVEMENT_RULES: AchievementRule[] = [
  // Daily Learning - 每日学习
  {
    id: 'daily-learn-1',
    category: 'daily',
    tier: 'beginner',
    title: '初学乍练',
    icon: '🌱',
    target: 1,
    desc: '完成首次学习',
    getValue: ctx => ctx.stats.totalDaysLearned || 0,
    rewards: [createReward('points', 10, '获得 10 积分'), createReward('badge', 'first_step', '新手徽章')],
    nextTierId: 'daily-learn-7',
  },
  {
    id: 'daily-learn-7',
    category: 'daily',
    tier: 'intermediate',
    title: '周周向上',
    icon: '📅',
    target: 7,
    desc: '累计学习 7 天',
    getValue: ctx => ctx.stats.totalDaysLearned || 0,
    rewards: [createReward('points', 50, '获得 50 积分')],
    prevTierId: 'daily-learn-1',
    nextTierId: 'daily-learn-30',
  },
  {
    id: 'daily-learn-30',
    category: 'daily',
    tier: 'advanced',
    title: '月度学霸',
    icon: '📚',
    target: 30,
    desc: '累计学习 30 天',
    getValue: ctx => ctx.stats.totalDaysLearned || 0,
    rewards: [createReward('points', 200, '获得 200 积分'), createReward('title', '月度学霸', '专属称号')],
    prevTierId: 'daily-learn-7',
    nextTierId: 'daily-learn-100',
  },
  {
    id: 'daily-learn-100',
    category: 'daily',
    tier: 'expert',
    title: '百日坚持',
    icon: '🏆',
    target: 100,
    desc: '累计学习 100 天',
    getValue: ctx => ctx.stats.totalDaysLearned || 0,
    rewards: [createReward('points', 500, '获得 500 积分'), createReward('badge', 'century', '百日徽章')],
    prevTierId: 'daily-learn-30',
  },

  // Streak - 连续打卡
  {
    id: 'streak-3',
    category: 'streak',
    tier: 'beginner',
    title: '三连击',
    icon: '⚡',
    target: 3,
    desc: '连续学习 3 天',
    getValue: ctx => ctx.stats.streak || 0,
    rewards: [createReward('points', 30, '获得 30 积分')],
    nextTierId: 'streak-7',
  },
  {
    id: 'streak-7',
    category: 'streak',
    tier: 'intermediate',
    title: '周周坚持',
    icon: '🔥',
    target: 7,
    desc: '连续学习 7 天',
    getValue: ctx => ctx.stats.streak || 0,
    rewards: [createReward('points', 100, '获得 100 积分'), createReward('badge', 'weekly_warrior', '周战士徽章')],
    prevTierId: 'streak-3',
    nextTierId: 'streak-30',
  },
  {
    id: 'streak-30',
    category: 'streak',
    tier: 'advanced',
    title: '月度连胜',
    icon: '💪',
    target: 30,
    desc: '连续学习 30 天',
    getValue: ctx => ctx.stats.streak || 0,
    rewards: [createReward('points', 300, '获得 300 积分'), createReward('title', '坚持达人', '专属称号')],
    prevTierId: 'streak-7',
    nextTierId: 'streak-100',
  },
  {
    id: 'streak-100',
    category: 'streak',
    tier: 'expert',
    title: '百日连胜',
    icon: '👑',
    target: 100,
    desc: '连续学习 100 天',
    getValue: ctx => ctx.stats.streak || 0,
    rewards: [createReward('points', 1000, '获得 1000 积分'), createReward('badge', 'legend', '传奇徽章')],
    prevTierId: 'streak-30',
  },

  // Mastery - 知识掌握
  {
    id: 'mastery-10',
    category: 'mastery',
    tier: 'beginner',
    title: '初窥门径',
    icon: '🌟',
    target: 10,
    desc: '掌握 10 个句子',
    getValue: ctx => ctx.memory.permanent,
    rewards: [createReward('points', 50, '获得 50 积分')],
    nextTierId: 'mastery-50',
  },
  {
    id: 'mastery-50',
    category: 'mastery',
    tier: 'intermediate',
    title: '渐入佳境',
    icon: '📖',
    target: 50,
    desc: '掌握 50 个句子',
    getValue: ctx => ctx.memory.permanent,
    rewards: [createReward('points', 150, '获得 150 积分')],
    prevTierId: 'mastery-10',
    nextTierId: 'mastery-100',
  },
  {
    id: 'mastery-100',
    category: 'mastery',
    tier: 'advanced',
    title: '学有所成',
    icon: '🎓',
    target: 100,
    desc: '掌握 100 个句子',
    getValue: ctx => ctx.memory.permanent,
    rewards: [createReward('points', 400, '获得 400 积分'), createReward('title', '知识达人', '专属称号')],
    prevTierId: 'mastery-50',
    nextTierId: 'mastery-500',
  },
  {
    id: 'mastery-500',
    category: 'mastery',
    tier: 'expert',
    title: '博学多才',
    icon: '📚',
    target: 500,
    desc: '掌握 500 个句子',
    getValue: ctx => ctx.memory.permanent,
    rewards: [createReward('points', 1000, '获得 1000 积分'), createReward('badge', 'scholar', '学者徽章')],
    prevTierId: 'mastery-100',
  },

  // Challenge - 挑战成就
  {
    id: 'challenge-collection-100',
    category: 'challenge',
    tier: 'intermediate',
    title: '词库收藏家',
    icon: '💎',
    target: 100,
    desc: '词库达到 100 个句子',
    getValue: ctx => ctx.sentenceCount,
    rewards: [createReward('points', 100, '获得 100 积分')],
    nextTierId: 'challenge-collection-500',
  },
  {
    id: 'challenge-collection-500',
    category: 'challenge',
    tier: 'advanced',
    title: '词库大师',
    icon: '🏆',
    target: 500,
    desc: '词库达到 500 个句子',
    getValue: ctx => ctx.sentenceCount,
    rewards: [createReward('points', 500, '获得 500 积分'), createReward('badge', 'collector', '收藏家徽章')],
    prevTierId: 'challenge-collection-100',
  },
  {
    id: 'challenge-points-2000',
    category: 'challenge',
    tier: 'advanced',
    title: '积分巨贾',
    icon: '💰',
    target: 2000,
    desc: '累计获得 2000 积分',
    getValue: ctx => ctx.stats.totalPoints || 0,
    rewards: [createReward('title', '积分达人', '专属称号')],
    nextTierId: 'challenge-points-5000',
  },
  {
    id: 'challenge-points-5000',
    category: 'challenge',
    tier: 'expert',
    title: '积分富豪',
    icon: '💎',
    target: 5000,
    desc: '累计获得 5000 积分',
    getValue: ctx => ctx.stats.totalPoints || 0,
    rewards: [createReward('badge', 'millionaire', '富豪徽章')],
    prevTierId: 'challenge-points-2000',
  },

  // FSRS - 记忆算法
  {
    id: 'fsrs-stability-3',
    category: 'fsrs',
    tier: 'beginner',
    title: '记忆新手',
    icon: '🧠',
    target: 3,
    desc: '平均稳定性达到 3 天',
    getValue: ctx => ctx.memory.avgStability,
    rewards: [createReward('points', 50, '获得 50 积分')],
    nextTierId: 'fsrs-stability-7',
  },
  {
    id: 'fsrs-stability-7',
    category: 'fsrs',
    tier: 'intermediate',
    title: '记忆达人',
    icon: '🧠',
    target: 7,
    desc: '平均稳定性达到 7 天',
    getValue: ctx => ctx.memory.avgStability,
    rewards: [createReward('points', 150, '获得 150 积分')],
    prevTierId: 'fsrs-stability-3',
    nextTierId: 'fsrs-stability-14',
  },
  {
    id: 'fsrs-stability-14',
    category: 'fsrs',
    tier: 'advanced',
    title: '记忆大师',
    icon: '🧠',
    target: 14,
    desc: '平均稳定性达到 14 天',
    getValue: ctx => ctx.memory.avgStability,
    rewards: [createReward('points', 300, '获得 300 积分'), createReward('title', '记忆大师', '专属称号')],
    prevTierId: 'fsrs-stability-7',
  },
  {
    id: 'fsrs-retention-90',
    category: 'fsrs',
    tier: 'intermediate',
    title: '记忆精准',
    icon: '🎯',
    target: 90,
    desc: '记忆保留率达到 90%（需至少复习 10 次）',
    getValue: ctx => {
      const totalReps = ctx.memory.totalReps || 0;
      if (totalReps < 10) return 0;
      return ctx.memory.retention;
    },
    rewards: [createReward('points', 100, '获得 100 积分')],
    nextTierId: 'fsrs-retention-95',
  },
  {
    id: 'fsrs-retention-95',
    category: 'fsrs',
    tier: 'advanced',
    title: '记忆完美',
    icon: '💯',
    target: 95,
    desc: '记忆保留率达到 95%（需至少复习 30 次）',
    getValue: ctx => {
      const totalReps = ctx.memory.totalReps || 0;
      if (totalReps < 30) return 0;
      return ctx.memory.retention;
    },
    rewards: [createReward('points', 300, '获得 300 积分'), createReward('badge', 'perfect_memory', '完美记忆徽章')],
    prevTierId: 'fsrs-retention-90',
  },

  // Social - 社交互动
  {
    id: 'social-share-1',
    category: 'social',
    tier: 'beginner',
    title: '分享新手',
    icon: '📤',
    target: 1,
    desc: '首次分享成就',
    getValue: ctx => ctx.stats.shareCount || 0,
    rewards: [createReward('points', 20, '获得 20 积分')],
    nextTierId: 'social-share-5',
  },
  {
    id: 'social-share-5',
    category: 'social',
    tier: 'intermediate',
    title: '分享达人',
    icon: '🌟',
    target: 5,
    desc: '分享 5 次成就',
    getValue: ctx => ctx.stats.shareCount || 0,
    rewards: [createReward('points', 100, '获得 100 积分'), createReward('badge', 'sharer', '分享达人徽章')],
    prevTierId: 'social-share-1',
  },
];

const ACHIEVEMENTS_STORAGE_KEY = 'd3s_achievements_unlocked';

interface UnlockedRecord {
  unlockedAt: number;
}

const loadUnlockedMap = (): Record<string, UnlockedRecord> => {
  try {
    const raw = localStorage.getItem(ACHIEVEMENTS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
};

const saveUnlockedMap = (map: Record<string, UnlockedRecord>): void => {
  try {
    localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify(map));
  } catch {}
};

export const persistAchievementUnlock = (achievementId: string): void => {
  const map = loadUnlockedMap();
  if (!map[achievementId]) {
    map[achievementId] = { unlockedAt: Date.now() };
    saveUnlockedMap(map);
  }
};

export const computeAchievements = (ctx: AchievementContext): Achievement[] => {
  const unlockedMap = loadUnlockedMap();

  return ACHIEVEMENT_RULES.map(rule => {
    const current = rule.getValue(ctx);
    const target = rule.target > 0 ? rule.target : 1;
    const unlocked = current >= rule.target;
    const progress = Math.min((current / target) * 100, 100);

    const persisted = unlockedMap[rule.id];

    return {
      id: rule.id,
      category: rule.category,
      tier: rule.tier,
      title: rule.title,
      icon: rule.icon,
      target: rule.target,
      current,
      desc: rule.desc,
      unlocked,
      progress: Math.round(progress),
      unlockedAt: persisted?.unlockedAt,
      rewards: rule.rewards,
      nextTierId: rule.nextTierId,
      prevTierId: rule.prevTierId,
    };
  });
};

export const detectNewAchievements = (
  prev: Achievement[],
  next: Achievement[]
): Achievement[] => {
  const prevUnlocked = new Set(prev.filter(a => a.unlocked).map(a => a.id));
  return next.filter(a => a.unlocked && !prevUnlocked.has(a.id));
};

let achievementsCache: Achievement[] | null = null;
let cacheKey: string | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 60_000;

const getCacheKey = (ctx: AchievementContext): string => {
  return JSON.stringify({
    totalDaysLearned: ctx.stats.totalDaysLearned,
    streak: ctx.stats.streak,
    totalPoints: ctx.stats.totalPoints,
    shareCount: ctx.stats.shareCount,
    permanent: ctx.memory.permanent,
    avgStability: ctx.memory.avgStability,
    retention: ctx.memory.retention,
    sentenceCount: ctx.sentenceCount,
  });
};

export const computeAchievementsCached = (ctx: AchievementContext): Achievement[] => {
  const now = Date.now();
  const key = getCacheKey(ctx);
  if (cacheKey === key && achievementsCache && (now - cacheTimestamp) < CACHE_TTL) {
    return achievementsCache;
  }
  cacheKey = key;
  cacheTimestamp = now;
  achievementsCache = computeAchievements(ctx);
  return achievementsCache;
};

export const clearAchievementsCache = (): void => {
  achievementsCache = null;
  cacheKey = null;
  cacheTimestamp = 0;
};

export const getUnlockedCount = (achievements: Achievement[]): number => {
  return achievements.filter(a => a.unlocked).length;
};

export const getByCategory = (achievements: Achievement[], category: AchievementCategory): Achievement[] => {
  return achievements.filter(a => a.category === category);
};

export const getByTier = (achievements: Achievement[], tier: AchievementTier): Achievement[] => {
  return achievements.filter(a => a.tier === tier);
};

export const getAlmostUnlocked = (achievements: Achievement[], threshold = 80): Achievement[] => {
  return achievements.filter(a => !a.unlocked && a.progress >= threshold);
};

export const getRecentlyUnlocked = (achievements: Achievement[], days = 7): Achievement[] => {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return achievements.filter(a => a.unlocked && a.unlockedAt && a.unlockedAt >= cutoff);
};

export const getRecommendations = (ctx: AchievementContext, existingAchievements?: Achievement[]): AchievementRecommendation[] => {
  const achievements = existingAchievements ?? computeAchievementsCached(ctx);
  const recommendations: AchievementRecommendation[] = [];
  
  const almostUnlocked = getAlmostUnlocked(achievements, 70);
  almostUnlocked.slice(0, 3).forEach(ach => {
    recommendations.push({
      achievement: ach,
      priority: 'high',
      reason: `距离解锁仅差 ${ach.target - ach.current} 步`,
    });
  });

  const streakAchievements = getByCategory(achievements, 'streak').filter(a => !a.unlocked);
  if (streakAchievements.length > 0) {
    const nextStreak = streakAchievements[0];
    recommendations.push({
      achievement: nextStreak,
      priority: 'high',
      reason: '保持连续学习，挑战更长记录',
    });
  }

  const fsrsAchievements = getByCategory(achievements, 'fsrs').filter(a => !a.unlocked);
  if (fsrsAchievements.length > 0 && ctx.memory.retention < 90) {
    recommendations.push({
      achievement: fsrsAchievements.find(a => a.id.includes('retention')) || fsrsAchievements[0],
      priority: 'medium',
      reason: '提升记忆保留率，优化学习效果',
    });
  }

  const beginnerNotUnlocked = getByTier(achievements, 'beginner').filter(a => !a.unlocked);
  if (beginnerNotUnlocked.length > 0) {
    recommendations.push({
      achievement: beginnerNotUnlocked[0],
      priority: 'low',
      reason: '完成基础成就，开启学习之旅',
    });
  }

  return recommendations.slice(0, 5);
};

let overallProgressCache: ReturnType<typeof computeOverallProgress> | null = null;
let overallProgressCacheKey: string | null = null;

export const computeOverallProgress = (achievements: Achievement[]): {
  total: number;
  unlocked: number;
  percentage: number;
  byCategory: Record<AchievementCategory, { total: number; unlocked: number }>;
  byTier: Record<AchievementTier, { total: number; unlocked: number }>;
} => {
  const cacheKey = achievements.map(a => `${a.id}:${a.unlocked}`).join(',');
  if (overallProgressCacheKey === cacheKey && overallProgressCache) {
    return overallProgressCache;
  }
  
  const byCategory: Record<AchievementCategory, { total: number; unlocked: number }> = {} as any;
  const byTier: Record<AchievementTier, { total: number; unlocked: number }> = {} as any;

  Object.keys(ACHIEVEMENT_CATEGORIES).forEach(cat => {
    byCategory[cat as AchievementCategory] = { total: 0, unlocked: 0 };
  });

  Object.keys(TIER_CONFIG).forEach(tier => {
    byTier[tier as AchievementTier] = { total: 0, unlocked: 0 };
  });

  achievements.forEach(ach => {
    byCategory[ach.category].total++;
    byTier[ach.tier].total++;
    if (ach.unlocked) {
      byCategory[ach.category].unlocked++;
      byTier[ach.tier].unlocked++;
    }
  });

  const total = achievements.length;
  const unlocked = achievements.filter(a => a.unlocked).length;

  overallProgressCacheKey = cacheKey;
  overallProgressCache = {
    total,
    unlocked,
    percentage: total > 0 ? Math.round((unlocked / total) * 100) : 0,
    byCategory,
    byTier,
  };

  return overallProgressCache;
};

export const getNextMilestone = (achievements: Achievement[]): Achievement | null => {
  const almostUnlocked = getAlmostUnlocked(achievements, 50);
  if (almostUnlocked.length === 0) return null;
  return almostUnlocked.sort((a, b) => b.progress - a.progress)[0];
};

export const getTotalRewards = (achievements: Achievement[]): {
  points: number;
  badges: string[];
  titles: string[];
} => {
  const points = achievements
    .filter(a => a.unlocked)
    .flatMap(a => a.rewards)
    .filter(r => r.type === 'points')
    .reduce((sum, r) => sum + (typeof r.value === 'number' ? r.value : 0), 0);

  const badges = achievements
    .filter(a => a.unlocked)
    .flatMap(a => a.rewards)
    .filter(r => r.type === 'badge')
    .map(r => String(r.value));

  const titles = achievements
    .filter(a => a.unlocked)
    .flatMap(a => a.rewards)
    .filter(r => r.type === 'title')
    .map(r => String(r.value));

  return { points, badges, titles };
};