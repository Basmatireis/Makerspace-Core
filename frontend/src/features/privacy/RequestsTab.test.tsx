import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { RequestsTab } from './RequestsTab';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({
  authQueryKey: ['auth', 'current-user'],
  useCurrentUser: () => ({ permissions: auth.permissions, authentication: { reauthenticationRequired: [] } }),
}));

const requestId = '0198a000-0000-7000-8000-000000000020';
const personId = '0198a000-0000-7000-8000-0000000000aa';

function subjectRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: requestId,
    kind: 'access',
    status: 'assessed',
    personId,
    reference: 'DSR-1',
    channel: 'email',
    receivedAt: '2026-09-01T10:00:00Z',
    dueAt: '2026-10-01T10:00:00Z',
    notes: '',
    identityVerifiedAt: '2026-09-02T10:00:00Z',
    identityVerifiedBy: null,
    assessedAt: '2026-09-03T10:00:00Z',
    assessment: {
      categories: [{ categoryId: 'audit_events', name: 'Audit events', records: 7, outcome: null, note: 'Exported' }],
      blockers: [],
      openHolds: 0,
      uncoveredCategories: [],
    },
    approvedAt: null,
    approvedBy: null,
    executedAt: null,
    executedBy: null,
    result: null,
    exportAvailable: false,
    completedAt: null,
    rejectionReason: '',
    steps: [
      { status: 'received', occurredAt: '2026-09-01T10:00:00Z', actor: null, note: '' },
      { status: 'identity_verified', occurredAt: '2026-09-02T10:00:00Z', actor: null, note: 'Checked in person' },
    ],
    version: 4,
    createdAt: '2026-09-01T10:00:00Z',
    createdBy: null,
    ...overrides,
  };
}

function useRequests(requests: Record<string, unknown>[]) {
  server.use(http.get('*/api/v1/privacy/requests', () => HttpResponse.json({ requests })));
}

describe('data requests tab', () => {
  beforeEach(() => {
    auth.permissions = ['privacy.read', 'privacy.requests.manage', 'privacy.requests.execute'];
  });

  it('lists requests with status and overdue tags', async () => {
    useRequests([
      subjectRequest(),
      subjectRequest({
        id: '0198a000-0000-7000-8000-000000000021',
        reference: 'DSR-2',
        status: 'completed',
        kind: 'erasure',
      }),
    ]);
    renderRoute(<RequestsTab />);
    expect(await screen.findByText('DSR-1')).toBeInTheDocument();
    expect(screen.getByText('Assessed')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getAllByText('Overdue')).toHaveLength(1);
  });

  it('shows the steps and the assessment in the detail row', async () => {
    const user = userEvent.setup();
    useRequests([subjectRequest()]);
    renderRoute(<RequestsTab />);
    await user.click(await screen.findByRole('button', { name: /^Show details of/ }));
    expect(await screen.findByText('Checked in person')).toBeInTheDocument();
    expect(screen.getByText('Exported')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('records a request with the chosen person', async () => {
    const user = userEvent.setup();
    useRequests([]);
    server.use(
      http.get('*/api/v1/people', () =>
        HttpResponse.json({
          items: [{ id: personId, firstName: 'Ada', lastName: 'Lovelace' }],
          page: 1,
          pageSize: 25,
          total: 1,
        }),
      ),
    );
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/privacy/requests', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(subjectRequest({ status: 'received' }), { status: 201 });
      }),
    );
    renderRoute(<RequestsTab />);
    await user.click(await screen.findByRole('button', { name: 'Record request' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Erasure'));
    await user.click(within(dialog).getByRole('combobox', { name: 'Person' }));
    await user.click(await screen.findByRole('option', { name: 'Ada Lovelace' }));
    await user.type(within(dialog).getByLabelText('Reference'), 'DSR-9');
    await user.click(within(dialog).getByRole('button', { name: 'Record request' }));
    await vi.waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ kind: 'erasure', personId, channel: 'email', reference: 'DSR-9' });
    expect(typeof body?.receivedAt).toBe('string');
  });

  it('sends the expected version with a transition', async () => {
    const user = userEvent.setup();
    useRequests([subjectRequest()]);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`*/api/v1/privacy/requests/${requestId}/transition`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(subjectRequest({ status: 'approved', version: 5 }));
      }),
    );
    renderRoute(<RequestsTab />);
    await user.click(await screen.findByRole('button', { name: /^Show details of/ }));
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ status: 'approved', expectedVersion: 4 });
  });

  it('requires a reason to reject and shows API errors', async () => {
    const user = userEvent.setup();
    useRequests([subjectRequest()]);
    server.use(
      http.post(`*/api/v1/privacy/requests/${requestId}/transition`, () =>
        HttpResponse.json({ code: 'request_state_invalid', message: 'nope' }, { status: 409 }),
      ),
    );
    renderRoute(<RequestsTab />);
    await user.click(await screen.findByRole('button', { name: /^Show details of/ }));
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('This field is required.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Reason'), 'Not the data subject');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText(/no longer in a state/)).toBeInTheDocument();
  });

  it('offers execute and the export download only with the execute permission', async () => {
    const user = userEvent.setup();
    useRequests([
      subjectRequest({ status: 'approved' }),
      subjectRequest({
        id: '0198a000-0000-7000-8000-000000000021',
        reference: 'DSR-2',
        status: 'completed',
        exportAvailable: true,
      }),
    ]);
    const { unmount } = renderRoute(<RequestsTab />);
    await screen.findByText('DSR-1');
    for (const button of await screen.findAllByRole('button', { name: /^Show details of/ })) {
      await user.click(button);
    }
    expect(await screen.findByRole('button', { name: 'Execute' })).toBeInTheDocument();
    const downloads: string[] = [];
    server.use(
      http.get('*/api/v1/privacy/requests/:id/export', ({ params }) => {
        downloads.push(String(params.id));
        return new HttpResponse(new Blob(['zip']), {
          headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="x.zip"' },
        });
      }),
    );
    const saved: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:export', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    await user.click(screen.getByRole('button', { name: 'Download export' }));
    await waitFor(() => expect(downloads).toEqual(['0198a000-0000-7000-8000-000000000021']));
    await waitFor(() => expect(saved).toEqual(['subject-request-0198a000-0000-7000-8000-000000000021.zip']));
    click.mockRestore();
    unmount();

    auth.permissions = ['privacy.read', 'privacy.requests.manage'];
    renderRoute(<RequestsTab />);
    await screen.findByText('DSR-1');
    for (const button of await screen.findAllByRole('button', { name: /^Show details of/ })) {
      await user.click(button);
    }
    expect(screen.queryByRole('button', { name: 'Execute' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download export' })).not.toBeInTheDocument();
  });
});
