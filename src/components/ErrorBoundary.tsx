import React, { ErrorInfo, ReactNode, useState } from 'react';
import { captureError } from '../utils/errorReporter';

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showClearConfirm: boolean;
  showDataExport: boolean;
  recoveryStrategy: RecoveryStrategy;
  diagnosticInfo: DiagnosticInfo | null;
};

type RecoveryStrategy = 'refresh' | 'safe_clear' | 'data_export' | 'full_clear';

type DiagnosticInfo = {
  errorType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedComponents: string[];
  probableCauses: string[];
  recommendedActions: string[];
  dataRisk: 'none' | 'low' | 'medium' | 'high';
};

class ErrorBoundaryImpl extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { 
      hasError: false, 
      error: null, 
      errorInfo: null,
      showClearConfirm: false,
      showDataExport: false,
      recoveryStrategy: 'refresh',
      diagnosticInfo: null
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const diagnosticInfo = this.analyzeError(error, errorInfo);
    const recoveryStrategy = this.determineRecoveryStrategy(diagnosticInfo);
    
    this.setState({ 
      errorInfo,
      diagnosticInfo,
      recoveryStrategy 
    });
    
    captureError({
      message: error.message,
      stack: error.stack,
      level: 'error',
      context: {
        componentStack: errorInfo.componentStack,
        type: 'ReactErrorBoundary',
        diagnosticInfo,
        recoveryStrategy
      }
    });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  handleShowClearConfirm = (): void => {
    this.setState({ showClearConfirm: true });
  };

  handleHideClearConfirm = (): void => {
    this.setState({ showClearConfirm: false });
  };

  handleShowDataExport = (): void => {
    this.setState({ showDataExport: true });
  };

  handleHideDataExport = (): void => {
    this.setState({ showDataExport: false });
  };

  /**
   * 分级清理：先清缓存，保核心数据
   */
  handleSafeClear = (): void => {
    try {
      // 1. 先清理临时数据（低风险）
      this.clearTempData();
      
      // 2. 尝试刷新页面
      setTimeout(() => {
        this.handleReset();
      }, 500);
      
    } catch (error) {
      console.error('安全清理失败:', error);
      // 降级到完全清理
      this.handleFullClear();
    }
  };

  /**
   * 完全清理（最后手段）
   */
  handleFullClear = (): void => {
    // 二次确认
    if (!this.state.showClearConfirm) {
      this.handleShowClearConfirm();
      return;
    }

    try {
      // 备份关键数据
      this.backupCriticalData();
      
      // 执行清理
      localStorage.clear();
      if (indexedDB) {
        indexedDB.deleteDatabase('D3S_Database');
        indexedDB.deleteDatabase('D3S_IndexedDB');
      }
      
      // 刷新页面
      setTimeout(() => {
        this.handleReset();
      }, 1000);
      
    } catch (error) {
      console.error('完全清理失败:', error);
      this.handleReset();
    }
  };

  /**
   * 清理临时数据（不删除核心学习数据）
   */
  private clearTempData(): void {
    const keysToKeep = [
      'd3s_user_stats_v3',
      'd3s_settings_v3',
      'd3s_sync_config'
    ];
    
    // 获取所有key
    const allKeys = Object.keys(localStorage);
    
    // 只清理非核心数据
    const keysToRemove = allKeys.filter(key => 
      key.startsWith('d3s_') && !keysToKeep.includes(key)
    );
    
    keysToRemove.forEach(key => {
      localStorage.removeItem(key);
    });
    
    console.log(`🧹 安全清理完成: 保留了 ${keysToKeep.length} 个核心数据，清理了 ${keysToRemove.length} 个临时数据`);
  }

  /**
   * 备份关键数据
   */
  private backupCriticalData(): void {
    try {
      const criticalData = {
        timestamp: Date.now(),
        stats: localStorage.getItem('d3s_user_stats_v3'),
        settings: localStorage.getItem('d3s_settings_v3'),
        // 可以添加更多关键数据
      };
      
      // 保存到sessionStorage作为临时备份
      sessionStorage.setItem('d3s_emergency_backup', JSON.stringify(criticalData));
      
      console.log('✅ 关键数据已备份');
    } catch (error) {
      console.warn('数据备份失败:', error);
    }
  }

  /**
   * 导出学习数据
   */
  private exportLearningData(): void {
    try {
      // 收集所有关键学习数据
      const exportData = {
        exportTime: new Date().toISOString(),
        version: '1.1',
        appVersion: 'daily-three-sentences',
        stats: this.getParsedData('d3s_user_stats_v3'),
        settings: this.getParsedData('d3s_settings_v3'),
        sentences: this.getSentencesData(),
        dailySelection: this.getParsedData('d3s_daily_selection'),
        syncConfig: this.getParsedData('d3s_sync_config'),
        lastSyncTime: this.getParsedData('d3s_last_sync_time'),
        // 收集所有d3s前缀的数据
        allD3SData: this.getAllD3SData(),
        metadata: {
          totalItems: this.countD3SDataItems(),
          dataSize: this.calculateDataSize(),
          exportEnvironment: {
            userAgent: navigator.userAgent,
            timestamp: Date.now(),
            url: window.location.href
          }
        }
      };
      
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { 
        type: 'application/json' 
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `daily-three-sentences-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      console.log('📥 学习数据导出成功', {
        items: exportData.metadata.totalItems,
        size: exportData.metadata.dataSize
      });
    } catch (error) {
      console.error('数据导出失败:', error);
      // 降级到简单导出
      this.fallbackExport();
    }
  }

  /**
   * 获取解析后的数据
   */
  private getParsedData(key: string): any {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /**
   * 获取句子数据
   */
  private getSentencesData(): any {
    try {
      // 尝试从不同存储位置获取句子数据
      const keys = Object.keys(localStorage).filter(key => 
        key.includes('sentence') || key.includes('d3s_sentences')
      );
      
      const sentences: any = {};
      keys.forEach(key => {
        sentences[key] = this.getParsedData(key);
      });
      
      return sentences;
    } catch {
      return null;
    }
  }

  /**
   * 获取所有d3s前缀的数据
   */
  private getAllD3SData(): Record<string, any> {
    const d3sData: Record<string, any> = {};
    
    try {
      const allKeys = Object.keys(localStorage);
      const d3sKeys = allKeys.filter(key => key.startsWith('d3s_'));
      
      d3sKeys.forEach(key => {
        d3sData[key] = this.getParsedData(key);
      });
    } catch (error) {
      console.warn('获取d3s数据失败:', error);
    }
    
    return d3sData;
  }

  /**
   * 计算数据项数量
   */
  private countD3SDataItems(): number {
    try {
      const allKeys = Object.keys(localStorage);
      return allKeys.filter(key => key.startsWith('d3s_')).length;
    } catch {
      return 0;
    }
  }

  /**
   * 计算数据大小
   */
  private calculateDataSize(): string {
    try {
      let totalSize = 0;
      const allKeys = Object.keys(localStorage);
      
      allKeys.forEach(key => {
        if (key.startsWith('d3s_')) {
          const value = localStorage.getItem(key);
          totalSize += new Blob([value || '']).size;
        }
      });
      
      return `${(totalSize / 1024).toFixed(2)} KB`;
    } catch {
      return '未知';
    }
  }

  /**
   * 降级导出（基础数据）
   */
  private fallbackExport(): void {
    try {
      const basicData = {
        exportTime: new Date().toISOString(),
        version: '1.0',
        stats: localStorage.getItem('d3s_user_stats_v3'),
        settings: localStorage.getItem('d3s_settings_v3'),
        note: '这是基础数据导出，可能不包含完整的学习记录'
      };
      
      const blob = new Blob([JSON.stringify(basicData, null, 2)], { 
        type: 'application/json' 
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `daily-three-sentences-basic-backup-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      console.log('📥 基础数据导出成功');
    } catch (error) {
      console.error('基础数据导出也失败:', error);
    }
  }

  /**
   * 智能错误分析
   */
  private analyzeError(error: Error, errorInfo: ErrorInfo): DiagnosticInfo {
    const errorMessage = error.message.toLowerCase();
    const stack = error.stack || '';
    
    // 错误类型分类
    let errorType = 'unknown';
    let severity: 'low' | 'medium' | 'high' | 'critical' = 'medium';
    let dataRisk: 'none' | 'low' | 'medium' | 'high' = 'low';
    
    const affectedComponents: string[] = [];
    const probableCauses: string[] = [];
    const recommendedActions: string[] = [];
    
    // 分析错误类型
    if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
      errorType = 'network_error';
      severity = 'low';
      dataRisk = 'none';
      probableCauses.push('网络连接问题', '服务器暂时不可用');
      recommendedActions.push('检查网络连接', '稍后重试');
    } else if (errorMessage.includes('storage') || errorMessage.includes('quota')) {
      errorType = 'storage_error';
      severity = 'high';
      dataRisk = 'high';
      probableCauses.push('存储空间不足', '数据损坏');
      recommendedActions.push('导出数据备份', '清理临时数据');
    } else if (errorMessage.includes('syntax') || errorMessage.includes('parse')) {
      errorType = 'syntax_error';
      severity = 'critical';
      dataRisk = 'medium';
      probableCauses.push('代码错误', '数据格式异常');
      recommendedActions.push('刷新页面', '检查数据完整性');
    } else if (errorMessage.includes('memory') || errorMessage.includes('heap')) {
      errorType = 'memory_error';
      severity = 'high';
      dataRisk = 'medium';
      probableCauses.push('内存不足', '资源泄露');
      recommendedActions.push('关闭其他标签页', '清理浏览器缓存');
    } else {
      errorType = 'runtime_error';
      severity = 'medium';
      dataRisk = 'low';
      probableCauses.push('未知运行时错误');
      recommendedActions.push('刷新页面', '检查浏览器版本');
    }
    
    // 分析受影响的组件
    if (errorInfo.componentStack) {
      const componentMatches = errorInfo.componentStack.match(/in\s+([A-Z][A-Za-z]+)/g);
      if (componentMatches) {
        componentMatches.forEach(match => {
          const componentName = match.replace('in ', '');
          if (componentName && !affectedComponents.includes(componentName)) {
            affectedComponents.push(componentName);
          }
        });
      }
    }
    
    // 基于错误堆栈进一步分析
    if (stack.includes('StudyPage')) {
      affectedComponents.push('StudyPage');
      dataRisk = 'high';
      recommendedActions.push('导出学习进度');
    }
    
    if (stack.includes('storage') || stack.includes('localStorage')) {
      affectedComponents.push('StorageService');
      dataRisk = 'high';
      recommendedActions.push('立即备份数据');
    }
    
    return {
      errorType,
      severity,
      affectedComponents,
      probableCauses,
      recommendedActions,
      dataRisk
    };
  }

  /**
   * 确定恢复策略
   */
  private determineRecoveryStrategy(diagnosticInfo: DiagnosticInfo): RecoveryStrategy {
    const { severity, dataRisk } = diagnosticInfo;
    
    // 基于严重性和数据风险确定策略
    if (dataRisk === 'high') {
      return 'data_export'; // 高风险数据，优先导出
    }
    
    if (severity === 'critical') {
      return 'full_clear'; // 严重错误，需要完全清理
    }
    
    if (severity === 'high') {
      return 'safe_clear'; // 高严重性，安全清理
    }
    
    // 默认策略
    return 'refresh';
  }

  /**
   * 获取推荐的恢复操作
   */
  private getRecommendedActions(): string[] {
    const { diagnosticInfo, recoveryStrategy } = this.state;
    
    if (!diagnosticInfo) {
      return ['刷新页面', '检查网络连接'];
    }
    
    const baseActions = [...diagnosticInfo.recommendedActions];
    
    // 基于恢复策略添加特定建议
    switch (recoveryStrategy) {
      case 'data_export':
        baseActions.unshift('立即导出学习数据');
        break;
      case 'safe_clear':
        baseActions.unshift('执行安全清理');
        break;
      case 'full_clear':
        baseActions.unshift('完全清理（最后手段）');
        break;
      default:
        baseActions.unshift('刷新页面');
    }
    
    return baseActions.slice(0, 3); // 最多显示3条建议
  }

  render(): ReactNode {
    const { hasError, error, errorInfo, showClearConfirm, showDataExport } = this.state;
    const { fallback, children } = this.props;
    
    if (hasError) {
      if (fallback) {
        return fallback;
      }

      // 二次确认弹窗
      if (showClearConfirm) {
        return this.renderClearConfirmDialog();
      }

      // 数据导出弹窗
      if (showDataExport) {
        return this.renderDataExportDialog();
      }

      return this.renderErrorRecoveryUI();
    }

    return children;
  }

  private renderErrorRecoveryUI(): ReactNode {
    const { error, errorInfo, diagnosticInfo, recoveryStrategy } = this.state;
    const recommendedActions = this.getRecommendedActions();
    
    // 根据严重性设置UI主题
    const getThemeConfig = () => {
      if (!diagnosticInfo) return { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-800' };
      
      switch (diagnosticInfo.severity) {
        case 'critical':
          return { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-800' };
        case 'high':
          return { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-800' };
        case 'medium':
          return { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-800' };
        default:
          return { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-800' };
      }
    };
    
    const theme = getThemeConfig();
    
    return (
      <div className={`min-h-screen flex items-center justify-center ${theme.bg} p-4`}>
        <div className={`max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center space-y-6 border ${theme.border}`}>
          <div className="text-6xl">
            {diagnosticInfo?.severity === 'critical' ? '�' : 
             diagnosticInfo?.severity === 'high' ? '�🚨' : 
             diagnosticInfo?.severity === 'medium' ? '⚠️' : 'ℹ️'}
          </div>
          
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {diagnosticInfo ? `检测到${diagnosticInfo.severity === 'critical' ? '严重' : diagnosticInfo.severity === 'high' ? '高级' : ''}错误` : '应用遇到问题'}
            </h1>
            <p className="text-gray-600 text-sm mt-2">
              {diagnosticInfo ? `系统建议：${recommendedActions.join(' → ')}` : '系统检测到异常，请选择恢复方案'}
            </p>
          </div>
          
          {/* 诊断信息卡片 */}
          {diagnosticInfo && (
            <div className="text-left bg-gray-50 rounded-lg p-4 space-y-3">
              <div className="flex justify-between items-center">
                <span className="font-medium text-gray-700">错误诊断</span>
                <span className={`px-2 py-1 rounded-full text-xs font-medium ${theme.text} ${theme.bg.replace('50', '100')}`}>
                  {diagnosticInfo.severity.toUpperCase()}
                </span>
              </div>
              
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-gray-500">类型:</span>
                  <span className="ml-1 font-medium">{diagnosticInfo.errorType}</span>
                </div>
                <div>
                  <span className="text-gray-500">数据风险:</span>
                  <span className={`ml-1 font-medium ${
                    diagnosticInfo.dataRisk === 'high' ? 'text-red-600' :
                    diagnosticInfo.dataRisk === 'medium' ? 'text-orange-600' : 'text-green-600'
                  }`}>
                    {diagnosticInfo.dataRisk === 'high' ? '高风险' :
                     diagnosticInfo.dataRisk === 'medium' ? '中风险' : '低风险'}
                  </span>
                </div>
              </div>
              
              {diagnosticInfo.affectedComponents.length > 0 && (
                <div>
                  <span className="text-gray-500 text-xs">受影响组件:</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {diagnosticInfo.affectedComponents.map(comp => (
                      <span key={comp} className="px-2 py-1 bg-gray-200 rounded text-xs">
                        {comp}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          
          {/* 错误详情 */}
          {error && (
            <details className="text-left bg-gray-100 rounded-lg p-4 text-xs text-gray-600 overflow-auto max-h-40">
              <summary className="cursor-pointer font-medium text-gray-700 mb-2">错误详情</summary>
              <pre className="whitespace-pre-wrap break-all">{error.toString()}</pre>
              {errorInfo && (
                <pre className="mt-2 whitespace-pre-wrap break-all text-gray-600">
                  {errorInfo.componentStack}
                </pre>
              )}
            </details>
          )}
          
          {/* 智能推荐的操作按钮 */}
          <div className="space-y-3">
            {/* 基于恢复策略高亮推荐按钮 */}
            <button
              onClick={this.handleReset}
              className={`w-full px-6 py-3 rounded-xl font-medium transition-colors ${
                recoveryStrategy === 'refresh' 
                  ? 'bg-blue-600 text-white hover:bg-blue-700 border-2 border-blue-500' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              🔄 刷新页面{recoveryStrategy === 'refresh' && '（推荐）'}
            </button>
            
            <button
              onClick={this.handleSafeClear}
              className={`w-full px-6 py-3 rounded-xl font-medium transition-colors ${
                recoveryStrategy === 'safe_clear' 
                  ? 'bg-green-600 text-white hover:bg-green-700 border-2 border-green-500' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              🧹 安全清理{recoveryStrategy === 'safe_clear' && '（推荐）'}
            </button>
            
            <button
              onClick={this.handleShowDataExport}
              className={`w-full px-6 py-3 rounded-xl font-medium transition-colors ${
                recoveryStrategy === 'data_export' 
                  ? 'bg-purple-600 text-white hover:bg-purple-700 border-2 border-purple-500' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              📥 导出学习数据{recoveryStrategy === 'data_export' && '（推荐）'}
            </button>
            
            <button
              onClick={this.handleFullClear}
              className={`w-full px-6 py-3 rounded-xl font-medium transition-colors ${
                recoveryStrategy === 'full_clear' 
                  ? 'bg-red-600 text-white hover:bg-red-700 border-2 border-red-500' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              ⚠️ 完全清理{recoveryStrategy === 'full_clear' && '（推荐）'}
            </button>
          </div>
          
          <p className="text-xs text-gray-500">
            💡 提示：根据错误类型，系统已智能推荐最适合的恢复方案
          </p>
        </div>
      </div>
    );
  }

  private renderClearConfirmDialog(): ReactNode {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black bg-opacity-50 p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center space-y-6">
          <div className="text-6xl">⚠️</div>
          <h1 className="text-2xl font-bold text-red-600">危险操作确认</h1>
          <p className="text-gray-600 text-sm">
            此操作将<strong className="text-red-600">永久删除</strong>所有学习数据，包括：
          </p>
          <ul className="text-left text-sm text-gray-600 space-y-1">
            <li>• 所有学习进度和统计</li>
            <li>• 个人设置和配置</li>
            <li>• 历史学习记录</li>
            <li>• 无法恢复的数据</li>
          </ul>
          
          <div className="flex gap-3 justify-center">
            <button
              onClick={this.handleHideClearConfirm}
              className="px-6 py-3 bg-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-300 transition-colors"
            >
              取消
            </button>
            <button
              onClick={this.handleFullClear}
              className="px-6 py-3 bg-red-600 text-white rounded-xl font-medium hover:bg-red-700 transition-colors"
            >
              我已知晓，继续清理
            </button>
          </div>
        </div>
      </div>
    );
  }

  private renderDataExportDialog(): ReactNode {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black bg-opacity-50 p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center space-y-6">
          <div className="text-6xl">💾</div>
          <h1 className="text-2xl font-bold text-gray-900">导出学习数据</h1>
          <p className="text-gray-600 text-sm">
            导出包含您的学习进度、统计数据和设置的备份文件。
          </p>
          
          <button
            onClick={() => {
              this.exportLearningData();
              this.handleHideDataExport();
            }}
            className="w-full px-6 py-3 bg-green-600 text-white rounded-xl font-medium hover:bg-green-700 transition-colors"
          >
            下载备份文件
          </button>
          
          <button
            onClick={this.handleHideDataExport}
            className="w-full px-6 py-3 bg-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-300 transition-colors"
          >
            取消
          </button>
        </div>
      </div>
    );
  }
}

const ErrorBoundary: React.FC<ErrorBoundaryProps> = (props) => 
  React.createElement(ErrorBoundaryImpl, props);

export { ErrorBoundary };
