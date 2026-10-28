import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { PrivacyPage } from './PrivacyPage';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({
  authQueryKey: ['auth', 'current-user'],
  useCurrentUser: () => ({ permissions: auth.permissions }),
}));

function category(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit_events',
    name: 'Audit events',
    description: 'Who did what.',
    ownerModuleId: 'platform',
    orphaned: false,
    subject: 'person',
    fields: ['audit_events.actor_id'],
    triggers: ['created_at'],
    actions: ['delete'],
    legacyDefault: {
      trigger: 'created_at',
      periodDays: 365,
      action: 'delete',
      source: 'AUDIT_RETENTION',
      zeroDisables: true,
    },
    retentionNote: 'Kept for a year.',
    firstSeenAt: '2026-10-01T00:00:00Z',
    lastSeenAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function settingsBody(overrides: Record<string, unknown> = {}) {
  return {
    controllerName: 'HTU Makerspace',
    controllerAddress: 'Graz',
    dataProtectionContact: 'dpo@example.test',
    automaticRunsEnabled: false,
    runIntervalMinutes: 60,
    version: 4,
    updatedAt: null,
    ...overrides,
  };
}

describe('privacy settings', () => {
  beforeEach(() => {
    auth.permissions = ['privacy.read', 'privacy.settings.manage'];
    server.use(
      http.get('*/api/v1/privacy/overview', () =>
        HttpResponse.json({
          categories: 12,
          orphanedCategories: 1,
          automaticRunsEnabled: false,
        }),
      ),
      http.get('*/api/v1/privacy/settings', () => HttpResponse.json(settingsBody({ controllerName: '' }))),
      http.get('*/api/v1/privacy/categories', () =>
        HttpResponse.json({
          categories: [
            category(),
            category({
              id: 'signage_media',
              name: 'Signage media',
              ownerModuleId: 'signage',
              orphaned: true,
              subject: 'none',
              fields: ['signage_media.*'],
              legacyDefault: null,
            }),
          ],
        }),
      ),
    );
  });

  it('shows counts and the controller hint', async () => {
    renderRoute(<PrivacyPage />, '/settings/privacy');
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(await screen.findByText('Controller not named')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('lists categories with tags and filters them by search', async () => {
    const user = userEvent.setup();
    renderRoute(<PrivacyPage />, '/settings/privacy?tab=categories');
    expect(await screen.findByText('Audit events')).toBeInTheDocument();
    expect(screen.getByText('Orphaned')).toBeInTheDocument();
    expect(screen.getByText('No subject')).toBeInTheDocument();
    expect(screen.getByText('365 days after created_at → delete, from AUDIT_RETENTION')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), 'actor_id');
    await waitFor(() => expect(screen.queryByText('Signage media')).not.toBeInTheDocument());
    expect(screen.getByText('Audit events')).toBeInTheDocument();
  });

  it('saves the settings with the expected version', async () => {
    const user = userEvent.setup();
    server.use(http.get('*/api/v1/privacy/settings', () => HttpResponse.json(settingsBody())));
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put('*/api/v1/privacy/settings', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(settingsBody({ controllerName: 'New name', version: 5 }));
      }),
    );
    renderRoute(<PrivacyPage />, '/settings/privacy?tab=settings');
    const name = await screen.findByLabelText('Controller name');
    await user.clear(name);
    await user.type(name, 'New name');
    await user.click(screen.getByRole('button', { name: 'Save privacy settings' }));
    expect(await screen.findByText('Privacy settings saved')).toBeInTheDocument();
    expect(body).toMatchObject({ controllerName: 'New name', expectedVersion: 4, runIntervalMinutes: 60 });
  });

  it('explains a stale write', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/v1/privacy/settings', () => HttpResponse.json(settingsBody())),
      http.put('*/api/v1/privacy/settings', () =>
        HttpResponse.json({ code: 'stale_write', message: 'stale' }, { status: 409 }),
      ),
    );
    renderRoute(<PrivacyPage />, '/settings/privacy?tab=settings');
    await screen.findByLabelText('Controller name');
    await user.click(screen.getByRole('button', { name: 'Save privacy settings' }));
    expect(await screen.findByText('Settings changed in the meantime; reloaded.')).toBeInTheDocument();
  });

  it('is read-only without the manage permission', async () => {
    auth.permissions = ['privacy.read'];
    server.use(http.get('*/api/v1/privacy/settings', () => HttpResponse.json(settingsBody())));
    renderRoute(<PrivacyPage />, '/settings/privacy?tab=settings');
    expect(await screen.findByLabelText('Controller name')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save privacy settings' })).not.toBeInTheDocument();
  });

  it('shows the data requests tab only with the requests permission', async () => {
    const { unmount } = renderRoute(<PrivacyPage />, '/settings/privacy');
    expect(await screen.findByRole('tab', { name: 'Processing activities' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Data requests' })).not.toBeInTheDocument();
    unmount();
    auth.permissions = ['privacy.read', 'privacy.requests.manage'];
    renderRoute(<PrivacyPage />, '/settings/privacy');
    expect(await screen.findByRole('tab', { name: 'Data requests' })).toBeInTheDocument();
  });
});
