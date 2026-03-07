import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { performanceMonitor } from './utils/performanceMonitor';
import { checkEnv } from './services/envCheck';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

if (import.meta.env.DEV) {
  checkEnv();
}

performanceMonitor.mark('appStart');

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

performanceMonitor.mark('appRendered');
performanceMonitor.measure('appInitialization', 'appStart', 'appRendered');

if (import.meta.env.DEV) {
  const metrics = performanceMonitor.getSummary();
  console.log('📊 性能监控摘要:', metrics);
}
