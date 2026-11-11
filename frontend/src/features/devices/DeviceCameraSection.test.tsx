import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const deviceId = '0192f6f8-743e-7c77-a349-cd07c3e8a921';
const device = {
  id: deviceId,
  name: 'Entrance tablet',
  deviceTypeId: '0192f6f8-743e-7c77-a349-cd07c3e8a920',
  deviceTypeName: 'Tablet',
  status: 'active',
  expiresAt: null,
  revokedAt: null,
  lastSeenAt: null,
  sessionPolicyId: null,
  terminalEnabled: true,
  allowedApplicationModes: ['visitor_terminal'],
  checkInMethods: ['pin'],
  checkOutMethods: ['pin'],
  allowTapCheckout: false,
  offerSurveysAtCheckout: false,
  kioskResetSeconds: 60,
  capabilities: ['camera'],
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function serve(permissions: PermissionId[]) {
  const puts: unknown[] = [];
  let started = 0;
  let camera = {
    crop: { centerX: 0.6, centerY: 0.45, size: 0.7 },
    indicator: null,
    mirror: false,
    calibrationExpiresAt: null,
  } as Record<string, unknown>;
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/managed-devices/:deviceId', () => HttpResponse.json(device)),
    http.get('*/api/v1/managed-devices/:deviceId/hardware', () =>
      HttpResponse.json({
        deviceId,
        deviceName: device.name,
        terminalEnabled: true,
        allowedApplicationModes: ['visitor_terminal'],
        sessionPolicyId: null,
        configuredCapabilities: ['camera'],
        reportedCapabilities: [],
        effectiveCapabilities: ['camera'],
        platform: null,
        bridgeVersion: null,
        reportedAt: null,
      }),
    ),
    http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/session-policies', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/managed-devices/:deviceId/camera', () => HttpResponse.json(camera)),
    http.put('*/api/v1/managed-devices/:deviceId/camera', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      puts.push(body);
      camera = { ...body, calibrationExpiresAt: null };
      return HttpResponse.json(camera);
    }),
    http.post('*/api/v1/managed-devices/:deviceId/camera/calibration', () => {
      started += 1;
      camera = { ...camera, calibrationExpiresAt: new Date(Date.now() + 600_000).toISOString() };
      return HttpResponse.json(camera);
    }),
  );
  return { puts, started: () => started };
}

describe('kiosk camera settings', () => {
  it('starts a calibration window and edits and resets the values numerically', async () => {
    const calls = serve([PermissionId.managed_devicesread, PermissionId.managed_devicesmanage]);
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/devices-sessions/devices/${deviceId}`);
    expect(await screen.findByText(/Centre 60 % from the left, 45 % from the top · size 70 %/)).toBeInTheDocument();
    expect(screen.getByText('Mirror image')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Calibrate on the tablet' }));
    expect(await screen.findByText(/Open until/)).toBeInTheDocument();
    expect(calls.started()).toBe(1);
    expect(screen.getByRole('button', { name: 'Close calibration' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit values' }));
    const dialog = await screen.findByRole('dialog', { name: 'Kiosk camera values' });
    await user.click(within(dialog).getByRole('switch', { name: 'Mirror image' }));
    await user.click(within(dialog).getByRole('switch', { name: 'Camera pointer' }));
    await user.selectOptions(within(dialog).getByLabelText('Screen edge next to the lens'), 'right');
    const offset = within(dialog).getByLabelText('Position from the top (%)');
    await user.clear(offset);
    await user.type(offset, '101');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(offset);
    await user.type(offset, '12.5');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.puts).toHaveLength(1));
    expect(calls.puts[0]).toEqual({
      crop: { centerX: 0.6, centerY: 0.45, size: 0.7 },
      indicator: { edge: 'right', offset: 12.5 },
      mirror: true,
    });

    await user.click(await screen.findByRole('button', { name: 'Edit values' }));
    const again = await screen.findByRole('dialog', { name: 'Kiosk camera values' });
    await user.click(within(again).getByRole('button', { name: 'Reset to default' }));
    await user.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.puts).toHaveLength(2));
    expect(calls.puts[1]).toEqual({ crop: null, indicator: null, mirror: false });
  });

  it('shows the values without controls to read-only staff', async () => {
    serve([PermissionId.managed_devicesread]);
    renderRoute(<App />, `/settings/devices-sessions/devices/${deviceId}`);
    expect(await screen.findByRole('heading', { name: 'Kiosk camera' })).toBeInTheDocument();
    expect(await screen.findByText(/Centre 60 %/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Calibrate on the tablet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit values' })).not.toBeInTheDocument();
  });
});
