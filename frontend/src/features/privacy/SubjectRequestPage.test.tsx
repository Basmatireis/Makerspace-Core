import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { requestPath } from './privacyNavigation';
import { SubjectRequestPage } from './SubjectRequestPage';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({
  authQueryKey: ['auth', 'current-user'],
  useCurrentUser: () => ({
    permissions: auth.permissions,
    account: { id: 'me' },
    authentication: { reauthenticationRequired: [] },
  }),
}));

const requestId = '0198a000-0000-7000-8000-000000000020';
const personId = '0198a000-0000-7000-8000-0000000000aa';

function subjectRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: requestId,
    kind: 'erasure',
    status: 'assessed',
    personId,
    personName: 'Max Mustermann',
    identityVerifiedByName: 'Lena K.',
    approvedByName: null,
    executedByName: null,
    reference: 'DSR-1',
    channel: 'email',
    receivedAt: '2026-09-01T10:00:00Z',
    dueAt: '2026-10-01T10:00:00Z',
    notes: 'Leaving the university',
    identityVerifiedAt: '2026-09-02T10:00:00Z',
    identityVerifiedBy: '0198a000-0000-7000-8000-0000000000bb',
    assessedAt: '2026-09-03T10:00:00Z',
    assessment: {
      categories: [
        { categoryId: 'visits', name: 'Visits and holds', records: 118, outcome: 'erased', note: '' },
        { categoryId: 'jobs', name: 'Machine jobs', records: 14, outcome: 'unlinked', note: '' },
        { categoryId: 'finance', name: 'Financial records', records: 4, outcome: 'retained_legal', note: 'Until 2033' },
      ],
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
      { status: 'received', occurredAt: '2026-09-01T10:00:00Z', actor: null, actorName: 'Hauke N.', note: '' },
      {
        status: 'identity_verified',
        occurredAt: '2026-09-02T10:00:00Z',
        actor: null,
        actorName: 'Lena K.',
        note: 'Student card shown',
      },
      { status: 'assessed', occurredAt: '2026-09-03T10:00:00Z', actor: null, actorName: 'Lena K.', note: '' },
    ],
    version: 4,
    createdAt: '2026-09-01T10:00:00Z',
    createdBy: null,
    ...overrides,
  };
}

function useRequest(overrides: Record<string, unknown> = {}) {
  server.use(
    http.get(`*/api/v1/privacy/requests/${requestId}`, () => HttpResponse.json(subjectRequest(overrides))),
    http.get('*/api/v1/privacy/categories', () =>
      HttpResponse.json({
        categories: [{ id: 'visits', name: 'Visits and holds', contains: 'Check-in and check-out times' }],
      }),
    ),
  );
}

function recordTransition(response: Record<string, unknown>) {
  const state: { body?: Record<string, unknown> } = {};
  server.use(
    http.post(`*/api/v1/privacy/requests/${requestId}/transition`, async ({ request }) => {
      state.body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(response);
    }),
  );
  return state;
}

function renderPage() {
  return renderRoute(<SubjectRequestPage />, requestPath(requestId));
}

describe('data request page', () => {
  beforeEach(() => {
    auth.permissions = ['privacy.read', 'privacy.requests.manage', 'privacy.requests.execute'];
  });

  it('shows the step to take for an assessed request with the four-eyes hint', async () => {
    useRequest();
    renderPage();
    expect(await screen.findByRole('heading', { name: /Max Mustermann asks for erasure/ })).toBeInTheDocument();
    expect(screen.getByText('Step 4 · Approve the erasure')).toBeInTheDocument();
    expect(screen.getByText(/Lena K\. verified the identity, so someone else must approve/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve the erasure' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Max Mustermann' })).toHaveAttribute('href', `/people/${personId}`);
    expect(screen.queryByText(/Student card shown/, { selector: '.cds--progress-optional' })).not.toBeInTheDocument();
    expect(screen.getByText(/Lena K. · 02\.09\.2026/, { selector: '.cds--progress-optional' })).toBeInTheDocument();
  });

  it('tells the verifier that someone else must approve', async () => {
    useRequest({ identityVerifiedBy: 'me' });
    renderPage();
    expect(await screen.findByText(/You verified the identity, so someone else must approve/)).toBeInTheDocument();
  });

  it('describes the assessment in words, not codes', async () => {
    useRequest();
    renderPage();
    const table = await screen.findByRole('table', { name: /categories/ });
    expect(within(table).getByText('Deleted')).toBeInTheDocument();
    expect(within(table).getByText('Kept without the name')).toBeInTheDocument();
    expect(within(table).getByText('Kept for a legal obligation')).toBeInTheDocument();
    expect(within(table).getByText('Check-in and check-out times')).toBeInTheDocument();
    expect(table).not.toHaveTextContent('retained_legal');
    expect(screen.getByText('Nothing blocks the erasure.')).toBeInTheDocument();
  });

  it('translates blockers and open holds', async () => {
    useRequest({
      assessment: {
        categories: [],
        blockers: ['person_scim_managed'],
        openHolds: 1,
        uncoveredCategories: [],
      },
    });
    renderPage();
    expect(
      await screen.findByText('The person is provisioned by the identity provider; deprovision there first.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the holds' })).toHaveAttribute('href', '/settings/privacy/holds');
    expect(screen.queryByText('Nothing blocks the erasure.')).not.toBeInTheDocument();
  });

  it('approves with the expected version', async () => {
    const user = userEvent.setup();
    useRequest();
    const sent = recordTransition(subjectRequest({ status: 'approved', version: 5 }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Approve the erasure' }));
    await vi.waitFor(() => expect(sent.body).toBeDefined());
    expect(sent.body).toEqual({ status: 'approved', expectedVersion: 4 });
  });

  it('requires a note to verify the identity', async () => {
    const user = userEvent.setup();
    useRequest({ status: 'received', assessment: null, steps: [] });
    const sent = recordTransition(subjectRequest({ status: 'identity_verified', version: 5 }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Mark identity as verified' }));
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
    expect(sent.body).toBeUndefined();
    await user.type(screen.getByLabelText(/How did you verify/), 'Student card shown');
    await user.click(screen.getByRole('button', { name: 'Mark identity as verified' }));
    await vi.waitFor(() => expect(sent.body).toBeDefined());
    expect(sent.body).toEqual({ status: 'identity_verified', note: 'Student card shown', expectedVersion: 4 });
  });

  it('needs a reason to reject and shows API errors', async () => {
    const user = userEvent.setup();
    useRequest();
    server.use(
      http.post(`*/api/v1/privacy/requests/${requestId}/transition`, () =>
        HttpResponse.json({ code: 'request_state_invalid', message: 'nope' }, { status: 409 }),
      ),
    );
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Reject this request…' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('This field is required.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Reason'), 'Not the data subject');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText(/no longer in a state/)).toBeInTheDocument();
  });

  it('executes an approved access request through the API client', async () => {
    const user = userEvent.setup();
    useRequest({ kind: 'access', status: 'approved' });
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`*/api/v1/privacy/requests/${requestId}/execute`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(subjectRequest({ kind: 'access', status: 'completed', version: 5 }));
      }),
    );
    renderPage();
    expect(await screen.findByRole('heading', { name: /asks for a copy of their data/ })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Build the export' }));
    await vi.waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ expectedVersion: 4 });
  });

  it('confirms an erasure before deleting and lists what stays', async () => {
    const user = userEvent.setup();
    useRequest({ status: 'approved' });
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`*/api/v1/privacy/requests/${requestId}/execute`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(subjectRequest({ status: 'partially_completed', version: 5 }));
      }),
    );
    renderPage();
    await user.click(await screen.findByRole('button', { name: "Delete the person's data" }));
    const dialog = await screen.findByRole('alertdialog');
    expect(body).toBeUndefined();
    expect(within(dialog).getByText(/Financial records/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete the data' }));
    await vi.waitFor(() => expect(body).toEqual({ expectedVersion: 4 }));
  });

  it('offers no execution without the execute permission', async () => {
    auth.permissions = ['privacy.read', 'privacy.requests.manage'];
    useRequest({ status: 'approved' });
    renderPage();
    await screen.findByText(/Only people with the execute permission/);
    expect(screen.queryByRole('button', { name: "Delete the person's data" })).not.toBeInTheDocument();
  });

  it('downloads the export through the API client', async () => {
    const user = userEvent.setup();
    useRequest({
      kind: 'access',
      status: 'completed',
      exportAvailable: true,
      result: { categories: [], blockers: [], openHolds: 0, uncoveredCategories: [] },
    });
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
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Download export' }));
    await waitFor(() => expect(downloads).toEqual([requestId]));
    await waitFor(() => expect(saved).toEqual([`subject-request-${requestId}.zip`]));
    click.mockRestore();
  });

  it('shows the result of an executed erasure under its own title', async () => {
    useRequest({
      status: 'partially_completed',
      result: {
        categories: [{ categoryId: 'visits', name: 'Visits and holds', records: 118, outcome: 'erased', note: '' }],
        blockers: [],
        openHolds: 0,
        uncoveredCategories: [],
      },
    });
    renderPage();
    expect(await screen.findByText('What the erasure did')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject this request…' })).not.toBeInTheDocument();
  });
});
