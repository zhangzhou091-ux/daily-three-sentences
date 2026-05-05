import { useState, useEffect, useRef, useCallback } from 'react';
import { Sentence, UserStats } from '../../types';
import {
  computeAchievements,
  detectNewAchievements,
  persistAchievementUnlock,
  loadShownAchievements,
  persistShownAchievement,
  Achievement,
} from '../analytics/achievements';
import { computeMemoryAnalysis } from '../analytics/memory';

export const useAchievementNotifications = (
  sentences: Sentence[],
  stats: UserStats
) => {
  const [notifications, setNotifications] = useState<Achievement[]>([]);
  const prevAchievementsRef = useRef<Achievement[] | null>(null);
  const dismissedRef = useRef<Set<string>>(loadShownAchievements());

  useEffect(() => {
    const memory = computeMemoryAnalysis(sentences);
    const nextAchievements = computeAchievements({
      stats,
      memory,
      sentenceCount: sentences.length,
    });

    if (prevAchievementsRef.current) {
      const newlyUnlocked = detectNewAchievements(
        prevAchievementsRef.current,
        nextAchievements
      );

      const unseen = newlyUnlocked.filter(
        a => !dismissedRef.current.has(a.id)
      );

      if (unseen.length > 0) {
        unseen.forEach(a => persistAchievementUnlock(a.id));
        setNotifications(prev => [...prev, ...unseen]);
      }
    }

    prevAchievementsRef.current = nextAchievements;
  }, [sentences, stats]);

  const dismissNotification = useCallback((id: string) => {
    dismissedRef.current.add(id);
    persistShownAchievement(id);
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  return { notifications, dismissNotification };
};
