import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { requestPath } from './privacyNavigation';
import { RequestsTab } from './RequestsTab';

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
const day = 86_400_000;

function inDays(days: number): string {
  return new Date(Date.now() + days * day).toISOString();
}

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
    receivedAt: inDays(-9),
    dueAt: inDays(21),
    notes: '',
    identityVerifiedAt: inDays(-2),
    identityVerifiedBy: '0198a000-0000-7000-8000-0000000000bb',
    assessedAt: inDays(-1),
    assessment: {
      categories: [
        { categoryId: 'visits', name: 'Visits', records: 118, outcome: 'erased', note: '' },
        { categoryId: 'finance', name: 'Financial records', records: 4, outcome: 'retained_legal', note: '' },
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
    steps: [{ status: 'received', occurredAt: inDays(-9), actor: null, actorName: 'Hauke N.', note: '' }],
    version: 4,
    createdAt: inDays(-9),
    createdBy: null,
    ...overrides,
  };
}

function useRequests(requests: Record<string, unknown>[]) {
  server.use(http.get('*/api/v1/privacy/requests', () => HttpResponse.json({ requests })));
}

const otherId = '0198a000-0000-7000-8000-000000000021';
const thirdId = '0198a000-0000-7000-8000-000000000022';
const fourthId = '0198a000-0000-7000-8000-000000000023';

/** One request per tile: mine (approve), waiting (verified by me), overdue and mine (verify), closed. */
function mixedRequests() {
  return [
    subjectRequest(),
    subjectRequest({
      id: otherId,
      kind: 'access',
      personName: 'Jana Novak',
      reference: 'DSR-2',
      identityVerifiedBy: 'me',
    }),
    subjectRequest({
      id: thirdId,
      kind: 'access',
      personName: 'Ali Yilmaz',
      reference: 'DSR-3',
      status: 'received',
      assessment: null,
      identityVerifiedBy: null,
      receivedAt: inDays(-32),
      dueAt: inDays(-2),
    }),
    subjectRequest({
      id: fourthId,
      personName: 'Sophie Berger',
      reference: 'DSR-4',
      status: 'completed',
      receivedAt: inDays(-20),
      dueAt: inDays(-1),
      completedAt: inDays(-1),
    }),
  ];
}

function tileValue(label: string): string {
  return within(screen.getByRole('link', { name: new RegExp(label) })).getByText(/^\d+$/).textContent ?? '';
}

describe('data requests list', () => {
  beforeEach(() => {
    auth.permissions = ['privacy.read', 'privacy.requests.manage', 'privacy.requests.execute'];
  });

  it('counts the tiles from who may take the next step', async () => {
    useRequests(mixedRequests());
    renderRoute(<RequestsTab />);
    await screen.findByText('Max Mustermann');
    expect(tileValue('Your move')).toBe('2');
    expect(tileValue('Waiting for someone else')).toBe('1');
    expect(tileValue('Due within 7 days or overdue')).toBe('1');
    expect(tileValue('Closed this year')).toBe('1');
  });

  it('keeps the approval of a request the current user verified out of "your move"', async () => {
    const user = userEvent.setup();
    useRequests(mixedRequests());
    renderRoute(<RequestsTab />);
    await screen.findByText('Max Mustermann');
    await user.click(screen.getByRole('link', { name: /Waiting for someone else/ }));
    expect(screen.getByText('Jana Novak')).toBeInTheDocument();
    expect(screen.queryByText('Max Mustermann')).not.toBeInTheDocument();
    expect(screen.getByText(/Someone other than you/)).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /Your move/ }));
    expect(screen.getByText('Max Mustermann')).toBeInTheDocument();
    expect(screen.getByText('Ali Yilmaz')).toBeInTheDocument();
    expect(screen.queryByText('Jana Novak')).not.toBeInTheDocument();
    expect(screen.getAllByText(/^You · /)).toHaveLength(2);
  });

  it('shows the countdown, marks overdue requests and links to the request page', async () => {
    useRequests(mixedRequests());
    renderRoute(<RequestsTab />);
    const overdue = await screen.findByText(/^overdue by 2 days$/);
    expect(overdue).toHaveClass('privacy-requests__due--late');
    expect(screen.getAllByText('in 21 days')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Max Mustermann' })).toHaveAttribute('href', requestPath(requestId));
    expect(screen.getAllByText('Assessed, waiting for approval')).toHaveLength(2);
    // Closed requests are hidden by "Open only" and come back when it is switched off.
    expect(screen.queryByText('Sophie Berger')).not.toBeInTheDocument();
  });

  it('shows closed requests with how long they took when open only is off', async () => {
    const user = userEvent.setup();
    useRequests(mixedRequests());
    renderRoute(<RequestsTab />);
    await screen.findByText('Max Mustermann');
    await user.click(screen.getByRole('button', { name: 'Open only' }));
    expect(await screen.findByText('Sophie Berger')).toBeInTheDocument();
    expect(screen.getByText('closed in 19 days')).toBeInTheDocument();
  });

  it('names an erased person as such', async () => {
    useRequests([subjectRequest({ personName: null, personId: null })]);
    renderRoute(<RequestsTab />);
    expect(await screen.findByRole('link', { name: 'Erased person' })).toBeInTheDocument();
  });

  it('records a request with the chosen person and opens its page', async () => {
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
    const { router } = renderRoute(<RequestsTab />);
    await user.click(await screen.findByRole('button', { name: 'Record a request' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Due one month later: /)).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(/Erasure/));
    await user.click(within(dialog).getByRole('combobox', { name: 'Who is asking?' }));
    await user.click(await screen.findByRole('option', { name: 'Ada Lovelace' }));
    await user.type(within(dialog).getByLabelText('Your reference'), 'DSR-9');
    await user.click(within(dialog).getByRole('button', { name: 'Record and open' }));
    await vi.waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ kind: 'erasure', personId, channel: 'email', reference: 'DSR-9' });
    expect(typeof body?.receivedAt).toBe('string');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(requestPath(requestId)));
  });
});
