import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId, type StreamingCamera, type StreamingGateway } from '../../api/generated/models';
import { App } from '../../app/App';
import { formatDateTime } from '../../app/dateTime';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const gatewayId = '0192f6f8-743e-7c77-a349-cd07c3e8a701';
const machineId = '0192f6f8-743e-7c77-a349-cd07c3e8a702';
const stamp = '2026-10-19T08:00:00Z';

const gateway = (patch: Partial<StreamingGateway> = {}): StreamingGateway => ({
  id: gatewayId,
  name: 'Print room gateway',
  publicHost: 'signage-gw.example.org:8443',
  lifecycle: 'active',
  configurationRevision: 3,
  appliedConfigurationRevision: 3,
  softwareVersion: '0.6.0',
  protocolVersion: 1,
  healthState: 'connected',
  healthSummary: null,
  lastHeartbeatAt: new Date().toISOString(),
  enrolledAt: stamp,
  disabledAt: null,
  revokedAt: null,
  credentialExpiresAt: '2027-01-17T08:00:00Z',
  version: 4,
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});
const camera = (patch: Partial<StreamingCamera> = {}): StreamingCamera => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a703',
  gatewayId,
  gatewayName: 'Print room gateway',
  gatewayLifecycle: 'active',
  machineId,
  machineName: 'Bambu H2D',
  enabled: true,
  health: 'idle',
  viewers: 0,
  codec: null,
  width: null,
  height: null,
  fps: null,
  reportedAt: stamp,
  version: 2,
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});

function setup(permissions: PermissionId[], { gateways = [gateway()], cameras = [camera()] } = {}) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/streaming-gateways', () => HttpResponse.json({ items: gateways })),
    http.get('*/api/v1/streaming-gateways/:id', ({ params }) => {
      const found = gateways.find((item) => item.id === params.id);
      return found
        ? HttpResponse.json(found)
        : HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
    }),
    http.get('*/api/v1/local-services/cameras', () => HttpResponse.json({ items: cameras })),
    http.get('*/api/v1/local-services/camera-candidates', () =>
      HttpResponse.json({
        items: [
          { id: machineId, name: 'Bambu H2D', kind: 'FDM printer' },
          { id: '0192f6f8-743e-7c77-a349-cd07c3e8a704', name: 'Laser cutter', kind: 'Laser' },
        ],
      }),
    ),
  );
}

describe('Local services', () => {
  it('is reachable only with local_services.manage', async () => {
    setup([PermissionId.machinesread, PermissionId.rolesread]);
    renderRoute(<App />, '/settings/local-services');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Local services' })).not.toBeInTheDocument());
    expect(screen.queryByRole('table', { name: 'Streaming gateways' })).not.toBeInTheDocument();
  });

  it('offers the settings tile and lists gateways with status, version, host and camera count', async () => {
    setup([PermissionId.local_servicesmanage]);
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Local services' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('link', { name: /Local services/ }));
    const table = await screen.findByRole('table', { name: 'Streaming gateways' });
    const row = within(table).getByRole('row', { name: /Print room gateway/ });
    expect(within(row).getByText('Online')).toBeInTheDocument();
    expect(within(row).getByText('0.6.0')).toBeInTheDocument();
    expect(within(row).getByText('signage-gw.example.org:8443')).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Credential expires' })).toBeInTheDocument();
    expect(within(row).getByText(formatDateTime('2027-01-17T08:00:00Z'))).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText('1')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Open Machines, Connectors/ })).toHaveAttribute(
      'href',
      '/machine-logbook/machines?tab=connectors',
    );
  });

  it('shows the enrollment secret once after adding a gateway', async () => {
    setup([PermissionId.local_servicesmanage], { gateways: [], cameras: [] });
    let created: unknown;
    const secret = 'S'.repeat(43);
    server.use(
      http.post('*/api/v1/streaming-gateways', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(gateway({ lifecycle: 'pending', lastHeartbeatAt: null }), { status: 201 });
      }),
      http.post(`*/api/v1/streaming-gateways/${gatewayId}/enrollments`, () =>
        HttpResponse.json(
          {
            gateway: gateway({ lifecycle: 'pending' }),
            enrollmentId: 'e1',
            enrollmentSecret: secret,
            expiresAt: '2026-10-19T08:15:00Z',
          },
          { status: 201 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/local-services');
    await user.click((await screen.findAllByRole('button', { name: 'Add gateway' }))[0]);
    await user.type(await screen.findByLabelText('Name'), 'Print room gateway');
    await user.type(screen.getByLabelText('Public host'), 'signage-gw.example.org:8443');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add gateway' }));
    expect(await screen.findByText('Shown once, valid 15 minutes.')).toBeInTheDocument();
    expect(created).toEqual({ name: 'Print room gateway', publicHost: 'signage-gw.example.org:8443' });
    expect(screen.getByText(secret)).toBeInTheDocument();
    expect(screen.getByText(/STREAM_PUBLIC_HOST=signage-gw.example.org:8443/)).toBeInTheDocument();
    expect(screen.getByText(/docker compose up -d/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I have stored the secret' }));
    await waitFor(() => expect(screen.queryByText(secret)).not.toBeInTheDocument());
  });

  it('explains why a camera cannot be assigned', async () => {
    setup([PermissionId.local_servicesmanage], { cameras: [] });
    const message =
      'the machine needs an active Bambu printer assignment (H2D or X1 Carbon) before its camera can be streamed';
    let attempts = 0;
    server.use(
      http.post(`*/api/v1/streaming-gateways/${gatewayId}/cameras`, () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json({ code: 'validation_failed', message }, { status: 422 })
          : HttpResponse.json(
              { code: 'streaming_camera_exists', message: 'This machine already has a streaming camera' },
              { status: 409 },
            );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/local-services/${gatewayId}`);
    await user.click(await screen.findByRole('button', { name: 'Assign camera' }));
    await user.selectOptions(
      await screen.findByLabelText('Machine'),
      await screen.findByRole('option', { name: 'Laser cutter' }),
    );
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Assign camera' }));
    expect(
      await within(dialog).findByText(/Only printers with an active Bambu H2D or X1 Carbon assignment can stream/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Assign camera' }));
    expect(
      await within(dialog).findByText(
        'This machine already has a camera on a streaming gateway. Remove that camera first.',
      ),
    ).toBeInTheDocument();
  });

  it('revokes a gateway after confirmation; Delete stays available', async () => {
    setup([PermissionId.local_servicesmanage]);
    let revoked = false;
    server.use(
      http.get(`*/api/v1/streaming-gateways/${gatewayId}`, () =>
        HttpResponse.json(revoked ? gateway({ lifecycle: 'revoked', revokedAt: stamp }) : gateway()),
      ),
      http.post(`*/api/v1/streaming-gateways/${gatewayId}/revocation`, async ({ request }) => {
        expect(await request.json()).toEqual({ expectedVersion: 4 });
        revoked = true;
        return HttpResponse.json(gateway({ lifecycle: 'revoked' }));
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/local-services/${gatewayId}`);
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New enrollment secret' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'New enrollment secret' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('issues a new enrollment secret for an enrolled gateway and explains the re-enrollment', async () => {
    setup([PermissionId.local_servicesmanage]);
    const secret = 'R'.repeat(43);
    server.use(
      http.post(`*/api/v1/streaming-gateways/${gatewayId}/enrollments`, () =>
        HttpResponse.json(
          { gateway: gateway(), enrollmentId: 'e1', enrollmentSecret: secret, expiresAt: '2026-10-19T08:15:00Z' },
          { status: 201 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/local-services/${gatewayId}`);
    await user.click(await screen.findByRole('button', { name: 'New enrollment secret' }));
    expect(await screen.findByText(secret)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Use this to move the gateway to another host or after losing its data. The running gateway keeps working until the new secret is used; then it is disconnected./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/STREAM_ENROLLMENT_SECRET=R+/)).toBeInTheDocument();
  });

  it.each(['active', 'revoked'] as const)(
    'deletes a %s gateway from the detail page and returns to the list',
    async (lifecycle) => {
      setup([PermissionId.local_servicesmanage], { gateways: [gateway({ lifecycle })] });
      let body: unknown;
      server.use(
        http.delete(`*/api/v1/streaming-gateways/${gatewayId}`, async ({ request }) => {
          body = await request.json();
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const user = userEvent.setup();
      renderRoute(<App />, `/settings/local-services/${gatewayId}`);
      await user.click(await screen.findByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(
        within(dialog).getByText(
          /The gateway is revoked and removed. A running instance stops working; its cameras must be assigned to another one./,
        ),
      ).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(body).toEqual({ expectedVersion: 4 }));
      expect(await screen.findByRole('heading', { name: 'Local services' })).toBeInTheDocument();
    },
  );

  it('deletes and re-issues enrollment secrets from the list', async () => {
    const pending = gateway({ lifecycle: 'pending', lastHeartbeatAt: null, enrolledAt: null });
    setup([PermissionId.local_servicesmanage], {
      gateways: [pending, gateway({ id: '0192f6f8-743e-7c77-a349-cd07c3e8a799', name: 'Second gateway' })],
    });
    const secret = 'T'.repeat(43);
    let deleted: unknown;
    server.use(
      http.post(`*/api/v1/streaming-gateways/${gatewayId}/enrollments`, () =>
        HttpResponse.json(
          { gateway: pending, enrollmentId: 'e1', enrollmentSecret: secret, expiresAt: '2026-10-19T08:15:00Z' },
          { status: 201 },
        ),
      ),
      http.delete('*/api/v1/streaming-gateways/0192f6f8-743e-7c77-a349-cd07c3e8a799', async ({ request }) => {
        deleted = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/local-services');
    await screen.findByRole('table', { name: 'Streaming gateways' });
    const menuItem = (label: string) =>
      screen.findByText(label, { selector: '.cds--overflow-menu-options__option-content' });
    await user.click(await screen.findByRole('button', { name: 'Actions for Second gateway' }));
    expect(await menuItem('New enrollment secret')).toBeInTheDocument();
    await user.click(await menuItem('Delete'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete gateway' }));
    await waitFor(() => expect(deleted).toEqual({ expectedVersion: 4 }));

    await user.click(await screen.findByRole('button', { name: 'Actions for Print room gateway' }));
    await user.click(await menuItem('New enrollment secret'));
    expect(await screen.findByText(secret)).toBeInTheDocument();
    expect(screen.getByText(/STREAM_ENROLLMENT_SECRET=T+/)).toBeInTheDocument();
  });
});
