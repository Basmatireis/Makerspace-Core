import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FeatureFlags } from '@carbon/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { queryClient } from './api/query-client';
import { App } from './app/App';
import { RouteErrorPage } from './app/RouteErrorPage';
import { SessionEventHandler } from './features/auth/auth';
import { BrandingProvider } from './features/branding/branding';
import './styles/index.scss';

const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <>
        <SessionEventHandler />
        <App />
      </>
    ),
    errorElement: <RouteErrorPage />,
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Tooltips, toggletips and dropdown menus are positioned as fixed layers, so tables, tiles and modals with
        overflow no longer clip them. */}
    <FeatureFlags enableV12DynamicFloatingStyles>
      <QueryClientProvider client={queryClient}>
        <BrandingProvider>
          <RouterProvider router={router} />
        </BrandingProvider>
      </QueryClientProvider>
    </FeatureFlags>
  </StrictMode>,
);
