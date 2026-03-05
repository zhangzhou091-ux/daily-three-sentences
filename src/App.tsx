import React from 'react';
import { AppProvider } from './context/AppContext';
import { SentenceProvider } from './context/SentenceContext';
import MainLayout from './components/MainLayout';
import { ErrorBoundary } from './components/ErrorBoundary';

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <AppProvider>
        <SentenceProvider>
          <MainLayout />
        </SentenceProvider>
      </AppProvider>
    </ErrorBoundary>
  );
};

export default App;
