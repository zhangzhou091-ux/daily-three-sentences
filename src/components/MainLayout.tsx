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
import { supabaseService } from '../services/supabaseService';

// const SYNC_MESSAGE_DURATION = 3000; // Unused

const MainLayout: React.FC = () => {
  const { 
    currentView, setView, settings, isOnline, isConfigured, isLoading, 
    syncMessage, isSyncing, configError, updateSettings, setSyncMessage 
  } = useAppContext();
  const { sentences, refreshSentences } = useSentenceContext();
  
  const [isNavVisible, setIsNavVisible] = useState(true); // Default to true
  const [userNameInput, setUserNameInput] = useState('');
  const [syncQueueStatus, setSyncQueueStatus] = useState(syncQueueService.getQueueStatus());
  const [syncToast, setSyncToast] = useState<{ show: boolean; message: string; type: 'success' | 'error' | 'info' }>({ 
    show: false, 
    message: '', 
    type: 'info' 
  });
  const [dbError, setDbError] = useState<string | null>(null);

  // 监听同步队列状态
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];
    const toastTimeouts: ReturnType<typeof setTimeout>[] = [];
    
    const handleSyncStart = (data: { count: number }) => {
      setSyncToast({ show: true, message: `正在同步 ${data.count} 条数据...`, type: 'info' });
    };
    
    const handleSyncSuccess = (data: { count: number; message: string }) => {
      setSyncToast({ show: true, message: data.message || `成功同步 ${data.count} 条数据`, type: 'success' });
      const timeout = setTimeout(() => setSyncToast(prev => ({ ...prev, show: false })), 2000);
      toastTimeouts.push(timeout);
    };
    
    const handleSyncError = (data: { message: string }) => {
      setSyncToast({ show: true, message: data.message, type: 'error' });
      const timeout = setTimeout(() => setSyncToast(prev => ({ ...prev, show: false })), 3000);
      toastTimeouts.push(timeout);
    };
    
    const handleQueueChanged = (status: { pendingCount: number; isProcessing: boolean }) => {
      setSyncQueueStatus(status);
    };
    
    unsubscribers.push(syncQueueService.on('syncStart', handleSyncStart));
    unsubscribers.push(syncQueueService.on('syncSuccess', handleSyncSuccess));
    unsubscribers.push(syncQueueService.on('syncError', handleSyncError));
    unsubscribers.push(syncQueueService.on('queueChanged', handleQueueChanged));
    
    const interval = setInterval(() => {
      setSyncQueueStatus(syncQueueService.getQueueStatus());
    }, 5000);
    
    return () => {
      unsubscribers.forEach(unsub => unsub());
      clearInterval(interval);
      toastTimeouts.forEach(timeout => clearTimeout(timeout));
    };
  }, []);

  const handleSaveUser = () => {
    if (!userNameInput.trim()) return;
    updateSettings({ ...settings, userName: userNameInput.trim() });
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
    } catch (err: any) {
      console.error('数据库重置失败:', err);
      setSyncMessage(`重置失败：${err.message}`);
    }
  };

  const renderConfigView = () => (
    <div className="flex flex-col items-center justify-center min-h-[80vh] px-4 w-full max-w-md mx-auto">
      <div className="w-full space-y-6">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-2">欢迎使用每日三句</h2>
          <p className="text-gray-500 text-sm">请输入用户名以同步您的专属数据</p>
        </div>
        {configError && (
          <div className="p-2 bg-red-50 text-red-500 rounded text-sm animate-fade-in">
            {configError}
          </div>
        )}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">用户名</label>
            <input
              type="text"
              value={userNameInput}
              onChange={(e) => setUserNameInput(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="请输入您的用户名"
            />
          </div>
          <button
            onClick={handleSaveUser}
            className="w-full py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md"
          >
            开始使用
          </button>
        </div>
      </div>
    </div>
  );

  const renderView = () => {
    if (isLoading) return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-12 h-12 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Loading Data...</p>
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
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Loading Module...</p>
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
                <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest">{settings.userName}</span>
                <span className={`text-[8px] font-bold ${supabaseService.isReady ? 'text-green-500' : 'text-gray-300'}`}>
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
