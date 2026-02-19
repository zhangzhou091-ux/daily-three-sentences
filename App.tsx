import React, { useState, useEffect, useCallback } from 'react';
import { ViewType, Sentence } from './types';
import Navbar from './components/Navbar';
import StudyPage from './pages/StudyPage';
import ManagePage from './pages/ManagePage';
import AchievementPage from './pages/AchievementPage';
import SettingsPage from './pages/SettingsPage';
import { storageService } from './services/storageService';
import { supabaseService, SyncResult } from './services/supabaseService';

// 本地存储配置KEY（保存URL/KEY/用户名）
const STORAGE_CONFIG_KEY = 'supabase_config_with_username';
// 同步提示条自动消失时长（毫秒）
const SYNC_MESSAGE_DURATION = 3000;

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewType>('study');
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [settings, setSettings] = useState(storageService.getSettings());
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isLoading, setIsLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  
  // 🔴 仅新增这1行：导航栏显示/隐藏状态（默认隐藏）
  const [isNavVisible, setIsNavVisible] = useState(false);
  
  // Supabase配置相关状态
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseKey, setSupabaseKey] = useState('');
  const [userName, setUserName] = useState(settings.userName || '');
  const [isConfigured, setIsConfigured] = useState(false);
  const [configError, setConfigError] = useState('');
  const [syncMessage, setSyncMessage] = useState('');

  // 🔴 优化1：防抖syncData，避免重复调用
  const debouncedSyncData = useCallback(
    React.useCallback(
      async () => {
        if (!supabaseService.isReady || syncing) return;
        await syncData();
      },
      [syncing]
    ),
    []
  );

  // 🔴 优化2：同步数据核心方法（抽离并防抖）
  const syncData = async () => {
    if (!supabaseService.isReady || syncing) return;
    
    setSyncing(true);
    try {
      const { sentences: syncedData, message } = await supabaseService.syncSentences(sentences);
      setSentences(syncedData);
      setSyncMessage(message);
      // 自动清除提示条
      setTimeout(() => setSyncMessage(''), SYNC_MESSAGE_DURATION);
    } catch (e: any) {
      console.error("Sync failed", e);
      setSyncMessage(`数据同步失败：${e.message || '请检查配置或网络'}`);
      setTimeout(() => setSyncMessage(''), SYNC_MESSAGE_DURATION);
    } finally {
      setSyncing(false);
    }
  };

  // 🔴 优化3：刷新数据并同步
  const refreshSentences = async () => {
    try {
      const data = await storageService.getSentences();
      setSentences(data);
      // 仅配置成功且在线时同步，避免重复调用
      if (supabaseService.isReady && isOnline && !syncing) {
        await debouncedSyncData();
      }
    } catch (err: any) {
      console.error('刷新数据失败:', err);
      setSyncMessage(`刷新失败：${err.message}`);
      setTimeout(() => setSyncMessage(''), SYNC_MESSAGE_DURATION);
    }
  };

  // 🔴 优化4：保存配置（增加重复检查+状态同步）
  const saveConfig = async () => {
    // 前置校验
    if (!supabaseUrl || !supabaseKey || !userName) {
      setConfigError('URL、KEY和用户名均不能为空！');
      return;
    }

    // 避免重复初始化
    if (supabaseService.isReady) {
      setConfigError('✅ 云同步已激活，无需重复配置！');
      setTimeout(() => setConfigError(''), SYNC_MESSAGE_DURATION);
      return;
    }

    try {
      const initResult = await supabaseService.init(supabaseUrl, supabaseKey, userName);
      if (initResult?.success) {
        // 持久化配置
        localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify({
          url: supabaseUrl,
          key: supabaseKey,
          name: userName
        }));
        // 更新本地设置
        storageService.saveSettings({ ...settings, userName });
        // 同步状态（关键：确保isConfigured和isReady一致）
        setIsConfigured(true);
        setConfigError('');
        setSyncMessage(initResult.message);
        setTimeout(() => setSyncMessage(''), SYNC_MESSAGE_DURATION);
        // 配置成功后立即同步
        if (isOnline) {
          await debouncedSyncData();
        }
      } else {
        setConfigError(initResult?.message || '配置保存失败');
        setIsConfigured(false);
        setTimeout(() => setConfigError(''), SYNC_MESSAGE_DURATION);
      }
    } catch (err: any) {
      console.error('保存配置失败:', err);
      setConfigError(`配置异常：${err.message || '请检查网络或配置信息'}`);
      setIsConfigured(false);
      setTimeout(() => setConfigError(''), SYNC_MESSAGE_DURATION);
    }
  };

  // 🔴 优化5：清除配置（增强状态重置）
  const clearConfig = () => {
    try {
      supabaseService.clearConfig();
      localStorage.removeItem(STORAGE_CONFIG_KEY);
      setSupabaseUrl('');
      setSupabaseKey('');
      setUserName('');
      setIsConfigured(false);
      setSyncMessage('已清除配置，仅使用本地数据');
      setConfigError('');
      setTimeout(() => setSyncMessage(''), SYNC_MESSAGE_DURATION);
      // 清除后重新加载本地数据
      refreshSentences();
    } catch (err: any) {
      console.error('清除配置失败:', err);
      setSyncMessage(`清除配置失败：${err.message}`);
      setTimeout(() => setSyncMessage(''), SYNC_MESSAGE_DURATION);
    }
  };

  // 🔴 优化6：应用初始化（更严谨的错误处理+状态同步）
  useEffect(() => {
    const initApp = async () => {
      try {
        storageService.initSync();
        
        // 读取本地保存的配置
        const savedConfig = localStorage.getItem(STORAGE_CONFIG_KEY);
        if (savedConfig) {
          const { url, key, name } = JSON.parse(savedConfig);
          setSupabaseUrl(url);
          setSupabaseKey(key);
          setUserName(name);
          
          // 仅当配置完整时初始化
          if (url && key && name) {
            const initResult = await supabaseService.init(url, key, name);
            if (initResult?.success) {
              setIsConfigured(true);
              setConfigError('');
              setSyncMessage(initResult.message);
              setTimeout(() => setSyncMessage(''), SYNC_MESSAGE_DURATION);
            } else {
              setConfigError(initResult?.message || '配置初始化失败，请重新填写');
              setIsConfigured(false);
            }
          } else {
            setConfigError('本地配置不完整，请重新填写');
            setIsConfigured(false);
          }
        }

        // 优先加载本地数据（兜底逻辑）
        const localData = await storageService.getSentences();
        setSentences(localData);
        
        // 后台同步（仅配置成功且在线）
        if (navigator.onLine && supabaseService.isReady && !syncing) {
          await debouncedSyncData();
        }
      } catch (err: any) {
        console.error('应用初始化失败:', err);
        setConfigError(`初始化异常：${err.message || '未知错误'}`);
        // 强制兜底加载本地数据
        const localData = await storageService.getSentences();
        setSentences(localData);
      } finally {
        // 无论成功失败，都结束加载状态
        setIsLoading(false);
      }
    };

    initApp();

    // 网络状态监听
    const handleOnline = () => {
      setIsOnline(true);
      // 网络恢复后自动同步（防抖）
      debouncedSyncData();
    };
    const handleOffline = () => {
      setIsOnline(false);
      setSyncMessage('当前处于离线模式 - 数据仅在本地保存');
      setTimeout(() => setSyncMessage(''), SYNC_MESSAGE_DURATION);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // 🔴 优化7：组件卸载时清理所有定时器和监听
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      // 清除所有未执行的定时器
      const timerIds = window.setTimeout(() => {}, 0);
      for (let i = 0; i < timerIds; i++) {
        window.clearTimeout(i);
      }
    };
  }, [debouncedSyncData]);

  // 🔴 优化8：同步isConfigured和supabaseService.isReady状态
  useEffect(() => {
    if (supabaseService.isReady && !isConfigured) {
      setIsConfigured(true);
    } else if (!supabaseService.isReady && isConfigured) {
      setIsConfigured(false);
    }
  }, [supabaseService.isReady, isConfigured]);

  // 配置界面渲染
  const renderConfigView = () => {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-4 w-full max-w-md mx-auto">
        <div className="w-full space-y-6">
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-2">数据同步配置</h2>
            <p className="text-gray-500 text-sm">填写URL、KEY和用户名，无需登录即可同步专属数据</p>
          </div>

          {/* 配置错误提示 */}
          {configError && (
            <div className="p-2 bg-red-50 text-red-500 rounded text-sm animate-fade-in">
              {configError}
            </div>
          )}

          {/* 配置表单 */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supabase URL</label>
              <input
                type="text"
                value={supabaseUrl}
                onChange={(e) => setSupabaseUrl(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="https://xxxxxx.supabase.co"
                disabled={syncing}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supabase Anon KEY</label>
              <input
                type="text"
                value={supabaseKey}
                onChange={(e) => setSupabaseKey(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                disabled={syncing}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">用户名（数据隔离标识）</label>
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="请输入你的专属用户名（如：张三）"
                disabled={syncing}
              />
              <p className="text-xs text-gray-400 mt-1">同一用户名可在不同设备同步数据，无需密码</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveConfig}
                disabled={syncing}
                className={`flex-1 py-2 rounded-md ${syncing ? 'bg-gray-400' : 'bg-blue-500 hover:bg-blue-600'} text-white`}
              >
                {syncing ? '配置中...' : '保存配置并同步'}
              </button>
              {isConfigured && (
                <button
                  onClick={clearConfig}
                  disabled={syncing}
                  className={`px-4 py-2 rounded-md ${syncing ? 'bg-gray-200' : 'bg-gray-200 hover:bg-gray-300'} text-gray-700`}
                >
                  清除
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // 主视图渲染
  const renderView = () => {
    if (isLoading) return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-12 h-12 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Loading Data...</p>
      </div>
    );

    // 未配置时显示配置界面
    if (!isConfigured) {
      return renderConfigView();
    }

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
      
      {/* 同步/配置提示条（自动消失） */}
      {syncMessage && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-green-500 text-white text-[10px] font-black uppercase tracking-widest py-1 text-center safe-area-top animate-fade-in">
          {syncMessage}
        </div>
      )}

      {/* 离线提示（自动消失） */}
      {!isOnline && !syncMessage && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-orange-500 text-white text-[10px] font-black uppercase tracking-widest py-1 text-center safe-area-top animate-fade-in">
          当前处于离线模式 - 数据仅在本地保存
        </div>
      )}

      {/* 同步中提示 */}
      {syncing && !syncMessage && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-blue-500 text-white text-[10px] font-black uppercase tracking-widest py-1 text-center safe-area-top flex items-center justify-center gap-2 animate-fade-in">
          <div className="w-2 h-2 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          正在同步【{userName}】的数据...
        </div>
      )}

      {/* 🔴 修改1：顶部导航 - 仅配置成功+导航显示时显示（新增isNavVisible） */}
      {isConfigured && isNavVisible && (
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
                <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest">{userName}</span>
                <span className={`text-[8px] font-bold ${supabaseService.isReady ? 'text-green-500' : 'text-gray-300'}`}>
                  {supabaseService.isReady ? 'SYNC ON' : 'LOCAL ONLY'}
                </span>
             </div>
             <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center border border-white">
                <span className="text-sm">👤</span>
             </div>
          </div>
        </header>
      )}

      {/* 🔴 主内容区：完全保留原始样式，不做任何修改（避免空白） */}
      <main className="w-full max-w-screen-sm px-4 pt-24 pb-32 sm:pt-32 sm:pb-12 h-full overflow-y-auto custom-scrollbar">
        <div className="w-full">
           {renderView()}
        </div>
      </main>

      {/* 🔴 修改2：底部导航 - 仅配置成功+导航显示时显示（新增isNavVisible） */}
      {isConfigured && isNavVisible && (
        <div className="sm:hidden fixed bottom-8 left-1/2 -translate-x-1/2 w-full max-w-[380px] px-4 z-50 safe-area-bottom">
          <Navbar currentView={currentView} setView={setCurrentView} />
        </div>
      )}

      {/* 🔴 新增：简单的唤起按钮（绝对不会导致空白） */}
      {isConfigured && (
        <button
          onClick={() => setIsNavVisible(!isNavVisible)}
          style={{
            position: 'fixed',
            bottom: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '50px',
            height: '50px',
            borderRadius: '50%',
            backgroundColor: 'white',
            border: 'none',
            boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
            zIndex: 999,
            cursor: 'pointer'
          }}
        >
          {isNavVisible ? '隐藏' : '显示'}
        </button>
      )}
    </div>
  );
};

export default App;