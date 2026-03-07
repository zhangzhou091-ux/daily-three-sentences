import React from 'react';
import { SUPABASE_CONFIG } from '../constants';

const EnvTest: React.FC = () => {
  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">环境变量测试</h1>
      
      <div className="space-y-4">
        <div className="p-4 bg-blue-50 rounded-lg">
          <h2 className="font-bold text-blue-700">Supabase 配置</h2>
          <div className="mt-2 space-y-2 text-sm">
            <p><strong>URL:</strong> <code className="bg-white px-2 py-1 rounded">{SUPABASE_CONFIG.URL || '❌ 未设置'}</code></p>
            <p><strong>KEY:</strong> <code className="bg-white px-2 py-1 rounded">{SUPABASE_CONFIG.KEY ? '✅ 已设置' : '❌ 未设置'}</code></p>
            <p><strong>长度:</strong> {SUPABASE_CONFIG.KEY ? `${SUPABASE_CONFIG.KEY.length} 字符` : 'N/A'}</p>
          </div>
        </div>
        
        <div className="p-4 bg-green-50 rounded-lg">
          <h2 className="font-bold text-green-700">开发环境信息</h2>
          <div className="mt-2 space-y-2 text-sm">
            <p><strong>MODE:</strong> {import.meta.env.MODE || 'default'}</p>
            <p><strong>DEV:</strong> {import.meta.env.DEV ? '✅ 是' : '❌ 否'}</p>
            <p><strong>PROD:</strong> {import.meta.env.PROD ? '✅ 是' : '❌ 否'}</p>
            <p><strong>BASE:</strong> {import.meta.env.BASE_URL || 'N/A'}</p>
          </div>
        </div>
        
        <div className="p-4 bg-red-50 rounded-lg">
          <h2 className="font-bold text-red-700">环境变量文件 (.env.local)</h2>
          <p className="text-sm mt-2">
            请确保 .env.local 文件存在于项目根目录，并包含：
          </p>
          <pre className="mt-2 p-3 bg-gray-100 rounded text-xs overflow-x-auto">
VITE_SUPABASE_URL=https://enaovozvdpivbhjoetkp.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_XSSE5uw_UPFDXLQIUEv9MA_TB-ZAdfu
          </pre>
        </div>
      </div>
    </div>
  );
};

export default EnvTest;
