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
  initError: string | null;
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
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    let cleanupPeriodic: (() => void) | undefined;
    
    const initApp = async () => {
      try {
        storageService.initSync();
        cleanupPeriodic = localStorageService.startPeriodicCleanup();
        performanceMonitor.startPeriodicReporting();
        
        const config = supabaseService.getConfig();
        if (config.isConfigured && config.userName) {
          setIsConfigured(true);
        } else {
          setIsConfigured(false);
        }
        setInitError(null);
      } catch (err) {
        console.error('App init failed:', err);
        setInitError('应用初始化失败，请尝试刷新页面。如果问题持续，请尝试清除浏览器缓存。');
      } finally {
        setIsLoading(false);
      }
      
      setTimeout(() => {
        storageService.recoverPendingStats().catch(err => {
          console.warn('后台恢复统计数据失败:', err);
        });
      }, 0);
    };
    initApp();

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const handleSettingsChanged = (event: Event) => {
      if (event instanceof CustomEvent) {
        const nextSettings = event.detail || storageService.getSettings();
        setSettings(nextSettings);
      }
    };
    const handleStatsChanged = (event: Event) => {
      if (event instanceof CustomEvent) {
        const nextStats = event.detail || localStorageService.getStats();
        setStats(nextStats);
      }
    };
    const handleAuthExpired = () => {
      setIsConfigured(false);
      setConfigError('您已在其他页面登出');
      setCurrentView('settings');
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('settingsChanged', handleSettingsChanged);
    window.addEventListener('statsChanged', handleStatsChanged);
    window.addEventListener('d3s:auth_expired', handleAuthExpired);

    return () => {
      cleanupPeriodic?.();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('settingsChanged', handleSettingsChanged);
      window.removeEventListener('statsChanged', handleStatsChanged);
      window.removeEventListener('d3s:auth_expired', handleAuthExpired);
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
      initError,
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
