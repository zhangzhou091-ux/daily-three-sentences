import React, { useState, useEffect, Suspense, lazy } from 'react';
import Navbar from './Navbar';
// Lazy load pages for better performance
const StudyPage = lazy(() => import('../pages/StudyPage'));
const ManagePage = lazy(() => import('../pages/ManagePage'));
const AchievementPage = lazy(() => import('../pages/AchievementPage'));
const SettingsPage = lazy(() => import('../pages/SettingsPage'));

import { useAppContext } from '../context/AppContext';
import { useSentenceContext } from '../context/SentenceContext';
import { syncQueueService } from '../services/syncQueueService';
import { SyncStatus, SyncEventData, QueueWarningData } from '../types';
import { supabaseService } from '../services/supabaseService';

// const SYNC_MESSAGE_DURATION = 3000; // Unused

const MainLayout: React.FC = () => {
  const { 
    currentView, setView, settings, isOnline, isConfigured, isLoading, 
    syncMessage, isSyncing, configError, updateSettings, setSyncMessage,
    refreshConfig
  } = useAppContext();
  const { sentences, refreshSentences } = useSentenceContext();
  
  const [isNavVisible, setIsNavVisible] = useState(true); // Default to true
  const [userNameInput, setUserNameInput] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [syncQueueStatus, setSyncQueueStatus] = useState(syncQueueService.getQueueStatus());
  const [queueWarning, setQueueWarning] = useState<QueueWarningData | null>(null);
  const [syncToast, setSyncToast] = useState<{ show: boolean; message: string; type: 'success' | 'error' | 'info' | 'warning' }>({ 
    show: false, 
    message: '', 
    type: 'info' 
  });
  const [dbError, setDbError] = useState<string | null>(null);

  useEffect(() => {
    if (!syncToast.show) return;
    
    const duration = syncToast.type === 'success' ? 2000 : 3000;
    const timer = setTimeout(() => {
      setSyncToast(prev => ({ ...prev, show: false }));
    }, duration);
    
    return () => clearTimeout(timer);
  }, [syncToast.show, syncToast.type]);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];
    
    const handleSyncStart = (data?: SyncEventData) => {
      if (data && 'count' in data) {
        setSyncToast({ show: true, message: `正在同步 ${data.count} 条数据...`, type: 'info' });
      }
    };
    
    const handleSyncSuccess = (data?: SyncEventData) => {
      if (data && 'count' in data && 'message' in data) {
        setSyncToast({ show: true, message: data.message || `成功同步 ${data.count} 条数据`, type: 'success' });
      }
    };
    
    const handleSyncError = (data?: SyncEventData) => {
      if (data && 'message' in data && !('count' in data)) {
        setSyncToast({ show: true, message: data.message, type: 'error' });
      }
    };
    
    const handleQueueChanged = (data?: SyncEventData) => {
      if (data && 'pendingCount' in data) {
        setSyncQueueStatus(data);
      }
    };
    
    const handleQueueWarning = (data?: QueueWarningData) => {
      if (data && 'level' in data) {
        setQueueWarning(data);
        if (data.level === 'circuit_breaker') {
          setSyncToast({ show: true, message: data.message, type: 'error' });
        } else if (data.level === 'critical') {
          setSyncToast({ show: true, message: data.message, type: 'warning' });
        }
      }
    };
    
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setSyncQueueStatus(syncQueueService.getQueueStatus());
      }
    };
    
    unsubscribers.push(syncQueueService.on('syncStart', handleSyncStart));
    unsubscribers.push(syncQueueService.on('syncSuccess', handleSyncSuccess));
    unsubscribers.push(syncQueueService.on('syncError', handleSyncError));
    unsubscribers.push(syncQueueService.on('queueChanged', handleQueueChanged));
    unsubscribers.push(syncQueueService.on('queueWarning', handleQueueWarning));
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        setSyncQueueStatus(syncQueueService.getQueueStatus());
      }
    }, 30000);
    
    return () => {
      unsubscribers.forEach(unsub => unsub());
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(interval);
    };
  }, []);

  const handleSaveUser = async () => {
    if (!urlInput.trim() || !keyInput.trim() || !userNameInput.trim()) {
      setLoginError('请填写完整的配置信息');
      return;
    }
    
    setLoginLoading(true);
    setLoginError('');
    
    try {
      const result = await supabaseService.configure(
        urlInput.trim(),
        keyInput.trim(),
        userNameInput.trim()
      );
      
      if (result.success) {
        updateSettings({ ...settings, userName: userNameInput.trim() });
        await refreshConfig();
      } else {
        setLoginError(result.message);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : '配置失败，请检查网络连接';
      setLoginError(errorMessage);
    } finally {
      setLoginLoading(false);
    }
  };

  const resetDatabase = async () => {
    if (!window.confirm('确定要重置本地数据库吗？这将清除所有本地数据！')) return;
    try {
      const DBDeleteReq = indexedDB.deleteDatabase('D3S_Database');
      DBDeleteReq.onsuccess = async () => {
        setDbError(null);
        setSyncMessage('本地数据库已重置，请刷新页面');
        setTimeout(() => window.location.reload(), 1000);
      };
      DBDeleteReq.onerror = () => {
        setSyncMessage('数据库重置失败');
      };
    } catch (error: unknown) {
      console.error('数据库重置失败:', error);
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      setSyncMessage(`重置失败：${errorMessage}`);
    }
  };

  const renderConfigView = () => (
    <div className="flex flex-col items-center justify-center min-h-[80vh] px-4 w-full max-w-md mx-auto">
      <div className="w-full space-y-6">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-2">欢迎使用每日三句</h2>
          <p className="text-gray-600 text-sm">请配置云端连接以同步您的专属数据</p>
        </div>
        
        {(configError || loginError) && (
          <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm animate-fade-in border border-red-100">
            <div className="flex items-start gap-2">
              <span className="text-lg">⚠️</span>
              <div>
                <p className="font-bold">配置错误</p>
                <p className="text-xs mt-1">{configError || loginError}</p>
              </div>
            </div>
          </div>
        )}
        
        <div className="space-y-4">
          {/* Supabase URL */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Supabase Project URL
            </label>
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              placeholder="https://your-project.supabase.co"
            />
          </div>
          
          {/* API Key */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Supabase Anonymous Key
            </label>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              placeholder="sb_publishable_..."
            />
          </div>
          
          {/* 用户名 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">用户名</label>
            <input
              type="text"
              value={userNameInput}
              onChange={(e) => setUserNameInput(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              placeholder="请输入您的用户名"
            />
            <p className="text-[10px] text-gray-600 mt-1">
              用于在云端隔离您的学习数据
            </p>
          </div>
          
          <button
            onClick={handleSaveUser}
            disabled={loginLoading || !urlInput.trim() || !keyInput.trim() || !userNameInput.trim()}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold shadow-lg hover:shadow-xl transition-all active:scale-95 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {loginLoading ? '连接中...' : '登录'}
          </button>
        </div>
        
        {/* 配置说明 */}
        <div className="p-3 bg-blue-50 rounded-lg text-sm text-blue-700">
          <p className="font-medium">配置说明：</p>
          <ul className="mt-1 space-y-1 text-xs">
            <li>• 从 <a href="https://supabase.com" target="_blank" rel="noreferrer" className="underline">Supabase</a> 获取项目URL和API Key</li>
            <li>• 用户名用于区分不同用户的数据</li>
            <li>• 配置成功后即可使用云端同步功能</li>
          </ul>
        </div>
        
        <div className="text-center pt-4">
          <p className="text-[10px] text-gray-600">
            数据将加密存储在云端 · 支持多设备同步
          </p>
        </div>
      </div>
    </div>
  );

  const renderView = () => {
    if (isLoading) return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-12 h-12 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
        <p className="text-[10px] font-black text-gray-600 uppercase tracking-widest">Loading Data...</p>
      </div>
    );

    if (dbError) return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-4 w-full max-w-md mx-auto space-y-6">
        <div className="text-center space-y-4">
          <div className="text-red-500 text-6xl">⚠️</div>
          <h2 className="text-xl font-bold text-gray-900">数据库初始化失败</h2>
          <p className="text-gray-600 text-sm">{dbError}</p>
        </div>
        <button onClick={resetDatabase} className="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-3 px-6 rounded-xl transition-colors">
          重置本地数据库
        </button>
      </div>
    );

    if (!isConfigured) return renderConfigView();

    return (
      <Suspense fallback={
        <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
          <div className="w-12 h-12 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
          <p className="text-[10px] font-black text-gray-600 uppercase tracking-widest">Loading Module...</p>
        </div>
      }>
        {(() => {
          switch (currentView) {
            case 'study': return <StudyPage sentences={sentences} onUpdate={refreshSentences} />;
            case 'manage': return <ManagePage sentences={sentences} onUpdate={refreshSentences} />;
            case 'achievements': return <AchievementPage sentences={sentences} />;
            case 'settings': return <SettingsPage sentencesCount={sentences.length} onConfigUpdate={refreshSentences} />;
            default: return <StudyPage sentences={sentences} onUpdate={refreshSentences} />;
          }
        })()}
      </Suspense>
    );
  };

  return (
    <div className="min-h-screen text-[#1d1d1f] flex flex-col items-center transition-colors duration-500 overflow-hidden" style={{ backgroundColor: settings.themeColor }}>
      {/* 顶部提示条 */}
      {syncMessage && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-green-500 text-white text-[10px] font-black uppercase tracking-widest py-1 text-center safe-area-top animate-fade-in">
          {syncMessage}
        </div>
      )}
      {!isOnline && !syncMessage && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-orange-500 text-white text-[10px] font-black uppercase tracking-widest py-1 text-center safe-area-top animate-fade-in">
          当前处于离线模式 - 数据仅在本地保存
        </div>
      )}
      {isSyncing && !syncMessage && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-blue-500 text-white text-[10px] font-black uppercase tracking-widest py-1 text-center safe-area-top flex items-center justify-center gap-2 animate-fade-in">
          <div className="w-2 h-2 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          正在同步...
        </div>
      )}

      {/* Sync Toast */}
      {syncToast.show && (
        <div className={`fixed bottom-20 left-4 right-4 z-[100] px-4 py-2 rounded-xl text-sm font-medium shadow-lg animate-fade-in flex items-center justify-between ${
          syncToast.type === 'success' ? 'bg-green-500 text-white' :
          syncToast.type === 'error' ? 'bg-red-500 text-white' :
          syncToast.type === 'warning' ? 'bg-orange-500 text-white' :
          'bg-blue-500 text-white'
        }`}>
          <span>{syncToast.message}</span>
          {syncQueueStatus.pendingCount > 0 && (
            <span className="ml-2 px-2 py-0.5 bg-white/20 rounded-full text-xs">
              {syncQueueStatus.pendingCount} 待同步
            </span>
          )}
        </div>
      )}

      {/* Queue Warning Banner */}
      {queueWarning && queueWarning.level !== 'safe' && (
        <div className={`fixed top-0 left-0 right-0 z-[100] text-white text-[10px] font-black uppercase tracking-widest py-1 text-center safe-area-top animate-fade-in ${
          queueWarning.level === 'circuit_breaker' ? 'bg-red-600' :
          queueWarning.level === 'critical' ? 'bg-orange-500' :
          'bg-yellow-500'
        }`}>
          {queueWarning.message}
          <span className="ml-2 px-2 py-0.5 bg-white/20 rounded-full text-xs normal-case">
            {queueWarning.count} 条待同步
          </span>
        </div>
      )}

      {/* Header */}
      {isConfigured && (
        <header className="fixed top-0 left-0 right-0 h-16 sm:h-20 bg-white/80 backdrop-blur-2xl z-40 border-b border-black/[0.03] px-4 sm:px-8 flex items-center justify-between transition-all duration-300 safe-area-top">
          <div className="flex flex-col">
            <span className="text-[9px] sm:text-[11px] font-black text-blue-600 uppercase tracking-[0.2em] leading-none mb-1">D3S Platform</span>
            <h1 className="text-lg sm:text-xl font-extrabold tracking-tight">每日三句</h1>
          </div>
          
          {/* Desktop Navigation */}
          <div className="hidden md:flex absolute left-1/2 -translate-x-1/2">
             <Navbar currentView={currentView} setView={setView} />
          </div>

          <div className="flex items-center gap-3">
             <div className="flex flex-col items-end mr-1">
                <span className="text-[9px] font-black text-gray-600 uppercase tracking-widest">{settings.userName}</span>
                <span className={`text-[8px] font-bold ${supabaseService.isReady ? 'text-green-500' : 'text-gray-600'}`}>
                  {supabaseService.isReady ? 'SYNC ON' : 'LOCAL ONLY'}
                </span>
             </div>
             <div className="w-8 h-8 sm:w-10 sm:h-10 bg-gray-100 rounded-full flex items-center justify-center border border-white shadow-sm">
                <span className="text-xs sm:text-sm">👤</span>
             </div>
          </div>
        </header>
      )}

      {/* Main Content */}
      <main className="w-full max-w-5xl mx-auto px-4 pt-20 pb-28 sm:pt-28 sm:pb-12 h-full overflow-y-auto custom-scrollbar">
        <div className="w-full h-full">
           {renderView()}
        </div>
      </main>

      {/* Mobile Bottom Nav */}
      {isConfigured && (
        <div className="md:hidden fixed bottom-6 left-4 right-4 z-50 safe-area-bottom">
          <Navbar currentView={currentView} setView={setView} />
        </div>
      )}
    </div>
  );
};

export default MainLayout;
