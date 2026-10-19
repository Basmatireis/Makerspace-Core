import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AddManualMachineRunRequest, MachineProcess, Material, MaterialType, ReplaceMachineRunUsagesRequest } from '../../api/generated/models';
import { ids, jobFixture, machine, manualRun } from '../../test/machineRuns';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { RunFormModal } from './dialogs/RunFormModal';
import { UsageFormModal } from './dialogs/UsageFormModal';
import { consumptionSummary, materialsForProcess, sumUsages } from './processConfig';
import { ToastProvider } from './shared/toasts';

vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: ['machine_jobs.edit', 'machines.read', 'inventory.read'] }) }));

const now = '2026-09-15T11:26:00Z';
const typeOf = (id: string, name: string, unit: MaterialType['unit'], processes: MachineProcess[], active = true): MaterialType => ({ id, name, unit, processes, active, materialCount: 1, pricingRuleCount: 0, version: 1, createdAt: now, updatedAt: now });
const materialOf = (id: string, name: string, materialTypeId: string, unit: Material['unit'], overrides: Partial<Material> = {}): Material => ({
  id, name, materialTypeId, materialTypeName: name, unit, active: true, quantity: '100', assignedQuantity: '0', unassignedQuantity: '100', averageUnitCost: '1', inventoryValue: '100', stockState: 'in_stock',
  inventoryVersion: 1, recentConsumption: '0', version: 1, createdAt: now, updatedAt: now, ...overrides,
});
const t = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e8e0${String(n).padStart(2, '0')}`;
const types = [
  typeOf(t(1), 'PLA', 'g', ['fdm_printing']), typeOf(t(2), 'Stabilizer', 'm', ['embroidery']), typeOf(t(3), 'UV ink', 'ml', ['uv_printing']),
  typeOf(t(4), 'DTF paper', 'cm2', ['uv_printing']), typeOf(t(5), 'Plywood', 'cm2', ['laser_cutting', 'other']),
];
const materials = [
  materialOf(t(11), 'PLA Black', t(1), 'g'), materialOf(t(12), 'Tear-away', t(2), 'm'),
  materialOf(t(13), 'Cyan', t(3), 'ml', { colorName: 'Cyan', colorHex: '#00AEEF' }), materialOf(t(14), 'Magenta', t(3), 'ml', { colorName: 'Magenta', colorHex: '#EC008C' }),
  materialOf(t(15), 'Old ink', t(3), 'ml', { active: false }), materialOf(t(16), 'DTF A4', t(4), 'cm2'), materialOf(t(17), 'Birch 4 mm', t(5), 'cm2'),
];

const lookups = [
  http.get('*/api/v1/materials', () => HttpResponse.json({ items: materials, page: 1, pageSize: 100, total: materials.length, totalInventoryValue: '0' })),
  http.get('*/api/v1/material-types', () => HttpResponse.json({ items: types })),
];

const jobOn = (process: MachineProcess) => jobFixture({ machine: { ...machine, machineType: { ...machine.machineType, process } } });

describe('material picker by process', () => {
  it('offers only active materials whose type includes the process, plus the one already chosen', () => {
    const embroidery = materialsForProcess(materials, types, 'embroidery').map((item) => item.name);
    expect(embroidery).toEqual(['Tear-away']);
    expect(materialsForProcess(materials, types, 'fdm_printing').map((item) => item.name)).toEqual(['PLA Black']);
    // An old usage keeps its material even when the type no longer fits or the material is inactive.
    expect(materialsForProcess(materials, types, 'embroidery', t(15)).map((item) => item.name)).toEqual(['Tear-away', 'Old ink']);
    // Without the type list or the process the backend decides.
    expect(materialsForProcess(materials, undefined, 'embroidery')).toHaveLength(materials.length - 1);
  });

  it('shows only matching materials in the run form and keeps a current non-matching one', async () => {
    server.use(...lookups);
    const user = userEvent.setup();
    renderRoute(<ToastProvider><RunFormModal open mode="add" job={jobOn('embroidery')} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog');
    const picker = await within(dialog).findByLabelText('Material');
    await waitFor(() => expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual(['Select a material', 'Tear-away (m)']));
    expect(user).toBeDefined();

    // Editing a run whose usage no longer matches still lists that material.
    const run = manualRun({ usages: [{ id: ids.usage, ownership: 'makerspace', materialId: t(11), spoolId: null, spoolDisplayId: null, materialName: 'PLA Black', materialTypeId: t(1), materialTypeName: 'PLA', unit: 'g', quantity: '10', quantityBasis: 'actual', staffCorrected: false }] });
    server.use(http.get(`*/api/v1/machines/${ids.machine}`, () => HttpResponse.json({ ...machine, machineType: { ...machine.machineType, process: 'embroidery' } })));
    renderRoute(<ToastProvider><UsageFormModal open run={run} onClose={() => undefined} /></ToastProvider>);
    const editDialog = await screen.findByRole('dialog', { name: 'Edit material usage' });
    const editPicker = await within(editDialog).findByLabelText('Material');
    expect(within(editPicker).getAllByRole('option').map((option) => option.textContent)).toEqual(expect.arrayContaining(['Tear-away (m)', 'PLA Black (g)']));
    expect(within(editPicker).getAllByRole('option').map((option) => option.textContent)).not.toContain('Cyan (ml)');
  });
});

describe('process driven run form', () => {
  it('sends the exact stitch count of an embroidery run with a stabilizer in metres', async () => {
    let body: AddManualMachineRunRequest | undefined;
    server.use(...lookups, http.post(`*/api/v1/machine-jobs/${ids.job}/runs`, async ({ request }) => { body = await request.json() as AddManualMachineRunRequest; return HttpResponse.json(jobOn('embroidery'), { status: 201 }); }));
    const user = userEvent.setup();
    renderRoute(<ToastProvider><RunFormModal open mode="add" job={jobOn('embroidery')} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Stitches'), '12400');
    await waitFor(() => expect(within(dialog).getByLabelText('Material')).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Material'), t(12));
    expect(within(dialog).getByLabelText('Quantity (m)')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Quantity (m)'), '0.4');
    expect(within(dialog).queryByLabelText(/Spool/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add run' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.run.measures).toEqual({ stitches: 12400 });
    expect(body?.run.usages).toEqual([expect.objectContaining({ materialId: t(12), quantity: '0.4', ownership: 'makerspace' })]);
  });

  it('does not offer stitches on other processes', async () => {
    server.use(...lookups);
    renderRoute(<ToastProvider><RunFormModal open mode="add" job={jobOn('fdm_printing')} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Stitches')).not.toBeInTheDocument();
    expect(await within(dialog).findByLabelText(/Spool/)).toBeInTheDocument();
  });

  it('shows one coloured ml row per active ink and sends them with two decimals', async () => {
    let body: AddManualMachineRunRequest | undefined;
    server.use(...lookups, http.post(`*/api/v1/machine-jobs/${ids.job}/runs`, async ({ request }) => { body = await request.json() as AddManualMachineRunRequest; return HttpResponse.json(jobOn('uv_printing'), { status: 201 }); }));
    const user = userEvent.setup();
    renderRoute(<ToastProvider><RunFormModal open mode="add" job={jobOn('uv_printing')} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog');
    const cyan = await within(dialog).findByLabelText('Cyan (ml)');
    expect(within(dialog).getByLabelText('Magenta (ml)')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Old ink/)).not.toBeInTheDocument(); // inactive
    expect(dialog.querySelectorAll('.mj-swatch')).toHaveLength(2);
    expect(cyan).toHaveAttribute('inputmode', 'decimal');
    await user.type(cyan, '0.4');
    // Substrates are added as rows; the picker offers them, not the ink.
    await user.click(within(dialog).getByRole('button', { name: 'Add material' }));
    const picker = within(dialog).getByLabelText('Material');
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual(['Select a material', 'DTF A4 (cm²)']);
    await user.selectOptions(picker, t(16));
    await user.type(within(dialog).getByLabelText('Quantity (cm²)'), '180');
    await user.click(within(dialog).getByRole('button', { name: 'Add run' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.run.usages).toEqual([
      expect.objectContaining({ materialId: t(16), quantity: '180' }),
      expect.objectContaining({ materialId: t(13), quantity: '0.40' }),
    ]);
    expect(body?.run.measures).toEqual({});
  });

  it('calculates cm² from width, height and count for cutting machines and keeps the result editable', async () => {
    let body: AddManualMachineRunRequest | undefined;
    server.use(...lookups, http.post(`*/api/v1/machine-jobs/${ids.job}/runs`, async ({ request }) => { body = await request.json() as AddManualMachineRunRequest; return HttpResponse.json(jobOn('laser_cutting'), { status: 201 }); }));
    const user = userEvent.setup();
    renderRoute(<ToastProvider><RunFormModal open mode="add" job={jobOn('laser_cutting')} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText('Material')).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Material'), t(17));
    fireEvent.change(await within(dialog).findByLabelText('Width (cm)'), { target: { value: '20' } });
    fireEvent.change(within(dialog).getByLabelText('Height (cm)'), { target: { value: '10' } });
    fireEvent.change(within(dialog).getByLabelText('Count'), { target: { value: '3' } });
    const quantity = within(dialog).getByLabelText('Quantity (cm²)');
    await waitFor(() => expect(quantity).toHaveValue('600'));
    await user.clear(quantity);
    await user.type(quantity, '575');
    await user.click(within(dialog).getByRole('button', { name: 'Add run' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.run.usages).toEqual([expect.objectContaining({ materialId: t(17), quantity: '575' })]);
  });

  it('puts existing ink usages into the ink rows when editing a run', async () => {
    let body: ReplaceMachineRunUsagesRequest | undefined;
    server.use(
      ...lookups,
      http.get(`*/api/v1/machines/${ids.machine}`, () => HttpResponse.json({ ...machine, machineType: { ...machine.machineType, process: 'uv_printing' } })),
      http.put(`*/api/v1/machine-runs/${ids.manualRun}/usages`, async ({ request }) => { body = await request.json() as ReplaceMachineRunUsagesRequest; return HttpResponse.json({ run: manualRun() }); }),
    );
    const user = userEvent.setup();
    const run = manualRun({ usages: [
      { id: ids.usage, ownership: 'makerspace', materialId: t(13), spoolId: null, spoolDisplayId: null, materialName: 'Cyan', materialTypeId: t(3), materialTypeName: 'UV ink', unit: 'ml', quantity: '3.200000', quantityBasis: 'actual', staffCorrected: false },
    ] });
    renderRoute(<ToastProvider><UsageFormModal open run={run} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog', { name: 'Edit material usage' });
    expect(await within(dialog).findByLabelText('Cyan (ml)')).toHaveValue('3.2');
    await user.click(within(dialog).getByRole('button', { name: 'Save usage' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.usages).toEqual([expect.objectContaining({ materialId: t(13), quantity: '3.20' })]);
  });
});

describe('decimal entry', () => {
  it('keeps what is typed in a usage quantity and sends the comma value as a decimal', async () => {
    let body: ReplaceMachineRunUsagesRequest | undefined;
    server.use(
      ...lookups,
      http.get(`*/api/v1/machines/${ids.machine}`, () => HttpResponse.json({ ...machine, machineType: { ...machine.machineType, process: 'fdm_printing' } })),
      http.put(`*/api/v1/machine-runs/${ids.manualRun}/usages`, async ({ request }) => { body = await request.json() as ReplaceMachineRunUsagesRequest; return HttpResponse.json({ run: manualRun() }); }),
    );
    const user = userEvent.setup();
    const run = manualRun({ usages: [
      { id: ids.usage, ownership: 'makerspace', materialId: t(11), spoolId: null, spoolDisplayId: null, materialName: 'PLA Black', materialTypeId: t(1), materialTypeName: 'PLA', unit: 'g', quantity: '10.000000', quantityBasis: 'actual', staffCorrected: false },
    ] });
    renderRoute(<ToastProvider><UsageFormModal open run={run} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog', { name: 'Edit material usage' });
    const quantity = await within(dialog).findByLabelText(/^Quantity/);
    await user.clear(quantity);
    await user.type(quantity, '12.');
    expect(quantity).toHaveValue('12.');
    await user.type(quantity, '5');
    expect(quantity).toHaveValue('12.5');
    await user.clear(quantity);
    await user.type(quantity, '1,');
    expect(quantity).toHaveValue('1,');
    await user.type(quantity, '5');
    expect(quantity).toHaveValue('1,5');
    await user.click(within(dialog).getByRole('button', { name: 'Save usage' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.usages).toEqual([expect.objectContaining({ materialId: t(11), quantity: '1.5' })]);
  });

  it('rejects thousands separators in a quantity', async () => {
    server.use(...lookups, http.get(`*/api/v1/machines/${ids.machine}`, () => HttpResponse.json({ ...machine, machineType: { ...machine.machineType, process: 'fdm_printing' } })));
    const user = userEvent.setup();
    const run = manualRun({ usages: [
      { id: ids.usage, ownership: 'makerspace', materialId: t(11), spoolId: null, spoolDisplayId: null, materialName: 'PLA Black', materialTypeId: t(1), materialTypeName: 'PLA', unit: 'g', quantity: '10', quantityBasis: 'actual', staffCorrected: false },
    ] });
    renderRoute(<ToastProvider><UsageFormModal open run={run} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog', { name: 'Edit material usage' });
    const quantity = await within(dialog).findByLabelText(/^Quantity/);
    await user.clear(quantity);
    await user.type(quantity, '1.234,5');
    await user.click(within(dialog).getByRole('button', { name: 'Save usage' }));
    expect(await within(dialog).findByText('Enter the number without thousands separators, e.g. 1234,5.')).toBeInTheDocument();
    expect(quantity).toHaveValue('1.234,5');
  });

  it('rejects decimals in the stitch count instead of clearing the field', async () => {
    server.use(...lookups);
    const user = userEvent.setup();
    renderRoute(<ToastProvider><RunFormModal open mode="add" job={jobOn('embroidery')} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog');
    const stitches = within(dialog).getByLabelText('Stitches');
    await user.type(stitches, '1,5');
    expect(stitches).toHaveValue('1,5');
    await user.click(within(dialog).getByRole('button', { name: 'Add run' }));
    expect(await within(dialog).findByText('Enter a whole number of stitches.')).toBeInTheDocument();
    expect(stitches).toHaveValue('1,5');
  });

  it('accepts a comma in an ink amount', async () => {
    let body: AddManualMachineRunRequest | undefined;
    server.use(...lookups, http.post(`*/api/v1/machine-jobs/${ids.job}/runs`, async ({ request }) => { body = await request.json() as AddManualMachineRunRequest; return HttpResponse.json(jobOn('uv_printing'), { status: 201 }); }));
    const user = userEvent.setup();
    renderRoute(<ToastProvider><RunFormModal open mode="add" job={jobOn('uv_printing')} onClose={() => undefined} /></ToastProvider>);
    const dialog = await screen.findByRole('dialog');
    await user.type(await within(dialog).findByLabelText('Cyan (ml)'), '0,4');
    await user.click(within(dialog).getByRole('button', { name: 'Add run' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.run.usages).toEqual([expect.objectContaining({ materialId: t(13), quantity: '0.40' })]);
  });
});

describe('consumption summary', () => {
  it('reads in the unit of each material', () => {
    expect(consumptionSummary(sumUsages([{ materialTypeName: 'Stabilizer', unit: 'm', quantity: '0.400000' }]), { stitches: 12400 })).toBe('12,400 stitches · 0.4 m Stabilizer');
    expect(consumptionSummary(sumUsages([
      { materialTypeName: 'UV ink', unit: 'ml', quantity: '1.20' }, { materialTypeName: 'UV ink', unit: 'ml', quantity: '2.00' }, { materialTypeName: 'DTF paper', unit: 'cm2', quantity: '180' },
    ]), {})).toBe('3.20 ml UV ink · 180 cm² DTF paper');
    expect(consumptionSummary([], {})).toBeNull();
  });
});
