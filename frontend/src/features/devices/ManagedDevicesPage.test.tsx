import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  description: 'Front desk terminals',
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

describe('Managed devices administration', () => {
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
    renderRoute(<App />, '/settings/managed-devices');

    const typeHeading = await screen.findByRole('heading', { name: 'Device types' });
    const panel = typeHeading.closest('.cds--tile') as HTMLElement;
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
          { device: { ...device, name: 'Lobby terminal' }, token: 'a'.repeat(43) },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/managed-devices');

    expect(await screen.findByRole('heading', { name: 'Managed devices' })).toBeInTheDocument();
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(await screen.findByText('Never')).toBeInTheDocument();
    expect(screen.getAllByText('No expiration')).not.toHaveLength(0);

    await user.type(screen.getByLabelText('Device name'), 'Lobby terminal');
    await user.selectOptions(screen.getByLabelText('Device type'), typeId);
    await user.click(screen.getByRole('button', { name: 'Create device' }));
    await waitFor(() =>
      expect(submitted).toEqual({
        name: 'Lobby terminal',
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
      http.post('*/api/v1/managed-devices/:deviceId/token', async ({ request }) => {
        submitted = (await request.json()) as RotateManagedDeviceTokenRequest;
        return HttpResponse.json({
          device: { ...device, version: 2 },
          token: 'b'.repeat(43),
        });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/managed-devices');

    await screen.findByText('Front desk');
    const deviceRow = screen.getByRole('row', { name: /Front desk/ });
    fireEvent.click(within(deviceRow).getByRole('button', { name: 'Options' }));
    await user.click(await screen.findByText('Rotate token', { exact: true }));
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
