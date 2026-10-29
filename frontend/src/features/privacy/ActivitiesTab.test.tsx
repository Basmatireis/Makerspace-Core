import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { ActivitiesTab } from './ActivitiesTab';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({
  authQueryKey: ['auth', 'current-user'],
  useCurrentUser: () => ({ permissions: auth.permissions, authentication: { reauthenticationRequired: [] } }),
}));

const activityId = '0198a000-0000-7000-8000-000000000010';

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: activityId,
    name: 'Membership administration',
    purpose: 'Run the membership',
    legalBasis: 'Contract',
    categoryIds: ['audit_events'],
    recipients: 'Student union',
    retentionNote: 'Two years after leaving',
    version: 3,
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
    updatedBy: null,
    ...overrides,
  };
}

function category(id: string, name: string) {
  return {
    id,
    name,
    description: '',
    ownerModuleId: 'platform',
    ownerModuleEnabled: true,
    orphaned: false,
    subject: 'person',
    fields: [],
    triggers: ['created_at'],
    actions: ['delete'],
    legacyDefault: null,
    retentionNote: '',
    firstSeenAt: '2026-10-01T00:00:00Z',
    lastSeenAt: '2026-10-01T00:00:00Z',
  };
}

describe('processing activities tab', () => {
  beforeEach(() => {
    auth.permissions = ['privacy.read', 'privacy.settings.manage'];
    server.use(
      http.get('*/api/v1/privacy/categories', () =>
        HttpResponse.json({
          categories: [category('audit_events', 'Audit events'), category('people.profile', 'Profiles')],
        }),
      ),
      http.get('*/api/v1/privacy/processing-activities', () => HttpResponse.json({ activities: [activity()] })),
    );
  });

  it('renders the activities with category names', async () => {
    renderRoute(<ActivitiesTab />);
    expect(await screen.findByText('Membership administration')).toBeInTheDocument();
    expect(screen.getByText('Contract')).toBeInTheDocument();
    expect(screen.getByText('Audit events')).toBeInTheDocument();
    expect(screen.getByText('Student union')).toBeInTheDocument();
  });

  it('submits the chosen category ids when editing', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put(`*/api/v1/privacy/processing-activities/${activityId}`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(activity({ version: 4 }));
      }),
    );
    renderRoute(<ActivitiesTab />);
    await user.click(await screen.findByRole('button', { name: 'Edit Membership administration' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: /Data categories/ }));
    await user.click(await screen.findByRole('option', { name: 'Profiles' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      name: 'Membership administration',
      categoryIds: ['audit_events', 'people.profile'],
      expectedVersion: 3,
    });
  });

  it('deletes an activity with its version after confirmation', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    server.use(
      http.delete(`*/api/v1/privacy/processing-activities/${activityId}`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderRoute(<ActivitiesTab />);
    await user.click(await screen.findByRole('button', { name: 'Delete Membership administration' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(body).toEqual({ expectedVersion: 3 }));
  });

  it('is read-only without the manage permission', async () => {
    auth.permissions = ['privacy.read'];
    renderRoute(<ActivitiesTab />);
    await screen.findByText('Membership administration');
    expect(screen.queryByRole('button', { name: 'Add activity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
  });
});
