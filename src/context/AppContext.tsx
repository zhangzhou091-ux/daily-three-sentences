import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { UserSettings, UserStats, ViewType } from '../types';
import { storageService } from '../services/storage';
import { supabaseService } from '../services/supabaseService';
import { localStorageService } from '../services/storage/localStorageService';
import { performanceMonitor } from '../utils/performanceMonitor';

interface AppContextType {
  settings: UserSettings;
  stats: UserStats;
  currentView: ViewType;
  isOnline: boolean;
  isSyncing: boolean;
  syncMessage: string;
  configError: string;
  isConfigured: boolean;
  isLoading: boolean;
  setView: (view: ViewType) => void;
  updateSettings: (newSettings: UserSettings) => void;
  setSyncing: (syncing: boolean) => void;
  setSyncMessage: (msg: string) => void;
  refreshConfig: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<UserSettings>(storageService.getSettings());
  const [stats, setStats] = useState<UserStats>(localStorageService.getStats());
  const [currentView, setCurrentView] = useState<ViewType>('study');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [configError, setConfigError] = useState('');
  const [isConfigured, setIsConfigured] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // 初始化应用
  useEffect(() => {
    const initApp = async () => {
      try {
        storageService.initSync();
        localStorageService.startPeriodicCleanup();
        performanceMonitor.startPeriodicReporting();
        
        // 检查 Supabase 是否已完整配置（URL、KEY、用户名）
        const config = supabaseService.getConfig();
        if (config.isConfigured && config.userName) {
          setIsConfigured(true);
        } else {
          setIsConfigured(false);
        }
      } catch (err) {
        console.error('App init failed:', err);
      } finally {
        setIsLoading(false);
      }
    };
    initApp();

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // 更新设置
  const updateSettings = useCallback(async (newSettings: UserSettings) => {
    storageService.saveSettings(newSettings);
    setSettings(newSettings);
  }, []);

  const refreshConfig = useCallback(async () => {
    const currentSettings = storageService.getSettings();
    setSettings(currentSettings);
    
    // 检查 Supabase 是否已完整配置
    const config = supabaseService.getConfig();
    if (config.isConfigured && config.userName) {
      setIsConfigured(true);
      setConfigError('');
    } else {
      setIsConfigured(false);
    }
  }, []);

  return (
    <AppContext.Provider value={{
      settings,
      stats,
      currentView,
      isOnline,
      isSyncing,
      syncMessage,
      configError,
      isConfigured,
      isLoading,
      setView: setCurrentView,
      updateSettings,
      setSyncing: setIsSyncing,
      setSyncMessage,
      refreshConfig
    }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useAppContext must be used within AppProvider');
  return context;
};
