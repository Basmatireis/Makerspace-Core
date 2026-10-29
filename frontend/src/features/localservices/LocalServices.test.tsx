import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId, type PrinterConnector } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const connectorId = '0192f6f8-743e-7c77-a349-cd07c3e8a701';
const stamp = '2026-10-19T08:00:00Z';

const connector = (patch: Partial<PrinterConnector> = {}): PrinterConnector => ({
  id: connectorId,
  name: 'Print room connector',
  locationLabel: 'Print room',
  lifecycle: 'active',
  configurationRevision: 3,
  appliedConfigurationRevision: 3,
  softwareVersion: '0.6.0',
  protocolVersion: 1,
  healthState: 'connected',
  healthSummary: null,
  pendingEventCount: 0,
  quarantinedEventCount: 0,
  lastHeartbeatAt: new Date().toISOString(),
  enrolledAt: stamp,
  disabledAt: null,
  revokedAt: null,
  eventsClearedAt: null,
  eventsClearedByName: null,
  updaterAvailable: false,
  update: null,
  version: 4,
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});

function setup(permissions: PermissionId[], connectors: PrinterConnector[] = [connector()]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: connectors, coreVersion: '0.8.3' })),
    http.get('*/api/v1/printer-connectors/:id/assignments', () => HttpResponse.json({ items: [] })),
  );
}

describe('Local services', () => {
  it('is reachable only with printer_connectors.read', async () => {
    setup([PermissionId.machinesread, PermissionId.rolesread]);
    renderRoute(<App />, '/settings/local-services');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Local services' })).not.toBeInTheDocument());
    expect(screen.queryByRole('table', { name: 'Printer connectors' })).not.toBeInTheDocument();
  });

  it('offers the settings tile and lists connectors and the versions tab', async () => {
    setup([PermissionId.printer_connectorsread]);
    renderRoute(<App />, '/settings');
    await userEvent.setup().click(await screen.findByRole('link', { name: /Printer connectors/ }));
    const table = await screen.findByRole('table', { name: 'Printer connectors' });
    expect(within(table).getByRole('row', { name: /Print room connector/ })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Printer connectors',
      'Versions and updates',
    ]);
  });

  it('lists versions, offers an update with confirmation and explains manual updates without the updater', async () => {
    const withUpdater = connector({ softwareVersion: '0.8.2', updaterAvailable: true });
    const manual = connector({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a705',
      name: 'Hall connector',
      softwareVersion: '0.8.1',
    });
    const current = connector({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a706',
      name: 'Current connector',
      softwareVersion: '0.8.3',
    });
    setup([PermissionId.printer_connectorsread, PermissionId.printer_connectorsmanage], [withUpdater, manual, current]);
    let requested: unknown;
    server.use(
      http.post(`*/api/v1/printer-connectors/${connectorId}/update`, async ({ request }) => {
        requested = await request.json();
        return HttpResponse.json(
          connector({
            ...withUpdater,
            update: {
              requestId: '0192f6f8-743e-7c77-a349-cd07c3e8a707',
              targetVersion: '0.8.3',
              status: 'requested',
              reason: null,
              requestedAt: stamp,
              statusAt: stamp,
            },
          }),
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/local-services?tab=updates');
    const table = await screen.findByRole('table', { name: 'Versions and updates' });
    expect(screen.getByText('0.8.3', { selector: 'strong' })).toBeInTheDocument();
    const updatable = within(table).getByRole('row', { name: /Print room connector/ });
    expect(within(updatable).getByText('Update available')).toBeInTheDocument();
    const hall = within(table).getByRole('row', { name: /Hall connector/ });
    expect(within(hall).getByText('No updater on this host: update it by hand.')).toBeInTheDocument();
    expect(within(hall).queryByRole('button')).not.toBeInTheDocument();
    expect(
      within(within(table).getByRole('row', { name: /Current connector/ })).getByText('Up to date'),
    ).toBeInTheDocument();
    expect(screen.getByText(/MAKERSPACE_VERSION=0\.8\.3/)).toBeInTheDocument();

    await user.click(within(updatable).getByRole('button', { name: 'Update to 0.8.3' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update Print room connector to 0.8.3?' });
    expect(requested).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(requested).toEqual({ targetVersion: '0.8.3' }));
  });

  it('shows no update actions without printer_connectors.manage', async () => {
    setup([PermissionId.printer_connectorsread], [connector({ softwareVersion: '0.8.2', updaterAvailable: true })]);
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/local-services');
    expect(await screen.findByRole('tab', { name: 'Printer connectors', selected: true })).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Printer connectors' });
    await user.click(screen.getByRole('tab', { name: 'Versions and updates' }));
    const table = await screen.findByRole('table', { name: 'Versions and updates' });
    expect(within(table).getByText('Update available')).toBeInTheDocument();
    expect(within(table).queryByRole('button')).not.toBeInTheDocument();
  });
});
