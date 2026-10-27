import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CreateManagedDeviceRequest, RotateManagedDeviceTokenRequest } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const typeId = '0192f6f8-743e-7c77-a349-cd07c3e8a920';
const deviceId = '0192f6f8-743e-7c77-a349-cd07c3e8a921';
const deviceType = {
  id: typeId,
  name: 'Reception',
  description: 'Front desk kiosks',
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const device = {
  id: deviceId,
  name: 'Front desk',
  deviceTypeId: typeId,
  deviceTypeName: 'Reception',
  status: 'active' as const,
  expiresAt: null,
  revokedAt: null,
  lastSeenAt: null,
  sessionPolicyId: null,
  terminalEnabled: false,
  allowedApplicationModes: ['staff_ui' as const],
  checkInAssurance: 'low' as const,
  checkOutAssurance: 'low' as const,
  checkoutMode: 'verified' as const,
  capabilities: [],
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const hardware = {
  deviceId,
  deviceName: 'Front desk',
  terminalEnabled: false,
  allowedApplicationModes: ['staff_ui' as const],
  sessionPolicyId: null,
  configuredCapabilities: ['nfc' as const, 'camera' as const],
  reportedCapabilities: ['nfc' as const],
  effectiveCapabilities: ['nfc' as const],
  platform: 'android' as const,
  bridgeVersion: '1.2.3',
  reportedAt: '2026-02-01T10:00:00Z',
};

describe('Managed devices administration', () => {
  it('shows a device with configured, reported and effective capabilities and filters by status', async () => {
    const revoked = {
      ...device,
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a922',
      name: 'Old tablet',
      status: 'revoked' as const,
    };
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.managed_devicesread]))),
      http.get('*/api/v1/managed-devices', () => HttpResponse.json({ items: [device, revoked], nextCursor: null })),
      http.get('*/api/v1/managed-devices/:deviceId', () => HttpResponse.json(device)),
      http.get('*/api/v1/managed-devices/:deviceId/hardware', () => HttpResponse.json(hardware)),
      http.get('*/api/v1/session-policies', () => HttpResponse.json({ items: [] })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/devices-sessions?tab=managed-devices&dev-status=revoked');
    expect(await screen.findByRole('link', { name: 'Old tablet' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Front desk' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New device' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Old tablet' }));
    expect(await screen.findByRole('heading', { name: 'Capabilities' })).toBeInTheDocument();
    expect(await screen.findByText('Last report')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate token' })).not.toBeInTheDocument();
  });

  it('confirms device-type deletion and keeps reference conflicts visible', async () => {
    let deleteAttempts = 0;
    let types = [deviceType];
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.managed_devicesread, PermissionId.managed_devicesmanage])),
      ),
      http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: types })),
      http.get('*/api/v1/managed-devices', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.delete('*/api/v1/managed-device-types/:typeId', () => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          return HttpResponse.json({ code: 'conflict', message: 'Still referenced' }, { status: 409 });
        }
        types = [];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/devices-sessions?tab=device-types');

    const typeHeading = await screen.findByRole('heading', { name: 'Device types' });
    const panel = typeHeading.closest('section') as HTMLElement;
    await user.click(await within(panel).findByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete device type Reception?' });
    expect(
      within(dialog).getByText(/blocked while a device or role permission still references it/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(deleteAttempts).toBe(0);

    await user.click(within(dialog).getByRole('button', { name: 'Delete device type' }));
    expect(await within(dialog).findByText(/still used by a device or role permission/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete device type' }));

    await waitFor(() => expect(deleteAttempts).toBe(2));
    await waitFor(() => expect(screen.queryByText('Reception')).not.toBeInTheDocument());
  });

  it('renders status and creates a device with a dismissible one-time token', async () => {
    let submitted: CreateManagedDeviceRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.managed_devicesread, PermissionId.managed_devicesmanage])),
      ),
      http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [deviceType] })),
      http.get('*/api/v1/managed-devices', () => HttpResponse.json({ items: [device], nextCursor: null })),
      http.post('*/api/v1/managed-devices', async ({ request }) => {
        submitted = (await request.json()) as CreateManagedDeviceRequest;
        return HttpResponse.json(
          { device: { ...device, name: 'Lobby kiosk' }, token: 'a'.repeat(43) },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/managed-devices');

    expect(await screen.findByRole('heading', { name: 'Managed devices' })).toBeInTheDocument();
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(await screen.findByText('Never')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Front desk' })).toHaveAttribute(
      'href',
      `/settings/devices-sessions/devices/${deviceId}`,
    );

    await user.click(screen.getByRole('button', { name: 'New device' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Device name'), 'Lobby kiosk');
    await user.selectOptions(within(dialog).getByLabelText('Device type'), typeId);
    await user.click(within(dialog).getByRole('button', { name: 'Create device' }));
    await waitFor(() =>
      expect(submitted).toEqual({
        name: 'Lobby kiosk',
        deviceTypeId: typeId,
        expiresAt: null,
        credentialDelivery: 'nativeToken',
        sessionPolicyId: null,
        terminalEnabled: false,
        allowedApplicationModes: ['staff_ui'],
        checkInAssurance: 'low',
        checkOutAssurance: 'low',
        checkoutMode: 'verified',
        capabilities: [],
      }),
    );
    expect(await screen.findByDisplayValue('a'.repeat(43))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss permanently' }));
    expect(screen.queryByDisplayValue('a'.repeat(43))).not.toBeInTheDocument();
  });

  it('is inaccessible without managed-device read permission', async () => {
    server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture())));
    renderRoute(<App />, '/settings/managed-devices');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Managed devices' })).not.toBeInTheDocument();
  });

  it('rotates a token with confirmation and permanently dismisses the replacement', async () => {
    let submitted: RotateManagedDeviceTokenRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.managed_devicesread, PermissionId.managed_devicesmanage])),
      ),
      http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [deviceType] })),
      http.get('*/api/v1/managed-devices', () => HttpResponse.json({ items: [device], nextCursor: null })),
      http.get('*/api/v1/managed-devices/:deviceId', () => HttpResponse.json(device)),
      http.get('*/api/v1/managed-devices/:deviceId/hardware', () => HttpResponse.json(hardware)),
      http.get('*/api/v1/session-policies', () => HttpResponse.json({ items: [] })),
      http.post('*/api/v1/managed-devices/:deviceId/token', async ({ request }) => {
        submitted = (await request.json()) as RotateManagedDeviceTokenRequest;
        return HttpResponse.json({
          device: { ...device, version: 2 },
          token: 'b'.repeat(43),
        });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/devices-sessions/devices/${deviceId}`);

    await user.click(await screen.findByRole('button', { name: 'Rotate token' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Rotate token for Front desk?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Rotate token' }));

    await waitFor(() =>
      expect(submitted).toEqual({ expiresAt: null, expectedVersion: 1, credentialDelivery: 'nativeToken' }),
    );
    expect(await screen.findByDisplayValue('b'.repeat(43))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss permanently' }));
    expect(screen.queryByDisplayValue('b'.repeat(43))).not.toBeInTheDocument();
  });
});
