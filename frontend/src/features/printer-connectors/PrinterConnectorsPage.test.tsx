import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

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
});

