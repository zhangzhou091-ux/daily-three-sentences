import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import { storageService } from '../services/storage';
import { supabaseService } from '../services/supabaseService';
import { syncQueueService } from '../services/syncQueueService';
import { geminiService } from '../services/geminiService';
import { elevenLabsService, ElevenLabsVoice } from '../services/elevenLabsService';
import { elevenLabsCacheService } from '../services/elevenLabsCacheService';
import { kokoroTtsService, KokoroVoice } from '../services/kokoroTtsService';
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
  const [webSpeechVoices, setWebSpeechVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [testVoiceName, setTestVoiceName] = useState<string>('');
  const [elevenLabsVoices, setElevenLabsVoices] = useState<ElevenLabsVoice[]>(elevenLabsService.getPopularVoices());
  const [elevenLabsKeyValidating, setElevenLabsKeyValidating] = useState(false);
  const [elevenLabsKeyStatus, setElevenLabsKeyStatus] = useState<'idle' | 'valid' | 'invalid'>('idle');
  const [showElevenLabsKey, setShowElevenLabsKey] = useState(false);
  const [elevenLabsCacheStats, setElevenLabsCacheStats] = useState<{ count: number; totalSize: number } | null>(null);
  const [kokoroVoices] = useState<KokoroVoice[]>(kokoroTtsService.getVoices());
  const [kokoroCacheStats, setKokoroCacheStats] = useState<{ count: number; totalSize: number } | null>(null);
  const [kokoroModelStatus, setKokoroModelStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const isSyncingRef = useRef(false);
  const isResettingRef = useRef(false);
  const prevUserNameRef = useRef<string>(settings.userName);
  const clearConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const isSyncing = syncQueueStatus.isSyncing;

  const loadAllEnglishVoices = (voices: SpeechSynthesisVoice[]) => {
    const enVoices = voices.filter(v => v.lang.startsWith('en'));
    enVoices.sort((a, b) => {
      if (a.localService !== b.localService) return a.localService ? -1 : 1;
      const aUs = a.lang === 'en-US' || a.lang === 'en_US' ? 0 : 1;
      const bUs = b.lang === 'en-US' || b.lang === 'en_US' ? 0 : 1;
      return aUs - bUs;
    });
    setWebSpeechVoices(enVoices);
  };

  const triggerVoiceListLoad = () => {
    const utterance = new SpeechSynthesisUtterance(' ');
    utterance.volume = 0;
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    const loadVoices = async () => {
      try {
        // iOS需要先触发一次合成才会加载完整语音列表
        triggerVoiceListLoad();
        const voices = await geminiService.getAvailableVoices();
        loadAllEnglishVoices(voices);
      } catch {
        setWebSpeechVoices([]);
      }
    };
    loadVoices();

    const handleVoicesChanged = () => {
      const voices = window.speechSynthesis.getVoices();
      loadAllEnglishVoices(voices);
    };
    window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
  }, []);

  const handleTestVoice = useCallback(async () => {
    geminiService.stop();
    setTestVoiceName('');
    try {
      const engineInfo = geminiService.getCurrentEngineInfo();
      const voiceName = engineInfo.voiceName || '默认';
      setTestVoiceName(`${engineInfo.engine} - ${voiceName}`);
      await geminiService.speak('Hello, this is a voice test. How are you doing today?', undefined, false);
    } catch {
      setTestVoiceName('播放失败');
    }
  }, [settings.ttsEngine, settings.elevenLabsApiKey, settings.elevenLabsVoiceId]);

  const handleValidateElevenLabsKey = useCallback(async (apiKey: string) => {
    if (!apiKey || !apiKey.trim()) {
      setElevenLabsKeyStatus('idle');
      return;
    }
    setElevenLabsKeyValidating(true);
    try {
      const result = await elevenLabsService.validateApiKey(apiKey);
      if (result.valid) {
        setElevenLabsKeyStatus('valid');
        const voices = await elevenLabsService.fetchVoices(apiKey);
        setElevenLabsVoices(voices);
      } else {
        setElevenLabsKeyStatus('invalid');
        setMessage({ text: `密钥验证失败：${result.error}`, type: 'error' });
      }
    } catch {
      setElevenLabsKeyStatus('invalid');
    } finally {
      setElevenLabsKeyValidating(false);
    }
  }, []);

  const loadElevenLabsCacheStats = useCallback(async () => {
    try {
      const stats = await elevenLabsCacheService.getStats();
      setElevenLabsCacheStats({ count: stats.count, totalSize: stats.totalSize });
    } catch {
      setElevenLabsCacheStats(null);
    }
  }, []);

  const handleClearElevenLabsCache = useCallback(async () => {
    const count = await elevenLabsCacheService.clearAll();
    setElevenLabsCacheStats(null);
    setMessage({ text: `已清理 ${count} 条音频缓存`, type: 'success' });
  }, []);

  const loadKokoroCacheStats = useCallback(async () => {
    try {
      const stats = await kokoroTtsService.getCacheStats();
      setKokoroCacheStats({ count: stats.count, totalSize: stats.totalSize });
    } catch {
      setKokoroCacheStats(null);
    }
  }, []);

  const handleClearKokoroCache = useCallback(async () => {
    const count = await kokoroTtsService.clearCache();
    setKokoroCacheStats(null);
    setMessage({ text: `已清理 ${count} 条 Kokoro 音频缓存`, type: 'success' });
  }, []);

  const handleLoadKokoroModel = useCallback(async () => {
    setKokoroModelStatus('loading');
    const result = await kokoroTtsService.loadModel();
    setKokoroModelStatus(result.loaded ? 'loaded' : 'error');
    if (result.loaded) {
      setMessage({ text: 'Kokoro 模型加载成功', type: 'success' });
    } else {
      setMessage({ text: `模型加载失败: ${result.error}`, type: 'error' });
    }
  }, []);

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
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">TTS 引擎</label>
                <select
                  value={settings.ttsEngine || 'elevenlabs'}
                  onChange={(e) => handleUpdate('ttsEngine', e.target.value as 'elevenlabs' | 'kokoro' | 'webSpeech')}
                  className="text-sm font-bold text-gray-900 bg-gray-50 rounded-xl px-4 py-3 border-none focus:ring-2 focus:ring-blue-100 w-full cursor-pointer"
                  disabled={loading}
                >
                  <option value="elevenlabs">ElevenLabs (最高质量，缓存后不消耗额度)</option>
                  <option value="kokoro">Kokoro-82M (本地运行，免费无限使用)</option>
                  <option value="webSpeech">浏览器原生语音 (无需下载)</option>
                </select>
                <p className="text-[10px] text-gray-500">ElevenLabs 音质最佳；Kokoro 本地运行免费无限；浏览器原生无需下载模型</p>
              </div>
              {settings.ttsEngine === 'elevenlabs' && (
                <div className="space-y-4 p-4 bg-gradient-to-br from-purple-50 to-indigo-50 rounded-2xl">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm">🎙️</span>
                    <h4 className="text-xs font-black text-indigo-700 uppercase tracking-widest">ElevenLabs 配置</h4>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">API 密钥</label>
                      <div className="flex items-center gap-2">
                        {elevenLabsKeyStatus === 'valid' && (
                          <span className="text-[10px] font-bold text-green-600 bg-green-100 px-2 py-0.5 rounded-full">✓ 已验证</span>
                        )}
                        {elevenLabsKeyStatus === 'invalid' && (
                          <span className="text-[10px] font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded-full">✗ 无效</span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          type={showElevenLabsKey ? 'text' : 'password'}
                          value={settings.elevenLabsApiKey || ''}
                          onChange={(e) => {
                            handleUpdate('elevenLabsApiKey', e.target.value);
                            setElevenLabsKeyStatus('idle');
                          }}
                          className="text-sm font-mono text-gray-900 bg-white rounded-xl px-4 py-3 border border-gray-200 focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 w-full pr-10"
                          placeholder="输入你的 ElevenLabs API 密钥"
                          disabled={loading}
                        />
                        <button
                          type="button"
                          onClick={() => setShowElevenLabsKey(!showElevenLabsKey)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          {showElevenLabsKey ? '🙈' : '👁️'}
                        </button>
                      </div>
                      <button
                        onClick={() => handleValidateElevenLabsKey(settings.elevenLabsApiKey || '')}
                        disabled={elevenLabsKeyValidating || !settings.elevenLabsApiKey}
                        className="px-4 py-3 bg-indigo-500 text-white rounded-xl text-xs font-bold hover:bg-indigo-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        {elevenLabsKeyValidating ? '验证中...' : '验证'}
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-500">
                      在 <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="text-indigo-500 underline">elevenlabs.io</a> 创建 API 密钥，免费套餐每月有配额
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">ElevenLabs 语音</label>
                    <select
                      value={settings.elevenLabsVoiceId || 'JBFqnCBsd6RMkjVDRZzb'}
                      onChange={(e) => handleUpdate('elevenLabsVoiceId', e.target.value)}
                      className="text-sm font-bold text-gray-900 bg-white rounded-xl px-4 py-3 border border-gray-200 focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 w-full cursor-pointer"
                      disabled={loading}
                    >
                      <optgroup label="推荐语音">
                        {elevenLabsVoices.filter(v =>
                          ['JBFqnCBsd6RMkjVDRZzb', 'cjVigY5qzO86Huf0OWal', 'onwK4e9ZLuTAKqWW03F9', 'ThT5KcBeYPX3keUQqHPh'].includes(v.voice_id)
                        ).map(v => (
                          <option key={v.voice_id} value={v.voice_id}>
                            {v.name} {v.labels?.gender === 'male' ? '♂' : v.labels?.gender === 'female' ? '♀' : ''} {v.labels?.accent ? `(${v.labels.accent})` : ''}
                          </option>
                        ))}
                      </optgroup>
                      {elevenLabsVoices.length > 4 && (
                        <optgroup label="更多语音">
                          {elevenLabsVoices.filter(v =>
                            !['JBFqnCBsd6RMkjVDRZzb', 'cjVigY5qzO86Huf0OWal', 'onwK4e9ZLuTAKqWW03F9', 'ThT5KcBeYPX3keUQqHPh'].includes(v.voice_id)
                          ).map(v => (
                            <option key={v.voice_id} value={v.voice_id}>
                              {v.name} {v.labels?.gender === 'male' ? '♂' : v.labels?.gender === 'female' ? '♀' : ''} {v.labels?.accent ? `(${v.labels.accent})` : ''}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <p className="text-[10px] text-gray-500">
                      {elevenLabsVoices.length <= 10
                        ? '验证 API 密钥后可加载你的自定义语音'
                        : `已加载 ${elevenLabsVoices.length} 个可用语音`
                      }
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">音频缓存</label>
                      <button
                        onClick={loadElevenLabsCacheStats}
                        className="text-[10px] font-bold text-indigo-500 hover:text-indigo-700 transition-colors"
                      >
                        🔄 刷新统计
                      </button>
                    </div>
                    <div className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-200">
                      <div>
                        {elevenLabsCacheStats ? (
                          <p className="text-sm font-bold text-gray-900">
                            {elevenLabsCacheStats.count} 条缓存 · {elevenLabsCacheService.formatSize(elevenLabsCacheStats.totalSize)}
                          </p>
                        ) : (
                          <p className="text-sm text-gray-400">点击刷新查看缓存统计</p>
                        )}
                      </div>
                      <button
                        onClick={handleClearElevenLabsCache}
                        disabled={!elevenLabsCacheStats || elevenLabsCacheStats.count === 0}
                        className="text-[10px] font-bold text-red-500 hover:text-red-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        清理缓存
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-500">
                      已朗读的音频会自动缓存到本地，再次朗读相同内容不消耗 API 额度
                    </p>
                  </div>
                </div>
              )}
              {settings.ttsEngine === 'kokoro' && (
                <div className="space-y-4 p-4 bg-gradient-to-br from-emerald-50 to-teal-50 rounded-2xl">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm">🤖</span>
                    <h4 className="text-xs font-black text-emerald-700 uppercase tracking-widest">Kokoro-82M 配置</h4>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">模型状态</label>
                      <div className="flex items-center gap-2">
                        {kokoroModelStatus === 'loaded' && (
                          <span className="text-[10px] font-bold text-green-600 bg-green-100 px-2 py-0.5 rounded-full">✓ 已加载</span>
                        )}
                        {kokoroModelStatus === 'loading' && (
                          <span className="text-[10px] font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">⏳ 加载中...</span>
                        )}
                        {kokoroModelStatus === 'error' && (
                          <span className="text-[10px] font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded-full">✗ 加载失败</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleLoadKokoroModel}
                        disabled={kokoroModelStatus === 'loading'}
                        className="flex-1 text-sm font-bold text-white bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-300 rounded-xl px-4 py-2 transition-colors"
                      >
                        {kokoroModelStatus === 'loading' ? '加载中...' : kokoroModelStatus === 'loaded' ? '重新加载模型' : '加载模型 (~82MB)'}
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-500">
                      首次加载需下载约 82MB 模型文件，后续自动缓存。支持 WebGPU 加速和 WASM 兼容模式。
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">Kokoro 语音</label>
                    <select
                      value={settings.kokoroVoice || 'af_heart'}
                      onChange={(e) => handleUpdate('kokoroVoice', e.target.value)}
                      className="text-sm font-bold text-gray-900 bg-gray-50 rounded-xl px-4 py-3 border-none focus:ring-2 focus:ring-emerald-100 w-full cursor-pointer"
                      disabled={loading}
                    >
                      <optgroup label="🇺🇸 美式英语 - 女声（推荐）">
                        {kokoroVoices.filter(v => v.accent === 'american' && v.gender === 'female').map(v => (
                          <option key={v.id} value={v.id}>{v.name} ({v.id}) - 评级: {v.grade}</option>
                        ))}
                      </optgroup>
                      <optgroup label="🇺🇸 美式英语 - 男声">
                        {kokoroVoices.filter(v => v.accent === 'american' && v.gender === 'male').map(v => (
                          <option key={v.id} value={v.id}>{v.name} ({v.id}) - 评级: {v.grade}</option>
                        ))}
                      </optgroup>
                      <optgroup label="🇬🇧 英式英语 - 女声">
                        {kokoroVoices.filter(v => v.accent === 'british' && v.gender === 'female').map(v => (
                          <option key={v.id} value={v.id}>{v.name} ({v.id}) - 评级: {v.grade}</option>
                        ))}
                      </optgroup>
                      <optgroup label="🇬🇧 英式英语 - 男声">
                        {kokoroVoices.filter(v => v.accent === 'british' && v.gender === 'male').map(v => (
                          <option key={v.id} value={v.id}>{v.name} ({v.id}) - 评级: {v.grade}</option>
                        ))}
                      </optgroup>
                    </select>
                    <p className="text-[10px] text-gray-500">
                      af_heart (评级 A) 和 af_bella (评级 A-) 音质最佳
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">音频缓存</label>
                      <button
                        onClick={loadKokoroCacheStats}
                        className="text-[10px] font-bold text-emerald-500 hover:text-emerald-700 transition-colors"
                      >
                        🔄 刷新统计
                      </button>
                    </div>
                    <div className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-200">
                      <div>
                        {kokoroCacheStats ? (
                          <p className="text-sm font-bold text-gray-900">
                            {kokoroCacheStats.count} 条缓存 · {elevenLabsCacheService.formatSize(kokoroCacheStats.totalSize)}
                          </p>
                        ) : (
                          <p className="text-sm text-gray-400">点击刷新查看缓存统计</p>
                        )}
                      </div>
                      <button
                        onClick={handleClearKokoroCache}
                        disabled={!kokoroCacheStats || kokoroCacheStats.count === 0}
                        className="text-[10px] font-bold text-red-500 hover:text-red-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        清理缓存
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-500">
                      Kokoro 生成的音频会自动缓存，再次朗读相同内容直接使用缓存
                    </p>
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">浏览器原生语音</label>
                  <button
                    onClick={() => {
                      window.speechSynthesis.cancel();
                      // iOS需要先触发一次合成才会加载完整语音列表
                      triggerVoiceListLoad();
                      setTimeout(() => {
                        const voices = window.speechSynthesis.getVoices();
                        loadAllEnglishVoices(voices);
                      }, 500);
                    }}
                    className="text-[10px] font-bold text-blue-500 hover:text-blue-700 transition-colors"
                  >
                    🔄 刷新列表
                  </button>
                </div>
                <select
                  value={settings.webSpeechVoice || ''}
                  onChange={(e) => handleUpdate('webSpeechVoice', e.target.value)}
                  className="text-sm font-bold text-gray-900 bg-gray-50 rounded-xl px-4 py-3 border-none focus:ring-2 focus:ring-blue-100 w-full cursor-pointer"
                  disabled={loading}
                >
                  <option value="">自动选择（推荐）</option>
                  {webSpeechVoices.length === 0 && (
                    <option value="" disabled>加载中...</option>
                  )}
                  {webSpeechVoices.filter(v => v.localService).length > 0 && (
                    <optgroup label="📱 本地语音（已下载）">
                      {webSpeechVoices.filter(v => v.localService).map(v => (
                        <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                      ))}
                    </optgroup>
                  )}
                  {webSpeechVoices.filter(v => !v.localService).length > 0 && (
                    <optgroup label="☁️ 网络语音">
                      {webSpeechVoices.filter(v => !v.localService).map(v => (
                        <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <p className="text-[10px] text-gray-500">
                  {webSpeechVoices.length > 0 
                    ? `检测到 ${webSpeechVoices.length} 个英语语音（${webSpeechVoices.filter(v => v.localService).length} 个本地，${webSpeechVoices.filter(v => v.lang === 'en-US' || v.lang === 'en_US').length} 个美式）`
                    : '正在加载语音列表...'}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">朗读测试</label>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleTestVoice}
                    className="px-4 py-2 bg-blue-500 text-white rounded-xl text-sm font-bold hover:bg-blue-600 transition-colors"
                  >
                    🔊 试听
                  </button>
                  {testVoiceName && (
                    <span className="text-xs font-bold text-green-600 bg-green-50 px-3 py-1 rounded-full">
                      当前语音: {testVoiceName}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-gray-500">点击试听，确认当前使用的是哪个语音</p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-black text-gray-600 uppercase tracking-widest">发音速度</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 0.2, label: '0.2x', desc: '慢速' },
                    { value: 0.5, label: '0.5x', desc: '中速' },
                    { value: 1, label: '1x', desc: '正常' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleUpdate('speechRate', opt.value)}
                      className={`py-2 rounded-lg text-xs font-bold transition-all ${
                        (settings.speechRate ?? 1) === opt.value
                          ? 'bg-blue-500 text-white shadow-md'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {opt.label}
                      <span className="block text-[9px] font-normal opacity-70">{opt.desc}</span>
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-500">0.2x 适合逐词听辨，0.5x 适合跟读，1x 正常语速</p>
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