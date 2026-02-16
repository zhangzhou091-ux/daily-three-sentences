
import React, { useState, useEffect } from 'react';
import { storageService } from '../services/storageService';
import { supabaseService } from '../services/supabaseService';
import { UserSettings } from '../types';

interface SettingsPageProps {
  sentencesCount: number;
}

const SettingsPage: React.FC<SettingsPageProps> = ({ sentencesCount }) => {
  const [settings, setSettings] = useState<UserSettings>(storageService.getSettings());
  const [syncConfig, setSyncConfig] = useState(() => {
    const data = localStorage.getItem('d3s_sync_config');
    return data ? JSON.parse(data) : { url: '', key: '' };
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLogged, setIsLogged] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabaseService.getSession().then(session => setIsLogged(!!session));
  }, []);

  const handleUpdate = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    storageService.saveSettings(settings);
    document.body.style.backgroundColor = settings.themeColor;
  }, [settings]);

  const handleSaveSyncConfig = () => {
    localStorage.setItem('d3s_sync_config', JSON.stringify(syncConfig));
    supabaseService.init(syncConfig.url, syncConfig.key);
    alert('配置已保存，请刷新应用生效');
  };

  const handleLogin = async () => {
    setLoading(true);
    try {
      const { error } = await supabaseService.signIn(email, password);
      if (error) throw error;
      setIsLogged(true);
      await storageService.performFullSync();
      alert('登录成功并已同步');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    setLoading(true);
    try {
      const { error } = await supabaseService.signUp(email, password);
      if (error) throw error;
      alert('请检查邮箱确认注册');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleClearAllData = async () => {
    const confirmed = window.confirm('⚠️ 警告：这将永久删除本地所有句子、学习进度和账号配置。此操作无法撤销，确定要继续吗？');
    if (confirmed) {
      await storageService.clearAllData();
    }
  };

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-700 pb-20">
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

          {!supabaseService.isReady ? (
            <div className="space-y-4">
              <input 
                type="text" 
                placeholder="Supabase Project URL" 
                value={syncConfig.url} 
                onChange={e => setSyncConfig({ ...syncConfig, url: e.target.value })}
                className="w-full bg-white/10 border border-white/20 rounded-2xl px-6 py-4 outline-none placeholder:text-white/30 text-sm font-bold"
              />
              <input 
                type="password" 
                placeholder="Anon Key" 
                value={syncConfig.key} 
                onChange={e => setSyncConfig({ ...syncConfig, key: e.target.value })}
                className="w-full bg-white/10 border border-white/20 rounded-2xl px-6 py-4 outline-none placeholder:text-white/30 text-sm font-bold"
              />
              <button 
                onClick={handleSaveSyncConfig}
                className="w-full bg-white text-blue-600 py-4 rounded-2xl font-black text-sm shadow-xl active:scale-95 transition-all"
              >
                连接数据库
              </button>
              <p className="text-[10px] text-white/50 text-center uppercase tracking-widest">请在 Supabase 控制台获取 API 信息</p>
            </div>
          ) : isLogged ? (
            <div className="flex flex-col items-center gap-6 py-4">
              <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center text-2xl backdrop-blur-xl">☁️</div>
              <div className="text-center">
                <p className="font-black">云同步已激活</p>
                <p className="text-[10px] text-white/60 uppercase tracking-widest mt-1">Data is safe and up to date</p>
              </div>
              <button 
                onClick={async () => { await supabaseService.signOut(); setIsLogged(false); }}
                className="text-xs font-black text-white/50 uppercase tracking-widest hover:text-white"
              >
                退出云账号
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <input 
                type="email" 
                placeholder="邮箱地址" 
                value={email} 
                onChange={e => setEmail(e.target.value)}
                className="w-full bg-white border-none rounded-2xl px-6 py-4 text-blue-900 text-sm font-bold outline-none"
              />
              <input 
                type="password" 
                placeholder="密码" 
                value={password} 
                onChange={e => setPassword(e.target.value)}
                className="w-full bg-white border-none rounded-2xl px-6 py-4 text-blue-900 text-sm font-bold outline-none"
              />
              <div className="grid grid-cols-2 gap-3">
                <button 
                  onClick={handleLogin}
                  disabled={loading}
                  className="bg-black text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest active:scale-95 transition-all disabled:opacity-50"
                >
                  {loading ? '...' : '登录同步'}
                </button>
                <button 
                  onClick={handleRegister}
                  disabled={loading}
                  className="bg-white/20 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest active:scale-95 transition-all disabled:opacity-50"
                >
                  注册新账号
                </button>
              </div>
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
                placeholder="你的名字"
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
              className="bg-red-500 text-white px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg shadow-red-200 active:scale-95 transition-all whitespace-nowrap"
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
