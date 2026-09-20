import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { OIDCProvidersPage } from './OIDCProvidersPage';

describe('OIDC provider secrets', () => {
  it.each([201, 500])('keeps client secrets out of mutation variables after HTTP %s', async (status) => {
    let submittedSecret: string | undefined;
    server.use(
      http.get('*/api/v1/oidc/providers', () => HttpResponse.json({ items: [] })),
      http.post('*/api/v1/oidc/providers', async ({ request }) => {
        submittedSecret = (await request.json() as { clientSecret: string }).clientSecret;
        return HttpResponse.json(status === 201 ? {} : { code: 'unavailable' }, { status });
      }),
    );
    const { queryClient } = renderRoute(<OIDCProvidersPage />, '/settings/oidc');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add provider' }));
    await user.type(screen.getByLabelText('Stable slug'), 'test-provider');
    await user.type(screen.getByLabelText('Display name'), 'Test provider');
    await user.type(screen.getByLabelText('Canonical issuer URL'), 'https://identity.example.test');
    await user.type(screen.getByLabelText('Client ID'), 'test-client');
    await user.type(screen.getByLabelText('Client secret'), 'local-test-secret');
    await user.click(screen.getByRole('button', { name: 'Save provider' }));
    if (status === 201) {
      await waitFor(() => expect(screen.queryByLabelText('Client secret')).not.toBeInTheDocument());
    } else {
      expect(await screen.findByText('Provider not saved')).toBeInTheDocument();
    }
    expect(submittedSecret).toBe('local-test-secret');
    expect(queryClient.getMutationCache().getAll().every((mutation) => mutation.state.variables === undefined)).toBe(true);
  });
});
