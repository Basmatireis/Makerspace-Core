import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { eventMutationMessage } from './errors';

const publicId = 'A'.repeat(43);
const shiftId = '0192f6f8-743e-7c77-a349-cd07c3e8b001';
const requirementId = '0192f6f8-743e-7c77-a349-cd07c3e8b002';
const eventId = '0192f6f8-743e-7c77-a349-cd07c3e8b010';

function eventFixture(status: 'draft' | 'planning' | 'confirmed' | 'completed' | 'cancelled' | 'archived' = 'planning') {
  return {
    id: eventId, name: 'Autumn exhibition', internalDescription: 'Internal plan', location: 'Main workshop',
    ownerPersonId: null, ownerName: null, status, publicTitle: null, publicDescription: null, publicLocation: null,
    publicId, isPublic: false, publicSignupEnabled: false, hasBanner: false, closedAt: null,
    rangeStartsAt: '2026-11-02T16:00:00Z', rangeEndsAt: '2026-11-02T22:00:00Z', taskTotal: 4,
    taskCompleted: 2, filledCount: 2, requiredCount: 4, nextDeadline: null, nextScheduleAt: '2026-11-02T16:00:00Z',
    version: 1, createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z',
  };
}

const publicEvent = {
  publicId,
  title: 'Public exhibition',
  description: 'What visitors may see.',
  location: 'Main workshop',
  status: 'planning',
  timeZone: 'Europe/Vienna',
  publicSignupEnabled: true,
  hasBanner: true,
  sessions: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8b003', name: 'Opening', location: 'Hall', description: null, startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T22:00:00Z' }],
  shifts: [{ id: shiftId, sessionId: null, name: 'Setup', description: 'Prepare the room.', startsAt: '2026-11-02T14:00:00Z', endsAt: '2026-11-02T16:00:00Z', requirements: [{ id: requirementId, name: 'Helper', description: null, requiredCount: 4, filledCount: 2, remainingCount: 2, availability: 'available' }] }],
  files: [],
};

afterEach(() => window.history.replaceState(null, '', '/'));

describe('Event pages', () => {
  it('shows actionable Event validation and stale-write messages', () => {
    expect(eventMutationMessage(new ApiError(422, {
      code: 'validation_failed',
      message: 'Add a public shift with at least one requirement before enabling public signup',
      requestId: 'request-1',
    }))).toBe('Add a public shift with at least one requirement before enabling public signup');
    expect(eventMutationMessage(new ApiError(409, {
      code: 'stale_write',
      message: 'Resource changed',
      requestId: 'request-2',
    }))).toBe('This event changed in another session. Reload it before saving again.');
  });

  it('shows Events navigation with any Event permission', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.eventsread]))),
      http.get('*/api/v1/events', () => HttpResponse.json({ items: [{
        id: '0192f6f8-743e-7c77-a349-cd07c3e8b010', name: 'Autumn exhibition', internalDescription: null,
        location: 'Main workshop', ownerPersonId: null, ownerName: null, status: 'planning', publicTitle: null,
        publicDescription: null, publicLocation: null, publicId, isPublic: false, publicSignupEnabled: false, hasBanner: true,
        closedAt: null, rangeStartsAt: '2026-11-02T16:00:00Z', rangeEndsAt: '2026-11-02T22:00:00Z',
        taskTotal: 4, taskCompleted: 2, filledCount: 2, requiredCount: 4, nextDeadline: null,
        nextScheduleAt: '2026-11-02T16:00:00Z', version: 1, createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z',
      }] })),
    );
    const { container } = renderRoute(<App />, '/events');
    expect(await screen.findByRole('heading', { name: 'Events' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Events' })).toHaveAttribute('href', '/events');
    expect(await screen.findByRole('link', { name: 'Autumn exhibition' })).toHaveAttribute('href', `/events/0192f6f8-743e-7c77-a349-cd07c3e8b010`);
    expect(container.querySelector('.events-table__name img')).toHaveAttribute('src', expect.stringContaining(`/api/v1/events/0192f6f8-743e-7c77-a349-cd07c3e8b010/banner`));
    expect(screen.getByText('2 Nov 2026')).toBeInTheDocument();
    expect(screen.getByText('17:00–23:00')).toBeInTheDocument();
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
    expect(screen.getByLabelText('Events table toolbar')).toContainElement(screen.getByRole('searchbox', { name: 'Search events' }));
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create event' })).not.toBeInTheDocument();
  });

  it('restores the overview state and focus when the create modal closes', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventsmanage]))),
      http.get('*/api/v1/events', () => HttpResponse.json({ items: [eventFixture('draft')] })),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/events');
    const search = await screen.findByRole('searchbox', { name: 'Search events' });
    await user.type(search, 'Autumn');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    expect(await screen.findByRole('heading', { name: 'Create event' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search events' })).toHaveValue('Autumn');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/events'));
    expect(screen.getByRole('searchbox', { name: 'Search events' })).toHaveValue('Autumn');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create event' })).toHaveFocus());
  });

  it('keeps the create modal behind one discard dialog and reports assignment-history conflicts', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventsmanage]))),
      http.get('*/api/v1/events', () => HttpResponse.json({ items: [eventFixture('draft')] })),
      http.delete(`*/api/v1/events/${eventId}`, () => HttpResponse.json({ code: 'event_has_assignment_history', message: 'Conflict', requestId: 'delete-event' }, { status: 409 })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/events');
    await screen.findByRole('heading', { name: 'Events' });
    for (const name of ['Name', 'Status', 'Location', 'Staffing', 'Owner', 'Actions']) {
      expect(await screen.findByRole('columnheader', { name: new RegExp(`${name}$`) })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await user.type(await screen.findByLabelText('Internal event name'), 'Volunteer day');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Your changes have not been saved.')).toBeInTheDocument();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Internal event name')).toHaveValue('Volunteer day');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    await user.click(await screen.findByRole('button', { name: 'Delete event' }));
    expect(await screen.findByText(/assignment history and cannot be deleted/i)).toBeInTheDocument();
  });

  it('guards dirty Settings during same-path tab navigation and preserves unrelated query parameters', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventsmanage, PermissionId.eventsstaffingmanage, PermissionId.eventsassign]))),
      http.get(`*/api/v1/events/${eventId}`, () => HttpResponse.json(eventFixture('planning'))),
      http.get('*/api/v1/event-people', () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/files`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/sessions`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/shifts`, () => HttpResponse.json({ items: [] })),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, `/events/${eventId}?view=compact&tab=settings`);
    const name = await screen.findByLabelText('Internal name');
    await user.clear(name);
    await user.type(name, 'Unsaved exhibition');
    await user.click(screen.getByRole('tab', { name: 'Schedule' }));
    expect(await screen.findByText('Your changes have not been saved.')).toBeInTheDocument();
    expect(router.state.location.search).toContain('tab=settings');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Internal name')).toHaveValue('Unsaved exhibition');
    await user.click(screen.getByRole('tab', { name: 'Schedule' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByRole('heading', { name: 'Schedule' })).toBeInTheDocument();
    expect(router.state.location.search).toContain('view=compact');
    expect(router.state.location.search).toContain('tab=schedule');
  });

  it('guards a selected banner and keeps the Settings draft across the banner version refresh', async () => {
    let currentEvent = eventFixture('planning');
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventsmanage]))),
      http.get(`*/api/v1/events/${eventId}`, () => HttpResponse.json(currentEvent)),
      http.get('*/api/v1/event-people', () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/files`, () => HttpResponse.json({ items: [] })),
      http.post(`*/api/v1/events/${eventId}/files`, () => {
        currentEvent = { ...currentEvent, hasBanner: true, version: 2, updatedAt: '2026-10-05T12:00:00Z' };
        return HttpResponse.json({ id: '0192f6f8-743e-7c77-a349-cd07c3e8b090', eventId, fileId: '0192f6f8-743e-7c77-a349-cd07c3e8b091', description: null, visibility: 'public', isBanner: true, originalFilename: 'banner.png', contentType: 'image/png', sizeBytes: 68, version: 1, createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z' }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { container } = renderRoute(<App />, `/events/${eventId}?tab=settings`);
    const name = await screen.findByLabelText('Internal name');
    await user.clear(name);
    await user.type(name, 'Draft survives banner');
    const bannerInput = container.querySelector<HTMLInputElement>('#event-banner-upload');
    expect(bannerInput).not.toBeNull();
    await user.upload(bannerInput!, new File(['image'], 'banner.png', { type: 'image/png' }));

    await user.click(screen.getByRole('tab', { name: 'Schedule' }));
    expect(await screen.findByText('Your changes have not been saved.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByText('banner.png')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Upload banner' }));

    expect(await screen.findByText('The event changed while you were editing')).toBeInTheDocument();
    expect(screen.getByLabelText('Internal name')).toHaveValue('Draft survives banner');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Continue draft with latest version' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    expect(screen.getByLabelText('Internal name')).toHaveValue('Draft survives banner');
  });

  it('guards dirty schedule, planning, staffing, and file drafts with one discard surface', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventsmanage, PermissionId.eventsstaffingmanage, PermissionId.eventsassign]))),
      http.get(`*/api/v1/events/${eventId}`, () => HttpResponse.json(eventFixture('planning'))),
      http.get(`*/api/v1/events/${eventId}/sessions`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/shifts`, () => HttpResponse.json({ items: [{
        id: shiftId, eventId, sessionId: null, name: 'Setup', description: null,
        startsAt: '2026-11-02T14:00:00Z', endsAt: '2026-11-02T16:00:00Z', signupOpensAt: null,
        signupClosesAt: null, isPublic: true, status: 'open', linkedSessionStatus: null, version: 1,
        createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z',
      }] })),
      http.get(`*/api/v1/events/${eventId}/task-lists`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/tasks`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/shifts/${shiftId}/requirements`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/assignments`, () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/event-eligibility-roles', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/event-people', () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/files`, () => HttpResponse.json({ items: [] })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?tab=schedule`);

    await user.click(await screen.findByRole('button', { name: 'Add shift' }));
    await user.type(screen.getByLabelText('Name', { exact: true }), 'Late setup');
    await user.click(screen.getByRole('tab', { name: 'Planning' }));
    expect(await screen.findByText('Your changes have not been saved.')).toBeInTheDocument();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Late setup');
    await user.click(screen.getByRole('tab', { name: 'Planning' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    await user.click(await screen.findByRole('button', { name: 'Add task' }));
    await user.type(screen.getByLabelText('Task'), 'Prepare labels');
    await user.click(screen.getByRole('tab', { name: 'Staffing' }));
    expect(await screen.findByText('Your changes have not been saved.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    await user.click(await screen.findByRole('button', { name: 'Add requirement' }));
    await user.type(screen.getByLabelText('Name', { exact: true }), 'Welcome desk');
    await user.click(screen.getByRole('tab', { name: 'Files' }));
    expect(await screen.findByText('Your changes have not been saved.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    await user.click(await screen.findByRole('button', { name: 'Upload file' }));
    await user.selectOptions(screen.getByLabelText('Visibility'), 'public');
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(await screen.findByText('Your changes have not been saved.')).toBeInTheDocument();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps planning and files editable after completion while schedule and staffing are read-only', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.eventsread, PermissionId.eventsmanage, PermissionId.eventsstaffingmanage, PermissionId.eventsassign]))),
      http.get(`*/api/v1/events/${eventId}`, () => HttpResponse.json(eventFixture('completed'))),
      http.get(`*/api/v1/events/${eventId}/sessions`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/shifts`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/task-lists`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/tasks`, () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/event-people', () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/files`, () => HttpResponse.json({ items: [] })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/${eventId}?tab=schedule`);
    expect(await screen.findByRole('heading', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add shift' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Planning' }));
    expect(await screen.findByRole('button', { name: 'Add task' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Files' }));
    expect(await screen.findByRole('button', { name: 'Upload file' })).toBeInTheDocument();
  });

  it('renders only the public DTO and returns a one-time external management link', async () => {
    let submitted: Record<string, unknown> | undefined;
    server.use(
      http.get(`*/api/v1/public/events/${publicId}`, () => HttpResponse.json(publicEvent)),
      http.post(`*/api/v1/public/events/${publicId}/signups`, async ({ request }) => {
        submitted = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          assignment: { id: '0192f6f8-743e-7c77-a349-cd07c3e8b004', publicId, shiftId, requirementId, firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test', phone: null, source: 'public_signup', status: 'active', cancelledAt: null, version: 1, createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z' },
          managementUrl: '/events/signup/manage#token=one-time-secret',
        }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { container } = renderRoute(<App />, `/events/public/${publicId}`);
    expect(await screen.findByRole('heading', { name: 'Public exhibition' })).toBeInTheDocument();
    expect(container.querySelector('.public-event-banner img')).toHaveAttribute('src', `/api/v1/public/events/${publicId}/banner`);
    expect(screen.getByText('2 / 4 filled')).toBeInTheDocument();
    expect(screen.queryByText(/internal/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    await user.selectOptions(screen.getByLabelText('Shift and requirement'), `${shiftId}:${requirementId}`);
    await user.type(screen.getByLabelText('First name'), 'Grace');
    await user.type(screen.getByLabelText('Last name'), 'Hopper');
    await user.type(screen.getByLabelText('Email'), 'grace@example.test');
    await user.click(screen.getByRole('button', { name: 'Confirm signup' }));
    expect(await screen.findByDisplayValue(/#token=one-time-secret$/)).toBeInTheDocument();
    expect(submitted).toMatchObject({ shiftId, requirementId, firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test' });
  });

  it('keeps the management token only in component memory and sends it in the custom header', async () => {
    const token = 'private-management-token';
    let receivedToken: string | null = null;
    window.history.pushState(null, '', `/events/signup/manage#token=${token}`);
    server.use(http.get('*/api/v1/public/event-signups/current', ({ request }) => {
      receivedToken = request.headers.get('X-Event-Signup-Token');
      return HttpResponse.json({ id: '0192f6f8-743e-7c77-a349-cd07c3e8b004', publicId, shiftId, requirementId, firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test', phone: null, source: 'public_signup', status: 'active', cancelledAt: null, version: 1, createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z' });
    }), http.get(`*/api/v1/public/events/${publicId}`, () => HttpResponse.json(publicEvent)));
    renderRoute(<App />, `/events/signup/manage#token=${token}`);
    expect(await screen.findByRole('heading', { name: 'Your signup' })).toBeInTheDocument();
    expect(receivedToken).toBe(token);
    expect(window.location.hash).toBe('');
    expect(screen.queryByText(token)).not.toBeInTheDocument();
  });
});
