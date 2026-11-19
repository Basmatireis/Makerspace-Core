import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  WorkingGroup,
  WorkingGroupComment,
  WorkingGroupNote,
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
const machineId = '0192f6f8-743e-7c77-a349-cd07c3e8e101';
const placeId = '0192f6f8-743e-7c77-a349-cd07c3e8e201';
const ada = { personId: fixturePersonId, displayName: 'Ada Lovelace' };
const grace = { personId: otherPersonId, displayName: 'Grace Hopper' };

const group = (over: Partial<WorkingGroup> = {}): WorkingGroup => ({
  id: printId,
  name: 'Printing',
  description: 'Looks after the 3D printers.',
  lead: grace,
  memberCount: 2,
  machineCount: 1,
  isMember: true,
  isLead: false,
  openTicketCount: 1,
  openTodoCount: 3,
  version: 4,
  members: [
    { personId: otherPersonId, displayName: 'Grace Hopper', isLead: true, joinedAt: '2026-01-01T00:00:00Z' },
    { personId: fixturePersonId, displayName: 'Ada Lovelace', isLead: false, joinedAt: '2026-01-02T00:00:00Z' },
  ],
  machines: [{ id: machineId, name: 'Prusa CORE One', status: 'limited', note: 'Nozzle worn', until: '2026-12-03' }],
  places: [{ id: placeId, name: 'Filament shelf' }],
  columns: [],
  canEdit: false,
  canManage: false,
  ...over,
});

const ticket: WorkingGroupTicket = {
  id: '0192f6f8-743e-7c77-a349-cd07c3e8d001',
  groupId: printId,
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
  commentCount: 4,
  inside: true,
  version: 1,
  createdAt: '2026-01-01T10:00:00Z',
  updatedAt: '2026-01-01T10:00:00Z',
};
const todo = (over: Partial<WorkingGroupTodo>): WorkingGroupTodo => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f001',
  groupId: printId,
  groupName: 'Printing',
  title: 'Order nozzles',
  dueOn: addDays(todayOn(), 2),
  columnId: '0192f6f8-743e-7c77-a349-cd07c3e8c001',
  done: false,
  isMine: false,
  commentCount: 0,
  version: 1,
  createdAt: '2026-01-01T10:00:00Z',
  updatedAt: '2026-01-01T10:00:00Z',
  createdBy: grace,
  ...over,
});
const unassignedTodo = todo({});
const overdueTodo = todo({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f002',
  title: 'Clean the bed',
  dueOn: addDays(todayOn(), -2),
  assignee: ada,
});
const laterTodo = todo({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f003',
  title: 'Sort screws',
  dueOn: addDays(todayOn(), 20),
  assignee: grace,
});

const comment = (n: number): WorkingGroupComment => ({
  id: `0192f6f8-743e-7c77-a349-cd07c3e8a00${n}`,
  author: n % 2 ? ada : grace,
  text: `Comment number ${n}`,
  internal: false,
  createdAt: '2026-01-02T10:00:00Z',
});

const note = (over: Partial<WorkingGroupNote>): WorkingGroupNote => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8b001',
  groupId: printId,
  groupName: 'Printing',
  public: false,
  text: 'Team meeting on Friday',
  createdAt: '2026-02-01T10:00:00Z',
  author: grace,
  canDelete: true,
  ...over,
});
const groupNote = note({});
const publicNote = note({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8b002',
  public: true,
  text: 'Printer room closed on Monday',
  createdAt: '2026-03-01T10:00:00Z',
  canDelete: false,
});

function serve(options: { group?: WorkingGroup; notes?: WorkingGroupNote[]; permissions?: PermissionId[] } = {}) {
  const detail = options.group ?? group();
  const bodies: Record<string, unknown[]> = {};
  const record = (name: string, body: unknown) => (bodies[name] ??= []).push(body);
  server.use(
    http.get('*/api/v1/auth/me', () =>
      HttpResponse.json(currentUserFixture(options.permissions ?? [PermissionId.working_groupsread])),
    ),
    http.get('*/api/v1/working-groups', () => HttpResponse.json({ items: [detail] })),
    http.get(`*/api/v1/working-groups/${printId}`, () => HttpResponse.json(detail)),
    http.get('*/api/v1/working-group-tickets', () => HttpResponse.json({ items: [ticket] })),
    http.get('*/api/v1/working-group-todos', () =>
      HttpResponse.json({ items: detail.isMember ? [unassignedTodo, overdueTodo, laterTodo] : [] }),
    ),
    http.get('*/api/v1/working-group-tickets/:id', () =>
      HttpResponse.json({ ticket, followers: [], comments: [1, 2, 3, 4].map(comment) }),
    ),
    http.get('*/api/v1/working-group-notes', () =>
      HttpResponse.json({ items: options.notes ?? [publicNote, groupNote] }),
    ),
    http.get('*/api/v1/working-group-status', () =>
      HttpResponse.json({
        items: [
          {
            kind: 'machine',
            id: machineId,
            name: 'Prusa CORE One',
            group: { id: printId, name: 'Printing' },
            status: 'limited',
            daysNotOkLast90: 9,
          },
          {
            kind: 'place',
            id: placeId,
            name: 'Filament shelf',
            group: { id: printId, name: 'Printing' },
            status: 'ok',
            daysNotOkLast90: 0,
          },
        ],
      }),
    ),
    http.post('*/api/v1/working-group-notes', async ({ request }) => {
      record('note', await request.json());
      return HttpResponse.json(groupNote, { status: 201 });
    }),
    http.put(`*/api/v1/working-groups/${printId}/machines/${machineId}/status`, async ({ request }) => {
      record('status', await request.json());
      return HttpResponse.json(detail);
    }),
  );
  return bodies;
}

/** Icon-only buttons are named by their tooltip text; the button sits next to it. */
const removeButton = (label: HTMLElement) =>
  label.closest('.cds--popover-container')?.querySelector('button') as HTMLButtonElement;

describe('working group overview for people inside', () => {
  it('shows the stat tiles and the pinboard in order, with the last comments under a row', async () => {
    serve();
    renderRoute(<App />, '/working-groups');

    const table = await screen.findByRole('table', { name: 'Group pinboard' });
    await within(table).findByText('Comment number 4');
    const kinds = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '');
    const order = [
      'Unassigned ticket',
      'Unassigned to-do',
      'Overdue to-do',
      'Team meeting on Friday',
      'Printer room closed on Monday',
    ];
    // Group note (Feb) is older than the public note (Mar): newest first.
    const expected = [
      'Unassigned ticket',
      'Unassigned to-do',
      'Overdue to-do',
      'Printer room closed on Monday',
      'Team meeting on Friday',
    ];
    expect(order).toHaveLength(expected.length);
    expected.forEach((text, index) => expect(kinds[index]).toContain(text));
    expect(kinds).toHaveLength(5);

    // Four comments: the last three show, the first one is an "earlier" link.
    expect(within(table).getByRole('link', { name: '1 earlier comment' })).toHaveAttribute(
      'href',
      expect.stringContaining('/working-groups/tasks?group=' + printId),
    );
    expect(within(table).queryByText(/Comment number 1/)).not.toBeInTheDocument();
    expect(within(table).getByText(/Comment number 2/)).toBeInTheDocument();

    expect(screen.getByText('Open tickets')).toBeInTheDocument();
    expect(screen.getByText('Open to-dos')).toBeInTheDocument();
    expect(screen.getByText('Machines, last 90 days')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /9 days of 90 not working/ })).toBeInTheDocument();
    expect(screen.getByText('Lead: Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText(/back around 3 Dec/)).toBeInTheDocument();
  });

  it('shows Remove only on notes the caller may remove', async () => {
    serve();
    renderRoute(<App />, '/working-groups');
    const table = await screen.findByRole('table', { name: 'Group pinboard' });
    await within(table).findByText('Team meeting on Friday');
    expect(within(table).getAllByText('Remove note')).toHaveLength(1);
  });

  it('asks before removing the note of somebody else', async () => {
    const user = userEvent.setup();
    serve();
    let removed = 0;
    server.use(
      http.delete('*/api/v1/working-group-notes/:id', () => {
        removed += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderRoute(<App />, '/working-groups');
    const table = await screen.findByRole('table', { name: 'Group pinboard' });
    await user.click(removeButton(await within(table).findByText('Remove note')));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Team meeting on Friday');
    expect(removed).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removed).toBe(1));
  });

  it('removes the own note without asking', async () => {
    const user = userEvent.setup();
    serve({ notes: [note({ author: ada })] });
    let removed = 0;
    server.use(
      http.delete('*/api/v1/working-group-notes/:id', () => {
        removed += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderRoute(<App />, '/working-groups');
    const table = await screen.findByRole('table', { name: 'Group pinboard' });
    await user.click(removeButton(await within(table).findByText('Remove note')));
    await waitFor(() => expect(removed).toBe(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('pins a note for everyone', async () => {
    const user = userEvent.setup();
    const bodies = serve();
    renderRoute(<App />, '/working-groups');
    await user.click(await screen.findByRole('button', { name: 'Pin a note' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Note'), 'Bring your own gloves');
    await user.click(within(dialog).getByLabelText('Everyone'));
    await user.click(within(dialog).getByRole('button', { name: 'Pin' }));
    await waitFor(() =>
      expect(bodies.note).toEqual([{ groupId: printId, public: true, text: 'Bring your own gloves' }]),
    );
  });

  it('changes a status and hides the note field for Working', async () => {
    const user = userEvent.setup();
    const bodies = serve();
    renderRoute(<App />, '/working-groups');
    await user.click(await screen.findByRole('button', { name: 'Change status of Prusa CORE One' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Note')).toHaveValue('Nozzle worn');

    await user.click(within(dialog).getByLabelText('Working'));
    expect(within(dialog).queryByLabelText('Note')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Back around')).not.toBeInTheDocument();

    await user.click(within(dialog).getByLabelText('Maintenance'));
    const noteField = within(dialog).getByLabelText('Note');
    await user.clear(noteField);
    await user.type(noteField, 'New hotend');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies.status).toHaveLength(1));
    expect(bodies.status[0]).toMatchObject({ status: 'maintenance', note: 'New hotend' });
  });
});

describe('working group overview for people outside', () => {
  const outside = group({ isMember: false, memberCount: 2, openTicketCount: undefined, openTodoCount: undefined });

  it('shows only public notes, no stat row and a way to write a ticket', async () => {
    serve({ group: outside });
    renderRoute(<App />, '/working-groups');

    const table = await screen.findByRole('table', { name: 'Notes from this group' });
    await within(table).findByText('Printer room closed on Monday');
    expect(within(table).queryByText('Team meeting on Friday')).not.toBeInTheDocument();
    expect(screen.queryByText('Open tickets')).not.toBeInTheDocument();
    expect(screen.queryByText('Machines, last 90 days')).not.toBeInTheDocument();
    expect(screen.getByText('Looks after the 3D printers.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pin a note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Change status of/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write a ticket' })).toBeInTheDocument();
  });
});
