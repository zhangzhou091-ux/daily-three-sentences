import React, { useState, useEffect } from 'react';
import { SUPABASE_CONFIG } from '../constants';

const EnvCheckPanel: React.FC = () => {
  const [envInfo, setEnvInfo] = useState<{
    url: string;
    keySet: boolean;
    keyLength: number | null;
    mode: string;
    dev: boolean;
    prod: boolean;
  } | null>(null);

  useEffect(() => {
    setEnvInfo({
      url: SUPABASE_CONFIG.URL || '❌ 未设置',
      keySet: !!SUPABASE_CONFIG.KEY,
      keyLength: SUPABASE_CONFIG.KEY ? SUPABASE_CONFIG.KEY.length : null,
      mode: import.meta.env.MODE || 'default',
      dev: import.meta.env.DEV,
      prod: import.meta.env.PROD
    });
  }, []);

  if (!envInfo) return null;

  return (
    <div className="space-y-3">
      <div className="apple-card p-4 space-y-3 bg-blue-50 border border-blue-100">
        <div className="flex items-start gap-3">
          <div className="mt-1 text-blue-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="flex-1 space-y-2">
            <h4 className="text-xs font-black text-blue-900 uppercase tracking-widest">环境配置状态</h4>
            
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="text-blue-600/70 text-[10px] uppercase tracking-widest mb-1">Supabase URL</p>
                <p className={`font-mono text-[10px] break-all ${envInfo.url.includes('enaovozvdpivbhjoetkp') ? 'text-blue-900 font-bold' : 'text-red-600'}`}>
                  {envInfo.url}
                </p>
              </div>
              <div>
                <p className="text-blue-600/70 text-[10px] uppercase tracking-widest mb-1">API Key</p>
                <p className={`font-bold ${envInfo.keySet ? 'text-green-700' : 'text-red-600'}`}>
                  {envInfo.keySet ? '✅ 已配置' : '❌ 未配置'}
                </p>
              </div>
            </div>

            {envInfo.dev && !envInfo.keySet && (
              <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-[10px] text-yellow-800">
                <p className="font-bold mb-1">⚠️ 重要提示</p>
                <p className="mb-1">环境变量未生效，请重启开发服务器：</p>
                <code className="block bg-yellow-100 px-2 py-1 rounded font-mono text-[9px]">
                  npm run dev
                </code>
              </div>
            )}

            {envInfo.dev && envInfo.keySet && envInfo.url.includes('enaovozvdpivbhjoetkp') && (
              <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded text-[10px] text-green-800">
                <p className="font-bold">✅ 环境配置正确</p>
                <p className="text-[10px] mt-1">Supabase 客户端已初始化</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default EnvCheckPanel;
