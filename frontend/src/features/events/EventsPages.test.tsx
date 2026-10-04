import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
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
