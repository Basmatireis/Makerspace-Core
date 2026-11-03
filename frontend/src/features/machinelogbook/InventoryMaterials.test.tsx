import type { ReactElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DeleteInventoryTransactionRequest,
  InventoryRecycleBin,
  Material,
  VersionRequest,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { testQueryClient } from '../../test/render';
import { server } from '../../test/server';
import { InventoryPage } from './InventoryPage';
import { iconButton, invId, material, page, part, partType, plaType, spool, transaction } from './inventoryTestData';
import { MaterialDetailPage } from './MaterialDetailPage';
import { machineLogbookPaths } from './shared/paths';
import { ToastProvider } from './shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const READ = [PermissionId.inventoryread];
const MANAGE = [...READ, PermissionId.inventorymanage, PermissionId.filament_spoolsmanage];
const ALL = [...MANAGE, PermissionId.inventorydelete, PermissionId.inventoryledgerdelete];

const blue = material({ attention: [] });
const low = material({
  id: invId(12),
  displayId: 'A-0003',
  name: 'PETG Basic · Black · Bambu Lab',
  materialTypeName: 'PETG',
  materialTypeCode: 'PETG',
  colorName: 'Black',
  colorHex: '#1C1C1C',
  quantity: '300',
  assignedQuantity: '0',
  unassignedQuantity: '300',
  stockState: 'low_stock',
  notes: 'Ask before ordering.',
  attention: [{ code: 'low_stock', message: 'Low stock · 300 g left, minimum 500 g' }],
});
const insert = part();
const purchase = transaction();
const consumption = transaction({
  id: invId(61),
  kind: 'machine_run_consumption',
  quantityDelta: '-37',
  inventoryValueDelta: '-0.74',
  totalPurchasePrice: null,
  supplier: null,
  occurredAt: '2026-11-01T09:00:00Z',
  machineJobDisplayId: 'J-2026-000412',
  spoolId: invId(20),
  spoolDisplayId: 'S-PLA-BASIC-DARK BLUE-01',
});

const originalMatchMedia = window.matchMedia;
function panelFits(fits: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: fits && query === '(min-width: 66rem)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

const emptyBin: InventoryRecycleBin = { materials: [], spools: [], ledgerEntries: [] };

function serve({
  materials = [blue, low, insert],
  bin = emptyBin,
}: { materials?: Material[]; bin?: InventoryRecycleBin } = {}) {
  server.use(
    http.get('*/api/v1/materials', () => HttpResponse.json({ ...page(materials), totalInventoryValue: '61.04' })),
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [plaType, partType] })),
    http.get('*/api/v1/filament-spools', () => HttpResponse.json(page([spool()]))),
    http.get('*/api/v1/materials/:id/transactions', () => HttpResponse.json(page([purchase, consumption]))),
    http.get('*/api/v1/inventory/recycle-bin', () => HttpResponse.json(bin)),
    http.get('*/api/v1/inventory/suggestions', () =>
      HttpResponse.json({ variants: [], manufacturers: [], suppliers: [], storageLocations: [] }),
    ),
  );
}

function renderAt(route: string, extra: { path: string; element: ReactElement }[] = []) {
  const router = createMemoryRouter(
    [
      { path: '/workshop/inventory', element: <InventoryPage /> },
      { path: '/workshop/inventory/materials/:materialId', element: <MaterialDetailPage /> },
      ...extra,
    ],
    { initialEntries: [route] },
  );
  render(
    <QueryClientProvider client={testQueryClient()}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('Inventory page', () => {
  it('keeps the tab in the URL, sends former tab names to Materials and offers the recycle bin', async () => {
    auth.permissions = READ;
    serve();
    const user = userEvent.setup();
    const router = renderAt('/workshop/inventory?tab=filament');
    expect(await screen.findByRole('table', { name: 'Articles' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?tab=articles');
    await user.click(screen.getByRole('tab', { name: 'Recycle bin' }));
    expect(await screen.findByText('No deleted articles')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?tab=bin');
  });

  it('lists articles with number, stock split, low stock and the attention flag', async () => {
    auth.permissions = READ;
    serve();
    renderAt('/workshop/inventory');
    const table = await screen.findByRole('table', { name: 'Articles' });
    const row = within(table).getByRole('link', { name: blue.name }).closest('tr') as HTMLElement;
    expect(within(row).getByText('A-0001')).toBeInTheDocument();
    expect(within(row).getByText('1,612 g')).toBeInTheDocument();
    expect(await within(row).findByText('1 spool · 1,000 g loose')).toBeInTheDocument();
    const lowRow = within(table).getByRole('link', { name: low.name }).closest('tr') as HTMLElement;
    expect(within(lowRow).getByText(/300 g loose · low/)).toBeInTheDocument();
    expect(within(lowRow).getByText('Low stock · 300 g left, minimum 500 g')).toBeInTheDocument();
    // Parts have their own tab; readers get no stock actions.
    expect(within(table).getByText(insert.name)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive stock' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New article' })).not.toBeInTheDocument();
  });

  it('shows the selected article in the panel with prices, spools and the latest ledger entries', async () => {
    auth.permissions = MANAGE;
    panelFits(true);
    serve();
    const user = userEvent.setup();
    const router = renderAt('/workshop/inventory');
    expect(await screen.findByText(/Select an article to see its stock/)).toBeInTheDocument();
    await user.click(await screen.findByRole('link', { name: blue.name }));
    expect(router.state.location.search).toContain(`selected=${blue.id}`);
    const panel = await screen.findByRole('complementary', { name: 'Article details' });
    expect(within(panel).getByRole('heading', { name: 'PLA Basic' })).toBeInTheDocument();
    expect(within(panel).getByText('A-0001 · Shelf B2')).toBeInTheDocument();
    expect(within(panel).getByText('Members')).toBeInTheDocument();
    expect(within(panel).getByText('€40.00 / kg')).toBeInTheDocument();
    expect(within(panel).getByText('Material type rate')).toBeInTheDocument();
    expect(await within(panel).findByRole('link', { name: 'S-PLA-BASIC-DARK BLUE-01' })).toBeInTheDocument();
    expect(await within(panel).findByText('Run consumption')).toBeInTheDocument();
    expect(within(panel).getByText('−37 g')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Open article' })).toHaveAttribute(
      'href',
      machineLogbookPaths.material(blue.id),
    );
    await user.click(iconButton(panel, 'Close panel'));
    expect(router.state.location.search).not.toContain('selected=');
  });

  it('opens the article page from a row on narrow screens', async () => {
    auth.permissions = READ;
    panelFits(false);
    serve();
    server.use(http.get(`*/api/v1/materials/${blue.id}`, () => HttpResponse.json(blue)));
    const user = userEvent.setup();
    const router = renderAt('/workshop/inventory');
    const table = await screen.findByRole('table', { name: 'Articles' });
    await user.click(
      within(within(table).getByRole('link', { name: blue.name }).closest('tr') as HTMLElement).getByText('Shelf B2'),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(machineLogbookPaths.material(blue.id)));
  });

  it('edits an article without price fields and points to Pricing', async () => {
    auth.permissions = MANAGE;
    panelFits(true);
    serve();
    const user = userEvent.setup();
    renderAt(`/workshop/inventory?selected=${blue.id}`);
    const panel = await screen.findByRole('complementary', { name: 'Article details' });
    await user.click(within(panel).getByRole('img', { name: 'More article actions' }));
    await user.click(await screen.findByText('Edit article'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit article' });
    expect(within(dialog).queryByLabelText(/Sale price/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Sales → Pricing' })).toHaveAttribute('href', '/pricing');
  });
});

describe('Article page', () => {
  const serveArticle = (item: Material) => {
    serve();
    server.use(http.get(`*/api/v1/materials/${item.id}`, () => HttpResponse.json(item)));
  };

  it('shows figures, prices, spools and the ledger, and no actions for readers', async () => {
    auth.permissions = READ;
    serveArticle(low);
    renderAt(machineLogbookPaths.material(low.id));
    expect(await screen.findByRole('heading', { name: low.name })).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Ask before ordering.')).toBeInTheDocument();
    expect(screen.getByText('€40.00 / kg')).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Ledger' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Spools' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive stock' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'More article actions' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Delete run consumption/)).not.toBeInTheDocument();
  });

  it('moves the article to the recycle bin with its version (inventory.delete)', async () => {
    auth.permissions = [...READ, PermissionId.inventorydelete];
    serveArticle(blue);
    let sent: VersionRequest | undefined;
    server.use(
      http.delete(`*/api/v1/materials/${blue.id}`, async ({ request }) => {
        sent = (await request.json()) as VersionRequest;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    const router = renderAt(machineLogbookPaths.material(blue.id));
    await user.click(await screen.findByRole('img', { name: 'More article actions' }));
    expect(screen.queryByText('Edit article')).not.toBeInTheDocument();
    await user.click(await screen.findByText('Delete article'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete article?' });
    expect(within(dialog).getByText(/It moves to the recycle bin/)).toBeInTheDocument();
    expect(
      await within(dialog).findByText(/Its spool goes along with it; the mounted spool is unmounted/),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Delete article' }));
    await waitFor(() => expect(sent).toEqual({ expectedVersion: blue.version }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/workshop/inventory'));
  });

  it('deletes a ledger entry with the inventory version only with inventory.ledger.delete', async () => {
    auth.permissions = [...READ, PermissionId.inventoryledgerdelete];
    serveArticle(blue);
    let sent: DeleteInventoryTransactionRequest | undefined;
    server.use(
      http.delete(`*/api/v1/inventory/ledger/${consumption.id}`, async ({ request }) => {
        sent = (await request.json()) as DeleteInventoryTransactionRequest;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderAt(machineLogbookPaths.material(blue.id));
    const ledger = await screen.findByRole('table', { name: 'Ledger' });
    await within(ledger).findByText(/J-2026-000412/);
    await user.click(iconButton(ledger, /^Delete run consumption/));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete ledger entry?' });
    expect(within(dialog).getByText('The stock changes by +37 g.')).toBeInTheDocument();
    expect(within(dialog).getByText(/The run keeps its material line/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));
    await waitFor(() => expect(sent).toEqual({ expectedInventoryVersion: blue.inventoryVersion }));
  });
});

describe('Inventory recycle bin', () => {
  const bin: InventoryRecycleBin = {
    materials: [
      {
        id: invId(70),
        displayId: 'A-0014',
        name: 'PLA Basic · Light Grey · Prusament',
        kind: 'filament',
        materialTypeName: 'PLA',
        unit: 'g',
        quantity: '250',
        spoolCount: 1,
        deletedAt: '2026-10-29T10:00:00Z',
        deletedByName: 'Lena Hofer',
        version: 6,
      },
    ],
    spools: [
      spool({
        id: invId(71),
        displayId: 'S-PETG-BASIC-BLACK-01',
        materialName: 'PETG Basic · Black · Bambu Lab',
        lifecycle: 'archived',
        mounted: false,
        mountedOn: null,
        archivedAt: '2026-10-28T12:00:00Z',
        retiredOutcome: 'empty',
        retiredQuantity: '0',
        retiredByName: 'Tobias Reiter',
        version: 3,
      }),
    ],
    ledgerEntries: [
      {
        transaction: transaction({
          id: invId(72),
          kind: 'order_sale',
          quantityDelta: '-85',
          orderReference: 'O-2026-0097',
        }),
        materialName: blue.name,
        materialDisplayId: blue.displayId,
        unit: 'g',
        deletedAt: '2026-10-31T08:00:00Z',
        deletedByName: 'Lena Hofer',
      },
    ],
  };

  it('lists deleted articles, retired spools and ledger entries and restores an article', async () => {
    auth.permissions = ALL;
    serve({ bin });
    let restored: VersionRequest | undefined;
    server.use(
      http.post(`*/api/v1/inventory/recycle-bin/materials/${invId(70)}/restore`, async ({ request }) => {
        restored = (await request.json()) as VersionRequest;
        return HttpResponse.json(blue);
      }),
    );
    const user = userEvent.setup();
    renderAt('/workshop/inventory?tab=bin');
    const articles = await screen.findByRole('table', { name: 'Deleted articles' });
    expect(within(articles).getByText('PLA Basic · Light Grey · Prusament')).toBeInTheDocument();
    expect(within(articles).getByText('by Lena Hofer')).toBeInTheDocument();
    const spools = screen.getByRole('table', { name: 'Retired spools' });
    expect(within(spools).getByText('Ran empty')).toBeInTheDocument();
    const ledger = screen.getByRole('table', { name: 'Deleted ledger entries' });
    expect(within(ledger).getByText('Sold (order) · −85 g')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'jobs recycle bin' })).toHaveAttribute('href', '/workshop/jobs?tab=bin');

    await user.click(within(articles).getByRole('button', { name: /^Restore A-0014/ }));
    const dialog = await screen.findByRole('dialog', { name: /Restore A-0014/ });
    expect(within(dialog).getByText(/comes back unchanged with 250 g in stock and its spool/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restored).toEqual({ expectedVersion: 6 }));
  });

  it('deletes a retired spool permanently after confirmation', async () => {
    auth.permissions = ALL;
    serve({ bin });
    let purged: VersionRequest | undefined;
    server.use(
      http.delete(`*/api/v1/inventory/recycle-bin/spools/${invId(71)}/purge`, async ({ request }) => {
        purged = (await request.json()) as VersionRequest;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderAt('/workshop/inventory?tab=bin');
    const spools = await screen.findByRole('table', { name: 'Retired spools' });
    await user.click(iconButton(spools, 'Delete S-PETG-BASIC-BLACK-01 permanently'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete S-PETG-BASIC-BLACK-01 permanently?' });
    expect(within(dialog).getByText('This cannot be undone.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(purged).toEqual({ expectedVersion: 3 }));
  });

  it('offers each action only to the permission that guards it', async () => {
    auth.permissions = [...READ, PermissionId.inventoryledgerdelete];
    serve({ bin });
    renderAt('/workshop/inventory?tab=bin');
    const articles = await screen.findByRole('table', { name: 'Deleted articles' });
    expect(within(articles).queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument();
    const spools = screen.getByRole('table', { name: 'Retired spools' });
    expect(within(spools).queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument();
    expect(within(spools).queryByText(/permanently/)).not.toBeInTheDocument();
    const ledger = screen.getByRole('table', { name: 'Deleted ledger entries' });
    expect(within(ledger).getByRole('button', { name: /^Restore Sold/ })).toBeInTheDocument();
  });

  it('offers every variant while the field shows the current one and filters once typed into', async () => {
    auth.permissions = MANAGE;
    panelFits(true);
    serve();
    const variant = (n: number, name: string) => ({
      id: invId(60 + n),
      materialTypeId: plaType.id,
      name,
      materialCount: 0,
      pricingRuleCount: 0,
    });
    server.use(
      http.get('*/api/v1/material-types', () =>
        HttpResponse.json({
          items: [{ ...plaType, variants: [variant(1, 'Basic'), variant(2, 'Matte')] }, partType],
        }),
      ),
    );
    const user = userEvent.setup();
    renderAt(`/workshop/inventory?selected=${blue.id}`);
    const panel = await screen.findByRole('complementary', { name: 'Article details' });
    await user.click(within(panel).getByRole('img', { name: 'More article actions' }));
    await user.click(await screen.findByText('Edit article'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit article' });
    const input = await within(dialog).findByRole('combobox', { name: /Variant/ });
    expect(input).toHaveValue('Basic');
    await user.click(input);
    expect(await screen.findByRole('option', { name: 'Matte' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Basic' })).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'Mat');
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Basic' })).not.toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Matte' })).toBeInTheDocument();
  });
});
