
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css'; // Import Tailwind CSS
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

import { performanceMonitor } from './utils/performanceMonitor';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// ✅ 性能监控：标记应用开始渲染
performanceMonitor.mark('appStart');

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// ✅ 性能监控：标记应用渲染完成
performanceMonitor.mark('appRendered');
performanceMonitor.measure('appInitialization', 'appStart', 'appRendered');

if (import.meta.env.DEV) {
  const metrics = performanceMonitor.getSummary();
  console.log('📊 性能监控摘要:', metrics);
}
