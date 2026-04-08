export interface LevelInfo {
  level: number;
  title: string;
  color: string;
  currentPoints: number;
  minPoints: number;
  maxPoints: number;
  nextLevelPoints: number;
  progress: number;
  pointsToNext: number;
}

export const LEVEL_CONFIG = [
  { lv: 1, title: '初级探索者', minPoints: 0, maxPoints: 200, color: 'from-blue-500 to-indigo-400' },
  { lv: 2, title: '新晋学者', minPoints: 200, maxPoints: 600, color: 'from-indigo-500 to-purple-400' },
  { lv: 3, title: '勤奋达人', minPoints: 600, maxPoints: 1200, color: 'from-purple-500 to-pink-400' },
  { lv: 4, title: '语境专家', minPoints: 1200, maxPoints: 2500, color: 'from-pink-500 to-rose-400' },
  { lv: 5, title: '英语大师', minPoints: 2500, maxPoints: 5000, color: 'from-rose-500 to-orange-400' },
  { lv: 6, title: '英语宗师', minPoints: 5000, maxPoints: Infinity, color: 'from-orange-500 to-red-400' },
];

export const computeLevelInfo = (totalPoints: number): LevelInfo => {
  const level = LEVEL_CONFIG.find(l => totalPoints >= l.minPoints && totalPoints < l.maxPoints) || LEVEL_CONFIG[LEVEL_CONFIG.length - 1];
  const nextLevel = LEVEL_CONFIG.find(l => l.lv === level.lv + 1) || level;
  
  const currentPoints = totalPoints;
  const minPoints = level.minPoints;
  const maxPoints = nextLevel.maxPoints === Infinity ? Math.max(totalPoints, 5000) : nextLevel.minPoints;
  
  const range = maxPoints - minPoints;
  const progress = range > 0 ? Math.min(((currentPoints - minPoints) / range) * 100, 100) : 100;
  const pointsToNext = Math.max(0, maxPoints - currentPoints);
  
  return {
    level: level.lv,
    title: level.title,
    color: level.color,
    currentPoints,
    minPoints,
    maxPoints,
    nextLevelPoints: maxPoints,
    progress: Math.round(progress),
    pointsToNext,
  };
};
