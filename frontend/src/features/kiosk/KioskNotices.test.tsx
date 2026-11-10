import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { BrandingProvider, defaultPublicConfiguration } from '../branding/branding';
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
  it('opens an internal privacy policy on top of the kiosk', async () => {
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
    const dialog = await screen.findByRole('dialog', { name: 'Privacy policy' });
    expect(await within(dialog).findByText('Text')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/kiosk');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Privacy policy' })).not.toBeInTheDocument());
  });

  it('frames an external imprint instead of leaving the kiosk', async () => {
    mockKiosk([]);
    server.use(
      http.get('*/api/v1/public/config', () =>
        HttpResponse.json({
          ...defaultPublicConfiguration,
          legal: {
            ...defaultPublicConfiguration.legal,
            imprint: { mode: 'external', href: 'https://example.test/imprint' },
          },
        }),
      ),
      http.get('*/api/v1/public/legal/imprint', () =>
        HttpResponse.json({
          kind: 'imprint',
          title: 'Imprint',
          mode: 'external',
          markdown: '',
          externalUrl: 'https://example.test/imprint',
        }),
      ),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(
      <BrandingProvider>
        <App />
      </BrandingProvider>,
      '/kiosk',
    );

    const link = await screen.findByRole('link', { name: 'Imprint' });
    await waitFor(() => expect(link).toHaveAttribute('href', 'https://example.test/imprint'));
    await user.click(link);
    const dialog = await screen.findByRole('dialog', { name: 'Imprint' });
    const frame = await within(dialog).findByTitle('Imprint');
    expect(frame).toHaveAttribute('src', 'https://example.test/imprint');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    expect(
      await within(dialog).findByRole('img', { name: 'QR code for https://example.test/imprint' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/kiosk');
  });
});
