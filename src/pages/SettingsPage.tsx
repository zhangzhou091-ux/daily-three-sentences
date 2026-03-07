import React, { useState, useEffect, useCallback } from 'react';
import { storageService } from '../services/storage';
import { supabaseService, SyncResult } from '../services/supabaseService';
import { syncQueueService } from '../services/syncQueueService';
import { UserSettings } from '../types';
import EnvCheckPanel from '../components/EnvCheckPanel';

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
  // 🔴 读取统一的配置KEY，兼容旧配置
  const [syncConfig, setSyncConfig] = useState(() => {
    // 优先读取新配置，兼容旧配置
    const newConfig = localStorage.getItem(STORAGE_CONFIG_KEY);
    const oldConfig = localStorage.getItem('d3s_sync_config');
    
    if (newConfig) {
      const { url, key } = JSON.parse(newConfig);
      return { url, key };
    } else if (oldConfig) {
      return JSON.parse(oldConfig);
    }
    // 如果没有本地配置，尝试使用环境变量
    return { 
      url: import.meta.env.VITE_SUPABASE_URL || '', 
      key: import.meta.env.VITE_SUPABASE_ANON_KEY || '' 
    };
  });

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

  // 🔴 优化：用户昵称修改后，同步更新本地配置的用户名
  const handleUpdate = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings(prev => {
      const newSettings = { ...prev, [key]: value };
      // 如果修改的是用户名，同步更新本地存储的配置
      if (key === 'userName' && isSyncReady) {
        const savedConfig = localStorage.getItem(STORAGE_CONFIG_KEY);
        if (savedConfig) {
          const config = JSON.parse(savedConfig);
          localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify({
            ...config,
            name: value as string
          }));
        }
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

  // 🔴 优化：保存同步配置（统一KEY+完善错误处理+内联提示+配置验证）
  const handleSaveSyncConfig = async () => {
    // 前置校验
    if (!settings.userName) {
      setMessage({ text: '请先填写用户昵称后再配置同步！', type: 'error' });
      return;
    }
    if (!syncConfig.url || !syncConfig.key) {
      setMessage({ text: '请填写完整的Supabase URL和Anon Key！', type: 'error' });
      return;
    }
    
    // 验证 URL 格式
    let parsedUrl;
    try {
      parsedUrl = new URL(syncConfig.url);
      if (parsedUrl.protocol !== 'https:') {
        setMessage({ text: '❌ Supabase URL 必须使用 HTTPS 协议', type: 'error' });
        return;
      }
    } catch {
      setMessage({ text: '❌ Supabase URL 格式无效', type: 'error' });
      return;
    }
    
    // 验证 Key 格式（基本检查）
    if (syncConfig.key.length < 20) {
      setMessage({ text: '❌ Supabase Key 长度无效（应 ≥ 20 字符）', type: 'error' });
      return;
    }
    
    if (isSyncReady) {
      setMessage({ text: '✅ 云同步已激活，无需重复配置！', type: 'info' });
      return;
    }
    if (loading) return;

    setLoading(true);
    try {
      // 保存到统一的配置KEY
      localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify({
        url: syncConfig.url,
        key: syncConfig.key,
        name: settings.userName
      }));
      // 移除旧配置，避免冲突
      localStorage.removeItem('d3s_sync_config');
      
      const initResult: SyncResult = await supabaseService.init(
        syncConfig.url, 
        syncConfig.key, 
        settings.userName
      );

      if (initResult.success) {
        setMessage({ text: initResult.message, type: 'success' });
        updateSyncStatus();
        if (onConfigUpdate) {
          onConfigUpdate();
        }
      } else {
        setMessage({ text: `配置失败：${initResult.message}`, type: 'error' });
      }
    } catch (err: any) {
      console.error('初始化异常:', err);
      setMessage({ 
        text: `配置异常：${err.message || '请检查网络或Supabase配置'}`, 
        type: 'error' 
      });
    } finally {
      setLoading(false);
    }
  };

  // 🔴 优化：清空数据（更安全的错误处理+状态重置）
  const handleClearAllData = async () => {
    const confirmed = window.confirm(
      '⚠️ 警告：这将永久删除本地所有句子、学习进度和账号配置。此操作无法撤销，确定要继续吗？'
    );
    if (!confirmed || loading) return;

    setLoading(true);
    try {
      await storageService.clearAllData();
      supabaseService.clearConfig();
      // 清空配置状态
      setSyncConfig({ url: '', key: '' });
      localStorage.removeItem(STORAGE_CONFIG_KEY);
      localStorage.removeItem('d3s_sync_config');
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

  // 🔴 优化：断开同步（更安全的状态处理）
  const handleDisconnectSync = () => {
    if (loading) return;
    
    try {
      supabaseService.clearConfig();
      setSyncConfig({ url: '', key: '' });
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

          {!isSyncReady ? (
            <div className="space-y-4">
              <input 
                type="text" 
                placeholder="Supabase Project URL" 
                value={syncConfig.url} 
                onChange={e => setSyncConfig({ ...syncConfig, url: e.target.value })}
                className="w-full bg-white/10 border border-white/20 rounded-2xl px-6 py-4 outline-none placeholder:text-white/30 text-sm font-bold"
                disabled={loading}
              />
              <input 
                type="password" 
                placeholder="Anon Key" 
                value={syncConfig.key} 
                onChange={e => setSyncConfig({ ...syncConfig, key: e.target.value })}
                className="w-full bg-white/10 border border-white/20 rounded-2xl px-6 py-4 outline-none placeholder:text-white/30 text-sm font-bold"
                disabled={loading}
              />
              <button 
                onClick={handleSaveSyncConfig}
                disabled={loading}
                className="w-full bg-white text-blue-600 py-4 rounded-2xl font-black text-sm shadow-xl active:scale-95 transition-all"
                style={{ opacity: loading ? 0.7 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
              >
                {loading ? '配置中...' : '连接数据库'}
              </button>
              <p className="text-[10px] text-white/50 text-center uppercase tracking-widest">
                请在 Supabase 控制台获取 API 信息 | 数据将按【用户昵称】隔离
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-6 py-4">
              <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center text-2xl backdrop-blur-xl">☁️</div>
              <div className="text-center">
                <p className="font-black">云同步已激活</p>
                <p className="text-white/80 font-bold mt-1">当前同步用户：{settings.userName}</p>
                <p className="text-[10px] text-white/60 uppercase tracking-widest mt-1">Data is safe and up to date</p>
              </div>
              <button 
                onClick={handleDisconnectSync}
                disabled={loading}
                className="text-xs font-black text-white/50 uppercase tracking-widest hover:text-white transition-colors"
              >
                断开云同步
              </button>
            </div>
          )}
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