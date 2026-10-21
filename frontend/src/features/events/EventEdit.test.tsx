import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import type { Event } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { eventFixture, eventId, helpersFixture, sessionFixture, shiftFixture, shiftId } from './testData';

const organizer = [
  PermissionId.eventsread,
  PermissionId.eventsmanage,
  PermissionId.eventsstaffingmanage,
  PermissionId.eventsassign,
];

function mockEdit(permissions: PermissionId[], event: Event = eventFixture()) {
  const requests: URL[] = [];
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get(`*/api/v1/events/${eventId}`, () => HttpResponse.json(event)),
    http.get(`*/api/v1/events/${eventId}/sessions`, () => HttpResponse.json({ items: [sessionFixture()] })),
    http.get(`*/api/v1/events/${eventId}/shifts`, () => HttpResponse.json({ items: [shiftFixture()] })),
    http.get(`*/api/v1/events/${eventId}/helpers`, ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json(helpersFixture());
    }),
    http.get(`*/api/v1/events/${eventId}/task-lists`, () =>
      HttpResponse.json({
        items: [
          {
            id: 'list-1',
            eventId,
            name: 'Before the event',
            description: null,
            sortOrder: 0,
            version: 1,
            createdAt: '2026-10-04T12:00:00Z',
            updatedAt: '2026-10-04T12:00:00Z',
          },
        ],
      }),
    ),
    http.get(`*/api/v1/events/${eventId}/tasks`, ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json({
        items: [
          {
            id: 'task-1',
            eventId,
            taskListId: 'list-1',
            title: 'Order posters',
            description: null,
            status: 'open',
            important: true,
            assigneePersonId: null,
            dueAt: '2026-10-01T10:00:00Z',
            sortOrder: 0,
            completedAt: null,
            completedByAccountId: null,
            version: 1,
            createdAt: '2026-10-04T12:00:00Z',
            updatedAt: '2026-10-04T12:00:00Z',
          },
        ],
      });
    }),
    http.get(`*/api/v1/events/${eventId}/files`, () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/event-eligibility-roles', () =>
      HttpResponse.json({ items: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8b030', name: 'First aider' }] }),
    ),
    http.get('*/api/v1/event-people', () => HttpResponse.json({ items: [] })),
  );
  return requests;
}

// The page settles once its queries are in; a row menu opened before that can be replaced by the re-render.
async function openMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  await screen.findByLabelText(label, { selector: 'button' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await user.click(screen.getByLabelText(label, { selector: 'button' }));
}

describe('Event edit mode', () => {
  it('shows the tabs a person may use and falls back for the rest', async () => {
    mockEdit(organizer);
    const first = renderRoute(<App />, `/events/${eventId}?mode=edit`);
    expect(await screen.findByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    for (const name of ['Programme', 'Helpers', 'Tasks', 'Public page', 'Files']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    first.unmount();

    mockEdit([PermissionId.eventsread, PermissionId.eventsassign]);
    renderRoute(<App />, `/events/${eventId}?mode=edit&tab=tasks`);
    expect(await screen.findByRole('tab', { name: 'Helpers' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Tasks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Programme' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps people without an organizer permission in the participant view', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventssignup])),
      ),
      http.get(`*/api/v1/events/${eventId}`, () => HttpResponse.json(eventFixture())),
      http.get(`*/api/v1/events/${eventId}/participation`, () =>
        HttpResponse.json({
          eventId,
          status: 'confirmed',
          canSignup: true,
          canSeeNames: false,
          myAssignments: [],
          sessions: [],
          shifts: [],
        }),
      ),
    );
    renderRoute(<App />, `/events/${eventId}?mode=edit`);
    expect(await screen.findByText('Your shifts')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Overview' })).not.toBeInTheDocument();
  });

  it('turns the server readiness into next steps and a Go live checklist', async () => {
    const draft = eventFixture({
      status: 'draft',
      ownerPersonId: null,
      ownerName: null,
      publicTitle: null,
      isPublic: false,
      publicSignupEnabled: false,
      goLive: {
        publicPage: { state: 'off', unmet: ['owner_missing', 'public_title_missing'] },
        helperSignup: {
          state: 'off',
          opensAt: null,
          unmet: ['public_page_off', 'signup_disabled', 'event_not_confirmed'],
        },
        shifts: { accepting: 0, total: 1, notPublic: 0 },
        confirmUnmet: ['owner_missing'],
      },
    });
    mockEdit(organizer, draft);
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?mode=edit`);
    expect(await screen.findByText('Assign an owner')).toBeInTheDocument();
    expect(screen.getByText('Add a public title')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go live' }));
    const panel = await screen.findByRole('heading', { name: 'Go live' });
    expect(panel).toBeInTheDocument();
    expect(screen.getByText('An owner is assigned')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Public page' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Helper signup' })).toBeDisabled();
    expect(screen.getAllByText('The switch stays off until every item is done.')).toHaveLength(2);
  });

  it('switches the public page off and rotates nothing without confirmation', async () => {
    mockEdit(organizer);
    let unpublished: unknown;
    server.use(
      http.post(`*/api/v1/events/${eventId}/unpublish`, async ({ request }) => {
        unpublished = await request.json();
        return HttpResponse.json(eventFixture({ isPublic: false }));
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?mode=edit`);
    await user.click(await screen.findByRole('button', { name: 'Public link & signup' }));
    const toggle = await screen.findByRole('switch', { name: 'Public page' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(unpublished).toEqual({ expectedVersion: 3 }));
    await user.click(screen.getByRole('button', { name: 'Rotate link' }));
    expect(await screen.findByRole('heading', { name: 'Rotate public link' })).toBeInTheDocument();
  });

  it('blocks confirming an incomplete draft and explains why', async () => {
    mockEdit(
      organizer,
      eventFixture({
        status: 'draft',
        goLive: { ...eventFixture().goLive, confirmUnmet: ['owner_missing', 'programme_missing'] },
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?mode=edit`);
    await user.click((await screen.findAllByRole('button', { name: 'Confirm event' }))[0]);
    expect(
      await screen.findByText(/Before confirming: an owner is assigned and at least one session or shift exists/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Confirm event' }).at(-1)).toBeDisabled();
  });

  it('explains why an event with history cannot be deleted', async () => {
    mockEdit(organizer, eventFixture({ status: 'draft', hasAssignmentHistory: true }));
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?mode=edit`);
    await user.click(await screen.findByLabelText('Event actions', { selector: 'button' }));
    await user.click(await screen.findByText('Delete event'));
    expect(await screen.findByText(/assignment history/)).toBeInTheDocument();
  });

  it('saves a shift with its positions in one request and rejects duplicate names', async () => {
    mockEdit(organizer);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`*/api/v1/events/${eventId}/shifts`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(shiftFixture(), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?mode=edit&tab=programme`);
    await user.click((await screen.findAllByRole('button', { name: 'Add shift' }))[0]);
    await user.type(await screen.findByLabelText('Name', { exact: true }), 'Kitchen');
    await user.click(screen.getByRole('button', { name: 'Add position' }));
    await user.click(screen.getByRole('button', { name: 'Add position' }));
    const names = screen.getAllByLabelText(/Name of position/);
    await user.type(names[0], 'Cook');
    await user.type(names[1], 'cook');
    await user.click(screen.getAllByRole('button', { name: 'Add shift' }).at(-1)!);
    expect((await screen.findAllByText('Position names must be different.')).length).toBeGreaterThan(0);
    expect(body).toBeUndefined();
    await user.clear(names[1]);
    await user.type(names[1], 'Dishes');
    await user.click(screen.getAllByRole('button', { name: 'Add shift' }).at(-1)!);
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      name: 'Kitchen',
      status: 'draft',
      isPublic: false,
      requirements: [
        { id: null, name: 'Cook', requiredCount: 1, eligibilityMode: 'anyone', eligibleRoleIds: [] },
        { id: null, name: 'Dishes', requiredCount: 1, eligibilityMode: 'anyone', eligibleRoleIds: [] },
      ],
    });
  });

  it('keeps positions that already have helpers from being removed', async () => {
    mockEdit(organizer);
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?mode=edit&tab=programme`);
    await openMenu(user, 'Actions for shift Bar');
    await user.click(await screen.findByText('Edit', { exact: true }));
    const remove = await screen.findAllByLabelText('Has helpers and cannot be removed', { selector: 'button' });
    expect(remove.length).toBe(2);
    expect(remove[0]).toBeDisabled();
  });

  it('duplicates a shift through the shift menu', async () => {
    mockEdit(organizer);
    let duplicated = false;
    server.use(
      http.post(`*/api/v1/events/${eventId}/shifts/${shiftId}/duplicate`, () => {
        duplicated = true;
        return HttpResponse.json(shiftFixture(), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?mode=edit&tab=programme`);
    await openMenu(user, 'Actions for shift Bar');
    await user.click(await screen.findByText('Duplicate'));
    await waitFor(() => expect(duplicated).toBe(true));
  });

  it('shows helpers by shift with open places, and counts only without a names permission', async () => {
    const requests = mockEdit(organizer);
    const user = userEvent.setup();
    const first = renderRoute(<App />, `/events/${eventId}?mode=edit&tab=helpers`);
    expect(await screen.findByText('Alan Turing')).toBeInTheDocument();
    expect(screen.getAllByText('Open place').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Assign' }).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('tab', { name: 'By helper' }));
    expect(await screen.findByRole('table', { name: 'Helpers' })).toBeInTheDocument();
    first.unmount();

    requests.length = 0;
    mockEdit([PermissionId.eventsread, PermissionId.eventsmanage]);
    renderRoute(<App />, `/events/${eventId}?mode=edit&tab=helpers`);
    expect(await screen.findByText('Counts only')).toBeInTheDocument();
    expect(screen.queryByText('Alan Turing')).not.toBeInTheDocument();
    expect(requests.some((url) => url.pathname.endsWith('/helpers'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Assign helper' })).not.toBeInTheDocument();
  });

  it('filters tasks on the server and marks overdue ones', async () => {
    const requests = mockEdit(organizer);
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?mode=edit&tab=tasks`);
    expect(await screen.findByText('Order posters')).toBeInTheDocument();
    expect(screen.getByText(/Overdue/, { selector: 'span.ev-overdue' })).toBeInTheDocument();
    expect(screen.getAllByText('Important').length).toBeGreaterThan(1);
    await user.click(screen.getByLabelText('Mine'));
    await user.click(screen.getByLabelText('Overdue'));
    await user.click(screen.getByLabelText('Show done'));
    await waitFor(() => {
      const last = requests.filter((url) => url.pathname.endsWith('/tasks')).at(-1);
      expect(last?.searchParams.get('mine')).toBe('true');
      expect(last?.searchParams.get('overdue')).toBe('true');
      expect(last?.searchParams.get('includeDone')).toBe('false');
    });
  });

  it('shows the assignee name of a task', async () => {
    mockEdit(organizer);
    server.use(
      http.get(`*/api/v1/events/${eventId}/tasks`, () =>
        HttpResponse.json({
          items: [
            {
              id: 'task-2',
              eventId,
              taskListId: 'list-1',
              title: 'Book the van',
              description: null,
              status: 'open',
              important: false,
              assigneePersonId: '0192f6f8-743e-7c77-a349-cd07c3e8b031',
              assigneeName: 'Robin Example',
              dueAt: null,
              sortOrder: 0,
              completedAt: null,
              completedByAccountId: null,
              version: 1,
              createdAt: '2026-10-04T12:00:00Z',
              updatedAt: '2026-10-04T12:00:00Z',
            },
          ],
        }),
      ),
    );
    renderRoute(<App />, `/events/${eventId}?mode=edit&tab=tasks`);
    expect(await screen.findByText('Book the van')).toBeInTheDocument();
    expect(screen.getByText('Robin Example')).toBeInTheDocument();
  });

  it('ticks a task done with the full task body and its version', async () => {
    mockEdit(organizer);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch(`*/api/v1/events/${eventId}/tasks/task-1`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?mode=edit&tab=tasks`);
    await user.click(await screen.findByLabelText('Done: Order posters'));
    await waitFor(() =>
      expect(body).toMatchObject({ status: 'done', title: 'Order posters', important: true, expectedVersion: 1 }),
    );
  });

  it('previews the public page with the typed title', async () => {
    mockEdit(organizer);
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?mode=edit&tab=public`);
    const title = await screen.findByLabelText('Public title');
    await user.clear(title);
    await user.type(title, 'Autumn fair');
    expect(await screen.findByRole('heading', { name: 'Autumn fair' })).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Help us' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Signed-in member' }));
    expect(screen.getByRole('tab', { name: 'Signed-in member' })).toHaveAttribute('aria-selected', 'true');
  });
});
