import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  PermissionId,
  type FilamentSpool,
  type Machine,
  type MachineActivity,
  type MachineType,
  type PrinterProfile,
} from '../../api/generated/models';
import { server } from '../../test/server';
import { testQueryClient } from '../../test/render';
import { MachineDetailPage } from './MachineDetailPage';
import { MachinesPage } from './MachinesPage';
import { LocalServicesPage } from '../localservices/LocalServicesPage';
import { ToastProvider } from './shared/toasts';

// These pages are rendered directly (not through App) so the printer tab works before the interim route glue is removed.
const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

function renderPage(route: string) {
  const queryClient = testQueryClient();
  const router = createMemoryRouter(
    [
      {
        path: '/machine-logbook',
        element: (
          <ToastProvider>
            <Outlet />
          </ToastProvider>
        ),
        children: [
          { path: 'machines', element: <MachinesPage /> },
          { path: 'machines/:machineId', element: <MachineDetailPage /> },
        ],
      },
      { path: '/settings/local-services', element: <LocalServicesPage /> },
    ],
    { initialEntries: [route] },
  );
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

const now = '2026-09-15T11:26:00Z';
const laserTypeId = '0192f6f8-743e-7c77-a349-cd07c3e8b001';
const printerTypeId = '0192f6f8-743e-7c77-a349-cd07c3e8b002';
const types: MachineType[] = [
  {
    id: laserTypeId,
    name: 'Laser',
    active: true,
    process: 'laser_cutting',
    version: 3,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: printerTypeId,
    name: '3D printer',
    active: true,
    process: 'fdm_printing',
    version: 1,
    createdAt: now,
    updatedAt: now,
  },
];

function machine(id: string, name: string, overrides: Partial<Machine> = {}): Machine {
  return {
    id,
    name,
    machineType: types[0],
    status: 'active',
    automaticCollectionEnabled: false,
    jobCount: 3,
    runtimeSeconds: 7200,
    failureRate: '4.2',
    version: 7,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const laser = machine('0192f6f8-743e-7c77-a349-cd07c3e8c001', 'Laser cutter');
const bambu = machine('0192f6f8-743e-7c77-a349-cd07c3e8c002', 'Bambu H2D', {
  machineType: types[1],
  automaticCollectionEnabled: true,
  externalIdentifier: 'BH2D-1',
  lastIngestedAt: now,
  jobCount: 40,
  failureRate: '10',
});
const saw = machine('0192f6f8-743e-7c77-a349-cd07c3e8c003', 'Old saw', { status: 'retired' });
const mill = machine('0192f6f8-743e-7c77-a349-cd07c3e8c004', 'CNC mill', { status: 'maintenance' });
const runId = '0192f6f8-743e-7c77-a349-cd07c3e8d001';

const activity: MachineActivity[] = [
  { machineId: laser.id, availability: 'available', lastJobStartedAt: '2026-01-02T10:00:00Z' },
  {
    machineId: bambu.id,
    availability: 'in_use',
    connector: { runtimeState: 'degraded', runtimeErrorCode: 'E42' },
    current: {
      kind: 'run',
      id: runId,
      displayId: 'RN-1',
      fileName: 'gearbox_housing_v3.gcode',
      startedAt: now,
      endsAt: '2099-01-01T12:00:00Z',
    },
  },
  { machineId: saw.id, availability: 'retired' },
  { machineId: mill.id, availability: 'maintenance' },
];

const profile: PrinterProfile = {
  machineId: bambu.id,
  machineName: bambu.name,
  enabled: true,
  model: null,
  version: 4,
  createdAt: now,
  updatedAt: now,
  inputUnits: [
    { id: 'unit-1', machineId: bambu.id, name: 'Direct feed', enabled: true, position: 0, nozzle: null, version: 1 },
  ],
  slots: [
    {
      id: 'slot-1',
      machineId: bambu.id,
      inputUnitId: 'unit-1',
      inputUnitName: 'Direct feed',
      name: 'Feed slot',
      position: 0,
      status: 'available',
      version: 1,
    },
  ],
};

const spool = {
  id: 'spool-1',
  displayId: 'S-0001',
  kind: 'standard',
  status: 'in_stock',
  fillNumber: 1,
  remainingQuantity: '850.000',
  unit: 'g',
  materialName: 'PLA Black',
  mounted: false,
  lifecycle: 'active',
  identifiers: [],
  version: 1,
  createdAt: now,
  updatedAt: now,
} as unknown as FilamentSpool;

function setup(
  permissions: PermissionId[],
  { profileResponse = profile as PrinterProfile | null }: { profileResponse?: PrinterProfile | null } = {},
) {
  auth.permissions = permissions;
  server.use(
    http.get('*/api/v1/machines', () =>
      HttpResponse.json({ items: [laser, bambu, saw, mill], page: 1, pageSize: 100, total: 4 }),
    ),
    http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: types })),
    http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: activity })),
    http.get(`*/api/v1/machines/${bambu.id}`, () => HttpResponse.json(bambu)),
    http.get(`*/api/v1/machines/${laser.id}`, () => HttpResponse.json(laser)),
    http.get(`*/api/v1/machines/${bambu.id}/printer`, () =>
      profileResponse ? HttpResponse.json(profileResponse) : HttpResponse.json({ code: 'not_found' }, { status: 404 }),
    ),
    http.get(`*/api/v1/machines/${laser.id}/printer`, () => HttpResponse.json({ code: 'not_found' }, { status: 404 })),
    http.get(`*/api/v1/machines/${bambu.id}/printer/live-status`, () =>
      HttpResponse.json({ code: 'not_found' }, { status: 404 }),
    ),
    http.get('*/api/v1/machine-logbook/work-items', () =>
      HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 }),
    ),
  );
}

const iconButton = (label: string) =>
  screen
    .getByText(label, { selector: '.cds--tooltip-content' })
    .closest('.cds--popover-container')!
    .querySelector('button') as HTMLElement;
const rowFor = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement;

describe('Machines list', () => {
  it('shows availability, current run, last job and connector issues from machine activity and hides retired machines', async () => {
    setup([PermissionId.machinesread, PermissionId.machine_jobsread]);
    renderPage('/machine-logbook/machines');
    expect(await screen.findByRole('link', { name: 'Bambu H2D' }, { timeout: 5000 })).toHaveAttribute(
      'href',
      `/machine-logbook/machines/${bambu.id}`,
    );

    const bambuRow = within(rowFor('Bambu H2D'));
    expect(bambuRow.getAllByText('In use').length).toBeGreaterThan(0);
    expect(bambuRow.getAllByText('Connector issue').length).toBeGreaterThan(0);
    expect(bambuRow.getByRole('link', { name: 'Gearbox housing v3' })).toHaveAttribute(
      'href',
      `/machine-logbook/jobs/runs/${runId}`,
    );
    expect(bambuRow.getByText('3D printer')).toBeInTheDocument();
    expect(bambuRow.getByText('10%')).toBeInTheDocument();

    const laserRow = within(rowFor('Laser cutter'));
    expect(laserRow.getAllByText('Available').length).toBeGreaterThan(0);
    expect(laserRow.getByText(/^Last job /)).toBeInTheDocument();
    expect(within(rowFor('CNC mill')).getByText('Marked for maintenance')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Old saw' })).not.toBeInTheDocument();
  });

  it('shows retired machines when the status filter selects them', async () => {
    setup([PermissionId.machinesread]);
    const user = userEvent.setup();
    renderPage('/machine-logbook/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    await user.click(iconButton('Filters'));
    await user.click(screen.getByRole('checkbox', { name: 'Retired' }));
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByRole('link', { name: 'Old saw' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Laser cutter' })).not.toBeInTheDocument();
    expect(within(rowFor('Old saw')).getByText('Retired', { selector: '.mj-secondary' })).toBeInTheDocument();
  });

  it('filters by type, collection and connector from the URL and searches by name', async () => {
    setup([PermissionId.machinesread]);
    const user = userEvent.setup();
    const { unmount } = renderPage(`/machine-logbook/machines?type=${printerTypeId}`);
    await screen.findByRole('link', { name: 'Bambu H2D' }, { timeout: 5000 });
    expect(screen.queryByRole('link', { name: 'Laser cutter' })).not.toBeInTheDocument();
    unmount();

    const second = renderPage('/machine-logbook/machines?collection=manual&connector=none');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    expect(screen.queryByRole('link', { name: 'Bambu H2D' })).not.toBeInTheDocument();
    second.unmount();

    renderPage('/machine-logbook/machines?connector=issue');
    await screen.findByRole('link', { name: 'Bambu H2D' }, { timeout: 5000 });
    expect(screen.queryByRole('link', { name: 'Laser cutter' })).not.toBeInTheDocument();
    await user.click(iconButton('Filters (1 applied)'));
    expect(screen.getByRole('checkbox', { name: 'Issue' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(await screen.findByRole('link', { name: 'Laser cutter' })).toBeInTheDocument();
  });

  it('searches the availability label, the process label and a connector issue', async () => {
    setup([PermissionId.machinesread]);
    const user = userEvent.setup();
    renderPage('/machine-logbook/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    const search = screen.getByLabelText('Search machines', { selector: 'input' });
    await user.type(search, 'maintenance');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Laser cutter' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'CNC mill' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'FDM 3D');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Laser cutter' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Bambu H2D' })).toBeInTheDocument();
  });

  it('keeps Machines and Machine types and sends the former Connectors tab to Settings, Local services', async () => {
    setup([PermissionId.machinesread]);
    const readOnly = renderPage('/machine-logbook/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Machines', 'Machine types']);
    readOnly.unmount();

    setup([PermissionId.machinesread, PermissionId.printer_connectorsread]);
    server.use(http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: [], coreVersion: '0.8.3' })));
    const { router } = renderPage('/machine-logbook/machines?tab=connectors');
    expect(
      await screen.findByRole('tab', { name: 'Printer connectors', selected: true }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/local-services');
    expect(router.state.location.search).toBe('?tab=connectors');
  });

  it('only offers Add machine with machines.manage', async () => {
    setup([PermissionId.machinesread]);
    const readOnly = renderPage('/machine-logbook/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Add machine' })).not.toBeInTheDocument();
    readOnly.unmount();

    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    renderPage('/machine-logbook/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    expect(
      within(document.querySelector('.cds--table-toolbar') as HTMLElement).getByRole('button', { name: 'Add machine' }),
    ).toBeInTheDocument();
  });

  it('lists the machine types with their process and offers changes only with machines.manage', async () => {
    setup([PermissionId.machinesread]);
    const readOnly = renderPage('/machine-logbook/machines?tab=types');
    const table = await screen.findByRole('table', { name: 'Machine types' }, { timeout: 5000 });
    expect(within(table).getByText('Laser')).toBeInTheDocument();
    expect(within(table).getByText('3D printer')).toBeInTheDocument();
    expect(within(table).getByText('FDM 3D printing')).toBeInTheDocument();
    expect(within(table).getByText('Laser cutting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add type' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    readOnly.unmount();

    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    renderPage('/machine-logbook/machines?tab=types');
    expect(await screen.findByRole('button', { name: 'Add type' }, { timeout: 5000 })).toBeInTheDocument();
    expect(iconButton('Actions for Laser')).toBeInTheDocument();
  });

  it('creates, renames and deactivates machine types and picks their process with their version', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    const patches: unknown[] = [];
    let created: unknown;
    server.use(
      http.post('*/api/v1/machine-types', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ ...types[0], id: 'new-type', name: 'Vinyl', version: 1 }, { status: 201 });
      }),
      http.patch(`*/api/v1/machine-types/${laserTypeId}`, async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json(types[0]);
      }),
    );
    const user = userEvent.setup();
    renderPage('/machine-logbook/machines?tab=types');
    await screen.findByRole('table', { name: 'Machine types' }, { timeout: 5000 });
    await user.click(iconButton('Actions for Laser'));
    await user.click(
      await screen.findByText('Deactivate', { selector: '.cds--overflow-menu-options__option-content' }),
    );
    await waitFor(() => expect(patches).toContainEqual({ active: false, expectedVersion: 3 }));

    await user.click(iconButton('Actions for Laser'));
    await user.click(await screen.findByText('Edit', { selector: '.cds--overflow-menu-options__option-content' }));
    const rename = await screen.findByRole('dialog', { name: 'Edit machine type' });
    await user.clear(within(rename).getByLabelText('Name'));
    await user.type(within(rename).getByLabelText('Name'), 'Laser line');
    await user.click(within(rename).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patches).toContainEqual({ name: 'Laser line', process: 'laser_cutting', expectedVersion: 3 }),
    );

    await user.click(screen.getByRole('button', { name: 'Add type' }));
    const add = await screen.findByRole('dialog', { name: 'Add machine type' });
    await user.type(within(add).getByLabelText('Name'), 'Vinyl');
    await user.selectOptions(within(add).getByLabelText('Process'), 'vinyl_cutting');
    expect(within(add).getByText(/Plotter runtime/)).toBeInTheDocument();
    await user.click(within(add).getByRole('button', { name: 'Add type' }));
    await waitFor(() => expect(created).toEqual({ name: 'Vinyl', process: 'vinyl_cutting' }));
  });

  it('rejects a machine type name that is already used', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    const user = userEvent.setup();
    renderPage('/machine-logbook/machines?tab=types');
    await user.click(await screen.findByRole('button', { name: 'Add type' }, { timeout: 5000 }));
    const add = await screen.findByRole('dialog', { name: 'Add machine type' });
    await user.type(within(add).getByLabelText('Name'), 'laser');
    expect(await within(add).findByText('This name is already used.')).toBeInTheDocument();
    expect(within(add).getByRole('button', { name: 'Add type' })).toBeDisabled();
  });

  it('creates a machine of a non-printer type with the Add machine wizard, skipping connection and spool inputs', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    const newId = '0192f6f8-743e-7c77-a349-cd07c3e8c009';
    let body: unknown;
    server.use(
      http.post('*/api/v1/machines', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(machine(newId, 'Vinyl cutter'), { status: 201 });
      }),
      http.get(`*/api/v1/machines/${newId}`, () => HttpResponse.json(machine(newId, 'Vinyl cutter'))),
      http.get(`*/api/v1/machines/${newId}/printer`, () => HttpResponse.json({ code: 'not_found' }, { status: 404 })),
    );
    const user = userEvent.setup();
    const { router } = renderPage('/machine-logbook/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    await user.click(document.querySelector('.cds--table-toolbar')!.querySelector<HTMLElement>('.cds--btn--primary')!);
    const dialog = await screen.findByRole('dialog', { name: 'Add machine' });
    await user.type(within(dialog).getByLabelText('Name'), ' Vinyl cutter ');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Laser' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Machine type'), laserTypeId);
    expect(within(dialog).queryByText('Model')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }));
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Vinyl cutter',
        machineTypeId: laserTypeId,
        status: 'active',
        externalIdentifier: null,
        automaticCollectionEnabled: false,
      }),
    );
    expect(await within(dialog).findByLabelText('Machine summary')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Connection summary')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Spool inputs summary')).not.toBeInTheDocument();
    await user.click(await within(dialog).findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/machine-logbook/machines/${newId}`));
  });
});

describe('Machine detail', () => {
  it('shows the header, connector warning, facts and current item from machine activity', async () => {
    setup([PermissionId.machinesread, PermissionId.machine_jobsread]);
    renderPage(`/machine-logbook/machines/${bambu.id}`);
    expect(await screen.findByRole('heading', { name: 'Bambu H2D' }, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText('Connector degraded · E42')).toBeInTheDocument();
    expect(screen.getByText('In use now')).toBeInTheDocument();
    expect(screen.getByText(/Unassigned run · started/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gearbox housing v3' })).toHaveAttribute(
      'href',
      `/machine-logbook/jobs/runs/${runId}`,
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByText('BH2D-1')).toBeInTheDocument();
  });

  it('gates New job, Edit machine and the printer tab by permission', async () => {
    setup([PermissionId.machinesread]);
    const readOnly = renderPage(`/machine-logbook/machines/${laser.id}`);
    expect(await screen.findByRole('heading', { name: 'Laser cutter' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New job' })).not.toBeInTheDocument();
    expect(screen.queryByText('More machine actions', { selector: '.cds--tooltip-content' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Printer setup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Jobs' })).not.toBeInTheDocument();
    readOnly.unmount();

    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    const manager = renderPage(`/machine-logbook/machines/${laser.id}`);
    expect(
      await screen.findByText('More machine actions', { selector: '.cds--tooltip-content' }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Only machines of a printer type (or with a profile) get the Printer setup tab.
    expect(screen.queryByRole('tab', { name: 'Printer setup' })).not.toBeInTheDocument();
    manager.unmount();

    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    server.use(
      http.get(`*/api/v1/machines/${bambu.id}/printer`, () =>
        HttpResponse.json({ code: 'not_found' }, { status: 404 }),
      ),
    );
    const printerManager = renderPage(`/machine-logbook/machines/${bambu.id}`);
    expect(await screen.findByRole('tab', { name: 'Printer setup' }, { timeout: 5000 })).toBeInTheDocument();
    printerManager.unmount();

    setup([PermissionId.machinesread, PermissionId.machine_jobsread, PermissionId.machine_jobscreate]);
    renderPage(`/machine-logbook/machines/${laser.id}`);
    expect(await screen.findByRole('button', { name: 'New job' }, { timeout: 5000 })).toBeInTheDocument();
  });

  it('shows the printer tab to read-only users when a profile exists, and selects tabs from the URL', async () => {
    setup([PermissionId.machinesread]);
    const { router } = renderPage(`/machine-logbook/machines/${bambu.id}?tab=printer`);
    expect(await screen.findByRole('tab', { name: 'Printer setup' }, { timeout: 5000 })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText('Direct feed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add input unit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mount spool' })).not.toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=overview'));
  });

  it('mounts a spool from the unmounted consumable spools', async () => {
    setup([PermissionId.machinesread, PermissionId.printer_slotsassign, PermissionId.inventoryread]);
    let spoolQuery: URLSearchParams | undefined;
    let mounted: unknown;
    server.use(
      http.get('*/api/v1/filament-spools', ({ request }) => {
        spoolQuery = new URL(request.url).searchParams;
        return HttpResponse.json({ items: [spool], page: 1, pageSize: 100, total: 1 });
      }),
      http.post('*/api/v1/printer-slots/slot-1/mount', async ({ request }) => {
        mounted = await request.json();
        return HttpResponse.json({ ...profile.slots[0], spoolId: 'spool-1', spoolDisplayId: 'S-0001' });
      }),
    );
    const user = userEvent.setup();
    renderPage(`/machine-logbook/machines/${bambu.id}?tab=printer`);
    await user.click(await screen.findByRole('button', { name: 'Mount spool' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Mount spool' });
    await user.click(await within(dialog).findByRole('combobox', { name: 'Spool' }));
    await user.click(await screen.findByRole('option', { name: /S-0001/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Mount spool' }));
    await waitFor(() => expect(mounted).toEqual({ spoolId: 'spool-1' }));
    expect(spoolQuery?.get('consumable')).toBe('true');
    expect(spoolQuery?.get('mounted')).toBe('false');
  });

  it('refreshes an open printer setup when the connector mounts a spool', async () => {
    setup([PermissionId.machinesread, PermissionId.inventoryread]);
    let requests = 0;
    server.use(
      http.get(`*/api/v1/machines/${bambu.id}/printer`, () => {
        requests += 1;
        const slots =
          requests === 1
            ? profile.slots
            : [{ ...profile.slots[0], spoolId: spool.id, spoolDisplayId: spool.displayId }];
        return HttpResponse.json({ ...profile, slots, version: requests });
      }),
      http.get('*/api/v1/filament-spools', () =>
        HttpResponse.json({ items: [{ ...spool, mounted: true }], page: 1, pageSize: 100, total: 1 }),
      ),
    );
    renderPage(`/machine-logbook/machines/${bambu.id}?tab=printer`);
    expect(await screen.findByText('Empty', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/S-0001.*PLA Black/, undefined, { timeout: 7000 })).toBeInTheDocument();
    expect(requests).toBeGreaterThan(1);
  });

  it('does not offer mounting without inventory.read and never queries spools', async () => {
    setup([PermissionId.machinesread, PermissionId.printer_slotsassign]);
    let spoolReads = 0;
    server.use(
      http.get('*/api/v1/filament-spools', () => {
        spoolReads++;
        return HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 });
      }),
    );
    renderPage(`/machine-logbook/machines/${bambu.id}?tab=printer`);
    await screen.findByText('Feed slot', undefined, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Mount spool' })).not.toBeInTheDocument();
    expect(spoolReads).toBe(0);
  });

  it('offers Unmount for mounted slots to printer_slots.assign and calls the API', async () => {
    const mountedProfile: PrinterProfile = {
      ...profile,
      slots: [{ ...profile.slots[0], spoolId: 'spool-1', spoolDisplayId: 'S-0001' }],
    };
    setup([PermissionId.machinesread, PermissionId.printer_slotsassign], { profileResponse: mountedProfile });
    let unmounted = false;
    server.use(
      http.post('*/api/v1/printer-slots/slot-1/unmount', () => {
        unmounted = true;
        return HttpResponse.json(profile.slots[0]);
      }),
    );
    const user = userEvent.setup();
    renderPage(`/machine-logbook/machines/${bambu.id}?tab=printer`);
    expect(await screen.findByText('S-0001', undefined, { timeout: 5000 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unmount' }));
    await waitFor(() => expect(unmounted).toBe(true));
  });
});

describe('Delete machine', () => {
  const openDelete = async (user: ReturnType<typeof userEvent.setup>) => {
    renderPage(`/machine-logbook/machines/${laser.id}`);
    expect(await screen.findByRole('heading', { name: 'Laser cutter' }, { timeout: 5000 })).toBeInTheDocument();
    await user.click(iconButton('More machine actions'));
    await user.click(await screen.findByText('Delete machine'));
    return screen.findByRole('alertdialog', { name: 'Delete this machine?' });
  };

  it('deletes the machine with its version and returns to the machine list', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    let body: unknown;
    server.use(
      http.delete(`*/api/v1/machines/${laser.id}`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete machine' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: laser.version }));
    expect(await screen.findByRole('heading', { name: 'Machines' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Laser cutter was deleted.')).toBeInTheDocument();
  });

  it('explains that a machine with history is retired instead and blocks the confirmation', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    server.use(
      http.delete(`*/api/v1/machines/${laser.id}`, () =>
        HttpResponse.json({ code: 'machine_in_use', message: 'in use' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete machine' }));
    expect(await within(dialog).findByText('Machine has history')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete machine' })).toBeDisabled();
  });

  it('saves edits made in the Edit machine dialog', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch(`*/api/v1/machines/${laser.id}`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...laser, status: 'maintenance', version: laser.version + 1 });
      }),
    );
    const user = userEvent.setup();
    renderPage(`/machine-logbook/machines/${laser.id}`);
    expect(await screen.findByRole('heading', { name: 'Laser cutter' }, { timeout: 5000 })).toBeInTheDocument();
    await user.click(iconButton('More machine actions'));
    await user.click(await screen.findByText('Edit machine'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit machine' });
    await user.click(within(dialog).getByRole('radio', { name: 'Maintenance' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save machine' }));
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Laser cutter',
        machineTypeId: laserTypeId,
        status: 'maintenance',
        externalIdentifier: null,
        automaticCollectionEnabled: false,
        expectedVersion: laser.version,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit machine' })).not.toBeInTheDocument());
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument();
  });

  it('is not offered without machines.manage', async () => {
    setup([PermissionId.machinesread]);
    renderPage(`/machine-logbook/machines/${laser.id}`);
    expect(await screen.findByRole('heading', { name: 'Laser cutter' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText('More machine actions', { selector: '.cds--tooltip-content' })).not.toBeInTheDocument();
    expect(screen.queryByText('Delete machine')).not.toBeInTheDocument();
  });
});

describe('Printer setup', () => {
  it.each([404, 500])('treats only a profile 404 as absent (status %s)', async (status) => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    server.use(
      http.get(`*/api/v1/machines/${bambu.id}/printer`, () => HttpResponse.json({ code: 'error' }, { status })),
    );
    renderPage(`/machine-logbook/machines/${bambu.id}?tab=printer`);
    if (status === 404)
      expect(await screen.findByRole('button', { name: 'Create profile' }, { timeout: 5000 })).toBeInTheDocument();
    else {
      await screen.findByText('Printer setup could not be loaded.', undefined, { timeout: 5000 });
      expect(screen.queryByRole('button', { name: 'Create profile' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    }
  });

  it('disables an existing profile only after confirmation, using its current version', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    let input: unknown;
    server.use(
      http.put(`*/api/v1/machines/${bambu.id}/printer`, async ({ request }) => {
        input = await request.json();
        return HttpResponse.json({ ...profile, enabled: false, version: 5 });
      }),
    );
    const user = userEvent.setup();
    renderPage(`/machine-logbook/machines/${bambu.id}?tab=printer`);
    await user.click(await screen.findByRole('switch', { name: 'Printer profile enabled' }, { timeout: 5000 }));
    expect(input).toBeUndefined();
    expect(
      screen.getByText(/Existing prints and history are kept, and you can enable the profile again/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disable profile' }));
    await waitFor(() => expect(input).toEqual({ enabled: false, expectedVersion: 4 }));
  });
});
