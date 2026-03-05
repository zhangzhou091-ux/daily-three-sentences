import React, { ErrorInfo, ReactNode } from 'react';

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
};

class ErrorBoundaryImpl extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  render(): ReactNode {
    const { hasError, error, errorInfo } = this.state;
    const { fallback, children } = this.props;
    
    if (hasError) {
      if (fallback) {
        return fallback;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
          <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center space-y-6">
            <div className="text-6xl">😵</div>
            <h1 className="text-2xl font-bold text-gray-900">出现了一些问题</h1>
            <p className="text-gray-500 text-sm">
              应用遇到了意外错误，请尝试刷新页面。如果问题持续存在，请清除浏览器缓存后重试。
            </p>
            {error && (
              <details className="text-left bg-gray-100 rounded-lg p-4 text-xs text-gray-600 overflow-auto max-h-40">
                <summary className="cursor-pointer font-medium text-gray-700 mb-2">错误详情</summary>
                <pre className="whitespace-pre-wrap break-all">{error.toString()}</pre>
                {errorInfo && (
                  <pre className="mt-2 whitespace-pre-wrap break-all text-gray-500">
                    {errorInfo.componentStack}
                  </pre>
                )}
              </details>
            )}
            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleReset}
                className="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
              >
                刷新页面
              </button>
              <button
                onClick={() => {
                  localStorage.clear();
                  indexedDB.deleteDatabase('D3S_Database');
                  this.handleReset();
                }}
                className="px-6 py-3 bg-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-300 transition-colors"
              >
                清除数据并刷新
              </button>
            </div>
          </div>
        </div>
      );
    }

    return children;
  }
}

const ErrorBoundary: React.FC<ErrorBoundaryProps> = (props) => 
  React.createElement(ErrorBoundaryImpl, props);

export { ErrorBoundary };
