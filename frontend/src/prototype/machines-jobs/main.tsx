import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { PrototypeStoreProvider } from './store';
import { PrototypeApp } from './PrototypeApp';
import { SignageProvider } from './signage/SignageContext';
import '../../styles/index.scss';
import './prototype.scss';

// Development-only entry (frontend/prototype.html). It is not referenced by
// index.html, so the production build and its bundle budget are unaffected.
const router = createHashRouter([{ path: '*', element: <PrototypeApp /> }]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrototypeStoreProvider>
      <SignageProvider>
        <RouterProvider router={router} />
      </SignageProvider>
    </PrototypeStoreProvider>
  </StrictMode>,
);
