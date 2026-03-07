import React from 'react';
import { SUPABASE_CONFIG } from '../constants';

const EnvTestPage: React.FC = () => {
  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-3xl font-black mb-8 text-center">环境变量诊断</h1>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="apple-card p-6 bg-blue-600 text-white">
            <h2 className="text-xl font-black mb-4 flex items-center gap-2">
              <span>☁️</span> Supabase 配置
            </h2>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-blue-200 text-xs uppercase tracking-widest mb-1">Project URL</p>
                <p className={`font-mono break-all ${SUPABASE_CONFIG.URL?.includes('enaovozvdpivbhjoetkp') ? 'text-white' : 'text-blue-200/50'}`}>
                  {SUPABASE_CONFIG.URL || '❌ 未设置'}
                </p>
              </div>
              <div>
                <p className="text-blue-200 text-xs uppercase tracking-widest mb-1">API Key</p>
                <div className="flex items-center gap-2">
                  <span className={`font-bold ${SUPABASE_CONFIG.KEY ? 'text-white' : 'text-blue-200/50'}`}>
                    {SUPABASE_CONFIG.KEY ? '✅ 已配置' : '❌ 未配置'}
                  </span>
                  {SUPABASE_CONFIG.KEY && (
                    <span className="text-xs bg-white/20 px-2 py-0.5 rounded">
                      {SUPABASE_CONFIG.KEY.length} 字符
                    </span>
                  )}
                </div>
              </div>
              <div>
                <p className="text-blue-200 text-xs uppercase tracking-widest mb-1">配置状态</p>
                <div className="flex gap-2">
                  <span className={`px-3 py-1 rounded-full text-xs font-bold ${SUPABASE_CONFIG.URL && SUPABASE_CONFIG.KEY ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>
                    {SUPABASE_CONFIG.URL && SUPABASE_CONFIG.KEY ? '✅ 完整' : '❌ 不完整'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="apple-card p-6">
            <h2 className="text-xl font-black mb-4 text-gray-900">开发环境</h2>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between items-center">
                <span className="text-gray-500 uppercase tracking-widest text-xs">运行模式</span>
                <span className="font-bold text-blue-600">{import.meta.env.MODE || 'default'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500 uppercase tracking-widest text-xs">开发环境</span>
                <span className={`px-2 py-1 rounded text-xs font-bold ${import.meta.env.DEV ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                  {import.meta.env.DEV ? '✅ 是' : '❌ 否'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500 uppercase tracking-widest text-xs">生产环境</span>
                <span className={`px-2 py-1 rounded text-xs font-bold ${import.meta.env.PROD ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                  {import.meta.env.PROD ? '✅ 是' : '❌ 否'}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="apple-card p-6 bg-yellow-50 border border-yellow-200">
            <h2 className="text-xl font-black mb-4 text-yellow-900 flex items-center gap-2">
              <span>⚠️</span> 如果看到这个页面
            </h2>
            <div className="space-y-3 text-sm text-yellow-800">
              <p>说明你正在访问测试页面。请检查以下内容：</p>
              <ol className="list-decimal list-inside space-y-2 ml-1">
                <li>
                  <strong>环境变量文件</strong>
                  <p className="ml-1 mt-1 text-xs font-mono bg-yellow-100 p-2 rounded">
                    VITE_SUPABASE_URL=https://enaovozvdpivbhjoetkp.supabase.co
                    <br/>
                    VITE_SUPABASE_ANON_KEY=sb_publishable_XSSE5uw_UPFDXLQIUEv9MA_TB-ZAdfu
                  </p>
                </li>
                <li>
                  <strong>重启开发服务器</strong>
                  <p className="ml-1 mt-1 text-xs">
                    停止当前服务器 (Ctrl+C)，然后运行:
                    <br/>
                    <code className="bg-yellow-100 px-1 rounded">npm run dev</code>
                  </p>
                </li>
                <li>
                  <strong>检查控制台</strong>
                  <p className="ml-1 mt-1 text-xs">
                    打开浏览器控制台 (F12)，应该看到:
                    <br/>
                    <code className="bg-yellow-100 px-1 rounded">✅ Supabase 客户端初始化成功</code>
                  </p>
                </li>
              </ol>
            </div>
          </div>

          <div className="apple-card p-6 bg-green-50 border border-green-200">
            <h2 className="text-xl font-black mb-4 text-green-900 flex items-center gap-2">
              <span>✅</span> 预期结果
            </h2>
            <div className="space-y-3 text-sm text-green-800">
              <p>正确配置后，你应该看到：</p>
              <ul className="list-disc list-inside space-y-2 ml-1">
                <li>控制台显示 <code className="bg-green-100 px-1 rounded">✅ Supabase 客户端初始化成功</code></li>
                <li>SettingsPage 显示 "云同步已激活"</li>
                <li>顶部导航显示 "SYNC ON"</li>
                <li>可以正常同步数据</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 text-center">
        <a 
          href="/settings" 
          className="inline-block px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-sm transition-all shadow-lg"
        >
          返回设置页面
        </a>
      </div>
    </div>
  );
};

export default EnvTestPage;
