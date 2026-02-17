import React, { useState, useEffect, useCallback } from 'react';
import { storageService } from '../services/storageService';
import { supabaseService, SyncResult } from '../services/supabaseService';
import { UserSettings } from '../types';

// 🔴 统一配置KEY（和App.tsx保持一致）
const STORAGE_CONFIG_KEY = 'supabase_config_with_username';
// 提示消息自动消失时长
const MESSAGE_DURATION = 3000;

interface SettingsPageProps {
  sentencesCount: number;
}

const SettingsPage: React.FC<SettingsPageProps> = ({ sentencesCount }) => {
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
    return { url: '', key: '' };
  });

  // 同步状态管理
  const [isSyncReady, setIsSyncReady] = useState(supabaseService.isReady);
  const [loading, setLoading] = useState<boolean>(false);
  // 🔴 新增：内联提示消息（替代alert，体验更好）
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  // 🔴 优化：实时同步supabase状态，添加防抖
  const updateSyncStatus = useCallback(() => {
    setIsSyncReady(supabaseService.isReady);
  }, []);

  // 🔴 优化：监听supabase状态变化（组件挂载/更新时检查）
  useEffect(() => {
    // 初始检查
    updateSyncStatus();
    
    // 定期检查状态（防止App.tsx配置后页面状态不同步）
    const statusCheckTimer = setInterval(updateSyncStatus, 2000);
    
    // 组件卸载时清理定时器
    return () => {
      clearInterval(statusCheckTimer);
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

  // 🔴 优化：保存同步配置（统一KEY+完善错误处理+内联提示）
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
        updateSyncStatus(); // 更新同步状态
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
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-700 pb-20">
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

      {/* Local Settings */}
      <div className="space-y-4">
        <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.3em] ml-6">本地外观</h3>
        <div className="apple-card p-10 space-y-6">
           <div className="flex flex-col gap-4">
              <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-2">用户昵称</label>
              <input 
                type="text" 
                value={settings.userName} 
                onChange={(e) => handleUpdate('userName', e.target.value)}
                className="text-xl font-black text-gray-900 bg-gray-50 rounded-2xl px-6 py-4 border-none focus:ring-2 focus:ring-blue-100 placeholder-gray-300"
                placeholder="你的名字（用于云同步数据隔离）"
                disabled={loading}
              />
           </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <h3 className="text-[11px] font-black text-red-400 uppercase tracking-[0.3em] ml-6">危险区域</h3>
        <div className="apple-card p-10 border border-red-100 bg-red-50/30">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
            <div>
              <h4 className="text-sm font-black text-red-600 uppercase tracking-tight">重置所有本地数据</h4>
              <p className="text-[11px] text-red-400 font-medium mt-1 leading-relaxed">
                这将删除您在本设备上的所有句子库、学习统计、积分以及设置。如果未开启云同步，数据将无法恢复。
              </p>
            </div>
            <button 
              onClick={handleClearAllData}
              disabled={loading}
              className="bg-red-500 text-white px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg shadow-red-200 active:scale-95 transition-all whitespace-nowrap"
              style={{ opacity: loading ? 0.7 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
            >
              清空全部数据
            </button>
          </div>
        </div>
      </div>

      <div className="text-center pt-8 pb-12 opacity-30">
        <p className="text-[9px] font-black text-gray-400 uppercase tracking-[0.4em]">Hybrid-Storage Engine v5.0 (Supabase-Powered)</p>
      </div>
    </div>
  );
};

export default SettingsPage;