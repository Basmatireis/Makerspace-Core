import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FeatureFlags } from '@carbon/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { setReauthenticationHandler } from './api/http-client';
import { queryClient } from './api/query-client';
import { App } from './app/App';
import { SessionEventHandler } from './features/auth/auth';
import { BrandingProvider } from './features/branding/branding';
import './styles/index.scss';

// The "Confirm it's you" dialog is only needed when an operation asks for a fresh sign-in, so it loads on demand.
setReauthenticationHandler((request) =>
  import('./features/auth/mfa/promptReauthentication').then(({ promptReauthentication }) =>
    promptReauthentication(request),
  ),
);

const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <>
        <SessionEventHandler />
        <App />
      </>
    ),
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
