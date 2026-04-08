import { useMemo } from 'react';
import { Sentence, UserStats } from '../../types';
import { computeAllAnalytics, AnalyticsResult } from '../analytics';

export const useAnalytics = (
  sentences: Sentence[], 
  stats: UserStats,
  forecastDays: number = 7
): AnalyticsResult => {
  return useMemo(() => {
    return computeAllAnalytics(sentences, stats, forecastDays);
  }, [sentences, stats, forecastDays]);
};
