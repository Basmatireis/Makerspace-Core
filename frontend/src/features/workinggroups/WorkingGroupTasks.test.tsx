import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkingGroup,
  WorkingGroupSummary,
  WorkingGroupTicket,
  WorkingGroupTodo,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, fixturePersonId, otherPersonId } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { addDays, todayOn } from './taskModel';

const printId = '0192f6f8-743e-7c77-a349-cd07c3e8e001';
const woodId = '0192f6f8-743e-7c77-a349-cd07c3e8e002';
const colTodo = { id: '0192f6f8-743e-7c77-a349-cd07c3e8c001', name: 'To do' };
const colProgress = { id: '0192f6f8-743e-7c77-a349-cd07c3e8c002', name: 'In progress' };
const ada = { personId: fixturePersonId, displayName: 'Ada Lovelace' };
const grace = { personId: otherPersonId, displayName: 'Grace Hopper' };

const printGroup: WorkingGroup = {
  id: printId,
  name: 'Printing',
  description: '',
  lead: grace,
  memberCount: 2,
  machineCount: 1,
  isMember: true,
  isLead: false,
  version: 4,
  members: [
    { ...grace, isLead: true, joinedAt: '2026-01-01T00:00:00Z' },
    { ...ada, isLead: false, joinedAt: '2026-01-02T00:00:00Z' },
  ],
  machines: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8e101', name: 'Prusa CORE One' }],
  places: [],
  columns: [colTodo, colProgress],
  canEdit: true,
  canManage: false,
};
const woodGroup: WorkingGroup = {
  ...printGroup,
  id: woodId,
  name: 'Woodworking',
  isMember: false,
  members: [{ ...grace, isLead: true, joinedAt: '2026-01-01T00:00:00Z' }],
  machines: [],
  columns: [colTodo],
  canEdit: false,
};

const summary = (group: WorkingGroup): WorkingGroupSummary => ({
  id: group.id,
  name: group.name,
  description: group.description,
  lead: group.lead,
  memberCount: group.memberCount,
  machineCount: group.machineCount,
  isMember: group.isMember,
  isLead: group.isLead,
});

const ticket = (over: Partial<WorkingGroupTicket>): WorkingGroupTicket => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8d001',
  groupId: printId,
  groupName: 'Printing',
  kind: 'problem',
  subject: 'Printer jams',
  body: 'It jams at the first layer.',
  blocksUse: false,
  status: 'new',
  author: grace,
  followerCount: 0,
  isFollowing: false,
  isMine: false,
  commentCount: 0,
  inside: true,
  version: 1,
  createdAt: '2026-01-01T10:00:00Z',
  updatedAt: '2026-01-01T10:00:00Z',
  ...over,
});

const todo = (over: Partial<WorkingGroupTodo>): WorkingGroupTodo => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f001',
  groupId: printId,
  groupName: 'Printing',
  title: 'Order nozzles',
  dueOn: addDays(todayOn(), 2),
  columnId: colTodo.id,
  done: false,
  isMine: false,
  commentCount: 0,
  version: 1,
  createdAt: '2026-01-01T10:00:00Z',
  updatedAt: '2026-01-01T10:00:00Z',
  ...over,
});

const inboxTicket = ticket({});
const plannedTicket = ticket({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8d002',
  subject: 'Belt squeaks',
  status: 'planned',
  columnId: colProgress.id,
  dueOn: addDays(todayOn(), 3),
  assignee: ada,
  isMine: true,
  version: 3,
});
const woodTicket = ticket({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8d003',
  groupId: woodId,
  groupName: 'Woodworking',
  subject: 'Saw is blunt',
  inside: false,
});
const lateTodo = todo({ title: 'Clean the bed', dueOn: addDays(todayOn(), -2) });
const nextTodo = todo({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f002',
  title: 'Order nozzles',
  repeatEveryDays: 7,
});

interface Served {
  bodies: Record<string, unknown[]>;
}

function serve(
  permissions: PermissionId[],
  options: { groups?: WorkingGroup[]; tickets?: WorkingGroupTicket[]; todos?: WorkingGroupTodo[] } = {},
): Served {
  const groups = options.groups ?? [printGroup, woodGroup];
  const tickets = options.tickets ?? [inboxTicket, plannedTicket, woodTicket];
  const todos = options.todos ?? [lateTodo, nextTodo];
  const served: Served = { bodies: {} };
  const record = (name: string, body: unknown) => (served.bodies[name] ??= []).push(body);
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/working-groups', () => HttpResponse.json({ items: groups.map(summary) })),
    ...groups.map((group) => http.get(`*/api/v1/working-groups/${group.id}`, () => HttpResponse.json(group))),
    http.get('*/api/v1/working-group-tickets', () => HttpResponse.json({ items: tickets })),
    http.get('*/api/v1/working-group-todos', () => HttpResponse.json({ items: todos })),
    http.get('*/api/v1/working-group-tickets/:id', ({ params }) =>
      HttpResponse.json({
        ticket: tickets.find((candidate) => candidate.id === params.id),
        followers: [],
        comments: [],
      }),
    ),
    http.get('*/api/v1/working-group-todos/:id', ({ params }) =>
      HttpResponse.json({ todo: todos.find((candidate) => candidate.id === params.id), comments: [] }),
    ),
    http.post('*/api/v1/working-group-tickets/:id/plan', async ({ request, params }) => {
      record('plan', await request.json());
      return HttpResponse.json({
        ticket: tickets.find((candidate) => candidate.id === params.id),
        followers: [],
        comments: [],
      });
    }),
    http.post('*/api/v1/working-group-tickets/:id/close', async ({ request, params }) => {
      record('close', await request.json());
      return HttpResponse.json({
        ticket: tickets.find((candidate) => candidate.id === params.id),
        followers: [],
        comments: [],
      });
    }),
    http.patch('*/api/v1/working-group-tickets/:id', async ({ request, params }) => {
      record('patch', await request.json());
      return HttpResponse.json({
        ticket: tickets.find((candidate) => candidate.id === params.id),
        followers: [],
        comments: [],
      });
    }),
    http.put('*/api/v1/working-group-tickets/:id/follow', ({ params }) => {
      record('follow', params.id);
      return HttpResponse.json({
        ticket: tickets.find((candidate) => candidate.id === params.id),
        followers: [],
        comments: [],
      });
    }),
    http.put('*/api/v1/working-groups/:id/columns', async ({ request }) => {
      record('columns', await request.json());
      return HttpResponse.json(printGroup);
    }),
  );
  return served;
}

const readOnly = [PermissionId.working_groupsread];

beforeEach(() => {
  // Wide enough for the side panel (the default test setup answers "does not match").
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

describe('working group tickets and to-dos', () => {
  it('lists the items of the first own group under their headings with counts', async () => {
    serve(readOnly);
    renderRoute(<App />, '/working-groups/tasks');

    expect(await screen.findByRole('heading', { name: 'Tickets & to-dos' })).toBeInTheDocument();
    expect((await screen.findAllByRole('tab')).map((tab) => tab.textContent)).toEqual([
      'All groups',
      'Printing',
      'Woodworking',
    ]);
    expect(await screen.findByRole('button', { name: /Printer jams/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Belt squeaks/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Saw is blunt/ })).not.toBeInTheDocument();

    const summaryCard = screen.getByRole('region', { name: 'Open tickets and to-dos' });
    expect(within(summaryCard).getByText('4')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Inbox/ })).toHaveTextContent('Inbox 1');
    expect(screen.getByRole('heading', { name: /Overdue/ })).toHaveTextContent('Overdue 1');
    expect(screen.getByRole('heading', { name: /This week/ })).toHaveTextContent('This week 2');
    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
  });

  it('filters by a status column and by the Unassigned tile', async () => {
    const user = userEvent.setup();
    serve(readOnly);
    renderRoute(<App />, '/working-groups/tasks');
    await screen.findByRole('button', { name: /Printer jams/ });

    const overdue = screen.getByRole('button', { name: /^1\s*Overdue$/ });
    expect(overdue).toHaveAttribute('aria-pressed', 'false');
    await user.click(overdue);
    expect(overdue).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Clean the bed/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Printer jams/ })).not.toBeInTheDocument();
    await user.click(overdue);

    await user.click(screen.getByRole('button', { name: /^Unassigned/ }));
    expect(screen.getByRole('button', { name: /Printer jams/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Order nozzles/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Belt squeaks/ })).not.toBeInTheDocument();
  });

  it('shows an outside person no to-dos and no New to-do, but lets them follow a ticket', async () => {
    const user = userEvent.setup();
    const served = serve(readOnly, {
      groups: [{ ...printGroup, isMember: false, canEdit: false }, woodGroup],
      tickets: [{ ...inboxTicket, inside: false }],
      todos: [],
    });
    renderRoute(<App />, '/working-groups/tasks');

    expect(await screen.findByRole('button', { name: /Printer jams/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New to-do' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit columns' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write a ticket' })).toBeInTheDocument();
    expect(screen.queryByText(/Order nozzles/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Printer jams/ }));
    expect(screen.queryByRole('button', { name: 'Plan it' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'I have this too' }));
    await waitFor(() => expect(served.bodies.follow).toEqual([inboxTicket.id]));
  });

  it('plans a ticket through the dialog and closes another one as declined only with an answer', async () => {
    const user = userEvent.setup();
    const served = serve(readOnly);
    renderRoute(<App />, '/working-groups/tasks');
    await user.click(await screen.findByRole('button', { name: /Printer jams/ }));

    await user.click(await screen.findByRole('button', { name: 'Plan it' }));
    const plan = await screen.findByRole('dialog', { name: 'Plan it' });
    await user.selectOptions(within(plan).getByLabelText('Column'), colProgress.id);
    await user.click(within(plan).getByRole('button', { name: 'Plan it' }));
    await waitFor(() =>
      expect(served.bodies.plan).toEqual([
        { columnId: colProgress.id, assigneePersonId: fixturePersonId, dueOn: addDays(todayOn(), 7) },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Plan it' })).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Answer and close' }));
    const close = await screen.findByRole('dialog', { name: 'Answer and close' });
    await user.click(within(close).getByLabelText('Declined'));
    await user.click(within(close).getByRole('button', { name: 'Close the ticket' }));
    expect(await within(close).findByText('Write an answer when you decline.')).toBeInTheDocument();
    expect(served.bodies.close).toBeUndefined();

    await user.type(within(close).getByLabelText(/Answer for Grace/), 'Out of scope.');
    await user.click(within(close).getByRole('button', { name: 'Close the ticket' }));
    await waitFor(() => expect(served.bodies.close).toEqual([{ outcome: 'declined', answer: 'Out of scope.' }]));
  });

  it('sends the expected version with an inline assignee change', async () => {
    const user = userEvent.setup();
    const served = serve(readOnly);
    renderRoute(<App />, '/working-groups/tasks');
    await user.click(await screen.findByRole('button', { name: /Belt squeaks/ }));

    await user.selectOptions(await screen.findByLabelText('Who'), otherPersonId);
    await waitFor(() => expect(served.bodies.patch).toEqual([{ expectedVersion: 3, assigneePersonId: otherPersonId }]));
  });

  it('saves the reordered columns from the dialog', async () => {
    const user = userEvent.setup();
    const served = serve(readOnly);
    renderRoute(<App />, '/working-groups/tasks');
    await screen.findByRole('button', { name: /Printer jams/ });

    await user.click(await screen.findByRole('button', { name: 'Edit columns' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit columns' });
    expect(within(dialog).getByText('Inbox and Done are fixed.')).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole('button', { name: 'Move up' })[1]);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(served.bodies.columns).toEqual([
        {
          columns: [
            { id: colProgress.id, name: 'In progress' },
            { id: colTodo.id, name: 'To do' },
          ],
        },
      ]),
    );
  });

  it('offers the board on a group tab only', async () => {
    const user = userEvent.setup();
    serve(readOnly);
    const { router } = renderRoute(<App />, '/working-groups/tasks');
    await screen.findByRole('button', { name: /Printer jams/ });
    expect(screen.getByRole('button', { name: 'Board view' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Board view' }));
    expect(await screen.findByRole('group', { name: 'Board' })).toBeInTheDocument();
    expect(router.state.location.search).toContain('view=board');

    await user.click(screen.getByRole('tab', { name: 'All groups' }));
    expect(await screen.findByRole('button', { name: /Saw is blunt/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Board view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Board' })).not.toBeInTheDocument();
  });
});
