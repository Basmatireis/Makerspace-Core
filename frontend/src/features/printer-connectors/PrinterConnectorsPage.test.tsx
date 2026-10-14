import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { connectorDiagnostic, isIPv4Unicast } from './connectorHelpers';

const connector = {
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a920',
  name: 'Print room agent',
  locationLabel: 'Print room',
  lifecycle: 'pending',
  configurationRevision: 3,
  appliedConfigurationRevision: 3,
  softwareVersion: '1.2.3',
  protocolVersion: 1,
  healthState: 'connected',
  healthSummary: null,
  pendingEventCount: 2,
  quarantinedEventCount: 1,
  lastHeartbeatAt: '2020-01-01T00:00:00Z',
  enrolledAt: '2020-01-01T00:00:00Z',
  disabledAt: null,
  revokedAt: null,
  version: 4,
  createdAt: '2020-01-01T00:00:00Z',
  updatedAt: '2020-01-01T00:00:00Z',
};

const staleConnector = {
  ...connector,
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a922',
  name: 'Stale print room agent',
  lifecycle: 'active',
};

describe('printer connector administration', () => {
  it('does not describe a stale heartbeat as connected and shows enrollment secrets once', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([
        PermissionId.printer_connectorsread,
        PermissionId.printer_connectorsmanage,
        PermissionId.printer_connectorscredentialsmanage,
      ]))),
      http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: [connector, staleConnector] })),
      http.post(`*/api/v1/printer-connectors/${connector.id}/enrollments`, () => HttpResponse.json({
        connector,
        enrollmentId: '0192f6f8-743e-7c77-a349-cd07c3e8a921',
        enrollmentSecret: 'a'.repeat(43),
        expiresAt: '2026-10-11T12:15:00Z',
      }, { status: 201 })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/printer-connectors');

    expect(await screen.findByText('Disconnected')).toBeInTheDocument();
    expect(screen.getAllByText('2 pending / 1 quarantined')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Enroll' }));
    expect(await screen.findByText('Copy this enrollment secret now')).toBeInTheDocument();
    expect(screen.getByText('a'.repeat(43))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I have stored the secret' }));
    expect(screen.queryByText('a'.repeat(43))).not.toBeInTheDocument();
  });

  it('shows normalized event history and review reasons in diagnostics', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.printer_connectorsread]))),
      http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: [connector] })),
      http.get(`*/api/v1/printer-connectors/${connector.id}/assignments`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/printer-connectors/${connector.id}/observed-runs`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/printer-connectors/${connector.id}/events`, () => HttpResponse.json({ items: [{
        id: '0192f6f8-743e-7c77-a349-cd07c3e8a930',
        machineId: '0192f6f8-743e-7c77-a349-cd07c3e8a931',
        assignmentId: '0192f6f8-743e-7c77-a349-cd07c3e8a932',
        kind: 'slot_observation',
        occurredAt: '2026-10-11T12:00:00Z',
        receivedAt: '2026-10-11T12:00:01Z',
        applicationState: 'review_required',
        applicationReason: 'configuration_version_mismatch',
        payload: { slot: 1, material: 'PLA' },
      }] })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/printer-connectors');

    await user.click(await screen.findByRole('button', { name: 'Diagnostics' }));
    expect(await screen.findByText('Recent normalized events')).toBeInTheDocument();
    expect(screen.getByText('slot observation')).toBeInTheDocument();
    expect(screen.getByText('configuration_version_mismatch')).toBeInTheDocument();
    expect(screen.getByText(/"material": "PLA"/)).toBeInTheDocument();
  });

  it('creates an H2D assignment with normalized settings and its write-only access code', async () => {
    let requestBody: unknown;
    const machine = { id: '0192f6f8-743e-7c77-a349-cd07c3e8a940', name: 'Bambu H2D' };
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([
        PermissionId.printer_connectorsread,
        PermissionId.printer_connectorsmanage,
        PermissionId.machinesmanage,
      ]))),
      http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: [connector] })),
      http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machine], page: 1, pageSize: 100, total: 1 })),
      http.post(`*/api/v1/printer-connectors/${connector.id}/assignments`, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/printer-connectors');

    await user.click(await screen.findByRole('button', { name: 'Assign printer' }));
    await user.selectOptions(screen.getByLabelText('Machine'), machine.id);
    await user.selectOptions(screen.getByLabelText('Adapter'), 'bambu_h2d');
    await user.type(screen.getByLabelText('Printer IPv4 address'), '192.168.1.42');
    await user.type(screen.getByLabelText('Printer serial number'), '01p00a123456789');
    await user.type(screen.getByLabelText('LAN access code'), 'secret-code');
    await user.click(screen.getByLabelText('Automatically mount spools identified by exact Bambu RFID'));
    expect(screen.getByLabelText('Machine')).toHaveValue(machine.id);
    expect(screen.getByLabelText('Printer IPv4 address')).toHaveValue('192.168.1.42');
    expect(screen.getByLabelText('Printer serial number')).toHaveValue('01P00A123456789');
    expect(screen.getByLabelText('LAN access code')).toHaveValue('secret-code');
    await user.click(screen.getAllByRole('button', { name: 'Assign printer' })[0]);

    await waitFor(() => expect(requestBody).toEqual({
      machineId: machine.id,
      adapterKind: 'bambu_h2d',
      adapterSchemaVersion: 1,
      settings: { ipAddress: '192.168.1.42', serialNumber: '01P00A123456789', autoDetectSpools: true },
      secrets: { lanAccessCode: 'secret-code' },
      enabled: true,
    }));
  });

  it('edits H2D settings without sending a blank credential and explains connection failures', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const assignment = {
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a941', connectorId: connector.id,
      machineId: '0192f6f8-743e-7c77-a349-cd07c3e8a940', machineName: 'Bambu H2D',
      adapterKind: 'bambu_h2d', adapterSchemaVersion: 1,
      settings: { ipAddress: '192.168.1.42', serialNumber: '01P00A123456789', autoDetectSpools: true },
      configurationVersion: 2, appliedConfigurationVersion: 2, enabled: true,
      runtimeState: 'degraded', runtimeErrorCode: 'TLS_SERIAL_MISMATCH', endedAt: null,
      version: 3, activatedAt: '2026-10-11T12:00:00Z', createdAt: '2026-10-11T12:00:00Z', updatedAt: '2026-10-11T12:00:00Z',
    };
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([
        PermissionId.printer_connectorsread,
        PermissionId.printer_connectorsmanage,
        PermissionId.machinesmanage,
      ]))),
      http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: [connector] })),
      http.get(`*/api/v1/printer-connectors/${connector.id}/assignments`, () => HttpResponse.json({ items: [assignment] })),
      http.get(`*/api/v1/printer-connectors/${connector.id}/observed-runs`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/printer-connectors/${connector.id}/events`, () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/machines', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
      http.patch(`*/api/v1/printer-connectors/${connector.id}/assignments/${assignment.id}`, async ({ request }) => {
        requestBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(assignment);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/printer-connectors');

    await user.click(await screen.findByRole('button', { name: 'Diagnostics' }));
    expect(await screen.findByText(/certificate does not match the configured serial number/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit settings' }));
    expect(screen.getByLabelText('New LAN access code (optional)')).toHaveValue('');
    expect(screen.getByLabelText('Automatically mount spools identified by exact Bambu RFID')).toBeChecked();
    await user.clear(screen.getByLabelText('Printer IPv4 address'));
    await user.type(screen.getByLabelText('Printer IPv4 address'), '192.168.1.50');
    await user.click(screen.getByRole('button', { name: 'Save assignment' }));

    await waitFor(() => expect(requestBody).toBeDefined());
    expect(requestBody).toMatchObject({
      adapterKind: 'bambu_h2d', adapterSchemaVersion: 1,
      settings: { ipAddress: '192.168.1.50', serialNumber: '01P00A123456789', autoDetectSpools: true },
      enabled: true, end: false, expectedVersion: 3,
    });
    expect(requestBody).not.toHaveProperty('secrets');
  });
});

describe('connector diagnostics', () => {
  it('recognizes stable failure families and IPv4 unicast literals', () => {
    expect(connectorDiagnostic('MQTT_CONNECTION_TIMEOUT')).toMatch(/port 8883/);
    expect(connectorDiagnostic('FTPS_AUTH_FAILED')).toMatch(/access code/i);
    expect(connectorDiagnostic('ARTIFACT_BACKLOG_CAPACITY')).toMatch(/capacity/i);
    expect(connectorDiagnostic('ARTIFACT_AMBIGUOUS')).toMatch(/more than one exact/i);
    expect(connectorDiagnostic('ARTIFACT_NOT_AVAILABLE')).toMatch(/root or cache/i);
    expect(connectorDiagnostic('SNAPSHOT_TIMEOUT')).toMatch(/15 seconds/i);
    expect(isIPv4Unicast('192.168.1.42')).toBe(true);
    expect(isIPv4Unicast('127.0.0.1')).toBe(false);
    expect(isIPv4Unicast('999.1.1.1')).toBe(false);
    expect(isIPv4Unicast('224.0.0.1')).toBe(false);
  });
});

