import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId, type FilamentSpool, type PrinterConnectorEvent } from '../../api/generated/models';
import { server } from '../../test/server';
import {
  assignmentId,
  assignmentOf,
  connectorId,
  connectorOf,
  h2dUnits,
  liveStatusOf,
  now,
  printer,
  printerId,
  renderPage,
  templateProfile,
  tray,
  types,
} from './printerTestData';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const READ = [PermissionId.machinesread, PermissionId.printer_connectorsread];
const iconButton = (label: string) =>
  screen
    .getByText(label, { selector: '.cds--tooltip-content' })
    .closest('.cds--popover-container')!
    .querySelector('button') as HTMLElement;
const menuItem = (label: string) =>
  screen.findByText(label, { selector: '.cds--overflow-menu-options__option-content' });

const event = (overrides: Partial<PrinterConnectorEvent> = {}): PrinterConnectorEvent => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a930',
  machineId: printerId,
  assignmentId,
  kind: 'slot_observation',
  occurredAt: '2026-10-11T12:00:00Z',
  receivedAt: '2026-10-11T12:00:01Z',
  applicationState: 'review_required',
  applicationReason: 'configuration_version_mismatch',
  payload: { slot: 1, material: 'PLA' },
  ...overrides,
});

function setup(
  permissions: PermissionId[],
  {
    connectors = [connectorOf()],
    assignments = [assignmentOf()],
    events = [event()],
    live = liveStatusOf(),
    profile = templateProfile(),
  } = {},
) {
  auth.permissions = permissions;
  server.use(
    http.get('*/api/v1/machines', () => HttpResponse.json({ items: [printer], page: 1, pageSize: 100, total: 1 })),
    http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: types })),
    http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: connectors })),
    http.get(`*/api/v1/printer-connectors/${connectorId}/assignments`, () => HttpResponse.json({ items: assignments })),
    http.get(`*/api/v1/printer-connectors/${connectorId}/events`, () => HttpResponse.json({ items: events })),
    http.get(`*/api/v1/printer-connectors/${connectorId}/observed-runs`, () => HttpResponse.json({ items: [] })),
    http.get(`*/api/v1/machines/${printerId}/printer/live-status`, () =>
      live ? HttpResponse.json(live) : HttpResponse.json({ code: 'not_found' }, { status: 404 }),
    ),
    http.get(`*/api/v1/machines/${printerId}/printer`, () => HttpResponse.json(profile)),
  );
}

describe('Connectors tab', () => {
  it('does not describe a stale heartbeat as connected and lists the assigned printers', async () => {
    setup(READ, {
      connectors: [
        connectorOf({ lastHeartbeatAt: '2020-01-01T00:00:00Z' }),
        connectorOf({ id: '0192f6f8-743e-7c77-a349-cd07c3e8a922', name: 'Fresh agent' }),
      ],
    });
    server.use(
      http.get('*/api/v1/printer-connectors/0192f6f8-743e-7c77-a349-cd07c3e8a922/assignments', () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    renderPage('/settings/local-services?tab=connectors');
    const table = await screen.findByRole('table', { name: 'Printer connectors' }, { timeout: 5000 });
    expect(within(table).getByText('Disconnected')).toBeInTheDocument();
    expect(within(table).getByText('Connected')).toBeInTheDocument();
    expect(within(table).getAllByText('2 pending · 1 quarantined')).toHaveLength(2);
    expect(await within(table).findByRole('link', { name: 'Bambu H2D' })).toHaveAttribute(
      'href',
      `/machine-logbook/machines/${printerId}`,
    );
  });

  it('shows the camera relay health and viewer count of assignments that stream', async () => {
    setup(READ, {
      assignments: [
        assignmentOf({
          cameraStreaming: true,
          camera: { health: 'live', viewers: 2, reportedAt: now },
        }),
      ],
    });
    renderPage('/settings/local-services?tab=connectors');
    const table = await screen.findByRole('table', { name: 'Printer connectors' }, { timeout: 5000 });
    expect(await within(table).findByText('Camera: live')).toBeInTheDocument();
    expect(within(table).getByText('2 viewers')).toBeInTheDocument();
  });

  it('shows no camera tag for assignments without camera streaming', async () => {
    setup(READ);
    renderPage('/settings/local-services?tab=connectors');
    const table = await screen.findByRole('table', { name: 'Printer connectors' }, { timeout: 5000 });
    await within(table).findByRole('link', { name: 'Bambu H2D' });
    expect(within(table).queryByText(/^Camera:/)).not.toBeInTheDocument();
  });

  it('hides management actions without printer_connectors.manage and credentials.manage', async () => {
    setup(READ, { connectors: [connectorOf({ lifecycle: 'pending' })] });
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    await screen.findByRole('table', { name: 'Printer connectors' }, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Add connector' })).not.toBeInTheDocument();
    await user.click(iconButton('Actions for Print room agent'));
    expect(await menuItem('Diagnostics')).toBeInTheDocument();
    expect(
      screen.queryByText('New enrollment secret', { selector: '.cds--overflow-menu-options__option-content' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Delete', { selector: '.cds--overflow-menu-options__option-content' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Revoke', { selector: '.cds--overflow-menu-options__option-content' }),
    ).not.toBeInTheDocument();
  });

  it('shows an enrollment secret once and issues one for a new connector', async () => {
    setup([...READ, PermissionId.printer_connectorsmanage, PermissionId.printer_connectorscredentialsmanage], {
      connectors: [connectorOf({ lifecycle: 'pending' })],
    });
    let created: unknown;
    server.use(
      http.post(`*/api/v1/printer-connectors/${connectorId}/enrollments`, () =>
        HttpResponse.json(
          {
            connector: connectorOf(),
            enrollmentId: 'e1',
            enrollmentSecret: 'a'.repeat(43),
            expiresAt: '2026-10-11T12:15:00Z',
          },
          { status: 201 },
        ),
      ),
      http.post('*/api/v1/printer-connectors', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(connectorOf({ id: 'new', name: 'Laser room Pi', lifecycle: 'pending' }), {
          status: 201,
        });
      }),
      http.post('*/api/v1/printer-connectors/new/enrollments', () =>
        HttpResponse.json(
          {
            connector: connectorOf(),
            enrollmentId: 'e2',
            enrollmentSecret: 'b'.repeat(43),
            expiresAt: '2026-10-11T12:15:00Z',
          },
          { status: 201 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    await screen.findByRole('table', { name: 'Printer connectors' }, { timeout: 5000 });
    await user.click(iconButton('Actions for Print room agent'));
    await user.click(await menuItem('New enrollment secret'));
    const secret = await screen.findByRole('dialog', { name: 'Enrollment secret' });
    expect(within(secret).getByText('a'.repeat(43))).toBeInTheDocument();
    expect(within(secret).getByText('Shown once, valid 15 minutes.')).toBeInTheDocument();
    expect(within(secret).getByText(`CONNECTOR_ENROLLMENT_SECRET=${'a'.repeat(43)}`)).toBeInTheDocument();
    expect(within(secret).getByText(/make dev-connector/)).toBeInTheDocument();
    expect(within(secret).getByText(/A secret issued earlier that was not used yet stops working/)).toBeInTheDocument();
    await user.click(within(secret).getByRole('button', { name: 'I have stored the secret' }));
    await waitFor(() => expect(screen.queryByText('a'.repeat(43))).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add connector' }));
    const add = await screen.findByRole('dialog', { name: 'Add connector' });
    await user.type(within(add).getByLabelText('Connector name'), 'Laser room Pi');
    await user.type(within(add).getByLabelText('Location (optional)'), 'Laser room');
    await user.click(within(add).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(created).toEqual({ name: 'Laser room Pi', locationLabel: 'Laser room' }));
    expect(await screen.findByText('b'.repeat(43))).toBeInTheDocument();
  });

  it('revokes a connector only after confirmation, using its version', async () => {
    setup([...READ, PermissionId.printer_connectorscredentialsmanage]);
    let body: unknown;
    server.use(
      http.post(`*/api/v1/printer-connectors/${connectorId}/revocation`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(connectorOf({ lifecycle: 'revoked' }));
      }),
    );
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    await screen.findByRole('table', { name: 'Printer connectors' }, { timeout: 5000 });
    await user.click(iconButton('Actions for Print room agent'));
    await user.click(await menuItem('Revoke'));
    expect(body).toBeUndefined();
    expect(await screen.findByText(/will stop collecting prints automatically until reassigned/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke connector' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: 4 }));
  });
});

describe('Deleting connectors', () => {
  it.each(['active', 'revoked'] as const)(
    'deletes a %s connector after confirmation, using its version',
    async (lifecycle) => {
      setup([...READ, PermissionId.printer_connectorsmanage], {
        connectors: [connectorOf({ lifecycle })],
        assignments: lifecycle === 'active' ? [assignmentOf()] : [],
      });
      let body: unknown;
      server.use(
        http.delete(`*/api/v1/printer-connectors/${connectorId}`, async ({ request }) => {
          body = await request.json();
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const user = userEvent.setup();
      renderPage('/settings/local-services?tab=connectors');
      await screen.findByRole('table', { name: 'Printer connectors' }, { timeout: 5000 });
      await user.click(iconButton('Actions for Print room agent'));
      expect(
        screen.queryByText('Revoke', { selector: '.cds--overflow-menu-options__option-content' }),
      ).not.toBeInTheDocument();
      await user.click(await menuItem('Delete'));
      expect(body).toBeUndefined();
      const dialog = await screen.findByRole('alertdialog');
      expect(
        within(dialog).getByText(
          /The connector is revoked and removed. A running instance stops working; its printers must be assigned to another connector./,
        ),
      ).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Delete connector' }));
      await waitFor(() => expect(body).toEqual({ expectedVersion: 4 }));
    },
  );

  it('offers Delete next to Revoke for a connector that is not revoked', async () => {
    setup([...READ, PermissionId.printer_connectorsmanage, PermissionId.printer_connectorscredentialsmanage]);
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    await screen.findByRole('table', { name: 'Printer connectors' }, { timeout: 5000 });
    await user.click(iconButton('Actions for Print room agent'));
    expect(await menuItem('Revoke')).toBeInTheDocument();
    expect(await menuItem('Delete')).toBeInTheDocument();
  });

  it('re-enrolls an active connector with an explanation and offers nothing for a revoked one', async () => {
    const revokedId = '0192f6f8-743e-7c77-a349-cd07c3e8a923';
    setup([...READ, PermissionId.printer_connectorsmanage, PermissionId.printer_connectorscredentialsmanage], {
      connectors: [connectorOf(), connectorOf({ id: revokedId, name: 'Old agent', lifecycle: 'revoked' })],
    });
    server.use(
      http.get(`*/api/v1/printer-connectors/${revokedId}/assignments`, () => HttpResponse.json({ items: [] })),
      http.post(`*/api/v1/printer-connectors/${connectorId}/enrollments`, () =>
        HttpResponse.json(
          {
            connector: connectorOf(),
            enrollmentId: 'e1',
            enrollmentSecret: 'c'.repeat(43),
            expiresAt: '2026-10-11T12:15:00Z',
          },
          { status: 201 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    await screen.findByRole('table', { name: 'Printer connectors' }, { timeout: 5000 });
    await user.click(iconButton('Actions for Old agent'));
    await menuItem('Diagnostics');
    expect(
      screen.queryByText('New enrollment secret', { selector: '.cds--overflow-menu-options__option-content' }),
    ).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(iconButton('Actions for Print room agent'));
    await user.click(await menuItem('New enrollment secret'));
    const secret = await screen.findByRole('dialog', { name: 'Enrollment secret' });
    expect(within(secret).getByText('c'.repeat(43))).toBeInTheDocument();
    expect(
      within(secret).getByText(
        /Use this to move the connector to another host or after losing its data. The running connector keeps working until the new secret is used; then it is disconnected./,
      ),
    ).toBeInTheDocument();
  });
});

describe('Connector diagnostics', () => {
  async function openDiagnostics(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole('table', { name: 'Printer connectors' }, { timeout: 5000 });
    await user.click(iconButton('Actions for Print room agent'));
    await user.click(await menuItem('Diagnostics'));
    return screen.findByRole('dialog', { name: 'Print room agent diagnostics' });
  }

  it('explains runtime errors and shows events that need review with their reason and raw payload', async () => {
    setup(READ, {
      connectors: [connectorOf({ healthState: 'degraded', healthSummary: 'MQTT_TIMEOUT' })],
      assignments: [assignmentOf({ runtimeState: 'degraded', runtimeErrorCode: 'TLS_SERIAL_MISMATCH' })],
    });
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    const dialog = await openDiagnostics(user);
    expect(await within(dialog).findByText('Connector needs attention')).toBeInTheDocument();
    expect(within(dialog).getAllByText(/does not match the configured serial number/i).length).toBeGreaterThan(0);
    expect(
      within(dialog).getAllByText('The event was recorded under an older configuration of the assignment.').length,
    ).toBeGreaterThan(0);

    await user.click(within(dialog).getByRole('tab', { name: 'Bambu H2D' }));
    expect(await within(dialog).findByText('Recent events')).toBeInTheDocument();
    await user.click(await within(dialog).findByRole('button', { name: /Show raw payload of Slot observation/ }));
    expect(await within(dialog).findByText(/"material": "PLA"/)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/^Needs review/).length).toBeGreaterThan(0);
  });

  it('shows the live status of a printer and compares reported trays with Core slots and mounted spools', async () => {
    const profile = templateProfile();
    profile.slots[0] = { ...profile.slots[0], spoolId: 'spool-empty', spoolDisplayId: 'S-0001' }; // Core: mounted, printer: tray 0 loaded -> no issue (PLA)
    profile.slots[1] = { ...profile.slots[1], spoolId: 'spool-other', spoolDisplayId: 'S-0002' }; // Core: PLA spool, printer: PETG -> material differs
    profile.slots[2] = { ...profile.slots[2], spoolId: 'spool-gone', spoolDisplayId: 'S-0003' }; // Core: mounted, printer: empty -> printer reports empty
    const live = liveStatusOf({
      units: h2dUnits.map((unit) =>
        unit.externalId === '0'
          ? {
              ...unit,
              trays: [
                unit.trays[0],
                unit.trays[1],
                unit.trays[2],
                tray('3', { materialType: 'PLA', colorHex: 'CC0000', rfid: true, empty: false }),
              ],
            }
          : unit,
      ),
    });
    setup([...READ, PermissionId.inventoryread], { profile, live });
    const spool = (spoolId: string, displayId: string, materialName: string) =>
      ({
        id: spoolId,
        displayId,
        materialName,
        kind: 'standard',
        status: 'in_stock',
        remainingQuantity: '500',
        unit: 'g',
        mounted: true,
        lifecycle: 'active',
        identifiers: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      }) as unknown as FilamentSpool;
    server.use(
      http.get('*/api/v1/filament-spools', () =>
        HttpResponse.json({
          items: [
            spool('spool-empty', 'S-0001', 'PLA Black'),
            spool('spool-other', 'S-0002', 'PLA White'),
            spool('spool-gone', 'S-0003', 'PLA Red'),
          ],
          page: 1,
          pageSize: 100,
          total: 3,
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    const dialog = await openDiagnostics(user);
    await user.click(within(dialog).getByRole('tab', { name: 'Bambu H2D' }));

    expect(await within(dialog).findByText('gearbox_housing_v3.gcode')).toBeInTheDocument();
    expect(within(dialog).getByText('Printing')).toBeInTheDocument();
    expect(within(dialog).getByText('215 / 220 °C')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Right nozzle').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('01.04.00.00')).toBeInTheDocument();
    const trays = await within(dialog).findByRole('table', { name: 'AMS 2 Pro trays' });
    await waitFor(() =>
      expect(
        within(trays)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['S-0001', 'S-0002', 'S-0003']),
    );
    const rows = within(trays).getAllByRole('row');
    // Slot 2 (index 1) is the tray feeding now and has a material mismatch with the mounted PLA spool.
    expect(within(rows[2]).getByText('Feeding now')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Material differs')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('Material differs')).not.toBeInTheDocument();
    expect(within(rows[3]).getByText('Printer reports empty')).toBeInTheDocument();
    expect(within(rows[4]).getByText('Not mounted in Core')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Open printer setup' })).toBeInTheDocument();
  });

  it('tells when a printer has not reported yet and shows the connector error text', async () => {
    setup(READ, {
      live: null as never,
      assignments: [assignmentOf({ runtimeState: 'degraded', runtimeErrorCode: 'MQTT_CONNECTION_TIMEOUT' })],
      events: [],
    });
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    const dialog = await openDiagnostics(user);
    await user.click(within(dialog).getByRole('tab', { name: 'Bambu H2D' }));
    expect(await within(dialog).findByText('No status received yet')).toBeInTheDocument();
    expect(within(dialog).getAllByText(/port 8883/).length).toBeGreaterThan(0);
  });

  it('keeps fresh MQTT status live while an independent FTPS retry is pending', async () => {
    setup(READ, {
      assignments: [assignmentOf({ runtimeState: 'degraded', runtimeErrorCode: 'ftps_transfer_finish_failed' })],
      live: liveStatusOf(),
      events: [],
    });
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    const dialog = await openDiagnostics(user);
    await user.click(within(dialog).getByRole('tab', { name: 'Bambu H2D' }));

    expect(await within(dialog).findByText('Live')).toBeInTheDocument();
    expect(within(dialog).getByText('Print file delayed · ftps_transfer_finish_failed')).toBeInTheDocument();
    expect(within(dialog).getAllByText(/retry independently/i).length).toBeGreaterThan(0);
    expect(within(dialog).queryByText(/No status for/)).not.toBeInTheDocument();
  });

  it('clears events only with printer_connectors.manage and then shows who cleared them', async () => {
    setup([...READ, PermissionId.printer_connectorsmanage]);
    let cleared = false;
    server.use(
      http.get('*/api/v1/printer-connectors', () =>
        HttpResponse.json({
          items: [
            connectorOf(
              cleared ? { eventsClearedAt: new Date().toISOString(), eventsClearedByName: 'Maria Hoffmann' } : {},
            ),
          ],
        }),
      ),
      http.post(`*/api/v1/printer-connectors/${connectorId}/events/clear`, () => {
        cleared = true;
        return HttpResponse.json(
          connectorOf({ eventsClearedAt: new Date().toISOString(), eventsClearedByName: 'Maria Hoffmann' }),
        );
      }),
    );
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    const dialog = await openDiagnostics(user);
    await user.click(within(dialog).getByRole('button', { name: 'Clear events' }));
    const confirm = await screen.findByRole('dialog', { name: 'Clear events?' });
    await user.click(within(confirm).getByRole('button', { name: 'Clear events' }));
    await waitFor(() => expect(cleared).toBe(true));
    expect(await within(dialog).findByText('Events cleared just now by Maria Hoffmann')).toBeInTheDocument();
  });

  it('hides Clear events without printer_connectors.manage', async () => {
    setup(READ);
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    const dialog = await openDiagnostics(user);
    await within(dialog).findByText('Events that need review');
    expect(within(dialog).queryByRole('button', { name: 'Clear events' })).not.toBeInTheDocument();
  });

  it('refetches with includeCleared when cleared events are shown', async () => {
    setup(READ, {
      connectors: [connectorOf({ eventsClearedAt: new Date().toISOString(), eventsClearedByName: 'Maria Hoffmann' })],
    });
    const params: (string | null)[] = [];
    server.use(
      http.get(`*/api/v1/printer-connectors/${connectorId}/events`, ({ request }) => {
        params.push(new URL(request.url).searchParams.get('includeCleared'));
        return HttpResponse.json({ items: [] });
      }),
    );
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    const dialog = await openDiagnostics(user);
    await waitFor(() => expect(params).toContain(null));
    await user.click(await within(dialog).findByRole('button', { name: 'Show cleared events' }));
    await waitFor(() => expect(params).toContain('true'));
    expect(within(dialog).getByRole('button', { name: 'Hide cleared events' })).toBeInTheDocument();
  });

  it('pages through the activity log of automatic changes', async () => {
    setup(READ);
    const pages: (string | null)[] = [];
    server.use(
      http.get(`*/api/v1/printer-connectors/${connectorId}/activity`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page');
        pages.push(page);
        return HttpResponse.json({
          items: [
            {
              id: page === '2' ? '0192f6f8-743e-7c77-a349-cd07c3e8a951' : '0192f6f8-743e-7c77-a349-cd07c3e8a950',
              kind: page === '2' ? 'spool_auto_mounted' : 'run_recorded',
              occurredAt: '2026-10-11T12:00:00Z',
              machineId: printerId,
              machineName: 'Bambu H2D',
              resourceId: '0192f6f8-743e-7c77-a349-cd07c3e8a960',
              resourceLabel: page === '2' ? 'AMS 1 slot 2' : 'R-2026-000042',
              eventKind: null,
              changedFields: page === '2' ? [] : ['outcome', 'usages'],
            },
          ],
          page: Number(page),
          pageSize: 25,
          total: 30,
        });
      }),
    );
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    const dialog = await openDiagnostics(user);
    expect(pages).toHaveLength(0);
    await user.click(within(dialog).getByRole('tab', { name: 'Activity log' }));
    const table = await within(dialog).findByRole('table', { name: 'Connector activity log' });
    expect(within(table).getByText('Run updated')).toBeInTheDocument();
    expect(within(table).getByText('R-2026-000042 · outcome, material usage')).toBeInTheDocument();
    // Carbon names the pagination buttons only through a tooltip that jsdom does not compute.
    await user.click(dialog.querySelector('.cds--pagination__button--forward') as HTMLElement);
    expect(await within(dialog).findByText('Spool mounted automatically')).toBeInTheDocument();
    expect(pages).toEqual(['1', '2']);
  });

  it('adds newly received events without crashing the open diagnostics table', async () => {
    const initial = event({ applicationState: 'applied', applicationReason: null });
    const arrived = event({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a931',
      kind: 'progress',
      applicationState: 'applied',
      applicationReason: null,
      receivedAt: '2026-10-11T12:00:05Z',
      payload: { fileName: 'Customer project', percent: 25 },
    });
    setup(READ, { events: [initial] });
    let requests = 0;
    server.use(
      http.get(`*/api/v1/printer-connectors/${connectorId}/events`, () => {
        requests += 1;
        return HttpResponse.json({ items: requests === 1 ? [initial] : [arrived, initial] });
      }),
    );
    const user = userEvent.setup();
    renderPage('/settings/local-services?tab=connectors');
    const dialog = await openDiagnostics(user);
    await user.click(within(dialog).getByRole('tab', { name: 'Bambu H2D' }));
    expect(await within(dialog).findByText(/unknown material/)).toBeInTheDocument();
    expect(
      await within(dialog).findByText('Customer project at 25 %', undefined, { timeout: 7000 }),
    ).toBeInTheDocument();
    expect(requests).toBeGreaterThan(1);
  });
});
