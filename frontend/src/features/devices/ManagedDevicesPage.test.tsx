import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  CreateManagedDeviceRequest,
  PairManagedDeviceRequest,
  RotateManagedDeviceTokenRequest,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const typeId = '0192f6f8-743e-7c77-a349-cd07c3e8a920';
const deviceId = '0192f6f8-743e-7c77-a349-cd07c3e8a921';
const policyId = '0192f6f8-743e-7c77-a349-cd07c3e8a930';
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
  checkInMethods: ['email_code' as const, 'pin' as const, 'password' as const],
  checkOutMethods: ['email_code' as const, 'pin' as const, 'password' as const],
  allowTapCheckout: false,
  offerSurveysAtCheckout: false,
  kioskResetSeconds: 60 as const,
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
  platform: 'desktop' as const,
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

  it('searches the status label and the application mode labels', async () => {
    const kiosk = {
      ...device,
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a923',
      name: 'Lobby tablet',
      status: 'revoked' as const,
      allowedApplicationModes: ['visitor_terminal' as const],
    };
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.managed_devicesread]))),
      http.get('*/api/v1/managed-devices', () => HttpResponse.json({ items: [device, kiosk], nextCursor: null })),
      http.get('*/api/v1/session-policies', () => HttpResponse.json({ items: [] })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/devices-sessions?tab=managed-devices');
    expect(await screen.findByRole('link', { name: 'Front desk' })).toBeInTheDocument();
    const search = screen.getByLabelText('Search managed devices', { selector: 'input' });
    await user.type(search, 'visitor kiosk');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Front desk' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Lobby tablet' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'staff ui');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Lobby tablet' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Front desk' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'revoked');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Front desk' })).not.toBeInTheDocument());
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
        checkInMethods: ['email_code', 'pin', 'password'],
        checkOutMethods: ['email_code', 'pin', 'password'],
        allowTapCheckout: false,
        offerSurveysAtCheckout: false,
        kioskResetSeconds: 60,
        capabilities: [],
      }),
    );
    expect(await screen.findByDisplayValue('a'.repeat(43))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss permanently' }));
    expect(screen.queryByDisplayValue('a'.repeat(43))).not.toBeInTheDocument();
  });

  it('maps Used as and the kiosk settings to the request body of a new device', async () => {
    let submitted: CreateManagedDeviceRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.managed_devicesread, PermissionId.managed_devicesmanage])),
      ),
      http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [deviceType] })),
      http.get('*/api/v1/managed-devices', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('*/api/v1/session-policies', () =>
        HttpResponse.json({
          items: [
            {
              id: policyId,
              name: 'Kiosk policy',
              idleTimeoutSeconds: 900,
              absoluteTimeoutSeconds: 28800,
              postLogoutDestination: 'visitor_terminal',
              isDefault: false,
              version: 1,
            },
          ],
        }),
      ),
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
    await user.click(await screen.findByRole('button', { name: 'New device' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Device name'), 'Lobby kiosk');
    await user.selectOptions(within(dialog).getByLabelText('Device type'), typeId);
    // The kiosk settings appear only for a kiosk.
    expect(within(dialog).queryByRole('group', { name: 'To check in, people use' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'Kiosk with staff sign-in' }));
    expect(within(dialog).getByRole('button', { name: 'Create device' })).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText('Session policy'), policyId);

    const create = within(dialog).getByRole('button', { name: 'Create device' });
    const checkIn = within(dialog).getByRole('group', { name: 'To check in, people use' });
    expect(
      within(checkIn)
        .getAllByRole('checkbox')
        .map((box) => [box.getAttribute('id'), (box as HTMLInputElement).checked]),
    ).toEqual([
      ['create-check-in-method-email_code', true],
      ['create-check-in-method-pin', true],
      ['create-check-in-method-password', true],
    ]);
    // Any combination works, but not none.
    for (const name of ['Email code', 'PIN', 'Password'])
      await user.click(within(checkIn).getByRole('checkbox', { name }));
    expect(within(dialog).getByText('Choose at least one way to check in.')).toBeInTheDocument();
    expect(create).toBeDisabled();
    await user.click(within(checkIn).getByRole('checkbox', { name: 'PIN' }));
    await user.click(within(checkIn).getByRole('checkbox', { name: 'Email code' }));
    // Check-out may name no way only while a tap in the list checks out.
    const checkOut = within(dialog).getByRole('group', { name: 'To check out, people use' });
    for (const name of ['Email code', 'PIN', 'Password'])
      await user.click(within(checkOut).getByRole('checkbox', { name }));
    expect(
      within(dialog).getByText('Choose a way to check out, or allow checking out by a tap in the list.'),
    ).toBeInTheDocument();
    expect(create).toBeDisabled();
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Also check out by tapping a name in the presence list' }),
    );
    await user.click(within(dialog).getByRole('checkbox', { name: 'Offer surveys at check-out' }));
    const reset = within(dialog).getByLabelText('Back to the start screen after (seconds without a touch)');
    await user.clear(reset);
    await user.type(reset, '10');
    expect(within(dialog).getByRole('button', { name: 'Create device' })).toBeDisabled();
    await user.clear(reset);
    await user.type(reset, '120');
    expect(
      within(dialog).getByText('Check-in with email code or PIN · check-out with a tap in the list'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create device' }));

    await waitFor(() =>
      expect(submitted).toEqual({
        name: 'Lobby kiosk',
        deviceTypeId: typeId,
        expiresAt: null,
        credentialDelivery: 'nativeToken',
        sessionPolicyId: policyId,
        terminalEnabled: true,
        allowedApplicationModes: ['visitor_terminal', 'staff_ui'],
        checkInMethods: ['email_code', 'pin'],
        checkOutMethods: [],
        allowTapCheckout: true,
        offerSurveysAtCheckout: true,
        kioskResetSeconds: 120,
        capabilities: [],
      }),
    );
  });

  it('pairs a kiosk by its code and reads every rejected code the same', async () => {
    const submitted: PairManagedDeviceRequest[] = [];
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.managed_devicesread, PermissionId.managed_devicesmanage])),
      ),
      http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [deviceType] })),
      http.get('*/api/v1/managed-devices', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('*/api/v1/managed-devices/:deviceId', () =>
        HttpResponse.json({ ...device, name: 'Lobby kiosk', terminalEnabled: true }),
      ),
      http.get('*/api/v1/managed-devices/:deviceId/hardware', () => HttpResponse.json(hardware)),
      http.get('*/api/v1/session-policies', () =>
        HttpResponse.json({
          items: [
            {
              id: policyId,
              name: 'Kiosk policy',
              idleTimeoutSeconds: 900,
              absoluteTimeoutSeconds: 28800,
              postLogoutDestination: 'visitor_terminal',
              isDefault: false,
              version: 1,
            },
          ],
        }),
      ),
      http.post('*/api/v1/managed-devices/pairing', async ({ request }) => {
        const body = (await request.json()) as PairManagedDeviceRequest;
        submitted.push(body);
        if (submitted.length === 1)
          return HttpResponse.json(
            { code: 'pairing_code_invalid', message: 'The pairing code is invalid or has expired' },
            { status: 422 },
          );
        return HttpResponse.json({ ...device, name: 'Lobby kiosk', terminalEnabled: true }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/devices-sessions?tab=managed-devices');
    await user.click(await screen.findByRole('button', { name: 'Pair device' }));
    const dialog = await screen.findByRole('dialog');
    const pair = within(dialog).getByRole('button', { name: 'Pair device' });
    await user.type(within(dialog).getByLabelText(/Pairing code/), 'k7f-2qo');
    await user.type(within(dialog).getByLabelText('Device name'), 'Lobby kiosk');
    await user.selectOptions(within(dialog).getByLabelText('Device type'), typeId);
    await user.selectOptions(within(dialog).getByLabelText('Session policy'), policyId);
    // O is not part of the alphabet.
    expect(pair).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/Pairing code/));
    await user.type(within(dialog).getByLabelText(/Pairing code/), 'k7f-2qx');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Camera' }));
    await user.click(pair);
    expect(await within(dialog).findByText(/This code was not accepted/)).toBeInTheDocument();

    await user.click(pair);
    expect(await screen.findByRole('heading', { name: 'Lobby kiosk' })).toBeInTheDocument();
    expect(submitted[1]).toEqual({
      code: 'K7F2QX',
      name: 'Lobby kiosk',
      deviceTypeId: typeId,
      expiresAt: null,
      sessionPolicyId: policyId,
      terminalEnabled: true,
      allowedApplicationModes: ['visitor_terminal'],
      checkInMethods: ['email_code', 'password'],
      checkOutMethods: ['email_code', 'password'],
      allowTapCheckout: false,
      offerSurveysAtCheckout: false,
      kioskResetSeconds: 60,
      capabilities: ['camera'],
    });
  });

  it('edits a tap-only kiosk into a staff device', async () => {
    let put: Record<string, unknown> | undefined;
    const kiosk = {
      ...device,
      terminalEnabled: true,
      allowedApplicationModes: ['visitor_terminal' as const],
      sessionPolicyId: policyId,
      checkOutMethods: [],
      allowTapCheckout: true,
    };
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.managed_devicesread, PermissionId.managed_devicesmanage])),
      ),
      http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [deviceType] })),
      http.get('*/api/v1/managed-devices/:deviceId', () => HttpResponse.json(kiosk)),
      http.get('*/api/v1/managed-devices/:deviceId/hardware', () => HttpResponse.json(hardware)),
      http.get('*/api/v1/session-policies', () => HttpResponse.json({ items: [] })),
      http.patch('*/api/v1/managed-devices/:deviceId', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...kiosk, version: 2 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/devices-sessions/devices/${deviceId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit device' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('radio', { name: 'Kiosk' })).toBeChecked();
    const checkOut = within(dialog).getByRole('group', { name: 'To check out, people use' });
    expect(
      within(checkOut)
        .getAllByRole('checkbox')
        .some((box) => (box as HTMLInputElement).checked),
    ).toBe(false);
    expect(within(dialog).getByText('Leave all unticked to check out only by a tap in the list.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'Staff device' }));
    expect(within(dialog).queryByRole('group', { name: 'To check out, people use' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(put).toMatchObject({
        terminalEnabled: false,
        allowedApplicationModes: ['staff_ui'],
        checkOutMethods: [],
        expectedVersion: 1,
      }),
    );
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
