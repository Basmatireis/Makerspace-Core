import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  AddManualMachineRunRequest,
  AttachMachineRunRequest,
  CreateMachineJobRequest,
  DetachMachineRunRequest,
  Material,
  SetMachineJobPriceAdjustmentRequest,
  UpdateMachineRunRequest,
  VersionRequest,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import {
  customer,
  ids,
  iso,
  jobFixture,
  machine,
  manualRun,
  needsOutcomeJob,
  operator,
  recordedRun,
  runningJob,
  unassignedItem,
  usage,
  workItem,
} from '../../test/machineRuns';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

const {
  machine: machineId,
  material: materialId,
  job: jobId,
  organization: organizationId,
  operator: operatorId,
  recordedRun: recordedRunId,
  manualRun: manualRunId,
} = ids;

const material: Material = {
  id: materialId,
  name: 'PLA Black',
  kind: 'filament',
  materialTypeId: '0192f6f8-743e-7c77-a349-cd07c3e8e001',
  materialTypeName: 'PLA',
  colorName: 'Black',
  colorHex: '#1A1A1A',
  unit: 'g',
  active: true,
  lowStockThreshold: '500',
  quantity: '8420',
  assignedQuantity: '0',
  unassignedQuantity: '8420',
  averageUnitCost: '0.018',
  inventoryValue: '151.56',
  stockState: 'in_stock',
  inventoryVersion: 7,
  recentConsumption: '2140',
  version: 2,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-09-15T11:26:00Z',
};

const as = (...permissions: PermissionId[]) =>
  http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions)));
const noUnassignedRuns = http.get('*/api/v1/machine-runs', () =>
  HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 }),
);
// Carbon's icon-only overflow trigger is named by an aria-hidden tooltip that jsdom does not resolve, so find it by class.
const overflowButton = () => document.querySelector<HTMLButtonElement>('.page-header__actions .cds--overflow-menu')!;
const orderAssociation = (orderId: string | null = null) =>
  http.get(`*/api/v1/machine-jobs/${jobId}/order-association`, () =>
    HttpResponse.json({ orderId, orderReference: orderId ? 'O-2026-0004' : null, sourceChanged: false }),
  );

/** Opens the overflow menu in the table row of a run and clicks one of its actions. */
async function runAction(user: ReturnType<typeof userEvent.setup>, runDisplayId: string, action: string) {
  const runs = await screen.findByRole('table', { name: 'Runs' }, { timeout: 5000 });
  const row = within(runs).getByRole('link', { name: runDisplayId }).closest('tr')!;
  await user.click(row.querySelector<HTMLButtonElement>('.cds--overflow-menu')!);
  await user.click(await screen.findByText(action));
}

const jobItem = workItem({
  fileName: 'gearbox_housing_v3.gcode',
  source: 'recorded',
  startedAt: '2026-09-15T08:12:00Z',
  runCount: 2,
});
const runItem = unassignedItem();

describe('Jobs page', () => {
  it('lists jobs and unassigned runs with statuses, links and URL filters', async () => {
    const requests: URL[] = [];
    server.use(
      as(PermissionId.machine_jobsread),
      http.get('*/api/v1/machine-logbook/work-items', ({ request }) => {
        requests.push(new URL(request.url));
        return HttpResponse.json({ items: [jobItem, runItem], page: 1, pageSize: 10, total: 2 });
      }),
    );
    renderRoute(<App />, '/machine-logbook/jobs?status=unassigned&q=bracket');
    const table = await screen.findByRole('table', { name: 'Jobs' }, { timeout: 5000 });
    expect(requests[0].searchParams.get('status')).toBe('unassigned');
    expect(requests[0].searchParams.get('search')).toBe('bracket');
    expect(requests[0].searchParams.get('sort')).toBe('startedAt');
    expect(requests[0].searchParams.get('direction')).toBe('desc');

    expect(within(table).getByRole('link', { name: 'Gearbox housing' })).toHaveAttribute(
      'href',
      `/machine-logbook/jobs/${jobId}`,
    );
    expect(within(table).getByText('J-2026-000001 · gearbox_housing_v3.gcode · 2 runs')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'bracket_v2.gcode' })).toHaveAttribute(
      'href',
      `/machine-logbook/jobs/runs/${recordedRunId}`,
    );
    expect(within(table).getByText('RN-2026-000008 · Unassigned')).toBeInTheDocument();
    expect(within(table).getByText('Successful')).toBeInTheDocument();
    expect(within(table).getByText('Unassigned run')).toBeInTheDocument();
    expect(within(table).getByText('€12.50')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New job' })).not.toBeInTheDocument();
  });

  it('deletes an unassigned run from its row menu only with machine_jobs.delete', async () => {
    let body: unknown;
    const run = recordedRun({ usages: [] });
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobsdelete),
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({ items: [runItem], page: 1, pageSize: 10, total: 1 }),
      ),
      http.get(`*/api/v1/machine-runs/${recordedRunId}`, () => HttpResponse.json(run)),
      http.delete(`*/api/v1/machine-runs/${recordedRunId}`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/machine-logbook/jobs');
    const table = await screen.findByRole('table', { name: 'Jobs' }, { timeout: 5000 });
    await user.click(
      within(table)
        .getByRole('link', { name: 'bracket_v2.gcode' })
        .closest('tr')!
        .querySelector<HTMLButtonElement>('.cds--overflow-menu')!,
    );
    await user.click(await screen.findByText('Delete run'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Delete run' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: run.version, reverseConsumption: false }));
  });

  it('has no row menu for unassigned runs without machine_jobs.delete', async () => {
    server.use(
      as(PermissionId.machine_jobsread),
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({ items: [runItem], page: 1, pageSize: 10, total: 1 }),
      ),
    );
    renderRoute(<App />, '/machine-logbook/jobs');
    const table = await screen.findByRole('table', { name: 'Jobs' }, { timeout: 5000 });
    expect(table.querySelector('.cds--overflow-menu')).toBeNull();
  });

  it('sends several selected values as repeated parameters, keeps the page URL comma-separated and sorts on the server', async () => {
    const requests: URL[] = [];
    server.use(
      as(PermissionId.machine_jobsread),
      http.get('*/api/v1/machine-logbook/work-items', ({ request }) => {
        requests.push(new URL(request.url));
        return HttpResponse.json({ items: [jobItem], page: 1, pageSize: 10, total: 1 });
      }),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(
      <App />,
      '/machine-logbook/jobs?status=running,running_unassigned&source=manual,recorded&billing=on_order,order_outdated',
    );
    const table = await screen.findByRole('table', { name: 'Jobs' }, { timeout: 5000 });
    expect(requests[0].searchParams.getAll('status')).toEqual(['running', 'running_unassigned']);
    expect(requests[0].searchParams.getAll('source')).toEqual(['manual', 'recorded']);
    expect(requests[0].searchParams.getAll('billing')).toEqual(['on_order', 'order_outdated']);

    await user.click(within(table).getByRole('button', { name: /Price/ }));
    await waitFor(() => expect(requests.at(-1)?.searchParams.get('sort')).toBe('price'));
    expect(requests.at(-1)?.searchParams.get('direction')).toBe('desc');
    // The page's own URL keeps the compact comma-separated form.
    expect(decodeURIComponent(router.state.location.search)).toContain('status=running,running_unassigned');
    expect(decodeURIComponent(router.state.location.search)).toContain('billing=on_order,order_outdated');
  });

  it('shows the empty state and offers New job only with machine_jobs.create', async () => {
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobscreate),
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({ items: [], page: 1, pageSize: 10, total: 0 }),
      ),
    );
    renderRoute(<App />, '/machine-logbook/jobs');
    expect(await screen.findByText('No jobs yet', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New job' }).length).toBeGreaterThan(0);
  });
});

describe('Job form', () => {
  function lookups() {
    return [
      as(
        PermissionId.machine_jobsread,
        PermissionId.machine_jobscreate,
        PermissionId.machinesread,
        PermissionId.inventoryread,
        PermissionId.pricingread,
      ),
      http.get('*/api/v1/pricing-groups', () =>
        HttpResponse.json({
          items: [
            {
              id: ids.pricingGroup,
              name: 'Partner',
              description: null,
              active: true,
              isDefault: false,
              rules: [],
              version: 1,
              createdAt: '2026-09-01T00:00:00Z',
              updatedAt: '2026-09-01T00:00:00Z',
            },
          ],
        }),
      ),
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({ items: [], page: 1, pageSize: 10, total: 0 }),
      ),
      http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machine], page: 1, pageSize: 100, total: 1 })),
      http.get('*/api/v1/materials', () =>
        HttpResponse.json({
          items: [material],
          page: 1,
          pageSize: 100,
          total: 1,
          totalInventoryValue: material.inventoryValue,
        }),
      ),
      http.get('*/api/v1/filament-spools', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
      http.get('*/api/v1/billing-parties', () => HttpResponse.json({ items: [customer] })),
      http.get('*/api/v1/machine-job-operators', () => HttpResponse.json({ items: [operator] })),
    ];
  }

  it('hides the outcome while the computed end is in the future and defaults to Successful otherwise', async () => {
    server.use(...lookups());
    const user = userEvent.setup();
    renderRoute(<App />, '/machine-logbook/jobs');
    await user.click((await screen.findAllByRole('button', { name: 'New job' }, { timeout: 5000 }))[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Outcome')).toHaveValue('successful');
    expect(within(dialog).queryByText(/The end is in the future/)).not.toBeInTheDocument();

    const hours = within(dialog).getByLabelText('Hours');
    await user.clear(hours);
    await user.type(hours, '3');
    await waitFor(() => expect(within(dialog).queryByLabelText('Outcome')).not.toBeInTheDocument());
    expect(within(dialog).getByText(/The end is in the future/)).toBeInTheDocument();
  });

  it('creates a manual job with its first run, customer, operator, material and pricing group and opens it', async () => {
    let submitted: CreateMachineJobRequest | undefined;
    server.use(
      ...lookups(),
      http.post('*/api/v1/machine-jobs', async ({ request }) => {
        submitted = (await request.json()) as CreateMachineJobRequest;
        return HttpResponse.json(jobFixture(), { status: 201 });
      }),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/machine-logbook/jobs');
    await user.click((await screen.findAllByRole('button', { name: 'New job' }, { timeout: 5000 }))[0]);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name (optional)'), ' Gearbox housing ');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Bambu H2D #1' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Machine'), machineId);
    await user.click(within(dialog).getByPlaceholderText('Search people or organizations'));
    await user.click(await screen.findByText('TU Berlin'));
    await user.click(within(dialog).getByPlaceholderText('Search operators'));
    await user.click(await screen.findByText('Maria Hoffmann'));
    await user.selectOptions(within(dialog).getByLabelText('Material'), materialId);
    await user.type(await within(dialog).findByLabelText('Quantity (g)'), '25');
    await user.selectOptions(within(dialog).getByLabelText('Pricing group (optional)'), ids.pricingGroup);
    await user.click(within(dialog).getByRole('button', { name: 'Create job' }));
    // The first run carries start, end, outcome and material; the job itself has none of them.
    await waitFor(() =>
      expect(submitted).toMatchObject({
        machineId,
        title: 'Gearbox housing',
        customer: { kind: 'organization', id: organizationId },
        operatorPersonId: operatorId,
        pricingGroupId: ids.pricingGroup,
        run: {
          outcome: 'successful',
          usages: [{ ownership: 'makerspace', materialId, spoolId: null, quantity: '25', quantityBasis: 'actual' }],
        },
      }),
    );
    expect(submitted).not.toHaveProperty('outcome');
    expect(submitted).not.toHaveProperty('startsAt');
    expect(
      submitted?.run.startsAt &&
        submitted.run.endsAt &&
        new Date(submitted.run.endsAt) > new Date(submitted.run.startsAt),
    ).toBe(true);
    expect(await screen.findByRole('heading', { name: 'Gearbox housing' }, { timeout: 5000 })).toBeInTheDocument();
  });

  it('shows a server rejection of the outcome as an inline error', async () => {
    server.use(
      ...lookups(),
      http.post('*/api/v1/machine-jobs', () =>
        HttpResponse.json(
          { code: 'outcome_before_run_end', message: 'An outcome cannot be recorded before the run has ended' },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/machine-logbook/jobs');
    await user.click((await screen.findAllByRole('button', { name: 'New job' }, { timeout: 5000 }))[0]);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Bambu H2D #1' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Machine'), machineId);
    await user.click(within(dialog).getByPlaceholderText('Search people or organizations'));
    await user.click(await screen.findByText('TU Berlin'));
    await user.click(within(dialog).getByPlaceholderText('Search operators'));
    await user.click(await screen.findByText('Maria Hoffmann'));
    await user.click(dialog.querySelector('.mj-usage-row .cds--btn--icon-only')!);
    await user.click(within(dialog).getByRole('button', { name: 'Create job' }));
    expect(
      await within(dialog).findByText('The outcome can only be recorded once the run has ended.'),
    ).toBeInTheDocument();
  });
});

describe('Job detail page', () => {
  const editor = [PermissionId.machine_jobsread, PermissionId.machine_jobsedit] as const;

  it('lists the runs with source, state, "From machine" labels and adds up the runtime', async () => {
    const recorded = recordedRun({
      job: { id: jobId, displayId: 'J-2026-000001', title: 'Gearbox housing' },
      startedAt: iso(-100),
      endedAt: iso(-40),
      durationSeconds: 3600,
      usages: [usage({ id: ids.otherJob, quantity: '42.000', materialName: 'PETG Grey' })],
      usagesFromMachine: true,
    });
    const replaced = manualRun({
      id: ids.otherJob,
      displayId: 'RN-2026-000002',
      state: 'replaced',
      outcome: null,
      usages: [],
    });
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () =>
        HttpResponse.json(jobFixture({ runs: [manualRun(), recorded, replaced] })),
      ),
      noUnassignedRuns,
    );
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    const table = await screen.findByRole('table', { name: 'Runs' }, { timeout: 5000 });
    // Manual run: no machine labels. Recorded run: link, connector, machine-reported outcome and material.
    const manualRow = within(table).getByRole('link', { name: 'RN-2026-000001' }).closest('tr')!;
    expect(within(manualRow).getByText('Manual')).toBeInTheDocument();
    expect(within(manualRow).queryByText('From machine')).not.toBeInTheDocument();
    expect(within(manualRow).getByText('183 g PLA Black')).toBeInTheDocument();
    const recordedRow = within(table).getByRole('link', { name: 'RN-2026-000007' }).closest('tr')!;
    expect(recordedRow.querySelector('a')).toHaveAttribute('href', `/machine-logbook/jobs/runs/${recordedRunId}`);
    expect(within(recordedRow).getByText('Recorded')).toBeInTheDocument();
    expect(within(recordedRow).getByText('Bambu LAN')).toBeInTheDocument();
    expect(within(recordedRow).getAllByText('From machine')).toHaveLength(2);
    // The replaced run is history: hidden until asked for, and then muted with a Replaced tag.
    expect(within(table).queryByText('RN-2026-000002')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show replaced runs (1)' }));
    const replacedRow = within(table).getByRole('link', { name: 'RN-2026-000002' }).closest('tr')!;
    expect(replacedRow).toHaveClass('mj-run-row--replaced');
    expect(within(replacedRow).getByText('Replaced')).toBeInTheDocument();
    expect(replacedRow.querySelector('.cds--overflow-menu')).toBeNull();
    // Facts: the runtime is the sum of the runs that count, the replaced one is not included.
    expect(screen.getByText('Runtime', { selector: 'dt' }).nextSibling).toHaveTextContent('2 h 30 min');
    expect(screen.getByText('Runs', { selector: 'dt' }).nextSibling).toHaveTextContent(/^2.*1 replaced/);
  });

  it('shows a running manual run and cancels it with the version of the run', async () => {
    let cancelled: VersionRequest | undefined;
    const job = runningJob();
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(job)),
      noUnassignedRuns,
      http.post(`*/api/v1/machine-runs/${manualRunId}/cancellation`, async ({ request }) => {
        cancelled = (await request.json()) as VersionRequest;
        return HttpResponse.json(jobFixture({ outcome: 'cancelled', status: 'cancelled' }));
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByRole('heading', { name: 'Gearbox housing' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Run progress' })).toBeInTheDocument();
    expect(screen.getByText('Expected end')).toBeInTheDocument();
    expect(screen.queryByText(jobId)).not.toBeInTheDocument();

    await runAction(user, 'RN-2026-000001', 'Cancel run');
    const dialog = await screen.findByRole('alertdialog');
    expect(cancelled).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(cancelled).toEqual({ expectedVersion: 2 }));
    expect(await screen.findByText('Run cancelled')).toBeInTheDocument();
  });

  it('hides run and edit actions from a reader', async () => {
    server.use(
      as(PermissionId.machine_jobsread),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(needsOutcomeJob())),
    );
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByRole('heading', { name: 'Gearbox housing' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Outcome not recorded yet')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Runs' })).toBeInTheDocument();
    expect(screen.queryByText('Record the outcome')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit job' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach recorded run' })).not.toBeInTheDocument();
    expect(document.querySelector('tbody .cds--overflow-menu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'More job actions' })).not.toBeInTheDocument();
    expect(screen.queryByText('Order')).not.toBeInTheDocument();
  });

  it('records the outcome of every run that has ended without one', async () => {
    const second = manualRun({
      id: ids.otherJob,
      displayId: 'RN-2026-000002',
      outcome: null,
      version: 4,
      startedAt: iso(-60),
      endedAt: iso(-10),
      durationSeconds: 3000,
    });
    const job = jobFixture({
      runs: [manualRun({ outcome: null }), second],
      outcome: 'unknown',
      status: 'needs_outcome',
    });
    const updates: { id: string; body: UpdateMachineRunRequest }[] = [];
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(job)),
      noUnassignedRuns,
      http.patch('*/api/v1/machine-runs/:runId', async ({ request, params }) => {
        updates.push({ id: String(params.runId), body: (await request.json()) as UpdateMachineRunRequest });
        return HttpResponse.json({ run: manualRun({ outcome: 'failed' }), job });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByText('Record the outcome')).toBeInTheDocument();
    expect(screen.getByText('2 runs of this job have ended. How did each one go?')).toBeInTheDocument();
    const saveButtons = screen.getAllByRole('button', { name: 'Save outcome' });
    expect(saveButtons).toHaveLength(2);
    expect(saveButtons[0]).toBeDisabled();
    // Each run is recorded on its own.
    await user.selectOptions(screen.getByLabelText('Outcome of RN-2026-000002'), 'failed');
    await user.click(screen.getAllByRole('button', { name: 'Save outcome' })[1]);
    await waitFor(() =>
      expect(updates).toEqual([{ id: ids.otherJob, body: { outcome: 'failed', expectedVersion: 4 } }]),
    );
    expect(await screen.findByText('Outcome recorded')).toBeInTheDocument();
  });

  it('adds a run (a reprint) and shows both runs with the summed runtime', async () => {
    let added: AddManualMachineRunRequest | undefined;
    const reprint = manualRun({
      id: ids.otherJob,
      displayId: 'RN-2026-000002',
      startedAt: iso(-60),
      endedAt: iso(-10),
      durationSeconds: 3000,
      usages: [usage({ id: ids.usage, quantity: '25.000' })],
      version: 1,
    });
    const before = jobFixture();
    server.use(
      as(...editor, PermissionId.machinesread, PermissionId.inventoryread),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () =>
        HttpResponse.json(added ? jobFixture({ runs: [manualRun(), reprint], version: 4 }) : before),
      ),
      noUnassignedRuns,
      http.get('*/api/v1/materials', () =>
        HttpResponse.json({
          items: [material],
          page: 1,
          pageSize: 100,
          total: 1,
          totalInventoryValue: material.inventoryValue,
        }),
      ),
      http.get('*/api/v1/filament-spools', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
      http.post(`*/api/v1/machine-jobs/${jobId}/runs`, async ({ request }) => {
        added = (await request.json()) as AddManualMachineRunRequest;
        return HttpResponse.json(jobFixture({ runs: [manualRun(), reprint], version: 4 }), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByText('Runtime', { selector: 'dt' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Runtime', { selector: 'dt' }).nextSibling).toHaveTextContent('1 h 30 min');
    await user.click(screen.getByRole('button', { name: 'Add run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add run' });
    expect(within(dialog).getByLabelText('Outcome')).toHaveValue('successful');
    await user.selectOptions(await within(dialog).findByLabelText('Material'), materialId);
    await user.type(within(dialog).getByLabelText('Quantity (g)'), '25');
    await user.click(within(dialog).getByRole('button', { name: 'Add run' }));

    await waitFor(() =>
      expect(added).toMatchObject({
        expectedJobVersion: 3,
        run: {
          outcome: 'successful',
          usages: [{ ownership: 'makerspace', materialId, quantity: '25', quantityBasis: 'actual' }],
        },
      }),
    );
    expect(new Date(added!.run.endsAt).getTime()).toBeGreaterThan(new Date(added!.run.startsAt).getTime());
    expect(await screen.findByText('Run added')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Runs' });
    await waitFor(() => expect(within(table).getByRole('link', { name: 'RN-2026-000002' })).toBeInTheDocument());
    expect(within(table).getByRole('link', { name: 'RN-2026-000001' })).toBeInTheDocument();
    expect(screen.getByText('Runtime', { selector: 'dt' }).nextSibling).toHaveTextContent('2 h 20 min');
    expect(screen.getByText('Runs', { selector: 'dt' }).nextSibling).toHaveTextContent('2');
  });

  it('attaches a running recorded run of the job machine and replaces the manual runs', async () => {
    let attached: AttachMachineRunRequest | undefined;
    const running = recordedRun({
      state: 'running',
      endedAt: null,
      estimatedEndAt: iso(30),
      startedAt: iso(-30),
      progressPercent: 50,
      outcome: null,
      outcomeFromMachine: false,
      durationSeconds: 3600,
    });
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      http.get('*/api/v1/machine-runs', ({ request }) => {
        const params = new URL(request.url).searchParams;
        expect(params.get('machineId')).toBe(machineId);
        expect(params.get('assigned')).toBe('false');
        expect(params.get('source')).toBe('recorded');
        return HttpResponse.json({ items: [running], page: 1, pageSize: 100, total: 1 });
      }),
      http.put(`*/api/v1/machine-runs/${recordedRunId}/job`, async ({ request }) => {
        attached = (await request.json()) as AttachMachineRunRequest;
        return HttpResponse.json(jobFixture());
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await user.click(await screen.findByRole('button', { name: 'Attach recorded run' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: /Recorded run/ }));
    await user.click(await screen.findByText(/Gearbox housing v3 · RN-2026-000007/));
    expect(await within(dialog).findByText('Manual run')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Replace manual runs' })).toBeChecked();
    expect(within(dialog).getByText('Manual runs replaced')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Attach and replace' }));
    await waitFor(() =>
      expect(attached).toEqual({ machineJobId: jobId, replaceManualRuns: true, expectedJobVersion: 3 }),
    );
  });

  it('does not offer to attach a recorded run when the machine has none', async () => {
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      noUnassignedRuns,
    );
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByRole('button', { name: 'Add run' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach recorded run' })).not.toBeInTheDocument();
  });

  it('detaches the only recorded run of a job and explains the manual copy', async () => {
    let detached: DetachMachineRunRequest | undefined;
    const recorded = recordedRun({
      job: { id: jobId, displayId: 'J-2026-000001', title: 'Gearbox housing' },
      usagesFromMachine: true,
      usages: [usage()],
    });
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () =>
        HttpResponse.json(jobFixture({ runs: [recorded], startedAt: recorded.startedAt })),
      ),
      noUnassignedRuns,
      http.delete(`*/api/v1/machine-runs/${recordedRunId}/job`, async ({ request }) => {
        detached = (await request.json()) as DetachMachineRunRequest;
        return HttpResponse.json(jobFixture());
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await runAction(user, 'RN-2026-000007', 'Detach from job');
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/gets a manual run with the same start, end and outcome, but without material/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Detach' }));
    await waitFor(() => expect(detached).toEqual({ expectedJobVersion: 3 }));
    expect(await screen.findByText('Run detached')).toBeInTheDocument();
  });

  it('offers Delete run for a manual run with edit access only, and hides it for recorded runs without machine_jobs.delete', async () => {
    const recorded = recordedRun({
      job: { id: jobId, displayId: 'J-2026-000001', title: 'Gearbox housing' },
      usagesFromMachine: true,
    });
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () =>
        HttpResponse.json(jobFixture({ runs: [manualRun(), recorded] })),
      ),
      noUnassignedRuns,
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    const runs = await screen.findByRole('table', { name: 'Runs' }, { timeout: 5000 });
    await user.click(
      within(runs)
        .getByRole('link', { name: 'RN-2026-000001' })
        .closest('tr')!
        .querySelector<HTMLButtonElement>('.cds--overflow-menu')!,
    );
    expect(await screen.findByText('Delete run')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(
      within(runs)
        .getByRole('link', { name: 'RN-2026-000007' })
        .closest('tr')!
        .querySelector<HTMLButtonElement>('.cds--overflow-menu')!,
    );
    expect(await screen.findByText('Detach from job')).toBeInTheDocument();
    expect(screen.queryByText('Delete run')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete job')).not.toBeInTheDocument();
  });

  it('requires an explicit consumption choice and sends it when a manual run is deleted', async () => {
    let removed: unknown;
    const second = manualRun({
      id: ids.otherJob,
      displayId: 'RN-2026-000002',
      version: 6,
      usages: [usage({ spoolDisplayId: 'SP-0001' })],
    });
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture({ runs: [manualRun(), second] }))),
      noUnassignedRuns,
      http.delete(`*/api/v1/machine-runs/${ids.otherJob}`, async ({ request }) => {
        removed = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await runAction(user, 'RN-2026-000002', 'Delete run');
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete run' });
    expect(
      within(dialog).getByRole('radio', { name: 'Reverse consumption (183 g back to SP-0001)' }),
    ).not.toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Keep consumption' })).not.toBeChecked();
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: 'Keep consumption' }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(removed).toEqual({ expectedVersion: 6, reverseConsumption: false }));
    expect(await screen.findByText('Run deleted')).toBeInTheDocument();
  });

  it('omits the consumption choice when the run booked no material', async () => {
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () =>
        HttpResponse.json(
          jobFixture({ runs: [manualRun(), manualRun({ id: ids.otherJob, displayId: 'RN-2026-000002', usages: [] })] }),
        ),
      ),
      noUnassignedRuns,
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await runAction(user, 'RN-2026-000002', 'Delete run');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete run' })).toBeEnabled();
  });

  it('explains the last run and offers Delete job instead only with machine_jobs.delete', async () => {
    server.use(
      as(...editor, PermissionId.machine_jobsdelete),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      orderAssociation(null),
      noUnassignedRuns,
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await runAction(user, 'RN-2026-000001', 'Delete run');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('This is the last run of its job')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete run' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete job instead' }));
    expect(await screen.findByText('Delete this job?')).toBeInTheDocument();
  });

  it('shows no Delete job instead without machine_jobs.delete', async () => {
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      noUnassignedRuns,
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await runAction(user, 'RN-2026-000001', 'Delete run');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('This is the last run of its job')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Delete job instead' })).not.toBeInTheDocument();
  });

  it('treats a last_run answer from the server like the last run', async () => {
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () =>
        HttpResponse.json(
          jobFixture({ runs: [manualRun(), manualRun({ id: ids.otherJob, displayId: 'RN-2026-000002', usages: [] })] }),
        ),
      ),
      noUnassignedRuns,
      http.delete(`*/api/v1/machine-runs/${ids.otherJob}`, () =>
        HttpResponse.json({ code: 'last_run', message: 'last run' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await runAction(user, 'RN-2026-000002', 'Delete run');
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete run' }));
    expect(await within(dialog).findByText('This is the last run of its job')).toBeInTheDocument();
  });

  it('shows Delete job only with machine_jobs.delete', async () => {
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      noUnassignedRuns,
    );
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await screen.findByRole('table', { name: 'Runs' }, { timeout: 5000 });
    expect(document.querySelector('.page-header__actions .cds--overflow-menu')).toBeNull();
    expect(screen.queryByText('Delete job')).not.toBeInTheDocument();
  });

  describe('delete job dialog', () => {
    const deleter = [...editor, PermissionId.machine_jobsdelete, PermissionId.ordersread] as const;
    const recorded = () =>
      recordedRun({
        job: { id: jobId, displayId: 'J-2026-000001', title: 'Gearbox housing' },
        usagesFromMachine: true,
        usages: [usage({ id: ids.otherJob, quantity: '40.000', spoolDisplayId: 'SP-0002' })],
      });
    const jobWithBoth = () => jobFixture({ runs: [manualRun(), recorded()] });

    it('requires the consumption choice, deletes recorded runs by default and sends the payload', async () => {
      let body: unknown;
      server.use(
        as(...deleter),
        http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobWithBoth())),
        orderAssociation(null),
        noUnassignedRuns,
        http.delete(`*/api/v1/machine-jobs/${jobId}`, async ({ request }) => {
          body = await request.json();
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const user = userEvent.setup();
      renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
      await screen.findByRole('table', { name: 'Runs' }, { timeout: 5000 });
      await user.click(overflowButton());
      await user.click(await screen.findByText('Delete job'));
      const dialog = await screen.findByRole('alertdialog');
      const confirm = within(dialog).getByRole('button', { name: 'Delete job' });
      const checkbox = within(dialog).getByRole('checkbox', { name: /Also delete recorded runs \(RN-2026-000007\)/ });
      expect(checkbox).toBeChecked();
      expect(confirm).toBeDisabled();
      await user.click(within(dialog).getByRole('radio', { name: /Reverse consumption/ }));
      await user.click(confirm);
      await waitFor(() =>
        expect(body).toEqual({ expectedVersion: 3, reverseConsumption: true, deleteRecordedRuns: true }),
      );
      expect(await screen.findByText('Job deleted')).toBeInTheDocument();
    });

    it('detaches recorded runs when the checkbox is cleared and then needs no choice for their material', async () => {
      let body: unknown;
      server.use(
        as(...deleter),
        http.get(`*/api/v1/machine-jobs/${jobId}`, () =>
          HttpResponse.json(jobFixture({ runs: [manualRun({ usages: [] }), recorded()] })),
        ),
        orderAssociation(null),
        noUnassignedRuns,
        http.delete(`*/api/v1/machine-jobs/${jobId}`, async ({ request }) => {
          body = await request.json();
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const user = userEvent.setup();
      renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
      await screen.findByRole('table', { name: 'Runs' }, { timeout: 5000 });
      await user.click(overflowButton());
      await user.click(await screen.findByText('Delete job'));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('checkbox', { name: /Also delete recorded runs/ }));
      expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Delete job' }));
      await waitFor(() =>
        expect(body).toEqual({ expectedVersion: 3, reverseConsumption: false, deleteRecordedRuns: false }),
      );
    });

    it('blocks the delete and links the order when the job is on an order', async () => {
      server.use(
        as(...deleter),
        http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
        orderAssociation('0192f6f8-743e-7c77-a349-cd07c3e8a999'),
        noUnassignedRuns,
      );
      const user = userEvent.setup();
      renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
      await screen.findByRole('table', { name: 'Runs' }, { timeout: 5000 });
      await user.click(overflowButton());
      await user.click(await screen.findByText('Delete job'));
      const dialog = await screen.findByRole('alertdialog');
      expect(await within(dialog).findByText('This job is on an order')).toBeInTheDocument();
      expect(within(dialog).getByRole('link', { name: /O-2026-0004/ })).toHaveAttribute(
        'href',
        '/orders/0192f6f8-743e-7c77-a349-cd07c3e8a999',
      );
      expect(within(dialog).getByRole('button', { name: 'Delete job' })).toBeDisabled();
    });

    it('shows the job-on-order notification when the server answers 409 job_on_order', async () => {
      server.use(
        as(...editor, PermissionId.machine_jobsdelete),
        http.get(`*/api/v1/machine-jobs/${jobId}`, () =>
          HttpResponse.json(jobFixture({ runs: [manualRun({ usages: [] })] })),
        ),
        noUnassignedRuns,
        http.delete(`*/api/v1/machine-jobs/${jobId}`, () =>
          HttpResponse.json({ code: 'job_on_order', message: 'on order' }, { status: 409 }),
        ),
      );
      const user = userEvent.setup();
      renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
      await screen.findByRole('table', { name: 'Runs' }, { timeout: 5000 });
      await user.click(overflowButton());
      await user.click(await screen.findByText('Delete job'));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete job' }));
      expect(await within(dialog).findByText('This job is on an order')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Delete job' })).toBeDisabled();
    });
  });

  it('offers deleting a recorded run with machine_jobs.delete and warns about a running one', async () => {
    let body: unknown;
    const running = recordedRun({
      job: { id: jobId, displayId: 'J-2026-000001', title: 'Gearbox housing' },
      state: 'running',
      endedAt: null,
      usages: [],
      startedAt: iso(-30),
      estimatedEndAt: iso(30),
    });
    server.use(
      as(...editor, PermissionId.machine_jobsdelete),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture({ runs: [manualRun(), running] }))),
      noUnassignedRuns,
      http.delete(`*/api/v1/machine-runs/${recordedRunId}`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await runAction(user, 'RN-2026-000007', 'Delete run');
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText('Further printer reports for this run are ignored after it is deleted.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete run' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: running.version, reverseConsumption: false }));
  });

  it('offers only the outcome for a recorded run and start, runtime and outcome for a manual one', async () => {
    const updates: UpdateMachineRunRequest[] = [];
    const recorded = recordedRun({
      job: { id: jobId, displayId: 'J-2026-000001', title: 'Gearbox housing' },
      usagesFromMachine: true,
      version: 7,
    });
    const job = jobFixture({ runs: [manualRun(), recorded] });
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(job)),
      noUnassignedRuns,
      http.patch('*/api/v1/machine-runs/:runId', async ({ request }) => {
        updates.push((await request.json()) as UpdateMachineRunRequest);
        return HttpResponse.json({ run: recorded, job });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await runAction(user, 'RN-2026-000001', 'Edit run');
    let dialog = await screen.findByRole('dialog', { name: 'Edit run' });
    expect(within(dialog).getByLabelText('Start date')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Hours')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await runAction(user, 'RN-2026-000007', 'Edit run');
    dialog = await screen.findByRole('dialog', { name: 'Edit run' });
    expect(within(dialog).queryByLabelText('Start date')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Hours')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Reported by the machine/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Outcome'), 'partial_failure');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updates).toEqual([{ outcome: 'partial_failure', expectedVersion: 7 }]));
  });

  it('replaces the material usage of one run', async () => {
    let body: { usages: unknown[]; expectedVersion: number } | undefined;
    server.use(
      as(...editor, PermissionId.inventoryread),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      noUnassignedRuns,
      http.get('*/api/v1/materials', () =>
        HttpResponse.json({
          items: [material],
          page: 1,
          pageSize: 100,
          total: 1,
          totalInventoryValue: material.inventoryValue,
        }),
      ),
      http.get('*/api/v1/filament-spools', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
      http.put(`*/api/v1/machine-runs/${manualRunId}/usages`, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json({ run: manualRun(), job: jobFixture() });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await runAction(user, 'RN-2026-000001', 'Edit material usage');
    const dialog = await screen.findByRole('dialog', { name: 'Edit material usage' });
    const quantity = await within(dialog).findByLabelText('Quantity (g)');
    await user.clear(quantity);
    await user.type(quantity, '200');
    await user.click(within(dialog).getByRole('button', { name: 'Save usage' }));
    await waitFor(() =>
      expect(body).toMatchObject({
        expectedVersion: 2,
        usages: [{ ownership: 'makerspace', materialId, quantity: '200' }],
      }),
    );
  });

  it('edits the outcome override of the job', async () => {
    let updated: { outcomeOverride: string | null; machineId: string; expectedVersion: number } | undefined;
    server.use(
      as(...editor, PermissionId.machinesread),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      noUnassignedRuns,
      http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machine], page: 1, pageSize: 100, total: 1 })),
      http.patch(`*/api/v1/machine-jobs/${jobId}`, async ({ request }) => {
        updated = (await request.json()) as typeof updated;
        return HttpResponse.json(jobFixture({ outcome: 'failed', outcomeOverridden: true }));
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit job' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit job' });
    const override = within(dialog).getByLabelText('Outcome override');
    expect(override).toHaveValue('');
    expect(within(dialog).getByText('Derived from the runs: Successful.')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Hours')).not.toBeInTheDocument();
    await user.selectOptions(override, 'failed');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updated).toMatchObject({ outcomeOverride: 'failed', machineId, expectedVersion: 3 }));
  });

  it('adjusts the price with the override permission and shows calculated, adjustment and final', async () => {
    let adjusted: SetMachineJobPriceAdjustmentRequest | undefined;
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobsoverride_price, PermissionId.ordersread),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      orderAssociation(),
      http.put(`*/api/v1/machine-jobs/${jobId}/price-adjustment`, async ({ request }) => {
        adjusted = (await request.json()) as SetMachineJobPriceAdjustmentRequest;
        return HttpResponse.json(
          jobFixture({
            effectivePrice: '10.00',
            priceAdjustment: {
              kind: 'discount_percent',
              value: '20.0000',
              reason: 'Member discount',
              adjustedAt: '2026-09-16T10:00:00Z',
            },
          }),
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByText('Not on an order.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit job' })).not.toBeInTheDocument();
    await user.click(overflowButton());
    await user.click(await screen.findByText('Adjust price'));
    const dialog = await screen.findByRole('dialog');
    const discount = within(dialog).getByRole('textbox', { name: 'Discount (%)' });
    await user.type(discount, '12,');
    expect(discount).toHaveValue('12,');
    await user.type(discount, '5');
    expect(discount).toHaveValue('12,5');
    await user.type(within(dialog).getByLabelText('Reason'), 'Member discount');
    await user.click(within(dialog).getByRole('button', { name: 'Save adjustment' }));
    await waitFor(() =>
      expect(adjusted).toEqual({
        kind: 'discount_percent',
        value: '12.5',
        reason: 'Member discount',
        expectedVersion: 3,
      }),
    );
    expect(await screen.findByText('Price adjusted')).toBeInTheDocument();
  });

  it('shows calculated, adjustment and final price and lets the adjustment be removed', async () => {
    let cleared: VersionRequest | undefined;
    const adjusted = jobFixture({
      effectivePrice: '10.00',
      priceAdjustment: {
        kind: 'discount_percent',
        value: '20.0000',
        reason: 'Member discount',
        adjustedAt: '2026-09-16T10:00:00Z',
      },
    });
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobsoverride_price),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(adjusted)),
      http.delete(`*/api/v1/machine-jobs/${jobId}/price-adjustment`, async ({ request }) => {
        cleared = (await request.json()) as VersionRequest;
        return HttpResponse.json(jobFixture());
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByText('Discount 20 %')).toBeInTheDocument();
    expect(screen.getByText('−€2.50')).toBeInTheDocument();
    expect(screen.getByText('Member discount')).toBeInTheDocument();
    await user.click(overflowButton());
    await user.click(await screen.findByText('Remove price adjustment'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove adjustment' }));
    await waitFor(() => expect(cleared).toEqual({ expectedVersion: 3 }));
  });

  it('offers no price adjustment without the override permission', async () => {
    server.use(
      as(...editor),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      noUnassignedRuns,
    );
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByRole('heading', { name: 'Gearbox housing' }, { timeout: 5000 })).toBeInTheDocument();
    expect(overflowButton()).toBeFalsy();
  });

  it('says so when the job does not exist', async () => {
    server.use(
      as(PermissionId.machine_jobsread),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () =>
        HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 }),
      ),
    );
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByText('This job does not exist')).toBeInTheDocument();
  });

  describe('recalculating and refreshing the charge', () => {
    const incomplete = () => jobFixture({ pricingStatus: 'incomplete', calculatedPrice: null, effectivePrice: null });
    const orderId = '0192f6f8-743e-7c77-a349-cd07c3e8a999';
    const itemId = '0192f6f8-743e-7c77-a349-cd07c3e8a998';
    const charged = (sourceChanged: boolean) =>
      http.get(`*/api/v1/machine-jobs/${jobId}/order-association`, () =>
        HttpResponse.json({ orderId, orderReference: 'O-2026-0004', orderItemId: itemId, sourceChanged }),
      );
    const order = http.get(`*/api/v1/orders/${orderId}`, () => HttpResponse.json({ id: orderId, version: 7 }));

    it('recalculates an incomplete job from the notification and shows the new price', async () => {
      let repriced: VersionRequest | undefined;
      let current = incomplete();
      server.use(
        as(...editor),
        http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(current)),
        noUnassignedRuns,
        http.post(`*/api/v1/machine-jobs/${jobId}/reprice`, async ({ request }) => {
          repriced = (await request.json()) as VersionRequest;
          current = jobFixture({ calculatedPrice: '42.00', effectivePrice: '42.00' });
          return HttpResponse.json(current);
        }),
      );
      const user = userEvent.setup();
      renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
      expect((await screen.findAllByText('Price incomplete', {}, { timeout: 5000 })).length).toBeGreaterThan(0);
      await user.click(screen.getAllByRole('button', { name: 'Recalculate price' })[0]);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Partner')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Recalculate price' }));
      await waitFor(() => expect(repriced).toEqual({ expectedVersion: 3 }));
      expect(await screen.findByText('Price recalculated')).toBeInTheDocument();
      expect((await screen.findAllByText('€42.00')).length).toBeGreaterThan(0);
    });

    it('hides the recalculation without the edit permission', async () => {
      server.use(
        as(PermissionId.machine_jobsread),
        http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(incomplete())),
      );
      renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
      expect((await screen.findAllByText('Price incomplete', {}, { timeout: 5000 })).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: 'Recalculate price' })).not.toBeInTheDocument();
    });

    it('refreshes the order charge of a changed job', async () => {
      let command: unknown;
      server.use(
        as(...editor, PermissionId.ordersread, PermissionId.orderswrite),
        http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
        noUnassignedRuns,
        charged(true),
        order,
        http.post(`*/api/v1/orders/${orderId}/items/${itemId}/refresh`, async ({ request }) => {
          command = await request.json();
          return HttpResponse.json({ id: orderId, version: 8 });
        }),
      );
      const user = userEvent.setup();
      renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
      const button = await screen.findByRole('button', { name: 'Refresh order charge' }, { timeout: 5000 });
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);
      await waitFor(() => expect(command).toMatchObject({ expectedVersion: 7, operationKey: expect.any(String) }));
      expect(await screen.findByText('Order charge refreshed')).toBeInTheDocument();
    });

    it('shows the backend message and keeps the charge when the order cannot be edited', async () => {
      server.use(
        as(...editor, PermissionId.ordersread, PermissionId.orderswrite),
        http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
        noUnassignedRuns,
        charged(true),
        order,
        http.post(`*/api/v1/orders/${orderId}/items/${itemId}/refresh`, () =>
          HttpResponse.json(
            { code: 'order_not_editable', message: 'The order is no longer a draft.' },
            { status: 422 },
          ),
        ),
      );
      const user = userEvent.setup();
      renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
      const button = await screen.findByRole('button', { name: 'Refresh order charge' }, { timeout: 5000 });
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);
      expect(await screen.findByText(/The order is no longer a draft\./)).toBeInTheDocument();
      expect(screen.getAllByText(/the charge keeps its price/).length).toBeGreaterThan(0);
    });

    it('offers no charge refresh when the job is unchanged or the permission is missing', async () => {
      server.use(
        as(...editor, PermissionId.ordersread),
        http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
        noUnassignedRuns,
        charged(true),
      );
      const { unmount } = renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
      expect(await screen.findByText('Changed after charge', {}, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Refresh order charge' })).not.toBeInTheDocument();
      unmount();
      server.use(as(...editor, PermissionId.ordersread, PermissionId.orderswrite), charged(false));
      renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
      expect((await screen.findAllByText('O-2026-0004', {}, { timeout: 5000 })).length).toBeGreaterThan(0);
      expect(screen.queryByText('Changed after charge')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Refresh order charge' })).not.toBeInTheDocument();
    });
  });
});
