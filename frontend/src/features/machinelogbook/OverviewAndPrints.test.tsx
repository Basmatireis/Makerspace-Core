import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Machine, MachineActivity, MachineJob, MachineLogbookOverview, PrintDetail, WorkItem } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { server } from '../../test/server';
import { testQueryClient } from '../../test/render';
import { MachineLogbookOverviewPage } from './OverviewPage';
import { PrintDetailPage } from './PrintDetailPage';
import { machineLogbookPaths } from './shared/paths';
import { ToastProvider } from './shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));
vi.mock('./dialogs/JobFormModal', () => ({
  JobFormModal: (props: { open: boolean; mode: string; printId?: string; initialValues?: unknown }) => props.open
    ? <div role="dialog" aria-label="Job form stub" data-mode={props.mode} data-print-id={props.printId ?? ''} data-initial={JSON.stringify(props.initialValues ?? null)} />
    : null,
}));

const ids = {
  machine: '0192f6f8-743e-7c77-a349-cd07c3e8b001',
  secondMachine: '0192f6f8-743e-7c77-a349-cd07c3e8b002',
  retiredMachine: '0192f6f8-743e-7c77-a349-cd07c3e8b003',
  type: '0192f6f8-743e-7c77-a349-cd07c3e8b010',
  print: '0192f6f8-743e-7c77-a349-cd07c3e8b020',
  job: '0192f6f8-743e-7c77-a349-cd07c3e8b030',
  otherJob: '0192f6f8-743e-7c77-a349-cd07c3e8b031',
  material: '0192f6f8-743e-7c77-a349-cd07c3e8b040',
};

function machineFixture(overrides: Partial<Machine> = {}): Machine {
  return {
    id: ids.machine,
    machineType: { id: ids.type, name: '3D printer', active: true, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
    name: 'Bambu H2D #1', status: 'active', externalIdentifier: null, automaticCollectionEnabled: true, lastIngestedAt: null,
    jobCount: 3, runtimeSeconds: 3600, failureRate: '0', version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function jobFixture(overrides: Partial<MachineJob> = {}): MachineJob {
  return {
    id: ids.job, displayId: 'J-2026-000010', title: 'Gearbox housing', machine: machineFixture(),
    startsAt: '2026-09-15T08:00:00Z', endsAt: '2026-09-15T09:00:00Z', durationSeconds: 3600,
    run: 'manual', print: null, customer: { id: ids.job, kind: 'person', displayName: 'Lena Maier' } as MachineJob['customer'], operator: null,
    outcome: 'successful', status: 'successful', notes: null, usages: [], pricingStatus: 'pending', pricingSnapshot: null, calculatedPrice: null, effectivePrice: null,
    version: 5, createdAt: '2026-09-15T08:00:00Z', updatedAt: '2026-09-15T08:00:00Z',
    ...overrides,
  };
}

function workItem(index: number, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    kind: 'job', id: `0192f6f8-743e-7c77-a349-cd07c3e8c0${String(index).padStart(2, '0')}`, displayId: `J-2026-0000${index}`, title: `Bracket ${index}`,
    machineId: ids.machine, machineName: 'Bambu H2D #1', status: 'running', run: 'manual', startedAt: '2026-09-15T08:00:00Z', endsAt: '2099-01-01T10:00:00Z',
    ...overrides,
  };
}

function overviewFixture(overrides: Partial<MachineLogbookOverview> = {}): MachineLogbookOverview {
  return {
    jobsToday: 4, jobsThisWeek: 9, unassignedJobs: 0, unassignedEstimatedAmount: '0.00', failedOrPartialThisWeek: 0,
    runningNow: 2, runningMachineNames: ['Bambu H2D #1', 'Prusa MK4'], needsOutcome: 0, unlinkedPrints: 1, billingIssues: 3,
    activeItems: [workItem(1)], activeTotal: 1,
    lowStockItems: 0, recentJobs: [], lowStockMaterials: [], activity: [],
    ...overrides,
  };
}

function renderPage(element: React.ReactElement, path: string, route = '*') {
  const queryClient = testQueryClient();
  const router = createMemoryRouter([{ path: route, element: <ToastProvider>{element}</ToastProvider> }], { initialEntries: [path] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { router };
}

function serveOverview(overview: MachineLogbookOverview, activity: MachineActivity[] = []) {
  server.use(
    http.get('*/api/v1/machine-logbook/overview', () => HttpResponse.json(overview)),
    http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machineFixture(), machineFixture({ id: ids.secondMachine, name: 'Prusa MK4' }), machineFixture({ id: ids.retiredMachine, name: 'Old lathe', status: 'retired' })], page: 1, pageSize: 100, total: 3 })),
    http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: activity })),
  );
}

describe('Overview page', () => {
  it('shows the key figures with counts, machine names and deep links into Jobs', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machinesread];
    serveOverview(overviewFixture({ needsOutcome: 0 }));
    renderPage(<MachineLogbookOverviewPage />, '/');

    expect(await screen.findByText('4 jobs today · 2 running · 1 unlinked')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Key figures' });
    const running = within(section).getByRole('link', { name: /Running now/ });
    expect(running).toHaveTextContent('Bambu H2D #1, Prusa MK4');
    expect(decodeURIComponent(running.getAttribute('href')!)).toBe('/machine-logbook/jobs?status=running,printing');
    expect(decodeURIComponent(within(section).getByRole('link', { name: /Needs outcome/ }).getAttribute('href')!)).toBe('/machine-logbook/jobs?status=needs_outcome');
    expect(decodeURIComponent(within(section).getByRole('link', { name: /Unlinked prints/ }).getAttribute('href')!)).toBe('/machine-logbook/jobs?status=unlinked');
    const billing = within(section).getByRole('link', { name: /Billing issues/ });
    expect(billing).toHaveTextContent('3');
    expect(decodeURIComponent(billing.getAttribute('href')!)).toBe('/machine-logbook/jobs?billing=price_incomplete,order_outdated');
    // Zero counts stay visible in the secondary colour.
    expect(within(section).getByText('0')).toHaveClass('mj-metric__value--zero');
    expect(within(section).getByText('3')).not.toHaveClass('mj-metric__value--zero');
  });

  it('lists the active items and links the rest to Jobs', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    const items = [1, 2, 3, 4, 5, 6].map((index) => workItem(index, index === 6 ? { kind: 'print', status: 'unlinked', title: null, fileName: 'bracket_6.gcode', endsAt: '2026-09-15T09:00:00Z', customer: null } : {}));
    serveOverview(overviewFixture({ activeItems: items, activeTotal: 9 }));
    const user = userEvent.setup();
    const { router } = renderPage(<MachineLogbookOverviewPage />, '/');

    const list = (await screen.findByText('Bracket 1')).closest('.cds--contained-list') as HTMLElement;
    expect(within(list).getAllByText('Bambu H2D #1 · ends ~11:00')).toHaveLength(5);
    expect(within(list).getByText('bracket_6.gcode')).toBeInTheDocument();
    expect(within(list).getByText('Unlinked print')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: /3 more active items/ }));
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toContain('/machine-logbook/jobs?status='));
    expect(decodeURIComponent(router.state.location.search)).toBe('?status=running,printing,unlinked,needs_outcome');
  });

  it('opens a print from the active list', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    serveOverview(overviewFixture({ activeItems: [workItem(1, { kind: 'print', id: ids.print, status: 'unlinked', title: null, fileName: 'bracket.gcode' })], activeTotal: 1 }));
    const user = userEvent.setup();
    const { router } = renderPage(<MachineLogbookOverviewPage />, '/');
    await user.click(await screen.findByRole('button', { name: /bracket\.gcode/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(machineLogbookPaths.print(ids.print)));
  });

  it('lists one line per non-retired machine with its current item, connector issue and availability', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machinesread];
    serveOverview(overviewFixture(), [
      { machineId: ids.machine, availability: 'in_use', current: { kind: 'print', id: ids.print, displayId: 'PR-1', fileName: 'gearbox_housing_v3.gcode', startedAt: '2026-09-15T08:00:00Z', endsAt: '2099-01-01T13:30:00Z' }, connector: { runtimeState: 'degraded', runtimeErrorCode: 'E42' } },
      { machineId: ids.secondMachine, availability: 'available', lastJobStartedAt: '2020-01-01T10:00:00Z' },
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
    serveOverview(overviewFixture({ runningNow: null, runningMachineNames: null, needsOutcome: null, unlinkedPrints: null, billingIssues: null, activeItems: null, activeTotal: null }));
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
      http.get('*/api/v1/machines', () => { machineRequests(); return HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 }); }),
      http.get('*/api/v1/machine-logbook/machine-activity', () => { machineRequests(); return HttpResponse.json({ items: [] }); }),
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

const printFixture = (overrides: Partial<PrintDetail> = {}): PrintDetail => ({
  id: ids.print, displayId: 'PR-2026-000007', machineId: ids.machine, machineName: 'Bambu H2D #1', connectorName: 'Bambu LAN', fileName: 'gearbox_housing_v3.gcode',
  state: 'finished', startedAt: '2026-09-15T08:00:00Z', endedAt: '2026-09-15T09:00:00Z', estimatedEndAt: null, progressPercent: 100,
  reportedUsage: { quantity: '42.000', quantityBasis: 'actual', materialId: ids.material, materialName: 'PLA Black', spoolId: null, spoolDisplayId: null },
  job: null, version: 1,
  events: [
    { id: ids.job, kind: 'operational_state', occurredAt: '2026-09-15T08:00:00Z', state: 'printing' },
    { id: ids.otherJob, kind: 'terminal_outcome', occurredAt: '2026-09-15T09:00:00Z', state: 'finished' },
  ],
  ...overrides,
});

/** Requests of the link dialog to the work-items endpoint, so tests can check the server-side filters. */
const workItemRequests: URL[] = [];

function servePrint(print: PrintDetail, jobs: MachineJob[] = []) {
  workItemRequests.length = 0;
  server.use(
    http.get(`*/api/v1/prints/${ids.print}`, () => HttpResponse.json(print)),
    // The server applies machineId and run; the fixture mimics that and returns the jobs newest first.
    http.get('*/api/v1/machine-logbook/work-items', ({ request }) => {
      const url = new URL(request.url);
      workItemRequests.push(url);
      const runs = url.searchParams.getAll('run');
      const machines = url.searchParams.getAll('machineId');
      const items = jobs
        .filter((job) => (runs.length === 0 || runs.includes(job.run === 'manual' ? 'manual' : 'printer')) && (machines.length === 0 || machines.includes(job.machine.id)))
        .map((job) => workItem(1, { id: job.id, displayId: job.displayId, title: job.title, startedAt: job.startsAt, run: job.run === 'manual' ? 'manual' : 'printer', machineId: job.machine.id, status: job.status }));
      return HttpResponse.json({ items, page: 1, pageSize: 50, total: items.length });
    }),
    ...jobs.map((job) => http.get(`*/api/v1/machine-jobs/${job.id}`, () => HttpResponse.json(job))),
  );
}

const renderPrint = () => renderPage(<PrintDetailPage />, machineLogbookPaths.print(ids.print), '/machine-logbook/jobs/prints/:printId');

describe('Print detail page', () => {
  it('shows the printer data, facts and a collapsed list of readable events', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    servePrint(printFixture());
    renderPrint();
    expect(await screen.findByRole('heading', { name: /gearbox_housing_v3\.gcode/ })).toBeInTheDocument();
    expect(screen.getByText('PR-2026-000007 · Bambu H2D #1 · via Bambu LAN')).toBeInTheDocument();
    expect(screen.getByText('Reported material').nextSibling).toHaveTextContent('42 g PLA Black');
    expect(screen.getByText('Runtime').nextSibling).toHaveTextContent('1 h 0 min');
    expect(screen.getByText('Events from Bambu LAN (2)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create job' })).not.toBeInTheDocument();
  });

  it('offers Create job and Link to job only with their permissions', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobscreate];
    servePrint(printFixture());
    const first = renderPrint();
    expect(await screen.findByRole('button', { name: 'Create job' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link to job' })).not.toBeInTheDocument();
    first.router.dispose();
  });

  it('offers Link to job but not Create job with edit permission only', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    servePrint(printFixture());
    renderPrint();
    expect(await screen.findByRole('button', { name: 'Link to job' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create job' })).not.toBeInTheDocument();
  });

  it('does not offer create or link while the printer is still printing', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobscreate, PermissionId.machine_jobsedit];
    servePrint(printFixture({ state: 'printing', endedAt: null, estimatedEndAt: '2099-01-01T13:30:00Z', progressPercent: 45 }));
    renderPrint();
    expect(await screen.findByText('Print in progress')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
    expect(screen.getByText(/45 % · ends ~/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create job' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link to job' })).not.toBeInTheDocument();
  });

  it('creates a job prefilled from the print and passes the print id', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobscreate];
    servePrint(printFixture({ state: 'failed' }));
    const user = userEvent.setup();
    renderPrint();
    await user.click(await screen.findByRole('button', { name: 'Create job' }));
    const dialog = screen.getByRole('dialog', { name: 'Job form stub' });
    expect(dialog).toHaveAttribute('data-print-id', ids.print);
    const initial = JSON.parse(dialog.getAttribute('data-initial')!) as Record<string, unknown>;
    expect(initial).toMatchObject({ title: 'Gearbox housing v3', machineId: ids.machine, startsAt: '2026-09-15T08:00:00Z', outcome: 'failed' });
    expect(JSON.stringify(initial.usages)).toContain(ids.material);
  });

  it('links the print to a manual job on the same machine with the loaded job version', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    const manual = jobFixture({ startsAt: '2026-09-15T07:30:00Z', durationSeconds: 5400 });
    const alreadyLinked = jobFixture({ id: ids.otherJob, displayId: 'J-2026-000011', title: 'Linked elsewhere', run: 'automatic', print: { id: ids.otherJob, displayId: 'PR-9', state: 'finished' } });
    servePrint(printFixture(), [manual, alreadyLinked]);
    let body: unknown;
    server.use(http.put(`*/api/v1/prints/${ids.print}/job`, async ({ request }) => { body = await request.json(); return HttpResponse.json(manual); }));
    const user = userEvent.setup();
    renderPrint();

    await user.click(await screen.findByRole('button', { name: 'Link to job' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Link print' })).toBeDisabled();
    await user.click(within(dialog).getByRole('combobox', { name: /Job/ }));
    expect(screen.queryByText(/Linked elsewhere/)).not.toBeInTheDocument();
    // Candidates come from the server: this machine's manual runs, newest first.
    await waitFor(() => expect(workItemRequests.length).toBeGreaterThan(0));
    const request = workItemRequests[0].searchParams;
    expect(request.getAll('machineId')).toEqual([ids.machine]);
    expect(request.getAll('run')).toEqual(['manual']);
    expect(request.get('sort')).toBe('startedAt');
    expect(request.get('direction')).toBe('desc');
    await user.click(await screen.findByText(/J-2026-000010 Gearbox housing/));
    expect(within(dialog).getByText('Manual entry')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Link and replace' }));

    await waitFor(() => expect(body).toEqual({ machineJobId: ids.job, expectedJobVersion: 5 }));
    expect(await screen.findByText('J-2026-000010 now uses the data from PR-2026-000007.')).toBeInTheDocument();
  });

  it('unlinks a linked print with the version of its job', async () => {
    auth.permissions = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit];
    servePrint(printFixture({ job: { id: ids.job, displayId: 'J-2026-000010', title: 'Gearbox housing' } }));
    server.use(http.get(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json(jobFixture({ run: 'automatic', version: 8 }))));
    let body: unknown;
    server.use(http.delete(`*/api/v1/prints/${ids.print}/job`, async ({ request }) => { body = await request.json(); return HttpResponse.json(jobFixture({ version: 9 })); }));
    const user = userEvent.setup();
    renderPrint();

    expect(await screen.findByRole('link', { name: /J-2026-000010 Gearbox housing/ })).toHaveAttribute('href', machineLogbookPaths.job(ids.job));
    expect(screen.queryByRole('button', { name: 'Create job' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link to job' })).not.toBeInTheDocument();
    await screen.findByRole('link', { name: /J-2026-000010/ }); 
    // Carbon's icon-only overflow trigger is named by an aria-hidden tooltip that jsdom does not resolve, so find it by class.
    await waitFor(() => expect(document.querySelector('.cds--overflow-menu')).not.toBeNull());
    await user.click(document.querySelector('.cds--overflow-menu')!);
    await user.click(await screen.findByText('Unlink'));
    const dialog = await screen.findByRole('alertdialog', { name: /Unlink this print/ });
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));

    await waitFor(() => expect(body).toEqual({ expectedJobVersion: 8 }));
    expect(await screen.findByText('Print unlinked')).toBeInTheDocument();
  });

  it('does not offer unlink without job edit permission', async () => {
    auth.permissions = [PermissionId.machine_jobsread];
    servePrint(printFixture({ job: { id: ids.job, displayId: 'J-2026-000010', title: null } }));
    server.use(http.get(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json(jobFixture())));
    renderPrint();
    expect(await screen.findByRole('link', { name: 'J-2026-000010' })).toBeInTheDocument();
    expect(document.querySelector('.cds--overflow-menu')).toBeNull();
  });
});
