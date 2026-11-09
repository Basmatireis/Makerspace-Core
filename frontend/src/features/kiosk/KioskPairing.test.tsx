import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StartManagedDevicePairingRequest } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

describe('unregistered kiosk browser', () => {
  it('shows a pairing code with its countdown instead of an error', async () => {
    let requested: StartManagedDevicePairingRequest | undefined;
    server.use(
      http.get('*/api/v1/terminal/context', () =>
        HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 }),
      ),
      http.post('*/api/v1/public/managed-devices/pairing', async ({ request }) => {
        requested = (await request.json()) as StartManagedDevicePairingRequest;
        return HttpResponse.json(
          { code: 'K7F2QX', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
          { status: 201 },
        );
      }),
      http.get('*/api/v1/public/managed-devices/pairing', () => HttpResponse.json({ status: 'pending' })),
    );
    renderRoute(<App />, '/kiosk');

    expect(await screen.findByRole('heading', { name: 'This browser is not registered as a kiosk' })).toBeVisible();
    expect(await screen.findByLabelText('Pairing code K 7 F 2 Q X')).toHaveTextContent('K7F2QX');
    expect(screen.getByText(/Settings › Devices & sessions › Pair device/)).toBeInTheDocument();
    expect(screen.getByText(/The code expires in 1[45]:\d\d/)).toBeInTheDocument();
    // The browser asks for the cookie delivery; the credential never reaches JavaScript.
    expect(requested).toEqual({ credentialDelivery: 'bindBrowser' });
  });

  it('tells a registered device that is not a kiosk so instead of offering to pair it again', async () => {
    let pairingRequested = false;
    server.use(
      http.get('*/api/v1/terminal/context', () =>
        HttpResponse.json(
          { code: 'device_not_kiosk', message: 'This managed device is not configured as an entrance kiosk' },
          { status: 403 },
        ),
      ),
      http.post('*/api/v1/public/managed-devices/pairing', () => {
        pairingRequested = true;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    renderRoute(<App />, '/kiosk');
    expect(await screen.findByText('Not set up as a kiosk')).toBeInTheDocument();
    expect(screen.getByText(/registered in Makerspace Core but not as an entrance kiosk/)).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'This browser is not registered as a kiosk' }),
    ).not.toBeInTheDocument();
    expect(pairingRequested).toBe(false);
  });

  it('keeps the error for other failures', async () => {
    server.use(
      http.get('*/api/v1/terminal/context', () =>
        HttpResponse.json({ code: 'internal', message: 'Boom' }, { status: 500 }),
      ),
    );
    renderRoute(<App />, '/kiosk');
    expect(await screen.findByText('Kiosk unavailable')).toBeInTheDocument();
  });
});
