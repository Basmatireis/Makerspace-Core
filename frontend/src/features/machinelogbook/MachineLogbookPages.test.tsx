import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmMachineJobRequest, CreateMachineJobRequest, CreateMaterialRequest, MachineJob, MarkMaterialEmptyRequest, Material } from '../../api/generated/models';
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
const secondMaterialId = '0192f6f8-743e-7c77-a349-cd07c3e8a913';
const jobId = '0192f6f8-743e-7c77-a349-cd07c3e8a914';
const organizationId = '0192f6f8-743e-7c77-a349-cd07c3e8a915';
const operatorId = '0192f6f8-743e-7c77-a349-cd07c3e8a916';

const machine = {
  id: machineId,
  machineType: { id: machineTypeId, name: '3D printer', active: true, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
  name: 'Bambu H2D #1',
  status: 'active' as const,
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

function jobFixture(overrides: Partial<MachineJob> = {}): MachineJob {
  return {
    id: jobId,
    displayId: 'J-2026-000001',
    machine,
    startsAt: '2026-09-15T08:12:00Z',
    endsAt: '2026-09-15T11:26:00Z',
    durationSeconds: 11640,
    source: 'automatic',
    externalId: 'BH2D-00441',
    reviewState: 'needs_review',
    customer: null,
    operator: null,
    outcome: 'unknown',
    notes: null,
    usages: [
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a917', materialId, materialName: 'PLA Black', category: 'pla', unit: 'g', quantity: '183' },
      { id: '0192f6f8-743e-7c77-a349-cd07c3e8a918', materialId: secondMaterialId, materialName: 'Support White', category: 'pla', unit: 'g', quantity: '12' },
    ],
    pricingStatus: 'pending',
    pricingSnapshot: null,
    calculatedPrice: null,
    finalPrice: null,
    effectivePrice: null,
    priceOverrideReason: null,
    priceOverriddenAt: null,
    billingStatus: 'unbilled',
    billingReference: null,
    version: 1,
    createdAt: '2026-09-15T11:26:00Z',
    updatedAt: '2026-09-15T11:26:00Z',
    ...overrides,
  };
}

const material: Material = {
  id: materialId,
  name: 'PLA Black',
  category: 'pla',
  color: 'Black',
  unit: 'g',
  active: true,
  lowStockThreshold: '500',
  quantity: '8420',
  averageUnitCost: '0.018',
  inventoryValue: '151.56',
  stockState: 'in_stock',
  inventoryVersion: 7,
  recentConsumption: '2140',
  version: 2,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-09-15T11:26:00Z',
};

describe('Machine Logbook pages', () => {
  it('renders multiple usages, review state, and URL-backed job filters', async () => {
    const requestedOutcomes: Array<string | null> = [];
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.machine_jobsread]))),
      http.get('*/api/v1/machine-jobs', ({ request }) => {
        requestedOutcomes.push(new URL(request.url).searchParams.get('outcome'));
        return HttpResponse.json({ items: [jobFixture()], page: 1, pageSize: 25, total: 1 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/machine-logbook/jobs');

    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByText('183 g PLA Black, 12 g Support White')).toBeInTheDocument();
    expect(screen.getAllByText('Needs review').some((element) => element.closest('.cds--tag'))).toBe(true);
    expect(screen.getByRole('link', { name: 'Jobs' })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Outcome'), 'failed');
    await waitFor(() => expect(requestedOutcomes).toContain('failed'));
  });

  it('validates review assignments and confirms the current job before advancing', async () => {
    let submitted: ConfirmMachineJobRequest | undefined;
    let queueReads = 0;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.machine_jobsreview]))),
      http.get('*/api/v1/machine-jobs/review-queue', () => {
        queueReads += 1;
        return HttpResponse.json({ items: queueReads === 1 ? [jobFixture()] : [] });
      }),
      http.get('*/api/v1/billing-parties', () => HttpResponse.json({ items: [{ kind: 'organization', id: organizationId, displayName: 'TU Berlin', organizationKind: 'institute', pricingGroup: null, pricingGroupAssignmentVersion: 0 }] })),
      http.get('*/api/v1/machine-job-operators', () => HttpResponse.json({ items: [{ personId: operatorId, displayName: 'Maria Hoffmann' }] })),
      http.post('*/api/v1/machine-jobs/:jobId/confirm', async ({ request }) => {
        submitted = await request.json() as ConfirmMachineJobRequest;
        return HttpResponse.json(jobFixture({ reviewState: 'confirmed', outcome: submitted.outcome, customer: { kind: 'organization', id: organizationId, displayName: 'TU Berlin', organizationKind: 'institute', pricingGroup: null, pricingGroupAssignmentVersion: 0 }, operator: { personId: operatorId, displayName: 'Maria Hoffmann' }, version: 3 }));
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/machine-logbook/review');

    expect(await screen.findByRole('heading', { name: 'Review queue' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm job' }));
    expect(await screen.findByText('Select a customer to confirm')).toBeInTheDocument();
    expect(screen.getByText('Select an enabled operator to confirm')).toBeInTheDocument();

    const customerInput = screen.getByPlaceholderText('Search people or organizations…');
    await user.click(customerInput);
    await user.click(await screen.findByText('TU Berlin'));
    const operatorInput = screen.getByPlaceholderText('Search users…');
    await user.click(operatorInput);
    await user.click(await screen.findByText('Maria Hoffmann'));
    await user.click(screen.getByRole('button', { name: 'Confirm job' }));

    await waitFor(() => expect(submitted).toMatchObject({
      expectedVersion: 1,
      customer: { kind: 'organization', id: organizationId },
      operatorPersonId: operatorId,
      outcome: 'successful',
    }));
    expect(await screen.findByText('Review queue is clear')).toBeInTheDocument();
  });

  it('recovers visibly when review confirmation is stale', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.machine_jobsreview]))),
      http.get('*/api/v1/machine-jobs/review-queue', () => HttpResponse.json({ items: [jobFixture()] })),
      http.get('*/api/v1/billing-parties', () => HttpResponse.json({ items: [{ kind: 'organization', id: organizationId, displayName: 'TU Berlin', organizationKind: 'institute', pricingGroup: null, pricingGroupAssignmentVersion: 0 }] })),
      http.get('*/api/v1/machine-job-operators', () => HttpResponse.json({ items: [{ personId: operatorId, displayName: 'Maria Hoffmann' }] })),
      http.post('*/api/v1/machine-jobs/:jobId/confirm', () => HttpResponse.json({ code: 'stale_write', message: 'Reload and retry.' }, { status: 409 })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/machine-logbook/review');
    await screen.findByRole('heading', { name: 'Review queue' });
    await user.click(screen.getByPlaceholderText('Search people or organizations…'));
    await user.click(await screen.findByText('TU Berlin'));
    await user.click(screen.getByPlaceholderText('Search users…'));
    await user.click(await screen.findByText('Maria Hoffmann'));
    await user.click(screen.getByRole('button', { name: 'Confirm job' }));
    expect(await screen.findByText('Job was not confirmed')).toBeInTheDocument();
    expect(screen.getByText(/job changed.*latest queue has been loaded/i)).toBeInTheDocument();
  });

  it('requires an explicit destructive confirmation and sends the latest inventory version', async () => {
    let submitted: MarkMaterialEmptyRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.inventoryread, PermissionId.inventorymanage]))),
      http.get(`*/api/v1/materials/${materialId}`, () => HttpResponse.json(material)),
      http.get(`*/api/v1/materials/${materialId}/transactions`, () => HttpResponse.json({ items: [], page: 1, pageSize: 25, total: 0 })),
      http.post(`*/api/v1/materials/${materialId}/mark-empty`, async ({ request }) => {
        submitted = await request.json() as MarkMaterialEmptyRequest;
        return HttpResponse.json({
          material: { ...material, quantity: '0', inventoryValue: '0', stockState: 'empty', inventoryVersion: 8 },
          transaction: { id: '0192f6f8-743e-7c77-a349-cd07c3e8a919', materialId, kind: 'adjustment', quantityDelta: '-8420', unitAcquisitionCost: '0.018', inventoryValueDelta: '-151.56', totalPurchasePrice: null, occurredAt: submitted.occurredAt, supplier: null, note: null, adjustmentReason: 'mark_empty', machineJobId: null, machineJobDisplayId: null, createdAt: submitted.occurredAt },
        });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/machine-logbook/inventory/${materialId}`);

    expect(await screen.findByRole('heading', { name: 'PLA Black' })).toBeInTheDocument();
    expect(submitted).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Mark as empty' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Mark material as empty')).toBeInTheDocument();
    expect(submitted).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Mark empty' }));
    await waitFor(() => expect(submitted).toMatchObject({ expectedInventoryVersion: 7 }));
  });

  it('creates a confirmed manual job with multiple catalog lookups', async () => {
    let submitted: CreateMachineJobRequest | undefined;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.machine_jobsread, PermissionId.machine_jobscreate]))),
      http.get('*/api/v1/machine-jobs', () => HttpResponse.json({ items: [], page: 1, pageSize: 25, total: 0 })),
      http.get('*/api/v1/machines', () => HttpResponse.json({ items: [machine], page: 1, pageSize: 100, total: 1 })),
      http.get('*/api/v1/materials', () => HttpResponse.json({ items: [material], page: 1, pageSize: 100, total: 1, totalInventoryValue: material.inventoryValue })),
      http.get('*/api/v1/pricing-groups', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/billing-parties', () => HttpResponse.json({ items: [{ kind: 'organization', id: organizationId, displayName: 'TU Berlin', organizationKind: 'institute', pricingGroup: null, pricingGroupAssignmentVersion: 0 }] })),
      http.get('*/api/v1/machine-job-operators', () => HttpResponse.json({ items: [{ personId: operatorId, displayName: 'Maria Hoffmann' }] })),
      http.post('*/api/v1/machine-jobs', async ({ request }) => {
        submitted = await request.json() as CreateMachineJobRequest;
        return HttpResponse.json(jobFixture({ reviewState: 'confirmed', source: 'manual' }), { status: 201 });
      }),
      http.get(`*/api/v1/machine-jobs/${jobId}`, () => HttpResponse.json(jobFixture({ reviewState: 'confirmed', source: 'manual' }))),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/machine-logbook/jobs');
    await screen.findByRole('heading', { name: 'Jobs' });
    await user.click(screen.getByRole('button', { name: 'New job' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Machine'), machineId);
    await user.click(within(dialog).getByPlaceholderText('Search people or organizations…'));
    await user.click(await screen.findByText('TU Berlin'));
    await user.click(within(dialog).getByPlaceholderText('Search enabled users…'));
    await user.click(await screen.findByText('Maria Hoffmann'));
    await user.selectOptions(within(dialog).getByLabelText('Material'), materialId);
    await user.type(within(dialog).getByLabelText('Quantity'), '25');
    await user.click(within(dialog).getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(submitted).toMatchObject({
      machineId,
      customer: { kind: 'organization', id: organizationId },
      operatorPersonId: operatorId,
      outcome: 'successful',
      usages: [{ materialId, quantity: '25' }],
    }));
    expect(await screen.findByRole('heading', { name: 'J-2026-000001' })).toBeInTheDocument();
  });

  it('creates a material and navigates to its empty ledger', async () => {
    let submitted: CreateMaterialRequest | undefined;
    const created = { ...material, quantity: '0', averageUnitCost: '0', inventoryValue: '0', stockState: 'empty' as const, inventoryVersion: 0 };
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.inventoryread, PermissionId.inventorymanage]))),
      http.get('*/api/v1/materials', () => HttpResponse.json({ items: [], page: 1, pageSize: 25, total: 0, totalInventoryValue: '0' })),
      http.post('*/api/v1/materials', async ({ request }) => {
        submitted = await request.json() as CreateMaterialRequest;
        return HttpResponse.json(created, { status: 201 });
      }),
      http.get(`*/api/v1/materials/${materialId}`, () => HttpResponse.json(created)),
      http.get(`*/api/v1/materials/${materialId}/transactions`, () => HttpResponse.json({ items: [], page: 1, pageSize: 25, total: 0 })),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/machine-logbook/inventory');
    await screen.findByRole('heading', { name: 'Inventory' });
    await user.click(screen.getByRole('button', { name: 'Add material' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'PLA Black');
    await user.type(within(dialog).getByLabelText('Normalized category'), 'PLA');
    await user.type(within(dialog).getByLabelText('Color (optional)'), 'Black');
    await user.type(within(dialog).getByLabelText('Low-stock threshold (optional)'), '500');
    await user.click(within(dialog).getByRole('button', { name: 'Add material' }));
    await waitFor(() => expect(submitted).toEqual({ name: 'PLA Black', category: 'pla', color: 'Black', unit: 'g', lowStockThreshold: '500' }));
    expect(await screen.findByRole('heading', { name: 'PLA Black' })).toBeInTheDocument();
  });

  it('submits optimistic organization and pricing-rule edits', async () => {
    let organizationUpdate: Record<string, unknown> | undefined;
    let ruleUpdate: Record<string, unknown> | undefined;
    const organization = { id: organizationId, name: 'TU Berlin', kind: 'institute' as const, active: true, pricingGroup: { id: '0192f6f8-743e-7c77-a349-cd07c3e8a930', name: 'Partner' }, pricingGroupAssignmentVersion: 1, version: 4, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
    const rule = { id: '0192f6f8-743e-7c77-a349-cd07c3e8a931', pricingGroupId: organization.pricingGroup.id, kind: 'machine_runtime' as const, machineTypeId, materialCategory: null, materialUnit: null, rate: '0.5', active: true, version: 3 };
    const group = { id: organization.pricingGroup.id, name: 'Partner', description: null, active: true, isDefault: false, rules: [rule], version: 2, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.organizationsread, PermissionId.organizationsmanage, PermissionId.pricingread, PermissionId.pricingmanage, PermissionId.machinesread]))),
      http.get('*/api/v1/organizations', () => HttpResponse.json({ items: [organization], page: 1, pageSize: 100, total: 1 })),
      http.get('*/api/v1/pricing-groups', () => HttpResponse.json({ items: [group] })),
      http.get('*/api/v1/machine-types', () => HttpResponse.json({ items: [machine.machineType] })),
      http.patch(`*/api/v1/organizations/${organizationId}`, async ({ request }) => {
        organizationUpdate = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ...organization, ...organizationUpdate, version: 5 });
      }),
      http.patch(`*/api/v1/pricing-rules/${rule.id}`, async ({ request }) => {
        ruleUpdate = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ...rule, ...ruleUpdate, version: 4 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/machine-logbook');
    expect(await screen.findByRole('heading', { name: 'Machine logbook configuration' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    let dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'TU Berlin Makerspace');
    await user.click(within(dialog).getByRole('button', { name: 'Save organization' }));
    await waitFor(() => expect(organizationUpdate).toMatchObject({ expectedVersion: 4, name: 'TU Berlin Makerspace', kind: 'institute', active: true }));

    await user.click(screen.getByRole('tab', { name: 'Pricing groups' }));
    await user.click(await screen.findByRole('button', { name: 'Edit rule for Partner' }));
    dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Rate (€ per hour)'));
    await user.type(within(dialog).getByLabelText('Rate (€ per hour)'), '0.75');
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(ruleUpdate).toMatchObject({ expectedVersion: 3, kind: 'machine_runtime', machineTypeId, rate: '0.75', active: true }));
  });

  it('does not expose the overview to an inventory-only reader', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.inventoryread]))),
      http.get('*/api/v1/materials', () => HttpResponse.json({ items: [], page: 1, pageSize: 25, total: 0, totalInventoryValue: '0' })),
    );
    renderRoute(<App />, '/machine-logbook');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inventory' })).toBeInTheDocument();
  });
});
