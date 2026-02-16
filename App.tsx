
import React, { useState, useEffect } from 'react';
import { ViewType, Sentence } from './types';
import Navbar from './components/Navbar';
import StudyPage from './pages/StudyPage';
import ManagePage from './pages/ManagePage';
import AchievementPage from './pages/AchievementPage';
import SettingsPage from './pages/SettingsPage';
import { storageService } from './services/storageService';
import { supabaseService } from './services/supabaseService';

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewType>('study');
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [settings, setSettings] = useState(storageService.getSettings());
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isLoading, setIsLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const initApp = async () => {
      storageService.initSync();
      
      // 离线优先：先加载本地数据渲染
      const localData = await storageService.getSentences();
      setSentences(localData);
      setIsLoading(false);

      // 后台同步
      if (navigator.onLine && supabaseService.isReady) {
        setSyncing(true);
        try {
          await storageService.performFullSync();
          const syncedData = await storageService.getSentences();
          setSentences(syncedData);
        } catch (e) {
          console.error("Sync failed", e);
        } finally {
          setSyncing(false);
        }
      }
    };
    initApp();

    const handleOnline = () => {
      setIsOnline(true);
      storageService.performFullSync().then(refreshSentences);
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const refreshSentences = async () => {
    const data = await storageService.getSentences();
    setSentences(data);
  };

  const renderView = () => {
    if (isLoading) return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-12 h-12 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Database Syncing...</p>
      </div>
    );

    switch (currentView) {
      case 'study': return <StudyPage sentences={sentences} onUpdate={refreshSentences} />;
      case 'manage': return <ManagePage sentences={sentences} onUpdate={refreshSentences} />;
      case 'achievements': return <AchievementPage sentences={sentences} />;
      case 'settings': return <SettingsPage sentencesCount={sentences.length} />;
      default: return <StudyPage sentences={sentences} onUpdate={refreshSentences} />;
    }
  };

  return (
    <div className="min-h-screen text-[#1d1d1f] flex flex-col items-center transition-colors duration-500 overflow-hidden" style={{ backgroundColor: settings.themeColor }}>
      
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-orange-500 text-white text-[10px] font-black uppercase tracking-widest py-1 text-center safe-area-top">
          当前处于离线模式 - 数据仅在本地保存
        </div>
      )}

      {syncing && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-blue-500 text-white text-[10px] font-black uppercase tracking-widest py-1 text-center safe-area-top flex items-center justify-center gap-2">
          <div className="w-2 h-2 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          正在云端同步数据...
        </div>
      )}

      <header className="fixed top-0 left-0 right-0 h-20 bg-white/80 backdrop-blur-2xl z-40 border-b border-black/[0.03] px-8 flex items-center justify-between pointer-events-none sm:pointer-events-auto safe-area-top">
        <div className="flex flex-col">
          <span className="text-[11px] font-black text-blue-600 uppercase tracking-[0.2em] leading-none mb-1">D3S Platform</span>
          <h1 className="text-xl font-extrabold tracking-tight">每日三句</h1>
        </div>
        <div className="hidden sm:block">
           <Navbar currentView={currentView} setView={setCurrentView} />
        </div>
        <div className="flex items-center gap-3">
           <div className="flex flex-col items-end mr-1">
              <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest">{settings.userName}</span>
              <span className={`text-[8px] font-bold ${supabaseService.isReady ? 'text-green-500' : 'text-gray-300'}`}>
                {supabaseService.isReady ? 'SYNC ON' : 'LOCAL ONLY'}
              </span>
           </div>
           <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center border border-white">
              <span className="text-sm">👤</span>
           </div>
        </div>
      </header>

      <main className="w-full max-w-screen-sm px-4 pt-24 pb-32 sm:pt-32 sm:pb-12 h-full overflow-y-auto custom-scrollbar">
        <div className="w-full">
           {renderView()}
        </div>
      </main>

      <div className="sm:hidden fixed bottom-8 left-1/2 -translate-x-1/2 w-full max-w-[380px] px-4 z-50 safe-area-bottom">
        <Navbar currentView={currentView} setView={setCurrentView} />
      </div>
    </div>
  );
};

export default App;
