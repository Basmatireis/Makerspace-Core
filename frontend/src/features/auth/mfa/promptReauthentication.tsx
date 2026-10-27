import { createRoot } from 'react-dom/client';
import { FeatureFlags } from '@carbon/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReauthenticationRequest } from '../../../api/http-client';
import { queryClient } from '../../../api/query-client';
import { ReauthenticationDialog } from './ReauthenticationDialog';

/**
 * Opens the "Confirm it's you" dialog in its own React root, so any screen's failed request can ask for a fresh
 * sign-in without that screen knowing about it. Resolves true after a successful reauthentication.
 */
export function promptReauthentication(request: ReauthenticationRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const finish = (confirmed: boolean) => {
      resolve(confirmed);
      // Unmounting while React is still rendering the dialog that called this would be a nested render.
      setTimeout(() => {
        root.unmount();
        host.remove();
      });
    };
    root.render(
      <FeatureFlags enableV12DynamicFloatingStyles>
        <QueryClientProvider client={queryClient}>
          <ReauthenticationDialog request={request} onFinish={finish} />
        </QueryClientProvider>
      </FeatureFlags>,
    );
  });
}
