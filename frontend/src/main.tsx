import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { queryClient } from './api/query-client';
import { App } from './app/App';
import { SessionEventHandler } from './features/auth/auth';
import '@carbon/charts-react/styles.css';
import './styles/index.scss';

const router = createBrowserRouter([
  { path: '*', element: <><SessionEventHandler /><App /></> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
