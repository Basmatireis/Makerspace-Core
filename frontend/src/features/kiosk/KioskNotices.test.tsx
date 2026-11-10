import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const notice = (patch: Record<string, unknown>) => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a950',
  mode: 'banner',
  title: 'Soldering iron is broken',
  body: 'Please use the second bench.',
  level: 'warning',
  mustTap: false,
  ...patch,
});

const visit = (notices: unknown[]) => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a941',
  personId: '0192f6f8-743e-7c77-a349-cd07c3e8a942',
  displayName: 'Grace Hopper',
  checkedInAt: '2026-10-09T12:00:00Z',
  checkedOutAt: null,
  status: 'checked_in',
  checkInMethod: 'pin',
  checkOutMethod: null,
  admissionDecision: 'admitted',
  correctionReason: null,
  version: 1,
  notices,
});

function mockKiosk(contextNotices: unknown[], checkInNotices: unknown[] = []) {
  server.use(
    http.get('*/api/v1/terminal/context', () =>
      HttpResponse.json({
        deviceId: '0192f6f8-743e-7c77-a349-cd07c3e8a940',
        deviceName: 'Entrance',
        allowTapCheckout: true,
        offerSurveysAtCheckout: false,
        kioskResetSeconds: 60,
        checkInAssurance: 'low',
        checkOutAssurance: 'low',
        authenticationMethods: ['pin'],
        capabilities: [],
        staffDestination: 'login',
        notices: contextNotices,
      }),
    ),
    http.get('*/api/v1/terminal/presence', () => HttpResponse.json({ items: [], count: 0 })),
    http.post('*/api/v1/terminal/check-in/pin', () => HttpResponse.json(visit(checkInNotices), { status: 201 })),
  );
}

async function checkIn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Check in' }));
  await user.type(await screen.findByLabelText('Login name'), 'grace');
  for (const digit of '123456') await user.click(screen.getByRole('button', { name: digit }));
  await user.click(screen.getAllByRole('button', { name: 'Check in' }).at(-1) as HTMLElement);
}

describe('kiosk rule notices', () => {
  it('shows banner notices on the start screen but keeps the other kinds for the result screen', async () => {
    mockKiosk([
      notice({}),
      notice({ id: '0192f6f8-743e-7c77-a349-cd07c3e8a951', mode: 'everyone_today', title: 'Closed Friday' }),
    ]);
    renderRoute(<App />, '/kiosk');

    expect(await screen.findByText('Soldering iron is broken')).toBeInTheDocument();
    expect(screen.getByText('Please use the second bench.')).toBeInTheDocument();
    expect(screen.queryByText('Closed Friday')).not.toBeInTheDocument();
  });

  it('shows the person their notice after check-in and waits for OK when it must be tapped', async () => {
    mockKiosk(
      [notice({ id: '0192f6f8-743e-7c77-a349-cd07c3e8a951', mode: 'everyone_today', title: 'Closed Friday' })],
      [
        notice({
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a952',
          mode: 'person_checkin',
          title: 'Your training expires',
          mustTap: true,
        }),
      ],
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await checkIn(user);

    expect(await screen.findByRole('heading', { name: 'Welcome, Grace!' })).toBeInTheDocument();
    expect(screen.getByText('Your training expires')).toBeInTheDocument();
    expect(screen.getByText('Closed Friday')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Done/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('button', { name: 'Check out' })).toBeInTheDocument();
  });

  it('returns by itself when no notice has to be tapped', async () => {
    mockKiosk([], [notice({ mode: 'next_checkin', title: 'Welcome back' })]);
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await checkIn(user);

    expect(await screen.findByText('Welcome back')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Done · \d+ s$/ })).toBeInTheDocument();
  });
});

describe('kiosk legal links', () => {
  it('links the privacy policy and returns to the kiosk from it', async () => {
    mockKiosk([]);
    server.use(
      http.get('*/api/v1/public/legal/privacy', () =>
        HttpResponse.json({
          kind: 'privacy',
          title: 'Privacy policy',
          mode: 'internal',
          markdown: 'Text',
          externalUrl: null,
        }),
      ),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/kiosk');

    await user.click(await screen.findByRole('link', { name: 'Privacy policy' }));
    expect(await screen.findByRole('heading', { name: 'Privacy policy' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Back' }));
    expect(router.state.location.pathname).toBe('/kiosk');
  });
});
