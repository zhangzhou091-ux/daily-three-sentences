import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storage';
import { useSync } from './SyncContext';
import { useAppContext } from './AppContext';

interface SentenceContextType {
  sentences: Sentence[];
  refreshSentences: () => Promise<void>;
  isSyncing: boolean;
  syncMessage: string;
  isInitialLoading: boolean;
  syncError: string | null;
}

const SentenceContext = createContext<SentenceContextType | undefined>(undefined);

function mergeSentencesByUpdatedAt(
  existing: Sentence[], 
  incoming: Sentence[]
): Sentence[] {
  const map = new Map<string, Sentence>();
  
  existing.forEach(s => {
    if (s && s.id) {
      map.set(s.id, s);
    }
  });
  
  incoming.forEach(s => {
    if (s && s.id) {
      const existingSentence = map.get(s.id);
      if (!existingSentence) {
        map.set(s.id, s);
      } else {
        const existingTime = existingSentence.updatedAt || 0;
        const incomingTime = s.updatedAt || 0;
        if (incomingTime >= existingTime) {
          map.set(s.id, s);
        }
      }
    }
  });
  
  return Array.from(map.values()).sort((a, b) => a.addedAt - b.addedAt);
}

export const SentenceProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const { isOnline, isConfigured } = useAppContext();
  const { syncData, isSyncing, syncMessage } = useSync();
  
  const lastRequestId = useRef(0);
  const previousSentencesRef = useRef<Sentence[]>([]);
  const dataVersionRef = useRef(0);

  const refreshSentences = useCallback(async () => {
    const currentRequestId = ++lastRequestId.current;
    const currentVersion = ++dataVersionRef.current;
    
    try {
      console.log('📚 SentenceContext: 开始加载本地句子...');
      const localData = await storageService.getSentences();
      
      if (currentRequestId !== lastRequestId.current) {
        console.log('📚 SentenceContext: 检测到新请求，放弃当前本地数据更新');
        return;
      }
      
      console.log(`📚 SentenceContext: 本地句子加载完成，共${localData.length}条`);
      
      if (localData.length > 0 || previousSentencesRef.current.length === 0) {
        setSentences(localData);
        previousSentencesRef.current = localData;
      }
      
      setSyncError(null);
      setIsInitialLoading(false);

      if (isConfigured && isOnline) {
        console.log('📚 SentenceContext: 开始云端同步...');
        const result = await syncData(localData);
        
        if (Array.isArray(result) && result.length > 0) {
          console.log(`📚 SentenceContext: 云端同步完成，共${result.length}条`);
          
          const mergedData = mergeSentencesByUpdatedAt(
            previousSentencesRef.current,
            result
          );
          
          previousSentencesRef.current = mergedData;
          
          if (currentRequestId === lastRequestId.current && currentVersion === dataVersionRef.current) {
            console.log('📚 SentenceContext: 当前请求为最新，更新UI');
            setSentences(mergedData);
            setSyncError(null);
          } else {
            console.log('📚 SentenceContext: 请求已过期，同步结果已缓存但不更新UI');
            console.log(`📚 SentenceContext: 缓存版本=${currentVersion}, 最新版本=${dataVersionRef.current}`);
          }
        } else if (result === undefined) {
          console.warn('📚 SentenceContext: 云端同步未执行（未配置或离线），保持本地数据');
          if (currentRequestId === lastRequestId.current) {
            setSyncError('同步未执行，显示本地数据');
          }
        }
      } else {
        console.log('📚 SentenceContext: 跳过云端同步', { isConfigured, isOnline });
      }
    } catch (err: unknown) {
      console.error('📚 SentenceContext: 加载句子失败:', err);
      
      if (currentRequestId === lastRequestId.current) {
        setSyncError(err instanceof Error ? err.message : '加载失败');
        setIsInitialLoading(false);
        
        if (previousSentencesRef.current.length > 0) {
          console.log('📚 SentenceContext: 恢复到上一次的有效数据');
          setSentences(previousSentencesRef.current);
        }
      }
    }
  }, [isConfigured, isOnline, syncData]);

  useEffect(() => {
    refreshSentences();
  }, [refreshSentences]);

  return (
    <SentenceContext.Provider value={{ sentences, refreshSentences, isSyncing, syncMessage, isInitialLoading, syncError }}>
      {children}
    </SentenceContext.Provider>
  );
};

export const useSentenceContext = () => {
  const context = useContext(SentenceContext);
  if (!context) throw new Error('useSentenceContext must be used within SentenceProvider');
  return context;
};
