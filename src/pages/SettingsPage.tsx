import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import { storageService } from '../services/storage';
import { supabaseService } from '../services/supabaseService';
import { syncQueueService } from '../services/syncQueueService';
import { UserSettings } from '../types';
import EnvCheckPanel from '../components/EnvCheckPanel';
import SupabaseConfigPanel from '../components/SupabaseConfigPanel';

const MESSAGE_DURATION = 3000;

interface SettingsPageProps {
  sentencesCount: number;
  onConfigUpdate?: () => void;
}

const SettingsPage: React.FC<SettingsPageProps> = ({ sentencesCount, onConfigUpdate }) => {
  const [settings, setSettings] = useState<UserSettings>(storageService.getSettings());
  const [isSyncReady, setIsSyncReady] = useState(supabaseService.isReady);
  const [loading, setLoading] = useState<boolean>(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [syncQueueStatus, setSyncQueueStatus] = useState(syncQueueService.getQueueStatus());
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const isSyncingRef = useRef(false);
  const isResettingRef = useRef(false);
  const prevUserNameRef = useRef<string>(settings.userName);
  const clearConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const isSyncing = syncQueueStatus.isSyncing;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribeStatus = supabaseService.onStatusChange(setIsSyncReady);
    
    const unsubscribeQueue = syncQueueService.on('queueChanged', (status) => {
      if (status && 'pendingCount' in status) {
        setSyncQueueStatus(status);
      }
    });
    
    return () => {
      unsubscribeStatus();
      unsubscribeQueue();
    };
  }, []);

  const handleUpdate = useCallback(<K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings(prev => {
      const updated = { ...prev, [key]: value };
      storageService.saveSettings(updated);
      return updated;
    });
  }, []);

  const debouncedSyncUserName = useDebouncedCallback((userName: string) => {
    if (!isMountedRef.current) return;
    if (isSyncReady) {
      supabaseService.setUserName(userName);
    }
  }, 500);

  useEffect(() => {
    if (settings.userName && settings.userName !== prevUserNameRef.current) {
      prevUserNameRef.current = settings.userName;
      if (isSyncReady && isMountedRef.current) {
        debouncedSyncUserName(settings.userName);
      }
    }
  }, [settings.userName, isSyncReady, debouncedSyncUserName]);

  useEffect(() => {
    return () => {
      debouncedSyncUserName.cancel();
    };
  }, [debouncedSyncUserName]);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => {
        if (isMountedRef.current) {
          setMessage(null);
        }
      }, MESSAGE_DURATION);
      return () => clearTimeout(timer);
    }
  }, [message]);

  useEffect(() => {
    return () => {
      if (clearConfirmTimerRef.current) {
        clearTimeout(clearConfirmTimerRef.current);
      }
      debouncedSyncUserName.cancel();
    };
  }, [debouncedSyncUserName]);

  // 配置成功回调
  const handleConfigSuccess = useCallback(() => {
    setMessage({ text: '✅ Supabase配置成功！', type: 'success' });
    onConfigUpdate?.();
  }, [onConfigUpdate]);

  // 配置错误回调
  const handleConfigError = useCallback((errorMessage: string) => {
    setMessage({ text: errorMessage, type: 'error' });
  }, []);

  // 清空数据
  const handleClearAllData = async () => {
    if (showClearConfirm) {
      if (clearConfirmTimerRef.current) {
        clearTimeout(clearConfirmTimerRef.current);
        clearConfirmTimerRef.current = null;
      }
      
      if (isResettingRef.current) {
        return;
      }
      isResettingRef.current = true;
      
      const MAX_WAIT_MS = 10000;
      const CHECK_INTERVAL_MS = 100;
      const startTime = Date.now();
      const waitAbortController = new AbortController();
      
      const waitForSyncComplete = async (): Promise<'completed' | 'timeout' | 'aborted'> => {
        while (Date.now() - startTime < MAX_WAIT_MS) {
          if (waitAbortController.signal.aborted) {
            return 'aborted';
          }
          
          const status = syncQueueService.getQueueStatus();
          
          if (!status.isSyncing && status.pendingCount === 0) {
            return 'completed';
          }
          
          await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));
        }
        
        return 'timeout';
      };
      
      if (isSyncing || syncQueueService.getQueueStatus().pendingCount > 0) {
        setMessage({ text: '正在等待同步完成...', type: 'info' });
        
        const waitResult = await waitForSyncComplete();
        
        if (waitResult === 'aborted') {
          isResettingRef.current = false;
          setShowClearConfirm(false);
          setMessage(null);
          return;
        }
        
        if (waitResult === 'timeout') {
          const currentStatus = syncQueueService.getQueueStatus();
          const pendingInfo = currentStatus.pendingCount > 0 
            ? `\n待同步操作：${currentStatus.pendingCount} 个` 
            : '';
          
          const confirmForce = window.confirm(
            `等待同步超时（${MAX_WAIT_MS / 1000}秒）。${pendingInfo}\n强制清空可能导致数据不一致。\n\n确定要强制清空吗？`
          );
          if (!confirmForce) {
            isResettingRef.current = false;
            setShowClearConfirm(false);
            setMessage(null);
            return;
          }
        }
      }
      
      const currentQueueStatus = syncQueueService.getQueueStatus();
      if (currentQueueStatus.pendingCount > 0) {
        const confirmForce = window.confirm(
          `当前有 ${currentQueueStatus.pendingCount} 个操作待同步。强制清空将丢失这些数据。\n\n确定要强制清空吗？`
        );
        if (!confirmForce) {
          isResettingRef.current = false;
          setShowClearConfirm(false);
          setMessage(null);
          return;
        }
      }
      
      waitAbortController.abort();
      
      syncQueueService.clearAll();
      
      setLoading(true);
      try {
        await storageService.clearAllData();
        supabaseService.clearConfig();
        syncQueueService.clearAll();
        setSettings(storageService.getSettings());
        const finalStatus = syncQueueService.getQueueStatus();
        setSyncQueueStatus(finalStatus);
        setMessage({ text: '已成功清空所有本地数据', type: 'success' });
        setShowClearConfirm(false);
        onConfigUpdate?.();
      } catch (error: unknown) {
        console.error('清空数据失败:', error);
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        setMessage({ text: `清空失败：${errorMessage}`, type: 'error' });
        setShowClearConfirm(false);
      } finally {
        setLoading(false);
        isResettingRef.current = false;
      }
    } else {
      setShowClearConfirm(true);
      clearConfirmTimerRef.current = setTimeout(() => {
        setShowClearConfirm(false);
      }, 3000);
    }
  };

  const handleDisconnectSync = () => {
    const confirmed = window.confirm(
      '确定要断开云同步吗？这将清除同步配置和待同步队列，页面不会刷新。您可以随时重新配置连接。'
    );
    if (!confirmed) return;
    
    try {
      supabaseService.clearConfig();
      syncQueueService.clearAll();
      setSyncQueueStatus(syncQueueService.getQueueStatus());
      setMessage({ text: '已断开云同步', type: 'info' });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      setMessage({ text: `断开失败：${errorMessage}`, type: 'error' });
    }
  };

  // 立即同步
  const handleSyncNow = async () => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    try {
      const result = await syncQueueService.syncNow();
      if (result.success) {
        setMessage({ text: '同步成功', type: 'success' });
      } else {
        setMessage({ text: result.message, type: 'error' });
      }
    } finally {
      isSyncingRef.current = false;
      setSyncQueueStatus(syncQueueService.getQueueStatus());
    }
  };

  // 清除同步错误
  const handleClearSyncError = () => {
    syncQueueService.clearError();
    setSyncQueueStatus(syncQueueService.getQueueStatus());
  };

  // 退出登录
  const handleLogout = () => {
    const confirmed = window.confirm('确定要重置账户配置吗？这将清除云同步配置并刷新页面，本地句子数据将保留。');
    if (!confirmed) return;
    
    supabaseService.clearConfig();
    window.location.reload();
  };

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-700 pb-20 max-w-4xl mx-auto">
      {/* 🔴 新增：内联提示消息 */}
      {message && (
        <div 
          className={`fixed top-20 left-1/2 -translate-x-1/2 z-50 px-6 py-2 rounded-full text-sm font-bold shadow-lg ${
            message.type === 'success' ? 'bg-green-500 text-white' :
            message.type === 'error' ? 'bg-red-500 text-white' :
            'bg-blue-500 text-white'
          }`}
          style={{
            animation: 'spring-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
          }}
        >
          {message.text}
        </div>
      )}

      <div className="px-2">
        <h2 className="text-3xl font-black tracking-tight text-gray-900 leading-tight">设置与云同步</h2>
        <p className="text-gray-600 text-xs font-bold uppercase tracking-widest mt-1">Manage your local data and cloud sync</p>
      </div>

      {/* Cloud Sync Status Banner - Only show when connected */}
      {isSyncReady && (
        <div className="rounded-[20px] bg-[#2563EB] text-white" style={{ padding: '40px 32px' }}>
          {/* 顶部信息区 */}
          <div className="flex flex-col items-start mb-8">
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 15l2-2m0 0l2 2m-2-2v4" />
              </svg>
              <h3 className="text-lg font-bold">云端自动同步</h3>
            </div>
            <p className="text-xs leading-[1.4] text-white/90 max-w-md">
              连接Supabase实现手机与电脑间的数据即时同步。支持离线优先，网络恢复后自动补登。
            </p>
          </div>

          {/* 中间核心状态区 */}
          <div className="flex flex-col items-center mb-8">
            {/* 圆形指示器 */}
            <div className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 transition-all duration-500 ${isSyncing ? 'animate-pulse scale-110' : ''}`} style={{ backgroundColor: 'rgba(147, 197, 253, 0.8)' }}>
              <svg className={`w-6 h-6 text-white ${isSyncing ? 'animate-spin' : ''}`} style={isSyncing ? { animation: 'spin 2s linear infinite' } : {}} fill="currentColor" viewBox="0 0 24 24">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
              </svg>
            </div>
            
            {/* 状态文字 */}
            <p className="text-base font-bold mb-3">云同步已激活</p>
            <p className="text-sm font-normal mb-2">当前同步用户：{supabaseService.userName || '未设置'}</p>
            <p className="text-[10px] font-normal tracking-wider uppercase text-white/80">DATA IS SAFE AND UP TO DATE</p>
          </div>

          {/* 底部操作区 */}
          <div className="flex justify-center">
            <button 
              onClick={handleDisconnectSync}
              disabled={loading}
              className="text-[13px] font-normal bg-transparent border-none text-white hover:text-[#BFDBFE] transition-colors cursor-pointer disabled:opacity-50"
            >
              断开云同步
            </button>
          </div>
        </div>
      )}

      {/* Grid Layout for Desktop */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-8">
          {/* Local Settings */}
          <div className="space-y-2">
            <h3 className="text-[11px] font-black text-gray-600 uppercase tracking-[0.2em] ml-2">本地外观</h3>
            <div className="apple-card p-6 space-y-4">
              <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">用户昵称</label>
                  <input 
                    type="text" 
                    value={settings.userName} 
                    onChange={(e) => handleUpdate('userName', e.target.value)}
                    onBlur={() => {
                      if (settings.userName && isSyncReady) {
                        debouncedSyncUserName(settings.userName);
                      }
                    }}
                    className="text-lg font-bold text-gray-900 bg-gray-50 rounded-xl px-4 py-3 border-none focus:ring-2 focus:ring-blue-100 placeholder-gray-400 w-full"
                    placeholder="你的名字（用于云同步数据隔离）"
                    disabled={loading}
                  />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">主题背景色</label>
                <div className="flex gap-2">
                  {['#f5f5f7', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'].map(color => (
                    <button
                      key={color}
                      onClick={() => handleUpdate('themeColor', color)}
                      className={`w-8 h-8 rounded-full border-2 transition-all duration-200 ${
                        settings.themeColor === color 
                          ? 'border-gray-900 scale-125 shadow-lg ring-2 ring-offset-2 ring-gray-300' 
                          : 'border-transparent hover:scale-105'
                      }`}
                      style={{ backgroundColor: color }}
                      disabled={loading}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 环境诊断面板 - 在设置页面显示更详细的信息 */}
          <div className="space-y-2">
            <h3 className="text-[11px] font-black text-gray-600 uppercase tracking-[0.2em] ml-2">环境诊断</h3>
            <EnvCheckPanel />
          </div>

          {/* Daily Target Settings */}
          <div className="space-y-2">
            <h3 className="text-[11px] font-black text-gray-600 uppercase tracking-[0.2em] ml-2">每日目标</h3>
            <div className="apple-card p-6 space-y-6">
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-center">
                   <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">每日复习</label>
                   <span className="text-xs font-bold text-green-500">{settings.dailyReviewTarget === 999 ? '不限' : `${settings.dailyReviewTarget}个`}</span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[3, 5, 8, 999].map(val => (
                    <button
                      key={val}
                      onClick={() => handleUpdate('dailyReviewTarget', val)}
                      className={`py-2 rounded-lg text-xs font-bold transition-all ${
                        settings.dailyReviewTarget === val
                          ? 'bg-green-500 text-white shadow-md'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {val === 999 ? '∞' : val}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-8">
          {/* Sync Status Panel - When connected */}
          {isSyncReady ? (
            <div className="space-y-2">
              <h3 className="text-[11px] font-black text-gray-600 uppercase tracking-[0.2em] ml-2">同步状态</h3>
              <div className="apple-card p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-gray-50 rounded-2xl p-4 text-center">
                    <p className="text-[10px] font-black text-gray-600 uppercase tracking-widest mb-1">待同步</p>
                    <p className={`text-2xl font-black ${syncQueueStatus.pendingCount > 0 ? 'text-orange-500' : 'text-green-500'}`}>
                      {syncQueueStatus.pendingCount}
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-2xl p-4 text-center">
                    <p className="text-[10px] font-black text-gray-600 uppercase tracking-widest mb-1">状态</p>
                    <p className={`text-sm font-bold ${syncQueueStatus.isSyncing ? 'text-blue-500' : 'text-green-500'}`}>
                      {syncQueueStatus.isSyncing ? '同步中' : '已同步'}
                    </p>
                  </div>
                </div>
                
                {syncQueueStatus.lastSyncTime && (
                  <div className="flex justify-between text-[10px] text-gray-600 px-1">
                    <span>上次同步</span>
                    <span>{new Date(syncQueueStatus.lastSyncTime).toLocaleTimeString('zh-CN')}</span>
                  </div>
                )}
                
                {syncQueueStatus.lastSyncError && (
                  <div className="bg-red-50 rounded-xl p-3 text-xs text-red-500 text-center">
                    {syncQueueStatus.lastSyncError}
                  </div>
                )}
                
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    onClick={handleSyncNow}
                    disabled={isSyncing || syncQueueStatus.isSyncing || syncQueueStatus.pendingCount === 0}
                    className="bg-blue-500 text-white py-2.5 rounded-xl text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-600 transition-colors"
                  >
                    {isSyncing ? '同步中...' : '立即同步'}
                  </button>
                  <button
                    onClick={handleClearSyncError}
                    disabled={!syncQueueStatus.lastSyncError}
                    className="bg-gray-100 text-gray-600 py-2.5 rounded-xl text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-200 transition-colors"
                  >
                    清除错误
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <h3 className="text-[11px] font-black text-gray-600 uppercase tracking-[0.2em] ml-2">云同步配置</h3>
              <SupabaseConfigPanel onConfigSuccess={handleConfigSuccess} onConfigError={handleConfigError} />
            </div>
          )}
        </div>
      </div>

      {/* Logout Section */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-black text-gray-600 uppercase tracking-[0.2em] ml-2">账户</h3>
        <div className="apple-card p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-black text-gray-700 uppercase tracking-tight">重置账户配置</h4>
              <p className="text-[10px] text-gray-600 font-medium mt-1 leading-relaxed max-w-md">
                清除云端连接配置并刷新页面。本地句子数据将保留，需重新配置云同步。
              </p>
            </div>
            <button 
              onClick={handleLogout}
              disabled={loading}
              className="bg-gray-500 text-white px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-gray-200 active:scale-95 transition-all whitespace-nowrap hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              重置配置
            </button>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-black text-red-400 uppercase tracking-[0.2em] ml-2">危险区域</h3>
        <div className="apple-card p-6 border border-red-100 bg-red-50/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-black text-red-600 uppercase tracking-tight">重置所有数据</h4>
              <p className="text-[10px] text-red-400 font-medium mt-1 leading-relaxed max-w-md">
                永久删除本地所有句子（共 {sentencesCount} 条）、学习统计和设置。
              </p>
              {showClearConfirm && (
                <p className="text-xs text-red-600 font-bold mt-2 animate-in fade-in duration-300">
                  ⚠️ 再次点击确认删除，3秒后自动取消
                </p>
              )}
            </div>
            <button 
              onClick={handleClearAllData}
              disabled={loading}
              className={`px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest shadow-lg active:scale-95 transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
                showClearConfirm 
                  ? 'bg-red-600 text-white hover:bg-red-700 animate-pulse' 
                  : 'bg-red-500 text-white shadow-red-200 hover:bg-red-600'
              }`}
            >
              {showClearConfirm ? '⚠️ 确认清空？' : '清空数据'}
            </button>
        </div>
      </div>

      <div className="text-center pt-8 pb-12 opacity-30">
        <p className="text-[9px] font-black text-gray-600 uppercase tracking-[0.4em]">Hybrid-Storage Engine v5.0 (Supabase-Powered)</p>
      </div>
    </div>
  );
};

export default SettingsPage;