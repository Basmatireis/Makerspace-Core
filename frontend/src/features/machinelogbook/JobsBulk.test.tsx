import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  BulkAttachMachineRunsRequest,
  BulkCombineMachineRunsRequest,
  BulkCreateMachineJobsRequest,
  BulkDeleteMachineWorkRequest,
  WorkItem,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { customer, ids, jobFixture, operator, unassignedItem, workItem } from '../../test/machineRuns';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { batchAvailability, blockedItems, deleteBlocker, hasBookedMaterial, referenceTargets } from './bulkWork';
import { ApiError } from '../../api/http-client';

vi.mock('@carbon/charts-react', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

const secondRunId = '0192f6f8-743e-7c77-a349-cd07c3e8a921';
const secondJobId = '0192f6f8-743e-7c77-a349-cd07c3e8a922';
const otherMachineId = '0192f6f8-743e-7c77-a349-cd07c3e8a923';

const run1 = unassignedItem({ version: 5 });
const run2 = unassignedItem({ id: secondRunId, displayId: 'RN-2026-000009', fileName: 'cover_v1.gcode', version: 2 });
const runElsewhere = unassignedItem({
  id: secondRunId,
  displayId: 'RN-2026-000010',
  fileName: 'other.gcode',
  machineId: otherMachineId,
  machineName: 'Laser #2',
  version: 2,
});
const runRunning = unassignedItem({
  id: secondRunId,
  displayId: 'RN-2026-000011',
  fileName: 'live.gcode',
  status: 'running_unassigned',
});
const plainJob = workItem({ version: 3 });
const orderJob = workItem({
  id: secondJobId,
  displayId: 'J-2026-000002',
  title: 'Bracket',
  billing: { state: 'on_order', orderId: ids.otherJob, orderReference: 'O-2026-000004' },
  version: 7,
});
const recordedJob = workItem({
  source: 'recorded',
  runCount: 2,
  version: 3,
  consumption: { materials: [{ materialTypeName: 'PLA', unit: 'g', quantity: '183.000' }], measures: {} },
});

const allPermissions = [
  PermissionId.machine_jobsread,
  PermissionId.machine_jobscreate,
  PermissionId.machine_jobsedit,
  PermissionId.machine_jobsdelete,
  PermissionId.machinesread,
  PermissionId.ordersread,
];
const as = (...permissions: PermissionId[]) =>
  http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions)));
const listing = (items: WorkItem[]) =>
  http.get('*/api/v1/machine-logbook/work-items', () =>
    HttpResponse.json({ items, page: 1, pageSize: 10, total: items.length }),
  );
const lookups = () => [
  http.get('*/api/v1/billing-parties', () => HttpResponse.json({ items: [customer] })),
  http.get('*/api/v1/machine-job-operators', () => HttpResponse.json({ items: [operator] })),
];

async function openJobs(...items: WorkItem[]) {
  renderRoute(<App />, '/machine-logbook/jobs');
  const table = await screen.findByRole('table', { name: 'Jobs' }, { timeout: 5000 });
  expect(items.length).toBeGreaterThan(0);
  return table;
}

describe('batch action rules', () => {
  const can =
    (...granted: string[]) =>
    (permission: string) =>
      granted.includes(permission);
  const everything = can('machine_jobs.create', 'machine_jobs.edit', 'machine_jobs.delete');

  it('offers run actions only for unassigned runs of one machine and needs two runs to combine', () => {
    expect(batchAvailability([run1], everything as never)).toMatchObject({
      delete: { enabled: true },
      separate: { enabled: true },
      combined: { enabled: false },
      attach: { enabled: true },
    });
    expect(batchAvailability([run1, run2], everything as never)).toMatchObject({
      separate: { enabled: true },
      combined: { enabled: true },
      attach: { enabled: true },
    });
    const mixed = batchAvailability([run1, plainJob], everything as never);
    expect(mixed.separate.reason).toMatch(/only unassigned runs/);
    expect(mixed.delete.enabled).toBe(true);
    const machines = batchAvailability([run1, runElsewhere], everything as never);
    expect(machines.combined.reason).toMatch(/different machines/);
    expect(machines.attach.reason).toMatch(/different machines/);
    expect(machines.separate.enabled).toBe(true);
    expect(batchAvailability([run1, runRunning], everything as never).separate.reason).toMatch(/still running/);
  });

  it('follows the permission of the single operation', () => {
    expect(batchAvailability([run1], can('machine_jobs.edit') as never)).toMatchObject({
      delete: { enabled: false },
      separate: { enabled: false },
      attach: { enabled: true },
    });
    expect(batchAvailability([run1], can('machine_jobs.create') as never)).toMatchObject({
      delete: { enabled: false },
      separate: { enabled: true },
      attach: { enabled: false },
    });
    expect(batchAvailability([run1], can('machine_jobs.delete') as never)).toMatchObject({
      delete: { enabled: true },
      separate: { enabled: false },
      combined: { enabled: false },
    });
    expect(batchAvailability([], everything as never).delete.enabled).toBe(false);
  });

  it('skips jobs on an order and running runs when deleting', () => {
    expect(deleteBlocker(orderJob)).toBe('J-2026-000002 is on order O-2026-000004 — remove it from the order first');
    expect(deleteBlocker(runRunning)).toMatch(/still running/);
    expect(deleteBlocker(plainJob)).toBeNull();
    expect(batchAvailability([orderJob, runRunning], everything as never).delete.reason).toMatch(/every selected item/);
  });

  it('asks about material only when own material was consumed', () => {
    expect(hasBookedMaterial(recordedJob)).toBe(true);
    expect(
      hasBookedMaterial(
        workItem({
          consumption: { materials: [{ materialTypeName: 'External', unit: 'g', quantity: '50' }], measures: {} },
        }),
      ),
    ).toBe(false);
    expect(hasBookedMaterial(workItem({ consumption: { materials: [], measures: {} } }))).toBe(false);
    expect(referenceTargets([orderJob])).toEqual({ 'J-2026-000002': secondJobId, 'O-2026-000004': ids.otherJob });
  });

  it('reads the blocking items of a refused request', () => {
    const items = [
      {
        kind: 'job',
        id: secondJobId,
        displayId: 'J-2026-000002',
        code: 'job_on_order',
        message: 'J-2026-000002 is on an order',
      },
    ];
    expect(blockedItems(new ApiError(409, { code: 'bulk_blocked', message: 'x', details: { items } }))).toEqual(items);
    expect(blockedItems(new ApiError(409, { code: 'stale_write', message: 'x' }))).toBeNull();
    expect(blockedItems(new Error('x'))).toBeNull();
  });
});

describe('Jobs table selection', () => {
  it('offers no selection without a permission for a batch action', async () => {
    server.use(as(PermissionId.machine_jobsread), listing([run1]));
    const table = await openJobs(run1);
    expect(within(table).queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('enables the batch actions according to the selected rows', async () => {
    server.use(as(...allPermissions), listing([plainJob, run1, run2]));
    const user = userEvent.setup();
    const table = await openJobs(run1);
    await user.click(within(table).getByRole('checkbox', { name: 'Select bracket_v2.gcode' }));
    expect(screen.getByText('1 item selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create separate jobs' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create combined job' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attach to job' })).toBeEnabled();
    expect(screen.getByText('Create combined job: select at least 2 unassigned runs.')).toBeInTheDocument();

    await user.click(within(table).getByRole('checkbox', { name: 'Select cover_v1.gcode' }));
    expect(screen.getByRole('button', { name: 'Create combined job' })).toBeEnabled();

    await user.click(within(table).getByRole('checkbox', { name: 'Select Gearbox housing' }));
    expect(screen.getByText('3 items selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create separate jobs' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attach to job' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(screen.getByText(/Create separate jobs: only unassigned runs can be used/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(within(table).getByRole('checkbox', { name: 'Select Gearbox housing' })).not.toBeChecked();
  });

  it('selects every row of the page with the header checkbox', async () => {
    server.use(as(...allPermissions), listing([plainJob, run1, run2]));
    const user = userEvent.setup();
    const table = await openJobs(run1);
    await user.click(within(table).getByRole('checkbox', { name: 'Select all jobs on this page' }));
    expect(screen.getByText('3 items selected')).toBeInTheDocument();
  });
});

describe('Delete selection', () => {
  it('lists skipped items, asks about material and sends one request with the expected versions', async () => {
    let body: BulkDeleteMachineWorkRequest | undefined;
    server.use(
      as(...allPermissions),
      listing([recordedJob, orderJob, run1]),
      http.post('*/api/v1/machine-jobs/bulk-delete', async ({ request }) => {
        body = (await request.json()) as BulkDeleteMachineWorkRequest;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    const table = await openJobs(run1);
    await user.click(within(table).getByRole('checkbox', { name: 'Select all jobs on this page' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: /Delete 1 job, 1 run/ });
    expect(within(dialog).getByText('Delete 1 job, 1 run?')).toBeInTheDocument();
    expect(within(dialog).getByText('1 item will be skipped')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'O-2026-000004' })).toHaveAttribute(
      'href',
      `/orders/${ids.otherJob}`,
    );
    expect(within(dialog).getByLabelText('Also delete their recorded runs (in 1 job)')).toBeChecked();
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByLabelText(/^Reverse consumption/));
    await user.click(confirm);
    await waitFor(() =>
      expect(body).toEqual({
        jobs: [{ id: ids.job, expectedVersion: 3 }],
        runs: [{ id: ids.recordedRun, expectedVersion: 5 }],
        deleteRuns: true,
        material: 'reverse',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: /Delete 1 job, 1 run/ })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('Deleted 1 job and 1 run')).toBeInTheDocument();
    expect(screen.getByText('0 items selected')).toBeInTheDocument();
  });

  it('keeps recorded runs when the box is cleared and sends no material choice without booked material', async () => {
    let body: BulkDeleteMachineWorkRequest | undefined;
    server.use(
      as(...allPermissions),
      listing([workItem({ source: 'recorded', runCount: 2, version: 3 })]),
      http.post('*/api/v1/machine-jobs/bulk-delete', async ({ request }) => {
        body = (await request.json()) as BulkDeleteMachineWorkRequest;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    const table = await openJobs(plainJob);
    await user.click(within(table).getByRole('checkbox', { name: 'Select Gearbox housing' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByText('Material consumption')).not.toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(/^Also delete their recorded runs/));
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(body).toEqual({
        jobs: [{ id: ids.job, expectedVersion: 3 }],
        runs: [],
        deleteRuns: false,
        material: null,
      }),
    );
  });

  it('shows every blocking item when the server refuses the request', async () => {
    server.use(
      as(...allPermissions),
      listing([plainJob, run1]),
      http.post('*/api/v1/machine-jobs/bulk-delete', () =>
        HttpResponse.json(
          {
            code: 'bulk_blocked',
            message: 'Some items cannot be processed; nothing was changed',
            requestId: 'r1',
            details: {
              items: [
                {
                  kind: 'job',
                  id: ids.job,
                  displayId: 'J-2026-000001',
                  code: 'stale_write',
                  message: 'J-2026-000001 changed; reload the list and try again',
                },
              ],
            },
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    const table = await openJobs(plainJob);
    await user.click(within(table).getByRole('checkbox', { name: 'Select Gearbox housing' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(
      await within(dialog).findByText('The selection could not be deleted. Nothing was changed'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('listitem')).toHaveTextContent(
      'J-2026-000001 changed; reload the list and try again',
    );
    expect(screen.getByText('1 item selected')).toBeInTheDocument();
  });

  it('is unavailable without machine_jobs.delete', async () => {
    server.use(as(PermissionId.machine_jobsread, PermissionId.machine_jobscreate), listing([run1]));
    const user = userEvent.setup();
    const table = await openJobs(run1);
    await user.click(within(table).getByRole('checkbox', { name: 'Select bracket_v2.gcode' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByText('Delete: you do not have permission to delete jobs and runs.')).toBeInTheDocument();
  });
});

describe('Create jobs from runs', () => {
  async function fillParty(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
    await user.click(within(dialog).getByPlaceholderText('Search people or organizations'));
    await user.click(await screen.findByText('TU Berlin'));
    await user.click(within(dialog).getByPlaceholderText('Search operators'));
    await user.click(await screen.findByText('Maria Hoffmann'));
  }

  it('creates one job per selected run with shared recipient and operator', async () => {
    let body: BulkCreateMachineJobsRequest | undefined;
    server.use(
      as(...allPermissions),
      listing([run1, run2]),
      ...lookups(),
      http.post('*/api/v1/machine-runs/bulk-create-jobs', async ({ request }) => {
        body = (await request.json()) as BulkCreateMachineJobsRequest;
        return HttpResponse.json(
          {
            jobs: [
              { id: ids.job, displayId: 'J-2026-000010', title: null },
              { id: secondJobId, displayId: 'J-2026-000011', title: null },
            ],
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    const table = await openJobs(run1);
    await user.click(within(table).getByRole('checkbox', { name: 'Select all jobs on this page' }));
    await user.click(screen.getByRole('button', { name: 'Create separate jobs' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Create 2 separate jobs')).toBeInTheDocument();
    expect(within(dialog).getByText('cover_v1.gcode')).toBeInTheDocument();
    const create = within(dialog).getByRole('button', { name: 'Create 2 jobs' });
    await user.click(create);
    expect(body).toBeUndefined(); // customer and operator are required
    await fillParty(user, dialog);
    await user.click(create);
    await waitFor(() =>
      expect(body).toEqual({
        runs: [
          { id: ids.recordedRun, expectedVersion: 5 },
          { id: secondRunId, expectedVersion: 2 },
        ],
        customer: { kind: 'organization', id: ids.organization },
        operatorPersonId: ids.operator,
        notes: null,
      }),
    );
    expect(await screen.findByText('2 jobs created')).toBeInTheDocument();
    expect(screen.getByText(/J-2026-000010, J-2026-000011/)).toBeInTheDocument();
    expect(screen.getByText('0 items selected')).toBeInTheDocument();
  });

  it('combines the selected runs into one job and opens it', async () => {
    let body: BulkCombineMachineRunsRequest | undefined;
    server.use(
      as(...allPermissions),
      listing([run1, run2]),
      ...lookups(),
      http.post('*/api/v1/machine-runs/bulk-combine', async ({ request }) => {
        body = (await request.json()) as BulkCombineMachineRunsRequest;
        return HttpResponse.json(jobFixture(), { status: 201 });
      }),
      http.get(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json(jobFixture())),
    );
    const user = userEvent.setup();
    const table = await openJobs(run1);
    await user.click(within(table).getByRole('checkbox', { name: 'Select all jobs on this page' }));
    await user.click(screen.getByRole('button', { name: 'Create combined job' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name (optional)'), ' Housing set ');
    await fillParty(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create combined job' }));
    await waitFor(() =>
      expect(body).toEqual({
        runs: [
          { id: ids.recordedRun, expectedVersion: 5 },
          { id: secondRunId, expectedVersion: 2 },
        ],
        title: 'Housing set',
        customer: { kind: 'organization', id: ids.organization },
        operatorPersonId: ids.operator,
        notes: null,
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Gearbox housing' }, { timeout: 5000 })).toBeInTheDocument();
  });

  it('explains a refused combination in the dialog', async () => {
    server.use(
      as(...allPermissions),
      listing([run1, run2]),
      ...lookups(),
      http.post('*/api/v1/machine-runs/bulk-combine', () =>
        HttpResponse.json(
          {
            code: 'runs_on_different_machines',
            message: 'A job has one machine; the runs were recorded on different machines',
            requestId: 'r',
          },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    const table = await openJobs(run1);
    await user.click(within(table).getByRole('checkbox', { name: 'Select all jobs on this page' }));
    await user.click(screen.getByRole('button', { name: 'Create combined job' }));
    const dialog = await screen.findByRole('dialog');
    await fillParty(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create combined job' }));
    expect(
      await within(dialog).findByText('A job has one machine; the runs were recorded on different machines'),
    ).toBeInTheDocument();
  });
});

describe('Attach to job', () => {
  it('attaches the selected runs to a job of their machine', async () => {
    let body: BulkAttachMachineRunsRequest | undefined;
    const requests: URL[] = [];
    server.use(
      as(...allPermissions),
      http.get('*/api/v1/machine-logbook/work-items', ({ request }) => {
        requests.push(new URL(request.url));
        return HttpResponse.json({ items: [plainJob, run1, run2], page: 1, pageSize: 10, total: 3 });
      }),
      http.get(`*/api/v1/machine-jobs/${ids.job}`, () => HttpResponse.json(jobFixture())),
      http.post(`*/api/v1/machine-jobs/${ids.job}/runs/bulk-attach`, async ({ request }) => {
        body = (await request.json()) as BulkAttachMachineRunsRequest;
        return HttpResponse.json(jobFixture());
      }),
    );
    const user = userEvent.setup();
    const table = await openJobs(run1);
    await user.click(within(table).getByRole('checkbox', { name: 'Select bracket_v2.gcode' }));
    await user.click(within(table).getByRole('checkbox', { name: 'Select cover_v1.gcode' }));
    await user.click(screen.getByRole('button', { name: 'Attach to job' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Attach 2 runs' });
    expect(submit).toBeDisabled();
    await user.click(within(dialog).getByPlaceholderText('Search jobs'));
    await user.click(await screen.findByText(/J-2026-000001 Gearbox housing/));
    expect(await within(dialog).findByLabelText('Replace manual runs')).toBeChecked();
    expect(within(dialog).getByText('Manual entry replaced')).toBeInTheDocument();
    await waitFor(() => expect(submit).toBeEnabled());
    // The candidates are the jobs of the machine the runs were recorded on.
    expect(
      requests.some(
        (url) =>
          url.searchParams.getAll('machineId').includes(ids.machine) && url.searchParams.get('pageSize') === '50',
      ),
    ).toBe(true);
    await user.click(submit);
    await waitFor(() =>
      expect(body).toEqual({
        runs: [
          { id: ids.recordedRun, expectedVersion: 5 },
          { id: secondRunId, expectedVersion: 2 },
        ],
        replaceManualRuns: true,
        expectedJobVersion: 3,
      }),
    );
    expect(await screen.findByText('2 runs attached')).toBeInTheDocument();
  });

  it('is unavailable without machine_jobs.edit', async () => {
    server.use(as(PermissionId.machine_jobsread, PermissionId.machine_jobscreate), listing([run1]));
    const user = userEvent.setup();
    const table = await openJobs(run1);
    await user.click(within(table).getByRole('checkbox', { name: 'Select bracket_v2.gcode' }));
    expect(screen.getByRole('button', { name: 'Attach to job' })).toBeDisabled();
  });
});
