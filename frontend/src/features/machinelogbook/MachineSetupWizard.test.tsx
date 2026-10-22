import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionId, type PrinterProfile } from '../../api/generated/models';
import { server } from '../../test/server';
import { connectionTestTiming } from './components/wizard/useConnectionTest';
import {
  assignmentId,
  assignmentOf,
  connectorId,
  connectorOf,
  liveStatusOf,
  machineOf,
  printer,
  printerId,
  printerTypeId,
  renderPage,
  templateProfile,
  types,
} from './printerTestData';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const MANAGE = [
  PermissionId.machinesread,
  PermissionId.machinesmanage,
  PermissionId.printer_connectorsread,
  PermissionId.printer_connectorsmanage,
];
const newId = '0192f6f8-743e-7c77-a349-cd07c3e8c201';
const created = machineOf(newId, 'Lab printer');
const originalTiming = { ...connectionTestTiming };
beforeEach(() => {
  connectionTestTiming.pollMs = 20;
});
afterEach(() => {
  Object.assign(connectionTestTiming, originalTiming);
});

type Recorded = {
  machine?: unknown;
  setup: Record<string, unknown>[];
  assignment?: Record<string, unknown>;
  patch?: Record<string, unknown>;
};

/** Backend stand-in for the create flow: machine, profile, assignment and (after a delay) the connector's status report. */
function backend(
  permissions: PermissionId[],
  { reportAfterPolls = 5, appliedAfterPolls = 3, runtimeErrorCode = null as string | null, report = true } = {},
) {
  auth.permissions = permissions;
  const recorded: Recorded = { setup: [] };
  let profileVersion = 0;
  let polls = 0;
  let assigned = false;
  const profile = (version: number): PrinterProfile =>
    templateProfile({ machineId: newId, machineName: 'Lab printer', version });
  server.use(
    http.get('*/api/v1/machines', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
    http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: types })),
    http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: [connectorOf()] })),
    http.post('*/api/v1/machines', async ({ request }) => {
      recorded.machine = await request.json();
      return HttpResponse.json(created, { status: 201 });
    }),
    http.put(`*/api/v1/machines/${newId}/printer/setup`, async ({ request }) => {
      recorded.setup.push((await request.json()) as Record<string, unknown>);
      profileVersion += 1;
      return HttpResponse.json(profile(profileVersion));
    }),
    http.post(`*/api/v1/printer-connectors/${connectorId}/assignments`, async ({ request }) => {
      recorded.assignment = (await request.json()) as Record<string, unknown>;
      assigned = true;
      return HttpResponse.json(
        assignmentOf({
          machineId: newId,
          machineName: 'Lab printer',
          configurationVersion: 1,
          appliedConfigurationVersion: 0,
          runtimeState: null,
          version: 1,
        }),
        { status: 201 },
      );
    }),
    http.get(`*/api/v1/printer-connectors/${connectorId}/assignments`, () => {
      polls += 1;
      return HttpResponse.json({
        items: assigned
          ? [
              assignmentOf({
                machineId: newId,
                machineName: 'Lab printer',
                configurationVersion: 1,
                appliedConfigurationVersion: polls > appliedAfterPolls ? 1 : 0,
                runtimeErrorCode,
                runtimeState: runtimeErrorCode ? 'degraded' : 'connected',
                version: 1,
              }),
            ]
          : [],
      });
    }),
    http.get(`*/api/v1/machines/${newId}/printer/live-status`, () =>
      report && assigned && polls > reportAfterPolls
        ? HttpResponse.json({ ...liveStatusOf(), machineId: newId, assignmentId })
        : HttpResponse.json({ code: 'not_found' }, { status: 404 }),
    ),
    http.get(`*/api/v1/machines/${newId}`, () => HttpResponse.json(created)),
    http.get(`*/api/v1/machines/${newId}/printer`, () => HttpResponse.json(profile(profileVersion || 1))),
  );
  return recorded;
}

async function fillMachineStep(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.type(within(dialog).getByLabelText('Name'), ' Lab printer ');
  await waitFor(() => expect(within(dialog).getByRole('option', { name: '3D printer' })).toBeInTheDocument());
  await user.selectOptions(within(dialog).getByLabelText('Machine type'), printerTypeId);
  expect(within(dialog).getByRole('button', { name: 'Create and continue' })).toBeDisabled(); // a printer needs a model first
  await user.click(within(dialog).getByRole('radio', { name: /Bambu Lab H2D/ }));
}

async function clickAddMachine(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(document.querySelector('.cds--table-toolbar')).not.toBeNull(), { timeout: 5000 });
  await user.click(
    within(document.querySelector('.cds--table-toolbar') as HTMLElement).getByRole('button', { name: 'Add machine' }),
  );
}

async function openWizard(user: ReturnType<typeof userEvent.setup>) {
  renderPage('/machine-logbook/machines');
  await clickAddMachine(user);
  return screen.findByRole('dialog', { name: 'Add machine' });
}

describe('Add machine wizard for a printer', () => {
  it('offers the live X1 Carbon adapter and X1C topology', async () => {
    const recorded = backend(MANAGE);
    const user = userEvent.setup();
    const dialog = await openWizard(user);
    await user.type(within(dialog).getByLabelText('Name'), 'X1 printer');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: '3D printer' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Machine type'), printerTypeId);
    await user.click(within(dialog).getByRole('radio', { name: /Bambu Lab X1C/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }));
    await waitFor(() => expect(recorded.setup).toHaveLength(1));
    expect(recorded.setup[0]).toMatchObject({
      model: 'bambu_x1c',
      inputUnits: [
        { name: 'AMS', externalIdentifier: '0' },
        { name: 'External spool', externalIdentifier: '255' },
      ],
    });
    expect(await within(dialog).findByDisplayValue('Bambu Lab X1C')).toBeInTheDocument();
  });

  it('creates the machine and its template, saves and tests the connection, then saves the spool inputs', async () => {
    const recorded = backend(MANAGE);
    const user = userEvent.setup();
    const dialog = await openWizard(user);
    expect(within(dialog).getByText('Machine', { selector: '.cds--progress-label' })).toBeInTheDocument();
    await fillMachineStep(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }));

    // Step Machine: machine and template profile are created right away.
    await waitFor(() =>
      expect(recorded.machine).toEqual({
        name: 'Lab printer',
        machineTypeId: printerTypeId,
        status: 'active',
        externalIdentifier: null,
        automaticCollectionEnabled: false,
      }),
    );
    await waitFor(() => expect(recorded.setup).toHaveLength(1));
    const template = recorded.setup[0] as {
      expectedVersion: unknown;
      enabled: unknown;
      model: unknown;
      inputUnits: { name: string; nozzle: string; externalIdentifier: string; slots: unknown[] }[];
    };
    expect(template).toMatchObject({ expectedVersion: null, enabled: true, model: 'bambu_h2d' });
    expect(
      template.inputUnits.map((unit) => [unit.name, unit.nozzle, unit.externalIdentifier, unit.slots.length]),
    ).toEqual([
      ['AMS 2 Pro', 'left', '0', 4],
      ['External spool L', 'left', '255', 1],
      ['External spool R', 'right', '254', 1],
    ]);
    expect(template.inputUnits[0].slots[0]).toEqual({ name: 'Slot 1', status: 'available', externalIdentifier: '0' });

    // Step Connection: Save and test creates the assignment and waits for the connector.
    await user.type(await within(dialog).findByLabelText('Printer IPv4 address'), '192.168.1.42');
    await user.type(within(dialog).getByLabelText('Serial number'), '01p00a123456789');
    await user.type(within(dialog).getByLabelText('LAN access code'), 'secret-code');
    expect(within(dialog).getByLabelText('Serial number')).toHaveValue('01P00A123456789');
    connectionTestTiming.pollMs = 150;
    await user.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    await waitFor(() =>
      expect(recorded.assignment).toEqual({
        machineId: newId,
        adapterKind: 'bambu_h2d',
        adapterSchemaVersion: 1,
        settings: { ipAddress: '192.168.1.42', serialNumber: '01P00A123456789', autoDetectSpools: true },
        secrets: { lanAccessCode: 'secret-code' },
        enabled: true,
      }),
    );
    expect(
      await within(dialog).findByText('Waiting for Print room agent to pick up the configuration…'),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText('Connected')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Firmware 01\.04\.00\.00 · 2 nozzles · AMS 2 Pro, AMS HT · 2 external spool holders/),
    ).toBeInTheDocument();
    expect(screen.queryByText('secret-code')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('New LAN access code (optional)')).toHaveValue('');

    // Step Spool inputs: the profile saved in step 1 is the base; a reported unit that is not set up can be added.
    await user.click(await within(dialog).findByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByDisplayValue('AMS 2 Pro')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add as input unit' }));
    expect(await within(dialog).findByDisplayValue('AMS HT')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(recorded.setup).toHaveLength(2));
    const saved = recorded.setup[1] as {
      expectedVersion: number;
      model: string;
      inputUnits: {
        id?: string;
        name: string;
        nozzle: string | null;
        externalIdentifier: string | null;
        slots: { id?: string; externalIdentifier: string | null }[];
      }[];
    };
    expect(saved.expectedVersion).toBe(1);
    expect(saved.model).toBe('bambu_h2d');
    expect(saved.inputUnits.map((unit) => unit.id)).toEqual(['unit-ams', 'unit-l', 'unit-r', undefined]);
    expect(saved.inputUnits[3]).toEqual({
      name: 'AMS HT',
      nozzle: null,
      externalIdentifier: '128',
      slots: [{ name: 'Slot 1', status: 'available', externalIdentifier: '0' }],
    });
    expect(saved.inputUnits[0].slots.map((slot) => slot.id)).toEqual([
      'slot-ams-0',
      'slot-ams-1',
      'slot-ams-2',
      'slot-ams-3',
    ]);

    // Review shows what is stored.
    const connection = await within(dialog).findByLabelText('Connection summary');
    expect(within(connection).getByText('Print room agent')).toBeInTheDocument();
    expect(within(connection).getByText('Set')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Spool inputs summary')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('skips the connection with Set up later and still saves the spool inputs', async () => {
    const recorded = backend(MANAGE);
    const user = userEvent.setup();
    const dialog = await openWizard(user);
    await fillMachineStep(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }));
    await waitFor(() => expect(recorded.setup).toHaveLength(1));
    await user.click(await within(dialog).findByRole('radio', { name: /Set up later/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByDisplayValue('AMS 2 Pro')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(recorded.setup).toHaveLength(2));
    expect(recorded.assignment).toBeUndefined();
    const connection = await within(dialog).findByLabelText('Connection summary');
    expect(within(connection).getByText('Set up later')).toBeInTheDocument();
  });

  it('explains the connector error when the printer never reports and lets the user continue', async () => {
    const recorded = backend(MANAGE, { runtimeErrorCode: 'TLS_SERIAL_MISMATCH', report: false });
    connectionTestTiming.timeoutMs = 400;
    const user = userEvent.setup();
    const dialog = await openWizard(user);
    await fillMachineStep(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }));
    await user.type(await within(dialog).findByLabelText('Printer IPv4 address'), '192.168.1.42');
    await user.type(within(dialog).getByLabelText('Serial number'), 'SN1');
    await user.type(within(dialog).getByLabelText('LAN access code'), 'code');
    await user.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    expect(await within(dialog).findByText('No status received yet')).toBeInTheDocument();
    expect(within(dialog).getByText(/does not match the configured serial number/i)).toBeInTheDocument();
    expect(recorded.assignment).toBeDefined();
    // The button leaves its "Testing…" label one render after the notice appears.
    await user.click(await within(dialog).findByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByDisplayValue('AMS 2 Pro')).toBeInTheDocument();
    expect(within(dialog).getByText("Connect the printer to see what's loaded in each slot.")).toBeInTheDocument();
  });

  it('tests again after a timeout and asks for a new test once a connection field changes', async () => {
    const recorded = backend(MANAGE, { report: false });
    const patches: Record<string, unknown>[] = [];
    server.use(
      http.patch(`*/api/v1/printer-connectors/${connectorId}/assignments/${assignmentId}`, async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(assignmentOf({ machineId: newId, machineName: 'Lab printer', version: 2 }));
      }),
    );
    connectionTestTiming.timeoutMs = 300;
    const user = userEvent.setup();
    const dialog = await openWizard(user);
    await fillMachineStep(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }));
    await user.type(await within(dialog).findByLabelText('Printer IPv4 address'), '192.168.1.42');
    await user.type(within(dialog).getByLabelText('Serial number'), 'SN1');
    await user.type(within(dialog).getByLabelText('LAN access code'), 'code');
    await user.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    expect(await within(dialog).findByText('No status received yet')).toBeInTheDocument();
    expect(recorded.assignment).toBeDefined();

    await user.click(await within(dialog).findByRole('button', { name: 'Test again' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(await within(dialog).findByText('No status received yet')).toBeInTheDocument();

    const ip = within(dialog).getByLabelText('Printer IPv4 address');
    await user.clear(ip);
    await user.type(ip, '192.168.1.43');
    expect(within(dialog).queryByText('No status received yet')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Test again' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toMatchObject({ settings: { ipAddress: '192.168.1.43', serialNumber: 'SN1' } });
  });

  it('takes the serial number from the external identifier until it is edited', async () => {
    const recorded = backend(MANAGE);
    server.use(
      http.post('*/api/v1/machines', async ({ request }) => {
        recorded.machine = await request.json();
        return HttpResponse.json(
          { ...created, automaticCollectionEnabled: true, externalIdentifier: '01p00a123456789' },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    const dialog = await openWizard(user);
    await fillMachineStep(user, dialog);
    await user.click(within(dialog).getByRole('switch', { name: 'Automatic collection' }));
    await user.type(within(dialog).getByLabelText('External identifier (optional)'), '01p00a123456789');
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }));
    await waitFor(() =>
      expect(recorded.machine).toMatchObject({
        externalIdentifier: '01p00a123456789',
        automaticCollectionEnabled: true,
      }),
    );
    expect(await within(dialog).findByLabelText('Serial number')).toHaveValue('01P00A123456789');
  });

  it('keeps the created machine usable when the dialog is cancelled after the first step', async () => {
    const recorded = backend(MANAGE);
    const user = userEvent.setup();
    const dialog = await openWizard(user);
    await fillMachineStep(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }));
    await waitFor(() => expect(recorded.setup).toHaveLength(1));
    await within(dialog).findByRole('radio', { name: /Connect a connector now/ });
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(await within(dialog).findByRole('button', { name: 'Save and continue' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByText('Lab printer was saved. Finish its setup from the machine page.'),
    ).toBeInTheDocument();
  });

  it('shows a read-only note for the connection step without printer_connectors.manage', async () => {
    const recorded = backend([PermissionId.machinesread, PermissionId.machinesmanage]);
    const user = userEvent.setup();
    renderPage('/machine-logbook/machines');
    await clickAddMachine(user);
    const dialog = await screen.findByRole('dialog', { name: 'Add machine' });
    await fillMachineStep(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }));
    expect(await within(dialog).findByText('Connecting a printer needs the connector permission')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByDisplayValue('AMS 2 Pro')).toBeInTheDocument();
    expect(recorded.assignment).toBeUndefined();
  });
});

describe('Printer setup tab', () => {
  function detail(
    permissions: PermissionId[],
    {
      profile = templateProfile(),
      live = liveStatusOf() as ReturnType<typeof liveStatusOf> | null,
      assignments = [assignmentOf()],
    } = {},
  ) {
    auth.permissions = permissions;
    const requests: { setup: Record<string, unknown>[]; patch: Record<string, unknown>[] } = { setup: [], patch: [] };
    let currentProfile = profile;
    server.use(
      http.get(`*/api/v1/machines/${printerId}`, () => HttpResponse.json(printer)),
      http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: types })),
      http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/machines/${printerId}/printer`, () => HttpResponse.json(currentProfile)),
      http.get(`*/api/v1/machines/${printerId}/printer/live-status`, () =>
        live ? HttpResponse.json(live) : HttpResponse.json({ code: 'not_found' }, { status: 404 }),
      ),
      http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: [connectorOf()] })),
      http.get(`*/api/v1/printer-connectors/${connectorId}/assignments`, () =>
        HttpResponse.json({ items: assignments }),
      ),
      http.put(`*/api/v1/machines/${printerId}/printer/setup`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        requests.setup.push(body);
        currentProfile = { ...currentProfile, version: currentProfile.version + 1 };
        return HttpResponse.json(currentProfile);
      }),
      http.patch(`*/api/v1/printer-connectors/${connectorId}/assignments/${assignmentId}`, async ({ request }) => {
        requests.patch.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(assignmentOf({ version: 4 }));
      }),
    );
    return requests;
  }
  const open = async () => {
    const user = userEvent.setup();
    renderPage(`/machine-logbook/machines/${printerId}?tab=printer`);
    return user;
  };

  it('offers detected units that are not set up and saves them with the existing units', async () => {
    const requests = detail([PermissionId.machinesread, PermissionId.machinesmanage]);
    const user = await open();
    expect(
      await screen.findByText("The printer reports AMS HT (128), which isn't set up", undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add as input unit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit spool inputs' });
    expect(within(dialog).getByDisplayValue('AMS HT')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save spool inputs' }));
    await waitFor(() => expect(requests.setup).toHaveLength(1));
    const body = requests.setup[0] as {
      expectedVersion: number;
      inputUnits: { name: string; externalIdentifier: string | null; nozzle: string | null }[];
    };
    expect(body.expectedVersion).toBe(4);
    expect(body.inputUnits.map((unit) => [unit.name, unit.externalIdentifier])).toEqual([
      ['AMS 2 Pro', '0'],
      ['External spool L', '255'],
      ['External spool R', '254'],
      ['AMS HT', '128'],
    ]);
  });

  it('matches slots automatically by the identifiers the printer reports', async () => {
    const profile = templateProfile();
    profile.slots = profile.slots.map((slot) =>
      slot.inputUnitId === 'unit-ams' ? { ...slot, externalIdentifier: null } : slot,
    );
    const requests = detail([PermissionId.machinesread, PermissionId.machinesmanage], { profile });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Edit spool inputs' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit spool inputs' });
    await user.click(within(dialog).getByRole('button', { name: 'Match automatically' }));
    expect(await screen.findByText('6 of 6 slots matched')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save spool inputs' }));
    await waitFor(() => expect(requests.setup).toHaveLength(1));
    const body = requests.setup[0] as {
      inputUnits: { name: string; slots: { externalIdentifier: string | null }[] }[];
    };
    expect(body.inputUnits[0].slots.map((slot) => slot.externalIdentifier)).toEqual(['0', '1', '2', '3']);
  });

  it('blocks saving when two slots use the same printer slot', async () => {
    const profile = templateProfile();
    profile.slots = profile.slots.map((slot) =>
      slot.id === 'slot-ams-1' ? { ...slot, externalIdentifier: '0' } : slot,
    );
    const requests = detail([PermissionId.machinesread, PermissionId.machinesmanage], { profile });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Edit spool inputs' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit spool inputs' });
    expect((await within(dialog).findAllByText('Another slot already uses this printer slot.')).length).toBe(2);
    expect(within(dialog).getByRole('button', { name: 'Save spool inputs' })).toBeDisabled();
    expect(requests.setup).toHaveLength(0);
  });

  it('shows the connection, never the LAN access code, and does not send a blank credential when editing', async () => {
    const requests = detail([...MANAGE]);
    const user = await open();
    expect(await screen.findByText('192.168.1.42', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getAllByText('01P00A123456789').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Print room agent' })).toHaveAttribute(
      'href',
      '/settings/local-services?tab=connectors',
    );
    await user.click(screen.getByRole('button', { name: 'Edit connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit connection' });
    expect(within(dialog).getByLabelText('New LAN access code (optional)')).toHaveValue('');
    const ip = within(dialog).getByLabelText('Printer IPv4 address');
    await user.clear(ip);
    await user.type(ip, '192.168.1.50');
    await user.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    await waitFor(() => expect(requests.patch).toHaveLength(1));
    expect(requests.patch[0]).toMatchObject({
      adapterKind: 'bambu_h2d',
      adapterSchemaVersion: 1,
      settings: { ipAddress: '192.168.1.50', serialNumber: '01P00A123456789', autoDetectSpools: true },
      enabled: true,
      end: false,
      expectedVersion: 3,
    });
    expect(requests.patch[0]).not.toHaveProperty('secrets');
  });

  it('connects a printer later through the live adapter of its model, not only the simulator', async () => {
    const requests = detail([...MANAGE], { live: null, assignments: [] });
    let created: Record<string, unknown> | undefined;
    server.use(
      http.post(`*/api/v1/printer-connectors/${connectorId}/assignments`, async ({ request }) => {
        created = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(assignmentOf(), { status: 201 });
      }),
    );
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Connect printer' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit connection' });
    expect(within(dialog).getByLabelText('Adapter')).toHaveValue('Bambu Lab H2D');
    await user.selectOptions(within(dialog).getByLabelText('Connector'), connectorId);
    await user.type(within(dialog).getByLabelText('Printer IPv4 address'), '192.168.1.42');
    await user.type(within(dialog).getByLabelText('Serial number'), 'SN1');
    await user.type(within(dialog).getByLabelText('LAN access code'), 'code');
    await user.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    await waitFor(() =>
      expect(created).toMatchObject({
        adapterKind: 'bambu_h2d',
        settings: { ipAddress: '192.168.1.42', serialNumber: 'SN1' },
        secrets: { lanAccessCode: 'code' },
      }),
    );
    expect(requests.patch).toHaveLength(0);
  });

  it('hides editing and the connection tile from users without the matching permissions', async () => {
    detail([PermissionId.machinesread]);
    await open();
    await screen.findByRole('switch', undefined, { timeout: 5000 }).catch(() => null);
    await screen.findByText('AMS 2 Pro', undefined, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Edit spool inputs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit connection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Connection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add as input unit' })).not.toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('creates the profile of a printer without one by choosing a model', async () => {
    auth.permissions = [PermissionId.machinesread, PermissionId.machinesmanage];
    const bodies: Record<string, unknown>[] = [];
    let patched = false;
    server.use(
      http.get(`*/api/v1/machines/${printerId}`, () => HttpResponse.json(printer)),
      http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: types })),
      http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/machines/${printerId}/printer`, () =>
        HttpResponse.json({ code: 'not_found' }, { status: 404 }),
      ),
      http.get(`*/api/v1/machines/${printerId}/printer/live-status`, () =>
        HttpResponse.json({ code: 'not_found' }, { status: 404 }),
      ),
      http.patch(`*/api/v1/machines/${printerId}`, () => {
        patched = true;
        return HttpResponse.json(printer);
      }),
      http.put(`*/api/v1/machines/${printerId}/printer/setup`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(templateProfile());
      }),
    );
    const user = userEvent.setup();
    renderPage(`/machine-logbook/machines/${printerId}?tab=printer`);
    await user.click(await screen.findByRole('button', { name: 'Create profile' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit machine' });
    await user.click(await within(dialog).findByRole('radio', { name: /Prusa CORE One/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save machine' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(patched).toBe(true);
    expect(bodies[0]).toMatchObject({ expectedVersion: null, enabled: true, model: 'prusa_core_one' });
    expect((bodies[0] as { inputUnits: { name: string; externalIdentifier: unknown }[] }).inputUnits).toEqual([
      {
        name: 'Direct feed',
        nozzle: null,
        externalIdentifier: null,
        slots: [{ name: 'Extruder', status: 'available', externalIdentifier: null }],
      },
    ]);
  });
});
