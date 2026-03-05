import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storage';
import { useSync } from '../hooks/useSync';
import { useAppContext } from './AppContext';

interface SentenceContextType {
  sentences: Sentence[];
  refreshSentences: () => Promise<void>;
  isSyncing: boolean;
  syncMessage: string;
}

const SentenceContext = createContext<SentenceContextType | undefined>(undefined);

export const SentenceProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const { isOnline, isConfigured } = useAppContext();
  const { syncData, isSyncing, syncMessage } = useSync();

  const refreshSentences = useCallback(async () => {
    try {
      const data = await storageService.getSentences();
      setSentences(data);
      
      // If configured and online, sync with cloud
      if (isConfigured && isOnline) {
        const syncedData = await syncData(data);
        if (syncedData) {
          setSentences(syncedData);
        }
      }
    } catch (err) {
      console.error('Failed to refresh sentences:', err);
    }
  }, [isConfigured, isOnline, syncData]);

  // Initial load
  useEffect(() => {
    // Load local data first
    storageService.getSentences().then(setSentences);
  }, []);

  // When config changes (e.g. user login), refresh and sync
  useEffect(() => {
    if (isConfigured) {
      refreshSentences();
    }
  }, [isConfigured, refreshSentences]);

  return (
    <SentenceContext.Provider value={{ sentences, refreshSentences, isSyncing, syncMessage }}>
      {children}
    </SentenceContext.Provider>
  );
};

export const useSentenceContext = () => {
  const context = useContext(SentenceContext);
  if (!context) throw new Error('useSentenceContext must be used within SentenceProvider');
  return context;
};
