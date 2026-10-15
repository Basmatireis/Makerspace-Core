import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import type {
  Machine, MachineType, PrinterConnector, PrinterConnectorAssignment, PrinterLiveStatus, PrinterLiveStatusTray, PrinterLiveStatusUnit, PrinterProfile,
} from '../../api/generated/models';
import { testQueryClient } from '../../test/render';
import { MachineDetailPage } from './MachineDetailPage';
import { MachinesPage } from './MachinesPage';
import { ToastProvider } from './shared/toasts';

// Shared fixtures and render helper of the printer setup tests (wizard, spool inputs, connectors, diagnostics).

export function renderPage(route: string) {
  const queryClient = testQueryClient();
  const router = createMemoryRouter([{
    path: '/machine-logbook',
    element: <ToastProvider><Outlet /></ToastProvider>,
    children: [{ path: 'machines', element: <MachinesPage /> }, { path: 'machines/:machineId', element: <MachineDetailPage /> }],
  }], { initialEntries: [route] });
  return { router, ...render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>) };
}

export const now = '2026-09-15T11:26:00Z';
export const printerTypeId = '0192f6f8-743e-7c77-a349-cd07c3e8b002';
export const laserTypeId = '0192f6f8-743e-7c77-a349-cd07c3e8b001';
export const types: MachineType[] = [
  { id: laserTypeId, name: 'Laser', active: true, printer: false, version: 3, createdAt: now, updatedAt: now },
  { id: printerTypeId, name: '3D printer', active: true, printer: true, version: 1, createdAt: now, updatedAt: now },
];

export function machineOf(id: string, name: string, overrides: Partial<Machine> = {}): Machine {
  return { id, name, machineType: types[1], status: 'active', automaticCollectionEnabled: false, jobCount: 0, runtimeSeconds: 0, failureRate: '0', version: 5, createdAt: now, updatedAt: now, ...overrides };
}

export const printerId = '0192f6f8-743e-7c77-a349-cd07c3e8c101';
export const printer = machineOf(printerId, 'Bambu H2D');

export const connectorId = '0192f6f8-743e-7c77-a349-cd07c3e8a920';
export const assignmentId = '0192f6f8-743e-7c77-a349-cd07c3e8a941';
export const connectorOf = (overrides: Partial<PrinterConnector> = {}): PrinterConnector => ({
  id: connectorId, name: 'Print room agent', locationLabel: 'Print room', lifecycle: 'active', configurationRevision: 3, appliedConfigurationRevision: 3, softwareVersion: '1.2.3',
  protocolVersion: 1, healthState: 'connected', healthSummary: null, pendingEventCount: 2, quarantinedEventCount: 1, lastHeartbeatAt: new Date().toISOString(), enrolledAt: now,
  disabledAt: null, revokedAt: null, eventsClearedAt: null, eventsClearedByName: null, version: 4, createdAt: now, updatedAt: now, ...overrides,
});
export const assignmentOf = (overrides: Partial<PrinterConnectorAssignment> = {}): PrinterConnectorAssignment => ({
  id: assignmentId, connectorId, machineId: printerId, machineName: 'Bambu H2D', adapterKind: 'bambu_h2d', adapterSchemaVersion: 1,
  settings: { ipAddress: '192.168.1.42', serialNumber: '01P00A123456789', autoDetectSpools: true }, configurationVersion: 2, appliedConfigurationVersion: 2, enabled: true,
  runtimeState: 'connected', runtimeErrorCode: null, endedAt: null, version: 3, activatedAt: now, createdAt: now, updatedAt: now, ...overrides,
});

export const tray = (externalId: string, overrides: Partial<PrinterLiveStatusTray> = {}): PrinterLiveStatusTray => ({
  externalId, materialType: null, subBrand: null, colorHex: null, remainPercent: null, rfid: false, empty: true, ...overrides,
});
export const h2dUnits: PrinterLiveStatusUnit[] = [
  {
    externalId: '0', kind: 'ams', label: 'AMS 2 Pro', humidityPercent: 3, temperatureC: 27, trays: [
      tray('0', { materialType: 'PLA', subBrand: 'PLA Basic', colorHex: 'FFFFFF', remainPercent: 82, rfid: true, empty: false }),
      tray('1', { materialType: 'PETG', subBrand: 'PETG HF', colorHex: 'FFF144', remainPercent: 64, rfid: true, empty: false }),
      tray('2'),
      tray('3'),
    ],
  },
  { externalId: '128', kind: 'ams_ht', label: 'AMS HT', humidityPercent: 12, temperatureC: 31, trays: [tray('0', { materialType: 'PETG-CF', subBrand: 'PETG-CF', colorHex: '1A1A1A', remainPercent: 41, rfid: true, empty: false })] },
  { externalId: '254', kind: 'external', label: 'External spool R', humidityPercent: null, temperatureC: null, trays: [tray('254')] },
  { externalId: '255', kind: 'external', label: 'External spool L', humidityPercent: null, temperatureC: null, trays: [tray('255')] },
];
export const liveStatusOf = (overrides: Partial<PrinterLiveStatus['status']> = {}, receivedAt = new Date().toISOString()): PrinterLiveStatus => ({
  machineId: printerId, assignmentId, receivedAt, observedAt: receivedAt,
  status: {
    state: 'printing',
    job: { fileName: 'gearbox_housing_v3.gcode', progressPercent: 42, layer: 120, totalLayers: 300, remainingMinutes: 95 },
    temperatures: { extruders: [{ extruderId: 0, side: 'right', currentC: 215, targetC: 220 }, { extruderId: 1, side: 'left', currentC: 28, targetC: 0 }], bedC: 60, bedTargetC: 60, chamberC: 35 },
    nozzles: [{ extruderId: 0, side: 'right', diameterMm: 0.4, type: 'HS01' }, { extruderId: 1, side: 'left', diameterMm: 0.4, type: 'HS01' }],
    units: h2dUnits, activeTray: { unitExternalId: '0', trayExternalId: '1' }, errors: [], firmwareVersion: '01.04.00.00', wifiSignalDbm: -52,
    ...overrides,
  },
});

/** A printer profile as the wizard's template step would store it: the H2D template with AMS, two external holders. */
export const templateProfile = (overrides: Partial<PrinterProfile> = {}): PrinterProfile => ({
  machineId: printerId, machineName: 'Bambu H2D', enabled: true, model: 'bambu_h2d', version: 4, createdAt: now, updatedAt: now,
  inputUnits: [
    { id: 'unit-ams', machineId: printerId, name: 'AMS 2 Pro', position: 0, nozzle: 'left', externalIdentifier: '0', enabled: true, version: 1 },
    { id: 'unit-l', machineId: printerId, name: 'External spool L', position: 1, nozzle: 'left', externalIdentifier: '255', enabled: true, version: 1 },
    { id: 'unit-r', machineId: printerId, name: 'External spool R', position: 2, nozzle: 'right', externalIdentifier: '254', enabled: true, version: 1 },
  ],
  slots: [
    ...[0, 1, 2, 3].map((index) => ({ id: `slot-ams-${index}`, machineId: printerId, inputUnitId: 'unit-ams', inputUnitName: 'AMS 2 Pro', name: `Slot ${index + 1}`, position: index, externalIdentifier: String(index), status: 'available' as const, version: 1 })),
    { id: 'slot-l', machineId: printerId, inputUnitId: 'unit-l', inputUnitName: 'External spool L', name: 'Spool', position: 0, externalIdentifier: '255', status: 'available' as const, version: 1 },
    { id: 'slot-r', machineId: printerId, inputUnitId: 'unit-r', inputUnitName: 'External spool R', name: 'Spool', position: 0, externalIdentifier: '254', status: 'available' as const, version: 1 },
  ],
  ...overrides,
});
