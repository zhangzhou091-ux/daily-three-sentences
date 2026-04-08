import React, { useEffect, useState } from 'react';
import { AppProvider } from './context/AppContext';
import { SyncProvider } from './context/SyncContext';
import { SentenceProvider } from './context/SentenceContext';
import MainLayout from './components/MainLayout';

interface StorageWarningData {
  type: string;
  message: string;
  details?: {
    totalSource?: number;
    totalMigrated?: number;
    truncated?: boolean;
  };
}

const StorageWarning: React.FC = () => {
  const [warning, setWarning] = useState<StorageWarningData | null>(null);

  useEffect(() => {
    const handleStorageWarning = (e: CustomEvent<StorageWarningData>) => {
      setWarning(e.detail);
    };

    window.addEventListener('d3s:storage_warning', handleStorageWarning as EventListener);
    return () => {
      window.removeEventListener('d3s:storage_warning', handleStorageWarning as EventListener);
    };
  }, []);

  if (!warning) return null;

  const isCritical = warning.type === 'storageFull' || warning.type === 'migrationError';
  const isWarning = warning.type === 'truncationWarning' || warning.type === 'migrationWarning';

  return (
    <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md p-4 rounded-lg shadow-lg border ${
      isCritical 
        ? 'bg-red-50 border-red-200' 
        : isWarning 
          ? 'bg-amber-50 border-amber-200' 
          : 'bg-blue-50 border-blue-200'
    }`}>
      <div className="flex items-start gap-3">
        <span className="text-2xl">{isCritical ? '❌' : isWarning ? '⚠️' : 'ℹ️'}</span>
        <div className="flex-1">
          <p className={`font-bold ${
            isCritical 
              ? 'text-red-800' 
              : isWarning 
                ? 'text-amber-800' 
                : 'text-blue-800'
          }`}>
            {warning.type === 'storageFull' && '存储空间不足'}
            {warning.type === 'migrationError' && '数据迁移失败'}
            {warning.type === 'truncationWarning' && '存储空间受限'}
            {warning.type === 'migrationWarning' && '数据迁移警告'}
            {warning.type === 'migrationSuccess' && '数据迁移成功'}
          </p>
          <p className={`text-sm mt-1 ${
            isCritical 
              ? 'text-red-700' 
              : isWarning 
                ? 'text-amber-700' 
                : 'text-blue-700'
          }`}>
            {warning.message}
          </p>
          {warning.details?.truncated && (
            <p className={`text-xs mt-2 ${
              isCritical 
                ? 'text-red-600' 
                : 'text-amber-600'
            }`}>
              原始数据: {warning.details.totalSource} 条，保留: {warning.details.totalMigrated} 条
            </p>
          )}
          <button 
            onClick={() => setWarning(null)}
            className={`mt-2 text-sm font-medium ${
              isCritical 
                ? 'text-red-600 hover:text-red-800' 
                : isWarning 
                  ? 'text-amber-600 hover:text-amber-800' 
                  : 'text-blue-600 hover:text-blue-800'
            }`}
          >
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <AppProvider>
      <SyncProvider>
        <SentenceProvider>
          <StorageWarning />
          <MainLayout />
        </SentenceProvider>
      </SyncProvider>
    </AppProvider>
  );
};

export default App;
