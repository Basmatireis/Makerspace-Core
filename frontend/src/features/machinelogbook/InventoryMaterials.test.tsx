import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { CreateMaterialRequest, InventoryTransaction, MarkMaterialEmptyRequest, Material, MaterialType } from '../../api/generated/models';
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
  partType: '0192f6f8-743e-7c77-a349-cd07c3e8d0a3',
  sheet: '0192f6f8-743e-7c77-a349-cd07c3e8d002',
  insert: '0192f6f8-743e-7c77-a349-cd07c3e8d003',
  petg: '0192f6f8-743e-7c77-a349-cd07c3e8d004',
  spool: '0192f6f8-743e-7c77-a349-cd07c3e8d020',
};

const filament: Material = {
  id: ids.pla, name: 'PLA Basic · Black · Bambu Lab', kind: 'filament', materialTypeId: ids.plaType, materialTypeName: 'PLA', variant: 'Basic', manufacturer: 'Bambu Lab', salePrice: null, packageSize: '1000',
  storageLocation: 'Shelf A', notes: null, colorName: 'Black', colorHex: '#1A1A1A', unit: 'g', active: true, lowStockThreshold: '1000',
  quantity: '6107', assignedQuantity: '5000', unassignedQuantity: '1107', filamentDiameterMm: '1.75', averageUnitCost: '0.018', inventoryValue: '109.93',
  stockState: 'in_stock', inventoryVersion: 7, recentConsumption: '240', version: 3, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-15T11:26:00Z',
};
const lowFilament: Material = {
  ...filament, id: ids.petg, name: 'PETG · White', variant: null, manufacturer: null, colorName: 'White', colorHex: '#FFFFFF', quantity: '300', assignedQuantity: '0', unassignedQuantity: '300', stockState: 'low_stock',
  storageLocation: null, packageSize: null,
};
const sheet: Material = {
  ...filament, id: ids.sheet, name: 'Birch plywood', kind: 'consumable', materialTypeId: ids.sheetType, materialTypeName: 'Plywood', variant: '3 mm', manufacturer: null, colorName: null, colorHex: null,
  unit: 'm2', lowStockThreshold: null, quantity: '12', assignedQuantity: '0', unassignedQuantity: '12', filamentDiameterMm: null, averageUnitCost: '9', inventoryValue: '108', inventoryVersion: 4, version: 1,
  storageLocation: null, packageSize: null,
};
const insert: Material = {
  ...sheet, id: ids.insert, name: 'M3 heat-set insert', kind: 'part', materialTypeId: ids.partType, materialTypeName: 'Fasteners', variant: null, unit: 'piece', quantity: '250', unassignedQuantity: '250',
  salePrice: '0.15', averageUnitCost: '0.05', inventoryValue: '12.5', storageLocation: 'Drawer 4', packageSize: '100',
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
  { id: ids.plaType, name: 'PLA', kind: 'filament', unit: 'g', processes: ['fdm_printing'], active: true, materialCount: 1, pricingRuleCount: 2, version: 2, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' },
  { id: ids.sheetType, name: 'Plywood', kind: 'consumable', unit: 'm2', processes: ['laser_cutting'], active: true, materialCount: 1, pricingRuleCount: 0, version: 1, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' },
  { id: ids.partType, name: 'Fasteners', kind: 'part', unit: 'piece', processes: [], active: true, materialCount: 1, pricingRuleCount: 0, version: 1, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' },
];

function serveInventory(materials: Material[] = [filament, lowFilament, sheet, insert]) {
  server.use(
    http.get('*/api/v1/materials', () => HttpResponse.json({ ...page(materials), totalInventoryValue: '218' })),
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items: materialTypes })),
    http.get('*/api/v1/inventory/suggestions', () => HttpResponse.json({ variants: [], manufacturers: [], suppliers: [], storageLocations: [] })),
  );
}

describe('Inventory page', () => {
  it('selects the tab from the URL and keeps the URL in step with the tab', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveInventory();
    const user = userEvent.setup();
    const { router } = renderPage(<InventoryPage />, machineLogbookPaths.inventory('parts'));

    expect(await screen.findByRole('tab', { name: 'Parts', selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Parts' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Spools' }));
    expect(await screen.findByTestId('spools-table')).toHaveAttribute('data-compact', 'false');
    expect(new URLSearchParams(router.state.location.search).get('tab')).toBe('spools');
    await user.click(screen.getByRole('tab', { name: 'Consumables' }));
    expect(await screen.findByRole('table', { name: 'Consumables' })).toBeInTheDocument();
    expect(new URLSearchParams(router.state.location.search).get('tab')).toBe('consumables');
  });

  it('opens the filament tab for the tab names of the former page', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveInventory();
    renderPage(<InventoryPage />, '/machine-logbook/inventory?tab=material-types');
    expect(await screen.findByRole('tab', { name: 'Filament', selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Filament' })).toBeInTheDocument();
  });

  it('shows filament with colour, type, variant, manufacturer and the split between loose stock and spools', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveInventory();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory());

    const table = await screen.findByRole('table', { name: 'Filament' });
    for (const header of ['Colour', 'Material', 'Variant', 'Manufacturer', 'Loose stock', 'On spools', 'Location', 'State']) {
      expect(within(table).getByRole('columnheader', { name: new RegExp(header) })).toBeInTheDocument();
    }
    const row = (await within(table).findByRole('link', { name: 'Black' })).closest('tr') as HTMLElement;
    expect(within(row).getByText('PLA')).toBeInTheDocument();
    expect(within(row).getByText('Basic')).toBeInTheDocument();
    expect(within(row).getByText('Bambu Lab')).toBeInTheDocument();
    expect(within(row).getByText('1,107 g')).toBeInTheDocument();
    expect(within(row).getByText('5,000 g')).toBeInTheDocument();
    expect(within(row).getByText('Shelf A')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Black' })).toHaveAttribute('href', machineLogbookPaths.material(ids.pla));
    expect(within(table).queryByText('Birch plywood')).not.toBeInTheDocument();
    // The stock value of the whole inventory sits in the page description.
    expect(screen.getByText(/Stock value €218\.00/)).toBeInTheDocument();
  });

  it('shows consumables with their unit and parts with category and sale price', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveInventory();
    const user = userEvent.setup();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory('consumables'));

    const consumables = await screen.findByRole('table', { name: 'Consumables' });
    const sheetRow = (await within(consumables).findByRole('link', { name: 'Birch plywood' })).closest('tr') as HTMLElement;
    expect(within(sheetRow).getByText('12 m²')).toBeInTheDocument();
    expect(within(sheetRow).getByText('3 mm')).toBeInTheDocument();
    expect(within(consumables).queryByRole('columnheader', { name: /On spools/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Parts' }));
    const parts = await screen.findByRole('table', { name: 'Parts' });
    const partRow = (await within(parts).findByRole('link', { name: 'M3 heat-set insert' })).closest('tr') as HTMLElement;
    expect(within(partRow).getByText('Fasteners')).toBeInTheDocument();
    expect(within(partRow).getByText('250 pcs')).toBeInTheDocument();
    expect(within(partRow).getByText('€0.15')).toBeInTheDocument();
    expect(within(parts).getByRole('columnheader', { name: /Category/ })).toBeInTheDocument();
  });

  it('applies the low-stock filter named in the URL', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveInventory();
    renderPage(<InventoryPage />, `${machineLogbookPaths.inventory('filament')}&stock=low_stock`);

    const table = await screen.findByRole('table', { name: 'Filament' });
    expect(await within(table).findByRole('link', { name: 'White' })).toBeInTheDocument();
    expect(within(table).queryByRole('link', { name: 'Black' })).not.toBeInTheDocument();
    expect(within(table).getByText('Low')).toBeInTheDocument();
  });

  it('offers receiving stock and new articles only to people who may manage inventory', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveInventory();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory());
    await screen.findByRole('table', { name: 'Filament' });
    expect(screen.queryByRole('button', { name: 'Receive stock' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'More inventory actions' })).toBeInTheDocument();
  });

  it('opens Receive stock for the kind of the current tab', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveInventory();
    const user = userEvent.setup();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory('parts'));
    await user.click(await screen.findByRole('button', { name: 'Receive stock' }));
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });
    expect(within(dialog).getByRole('combobox', { name: 'Article' })).toBeInTheDocument();
    expect(within(dialog).queryByText('Where it goes')).not.toBeInTheDocument();
  });

  it('adds an article without stock from the overflow menu', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveInventory([]);
    let submitted: CreateMaterialRequest | undefined;
    server.use(http.post('*/api/v1/materials', async ({ request }) => {
      submitted = await request.json() as CreateMaterialRequest;
      return HttpResponse.json({ ...filament, ...submitted, id: ids.pla + '9' }, { status: 201 });
    }));
    const user = userEvent.setup();
    renderPage(<InventoryPage />, machineLogbookPaths.inventory('parts'));
    await user.click(await screen.findByRole('img', { name: 'More inventory actions' }));
    await user.click(await screen.findByText('New article'));
    const dialog = await screen.findByRole('dialog', { name: 'New article' });
    await user.type(within(dialog).getByLabelText('Name'), 'Brake caliper');
    await user.click(within(dialog).getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByText('Fasteners'));
    await user.type(within(dialog).getByLabelText(/Sale price per/), '39,9');
    await user.click(within(dialog).getByRole('button', { name: 'Add article' }));
    await waitFor(() => expect(submitted).toMatchObject({ name: 'Brake caliper', materialTypeId: ids.partType, salePrice: '39.90', colorName: null, filamentDiameterMm: null }));
    expect(await screen.findByText('Article added')).toBeInTheDocument();
  });
});

describe('Article detail page', () => {
  function serveMaterial(material: Material, transactions: InventoryTransaction[] = []) {
    server.use(
      http.get(`*/api/v1/materials/${material.id}`, () => HttpResponse.json(material)),
      http.get(`*/api/v1/materials/${material.id}/transactions`, () => HttpResponse.json(page(transactions))),
      http.get('*/api/v1/materials', () => HttpResponse.json({ ...page([filament, sheet]), totalInventoryValue: '218' })),
      http.get('*/api/v1/material-types', () => HttpResponse.json({ items: materialTypes })),
      http.get('*/api/v1/inventory/suggestions', () => HttpResponse.json({ variants: [], manufacturers: [], suppliers: [], storageLocations: [] })),
    );
  }
  const route = '/machine-logbook/inventory/materials/:materialId';

  it('shows the article fields, the stock split and a compact spools table for filament', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveMaterial(filament);
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.pla), route);

    expect(await screen.findByRole('heading', { name: 'PLA Basic · Black · Bambu Lab' })).toBeInTheDocument();
    const facts = document.querySelector('.mj-facts') as HTMLElement;
    expect(within(facts).getByText('On spools').nextSibling).toHaveTextContent('5,000 g');
    expect(within(facts).getByText('Loose stock').nextSibling).toHaveTextContent('1,107 g');
    expect(within(facts).getByText('Stock value').nextSibling).toHaveTextContent('€109.93');
    expect(within(facts).getByText('Package size').nextSibling).toHaveTextContent('1,000 g');
    expect(within(facts).getByText('Storage location').nextSibling).toHaveTextContent('Shelf A');
    expect(within(facts).getByText('Manufacturer').nextSibling).toHaveTextContent('Bambu Lab');
    expect(within(facts).getByText('Variant').nextSibling).toHaveTextContent('Basic');
    expect(within(facts).getByText('Material type').nextSibling).toHaveTextContent('PLA');
    expect(screen.queryByRole('table', { name: 'Products' })).not.toBeInTheDocument();
    expect(screen.getByTestId('spools-table')).toMatchObject({ dataset: { material: ids.pla, compact: 'true' } });
    expect(screen.getByRole('button', { name: 'Receive stock' })).toBeInTheDocument();
  });

  it('shows the sale price and category of a part, without spool sections, and no actions for readers', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveMaterial(insert);
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.insert), route);

    expect(await screen.findByRole('heading', { name: 'M3 heat-set insert' })).toBeInTheDocument();
    const facts = document.querySelector('.mj-facts') as HTMLElement;
    expect(within(facts).getByText('Sale price').nextSibling).toHaveTextContent('€0.15 / pcs');
    expect(within(facts).getByText('Category').nextSibling).toHaveTextContent('Fasteners');
    expect(screen.queryByText('On spools')).not.toBeInTheDocument();
    expect(screen.queryByTestId('spools-table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive stock' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'More article actions' })).not.toBeInTheDocument();
  });

  it('opens Receive stock with the article preselected', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveMaterial(insert);
    const user = userEvent.setup();
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.insert), route);
    await user.click(await screen.findByRole('button', { name: 'Receive stock' }));
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });
    expect(within(dialog).getByLabelText('Article')).toHaveValue('M3 heat-set insert · 250 pcs in stock');
    expect(within(dialog).getByLabelText(/Size of one package/)).toHaveValue('100');
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

  it('shows the purchase reference and the order sale kinds in the ledger', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveMaterial(insert, [
      transaction({ id: ids.spool + 'f', materialId: ids.insert, kind: 'purchase', supplier: 'Würth', reference: 'INV-2026-77', occurredAt: '2026-09-12T10:00:00Z' }),
      transaction({ id: ids.spool + 'g', materialId: ids.insert, kind: 'order_sale', quantityDelta: '-10', inventoryValueDelta: '-0.5', totalPurchasePrice: null, occurredAt: '2026-09-13T10:00:00Z' }),
      transaction({ id: ids.spool + 'h', materialId: ids.insert, kind: 'order_sale_reversal', quantityDelta: '10', inventoryValueDelta: '0.5', totalPurchasePrice: null, occurredAt: '2026-09-14T10:00:00Z' }),
    ]);
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.insert), route);

    const ledger = await screen.findByRole('table', { name: 'Ledger' });
    expect(await within(ledger).findByText('Sold (order)')).toBeInTheDocument();
    expect(within(ledger).getByText('Order reversed')).toBeInTheDocument();
    expect(within(ledger).getByText('INV-2026-77')).toBeInTheDocument();
    expect(within(ledger).getByText('Würth')).toBeInTheDocument();
  });

  it('links the order of a sale in the ledger only with orders.read', async () => {
    const sales = [
      transaction({ id: ids.spool + 'g', materialId: ids.insert, kind: 'order_sale', quantityDelta: '-10', inventoryValueDelta: '-0.5', totalPurchasePrice: null, orderId: ids.spool, orderReference: 'O-2026-000012', occurredAt: '2026-09-13T10:00:00Z' }),
    ];
    auth.permissions = [PermissionId.inventoryread, PermissionId.ordersread];
    serveMaterial(insert, sales);
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.insert), route);
    let ledger = await screen.findByRole('table', { name: 'Ledger' });
    expect(await within(ledger).findByRole('link', { name: 'O-2026-000012' })).toHaveAttribute('href', `/orders/${ids.spool}`);
    cleanup();

    auth.permissions = [PermissionId.inventoryread];
    renderPage(<MaterialDetailPage />, machineLogbookPaths.material(ids.insert), route);
    ledger = await screen.findByRole('table', { name: 'Ledger' });
    expect(await within(ledger).findByText('O-2026-000012')).toBeInTheDocument();
    expect(within(ledger).queryByRole('link', { name: 'O-2026-000012' })).toBeNull();
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

  it('asks for confirmation and sends the latest inventory version when marking an article empty', async () => {
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
    await user.click(screen.getByRole('img', { name: 'More article actions' }));
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

    await screen.findByRole('heading', { name: 'PLA Basic · Black · Bambu Lab' });
    await user.click(screen.getByRole('img', { name: 'More article actions' }));
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
});
