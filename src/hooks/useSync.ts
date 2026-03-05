import { useState, useRef, useCallback } from 'react';
import { Sentence } from '../types';
import { supabaseService } from '../services/supabaseService';
import { useAppContext } from '../context/AppContext';

export const useSync = () => {
  const { isConfigured, isOnline } = useAppContext();
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  
  const syncLock = useRef(false);
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncData = useCallback(async (currentSentences: Sentence[]) => {
    if (!isConfigured || !isOnline || syncLock.current) return;

    syncLock.current = true;
    setIsSyncing(true);

    try {
      const { sentences: syncedData, message } = await supabaseService.syncSentences(currentSentences);
      setSyncMessage(message);
      setTimeout(() => setSyncMessage(''), 3000);
      return syncedData;
    } catch (e: any) {
      console.error('Sync failed:', e);
      setSyncMessage(`同步失败：${e.message}`);
      setTimeout(() => setSyncMessage(''), 3000);
      return currentSentences;
    } finally {
      syncLock.current = false;
      setIsSyncing(false);
    }
  }, [isConfigured, isOnline]);

  return {
    isSyncing,
    syncMessage,
    syncData
  };
};
