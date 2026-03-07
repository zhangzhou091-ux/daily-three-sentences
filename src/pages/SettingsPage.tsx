import React, { useState, useEffect, useCallback } from 'react';
import { storageService } from '../services/storage';
import { supabaseService } from '../services/supabaseService';
import { syncQueueService } from '../services/syncQueueService';
import { UserSettings } from '../types';
import EnvCheckPanel from '../components/EnvCheckPanel';
import SupabaseConfigPanel from '../components/SupabaseConfigPanel';

// 🔴 统一配置KEY（和App.tsx保持一致）
const STORAGE_CONFIG_KEY = 'supabase_config_with_username';
// 提示消息自动消失时长
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

  // 🔴 优化：实时同步supabase状态，添加防抖
  const updateSyncStatus = useCallback(() => {
    setIsSyncReady(supabaseService.isReady);
  }, []);

  useEffect(() => {
    updateSyncStatus();
    
    const statusCheckTimer = setInterval(updateSyncStatus, 2000);
    
    const queueInterval = setInterval(() => {
      setSyncQueueStatus(syncQueueService.getQueueStatus());
    }, 1000);
    
    return () => {
      clearInterval(statusCheckTimer);
      clearInterval(queueInterval);
    };
  }, [updateSyncStatus]);

  // 更新设置
  const handleUpdate = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings(prev => {
      const newSettings = { ...prev, [key]: value };
      // 如果修改的是用户名，同步更新Supabase配置
      if (key === 'userName' && isSyncReady) {
        supabaseService.setUserName(value as string);
      }
      return newSettings;
    });
  };

  // 保存设置到本地
  useEffect(() => {
    storageService.saveSettings(settings);
    document.body.style.backgroundColor = settings.themeColor;
  }, [settings]);

  // 🔴 优化：自动关闭提示消息
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), MESSAGE_DURATION);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // 配置成功回调
  const handleConfigSuccess = () => {
    setMessage({ text: '✅ Supabase配置成功！', type: 'success' });
    updateSyncStatus();
    onConfigUpdate?.();
  };

  // 配置错误回调
  const handleConfigError = (errorMessage: string) => {
    setMessage({ text: errorMessage, type: 'error' });
  };

  // 清空数据
  const handleClearAllData = async () => {
    const confirmed = window.confirm(
      '⚠️ 警告：这将永久删除本地所有句子、学习进度和账号配置。此操作无法撤销，确定要继续吗？'
    );
    if (!confirmed || loading) return;

    setLoading(true);
    try {
      await storageService.clearAllData();
      supabaseService.clearConfig();
      // 重置本地设置
      setSettings(storageService.getSettings());
      updateSyncStatus(); // 更新同步状态
      setMessage({ text: '已成功清空所有本地数据', type: 'success' });
    } catch (err: any) {
      console.error('清空数据失败:', err);
      setMessage({ text: `清空失败：${err.message}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  // 断开同步
  const handleDisconnectSync = () => {
    if (loading) return;
    
    try {
      supabaseService.clearConfig();
      updateSyncStatus();
      setMessage({ text: '已断开云同步，仅使用本地数据', type: 'info' });
    } catch (err: any) {
      setMessage({ text: `断开失败：${err.message}`, type: 'error' });
    }
  };

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-700 pb-20 max-w-4xl mx-auto">
      {/* 🔴 新增：内联提示消息 */}
      {message && (
        <div 
          className={`fixed top-20 left-1/2 -translate-x-1/2 z-50 px-6 py-2 rounded-full text-sm font-bold ${
            message.type === 'success' ? 'bg-green-500 text-white' :
            message.type === 'error' ? 'bg-red-500 text-white' :
            'bg-blue-500 text-white'
          } animate-fade-in`}
        >
          {message.text}
        </div>
      )}

      <div className="px-2">
        <h2 className="text-3xl font-black tracking-tight text-gray-900 leading-tight">设置与云同步</h2>
        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest mt-1">Manage your local data and cloud sync</p>
      </div>

      {/* Cloud Sync Section */}
      <div className="apple-card p-10 space-y-8 bg-blue-600 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-20 -mt-20"></div>
        <div className="relative z-10">
          <h3 className="text-xl font-black mb-2 flex items-center gap-2">
            <span>☁️</span> 云端自动同步
          </h3>
          <p className="text-white/70 text-xs font-medium mb-8 leading-relaxed">
            连接 Supabase 实现手机与电脑间的数据即时同步。支持离线优先，网络恢复后自动补登。
          </p>

          {/* 新的Supabase配置面板 */}
          <div className="bg-white/10 rounded-2xl p-6 backdrop-blur-sm">
            <SupabaseConfigPanel 
              onConfigSuccess={handleConfigSuccess}
              onConfigError={handleConfigError}
            />
          </div>
        </div>
      </div>

      {/* Grid Layout for Desktop */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-8">
          {/* Local Settings */}
          <div className="space-y-2">
            <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.2em] ml-2">本地外观</h3>
            <div className="apple-card p-6 space-y-4">
              <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">用户昵称</label>
                  <input 
                    type="text" 
                    value={settings.userName} 
                    onChange={(e) => handleUpdate('userName', e.target.value)}
                    className="text-lg font-bold text-gray-900 bg-gray-50 rounded-xl px-4 py-3 border-none focus:ring-2 focus:ring-blue-100 placeholder-gray-300 w-full"
                    placeholder="你的名字（用于云同步数据隔离）"
                    disabled={loading}
                  />
              </div>
            </div>
          </div>

          {/* 环境诊断面板 - 在设置页面显示更详细的信息 */}
          <div className="space-y-2">
            <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.2em] ml-2">环境诊断</h3>
            <EnvCheckPanel />
          </div>

          {/* Daily Target Settings */}
          <div className="space-y-2">
            <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.2em] ml-2">每日目标</h3>
            <div className="apple-card p-6 space-y-6">
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-center">
                   <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">每日学习</label>
                   <span className="text-xs font-bold text-blue-500">{settings.dailyLearnTarget === 999 ? '不限' : `${settings.dailyLearnTarget}个`}</span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[3, 5, 8, 999].map(val => (
                    <button
                      key={val}
                      onClick={() => handleUpdate('dailyLearnTarget', val)}
                      className={`py-2 rounded-lg text-xs font-bold transition-all ${
                        settings.dailyLearnTarget === val
                          ? 'bg-blue-500 text-white shadow-md'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {val === 999 ? '∞' : val}
                    </button>
                  ))}
                </div>
              </div>
              
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-center">
                   <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">每日复习</label>
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
           {/* Sync Status Panel */}
          {isSyncReady && (
            <div className="space-y-2">
              <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.2em] ml-2">同步状态</h3>
              <div className="apple-card p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-gray-50 rounded-2xl p-4 text-center">
                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">待同步</p>
                    <p className={`text-2xl font-black ${syncQueueStatus.pendingCount > 0 ? 'text-orange-500' : 'text-green-500'}`}>
                      {syncQueueStatus.pendingCount}
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-2xl p-4 text-center">
                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">状态</p>
                    <p className={`text-sm font-bold ${syncQueueStatus.isSyncing ? 'text-blue-500' : 'text-green-500'}`}>
                      {syncQueueStatus.isSyncing ? '同步中' : '已同步'}
                    </p>
                  </div>
                </div>
                
                {syncQueueStatus.lastSyncTime && (
                  <div className="flex justify-between text-[10px] text-gray-400 px-1">
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
                    onClick={async () => {
                      const result = await syncQueueService.syncNow();
                      if (result.success) {
                        setMessage({ text: '同步成功', type: 'success' });
                      } else {
                        setMessage({ text: result.message, type: 'error' });
                      }
                    }}
                    disabled={syncQueueStatus.isSyncing || syncQueueStatus.pendingCount === 0}
                    className="bg-blue-500 text-white py-2.5 rounded-xl text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-600 transition-colors"
                  >
                    立即同步
                  </button>
                  <button
                    onClick={() => {
                      syncQueueService.clearError();
                      setSyncQueueStatus(syncQueueService.getQueueStatus());
                    }}
                    disabled={!syncQueueStatus.lastSyncError}
                    className="bg-gray-100 text-gray-600 py-2.5 rounded-xl text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-200 transition-colors"
                  >
                    清除错误
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Logout Section */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.2em] ml-2">账户</h3>
        <div className="apple-card p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-black text-gray-700 uppercase tracking-tight">退出登录</h4>
              <p className="text-[10px] text-gray-400 font-medium mt-1 leading-relaxed max-w-md">
                断开云端连接，返回登录界面。本地数据将保留。
              </p>
            </div>
            <button 
              onClick={() => {
                if (window.confirm('确定要退出登录吗？您需要重新输入配置信息才能继续使用云同步。')) {
                  supabaseService.clearConfig();
                  window.location.reload();
                }
              }}
              disabled={loading}
              className="bg-gray-500 text-white px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-gray-200 active:scale-95 transition-all whitespace-nowrap hover:bg-gray-600"
            >
              退出登录
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
                永久删除本地所有句子、学习统计和设置。
              </p>
            </div>
            <button 
              onClick={handleClearAllData}
              disabled={loading}
              className="bg-red-500 text-white px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-red-200 active:scale-95 transition-all whitespace-nowrap hover:bg-red-600"
              style={{ opacity: loading ? 0.7 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
            >
              清空数据
            </button>
        </div>
      </div>

      <div className="text-center pt-8 pb-12 opacity-30">
        <p className="text-[9px] font-black text-gray-400 uppercase tracking-[0.4em]">Hybrid-Storage Engine v5.0 (Supabase-Powered)</p>
      </div>
    </div>
  );
};

export default SettingsPage;