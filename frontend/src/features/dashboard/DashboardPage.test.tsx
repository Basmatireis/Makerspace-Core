import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PersonalDashboard, PersonalDashboardStaffing } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const openDayId = '0192f6f8-743e-7c77-a349-cd07c3e8b001';
const otherOpenDayId = '0192f6f8-743e-7c77-a349-cd07c3e8b002';
const requirementId = '0192f6f8-743e-7c77-a349-cd07c3e8b003';
const shiftId = '0192f6f8-743e-7c77-a349-cd07c3e8b004';

/** Instants relative to the real clock: the page compares them with "now". */
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

const semester = {
  periodId: '0192f6f8-743e-7c77-a349-cd07c3e8a932',
  name: 'Autumn',
  startsOn: '2026-10-01',
  endsOn: '2027-01-31',
};

function staffing(overrides: Partial<PersonalDashboardStaffing> = {}): PersonalDashboardStaffing {
  return {
    kind: 'supervisor',
    semester,
    minimum: 2,
    traineeThreshold: 3,
    staffed: 1,
    booked: 0,
    staffedAsTrainee: 0,
    status: 'missing',
    missing: 1,
    nextOpenPlace: null,
    nextOpenDay: null,
    ...overrides,
  };
}

function dashboard(overrides: Partial<PersonalDashboard> = {}): PersonalDashboard {
  return {
    person: { firstName: 'Ada', memberSince: '2025-01-01T00:00:00Z' },
    ...overrides,
  };
}

const labRulesCurrent = {
  mode: 'warning',
  state: 'current',
  actionRequired: false,
  currentVersion: null,
  latestConfirmedVersion: null,
  requestId: null,
};

function serve(data: PersonalDashboard, permissions: PermissionId[], labRules: object = labRulesCurrent) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/me/dashboard', () => HttpResponse.json(data)),
    http.get('*/api/v1/laborordnung/status/me', () => HttpResponse.json(labRules)),
  );
}

const supervisorPermissions = [PermissionId.open_daysread, PermissionId.open_dayssignup];

describe('personal dashboard', () => {
  it('shows a supervisor their semester progress, one short-staffed hint, statistics and what is coming up', async () => {
    serve(
      dashboard({
        staffing: staffing({
          nextOpenDay: {
            openDayId,
            startsAt: inHours(30),
            endsAt: inHours(34),
            openSupervisorPlaces: 2,
            shortStaffed: true,
          },
          nextOpenPlace: {
            openDayId: otherOpenDayId,
            requirementId,
            startsAt: inHours(200),
            endsAt: inHours(204),
            freePlaces: 1,
          },
        }),
        comingUp: [
          {
            kind: 'open_day',
            id: shiftId,
            openDayId,
            title: 'Open day · Autumn',
            startsAt: inHours(30),
            endsAt: inHours(34),
            shortStaffed: true,
          },
          {
            kind: 'event_shift',
            id: otherOpenDayId,
            title: 'Maker Faire · Door',
            startsAt: inHours(50),
            endsAt: inHours(54),
            eventId: requirementId,
            publicId: 'maker-faire',
          },
        ],
        statistics: {
          openDaysStaffed: 4,
          openDayHours: 16,
          eventShifts: 1,
          eventShiftHours: 4,
          memberSince: '2025-01-01T00:00:00Z',
        },
      }),
      supervisorPermissions,
    );

    renderRoute(<App />, '/dashboard');

    expect(
      await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening)|Still up, Ada$/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText('1 of 2', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Sign up for 1 open day more/)).toBeInTheDocument();
    // One info box in Next up: the short-staffed warning wins over the open place.
    expect(screen.getByText('Short-staffed')).toBeInTheDocument();
    expect(screen.queryByText('Supervisor needed')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your makerspace so far' })).toBeInTheDocument();
    expect(screen.getByText('16 hours keeping the doors open')).toBeInTheDocument();
    const comingUp = screen.getByText('Coming up').closest('.cds--contained-list') as HTMLElement;
    expect(within(comingUp).getByText('Open day · Autumn')).toBeInTheDocument();
    expect(within(comingUp).getByText('Maker Faire · Door')).toBeInTheDocument();
    expect(screen.queryByText(/calendar/i)).not.toBeInTheDocument();
  });

  it('offers a supervisor the next free supervisor place and signs up with its requirement', async () => {
    const user = userEvent.setup();
    let joined: { openDayId: string; body: unknown } | undefined;
    serve(
      dashboard({
        staffing: staffing({
          nextOpenPlace: {
            openDayId: otherOpenDayId,
            requirementId,
            startsAt: inHours(100),
            endsAt: inHours(104),
            freePlaces: 2,
          },
        }),
      }),
      supervisorPermissions,
    );
    server.use(
      http.put('*/api/v1/open-days/:id/assignments/me', async ({ params, request }) => {
        joined = { openDayId: String(params.id), body: await request.json() };
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    renderRoute(<App />, '/dashboard');

    expect(await screen.findByText('Nothing booked yet')).toBeInTheDocument();
    expect(screen.getByText('Supervisor needed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign up as supervisor' }));
    await waitFor(() => expect(joined).toEqual({ openDayId: otherOpenDayId, body: { requirementId } }));
    expect(await screen.findByText('Signed up')).toBeInTheDocument();
  });

  it('points a trainee at trainee places and their promotion progress, without a sign-up button when signup is not permitted', async () => {
    serve(
      dashboard({
        staffing: staffing({
          kind: 'trainee',
          staffed: 2,
          staffedAsTrainee: 2,
          status: 'fulfilled',
          missing: 0,
          nextOpenPlace: {
            openDayId: otherOpenDayId,
            requirementId,
            startsAt: inHours(100),
            endsAt: inHours(104),
            freePlaces: 1,
          },
        }),
      }),
      [PermissionId.open_daysread],
    );

    renderRoute(<App />, '/dashboard');

    expect(await screen.findByText(/^Trainee · Autumn$/)).toBeInTheDocument();
    expect(screen.getByText(/open days as trainee · 2 staffed, 0 booked/)).toBeInTheDocument();
    expect(screen.getByText(/After 3 open days as trainee the Leitung makes you a supervisor/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign up as/ })).not.toBeInTheDocument();
  });

  it('shows a trainee the free trainee place', async () => {
    serve(
      dashboard({
        staffing: staffing({
          kind: 'trainee',
          nextOpenPlace: {
            openDayId: otherOpenDayId,
            requirementId,
            startsAt: inHours(100),
            endsAt: inHours(104),
            freePlaces: 1,
          },
        }),
      }),
      supervisorPermissions,
    );

    renderRoute(<App />, '/dashboard');

    expect(await screen.findByText('Trainee place free')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign up as trainee' })).toBeInTheDocument();
  });

  it('lets a person leave an open day only after confirming', async () => {
    const user = userEvent.setup();
    let left: string | undefined;
    serve(
      dashboard({
        staffing: staffing(),
        comingUp: [
          {
            kind: 'open_day',
            id: shiftId,
            openDayId,
            title: 'Open day · Autumn',
            startsAt: inHours(30),
            endsAt: inHours(34),
          },
        ],
      }),
      supervisorPermissions,
    );
    server.use(
      http.delete('*/api/v1/open-days/:id/assignments/me', ({ params }) => {
        left = String(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderRoute(<App />, '/dashboard');

    const tooltip = await screen.findByText(/Actions for Open day · Autumn/, { selector: '.cds--tooltip-content' });
    await user.click(tooltip.closest('.cds--popover-container')!.querySelector('button') as HTMLElement);
    await user.click(
      await screen.findByText('Leave open day', { selector: '.cds--overflow-menu-options__option-content' }),
    );
    expect(left).toBeUndefined();
    const dialog = await screen.findByRole('dialog', { name: 'Leave this open day?' });
    await user.click(within(dialog).getByRole('button', { name: 'Leave open day' }));
    await waitFor(() => expect(left).toBe(openDayId));
  });

  it('shows a guest the lab rules status and the next open days, without staffing sections', async () => {
    serve(dashboard(), [], { ...labRulesCurrent, state: 'outdated', actionRequired: true });
    server.use(
      http.get('*/api/v1/public/open-days', () =>
        HttpResponse.json({
          items: [
            {
              id: openDayId,
              title: 'Open day',
              startsAt: inHours(40),
              endsAt: inHours(44),
              status: 'scheduled',
              updatedAt: '2026-01-01T00:00:00Z',
            },
            {
              id: otherOpenDayId,
              title: 'Open day',
              startsAt: inHours(60),
              endsAt: inHours(64),
              status: 'cancelled',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      ),
    );

    renderRoute(<App />, '/dashboard');

    expect(await screen.findByText('Not signed yet')).toBeInTheDocument();
    expect(screen.getByText('Next open day')).toBeInTheDocument();
    const list = screen.getByText('Upcoming open days').closest('.cds--contained-list') as HTMLElement;
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('Your makerspace so far')).not.toBeInTheDocument();
    expect(screen.queryByText('Coming up')).not.toBeInTheDocument();
    expect(screen.queryByText(/This semester/)).not.toBeInTheDocument();
  });

  it('shows the lab rules notice to staff only when action is required and requests a signature', async () => {
    const user = userEvent.setup();
    let requested = false;
    serve(dashboard({ staffing: staffing() }), supervisorPermissions, {
      ...labRulesCurrent,
      state: 'outdated',
      actionRequired: true,
    });
    server.use(
      http.post('*/api/v1/laborordnung/requests/me', () => {
        requested = true;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    renderRoute(<App />, '/dashboard');

    expect(await screen.findByText('New lab rules')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Request signature' }));
    await waitFor(() => expect(requested).toBe(true));
  });

  it('shows no lab rules notice when nothing is required', async () => {
    serve(dashboard({ staffing: staffing() }), supervisorPermissions);

    renderRoute(<App />, '/dashboard');

    expect(await screen.findByText(/^This semester/)).toBeInTheDocument();
    expect(screen.queryByText('New lab rules')).not.toBeInTheDocument();
  });

  it('reports an error with a retry when the dashboard cannot load', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(supervisorPermissions))),
      http.get('*/api/v1/me/dashboard', () => HttpResponse.json({ code: 'internal', message: 'x' }, { status: 500 })),
      http.get('*/api/v1/laborordnung/status/me', () => HttpResponse.json(labRulesCurrent)),
    );

    renderRoute(<App />, '/dashboard');

    expect(await screen.findByText('Unable to load your dashboard')).toBeInTheDocument();
  });
});
