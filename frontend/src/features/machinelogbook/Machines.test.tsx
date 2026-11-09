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
  type PrinterProfile,
} from '../../api/generated/models';
import { server } from '../../test/server';
import { testQueryClient } from '../../test/render';
import { MachineDetailPage } from './MachineDetailPage';
import { MachinesPage } from './MachinesPage';
import { laserProcessId, printerProcessId, processes } from './printerTestData';
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
        path: '/workshop',
        element: (
          <ToastProvider>
            <Outlet />
          </ToastProvider>
        ),
        children: [
          { path: 'machines', element: <MachinesPage /> },
          { path: 'machines/:machineId', element: <MachineDetailPage /> },
          { path: 'machines/:machineId/printer', element: <MachineDetailPage section="printer" /> },
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
const laserTypeId = laserProcessId;
const printerTypeId = printerProcessId;
const types = processes;

function machine(id: string, name: string, overrides: Partial<Machine> = {}): Machine {
  return {
    id,
    name,
    process: types[0],
    status: 'active',
    automaticCollectionEnabled: false,
    jobCount: 3,
    runtimeSeconds: 7200,
    failureRate: '4.2',
    attention: [],
    version: 7,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const laser = machine('0192f6f8-743e-7c77-a349-cd07c3e8c001', 'Laser cutter');
const bambu = machine('0192f6f8-743e-7c77-a349-cd07c3e8c002', 'Bambu H2D', {
  process: types[1],
  automaticCollectionEnabled: true,
  externalIdentifier: 'BH2D-1',
  lastIngestedAt: now,
  jobCount: 40,
  failureRate: '10',
  attention: [{ code: 'connector_error', message: 'Connector degraded · E42' }],
});
const saw = machine('0192f6f8-743e-7c77-a349-cd07c3e8c003', 'Old saw', { status: 'retired' });
const mill = machine('0192f6f8-743e-7c77-a349-cd07c3e8c004', 'CNC mill', { status: 'maintenance' });
const embroideryStitches = { key: 'stitches', label: 'Stitches', unit: 'stitch', blockSize: 1000 };
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
  nozzleCount: 1,
  version: 4,
  createdAt: now,
  updatedAt: now,
  inputUnits: [
    {
      id: 'unit-1',
      machineId: bambu.id,
      name: 'Direct feed',
      enabled: true,
      position: 0,
      nozzle: null,
      nozzleIndex: 1,
      version: 1,
    },
  ],
  slots: [
    {
      id: 'slot-1',
      machineId: bambu.id,
      inputUnitId: 'unit-1',
      inputUnitName: 'Direct feed',
      name: 'Feed slot',
      position: 0,
      nozzleIndex: 1,
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
    http.get('*/api/v1/processes', () => HttpResponse.json({ items: types })),
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
    renderPage('/workshop/machines');
    expect(await screen.findByRole('link', { name: 'Bambu H2D' }, { timeout: 5000 })).toHaveAttribute(
      'href',
      `/workshop/machines/${bambu.id}`,
    );

    const bambuRow = within(rowFor('Bambu H2D'));
    expect(bambuRow.getAllByText('In use').length).toBeGreaterThan(0);
    expect(bambuRow.getByText('Degraded · E42')).toBeInTheDocument();
    expect(bambuRow.getAllByText('Connector degraded · E42').length).toBeGreaterThan(0);
    expect(bambuRow.getByRole('link', { name: 'Gearbox housing v3' })).toHaveAttribute(
      'href',
      `/workshop/jobs/runs/${runId}`,
    );
    expect(bambuRow.getByText('3D printer · automatic')).toBeInTheDocument();
    expect(bambuRow.getByText('10 %')).toBeInTheDocument();
    expect(bambuRow.getByText('40')).toBeInTheDocument();

    const laserRow = within(rowFor('Laser cutter'));
    expect(laserRow.getAllByText('Available').length).toBeGreaterThan(0);
    expect(laserRow.getByText(/^Last job /)).toBeInTheDocument();
    expect(within(rowFor('CNC mill')).getByText('Marked for maintenance')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Old saw' })).not.toBeInTheDocument();
  });

  it('shows retired machines when the status filter selects them', async () => {
    setup([PermissionId.machinesread]);
    const user = userEvent.setup();
    renderPage('/workshop/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    await user.click(iconButton('Filters'));
    await user.click(screen.getByRole('checkbox', { name: 'Retired' }));
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByRole('link', { name: 'Old saw' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Laser cutter' })).not.toBeInTheDocument();
    expect(within(rowFor('Old saw')).getByText('Retired', { selector: '.mj-secondary' })).toBeInTheDocument();
  });

  it('filters by process, collection and connector from the URL and searches by name', async () => {
    setup([PermissionId.machinesread]);
    const user = userEvent.setup();
    const { unmount } = renderPage(`/workshop/machines?process=${printerTypeId}`);
    await screen.findByRole('link', { name: 'Bambu H2D' }, { timeout: 5000 });
    expect(screen.queryByRole('link', { name: 'Laser cutter' })).not.toBeInTheDocument();
    unmount();

    const second = renderPage('/workshop/machines?collection=manual&connector=none');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    expect(screen.queryByRole('link', { name: 'Bambu H2D' })).not.toBeInTheDocument();
    second.unmount();

    renderPage('/workshop/machines?connector=issue');
    await screen.findByRole('link', { name: 'Bambu H2D' }, { timeout: 5000 });
    expect(screen.queryByRole('link', { name: 'Laser cutter' })).not.toBeInTheDocument();
    await user.click(iconButton('Filters (1 applied)'));
    expect(screen.getByRole('checkbox', { name: 'Issue' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(await screen.findByRole('link', { name: 'Laser cutter' })).toBeInTheDocument();
  });

  it('searches the availability label, the process name and a connector issue', async () => {
    setup([PermissionId.machinesread]);
    const user = userEvent.setup();
    renderPage('/workshop/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    const search = screen.getByLabelText('Search machines', { selector: 'input' });
    await user.type(search, 'maintenance');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Laser cutter' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'CNC mill' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, '3D printer');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Laser cutter' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Bambu H2D' })).toBeInTheDocument();
  });

  it('keeps Machines and Processes and sends the former Connectors tab to Settings, Local services', async () => {
    setup([PermissionId.machinesread]);
    const readOnly = renderPage('/workshop/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Machines', 'Processes', 'Printers']);
    readOnly.unmount();

    setup([PermissionId.machinesread, PermissionId.printer_connectorsread]);
    server.use(http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: [], coreVersion: '0.8.3' })));
    const { router } = renderPage('/workshop/machines?tab=connectors');
    expect(
      await screen.findByRole('tab', { name: 'Printer connectors', selected: true }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/local-services');
    expect(router.state.location.search).toBe('?tab=connectors');
  });

  it('only offers Add machine with machines.manage', async () => {
    setup([PermissionId.machinesread]);
    const readOnly = renderPage('/workshop/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Add machine' })).not.toBeInTheDocument();
    readOnly.unmount();

    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    renderPage('/workshop/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    expect(
      within(document.querySelector('.cds--table-toolbar') as HTMLElement).getByRole('button', { name: 'Add machine' }),
    ).toBeInTheDocument();
  });

  it('lists the processes with integration and measures and offers changes only with machines.manage', async () => {
    const withEmbroidery = () => {
      server.use(
        http.get('*/api/v1/processes', () =>
          HttpResponse.json({
            items: [...types, { ...types[0], id: 'emb', name: 'Embroidery', measures: [embroideryStitches] }],
          }),
        ),
      );
    };
    setup([PermissionId.machinesread]);
    withEmbroidery();
    const readOnly = renderPage('/workshop/machines?tab=processes');
    const table = await screen.findByRole('table', { name: 'Processes' }, { timeout: 5000 });
    expect(await within(table).findByText('Embroidery')).toBeInTheDocument();
    expect(within(table).getByText('Laser')).toBeInTheDocument();
    expect(within(table).getByText('3D printer (FDM)')).toBeInTheDocument();
    expect(within(table).getByText('Stitches · per 1000 stitch')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add process' })).not.toBeInTheDocument();
    readOnly.unmount();

    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    withEmbroidery();
    renderPage('/workshop/machines?tab=processes');
    expect(await screen.findByRole('button', { name: 'Add process' }, { timeout: 5000 })).toBeInTheDocument();
    expect(iconButton('Actions for Laser')).toBeInTheDocument();
  });

  it('sends the former Machine types tab link to the Processes tab', async () => {
    setup([PermissionId.machinesread]);
    renderPage('/workshop/machines?tab=types');
    expect(await screen.findByRole('table', { name: 'Processes' }, { timeout: 5000 })).toBeInTheDocument();
  });

  it('creates a process with a measure, renames and deactivates processes with their version', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    const patches: unknown[] = [];
    let created: unknown;
    server.use(
      http.post('*/api/v1/processes', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ ...types[0], id: 'new-process', name: 'Embroidery', version: 1 }, { status: 201 });
      }),
      http.patch(`*/api/v1/processes/${laserTypeId}`, async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json(types[0]);
      }),
    );
    const user = userEvent.setup();
    renderPage('/workshop/machines?tab=processes');
    await screen.findByRole('table', { name: 'Processes' }, { timeout: 5000 });
    await user.click(iconButton('Actions for Laser'));
    await user.click(
      await screen.findByText('Deactivate', { selector: '.cds--overflow-menu-options__option-content' }),
    );
    await waitFor(() => expect(patches).toContainEqual({ active: false, expectedVersion: 3 }));

    await user.click(iconButton('Actions for Laser'));
    await user.click(await screen.findByText('Edit', { selector: '.cds--overflow-menu-options__option-content' }));
    const rename = await screen.findByRole('dialog', { name: 'Edit process' });
    await user.clear(within(rename).getByLabelText('Name'));
    await user.type(within(rename).getByLabelText('Name'), 'Laser line');
    await user.click(within(rename).getByRole('button', { name: 'Save' }));
    // Unchanged measures are left out so the stored list stays as it is.
    await waitFor(() =>
      expect(patches).toContainEqual({ name: 'Laser line', integration: 'none', active: true, expectedVersion: 3 }),
    );

    await user.click(screen.getByRole('button', { name: 'Add process' }));
    const add = await screen.findByRole('dialog', { name: 'Add process' });
    await user.type(within(add).getByLabelText('Name'), 'Embroidery');
    await user.click(within(add).getByRole('button', { name: 'Add measure' }));
    await user.type(within(add).getByLabelText('Key'), 'Bad Key');
    await user.type(within(add).getByLabelText('Label'), 'Stitches');
    await user.type(within(add).getByLabelText('Unit'), 'stitch');
    await user.clear(within(add).getByLabelText('Block size'));
    await user.type(within(add).getByLabelText('Block size'), '1000');
    await user.click(within(add).getByRole('button', { name: 'Add process' }));
    expect(await within(add).findByText(/Use 2 to 40 lowercase letters/)).toBeInTheDocument();
    expect(created).toBeUndefined();
    await user.clear(within(add).getByLabelText('Key'));
    await user.type(within(add).getByLabelText('Key'), 'stitches');
    await user.click(within(add).getByRole('button', { name: 'Add process' }));
    await waitFor(() =>
      expect(created).toEqual({
        name: 'Embroidery',
        integration: 'none',
        measures: [embroideryStitches],
      }),
    );
  });

  it('names the measure when removing it is refused because pricing rules or runs use it', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    const embroidery = { ...types[0], id: 'emb', name: 'Embroidery', measures: [embroideryStitches] };
    server.use(
      http.get('*/api/v1/processes', () => HttpResponse.json({ items: [embroidery] })),
      http.patch('*/api/v1/processes/emb', () =>
        HttpResponse.json(
          {
            code: 'measure_in_use',
            message: 'The measure "Stitches" is used by pricing rules or runs and cannot be removed',
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage('/workshop/machines?tab=processes');
    await screen.findByRole('table', { name: 'Processes' }, { timeout: 5000 });
    await user.click(await waitFor(() => iconButton('Actions for Embroidery')));
    await user.click(await screen.findByText('Edit', { selector: '.cds--overflow-menu-options__option-content' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit process' });
    expect(within(dialog).getByLabelText('Key')).toHaveValue('stitches');
    await user.click(
      within(dialog)
        .getByText('Remove measure 1', { selector: '.cds--tooltip-content' })
        .closest('.cds--popover-container')!
        .querySelector('button') as HTMLElement,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/The measure "Stitches" is used/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Edit process' })).toBeInTheDocument();
  });

  it('rejects a process name that is already used', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    const user = userEvent.setup();
    renderPage('/workshop/machines?tab=processes');
    await user.click(await screen.findByRole('button', { name: 'Add process' }, { timeout: 5000 }));
    const add = await screen.findByRole('dialog', { name: 'Add process' });
    await user.type(within(add).getByLabelText('Name'), 'laser');
    await user.click(within(add).getByRole('button', { name: 'Add process' }));
    expect(await within(add).findByText('This name is already used.')).toBeInTheDocument();
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
    const { router } = renderPage('/workshop/machines');
    await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    await user.click(document.querySelector('.cds--table-toolbar')!.querySelector<HTMLElement>('.cds--btn--primary')!);
    const dialog = await screen.findByRole('dialog', { name: 'Add machine' });
    await user.type(within(dialog).getByLabelText('Name'), ' Vinyl cutter ');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Laser' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Process'), laserTypeId);
    expect(within(dialog).queryByText('Model')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create and continue' }));
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Vinyl cutter',
        processId: laserTypeId,
        status: 'active',
        externalIdentifier: null,
        automaticCollectionEnabled: false,
      }),
    );
    expect(await within(dialog).findByLabelText('Machine summary')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Connection summary')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Spool inputs summary')).not.toBeInTheDocument();
    await user.click(await within(dialog).findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workshop/machines/${newId}`));
  });
});

describe('Machine panel', () => {
  const wide = (matches: boolean) =>
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) =>
        ({
          matches,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );

  it('opens the selected machine in the panel on wide screens and closes it again', async () => {
    wide(true);
    try {
      setup([PermissionId.machinesread, PermissionId.machine_jobsread, PermissionId.machine_jobscreate]);
      const user = userEvent.setup();
      const { router } = renderPage('/workshop/machines');
      expect(await screen.findByText('Select a machine to see its details here.', {}, { timeout: 5000 })).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Bambu H2D' }));
      const panel = screen.getByRole('complementary', { name: 'Machine details' });
      expect(within(panel).getByRole('heading', { name: 'Bambu H2D' })).toBeInTheDocument();
      expect(within(panel).getByRole('link', { name: 'Open machine' })).toHaveAttribute(
        'href',
        `/workshop/machines/${bambu.id}`,
      );
      expect(within(panel).getByRole('button', { name: 'New job' })).toBeInTheDocument();
      expect(within(panel).getByText('Failure rate')).toBeInTheDocument();
      expect(await within(panel).findByText('No jobs yet.')).toBeInTheDocument();
      expect(router.state.location.search).toBe(`?machine=${bambu.id}`);
      await user.click(iconButton('Close panel'));
      expect(await screen.findByText('Select a machine to see its details here.')).toBeVisible();
    } finally {
      wide(false);
    }
  });

  it('goes to the machine page from a row on narrow screens', async () => {
    setup([PermissionId.machinesread]);
    const user = userEvent.setup();
    const { router } = renderPage('/workshop/machines');
    const link = await screen.findByRole('link', { name: 'Laser cutter' }, { timeout: 5000 });
    await user.click(within(link.closest('tr') as HTMLElement).getByText('Laser'));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workshop/machines/${laser.id}`));
  });
});

describe('Machine detail', () => {
  it('shows the header, connector warning, facts and current item from machine activity', async () => {
    setup([PermissionId.machinesread, PermissionId.machine_jobsread]);
    renderPage(`/workshop/machines/${bambu.id}`);
    expect(await screen.findByRole('heading', { name: 'Bambu H2D' }, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    expect(screen.getAllByText('Connector degraded · E42').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Now' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Gearbox housing v3' })[0]).toHaveAttribute(
      'href',
      `/workshop/jobs/runs/${runId}`,
    );
    const tiles = screen.getByLabelText('Machine facts');
    expect(within(tiles).getByText('In use')).toBeInTheDocument();
    expect(within(tiles).getByText('10 %')).toBeInTheDocument();
    expect(within(tiles).getByText('Automatic')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getAllByText('BH2D-1').length).toBeGreaterThan(0);
    expect(await screen.findByText('No jobs yet')).toBeInTheDocument();
  });

  it('gates New job, Edit machine and the printer tab by permission', async () => {
    setup([PermissionId.machinesread]);
    const readOnly = renderPage(`/workshop/machines/${laser.id}`);
    expect(await screen.findByRole('heading', { name: 'Laser cutter' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New job' })).not.toBeInTheDocument();
    expect(screen.queryByText('More machine actions', { selector: '.cds--tooltip-content' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Printer setup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Jobs' })).not.toBeInTheDocument();
    readOnly.unmount();

    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    const manager = renderPage(`/workshop/machines/${laser.id}`);
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
    const printerManager = renderPage(`/workshop/machines/${bambu.id}`);
    expect(await screen.findByRole('tab', { name: 'Printer setup' }, { timeout: 5000 })).toBeInTheDocument();
    printerManager.unmount();

    setup([PermissionId.machinesread, PermissionId.machine_jobsread, PermissionId.machine_jobscreate]);
    renderPage(`/workshop/machines/${laser.id}`);
    expect(await screen.findByRole('button', { name: 'New job' }, { timeout: 5000 })).toBeInTheDocument();
  });

  it('shows the printer setup to read-only users when a profile exists and moves the former tab link to its page', async () => {
    setup([PermissionId.machinesread]);
    const { router } = renderPage(`/workshop/machines/${bambu.id}?tab=printer`);
    expect(await screen.findByRole('tab', { name: 'Printer setup' }, { timeout: 5000 })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(router.state.location.pathname).toBe(`/workshop/machines/${bambu.id}/printer`);
    expect(await screen.findByRole('heading', { name: 'Direct feed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit slots' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mount' })).not.toBeInTheDocument();
    const enabled = screen.getByRole('switch', { name: 'Printer profile enabled' });
    expect(enabled).toBeChecked();
    expect(enabled).toBeDisabled();

    await userEvent.setup().click(screen.getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workshop/machines/${bambu.id}`));
  });

  it('names the nozzle each unit feeds on a printer with several nozzles', async () => {
    setup([PermissionId.machinesread], {
      profileResponse: {
        ...profile,
        nozzleCount: 2,
        inputUnits: [{ ...profile.inputUnits[0], nozzleIndex: 2, nozzle: 'right' }],
      },
    });
    renderPage(`/workshop/machines/${bambu.id}/printer`);
    expect(await screen.findByText(/feeds nozzle 2 \(right\)/, undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it.each([
    ['only a chip UID', null, { kind: 'nfc', value: 'TAG-1' }],
    [
      'a tray UUID',
      '0123456789ABCDEF0123456789ABCDEF',
      { kind: 'bambu_tray_uuid', value: '0123456789ABCDEF0123456789ABCDEF' },
    ],
  ])(
    'registers the spool a printer reports with %s in a slot and mounts it there',
    async (_name, trayUuid, identifier) => {
      setup([
        PermissionId.machinesread,
        PermissionId.printer_slotsassign,
        PermissionId.inventoryread,
        PermissionId.inventorymanage,
      ]);
      const article = {
        id: 'material-1',
        displayId: 'A-0001',
        name: 'PLA Basic Black',
        kind: 'filament',
        materialTypeId: 'type-1',
        materialTypeName: 'PLA',
        materialTypeCode: 'PLA',
        machineUse: true,
        colorName: 'Black',
        colorHex: '#111111',
        packageSize: '1000',
        unit: 'g',
        active: true,
        unassignedQuantity: '2000',
        inventoryVersion: 9,
      };
      let created: Record<string, unknown> | undefined;
      let mounted: unknown;
      server.use(
        http.get(`*/api/v1/machines/${bambu.id}/printer`, () =>
          HttpResponse.json({
            ...profile,
            inputUnits: [{ ...profile.inputUnits[0], externalIdentifier: '0' }],
            slots: [{ ...profile.slots[0], externalIdentifier: '1' }],
          }),
        ),
        http.get(`*/api/v1/machines/${bambu.id}/printer/live-status`, () =>
          HttpResponse.json({
            machineId: bambu.id,
            assignmentId: 'assignment-1',
            receivedAt: now,
            observedAt: now,
            status: {
              state: 'idle',
              job: null,
              temperatures: { extruders: [], bedC: null, bedTargetC: null, chamberC: null },
              nozzles: [],
              units: [
                {
                  externalId: '0',
                  label: 'AMS 1',
                  kind: 'ams',
                  trays: [
                    {
                      externalId: '1',
                      materialType: 'PLA',
                      subBrand: 'PLA Basic',
                      colorHex: '111111',
                      remainPercent: 50,
                      rfid: true,
                      tagUid: 'TAG-1',
                      trayUuid,
                      empty: false,
                    },
                  ],
                },
              ],
              activeTray: null,
              errors: [],
              firmwareVersion: null,
              wifiSignalDbm: null,
            },
          }),
        ),
        http.get('*/api/v1/materials', () => HttpResponse.json({ items: [article], page: 1, pageSize: 100, total: 1 })),
        http.post('*/api/v1/filament-spools', async ({ request }) => {
          created = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ ...spool, id: 'spool-9', displayId: 'S-PLA-BLK-01' }, { status: 201 });
        }),
        http.post('*/api/v1/printer-slots/slot-1/mount', async ({ request }) => {
          mounted = await request.json();
          return HttpResponse.json(profile.slots[0]);
        }),
      );
      const user = userEvent.setup();
      renderPage(`/workshop/machines/${bambu.id}/printer`);
      expect(await screen.findByText('Not registered', undefined, { timeout: 5000 })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Register' }));
      const dialog = await screen.findByRole('dialog', { name: /Bambu H2D/ });
      // The article matching type and colour is suggested; half a roll is left.
      await waitFor(() =>
        expect(within(dialog).getByRole('combobox', { name: 'Article' })).toHaveValue(
          'A-0001 · PLA Basic Black · Black',
        ),
      );
      expect(within(dialog).getByLabelText('Net filament on the spool (g)')).toHaveValue('500');
      await user.click(within(dialog).getByRole('button', { name: 'Register and mount' }));
      await waitFor(() => expect(mounted).toEqual({ spoolId: 'spool-9' }));
      expect(created).toMatchObject({
        materialId: 'material-1',
        initialNetWeightG: '500',
        stockMode: 'existing_stock',
        expectedInventoryVersion: 9,
        identifiers: [identifier],
      });
    },
  );

  it('switches automatic recording with the machine version', async () => {
    setup([PermissionId.machinesread, PermissionId.machinesmanage]);
    let body: unknown;
    server.use(
      http.patch(`*/api/v1/machines/${bambu.id}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...bambu, automaticCollectionEnabled: false, externalIdentifier: null });
      }),
    );
    const user = userEvent.setup();
    renderPage(`/workshop/machines/${bambu.id}/printer`);
    await user.click(await screen.findByRole('switch', { name: 'Record runs automatically' }, { timeout: 5000 }));
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Bambu H2D',
        processId: printerTypeId,
        status: 'active',
        externalIdentifier: null,
        automaticCollectionEnabled: false,
        expectedVersion: 7,
      }),
    );
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
    renderPage(`/workshop/machines/${bambu.id}?tab=printer`);
    await user.click(await screen.findByRole('button', { name: 'Mount' }, { timeout: 5000 }));
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
    renderPage(`/workshop/machines/${bambu.id}?tab=printer`);
    expect((await screen.findAllByText('Empty', undefined, { timeout: 5000 })).length).toBeGreaterThan(0);
    expect(await screen.findByRole('link', { name: 'S-0001' }, { timeout: 7000 })).toBeInTheDocument();
    expect((await screen.findAllByText(/PLA Black/, undefined, { timeout: 7000 })).length).toBeGreaterThan(0);
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
    renderPage(`/workshop/machines/${bambu.id}?tab=printer`);
    await screen.findByText('Feed slot', undefined, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Mount' })).not.toBeInTheDocument();
    expect(spoolReads).toBe(0);
  });

  it('offers Unmount for mounted slots to printer_slots.assign and calls the API', async () => {
    const mountedProfile: PrinterProfile = {
      ...profile,
      slots: [{ ...profile.slots[0], assignmentId: 'assignment-1', spoolId: 'spool-1', spoolDisplayId: 'S-0001' }],
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
    renderPage(`/workshop/machines/${bambu.id}?tab=printer`);
    expect(await screen.findByText('S-0001', undefined, { timeout: 5000 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unmount' }));
    await waitFor(() => expect(unmounted).toBe(true));
  });
  it('shows customer filament in a slot and mounts it with printer_slots.assign alone', async () => {
    const mountedProfile: PrinterProfile = {
      ...profile,
      slots: [
        {
          ...profile.slots[0],
          assignmentId: 'assignment-2',
          mountKind: 'customer',
          customerColorName: 'Galaxy black',
        },
      ],
    };
    setup([PermissionId.machinesread, PermissionId.printer_slotsassign], { profileResponse: mountedProfile });
    renderPage(`/workshop/machines/${bambu.id}?tab=printer`);
    expect(await screen.findByText('Customer filament', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Galaxy black')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unmount' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mount customer filament' })).not.toBeInTheDocument();
  });

  it('offers to mount customer filament in an empty slot', async () => {
    setup([PermissionId.machinesread, PermissionId.printer_slotsassign]);
    let body: unknown;
    server.use(
      http.post('*/api/v1/printer-slots/slot-1/mount-customer-filament', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...profile.slots[0], assignmentId: 'assignment-3', mountKind: 'customer' });
      }),
    );
    const user = userEvent.setup();
    renderPage(`/workshop/machines/${bambu.id}?tab=printer`);
    await user.click(await screen.findByRole('button', { name: 'Mount customer filament' }, { timeout: 5000 }));
    await user.type(await screen.findByLabelText('Colour (optional)'), 'Red');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Mount customer filament' }));
    await waitFor(() => expect(body).toEqual({ materialTypeId: null, colorName: 'Red' }));
  });
});

describe('Delete machine', () => {
  const openDelete = async (user: ReturnType<typeof userEvent.setup>) => {
    renderPage(`/workshop/machines/${laser.id}`);
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
    renderPage(`/workshop/machines/${laser.id}`);
    expect(await screen.findByRole('heading', { name: 'Laser cutter' }, { timeout: 5000 })).toBeInTheDocument();
    await user.click(iconButton('More machine actions'));
    await user.click(await screen.findByText('Edit machine'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit machine' });
    await user.click(within(dialog).getByRole('radio', { name: 'Maintenance' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save machine' }));
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Laser cutter',
        processId: laserTypeId,
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
    renderPage(`/workshop/machines/${laser.id}`);
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
    renderPage(`/workshop/machines/${bambu.id}?tab=printer`);
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
    renderPage(`/workshop/machines/${bambu.id}?tab=printer`);
    await user.click(await screen.findByRole('switch', { name: 'Printer profile enabled' }, { timeout: 5000 }));
    expect(input).toBeUndefined();
    expect(
      screen.getByText(/Existing prints and history are kept, and you can enable the profile again/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disable profile' }));
    await waitFor(() => expect(input).toEqual({ enabled: false, expectedVersion: 4 }));
  });
});
