import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { assignmentId, eventFixture, eventId, participationFixture, positionId, shiftId } from './testData';

const member = [PermissionId.eventsread, PermissionId.eventssignup];

function mockEvent(permissions: PermissionId[], participation = participationFixture(), event = eventFixture()) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get(`*/api/v1/events/${eventId}`, () => HttpResponse.json(event)),
    http.get(`*/api/v1/events/${eventId}/participation`, () => HttpResponse.json(participation)),
  );
}

const mine = {
  assignmentId,
  shiftId,
  requirementId: positionId,
  shiftName: 'Bar',
  requirementName: 'Bartender',
  startsAt: '2026-11-02T16:00:00Z',
  endsAt: '2026-11-02T20:00:00Z',
  shiftStatus: 'open' as const,
  version: 7,
  canLeave: true,
};

describe('Event participant view', () => {
  it('shows the programme by day with fill counts and why a position cannot be joined', async () => {
    mockEvent(member);
    renderRoute(<App />, `/events/${eventId}`);
    expect(await screen.findByRole('heading', { name: 'Autumn exhibition' })).toBeInTheDocument();
    const bar = await screen.findByRole('table', { name: 'Positions of Bar' });
    expect(within(bar).getByText('1 of 3')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Join' })).toBeInTheDocument();
    expect(within(bar).getByText('Members with role First aider only')).toBeInTheDocument();
    expect(screen.getByText('Exhibition')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit event' })).not.toBeInTheDocument();
  });

  it('joins a place and reports a full position', async () => {
    mockEvent(member);
    let joined = 0;
    server.use(
      http.post(`*/api/v1/events/${eventId}/shifts/${shiftId}/requirements/${positionId}/join`, () => {
        joined += 1;
        return joined === 1
          ? HttpResponse.json(mine, { status: 201 })
          : HttpResponse.json({ code: 'requirement_full', message: 'Full' }, { status: 409 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}`);
    await user.click(await screen.findByRole('button', { name: 'Join' }));
    await waitFor(() => expect(joined).toBe(1));
    await user.click(await screen.findByRole('button', { name: 'Join' }));
    expect(await screen.findByText('This position was just filled by someone else.')).toBeInTheDocument();
  });

  it('asks for confirmation before leaving and sends the assignment version', async () => {
    const participation = participationFixture({ myAssignments: [mine] });
    participation.shifts[0].positions[0].myAssignmentId = assignmentId;
    participation.shifts[0].positions[0].joinable = false;
    mockEvent(member, participation);
    let body: unknown;
    server.use(
      http.post(`*/api/v1/events/${eventId}/assignments/${assignmentId}/leave`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}`);
    const yours = await screen.findByRole('table', { name: 'Your shifts' });
    await user.click(within(yours).getByRole('button', { name: 'Leave' }));
    expect(await screen.findByRole('heading', { name: 'Leave shift?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave shift' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: 7 }));
  });

  it('shows helper names only when the server sent them', async () => {
    const participation = participationFixture({ canSeeNames: true });
    participation.shifts[0].positions[0].helpers = [
      { displayName: 'Alan Turing', isMe: false },
      { displayName: 'Ada Lovelace', isMe: true },
    ];
    mockEvent([...member, PermissionId.eventsread_assignments], participation);
    renderRoute(<App />, `/events/${eventId}`);
    expect(await screen.findByText('Alan Turing, You')).toBeInTheDocument();
  });

  it('lets an assign-only coordinator assign open places but not join', async () => {
    mockEvent([PermissionId.eventsread, PermissionId.eventsassign], participationFixture({ canSignup: false }));
    renderRoute(<App />, `/events/${eventId}`);
    const bar = await screen.findByRole('table', { name: 'Positions of Bar' });
    expect(within(bar).getAllByRole('button', { name: 'Assign' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Manage helpers' })).toHaveAttribute(
      'href',
      `/events/${eventId}?mode=edit&tab=helpers`,
    );
    expect(screen.queryByRole('link', { name: 'Edit event' })).not.toBeInTheDocument();
  });

  it('offers organizers the edit mode and marks drafts and closed events', async () => {
    mockEvent(
      [PermissionId.eventsread, PermissionId.eventsmanage],
      participationFixture({ status: 'draft' }),
      eventFixture({ status: 'draft' }),
    );
    renderRoute(<App />, `/events/${eventId}`);
    expect(await screen.findByRole('link', { name: 'Edit event' })).toHaveAttribute(
      'href',
      `/events/${eventId}?mode=edit`,
    );
    expect(screen.getByText('This event is a draft')).toBeInTheDocument();
  });

  it('shows closed events as read-only without Join or Leave', async () => {
    const participation = participationFixture({
      status: 'completed',
      myAssignments: [{ ...mine, canLeave: false, leaveBlockedReason: 'event_closed' }],
    });
    participation.shifts[0].positions[0].joinable = false;
    participation.shifts[0].positions[0].reason = 'closed';
    mockEvent(member, participation, eventFixture({ status: 'completed' }));
    renderRoute(<App />, `/events/${eventId}`);
    expect(await screen.findByText('This event is completed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave' })).not.toBeInTheDocument();
  });
});
