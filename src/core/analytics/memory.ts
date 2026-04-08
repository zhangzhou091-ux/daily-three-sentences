import { Sentence } from '../../types';

const formatDate = (date: Date) => date.toISOString().split('T')[0];

export interface MemoryAnalysis {
  total: number;
  learned: number;
  learning: number;
  permanent: number;
  avgStability: number;
  avgDifficulty: number;
  retention: number;
  distribution: {
    name: string;
    key: string;
    count: number;
    ratio: number;
    color: string;
    textColor: string;
    bgColor: string;
  }[];
}

const MEMORY_LEVELS = [
  { name: '学习中', key: 'learning', min: 0, max: 1, color: 'bg-gray-100', textColor: 'text-gray-500', bgColor: 'bg-gray-500' },
  { name: '短期记忆', key: 'short', min: 1, max: 7, color: 'bg-blue-100', textColor: 'text-blue-500', bgColor: 'bg-blue-500' },
  { name: '中期记忆', key: 'medium', min: 7, max: 30, color: 'bg-purple-100', textColor: 'text-purple-500', bgColor: 'bg-purple-500' },
  { name: '长期记忆', key: 'long', min: 30, max: 90, color: 'bg-green-100', textColor: 'text-green-500', bgColor: 'bg-green-500' },
  { name: '永久记忆', key: 'permanent', min: 90, max: Infinity, color: 'bg-amber-100', textColor: 'text-amber-500', bgColor: 'bg-amber-500' },
];

export const computeMemoryAnalysis = (sentences: Sentence[]): MemoryAnalysis => {
  const total = sentences.length;
  
  if (total === 0) {
    return {
      total: 0,
      learned: 0,
      learning: 0,
      permanent: 0,
      avgStability: 0,
      avgDifficulty: 0,
      retention: 0,
      distribution: MEMORY_LEVELS.map(level => ({
        ...level,
        count: 0,
        ratio: 0,
      })),
    };
  }

  let learned = 0;
  let totalStability = 0;
  let totalDifficulty = 0;
  let totalReps = 0;
  let totalLapses = 0;
  let permanent = 0;
  
  const stabilityBuckets = MEMORY_LEVELS.map(() => 0);

  sentences.forEach(s => {
    const stability = s.stability || 0;
    const difficulty = s.difficulty || 5;
    const reps = s.reps || 0;
    const lapses = s.lapses || 0;
    
    if (s.intervalIndex > 0) {
      learned++;
      totalStability += stability;
      totalDifficulty += difficulty;
      totalReps += reps;
      totalLapses += lapses;
      
      if (stability >= 90) permanent++;
      
      for (let i = 0; i < MEMORY_LEVELS.length; i++) {
        const level = MEMORY_LEVELS[i];
        if (stability >= level.min && stability < level.max) {
          stabilityBuckets[i]++;
          break;
        }
      }
    }
  });

  const distribution = MEMORY_LEVELS.map((level, i) => ({
    ...level,
    count: stabilityBuckets[i],
    ratio: learned > 0 ? Math.round((stabilityBuckets[i] / learned) * 100) : 0,
  }));

  const retention = totalReps > 0 
    ? Math.round(((totalReps - totalLapses) / totalReps) * 100) 
    : 100;

  return {
    total,
    learned,
    learning: total - learned,
    permanent,
    avgStability: learned > 0 ? Math.round((totalStability / learned) * 10) / 10 : 0,
    avgDifficulty: learned > 0 ? Math.round((totalDifficulty / learned) * 10) / 10 : 0,
    retention,
    distribution,
  };
};
