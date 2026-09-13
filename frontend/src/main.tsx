import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { queryClient } from './api/query-client';
import { App } from './app/App';
import { SessionEventHandler } from './features/auth/auth';
import './styles/index.scss';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionEventHandler />
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
