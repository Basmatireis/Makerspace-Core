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
    contains: 'who changed what and when',
    erasure: 'unlinked',
    coverage: {
      policyStatus: 'none',
      policy: null,
      hold: null,
      lastRun: null,
      processingActivities: [],
    },
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

function policyCoverage(status: 'active' | 'pending' | 'none', overrides: Record<string, unknown> = {}) {
  return {
    policyStatus: status,
    policy: {
      id: '018f0000-0000-7000-8000-000000000001',
      categoryId: 'audit_events',
      version: 2,
      trigger: 'created_at',
      periodDays: 90,
      action: 'delete',
      purpose: 'Security',
      legalBasis: 'Legitimate interest',
      reason: 'Short retention',
      status: status === 'active' ? 'active' : 'draft',
      sourceTemplate: null,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      approvedAt: '2026-10-02T00:00:00Z',
      activatedAt: '2026-10-03T00:00:00Z',
      retiredAt: null,
      createdBy: null,
      approvedBy: null,
      activatedBy: null,
    },
    hold: null,
    lastRun: null,
    processingActivities: [],
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
          policiesActive: 3,
          policiesPending: 4,
          withoutPolicy: 5,
          openCategoryHolds: 0,
          openPersonHolds: 0,
          lastRun: null,
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

  it('shows counts, the controller hint and the automatic-runs state on the entry page', async () => {
    renderRoute(<PrivacyPage />, '/settings/privacy');
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(await screen.findByText(/controller not named/)).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('lists categories with tags and filters them by search', async () => {
    const user = userEvent.setup();
    renderRoute(<PrivacyPage />, '/settings/privacy');
    expect(await screen.findByText('Audit events')).toBeInTheDocument();
    expect(screen.getByText('Orphaned')).toBeInTheDocument();
    expect(screen.getByText('No person')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), 'actor_id');
    await waitFor(() => expect(screen.queryByText('Signage media')).not.toBeInTheDocument());
    expect(screen.getByText('Audit events')).toBeInTheDocument();
  });

  it('filters the table with the summary tiles', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/v1/privacy/categories', () =>
        HttpResponse.json({
          categories: [
            category({ coverage: policyCoverage('active') }),
            category({ id: 'signage_media', name: 'Signage media', ownerModuleId: 'signage', subject: 'none' }),
          ],
        }),
      ),
    );
    renderRoute(<PrivacyPage />, '/settings/privacy');
    expect(await screen.findByText('Signage media')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /Policy in force/ }));
    await waitFor(() => expect(screen.queryByText('Signage media')).not.toBeInTheDocument());
    expect(screen.getByText('Audit events')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /All categories/ }));
    expect(await screen.findByText('Signage media')).toBeInTheDocument();
  });

  it('filters the table by who the data belongs to from the filter popover', async () => {
    const user = userEvent.setup();
    renderRoute(<PrivacyPage />, '/settings/privacy');
    expect(await screen.findByText('Signage media')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Filter/ }));
    await user.click(screen.getByRole('checkbox', { name: 'A person' }));
    await waitFor(() => expect(screen.queryByText('Signage media')).not.toBeInTheDocument());
    expect(screen.getByText('Audit events')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Signage media')).toBeInTheDocument();
  });

  it('shows where the data is stored and the decision of record in the opened row', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/v1/privacy/categories', () =>
        HttpResponse.json({
          categories: [
            category({
              coverage: policyCoverage('active', {
                processingActivities: [{ id: '018f0000-0000-7000-8000-000000000009', name: 'Security logging' }],
              }),
            }),
          ],
        }),
      ),
    );
    renderRoute(<PrivacyPage />, '/settings/privacy');
    await screen.findByText('Audit events');
    await user.click(screen.getByRole('button', { name: 'Show where Audit events is stored' }));
    expect(screen.getByText('audit_events')).toBeInTheDocument();
    expect(screen.getByText('actor_id')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Security logging' })).toBeInTheDocument();
    expect(screen.getByText('Active v2')).toBeInTheDocument();
    expect(screen.getByText('365 days after created_at → delete, from AUDIT_RETENTION')).toBeInTheDocument();
    expect(screen.getByText('Kept without the person link.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit retention' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit retention' })).toHaveAttribute(
      'href',
      '/settings/privacy/categories/audit_events',
    );
  });

  it('shows the hold on a category that is paused', async () => {
    server.use(
      http.get('*/api/v1/privacy/categories', () =>
        HttpResponse.json({
          categories: [
            category({
              coverage: policyCoverage('active', {
                hold: {
                  id: '018f0000-0000-7000-8000-000000000010',
                  categoryId: 'audit_events',
                  personId: null,
                  reason: 'Legal review',
                  createdAt: '2026-10-20T10:00:00Z',
                  createdBy: null,
                  releasedAt: null,
                  releasedBy: null,
                },
              }),
            }),
          ],
        }),
      ),
    );
    renderRoute(<PrivacyPage />, '/settings/privacy');
    expect(await screen.findByText('Paused by a hold: In force')).toBeInTheDocument();
    expect(screen.getByText(/On hold since .*: Legal review/)).toBeInTheDocument();
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
    renderRoute(<PrivacyPage />, '/settings/privacy/settings');
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
    renderRoute(<PrivacyPage />, '/settings/privacy/settings');
    await screen.findByLabelText('Controller name');
    await user.click(screen.getByRole('button', { name: 'Save privacy settings' }));
    expect(await screen.findByText('Settings changed in the meantime; reloaded.')).toBeInTheDocument();
  });

  it('is read-only without the manage permission', async () => {
    auth.permissions = ['privacy.read'];
    server.use(http.get('*/api/v1/privacy/settings', () => HttpResponse.json(settingsBody())));
    renderRoute(<PrivacyPage />, '/settings/privacy/settings');
    expect(await screen.findByLabelText('Controller name')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save privacy settings' })).not.toBeInTheDocument();
  });

  it('links to data requests only with the requests permission and sends request handlers there', async () => {
    const { unmount } = renderRoute(<PrivacyPage />, '/settings/privacy');
    expect(await screen.findByRole('link', { name: 'Processing activities' })).toHaveAttribute(
      'href',
      '/settings/privacy/activities',
    );
    expect(screen.queryByRole('link', { name: 'Data requests' })).not.toBeInTheDocument();
    unmount();
    auth.permissions = ['privacy.read', 'privacy.requests.manage'];
    const second = renderRoute(<PrivacyPage />, '/settings/privacy');
    expect(await screen.findByRole('link', { name: 'Data requests' })).toHaveAttribute(
      'href',
      '/settings/privacy/requests',
    );
    second.unmount();
    auth.permissions = ['privacy.requests.manage'];
    const { router } = renderRoute(<PrivacyPage />, '/settings/privacy');
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/privacy/requests'));
  });

  it('shows a sub-page with a breadcrumb back to the categories', async () => {
    renderRoute(<PrivacyPage />, '/settings/privacy/settings');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy & data retention' })).toHaveAttribute('href', '/settings/privacy');
  });
});
