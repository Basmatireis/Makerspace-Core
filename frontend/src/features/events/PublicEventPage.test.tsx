import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { publicId, shiftId, positionId, timestamp } from './testData';

const requirementId = positionId;
const roleRequirementId = '0192f6f8-743e-7c77-a349-cd07c3e8b099';

const publicEvent = {
  publicId,
  title: 'Public exhibition',
  description: 'What visitors may see.',
  location: 'Main workshop',
  status: 'confirmed',
  timeZone: 'Europe/Vienna',
  publicSignupEnabled: true,
  hasBanner: true,
  sessions: [
    {
      id: '0192f6f8-743e-7c77-a349-cd07c3e8b003',
      name: 'Opening',
      location: 'Hall',
      description: null,
      startsAt: '2026-11-02T16:00:00Z',
      endsAt: '2026-11-02T22:00:00Z',
    },
  ],
  shifts: [
    {
      id: shiftId,
      sessionId: null,
      name: 'Setup',
      description: 'Prepare the room.',
      startsAt: '2026-11-02T14:00:00Z',
      endsAt: '2026-11-02T16:00:00Z',
      requirements: [
        {
          id: requirementId,
          name: 'Helper',
          description: null,
          requiredCount: 4,
          filledCount: 2,
          remainingCount: 2,
          availability: 'available',
        },
        {
          id: roleRequirementId,
          name: 'First aid',
          description: null,
          requiredCount: 1,
          filledCount: 0,
          remainingCount: 1,
          availability: 'authenticated_only',
        },
      ],
    },
  ],
  files: [],
};

describe('Public event page', () => {
  it('renders outside the app shell with only public data and the Help us availability', async () => {
    server.use(http.get(`*/api/v1/public/events/${publicId}`, () => HttpResponse.json(publicEvent)));
    const { container } = renderRoute(<App />, `/events/public/${publicId}`);
    expect(await screen.findByRole('heading', { name: 'Public exhibition' })).toBeInTheDocument();
    expect(container.querySelector('.ev-public__banner')).toHaveAttribute(
      'src',
      `/api/v1/public/events/${publicId}/banner`,
    );
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Help us' })).toBeInTheDocument();
    expect(screen.getByText('2 of 4 filled')).toBeInTheDocument();
    expect(screen.getByText('Members only')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sign up' })).toHaveLength(1);
    expect(screen.queryByText(/internal/i)).not.toBeInTheDocument();
  });

  it('shows closed signup as information', async () => {
    const closed = {
      ...publicEvent,
      publicSignupEnabled: false,
      shifts: [
        {
          ...publicEvent.shifts[0],
          requirements: publicEvent.shifts[0].requirements.map((r) => ({ ...r, availability: 'not_open' })),
        },
      ],
    };
    server.use(http.get(`*/api/v1/public/events/${publicId}`, () => HttpResponse.json(closed)));
    renderRoute(<App />, `/events/public/${publicId}`);
    expect(await screen.findByText('Helper signup is not open at the moment.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign up' })).not.toBeInTheDocument();
  });

  it('signs a visitor up and returns the one-time management link', async () => {
    let submitted: Record<string, unknown> | undefined;
    server.use(
      http.get(`*/api/v1/public/events/${publicId}`, () => HttpResponse.json(publicEvent)),
      http.post(`*/api/v1/public/events/${publicId}/signups`, async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            assignment: {
              id: '0192f6f8-743e-7c77-a349-cd07c3e8b004',
              publicId,
              shiftId,
              requirementId,
              firstName: 'Grace',
              lastName: 'Hopper',
              email: 'grace@example.test',
              phone: null,
              source: 'public_signup',
              status: 'active',
              cancelledAt: null,
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            managementUrl: '/events/signup/manage#token=one-time-secret',
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/public/${publicId}`);
    await user.click(await screen.findByRole('button', { name: 'Sign up' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm signup' }));
    expect(await within(dialog).findByText('Enter a first name.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('First name'), 'Grace');
    await user.type(within(dialog).getByLabelText('Last name'), 'Hopper');
    await user.type(within(dialog).getByLabelText('Email'), 'grace@example.test');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm signup' }));
    expect(await screen.findByDisplayValue(/#token=one-time-secret$/)).toBeInTheDocument();
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    expect(submitted).toMatchObject({
      shiftId,
      requirementId,
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.test',
    });
  });

  it('lets a signed-in member sign up for a role place and cancel an own signup', async () => {
    let cancelBody: unknown;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.eventsread]))),
      http.get(`*/api/v1/public/events/${publicId}`, () => HttpResponse.json(publicEvent)),
      http.get(`*/api/v1/events/public/${publicId}/assignments/me`, () =>
        HttpResponse.json({
          items: [
            {
              id: 'own-1',
              publicId,
              shiftId,
              requirementId,
              firstName: 'Ada',
              lastName: 'Lovelace',
              email: null,
              phone: null,
              source: 'authenticated_self',
              status: 'active',
              cancelledAt: null,
              version: 4,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        }),
      ),
      http.post(`*/api/v1/events/public/${publicId}/assignments/me/own-1/cancel`, async ({ request }) => {
        cancelBody = await request.json();
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/events/public/${publicId}`);
    expect(await screen.findByRole('heading', { name: 'Your signups' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sign up' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Cancel signup' }));
    await user.click(screen.getAllByRole('button', { name: 'Cancel signup' }).at(-1)!);
    await waitFor(() => expect(cancelBody).toEqual({ expectedVersion: 4 }));
  });

  it('says so when the page is not available', async () => {
    server.use(
      http.get(`*/api/v1/public/events/${publicId}`, () =>
        HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 }),
      ),
    );
    renderRoute(<App />, `/events/public/${publicId}`);
    expect(await screen.findByText('This page is not available')).toBeInTheDocument();
  });
});

describe('Signup management page', () => {
  it('keeps the management token only in component memory and sends it in the custom header', async () => {
    const token = 'private-management-token';
    let receivedToken: string | null = null;
    window.history.pushState(null, '', `/events/signup/manage#token=${token}`);
    server.use(
      http.get('*/api/v1/public/event-signups/current', ({ request }) => {
        receivedToken = request.headers.get('X-Event-Signup-Token');
        return HttpResponse.json({
          id: '0192f6f8-743e-7c77-a349-cd07c3e8b004',
          publicId,
          shiftId,
          requirementId,
          firstName: 'Grace',
          lastName: 'Hopper',
          email: 'grace@example.test',
          phone: null,
          source: 'public_signup',
          status: 'active',
          cancelledAt: null,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }),
      http.get(`*/api/v1/public/events/${publicId}`, () => HttpResponse.json(publicEvent)),
    );
    renderRoute(<App />, `/events/signup/manage#token=${token}`);
    expect(await screen.findByRole('heading', { name: 'Your signup' })).toBeInTheDocument();
    expect(receivedToken).toBe(token);
    expect(window.location.hash).toBe('');
    expect(screen.queryByText(token)).not.toBeInTheDocument();
  });
});
