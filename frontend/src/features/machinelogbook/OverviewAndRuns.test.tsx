import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Machine, MachineActivity, MachineLogbookOverview, WorkItem } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { server } from '../../test/server';
import { testQueryClient } from '../../test/render';
import {
  ids,
  jobFixture,
  machine,
  manualRun,
  recordedRun,
  usage,
  workItem as baseWorkItem,
} from '../../test/machineRuns';
import { MachineLogbookOverviewPage } from './OverviewPage';
import { RunDetailPage } from './RunDetailPage';
import { machineLogbookPaths } from './shared/paths';
import { ToastProvider } from './shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[], personId: '0192f6f8-743e-7c77-a349-cd07c3e8ffff' }));
vi.mock('../auth/auth', () => ({
  useCurrentUser: () => ({ permissions: auth.permissions, person: { id: auth.personId } }),
}));
vi.mock('./dialogs/JobFormModal', () => ({
  JobFormModal: (props: { open: boolean; mode: string; run?: { id: string }; initialValues?: unknown }) =>
    props.open ? (
      <div role="dialog" aria-label="Job form stub" data-mode={props.mode} data-run-id={props.run?.id ?? ''} />
    ) : null,
}));

const secondMachineId = '0192f6f8-743e-7c77-a349-cd07c3e8b002';
const retiredMachineId = '0192f6f8-743e-7c77-a349-cd07c3e8b003';

const machineFixture = (overrides: Partial<Machine> = {}): Machine => ({ ...machine, ...overrides });

function workItem(index: number, overrides: Partial<WorkItem> = {}): WorkItem {
  return baseWorkItem({
    id: `0192f6f8-743e-7c77-a349-cd07c3e8c0${String(index).padStart(2, '0')}`,
    displayId: `J-2026-0000${index}`,
    title: `Bracket ${index}`,
    status: 'running',
    startedAt: '2026-09-15T08:00:00Z',
    endsAt: '2099-01-01T10:00:00Z',
    billing: undefined,
    effectivePrice: null,
    ...overrides,
  });
}

function overviewFixture(overrides: Partial<MachineLogbookOverview> = {}): MachineLogbookOverview {
  return {
    jobsToday: 4,
    jobsThisWeek: 9,
    unassignedJobs: 0,
    unassignedEstimatedAmount: '0.00',
    failedOrPartialThisWeek: 0,
    runningNow: 2,
    runningMachineNames: ['Bambu H2D #1', 'Prusa MK4'],
    needsOutcome: 0,
    unassignedRuns: 1,
    billingIssues: 3,
    activeItems: [workItem(1)],
    activeTotal: 1,
    lowStockItems: 0,
    recentJobs: [],
    lowStockMaterials: [],
    activity: [],
    ...overrides,
  };
}

function renderPage(element: React.ReactElement, path: string, route = '*') {
  const queryClient = testQueryClient();
  const router = createMemoryRouter([{ path: route, element: <ToastProvider>{element}</ToastProvider> }], {
    initialEntries: [path],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

function serveOverview(overview: MachineLogbookOverview, activity: MachineActivity[] = []) {
  server.use(
    http.get('*/api/v1/machine-logbook/overview', () => HttpResponse.json(overview)),
    http.get('*/api/v1/machines', () =>
      HttpResponse.json({
        items: [
          machineFixture(),
          machineFixture({ id: secondMachineId, name: 'Prusa MK4' }),
          machineFixture({ id: retiredMachineId, name: 'Old lathe', status: 'retired' }),
        ],
        page: 1,
        pageSize: 100,
        total: 3,
      }),
    ),
    http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: activity })),
  );
}

describe('Overview page', () => {
  it('shows the key figures with counts, machine names and deep links into Jobs', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machinesread];
    serveOverview(overviewFixture({ needsOutcome: 0 }));
    renderPage(<MachineLogbookOverviewPage />, '/');

    expect(await screen.findByText('4 jobs today · 2 running · 1 unassigned')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Key figures' });
    const running = within(section).getByRole('link', { name: /Running now/ });
    expect(running).toHaveTextContent('Bambu H2D #1, Prusa MK4');
    expect(decodeURIComponent(running.getAttribute('href')!)).toBe(
      '/machine-logbook/jobs?status=running,running_unassigned',
    );
    expect(
      decodeURIComponent(
        within(section)
          .getByRole('link', { name: /Needs outcome/ })
          .getAttribute('href')!,
      ),
    ).toBe('/machine-logbook/jobs?status=needs_outcome');
    expect(
      decodeURIComponent(
        within(section)
          .getByRole('link', { name: /Unassigned runs/ })
          .getAttribute('href')!,
      ),
    ).toBe('/machine-logbook/jobs?status=unassigned');
    const billing = within(section).getByRole('link', { name: /Billing issues/ });
    expect(billing).toHaveTextContent('3');
    expect(decodeURIComponent(billing.getAttribute('href')!)).toBe(
      '/machine-logbook/jobs?billing=price_incomplete,order_outdated',
    );
    // Zero counts stay visible in the secondary colour.
    expect(within(section).getByText('0')).toHaveClass('mj-metric__value--zero');
    expect(within(section).getByText('3')).not.toHaveClass('mj-metric__value--zero');
  });

  it('lists the active items and links the rest to Jobs', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    const items = [1, 2, 3, 4, 5, 6].map((index) =>
      workItem(
        index,
        index === 6
          ? {
              kind: 'run',
              status: 'unassigned',
              title: null,
              fileName: 'bracket_6.gcode',
              source: 'recorded',
              endsAt: '2026-09-15T09:00:00Z',
              customer: undefined,
            }
          : {},
      ),
    );
    serveOverview(overviewFixture({ activeItems: items, activeTotal: 9 }));
    const user = userEvent.setup();
    const { router } = renderPage(<MachineLogbookOverviewPage />, '/');

    const list = (await screen.findByText('Bracket 1')).closest('.cds--contained-list') as HTMLElement;
    expect(within(list).getAllByText('Bambu H2D #1 · ends ~11:00')).toHaveLength(5);
    expect(within(list).getByText('bracket_6.gcode')).toBeInTheDocument();
    expect(within(list).getByText('Unassigned run')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: /3 more active items/ }));
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toContain('/machine-logbook/jobs?status='),
    );
    expect(decodeURIComponent(router.state.location.search)).toBe(
      '?status=running,running_unassigned,unassigned,needs_outcome',
    );
  });

  it('opens an unassigned run from the active list', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveOverview(
      overviewFixture({
        activeItems: [
          workItem(1, {
            kind: 'run',
            id: ids.recordedRun,
            status: 'unassigned',
            title: null,
            fileName: 'bracket.gcode',
            source: 'recorded',
          }),
        ],
        activeTotal: 1,
      }),
    );
    const user = userEvent.setup();
    const { router } = renderPage(<MachineLogbookOverviewPage />, '/');
    await user.click(await screen.findByRole('button', { name: /bracket\.gcode/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(machineLogbookPaths.run(ids.recordedRun)));
  });

  it('lists one line per non-retired machine with its current item, connector issue and availability', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machinesread];
    serveOverview(overviewFixture(), [
      {
        machineId: ids.machine,
        availability: 'in_use',
        current: {
          kind: 'run',
          id: ids.recordedRun,
          displayId: 'RN-1',
          fileName: 'gearbox_housing_v3.gcode',
          startedAt: '2026-09-15T08:00:00Z',
          endsAt: '2099-01-01T13:30:00Z',
        },
        connector: { runtimeState: 'degraded', runtimeErrorCode: 'E42' },
      },
      { machineId: secondMachineId, availability: 'available', lastJobStartedAt: '2020-01-01T10:00:00Z' },
    ]);
    renderPage(<MachineLogbookOverviewPage />, '/');

    const heading = await screen.findByText('Machines');
    const list = heading.closest('.cds--contained-list') as HTMLElement;
    expect(await within(list).findByText(/Gearbox housing v3 · ends ~/)).toBeInTheDocument();
    expect(within(list).getByText('Connector issue')).toBeInTheDocument();
    expect(within(list).getByText('In use')).toBeInTheDocument();
    expect(within(list).getByText('Available')).toBeInTheDocument();
    expect(within(list).getByText(/Last job/)).toBeInTheDocument();
    expect(within(list).queryByText('Old lathe')).not.toBeInTheDocument();
  });

  it('hides sections the user has no permission for', async () => {
    // Machines only: the job figures come back as null, so there are no key figures and no active list.
    auth.permissions = [PermissionId.machinesread];
    serveOverview(
      overviewFixture({
        runningNow: null,
        runningMachineNames: null,
        needsOutcome: null,
        unassignedRuns: null,
        billingIssues: null,
        activeItems: null,
        activeTotal: null,
      }),
    );
    const first = renderPage(<MachineLogbookOverviewPage />, '/');
    expect(await screen.findByText('4 jobs today')).toBeInTheDocument();
    expect(await screen.findByText('Machines')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Key figures' })).not.toBeInTheDocument();
    expect(screen.queryByText('Active jobs')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New job' })).not.toBeInTheDocument();
    first.router.dispose();
  });

  it('hides the machine list without machines.read and does not request it', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobscreate];
    const machineRequests = vi.fn();
    serveOverview(overviewFixture());
    server.use(
      http.get('*/api/v1/machines', () => {
        machineRequests();
        return HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 });
      }),
      http.get('*/api/v1/machine-logbook/machine-activity', () => {
        machineRequests();
        return HttpResponse.json({ items: [] });
      }),
    );
    const user = userEvent.setup();
    renderPage(<MachineLogbookOverviewPage />, '/');
    expect(await screen.findByText('Active jobs')).toBeInTheDocument();
    expect(screen.queryByText('Machines')).not.toBeInTheDocument();
    expect(machineRequests).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'New job' }));
    expect(screen.getByRole('dialog', { name: 'Job form stub' })).toHaveAttribute('data-mode', 'create');
  });
});

/** Requests of the attach dialog to the work-items endpoint, so tests can check the server-side filters. */
const workItemRequests: URL[] = [];

function serveRun(run: ReturnType<typeof recordedRun>, jobs: ReturnType<typeof jobFixture>[] = []) {
  workItemRequests.length = 0;
  server.use(
    http.get(`*/api/v1/machine-runs/${run.id}`, () => HttpResponse.json(run)),
    // The server applies machineId; the fixture mimics that and returns the jobs newest first.
    http.get('*/api/v1/machine-logbook/work-items', ({ request }) => {
      const url = new URL(request.url);
      workItemRequests.push(url);
      const machines = url.searchParams.getAll('machineId');
      const items = jobs
        .filter((job) => machines.length === 0 || machines.includes(job.machine.id))
        .map((job) =>
          baseWorkItem({
            id: job.id,
            displayId: job.displayId,
            title: job.title,
            startedAt: job.startedAt!,
            runCount: job.runs.length,
            status: job.status,
          }),
        );
      return HttpResponse.json({ items, page: 1, pageSize: 50, total: items.length });
    }),
    ...jobs.map((job) => http.get(`*/api/v1/machine-jobs/${job.id}`, () => HttpResponse.json(job))),
  );
}

const renderRun = (id = ids.recordedRun) =>
  renderPage(<RunDetailPage />, machineLogbookPaths.run(id), '/machine-logbook/jobs/runs/:runId');
const runningRecorded = () =>
  recordedRun({
    state: 'running',
    endedAt: null,
    estimatedEndAt: '2099-01-01T13:30:00Z',
    progressPercent: 45,
    outcome: null,
    outcomeFromMachine: false,
    durationSeconds: 1800,
    reportedUsage: null,
    reportedUsageItems: [],
  });

describe('Run detail page', () => {
  it('shows the machine data, facts, "From machine" labels and a collapsed list of readable events', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveRun(recordedRun());
    renderRun();
    expect(await screen.findByRole('heading', { name: /Gearbox housing v3/ })).toBeInTheDocument();
    expect(screen.getByText('RN-2026-000007 · Bambu H2D #1 · via Bambu LAN')).toBeInTheDocument();
    expect(screen.getByText('Reported material').nextSibling).toHaveTextContent('42 g PLA Black');
    expect(screen.getByText('Runtime').nextSibling).toHaveTextContent('1 h 0 min');
    // The machine reported the outcome, so the label says so.
    expect(screen.getByText('Outcome').nextSibling).toHaveTextContent('SuccessfulFrom machine');
    expect(screen.getByText('Events from Bambu LAN (2)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create job' })).not.toBeInTheDocument();
    expect(screen.queryByText(/printer/i)).not.toBeInTheDocument();
  });

  it('offers Create job and Attach to job only with their permissions', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobscreate];
    serveRun(recordedRun());
    const first = renderRun();
    expect(await screen.findByRole('button', { name: 'Create job' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach to job' })).not.toBeInTheDocument();
    first.router.dispose();
  });

  it('offers Attach to job but not Create job with edit permission only', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    serveRun(recordedRun());
    renderRun();
    expect(await screen.findByRole('button', { name: 'Attach to job' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create job' })).not.toBeInTheDocument();
  });

  it('offers create and attach while the run is still running', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobscreate, PermissionId.machine_jobsedit];
    serveRun(runningRecorded());
    renderRun();
    expect(await screen.findByText('Run in progress')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
    expect(screen.getByText(/45 % · ends ~/)).toBeInTheDocument();
    expect(screen.getByText('Outcome').nextSibling).toHaveTextContent('Not recorded yet');
    expect(screen.getByText('Consumed material').nextSibling).toHaveTextContent('Pending final report');
    expect(screen.getByText('Reported material').nextSibling).toHaveTextContent('Pending final report');
    expect(screen.getByText(/Mounted spools describe the printer setup/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create job' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach to job' })).toBeInTheDocument();
  });

  describe('signage visibility', () => {
    const jobRef = { id: ids.job, displayId: 'J-2026-000001', title: 'Gearbox housing' };
    const hide = () => screen.findByRole('checkbox', { name: 'Hide this run from signage screens' });

    it('lets staff who edit jobs hide a running run, sending the choice to the API', async () => {
      auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
      const run = runningRecorded();
      serveRun(run);
      const bodies: unknown[] = [];
      server.use(
        http.put(`*/api/v1/machine-runs/${run.id}/signage-visibility`, async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({ ...run, hiddenFromSignage: true });
        }),
      );
      renderRun();
      const checkbox = await hide();
      expect(checkbox).not.toBeChecked();
      expect(
        screen.getByText('Machine status and camera are hidden from all displays until this run ends.'),
      ).toBeInTheDocument();
      await userEvent.click(checkbox);
      await waitFor(() => expect(bodies).toEqual([{ hidden: true }]));
      expect(await screen.findByText('Run hidden from signage')).toBeInTheDocument();
    });

    it('shows an error when the run ended meanwhile', async () => {
      auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
      const run = runningRecorded();
      serveRun(run);
      server.use(
        http.put(`*/api/v1/machine-runs/${run.id}/signage-visibility`, () =>
          HttpResponse.json({ code: 'run_ended', message: 'The run has ended.' }, { status: 409 }),
        ),
      );
      renderRun();
      await userEvent.click(await hide());
      expect(await screen.findByText('The run has already ended.')).toBeInTheDocument();
    });

    it("lets the job's operator hide it without edit permission", async () => {
      auth.permissions = [PermissionId.machine_jobsread];
      auth.personId = ids.operator;
      serveRun({ ...runningRecorded(), hiddenFromSignage: true, job: jobRef }, [jobFixture()]);
      renderRun();
      expect(await hide()).toBeChecked();
      auth.personId = '0192f6f8-743e-7c77-a349-cd07c3e8ffff';
    });

    it('offers nothing to people who are neither editors nor part of the job', async () => {
      auth.permissions = [PermissionId.machine_jobsread];
      serveRun({ ...runningRecorded(), job: jobRef }, [jobFixture()]);
      renderRun();
      expect(await screen.findByText('Machine events')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Hide this run from signage screens' })).not.toBeInTheDocument();
    });

    it('is not offered once the run has ended', async () => {
      auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
      serveRun(recordedRun());
      renderRun();
      expect(await screen.findByText('Machine events')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Hide this run from signage screens' })).not.toBeInTheDocument();
    });
  });

  it('treats an omitted itemized report from an older response as empty', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveRun({ ...runningRecorded(), reportedUsageItems: undefined } as unknown as ReturnType<typeof recordedRun>);
    renderRun();
    expect(await screen.findByText('Run in progress')).toBeInTheDocument();
    expect(screen.getByText('Reported material').nextSibling).toHaveTextContent('Pending final report');
  });

  it('shows a display-only live filament estimate from the parsed artifact', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.print_artifactsread];
    const artifactId = '0192f6f8-743e-7c77-a349-cd07c3e8d001';
    serveRun({ ...runningRecorded(), artifact: { id: artifactId, sha256: 'a'.repeat(64), parserStatus: 'complete' } });
    server.use(
      http.get(`*/api/v1/print-artifacts/${artifactId}`, () =>
        HttpResponse.json({
          id: artifactId,
          originalFilename: 'part.3mf',
          sizeBytes: 1024,
          sha256: 'a'.repeat(64),
          parserStatus: 'complete',
          parserVersion: 'bambu-3mf-v1',
          metadata: {},
          primaryPreviewId: null,
          filaments: [
            { filamentKey: '1', filamentType: 'PLA', color: '#ffffff', plannedWeightGrams: '120' },
            { filamentKey: '2', filamentType: 'PETG', color: '#000000', plannedWeightGrams: '80' },
          ],
          createdAt: '2026-09-15T08:00:00Z',
          updatedAt: '2026-09-15T08:00:00Z',
        }),
      ),
    );
    renderRun();

    expect(await screen.findByRole('heading', { name: 'Filament estimate' })).toBeInTheDocument();
    expect(await screen.findByText('~90 g / 200 g planned · based on 45 % print progress')).toBeInTheDocument();
    expect(screen.getByText('PLA · #ffffff (detected in file): 120 g planned')).toBeInTheDocument();
    expect(screen.getByText(/Inventory is updated only after the run ends/)).toBeInTheDocument();
  });

  it('maps an unresolved reported filament to a selected spool as an audited usage correction', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit, PermissionId.inventoryread];
    const whiteSpool = '0192f6f8-743e-7c77-a349-cd07c3e8d610';
    const yellowMaterial = '0192f6f8-743e-7c77-a349-cd07c3e8d611';
    const yellowSpool = '0192f6f8-743e-7c77-a349-cd07c3e8d612';
    const run = recordedRun({
      usages: [usage({ spoolId: whiteSpool, spoolDisplayId: 'S-617', materialName: 'PLA White', quantity: '1.64' })],
      usagesFromMachine: true,
      hiddenFromSignage: false,
      reportedUsage: null,
      reportedUsageItems: [
        {
          lineNumber: 0,
          reportRevision: 1,
          slicerFilamentId: '1',
          extruder: 2,
          plannedQuantityGrams: '0.55',
          estimatedQuantityGrams: '0.55',
          method: 'slicer_complete',
          calculationVersion: 'bambu-3mf-v1',
          quality: 'high',
        },
        {
          lineNumber: 1,
          reportRevision: 1,
          slicerFilamentId: '3',
          extruder: 1,
          inputUnitExternalId: '128',
          slotExternalId: '0',
          plannedQuantityGrams: '1.64',
          estimatedQuantityGrams: '1.64',
          spoolId: whiteSpool,
          method: 'slicer_complete',
          calculationVersion: 'bambu-3mf-v1',
          quality: 'high',
        },
      ],
      version: 7,
    });
    serveRun(run);
    server.use(
      http.get('*/api/v1/filament-spools', () =>
        HttpResponse.json({
          items: [
            {
              id: yellowSpool,
              displayId: 'S-618',
              kind: 'standard',
              label: 'External holder',
              status: 'in_stock',
              fillNumber: 1,
              materialId: yellowMaterial,
              materialName: 'PLA Yellow',
              remainingQuantity: '500',
              unit: 'g',
              mounted: true,
              lifecycle: 'active',
              identifiers: [],
              version: 1,
              createdAt: '2026-09-01T00:00:00Z',
              updatedAt: '2026-09-01T00:00:00Z',
            },
          ],
          page: 1,
          pageSize: 100,
          total: 1,
        }),
      ),
    );
    let body: unknown;
    server.use(
      http.put(`*/api/v1/machine-runs/${ids.recordedRun}/usages`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ run, job: null });
      }),
    );

    const user = userEvent.setup();
    renderRun();
    await user.click(await screen.findByRole('button', { name: 'Map filament 1 to a spool' }));
    const dialog = await screen.findByRole('dialog', { name: 'Map reported material' });
    expect(within(dialog).getByLabelText('Consumed quantity (g)')).toHaveValue('0.55');
    await user.selectOptions(within(dialog).getByLabelText('Spool used'), yellowSpool);
    await user.click(within(dialog).getByRole('button', { name: 'Map and consume' }));

    await waitFor(() =>
      expect(body).toEqual({
        expectedVersion: 7,
        usages: [
          {
            ownership: 'makerspace',
            materialId: ids.material,
            spoolId: whiteSpool,
            externalMaterialName: null,
            quantity: '1.64',
            quantityBasis: 'actual',
          },
          {
            ownership: 'makerspace',
            materialId: yellowMaterial,
            spoolId: yellowSpool,
            externalMaterialName: null,
            quantity: '0.55',
            quantityBasis: 'estimated',
          },
        ],
      }),
    );
  });

  it('creates a job from the run and passes the run to the form', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobscreate];
    serveRun(recordedRun({ state: 'failed', outcome: 'failed' }));
    const user = userEvent.setup();
    renderRun();
    await user.click(await screen.findByRole('button', { name: 'Create job' }));
    expect(screen.getByRole('dialog', { name: 'Job form stub' })).toHaveAttribute('data-run-id', ids.recordedRun);
  });

  it('attaches a recorded run to a job on its machine and replaces the manual runs', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const manual = jobFixture({
      runs: [manualRun({ startedAt: '2026-09-15T07:30:00Z', endedAt: '2026-09-15T09:00:00Z', durationSeconds: 5400 })],
    });
    serveRun(recordedRun(), [manual]);
    let body: unknown;
    server.use(
      http.put(`*/api/v1/machine-runs/${ids.recordedRun}/job`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(manual);
      }),
    );
    const user = userEvent.setup();
    renderRun();

    await user.click(await screen.findByRole('button', { name: 'Attach to job' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Attach run' })).toBeDisabled();
    await user.click(within(dialog).getByRole('combobox', { name: /Job/ }));
    // Candidates come from the server: the jobs of this machine, newest first.
    await waitFor(() => expect(workItemRequests.length).toBeGreaterThan(0));
    const request = workItemRequests[0].searchParams;
    expect(request.getAll('machineId')).toEqual([ids.machine]);
    expect(request.get('sort')).toBe('startedAt');
    expect(request.get('direction')).toBe('desc');
    await user.click(await screen.findByText(/J-2026-000001 Gearbox housing/));
    expect(await within(dialog).findByText('Manual run')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Replace manual runs' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Attach and replace' }));

    await waitFor(() =>
      expect(body).toEqual({ machineJobId: ids.job, replaceManualRuns: true, expectedJobVersion: 3 }),
    );
    expect(await screen.findByText('J-2026-000001 now uses the data from RN-2026-000007.')).toBeInTheDocument();
  });

  it('attaches a running recorded run next to the manual runs when replacing is switched off', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const manual = jobFixture();
    serveRun(runningRecorded(), [manual]);
    let body: unknown;
    server.use(
      http.put(`*/api/v1/machine-runs/${ids.recordedRun}/job`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(manual);
      }),
    );
    const user = userEvent.setup();
    renderRun();

    await user.click(await screen.findByRole('button', { name: 'Attach to job' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/the job keeps running until the run ends/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: /Job/ }));
    await user.click(await screen.findByText(/J-2026-000001 Gearbox housing/));
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Replace manual runs' }));
    expect(within(dialog).getByText('Added next to the manual runs')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Attach run' }));

    await waitFor(() =>
      expect(body).toEqual({ machineJobId: ids.job, replaceManualRuns: false, expectedJobVersion: 3 }),
    );
    expect(await screen.findByText('RN-2026-000007 is part of J-2026-000001.')).toBeInTheDocument();
  });

  it('detaches the last run of a job with the job version and explains the manual copy', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const assigned = recordedRun({
      job: { id: ids.job, displayId: 'J-2026-000001', title: 'Gearbox housing' },
      usages: [usage()],
      usagesFromMachine: true,
      hiddenFromSignage: false,
    });
    serveRun(assigned);
    server.use(
      http.get(`*/api/v1/machine-jobs/${ids.job}`, () =>
        HttpResponse.json(jobFixture({ runs: [assigned], version: 8 })),
      ),
    );
    let body: unknown;
    server.use(
      http.delete(`*/api/v1/machine-runs/${ids.recordedRun}/job`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(jobFixture({ version: 9 }));
      }),
    );
    const user = userEvent.setup();
    renderRun();

    expect(await screen.findByRole('link', { name: /J-2026-000001 Gearbox housing/ })).toHaveAttribute(
      'href',
      machineLogbookPaths.job(ids.job),
    );
    expect(screen.queryByRole('button', { name: 'Create job' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach to job' })).not.toBeInTheDocument();
    // Carbon's icon-only overflow trigger is named by an aria-hidden tooltip that jsdom does not resolve, so find it by class.
    await waitFor(() => expect(document.querySelector('.cds--overflow-menu')).not.toBeNull());
    await user.click(document.querySelector('.cds--overflow-menu')!);
    await user.click(await screen.findByText('Detach from job'));
    const dialog = await screen.findByRole('alertdialog', { name: /Detach this run/ });
    expect(within(dialog).getByText(/gets a manual run with the same start, end and outcome/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Detach' }));

    await waitFor(() => expect(body).toEqual({ expectedJobVersion: 8 }));
    expect(await screen.findByText('Run detached')).toBeInTheDocument();
  });

  it('does not offer detach without job edit permission', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveRun(recordedRun({ job: { id: ids.job, displayId: 'J-2026-000001', title: null } }));
    server.use(http.get(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json(jobFixture())));
    renderRun();
    expect(await screen.findByRole('link', { name: 'J-2026-000001' })).toBeInTheDocument();
    expect(document.querySelector('.cds--overflow-menu')).toBeNull();
  });

  it('deletes a recorded run with machine_jobs.delete, asks about consumption and returns to the job', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsdelete];
    const assigned = recordedRun({
      job: { id: ids.job, displayId: 'J-2026-000001', title: 'Gearbox housing' },
      usages: [usage({ spoolDisplayId: 'SP-0003' })],
      usagesFromMachine: true,
      hiddenFromSignage: false,
      version: 5,
    });
    serveRun(assigned);
    server.use(
      http.get(`*/api/v1/machine-jobs/${ids.job}`, () =>
        HttpResponse.json(jobFixture({ runs: [manualRun(), assigned] })),
      ),
    );
    let body: unknown;
    server.use(
      http.delete(`*/api/v1/machine-runs/${ids.recordedRun}`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRun();
    await screen.findByRole('link', { name: /J-2026-000001 Gearbox housing/ });
    await waitFor(() => expect(document.querySelector('.cds--overflow-menu')).not.toBeNull());
    await user.click(document.querySelector('.cds--overflow-menu')!);
    await user.click(await screen.findByText('Delete run'));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete run' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: /Reverse consumption \(183 g back to SP-0003\)/ }));
    await user.click(confirm);
    await waitFor(() => expect(body).toEqual({ expectedVersion: 5, reverseConsumption: true }));
  });

  it('hides Delete run for a recorded run without machine_jobs.delete', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    serveRun(recordedRun());
    renderRun();
    await screen.findByRole('heading', { name: /Gearbox housing v3/ });
    expect(document.querySelector('.cds--overflow-menu')).toBeNull();
  });

  it('offers Delete run for a manual run with edit access', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    serveRun(
      recordedRun({
        id: ids.manualRun,
        source: 'manual',
        job: { id: ids.job, displayId: 'J-2026-000001', title: null },
      }),
    );
    server.use(http.get(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json(jobFixture())));
    const user = userEvent.setup();
    renderRun(ids.manualRun);
    await waitFor(() => expect(document.querySelector('.cds--overflow-menu')).not.toBeNull());
    await user.click(document.querySelector('.cds--overflow-menu')!);
    expect(await screen.findByText('Delete run')).toBeInTheDocument();
    expect(screen.queryByText('Detach from job')).not.toBeInTheDocument();
  });
});
