import React, { createContext, useContext, useState, useCallback, useRef, ReactNode, useEffect } from 'react';
import { Sentence } from '../types';
import { supabaseService } from '../services/supabaseService';
import { dbService } from '../services/dbService';
import { useAppContext } from './AppContext';

interface SyncContextType {
  isSyncing: boolean;
  syncMessage: string;
  syncData: (currentSentences: Sentence[]) => Promise<Sentence[] | undefined>;
  cancelSync: () => void;
}

const SyncContext = createContext<SyncContextType | undefined>(undefined);

export const SyncProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { isConfigured, isOnline } = useAppContext();
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  
  const syncLockRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCancelledRef = useRef(false);

  const clearMessageTimeout = useCallback(() => {
    if (messageTimeoutRef.current) {
      clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = null;
    }
  }, []);

  const setTemporaryMessage = useCallback((message: string, duration: number = 3000) => {
    clearMessageTimeout();
    setSyncMessage(message);
    messageTimeoutRef.current = setTimeout(() => {
      setSyncMessage('');
    }, duration);
  }, [clearMessageTimeout]);

  const syncData = useCallback(async (currentSentences: Sentence[]): Promise<Sentence[] | undefined> => {
    if (!isConfigured || !isOnline || syncLockRef.current) {
      return;
    }

    syncLockRef.current = true;
    isCancelledRef.current = false;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsSyncing(true);

    const snapshot = [...currentSentences];
    let wasCancelled = false;

    try {
      const { sentences: syncedData, message, needsLocalUpdate, deletedLocalIds } = await supabaseService.syncSentencesWithFreshData(async () => {
        const local = await dbService.getAll();
        return local.sort((a, b) => a.addedAt - b.addedAt);
      });
      
      if (controller.signal.aborted || isCancelledRef.current) {
        console.log('同步已取消（网络请求后），返回原始数据');
        wasCancelled = true;
        return snapshot;
      }
      
      if (deletedLocalIds && deletedLocalIds.length > 0) {
        if (controller.signal.aborted || isCancelledRef.current) {
          console.log('同步已取消（删除前），返回原始数据');
          wasCancelled = true;
          return snapshot;
        }
        await Promise.all(deletedLocalIds.map(id => dbService.delete(id)));
      }
      
      if (needsLocalUpdate) {
        if (controller.signal.aborted || isCancelledRef.current) {
          console.log('同步已取消（写入前），返回原始数据');
          wasCancelled = true;
          return snapshot;
        }
        const syncedSorted = syncedData.sort((a, b) => a.addedAt - b.addedAt);
        await dbService.putAll(syncedSorted);
      }
      
      if (!isCancelledRef.current) {
        setTemporaryMessage(message);
      }
      return syncedData;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') {
        console.log('同步已取消（异常捕获），返回原始数据');
        wasCancelled = true;
        return snapshot;
      }
      console.error('Sync failed:', e);
      if (!isCancelledRef.current) {
        setTemporaryMessage(`同步失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return snapshot;
    } finally {
      syncLockRef.current = false;
      abortControllerRef.current = null;
      setIsSyncing(false);
      if (!wasCancelled) {
        isCancelledRef.current = false;
      }
    }
  }, [isConfigured, isOnline, setTemporaryMessage]);

  const cancelSync = useCallback(() => {
    if (abortControllerRef.current && syncLockRef.current) {
      isCancelledRef.current = true;
      abortControllerRef.current.abort();
      setTemporaryMessage('同步已取消');
    }
  }, [setTemporaryMessage]);

  useEffect(() => {
    return () => {
      clearMessageTimeout();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [clearMessageTimeout]);

  return (
    <SyncContext.Provider value={{ isSyncing, syncMessage, syncData, cancelSync }}>
      {children}
    </SyncContext.Provider>
  );
};

export const useSync = () => {
  const context = useContext(SyncContext);
  if (!context) {
    throw new Error('useSync must be used within SyncProvider');
  }
  return context;
};
