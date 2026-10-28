import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { HoldsTab } from './HoldsTab';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({
  authQueryKey: ['auth', 'current-user'],
  useCurrentUser: () => ({ permissions: auth.permissions }),
}));

const holdId = '0198a000-0000-7000-8000-000000000002';

function hold(overrides: Record<string, unknown> = {}) {
  return {
    id: holdId,
    categoryId: 'audit_events',
    personId: null,
    reason: 'Legal proceedings',
    createdAt: '2026-10-01T10:00:00Z',
    createdBy: null,
    releasedAt: null,
    releasedBy: null,
    ...overrides,
  };
}

const categoryList = {
  categories: [
    {
      id: 'audit_events',
      name: 'Audit events',
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
    },
  ],
};

describe('holds tab', () => {
  beforeEach(() => {
    auth.permissions = ['privacy.read', 'privacy.policies.manage'];
    server.use(http.get('*/api/v1/privacy/categories', () => HttpResponse.json(categoryList)));
  });

  it('places a hold on a category', async () => {
    const user = userEvent.setup();
    server.use(http.get('*/api/v1/privacy/holds', () => HttpResponse.json({ holds: [] })));
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/privacy/holds', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(hold(), { status: 201 });
      }),
    );
    renderRoute(<HoldsTab />);
    await user.click(await screen.findByRole('button', { name: 'Place hold' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Legal proceedings');
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    await vi.waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ categoryId: 'audit_events', reason: 'Legal proceedings' });
  });

  it('places a hold on a person', async () => {
    const user = userEvent.setup();
    server.use(http.get('*/api/v1/privacy/holds', () => HttpResponse.json({ holds: [] })));
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/privacy/holds', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(hold({ categoryId: null, personId: body.personId }), { status: 201 });
      }),
    );
    renderRoute(<HoldsTab />);
    await user.click(await screen.findByRole('button', { name: 'Place hold' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('A person'));
    await user.type(within(dialog).getByLabelText('Person ID'), '0198a000-0000-7000-8000-0000000000aa');
    await user.type(within(dialog).getByLabelText('Reason'), 'Dispute');
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    await vi.waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ personId: '0198a000-0000-7000-8000-0000000000aa', reason: 'Dispute' });
  });

  it('releases an open hold after confirmation', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/v1/privacy/holds', () =>
        HttpResponse.json({
          holds: [
            hold(),
            hold({
              id: '0198a000-0000-7000-8000-000000000003',
              reason: 'Old dispute',
              releasedAt: '2026-10-02T00:00:00Z',
            }),
          ],
        }),
      ),
    );
    let released = false;
    server.use(
      http.post(`*/api/v1/privacy/holds/${holdId}/release`, () => {
        released = true;
        return HttpResponse.json(hold({ releasedAt: '2026-10-03T00:00:00Z' }));
      }),
    );
    renderRoute(<HoldsTab />);
    expect(await screen.findByText('Legal proceedings')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Release' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Release' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Release' }));
    await vi.waitFor(() => expect(released).toBe(true));
  });

  it('is read-only without the manage permission', async () => {
    auth.permissions = ['privacy.read'];
    server.use(http.get('*/api/v1/privacy/holds', () => HttpResponse.json({ holds: [hold()] })));
    renderRoute(<HoldsTab />);
    await screen.findByText('Legal proceedings');
    expect(screen.queryByRole('button', { name: 'Place hold' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release' })).not.toBeInTheDocument();
  });
});
