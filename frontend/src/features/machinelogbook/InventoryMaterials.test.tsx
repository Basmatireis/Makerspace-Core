import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { CreateMaterialRequest, FilamentProduct, FilamentProductInput, InventoryTransaction, MarkMaterialEmptyRequest, Material, MaterialType, UpdateFilamentProductRequest } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { server } from '../../test/server';
import { testQueryClient } from '../../test/render';
import { InventoryPage } from './InventoryPage';
import { MaterialDetailPage } from './MaterialDetailPage';
import { machineLogbookPaths } from './shared/paths';
import { ToastProvider } from './shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));
// The spools tab, its table and the spool dialogs are covered with the spools screens.
vi.mock('./components/InventorySpoolsTable', () => ({
  InventorySpoolsTable: ({ materialId, compact, switcher }: { materialId?: string; compact?: boolean; switcher?: ReactNode }) => (
    <div data-testid="spools-table" data-material={materialId ?? ''} data-compact={String(Boolean(compact))}>{switcher}</div>
  ),
}));
vi.mock('./dialogs/SpoolFormModal', () => ({
  SpoolFormModal: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="Spool form stub" /> : null,
}));

const ids = {
  pla: '0192f6f8-743e-7c77-a349-cd07c3e8d001',
  plaType: '0192f6f8-743e-7c77-a349-cd07c3e8d0a1',
  sheetType: '0192f6f8-743e-7c77-a349-cd07c3e8d0a2',
  sheet: '0192f6f8-743e-7c77-a349-cd07c3e8d002',
  product: '0192f6f8-743e-7c77-a349-cd07c3e8d010',
  spool: '0192f6f8-743e-7c77-a349-cd07c3e8d020',
};

const filament: Material = {
  id: ids.pla, name: 'PLA Black', materialTypeId: ids.plaType, materialTypeName: 'PLA', colorName: 'Black', colorHex: '#1A1A1A', unit: 'g', active: true, lowStockThreshold: '1000',
  quantity: '6107', assignedQuantity: '5000', unassignedQuantity: '1107', filamentDiameterMm: '1.75', averageUnitCost: '0.018', inventoryValue: '109.93',
  stockState: 'in_stock', inventoryVersion: 7, recentConsumption: '240', version: 3, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-15T11:26:00Z',
};
const sheet: Material = {
  ...filament, id: ids.sheet, name: 'Birch plywood', materialTypeId: ids.sheetType, materialTypeName: 'Plywood', colorName: null, colorHex: null, unit: 'm2', lowStockThreshold: null, quantity: '12', assignedQuantity: '0', unassignedQuantity: '12',
  filamentDiameterMm: null, averageUnitCost: '9', inventoryValue: '108', inventoryVersion: 4, version: 1,
};
const product: FilamentProduct = {
  id: ids.product, manufacturer: 'Bambu Lab', name: 'PLA Basic Black', materialId: ids.pla, materialName: 'PLA Black', netWeightG: '1000', defaultPrice: '19.99', packaging: 'spool',
  notes: null, active: true, inUseCount: 2, version: 5, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};

const page = <T,>(items: T[]) => ({ items, page: 1, pageSize: 100, total: items.length });

function transaction(overrides: Partial<InventoryTransaction>): InventoryTransaction {
  return {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8d100', materialId: ids.pla, kind: 'purchase', quantityDelta: '1000', unitAcquisitionCost: '0.02', inventoryValueDelta: '20', totalPurchasePrice: '20',
    occurredAt: '2026-09-10T10:00:00Z', supplier: null, note: null, adjustmentReason: null, machineJobId: null, machineJobDisplayId: null, spoolId: null, spoolDisplayId: null, fillNumber: null,
    fromSpoolId: null, fromSpoolDisplayId: null, fromFillNumber: null, toSpoolId: null, toSpoolDisplayId: null, toFillNumber: null, transferQuantity: null, createdAt: '2026-09-10T10:00:00Z',
    ...overrides,
  };
}

function renderPage(element: React.ReactElement, path: string, route = '*') {
  const queryClient = testQueryClient();
  const router = createMemoryRouter([{ path: route, element: <ToastProvider>{element}</ToastProvider> }], { initialEntries: [path] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { router };
}

const materialTypes: MaterialType[] = [
  { id: ids.plaType, name: 'PLA', unit: 'g', processes: ['fdm_printing'], active: true, materialCount: 1, pricingRuleCount: 2, version: 2, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' },
  { id: ids.sheetType, name: 'Plywood', unit: 'm2', processes: ['laser_cutting'], active: true, materialCount: 1, pricingRuleCount: 0, version: 1, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' },
];

function serveInventory(materials: Material[] = [filament, sheet], products: FilamentProduct[] = [product]) {
  server.use(
    http.get('*/api/v1/materials', () => HttpResponse.json({ ...page(materials), totalInventoryValue: '218' })),
    http.get('*/api/v1/filament-spools', () => HttpResponse.json(page([{ id: ids.spool, materialId: ids.pla }, { id: ids.spool + '1', materialId: ids.pla }]))),
    http.get('*/api/v1/filament-products', () => HttpResponse.json(page(products))),
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items: materialTypes })),
  );
}

describe('Inventory page', () => {
  it('selects the tab from the URL and keeps the URL in step with the tab', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveInventory();
    const user = userEvent.setup();
    const { router } = renderPage(<InventoryPage />, `${machineLogbookPaths.inventory('products')}`);

    expect(await screen.findByRole('tab', { name: 'Products', selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Products' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Spools' }));
    expect(await screen.findByTestId('spools-table')).toHaveAttribute('data-compact', 'false');
    expect(new URLSearchParams(router.state.location.search).get('tab')).toBe('spools');
    await user.click(screen.getByRole('tab', { name: 'Materials' }));
    expect(await screen.findByRole('table', { name: 'Materials' })).toBeInTheDocument();
    expect(new URLSearchParams(router.state.location.search).get('tab')).toBe('materials');
  });

  it('shows the split between filament on spools and loose stock, and the spool count', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveInventory();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory());

    const table = await screen.findByRole('table', { name: 'Materials' });
    const plaRow = (await within(table).findByRole('link', { name: 'PLA Black' })).closest('tr') as HTMLElement;
    expect(within(plaRow).getByText('6,107 g')).toBeInTheDocument();
    expect(within(plaRow).getByText('5,000 g on spools · 1,107 g loose')).toBeInTheDocument();
    await waitFor(() => expect(within(plaRow).getAllByRole('cell').some((cell) => cell.textContent === '2')).toBe(true));
    const sheetRow = within(table).getByRole('link', { name: 'Birch plywood' }).closest('tr') as HTMLElement;
    expect(within(sheetRow).getByText('12 m²')).toBeInTheDocument();
    expect(within(sheetRow).queryByText(/on spools/)).not.toBeInTheDocument();
    expect(within(plaRow).getByText('€18.00 / kg')).toBeInTheDocument();
  });

  it('offers New only to people who may manage inventory or register spools', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage, PermissionId.filament_spoolsmanage];
    serveInventory();
    const user = userEvent.setup();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory());
    await user.click(await screen.findByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Register spool' }));
    expect(await screen.findByRole('dialog', { name: 'Spool form stub' })).toBeInTheDocument();
  });

  it('adds a material from the toolbar', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveInventory([]);
    let submitted: CreateMaterialRequest | undefined;
    server.use(http.post('*/api/v1/materials', async ({ request }) => {
      submitted = await request.json() as CreateMaterialRequest;
      return HttpResponse.json({ ...filament, ...submitted, id: ids.pla + '9' }, { status: 201 });
    }));
    const user = userEvent.setup();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory());
    // The toolbar button comes first; the empty state repeats it.
    await user.click((await screen.findAllByRole('button', { name: 'Add material' }))[0]);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'PETG Clear');
    await user.selectOptions(await within(dialog).findByLabelText('Material type'), ids.plaType);
    await user.type(within(dialog).getByLabelText('Colour name (optional)'), 'Clear');
    await user.type(within(dialog).getByLabelText('Colour code (optional)'), '#dde8ee');
    await user.type(within(dialog).getByLabelText('Filament diameter in mm (optional)'), '1.75');
    await user.type(within(dialog).getByLabelText('Low-stock threshold in g (optional)'), '1,5');
    await user.click(within(dialog).getByRole('button', { name: 'Add material' }));
    await waitFor(() => expect(submitted).toEqual({ name: 'PETG Clear', materialTypeId: ids.plaType, colorName: 'Clear', colorHex: '#DDE8EE', lowStockThreshold: '1.5', filamentDiameterMm: '1.75' }));
    expect(await screen.findByText('Material added')).toBeInTheDocument();
  });

  it('hides add and edit controls from readers and shows plain product names', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveInventory();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory('products'));
    const table = await screen.findByRole('table', { name: 'Products' });
    expect(await within(table).findByText('PLA Basic Black')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'PLA Basic Black' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add product' })).not.toBeInTheDocument();
    expect(within(table).getByText('Bambu Lab')).toBeInTheDocument();
    expect(within(table).getByText('€19.99')).toBeInTheDocument();
  });

  it('creates a product with a new manufacturer', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveInventory();
    let submitted: FilamentProductInput | undefined;
    server.use(http.post('*/api/v1/filament-products', async ({ request }) => {
      submitted = await request.json() as FilamentProductInput;
      return HttpResponse.json({ ...product, ...submitted, id: ids.product + '9', inUseCount: 0, version: 1 }, { status: 201 });
    }));
    const user = userEvent.setup();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory('products'));
    await user.click(await screen.findByRole('button', { name: 'Add product' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox', { name: 'Manufacturer' }), 'Prusament');
    await user.type(within(dialog).getByLabelText('Product'), 'PETG Orange');
    await user.selectOptions(within(dialog).getByLabelText('Material'), ids.pla);
    await user.type(within(dialog).getByLabelText('Default price (€, optional)'), '24.5');
    await user.click(within(dialog).getByLabelText(/Refill/));
    await user.click(within(dialog).getByRole('button', { name: 'Add product' }));
    await waitFor(() => expect(submitted).toEqual({ manufacturer: 'Prusament', name: 'PETG Orange', materialId: ids.pla, netWeightG: '1000', defaultPrice: '24.50', packaging: 'refill', notes: null }));
    expect(await screen.findByText('Product added')).toBeInTheDocument();
  });

  it('edits a product with its version and shows a duplicate as an inline error', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveInventory();
    const submissions: UpdateFilamentProductRequest[] = [];
    server.use(http.patch(`*/api/v1/filament-products/${ids.product}`, async ({ request }) => {
      submissions.push(await request.json() as UpdateFilamentProductRequest);
      return HttpResponse.json({ code: 'product_exists', message: 'A product with this manufacturer and name already exists' }, { status: 409 });
    }));
    const user = userEvent.setup();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory('products'));
    await user.click(await screen.findByRole('button', { name: 'PLA Basic Black' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit product')).toBeInTheDocument();
    expect(within(dialog).getByRole('switch', { name: 'Active' })).toBeInTheDocument();
    const name = within(dialog).getByLabelText('Product');
    await user.clear(name);
    await user.type(name, 'PLA Matte Black');
    await user.click(within(dialog).getByRole('button', { name: 'Save product' }));
    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]).toMatchObject({ manufacturer: 'Bambu Lab', name: 'PLA Matte Black', materialId: ids.pla, netWeightG: '1000', defaultPrice: '19.99', packaging: 'spool', active: true, expectedVersion: 5 });
    expect(await within(dialog).findByText('This manufacturer already has a product with this name.')).toBeInTheDocument();
    expect(JSON.stringify(submissions)).not.toContain(ids.product);
  });
});

describe('Material detail page', () => {
  function serveMaterial(material: Material, transactions: InventoryTransaction[] = []) {
    server.use(
      http.get(`*/api/v1/materials/${material.id}`, () => HttpResponse.json(material)),
      http.get(`*/api/v1/materials/${material.id}/transactions`, () => HttpResponse.json(page(transactions))),
      http.get('*/api/v1/filament-products', () => HttpResponse.json(page([product]))),
      http.get('*/api/v1/materials', () => HttpResponse.json({ ...page([filament, sheet]), totalInventoryValue: '218' })),
    );
  }
  const route = '/machine-logbook/inventory/materials/:materialId';

  it('shows the stock split, products and a compact spools table for filament', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveMaterial(filament);
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.pla), route);

    expect(await screen.findByRole('heading', { name: 'PLA Black' })).toBeInTheDocument();
    const facts = document.querySelector('.mj-facts') as HTMLElement;
    expect(within(facts).getByText('On spools').nextSibling).toHaveTextContent('5,000 g');
    expect(within(facts).getByText('Loose stock').nextSibling).toHaveTextContent('1,107 g');
    expect(within(facts).getByText('Stock value').nextSibling).toHaveTextContent('€109.93');
    expect(await screen.findByRole('table', { name: 'Products' })).toBeInTheDocument();
    expect(screen.getByTestId('spools-table')).toMatchObject({ dataset: { material: ids.pla, compact: 'true' } });
    expect(screen.getByRole('button', { name: 'Add stock' })).toBeInTheDocument();
  });

  it('leaves out the spool sections and split for other materials, and the actions for readers', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveMaterial(sheet);
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.sheet), route);

    expect(await screen.findByRole('heading', { name: 'Birch plywood' })).toBeInTheDocument();
    expect(screen.queryByText('On spools')).not.toBeInTheDocument();
    expect(screen.queryByTestId('spools-table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add stock' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'More material actions' })).not.toBeInTheDocument();
  });

  it('writes spool snapshots and transfers into the ledger as text', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveMaterial(filament, [
      transaction({ id: ids.spool + 'a', kind: 'purchase', spoolId: null, spoolDisplayId: 'S-2026-000007', fillNumber: 2, occurredAt: '2026-09-12T10:00:00Z' }),
      transaction({ id: ids.spool + 'b', kind: 'spool_transfer', quantityDelta: '0', inventoryValueDelta: '0', transferQuantity: '1000', toSpoolId: ids.spool, toSpoolDisplayId: 'S-2026-000008', toFillNumber: 1, occurredAt: '2026-09-11T10:00:00Z' }),
      transaction({ id: ids.spool + 'c', kind: 'spool_transfer', quantityDelta: '0', inventoryValueDelta: '0', transferQuantity: '37', fromSpoolId: ids.spool, fromSpoolDisplayId: 'S-2026-000008', fromFillNumber: 1, occurredAt: '2026-09-10T12:00:00Z' }),
      transaction({ id: ids.spool + 'd', kind: 'spool_transfer', quantityDelta: '0', inventoryValueDelta: '0', transferQuantity: '500', toSpoolId: null, toSpoolDisplayId: 'S-2026-000009', occurredAt: '2026-09-09T12:00:00Z' }),
    ]);
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.pla), route);

    const ledger = await screen.findByRole('table', { name: 'Ledger' });
    expect(await within(ledger).findByText('1,000 g → S-2026-000008')).toBeInTheDocument();
    expect(within(ledger).getByText('37 g: S-2026-000008 → loose')).toBeInTheDocument();
    expect(within(ledger).getByText('500 g → S-2026-000009 (deleted)')).toBeInTheDocument();
    expect(within(ledger).getAllByText('Total unchanged')).toHaveLength(3);
    // A deleted spool is plain text, an existing one links to its page.
    const deleted = within(ledger).getByText('S-2026-000007 (deleted) · fill 2');
    expect(deleted.closest('a')).toBeNull();
    expect(within(ledger).getAllByRole('link', { name: /S-2026-000008/ })[0]).toHaveAttribute('href', machineLogbookPaths.spool(ids.spool));
  });

  it('labels the stock a machine run consumed and names the job it belongs to', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.machine_jobsread];
    serveMaterial(filament, [
      transaction({ id: ids.spool + 'e', kind: 'machine_run_consumption', quantityDelta: '-183', machineJobId: ids.spool, machineJobDisplayId: 'J-2026-000001', occurredAt: '2026-09-12T10:00:00Z' }),
    ]);
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.pla), route);

    const ledger = await screen.findByRole('table', { name: 'Ledger' });
    expect(await within(ledger).findByText('Run consumption')).toBeInTheDocument();
    expect(within(ledger).getByRole('link', { name: 'J-2026-000001' })).toHaveAttribute('href', machineLogbookPaths.job(ids.spool));
  });

  it('asks for confirmation and sends the latest inventory version when marking a material empty', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveMaterial(sheet);
    let submitted: MarkMaterialEmptyRequest | undefined;
    server.use(http.post(`*/api/v1/materials/${ids.sheet}/mark-empty`, async ({ request }) => {
      submitted = await request.json() as MarkMaterialEmptyRequest;
      return HttpResponse.json({ material: { ...sheet, quantity: '0', stockState: 'empty', inventoryVersion: 5 }, transaction: transaction({ materialId: ids.sheet, kind: 'adjustment', quantityDelta: '-12' }) });
    }));
    const user = userEvent.setup();
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.sheet), route);

    await screen.findByRole('heading', { name: 'Birch plywood' });
    // Carbon names the overflow button through a tooltip that only exists on hover; its icon carries the label.
    await user.click(screen.getByRole('img', { name: 'More material actions' }));
    // jsdom never positions the floating menu, so Carbon leaves it visibility:hidden.
    await user.click(await screen.findByText('Mark as empty'));
    const dialog = await screen.findByRole('alertdialog');
    expect(submitted).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Mark as empty' }));
    await waitFor(() => expect(submitted).toMatchObject({ expectedInventoryVersion: 4 }));
  });

  it('limits consumption of filament to loose stock and records it with the latest version', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveMaterial(filament);
    let submitted: Record<string, unknown> | undefined;
    server.use(http.post(`*/api/v1/materials/${ids.pla}/consumptions`, async ({ request }) => {
      submitted = await request.json() as Record<string, unknown>;
      return HttpResponse.json({ material: filament, transaction: transaction({ kind: 'manual_consumption', quantityDelta: '-100' }) }, { status: 201 });
    }));
    const user = userEvent.setup();
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.pla), route);

    await screen.findByRole('heading', { name: 'PLA Black' });
    await user.click(screen.getByRole('img', { name: 'More material actions' }));
    await user.click(await screen.findByText('Record consumption'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Loose stock: 1,107 g')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Quantity used (g)'), '2000');
    await user.click(within(dialog).getByRole('button', { name: 'Record consumption' }));
    expect(await within(dialog).findByText('Only 1,107 g on record that is not on a spool.')).toBeInTheDocument();
    expect(submitted).toBeUndefined();
    await user.clear(within(dialog).getByLabelText('Quantity used (g)'));
    await user.type(within(dialog).getByLabelText('Quantity used (g)'), '100');
    await user.click(within(dialog).getByRole('button', { name: 'Record consumption' }));
    await waitFor(() => expect(submitted).toMatchObject({ quantity: '100', disposal: false, reason: null, expectedInventoryVersion: 7 }));
  });

  it('records a purchase against the material with its price', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveMaterial(sheet);
    let submitted: Record<string, unknown> | undefined;
    server.use(http.post(`*/api/v1/materials/${ids.sheet}/purchases`, async ({ request }) => {
      submitted = await request.json() as Record<string, unknown>;
      return HttpResponse.json({ material: sheet, transaction: transaction({ materialId: ids.sheet }) }, { status: 201 });
    }));
    const user = userEvent.setup();
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.sheet), route);

    await user.click(await screen.findByRole('button', { name: 'Add stock' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Quantity received (m²)'), '5');
    await user.type(within(dialog).getByLabelText('Total price in EUR'), '45');
    await user.click(within(dialog).getByRole('button', { name: 'Add stock' }));
    await waitFor(() => expect(submitted).toMatchObject({ quantity: '5', totalPrice: '45.00', supplier: null, expectedInventoryVersion: 4 }));
  });
});
