import React, { useState, useEffect } from 'react';
import { supabaseService } from '../services/supabaseService';

interface SupabaseConfigPanelProps {
  onConfigSuccess?: () => void;
  onConfigError?: (message: string) => void;
}

const SupabaseConfigPanel: React.FC<SupabaseConfigPanelProps> = ({ 
  onConfigSuccess, 
  onConfigError 
}) => {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [userName, setUserName] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 加载已保存的配置
  useEffect(() => {
    const config = supabaseService.getConfig();
    if (config.url) setUrl(config.url);
    if (config.key) setKey(config.key);
    if (config.userName) setUserName(config.userName);
  }, []);

  const showMessage = (text: string, type: 'success' | 'error' | 'info') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 3000);
  };

  const handleConfigure = async () => {
    if (!url || !key || !userName) {
      showMessage('请填写完整的配置信息', 'error');
      return;
    }

    setLoading(true);
    try {
      const result = await supabaseService.configure(url, key, userName);
      
      if (result.success) {
        showMessage(result.message, 'success');
        onConfigSuccess?.();
      } else {
        showMessage(result.message, 'error');
        onConfigError?.(result.message);
      }
    } catch (error) {
      const errorMessage = '配置失败，请检查网络连接和配置信息';
      showMessage(errorMessage, 'error');
      onConfigError?.(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleClearConfig = () => {
    supabaseService.clearConfig();
    setUrl('');
    setKey('');
    setUserName('');
    showMessage('配置已清除', 'info');
  };

  const config = supabaseService.getConfig();

  return (
    <div className="space-y-4">
      {/* 配置表单 */}
      <div className="apple-card p-6 bg-white border border-gray-200 rounded-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-900">Supabase 云端配置</h3>
          <div className="flex items-center gap-2">
            <span className={`px-2 py-1 text-xs font-medium rounded-full ${
              config.isConfigured 
                ? 'bg-green-100 text-green-800' 
                : 'bg-red-100 text-red-800'
            }`}>
              {config.isConfigured ? '✅ 已连接' : '❌ 未连接'}
            </span>
          </div>
        </div>

        <div className="space-y-4">
          {/* Supabase URL */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Supabase Project URL
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-project.supabase.co"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* API Key */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Supabase Anonymous Key
            </label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sb_publishable_..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* 用户名 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              用户名（用于数据隔离）
            </label>
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="请输入用户名"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* 高级选项 */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              {showAdvanced ? '▼' : '▶'} 高级选项
            </button>
            
            {showAdvanced && (
              <div className="mt-2 p-3 bg-gray-50 rounded-md text-sm text-gray-600">
                <p>• 配置信息将保存在浏览器本地存储中</p>
                <p>• 支持多用户数据隔离</p>
                <p>• 清除配置将删除所有云端连接信息</p>
              </div>
            )}
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-3">
            <button
              onClick={handleConfigure}
              disabled={loading || !url || !key || !userName}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {loading ? '配置中...' : '保存配置'}
            </button>
            
            {config.isConfigured && (
              <button
                onClick={handleClearConfig}
                className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
              >
                清除配置
              </button>
            )}
          </div>
        </div>

        {/* 配置说明 */}
        <div className="mt-4 p-3 bg-blue-50 rounded-md text-sm text-blue-700">
          <p className="font-medium">配置说明：</p>
          <ul className="mt-1 space-y-1">
            <li>• 从 <a href="https://supabase.com" target="_blank" className="underline">Supabase</a> 获取项目URL和API Key</li>
            <li>• 用户名用于区分不同用户的数据</li>
            <li>• 配置成功后即可使用云端同步功能</li>
          </ul>
        </div>
      </div>

      {/* 状态消息 */}
      {message && (
        <div className={`p-3 rounded-md text-sm ${
          message.type === 'success' ? 'bg-green-100 text-green-700' :
          message.type === 'error' ? 'bg-red-100 text-red-700' :
          'bg-blue-100 text-blue-700'
        }`}>
          {message.text}
        </div>
      )}

      {/* 当前配置状态 */}
      {config.isConfigured && (
        <div className="p-4 bg-green-50 border border-green-200 rounded-md">
          <h4 className="font-medium text-green-800 mb-2">当前配置状态</h4>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-green-600">URL:</span>
              <div className="font-mono text-xs truncate" title={config.url}>
                {config.url}
              </div>
            </div>
            <div>
              <span className="text-green-600">Key:</span>
              <div className="font-mono text-xs">
                {config.key ? '••••••••' + config.key.slice(-8) : '未设置'}
              </div>
            </div>
            <div>
              <span className="text-green-600">用户:</span>
              <div className="font-medium">{config.userName}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SupabaseConfigPanel;