import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CreateMachineJobRequest, Machine, MachineJob, Material, SetMachineJobPriceAdjustmentRequest, UpdateMachineJobRequest, VersionRequest, WorkItem } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

const machineTypeId = '0192f6f8-743e-7c77-a349-cd07c3e8a910';
const machineId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const materialId = '0192f6f8-743e-7c77-a349-cd07c3e8a912';
const jobId = '0192f6f8-743e-7c77-a349-cd07c3e8a914';
const organizationId = '0192f6f8-743e-7c77-a349-cd07c3e8a915';
const operatorId = '0192f6f8-743e-7c77-a349-cd07c3e8a916';
const printId = '0192f6f8-743e-7c77-a349-cd07c3e8a917';

const machine: Machine = {
  id: machineId,
  machineType: { id: machineTypeId, name: '3D printer', active: true, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
  name: 'Bambu H2D #1',
  status: 'active',
  externalIdentifier: 'BH2D-1',
  automaticCollectionEnabled: true,
  lastIngestedAt: '2026-09-15T11:26:00Z',
  jobCount: 42,
  runtimeSeconds: 84000,
  failureRate: '4.2',
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-15T11:26:00Z',
};

const material: Material = {
  id: materialId, name: 'PLA Black', category: 'pla', color: 'Black', unit: 'g', active: true, lowStockThreshold: '500', quantity: '8420', assignedQuantity: '0', unassignedQuantity: '8420',
  averageUnitCost: '0.018', inventoryValue: '151.56', stockState: 'in_stock', inventoryVersion: 7, recentConsumption: '2140', version: 2, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-15T11:26:00Z',
};

const customer = { kind: 'organization' as const, id: organizationId, displayName: 'TU Berlin', organizationKind: 'institute' as const, pricingGroup: { id: '0192f6f8-743e-7c77-a349-cd07c3e8a930', name: 'Partner' }, pricingGroupAssignmentVersion: 1 };
const operator = { personId: operatorId, displayName: 'Maria Hoffmann' };

const iso = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();

function jobFixture(overrides: Partial<MachineJob> = {}): MachineJob {
  return {
    id: jobId,
    displayId: 'J-2026-000001',
    title: 'Gearbox housing',
    machine,
    startsAt: iso(-120),
    endsAt: iso(-30),
    durationSeconds: 5400,
    source: 'manual',
    run: 'manual',
    externalId: null,
    print: null,
    reviewState: 'confirmed',
    customer,
    operator,
    outcome: 'successful',
    status: 'successful',
    notes: 'Print with 0.2 mm layers',
    usages: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8a918', ownership: 'makerspace', materialId, spoolId: null, spoolDisplayId: null, materialName: 'PLA Black', category: 'pla', unit: 'g', quantity: '183.000', quantityBasis: 'actual' }],
    pricingStatus: 'complete',
    pricingSnapshot: { id: '0192f6f8-743e-7c77-a349-cd07c3e8a931', revision: 1, pricingGroupName: 'Partner', currency: 'EUR', reason: 'created', complete: true, calculatedAmount: '12.50', rules: [{ kind: 'machine_runtime', label: '3D printer runtime', selector: '3D printer', unit: 'hour', rate: '5.00', missing: false }], capturedAt: '2026-09-15T11:26:00Z' },
    calculatedPrice: '12.50',
    priceAdjustment: null,
    effectivePrice: '12.50',
    version: 3,
    createdAt: '2026-09-15T11:26:00Z',
    updatedAt: '2026-09-15T11:26:00Z',
    ...overrides,
  } as MachineJob;
}

const runningJob = () => jobFixture({ startsAt: iso(-30), endsAt: iso(30), durationSeconds: 3600, outcome: 'unknown', status: 'running', calculatedPrice: null, effectivePrice: null, pricingStatus: 'pending', pricingSnapshot: null });

const jobItem: WorkItem = {
  kind: 'job', id: jobId, displayId: 'J-2026-000001', title: 'Gearbox housing', fileName: 'gearbox_housing_v3.gcode', printDisplayId: 'PR-2026-000007', machineId, machineName: machine.name,
  customer, operator, status: 'successful', run: 'printer', startedAt: '2026-09-15T08:12:00Z', endsAt: '2026-09-15T11:26:00Z', effectivePrice: '12.50', billing: { state: 'not_on_order' }, version: 3,
};
const printItem: WorkItem = {
  kind: 'print', id: printId, displayId: 'PR-2026-000008', title: null, fileName: 'bracket_v2.gcode', machineId, machineName: machine.name,
  customer: null, operator: null, status: 'unlinked', run: 'printer', startedAt: '2026-09-16T09:00:00Z', endsAt: '2026-09-16T10:00:00Z', effectivePrice: null,
};

const as = (...permissions: PermissionId[]) => http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions)));
const emptyPrints = http.get('*/api/v1/prints', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 }));
// Carbon's icon-only overflow trigger is named by an aria-hidden tooltip that jsdom does not resolve, so find it by class.
const overflowButton = () => document.querySelector<HTMLButtonElement>('.page-header__actions .cds--overflow-menu')!;
const orderAssociation = (orderId: string | null = null) => http.get(`*/api/v1/machine-jobs/${jobId}/order-association`, () => HttpResponse.json({ orderId, orderReference: orderId ? 'O-2026-0004' : null, sourceChanged: false }));

describe('Jobs page', () => {
  it('lists jobs and unlinked prints with statuses, links and URL filters', async () => {
    const requests: URL[] = [];
    server.use(
      as(PermissionId.machine_jobsread),
      http.get('*/api/v1/machine-logbook/work-items', ({ request }) => {
        requests.push(new URL(request.url));
        return HttpResponse.json({ items: [jobItem, printItem], page: 1, pageSize: 10, total: 2 });
      }),
    );
    renderRoute(<App />, '/machine-logbook/jobs?status=unlinked&q=bracket');
    const table = await screen.findByRole('table', { name: 'Jobs' }, { timeout: 5000 });
    expect(requests[0].searchParams.get('status')).toBe('unlinked');
    expect(requests[0].searchParams.get('search')).toBe('bracket');
    expect(requests[0].searchParams.get('sort')).toBe('startedAt');
    expect(requests[0].searchParams.get('direction')).toBe('desc');

    expect(within(table).getByRole('link', { name: 'Gearbox housing' })).toHaveAttribute('href', `/machine-logbook/jobs/${jobId}`);
    expect(within(table).getByText('J-2026-000001 · gearbox_housing_v3.gcode')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'bracket_v2.gcode' })).toHaveAttribute('href', `/machine-logbook/jobs/prints/${printId}`);
    expect(within(table).getByText('PR-2026-000008 · Unlinked')).toBeInTheDocument();
    expect(within(table).getByText('Successful')).toBeInTheDocument();
    expect(within(table).getByText('Unlinked print')).toBeInTheDocument();
    expect(within(table).getByText('€12.50')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New job' })).not.toBeInTheDocument();
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
    const { router } = renderRoute(<App />, '/machine-logbook/jobs?status=running,printing&run=manual&billing=on_order,order_outdated');
    const table = await screen.findByRole('table', { name: 'Jobs' }, { timeout: 5000 });
    expect(requests[0].searchParams.getAll('status')).toEqual(['running', 'printing']);
    expect(requests[0].searchParams.getAll('run')).toEqual(['manual']);
    expect(requests[0].searchParams.getAll('billing')).toEqual(['on_order', 'order_outdated']);

    await user.click(within(table).getByRole('button', { name: /Price/ }));
    await waitFor(() => expect(requests.at(-1)?.searchParams.get('sort')).toBe('price'));
    expect(requests.at(-1)?.searchParams.get('direction')).toBe('desc');
    // The page's own URL keeps the compact comma-separated form.
    expect(decodeURIComponent(router.state.location.search)).toContain('status=running,printing');
    expect(decodeURIComponent(router.state.location.search)).toContain('billing=on_order,order_outdated');
  });

  it('shows the empty state and offers New job only with machine_jobs.create', async () => {
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobscreate),
      http.get('*/api/v1/machine-logbook/work-items', () => HttpResponse.json({ items: [], page: 1, pageSize: 10, total: 0 })),
    );
    renderRoute(<App />, '/machine-logbook/jobs');
    expect(await screen.findByText('No jobs yet', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New job' }).length).toBeGreaterThan(0);
  });
});

describe('Job form', () => {
  function lookups() {
    return [
      as(PermissionId.machine_jobsread, PermissionId.machine_jobscreate, PermissionId.machinesread, PermissionId.inventoryread),
      http.get('*/api/v1/machine-logbook/work-items', () => HttpResponse.json({ items: [], page: 1, pageSize: 10, total: 0 })),
      http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machine], page: 1, pageSize: 100, total: 1 })),
      http.get('*/api/v1/materials', () => HttpResponse.json({ items: [material], page: 1, pageSize: 100, total: 1, totalInventoryValue: material.inventoryValue })),
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

  it('creates a manual job with customer, operator and material and opens it', async () => {
    let submitted: CreateMachineJobRequest | undefined;
    server.use(
      ...lookups(),
      http.post('*/api/v1/machine-jobs', async ({ request }) => {
        submitted = await request.json() as CreateMachineJobRequest;
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
    await user.click(within(dialog).getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(submitted).toMatchObject({
      machineId, title: 'Gearbox housing', customer: { kind: 'organization', id: organizationId }, operatorPersonId: operatorId, outcome: 'successful',
      usages: [{ ownership: 'makerspace', materialId, spoolId: null, quantity: '25', quantityBasis: 'actual' }],
    }));
    expect(submitted?.startsAt && submitted.endsAt && new Date(submitted.endsAt) > new Date(submitted.startsAt)).toBe(true);
    expect(await screen.findByRole('heading', { name: 'Gearbox housing' }, { timeout: 5000 })).toBeInTheDocument();
  });

  it('shows a server rejection of the outcome as an inline error', async () => {
    server.use(
      ...lookups(),
      http.post('*/api/v1/machine-jobs', () => HttpResponse.json({ code: 'outcome_before_run_end', message: 'An outcome cannot be recorded before the run has ended' }, { status: 422 })),
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
    expect(await within(dialog).findByText('The outcome can only be recorded once the run has ended.')).toBeInTheDocument();
  });
});

describe('Job detail page', () => {
  it('shows a running manual run and cancels it with the loaded version', async () => {
    let cancelled: VersionRequest | undefined;
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobsedit),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(runningJob())),
      emptyPrints,
      http.post(`*/api/v1/machine-jobs/${jobId}/run-cancellation`, async ({ request }) => {
        cancelled = await request.json() as VersionRequest;
        return HttpResponse.json(jobFixture({ outcome: 'cancelled', status: 'cancelled' }));
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByRole('heading', { name: 'Gearbox housing' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Running · manual')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Run progress' })).toBeInTheDocument();
    expect(screen.queryByText(jobId)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel run' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(cancelled).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(cancelled).toEqual({ expectedVersion: 3 }));
    expect(await screen.findByText('Run cancelled')).toBeInTheDocument();
  });

  it('hides edit actions from a reader and keeps the run read-only', async () => {
    server.use(
      as(PermissionId.machine_jobsread),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture({ outcome: 'unknown', status: 'needs_outcome', endsAt: iso(-10) }))),
    );
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByRole('heading', { name: 'Gearbox housing' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Outcome not recorded yet')).toBeInTheDocument();
    expect(screen.queryByText('Record the outcome')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit job' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More job actions' })).not.toBeInTheDocument();
    expect(screen.queryByText('Order')).not.toBeInTheDocument();
  });

  it('records the outcome of a finished run inline', async () => {
    let updated: UpdateMachineJobRequest | undefined;
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobsedit),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture({ outcome: 'unknown', status: 'needs_outcome', endsAt: iso(-10) }))),
      emptyPrints,
      http.patch(`*/api/v1/machine-jobs/${jobId}`, async ({ request }) => {
        updated = await request.json() as UpdateMachineJobRequest;
        return HttpResponse.json(jobFixture({ outcome: 'failed', status: 'failed' }));
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByText('Record the outcome')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save outcome' });
    expect(save).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Outcome'), 'failed');
    await user.click(save);
    await waitFor(() => expect(updated).toMatchObject({ outcome: 'failed', operatorPersonId: operatorId, machineId, expectedVersion: 3, customer: { kind: 'organization', id: organizationId } }));
    expect(await screen.findByText('Outcome recorded')).toBeInTheDocument();
  });

  it('adjusts the price with the override permission and shows calculated, adjustment and final', async () => {
    let adjusted: SetMachineJobPriceAdjustmentRequest | undefined;
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobsoverride_price, PermissionId.ordersread),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      orderAssociation(),
      http.put(`*/api/v1/machine-jobs/${jobId}/price-adjustment`, async ({ request }) => {
        adjusted = await request.json() as SetMachineJobPriceAdjustmentRequest;
        return HttpResponse.json(jobFixture({ effectivePrice: '10.00', priceAdjustment: { kind: 'discount_percent', value: '20.0000', reason: 'Member discount', adjustedAt: '2026-09-16T10:00:00Z' } }));
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByText('Not on an order.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit job' })).not.toBeInTheDocument();
    await user.click(overflowButton());
    await user.click(await screen.findByText('Adjust price'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('spinbutton'), '20');
    expect(within(dialog).getByText('€10.00')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Reason'), 'Member discount');
    await user.click(within(dialog).getByRole('button', { name: 'Save adjustment' }));
    await waitFor(() => expect(adjusted).toEqual({ kind: 'discount_percent', value: '20', reason: 'Member discount', expectedVersion: 3 }));
    expect(await screen.findByText('Price adjusted')).toBeInTheDocument();
  });

  it('shows calculated, adjustment and final price and lets the adjustment be removed', async () => {
    let cleared: VersionRequest | undefined;
    const adjusted = jobFixture({ effectivePrice: '10.00', priceAdjustment: { kind: 'discount_percent', value: '20.0000', reason: 'Member discount', adjustedAt: '2026-09-16T10:00:00Z' } });
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobsoverride_price),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(adjusted)),
      http.delete(`*/api/v1/machine-jobs/${jobId}/price-adjustment`, async ({ request }) => {
        cleared = await request.json() as VersionRequest;
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
      as(PermissionId.machine_jobsread, PermissionId.machine_jobsedit),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      emptyPrints,
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByRole('heading', { name: 'Gearbox housing' }, { timeout: 5000 })).toBeInTheDocument();
    await user.click(overflowButton());
    expect(await screen.findByText('Edit material usage')).toBeInTheDocument();
    expect(screen.queryByText('Adjust price')).not.toBeInTheDocument();
  });

  it('shows the printer data of an automatic run and unlinks it', async () => {
    let unlinked: { expectedJobVersion: number } | undefined;
    const linked = jobFixture({ run: 'automatic', source: 'automatic', print: { id: printId, displayId: 'PR-2026-000007', fileName: 'gearbox_housing_v3.gcode', state: 'finished', connectorName: 'Bambu LAN' } });
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobsedit),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(linked)),
      http.delete(`*/api/v1/prints/${printId}/job`, async ({ request }) => {
        unlinked = await request.json() as { expectedJobVersion: number };
        return HttpResponse.json(jobFixture());
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByRole('link', { name: 'PR-2026-000007' })).toHaveAttribute('href', `/machine-logbook/jobs/prints/${printId}`);
    expect(screen.getByText(/gearbox_housing_v3.gcode · via Bambu LAN/)).toBeInTheDocument();
    await user.click(overflowButton());
    await user.click(await screen.findByText('Unlink print'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(unlinked).toEqual({ expectedJobVersion: 3 }));
  });

  it('links an unlinked print on the job machine and shows the comparison', async () => {
    let linkedBody: Record<string, unknown> | undefined;
    const print = { id: printId, displayId: 'PR-2026-000008', machineId, machineName: machine.name, connectorName: 'Bambu LAN', fileName: 'bracket_v2.gcode', state: 'finished' as const, startedAt: iso(-120), endedAt: iso(-60), estimatedEndAt: null, progressPercent: 100, reportedUsage: null, job: null, version: 1 };
    server.use(
      as(PermissionId.machine_jobsread, PermissionId.machine_jobsedit),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture())),
      http.get('*/api/v1/prints', ({ request }) => {
        const params = new URL(request.url).searchParams;
        expect(params.get('machineId')).toBe(machineId);
        expect(params.get('linked')).toBe('false');
        return HttpResponse.json({ items: [print], page: 1, pageSize: 100, total: 1 });
      }),
      http.put(`*/api/v1/prints/${printId}/job`, async ({ request }) => {
        linkedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(jobFixture());
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    await user.click(await screen.findByRole('button', { name: 'Link printer data' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: /Print/ }));
    await user.click(await screen.findByText(/bracket_v2.gcode · PR-2026-000008/));
    expect(within(dialog).getByText('From printer')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Link and replace' }));
    await waitFor(() => expect(linkedBody).toEqual({ machineJobId: jobId, expectedJobVersion: 3 }));
  });

  it('says so when the job does not exist', async () => {
    server.use(
      as(PermissionId.machine_jobsread),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 })),
    );
    renderRoute(<App />, `/machine-logbook/jobs/${jobId}`);
    expect(await screen.findByText('This job does not exist')).toBeInTheDocument();
  });
});
