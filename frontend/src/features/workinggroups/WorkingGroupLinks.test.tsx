import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  WorkingGroupActivityEntry,
  WorkingGroupProject,
  WorkingGroupPurchase,
  WorkingGroupSummary,
  WorkingGroupTicket,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, fixturePersonId, otherPersonId } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const groupId = '0192f6f8-743e-7c77-a349-cd07c3e8e001';
const ticketId = '0192f6f8-743e-7c77-a349-cd07c3e8d001';
const purchaseId = '0192f6f8-743e-7c77-a349-cd07c3e8p001'.replace('p', '9');
const refundId = '0192f6f8-743e-7c77-a349-cd07c3e8a002';
const projectId = '0192f6f8-743e-7c77-a349-cd07c3e8b001';
const ada = { personId: fixturePersonId, displayName: 'Ada Lovelace' };
const grace = { personId: otherPersonId, displayName: 'Grace Hopper' };

const summary: WorkingGroupSummary = {
  id: groupId,
  name: 'Printing',
  description: '',
  lead: grace,
  memberCount: 4,
  machineCount: 1,
  isMember: true,
  isLead: false,
  openTicketCount: 3,
  openTodoCount: 1,
};

const ticket = (over: Partial<WorkingGroupTicket> = {}): WorkingGroupTicket => ({
  id: ticketId,
  groupId,
  groupName: 'Printing',
  kind: 'problem',
  subject: 'Printer jams',
  body: '',
  blocksUse: false,
  status: 'new',
  author: grace,
  followerCount: 0,
  isFollowing: false,
  isMine: false,
  commentCount: 0,
  inside: true,
  version: 3,
  createdAt: '2026-01-01T10:00:00Z',
  updatedAt: '2026-01-01T10:00:00Z',
  ...over,
});

const purchase = (over: Partial<WorkingGroupPurchase>): WorkingGroupPurchase =>
  ({
    id: purchaseId,
    groupId,
    groupName: 'Printing',
    item: 'Nozzle set',
    quantity: 2,
    unitPrice: '10.00',
    estimatedTotal: '20.00',
    how: 'central',
    status: 'wanted',
    needsProject: false,
    requester: ada,
    periodName: '2026',
    createdAt: '2026-02-01T10:00:00Z',
    version: 1,
    hasAttachment: false,
    hasReceipt: false,
    ...over,
  }) as unknown as WorkingGroupPurchase;

const project = {
  id: projectId,
  groupId,
  groupName: 'Printing',
  title: 'Laser upgrade',
  status: 'submitted',
  requester: ada,
  createdAt: '2026-02-02T10:00:00Z',
} as unknown as WorkingGroupProject;

function serve(
  options: {
    permissions?: PermissionId[];
    member?: boolean;
    ticket?: WorkingGroupTicket;
    activity?: WorkingGroupActivityEntry[];
  } = {},
) {
  const bodies: unknown[] = [];
  const limits: (string | null)[] = [];
  const shown = options.ticket ?? ticket();
  server.use(
    http.get('*/api/v1/auth/me', () =>
      HttpResponse.json(currentUserFixture(options.permissions ?? [PermissionId.working_groupsread])),
    ),
    http.get('*/api/v1/working-groups', () => HttpResponse.json({ items: [summary] })),
    http.get(`*/api/v1/working-groups/${groupId}`, () =>
      HttpResponse.json({
        ...summary,
        isMember: options.member ?? true,
        version: 1,
        members: [],
        machines: [],
        places: [],
        columns: [],
        canEdit: false,
        canManage: false,
      }),
    ),
    http.get(`*/api/v1/working-groups/${groupId}/activity`, ({ request }) => {
      limits.push(new URL(request.url).searchParams.get('limit'));
      return HttpResponse.json({ items: (options.activity ?? []).slice(0, Number(limits.at(-1) ?? 50)) });
    }),
    http.get('*/api/v1/working-group-tickets', () => HttpResponse.json({ items: [shown] })),
    http.get('*/api/v1/working-group-todos', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-notes', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-status', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-tickets/:id', () =>
      HttpResponse.json({ ticket: shown, followers: [], comments: [] }),
    ),
    http.get('*/api/v1/working-group-purchases', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      const items =
        status === 'wanted'
          ? [purchase({ linkedTasks: [{ kind: 'ticket', id: ticketId, title: 'Printer jams' }] })]
          : status === 'bought'
            ? [purchase({ id: refundId, item: 'Spool holder', how: 'self', status: 'bought' })]
            : [purchase({}), purchase({ id: refundId, item: 'Spool holder' })];
      return HttpResponse.json({ items, truncated: false });
    }),
    http.get('*/api/v1/working-group-projects', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      return HttpResponse.json({ items: status === 'submitted' ? [project] : status === 'wiref' ? [] : [project] });
    }),
    http.get('*/api/v1/working-group-budget', () =>
      HttpResponse.json({
        period: { id: 'p', name: '2026', current: true },
        groups: [
          { groupId, groupName: 'Printing', given: '500.00', spent: '100.00', reserved: '50.00', free: '350.00' },
        ],
      }),
    ),
    http.put('*/api/v1/working-group-tickets/:id/link', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ ticket: shown, followers: [], comments: [] });
    }),
  );
  return { bodies, limits };
}

const taskUrl = `/working-groups/tasks?group=${groupId}&item=ticket:${ticketId}`;

describe('linking a ticket', () => {
  it('links one purchase through the dialog', async () => {
    const { bodies } = serve();
    renderRoute(<App />, taskUrl);
    await userEvent.click(await screen.findByRole('button', { name: 'Link' }));
    const dialog = await screen.findByRole('dialog', { name: /Link to a purchase/ });
    await userEvent.click(await within(dialog).findByLabelText(/Nozzle set/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(bodies).toEqual([{ expectedVersion: 3, purchaseId }]));
  });

  it('shows what it belongs to and unlinks with an empty body', async () => {
    const { bodies } = serve({
      ticket: ticket({ link: { kind: 'project', id: projectId, title: 'Laser upgrade', status: 'running' } }),
    });
    renderRoute(<App />, taskUrl);
    const title = await screen.findByRole('link', { name: 'Laser upgrade' });
    expect(title).toHaveAttribute('href', `/working-groups/projects/${projectId}`);
    expect(title.closest('p')).toHaveTextContent('Belongs to: Laser upgrade (Running)');
    await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(bodies).toEqual([{ expectedVersion: 3 }]));
  });

  it('moves focus to the Belongs-to line after linking and unlinking', async () => {
    serve();
    renderRoute(<App />, taskUrl);
    await userEvent.click(await screen.findByRole('button', { name: 'Link' }));
    const dialog = await screen.findByRole('dialog', { name: /Link to a purchase/ });
    expect(within(dialog).getByRole('group', { name: 'Purchases' })).toBeInTheDocument();
    await userEvent.click(await within(dialog).findByLabelText(/Nozzle set/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(document.querySelector('.wg-linkline')).toHaveFocus());
  });

  it('explains instead of listing when the caller cannot see purchases and projects', async () => {
    serve({ member: false, permissions: [PermissionId.working_groupsread, PermissionId.working_groupsmanage] });
    renderRoute(<App />, taskUrl);
    await userEvent.click(await screen.findByRole('button', { name: 'Link' }));
    const dialog = await screen.findByRole('dialog', { name: /Link to a purchase/ });
    expect(within(dialog).getByText(/cannot see the purchases and projects/)).toBeInTheDocument();
    expect(within(dialog).queryByText('Nothing found.')).not.toBeInTheDocument();
  });

  it('offers no Link button to somebody outside the group', async () => {
    serve({ ticket: ticket({ inside: false }) });
    renderRoute(<App />, taskUrl);
    await screen.findAllByText('Printer jams');
    await screen.findByText('Nothing selected').catch(() => undefined);
    expect(screen.queryByRole('button', { name: 'Link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument();
  });
});

describe('Lately', () => {
  const entry = (n: number): WorkingGroupActivityEntry => ({
    kind: 'ticket_closed',
    at: new Date(Date.now() - n * 3600_000).toISOString(),
    actor: ada,
    title: `Alignment ${n}`,
    targetKind: 'ticket',
    targetId: `0192f6f8-743e-7c77-a349-cd07c3e8d0${String(n).padStart(2, '0')}`,
  });

  it('lists sentences with relative times and loads more on request', async () => {
    const { limits } = serve({ activity: Array.from({ length: 12 }, (_, n) => entry(n + 1)) });
    renderRoute(<App />, '/working-groups');
    const row = (await screen.findByText('Alignment 1')).closest('li')!;
    expect(row).toHaveTextContent('Ada closed the ticket Alignment 1');
    expect(row).toHaveTextContent('1 hour ago');
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(limits).toEqual(['10', '50']));
    await waitFor(() => expect(screen.getByText('Alignment 11')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('link', { name: 'Alignment 11' })).toHaveFocus());
  });
});

describe('management overview', () => {
  const finance = [
    PermissionId.working_groupsread,
    PermissionId.working_groupsmanage,
    PermissionId.working_group_financesmanage,
  ];

  it('counts what waits and shows the linked tickets and the budget for finance managers', async () => {
    serve({ permissions: finance });
    renderRoute(<App />, '/working-groups?group=all');
    const waiting = await screen.findByRole('button', { name: /Waiting for you/ });
    await waitFor(() => expect(waiting).toHaveTextContent('3'));
    expect(screen.getByRole('button', { name: /Purchases to approve/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Refunds to pay/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Projects to approve/ })).toHaveTextContent('1');
    expect(await screen.findByText(/350\.00.*free/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Nozzle set/ }));
    const from = await screen.findByRole('link', { name: 'Printer jams' });
    expect(from).toHaveAttribute('href', `/working-groups/tasks?group=${groupId}&item=ticket%3A${ticketId}`);
  });

  it('keeps the budget off the group cards for people without finance rights', async () => {
    serve({ permissions: [PermissionId.working_groupsread, PermissionId.working_groupsmanage] });
    renderRoute(<App />, '/working-groups?group=all');
    expect(await screen.findByText('4 people · 3 open tickets')).toBeInTheDocument();
    expect(screen.queryByText(/free$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Waiting for you/ })).not.toBeInTheDocument();
  });
});
