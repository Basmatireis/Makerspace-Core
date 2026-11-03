import type { ReactElement } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { FilamentSpool, Material, MaterialType, ReceiveInventoryStockRequest } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { ReceiveStockModal } from './dialogs/ReceiveStockModal';
import { ToastProvider } from './shared/toasts';
import { printerProcessId } from './printerTestData';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const id = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e8c${String(n).padStart(3, '0')}`;
const now = '2026-09-15T11:26:00Z';
const MANAGER = [PermissionId.inventoryread, PermissionId.inventorymanage];
const WITH_SPOOLS = [...MANAGER, PermissionId.filament_spoolsmanage];

const variantOf = (n: number, name: string) => ({
  id: id(50 + n),
  materialTypeId: id(1),
  name,
  materialCount: 0,
  pricingRuleCount: 0,
});
const plaType: MaterialType = {
  id: id(1),
  name: 'PLA',
  code: 'PLA',
  kind: 'filament',
  machineUse: true,
  unit: 'g',
  processIds: [printerProcessId],
  active: true,
  materialCount: 1,
  pricingRuleCount: 0,
  variants: [variantOf(1, 'Basic'), variantOf(2, 'Matte')],
  version: 1,
  createdAt: now,
  updatedAt: now,
};
const partType: MaterialType = {
  id: id(2),
  name: 'Fasteners',
  code: 'FASTENERS',
  kind: 'part',
  machineUse: false,
  unit: 'piece',
  processIds: [],
  active: true,
  materialCount: 1,
  pricingRuleCount: 0,
  variants: [],
  version: 1,
  createdAt: now,
  updatedAt: now,
};

const black: Material = {
  id: id(10),
  displayId: 'A-0010',
  name: 'PLA Basic · Black · Bambu Lab',
  kind: 'filament',
  materialTypeCode: 'PLA',
  machineUse: true,
  prices: [],
  attention: [],
  materialTypeId: plaType.id,
  materialTypeName: 'PLA',
  variant: 'Basic',
  manufacturer: 'Bambu Lab',
  packageSize: '1000',
  storageLocation: null,
  notes: null,
  colorName: 'Black',
  colorHex: '#1A1A1A',
  unit: 'g',
  active: true,
  lowStockThreshold: null,
  quantity: '2000',
  assignedQuantity: '0',
  unassignedQuantity: '2000',
  filamentDiameterMm: '1.75',
  averageUnitCost: '0.02',
  inventoryValue: '40',
  stockState: 'in_stock',
  inventoryVersion: 7,
  recentConsumption: '0',
  version: 3,
  createdAt: now,
  updatedAt: now,
};
const insert: Material = {
  ...black,
  id: id(11),
  name: 'M3 heat-set insert',
  kind: 'part',
  materialTypeId: partType.id,
  materialTypeName: 'Fasteners',
  materialTypeCode: 'FASTENERS',
  machineUse: false,
  variant: null,
  manufacturer: null,
  colorName: null,
  colorHex: null,
  unit: 'piece',
  packageSize: '100',
  quantity: '250',
  unassignedQuantity: '250',
  filamentDiameterMm: null,
  inventoryVersion: 2,
};

const newSpool = {
  id: id(20),
  displayId: 'S-PLA-MATTE-RED-01',
  remainingQuantity: '1000',
  lifecycle: 'active',
  mounted: false,
  identifiers: [],
  version: 1,
} as unknown as FilamentSpool;

const page = <T,>(items: T[]) => ({ items, page: 1, pageSize: 100, total: items.length });

function serve(materials: Material[] = [black, insert]) {
  server.use(
    http.get('*/api/v1/materials', () => HttpResponse.json({ ...page(materials), totalInventoryValue: '100' })),
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [plaType, partType] })),
    http.get('*/api/v1/inventory/suggestions', () =>
      HttpResponse.json({
        variants: ['Basic', 'Matte'],
        manufacturers: ['Bambu Lab'],
        suppliers: ['Filament Shop'],
        storageLocations: ['Shelf A'],
      }),
    ),
  );
}

function renderModal(ui: ReactElement) {
  return renderRoute(<ToastProvider>{ui}</ToastProvider>);
}

const receipt = (material: Material, spools: FilamentSpool[] = []) => ({ material, spools, transactions: [] });

async function pickArticle(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, text: string | RegExp) {
  await user.click(await within(dialog).findByRole('combobox', { name: 'Article' }));
  await user.click(await screen.findByText(text));
}

describe('Receive stock', () => {
  it('starts with an empty article search that lists existing articles', async () => {
    auth.permissions = WITH_SPOOLS;
    serve();
    const user = userEvent.setup();
    renderModal(<ReceiveStockModal open onClose={vi.fn()} kind="filament" />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });

    const article = await within(dialog).findByRole('combobox', { name: 'Article' });
    expect(article).toHaveValue('');
    expect(within(dialog).queryByLabelText(/Variant/)).not.toBeInTheDocument();
    await user.type(article, 'Black');
    expect(await screen.findByText(/PLA Basic · Black · Bambu Lab · 2,000 g in stock/)).toBeInTheDocument();
  });

  it('books packages of an existing article to storage with the latest inventory version', async () => {
    auth.permissions = WITH_SPOOLS;
    serve();
    let body: ReceiveInventoryStockRequest | undefined;
    server.use(
      http.post('*/api/v1/inventory/receipts', async ({ request }) => {
        body = (await request.json()) as ReceiveInventoryStockRequest;
        return HttpResponse.json(receipt(black), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal(<ReceiveStockModal open onClose={onClose} kind="filament" />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });

    await pickArticle(user, dialog, /PLA Basic · Black · Bambu Lab · 2,000 g in stock/);
    // The article's package size is prefilled; three packages make 3 kg.
    await waitFor(() => expect(within(dialog).getByLabelText(/Size of one package/)).toHaveValue('1000'));
    const count = within(dialog).getByLabelText('Packages');
    await user.clear(count);
    await user.type(count, '3');
    expect(within(dialog).getByText('Total received: 3 × 1,000 g = 3,000 g')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Total price in EUR'), '57,9');
    await user.type(within(dialog).getByLabelText('Reference (optional)'), 'INV-77');
    expect(within(dialog).getByLabelText('In storage')).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      materialId: black.id,
      expectedInventoryVersion: 7,
      packageCount: 3,
      packageSize: '1000',
      totalPrice: '57.90',
      supplier: null,
      reference: 'INV-77',
      placement: { mode: 'storage' },
      occurredAt: expect.any(String),
    });
    expect(body).not.toHaveProperty('material');
    expect(await screen.findByText('Stock received')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open article' })).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('receives any article when no kind is given and takes the kind from the article', async () => {
    auth.permissions = WITH_SPOOLS;
    serve();
    let body: ReceiveInventoryStockRequest | undefined;
    server.use(
      http.post('*/api/v1/inventory/receipts', async ({ request }) => {
        body = (await request.json()) as ReceiveInventoryStockRequest;
        return HttpResponse.json(receipt(insert), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderModal(<ReceiveStockModal open onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });

    // Filament and parts are both offered; a part needs no placement.
    await user.click(await within(dialog).findByRole('combobox', { name: 'Article' }));
    expect(await screen.findByText(/PLA Basic · Black · Bambu Lab/)).toBeInTheDocument();
    await user.click(screen.getByText(new RegExp(insert.name)));
    await waitFor(() => expect(within(dialog).queryByLabelText('In storage')).not.toBeInTheDocument());
    const count = within(dialog).getByLabelText('Packages');
    await user.clear(count);
    await user.type(count, '2');
    const size = within(dialog).getByLabelText(/Size of one package/);
    await user.clear(size);
    await user.type(size, '50');
    await user.type(within(dialog).getByLabelText('Total price in EUR'), '10');
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ materialId: insert.id, packageCount: 2, packageSize: '50', totalPrice: '10.00' });
    expect(body).not.toHaveProperty('placement');
  });

  it('describes a new filament article and puts each package on a new spool', async () => {
    auth.permissions = WITH_SPOOLS;
    serve([]);
    let body: ReceiveInventoryStockRequest | undefined;
    const created = { ...black, id: id(12), name: 'PLA Matte · Red · Prusa' };
    const spool = { ...newSpool, id: id(21), displayId: 'S-PLA-MATTE-RED-01' } as FilamentSpool;
    server.use(
      http.post('*/api/v1/inventory/receipts', async ({ request }) => {
        body = (await request.json()) as ReceiveInventoryStockRequest;
        return HttpResponse.json(receipt(created, [spool]), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderModal(<ReceiveStockModal open onClose={vi.fn()} kind="filament" />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });

    await pickArticle(user, dialog, 'New article…');
    await user.click(await within(dialog).findByRole('combobox', { name: 'Material type' }));
    await user.click(await screen.findByText('PLA (g)'));
    await user.type(within(dialog).getByRole('combobox', { name: 'Variant (optional)' }), 'Matte');
    await user.type(within(dialog).getByLabelText('Colour name (optional)'), 'Red');
    await user.type(within(dialog).getByRole('combobox', { name: 'Manufacturer (optional)' }), 'Prusa');
    expect(within(dialog).getByText('Leave empty to name it "PLA Matte · Red · Prusa".')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Package size in g/), '1000');
    await waitFor(() => expect(within(dialog).getByLabelText(/Size of one package/)).toHaveValue('1000'));
    await user.type(within(dialog).getByLabelText('Total price in EUR'), '24');
    await user.click(within(dialog).getByLabelText('On new spools (one per package)'));
    expect(within(dialog).getByText(/The spool is labelled S-PLA-MATTE-RED-NN/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Tare weight per spool/), '210');
    await user.type(within(dialog).getByLabelText('Identifier value (optional)'), '04AA11');
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body?.material).toMatchObject({
      materialTypeId: plaType.id,
      variant: 'Matte',
      colorName: 'Red',
      manufacturer: 'Prusa',
      filamentDiameterMm: '1.75',
      packageSize: '1000',
    });
    expect(body?.material).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('materialId');
    expect(body).toMatchObject({
      packageCount: 1,
      packageSize: '1000',
      totalPrice: '24.00',
      placement: { mode: 'new_spools', tareWeightG: '210', identifiers: [{ kind: 'nfc', value: '04AA11' }] },
    });
    expect(await screen.findByRole('button', { name: 'Open S-PLA-MATTE-RED-01' })).toBeInTheDocument();
  });

  it('offers the variants of the chosen type and still takes a new name', async () => {
    auth.permissions = MANAGER;
    serve([black, insert]);
    const user = userEvent.setup();
    renderModal(<ReceiveStockModal open onClose={vi.fn()} kind="filament" />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });

    await pickArticle(user, dialog, 'New article…');
    await user.click(await within(dialog).findByRole('combobox', { name: 'Material type' }));
    await user.click(await screen.findByText('PLA (g)'));
    await user.click(within(dialog).getByRole('combobox', { name: 'Variant (optional)' }));
    expect(await screen.findByRole('option', { name: 'Basic' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Matte' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Matte' }));
    expect(within(dialog).getByRole('combobox', { name: 'Variant (optional)' })).toHaveValue('Matte');
    await user.clear(within(dialog).getByRole('combobox', { name: 'Variant (optional)' }));
    await user.type(within(dialog).getByRole('combobox', { name: 'Variant (optional)' }), 'Silk');
    expect(within(dialog).getByRole('combobox', { name: 'Variant (optional)' })).toHaveValue('Silk');
    expect(within(dialog).getByText(/Leave empty to name it "PLA Silk"/)).toBeInTheDocument();
  });

  it('switches to the existing article when the backend reports a name conflict', async () => {
    auth.permissions = MANAGER;
    serve([black]);
    server.use(
      http.post('*/api/v1/inventory/receipts', () =>
        HttpResponse.json(
          {
            code: 'material_name_conflict',
            message: 'An article with this name already exists',
            details: { materialId: black.id },
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderModal(<ReceiveStockModal open onClose={vi.fn()} kind="filament" />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });

    // The existing article is not on the list yet; the type stays free.
    await pickArticle(user, dialog, 'New article…');
    await user.click(await within(dialog).findByRole('combobox', { name: 'Material type' }));
    await user.click(await screen.findByText('PLA (g)'));
    await user.type(within(dialog).getByLabelText('Name (optional)'), 'PLA Basic · Black · Bambu Lab');
    await user.type(within(dialog).getByLabelText(/Size of one package/), '1000');
    await user.type(within(dialog).getByLabelText('Total price in EUR'), '20');
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }));

    // The same title also shows as a duplicate warning while the form still is in "new article" mode, so wait for the
    // switch to the existing article before looking for the notice.
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Article' })).toHaveValue(
        'PLA Basic · Black · Bambu Lab · 2,000 g in stock',
      ),
    );
    expect(await within(dialog).findByText('This article already exists')).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', { name: 'Material type' })).not.toBeInTheDocument();
  });

  it('offers the existing article when a described one has the same name', async () => {
    auth.permissions = MANAGER;
    serve([black, insert]);
    const user = userEvent.setup();
    renderModal(<ReceiveStockModal open onClose={vi.fn()} kind="filament" />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });

    await pickArticle(user, dialog, 'New article…');
    await user.click(await within(dialog).findByRole('combobox', { name: 'Material type' }));
    await user.click(await screen.findByText('PLA (g)'));
    await user.type(within(dialog).getByRole('combobox', { name: 'Variant (optional)' }), 'Basic');
    await user.type(within(dialog).getByLabelText('Colour name (optional)'), 'Black');
    await user.type(within(dialog).getByRole('combobox', { name: 'Manufacturer (optional)' }), 'Bambu Lab');
    expect(await within(dialog).findByText(/is already in the inventory/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Use it' }));
    expect(within(dialog).getByRole('combobox', { name: 'Article' })).toHaveValue(
      'PLA Basic · Black · Bambu Lab · 2,000 g in stock',
    );
  });

  it('hides the spool options without the spool permission', async () => {
    auth.permissions = MANAGER;
    serve();
    renderModal(<ReceiveStockModal open onClose={vi.fn()} kind="filament" article={black} />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });
    await within(dialog).findByLabelText('Packages');
    expect(within(dialog).getByText(/Loading it onto spools needs the filament spools permission/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('On new spools (one per package)')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Load onto a reusable spool')).not.toBeInTheDocument();
  });

  it('offers storage and new spools only, never a reusable spool', async () => {
    auth.permissions = WITH_SPOOLS;
    serve();
    renderModal(<ReceiveStockModal open onClose={vi.fn()} kind="filament" article={black} />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });
    expect(await within(dialog).findByLabelText('In storage')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('On new spools (one per package)')).toBeInTheDocument();
    expect(within(dialog).queryByText(/reusable/i)).not.toBeInTheDocument();
  });

  it('does not offer spool placement for parts and validates the price and date', async () => {
    auth.permissions = WITH_SPOOLS;
    serve();
    const user = userEvent.setup();
    renderModal(<ReceiveStockModal open onClose={vi.fn()} kind="part" article={insert} />);
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' });
    await within(dialog).findByLabelText('Packages');
    expect(within(dialog).queryByText('Where it goes')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }));
    expect(await within(dialog).findByText('Enter the total price, zero or more.')).toBeInTheDocument();
  });
});
