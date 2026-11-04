import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CorrectSpoolStockRequest,
  CreateFilamentSpoolRequest,
  DetectedSpoolTag,
  FilamentSpool,
  MountSpoolRequest,
  RetireFilamentSpoolRequest,
  VersionRequest,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { renderRoute, testQueryClient } from '../../test/render';
import { server } from '../../test/server';
import { InventorySpoolsTable } from './components/InventorySpoolsTable';
import { FilamentSpoolDetailPage } from './FilamentSpoolDetailPage';
import { detectedTag, invId, material, page, plaType, spool, transaction } from './inventoryTestData';
import { ToastProvider } from './shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const READ = [PermissionId.inventoryread, PermissionId.machinesread];
const MANAGE = [
  ...READ,
  PermissionId.inventorymanage,
  PermissionId.filament_spoolsmanage,
  PermissionId.printer_slotsassign,
  PermissionId.inventorydelete,
];

const blue = material();
const stored = spool({
  id: invId(21),
  displayId: 'S-PLA-BASIC-DARK BLUE-02',
  remainingQuantity: '60',
  mounted: false,
  mountedOn: null,
  identifiers: [],
  attention: [{ code: 'remainder_low', message: 'Almost empty · 60 g left' }],
  version: 2,
});
const mounted = spool();

const originalMatchMedia = window.matchMedia;
/** Pretends the viewport is wide enough (or not) for the list-and-panel layout. */
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

function serve({
  spools = [mounted, stored],
  detected = [] as DetectedSpoolTag[],
}: { spools?: FilamentSpool[]; detected?: DetectedSpoolTag[] } = {}) {
  server.use(
    http.get('*/api/v1/filament-spools', () => HttpResponse.json(page(spools))),
    http.get('*/api/v1/materials', () => HttpResponse.json({ ...page([blue]), totalInventoryValue: '32.24' })),
    http.get('*/api/v1/materials/:id', () => HttpResponse.json(blue)),
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [plaType] })),
    http.get('*/api/v1/printers/detected-spool-tags', () => HttpResponse.json({ items: detected })),
    http.get('*/api/v1/filament-spools/:id/transactions', () =>
      HttpResponse.json(
        page([
          transaction({
            id: invId(61),
            kind: 'machine_run_consumption',
            quantityDelta: '-37',
            spoolId: mounted.id,
            spoolDisplayId: mounted.displayId,
            machineJobDisplayId: 'J-2026-000412',
            totalPurchasePrice: null,
            supplier: null,
          }),
        ]),
      ),
    ),
    http.get('*/api/v1/inventory/suggestions', () =>
      HttpResponse.json({ variants: [], manufacturers: [], suppliers: [], storageLocations: [] }),
    ),
  );
}

const renderTab = () =>
  renderRoute(
    <ToastProvider>
      <InventorySpoolsTable />
    </ToastProvider>,
    '/workshop/inventory?tab=spools',
  );

describe('Spools tab', () => {
  it('lists active spools with label, article, remainder, mount, tag and attention', async () => {
    auth.permissions = READ;
    serve();
    renderTab();
    const table = await screen.findByRole('table', { name: 'Spools' });
    const row = within(table).getByRole('link', { name: 'S-PLA-BASIC-DARK BLUE-01' }).closest('tr') as HTMLElement;
    expect(within(row).getByText('PLA Basic · Dark Blue · Bambu Lab')).toBeInTheDocument();
    expect(within(row).getByText(/612 g/)).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'H2D · AMS 1 · Slot 1' })).toBeInTheDocument();
    expect(within(row).getByText('7A3F19C2')).toBeInTheDocument();
    const low = within(table).getByRole('link', { name: 'S-PLA-BASIC-DARK BLUE-02' }).closest('tr') as HTMLElement;
    expect(within(low).getByText('No tag')).toBeInTheDocument();
    expect(within(low).getByText('Almost empty · 60 g left')).toBeInTheDocument();
    // Readers neither register nor receive.
    expect(screen.queryByRole('button', { name: 'Register spool' })).not.toBeInTheDocument();
  });

  it('shows unregistered detected tags with the suggested article and registers one with mount', async () => {
    auth.permissions = MANAGE;
    const tag = detectedTag();
    serve({
      detected: [tag, detectedTag({ tagUid: 'KNOWN', spool: { id: mounted.id, displayId: mounted.displayId } })],
    });
    let created: CreateFilamentSpoolRequest | undefined;
    let mountedBody: MountSpoolRequest | undefined;
    server.use(
      http.post('*/api/v1/filament-spools', async ({ request }) => {
        created = (await request.json()) as CreateFilamentSpoolRequest;
        return HttpResponse.json(spool({ id: invId(25), displayId: 'S-PLA-BASIC-DARK BLUE-03', mounted: false }), {
          status: 201,
        });
      }),
      http.post('*/api/v1/printer-slots/:slotId/mount', async ({ request, params }) => {
        mountedBody = (await request.json()) as MountSpoolRequest;
        expect(params.slotId).toBe(tag.slotId);
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderTab();
    const strip = await screen.findByRole('region', { name: 'Detected by printers, not registered' });
    expect(within(strip).getByText('A1C4D77E')).toBeInTheDocument();
    expect(within(strip).queryByText('KNOWN')).not.toBeInTheDocument();
    expect(within(strip).getByText('Match')).toBeInTheDocument();
    expect(within(strip).queryByRole('button', { name: /ignore/i })).not.toBeInTheDocument();
    await user.click(within(strip).getByRole('button', { name: 'Register' }));

    const dialog = await screen.findByRole('dialog', { name: 'Detected in H2D · AMS 1 · Slot 2' });
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Article' })).toHaveValue(
        'A-0001 · PLA Basic · Dark Blue · Bambu Lab · 1,000 g loose',
      ),
    );
    expect(within(dialog).getByLabelText('RFID tag UID (optional)')).toHaveValue('A1C4D77E');
    expect(within(dialog).getByLabelText('Filament on the spool in g (net)')).toHaveValue('680');
    await user.click(within(dialog).getByRole('button', { name: 'Register and mount' }));

    await waitFor(() => expect(mountedBody).toEqual({ spoolId: invId(25) }));
    expect(created).toMatchObject({
      materialId: blue.id,
      initialNetWeightG: '680',
      stockMode: 'existing_stock',
      expectedInventoryVersion: blue.inventoryVersion,
      identifiers: [{ kind: 'nfc', value: 'A1C4D77E' }],
    });
    expect(created).not.toHaveProperty('totalPrice');
  });

  it('registers a purchased spool with its price when the article has no loose stock', async () => {
    auth.permissions = MANAGE;
    serve();
    server.use(
      http.get('*/api/v1/materials', () =>
        HttpResponse.json({
          ...page([{ ...blue, unassignedQuantity: '0', quantity: '612' }]),
          totalInventoryValue: '12',
        }),
      ),
    );
    let created: CreateFilamentSpoolRequest | undefined;
    server.use(
      http.post('*/api/v1/filament-spools', async ({ request }) => {
        created = (await request.json()) as CreateFilamentSpoolRequest;
        return HttpResponse.json(spool({ id: invId(26) }), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Register spool' }));
    const dialog = await screen.findByRole('dialog', { name: 'Register spool' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Article' }));
    await user.click(await screen.findByRole('option', { name: /A-0001 · PLA Basic/ }));
    expect(within(dialog).getByRole('radio', { name: /From loose stock/ })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Price in EUR'), '19.99');
    expect(within(dialog).getByText(/Spool S-PLA-BASIC-DARK BLUE-NN with 1,000 g booked as a purchase/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Register spool' }));
    await waitFor(() =>
      expect(created).toMatchObject({
        materialId: blue.id,
        stockMode: 'new_acquisition',
        totalPrice: '19.99',
        initialNetWeightG: '1000',
      }),
    );
  });

  it('selects a row into the panel on wide screens and retires the spool from there', async () => {
    auth.permissions = MANAGE;
    panelFits(true);
    serve();
    let retired: RetireFilamentSpoolRequest | undefined;
    server.use(
      http.post('*/api/v1/filament-spools/:id/retire', async ({ request }) => {
        retired = (await request.json()) as RetireFilamentSpoolRequest;
        return HttpResponse.json(stored);
      }),
    );
    const user = userEvent.setup();
    renderTab();
    expect(await screen.findByText(/Select a spool to see where it is/)).toBeInTheDocument();
    await user.click(await screen.findByRole('link', { name: 'S-PLA-BASIC-DARK BLUE-01' }));
    const panel = await screen.findByRole('complementary', { name: 'Spool details' });
    expect(within(panel).getByText('61 % of 1,000 g')).toBeInTheDocument();
    expect(within(panel).getByText('mounted, RFID tag')).toBeInTheDocument();
    expect(await within(panel).findByText(/J-2026-000412/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Open spool' })).toHaveAttribute(
      'href',
      `/workshop/inventory/spools/${mounted.id}`,
    );

    await user.click(within(panel).getByRole('img', { name: 'More spool actions' }));
    await user.click(await screen.findByText('Retire'));
    const dialog = await screen.findByRole('alertdialog', { name: /Retire S-PLA-BASIC-DARK BLUE-01/ });
    expect(within(dialog).getByText(/unmounted from H2D · AMS 1 · Slot 1/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: /The rest was thrown away/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Write off 612 g' }));
    await waitFor(() => expect(retired).toEqual({ expectedVersion: mounted.version, outcome: 'discarded' }));
  });

  it('opens the spool page from a row on narrow screens', async () => {
    auth.permissions = READ;
    panelFits(false);
    serve();
    const user = userEvent.setup();
    const { router } = renderTab();
    const table = await screen.findByRole('table', { name: 'Spools' });
    await user.click(within(table).getAllByText('Mounted')[0]);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workshop/inventory/spools/${mounted.id}`));
  });
});

function renderPageAt(spoolId: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/workshop/inventory/spools/:spoolId',
        element: (
          <ToastProvider>
            <FilamentSpoolDetailPage />
          </ToastProvider>
        ),
      },
    ],
    { initialEntries: [`/workshop/inventory/spools/${spoolId}`] },
  );
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const renderPage = (target: FilamentSpool) => {
  server.use(http.get(`*/api/v1/filament-spools/${target.id}`, () => HttpResponse.json(target)));
  return renderPageAt(target.id);
};

describe('Spool page', () => {
  it('weighs the spool and books the difference as an inventory count', async () => {
    auth.permissions = MANAGE;
    serve();
    let correction: CorrectSpoolStockRequest | undefined;
    server.use(
      http.post('*/api/v1/filament-spools/:id/corrections', async ({ request }) => {
        correction = (await request.json()) as CorrectSpoolStockRequest;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderPage(mounted);
    expect(await screen.findByRole('heading', { name: 'S-PLA-BASIC-DARK BLUE-01' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Weigh' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'S-PLA-BASIC-DARK BLUE-01 · PLA Basic · Dark Blue · Bambu Lab',
    });
    expect(within(dialog).getByLabelText('Tare in g')).toHaveValue('250');
    await user.type(within(dialog).getByLabelText('Gross weight in g'), '800');
    expect(within(dialog).getByText(/a correction of −62 g/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(correction).toMatchObject({
        physicalQuantity: '550',
        reason: 'inventory_count',
        expectedInventoryVersion: blue.inventoryVersion,
        expectedSpoolVersion: mounted.version,
      }),
    );
  });

  it('suggests weighing or retiring a spool that ran out during a print, by permission', async () => {
    const ranOut = spool({
      id: invId(31),
      mounted: false,
      mountedOn: null,
      attention: [{ code: 'ran_out_during_run', message: 'Ran out during RN-2026-000007 · Core still holds 12 g' }],
    });
    auth.permissions = MANAGE;
    serve();
    const user = userEvent.setup();
    const view = renderPage(ranOut);
    const notice = await screen.findByText(/Core still holds 12 g/);
    const banner = notice.closest('[role="status"]') as HTMLElement;
    expect(within(banner).getByRole('button', { name: 'Weigh' })).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Retire' }));
    expect(await screen.findByRole('alertdialog', { name: /Retire/ })).toBeInTheDocument();
    view.unmount();

    auth.permissions = READ;
    renderPage(ranOut);
    const readOnly = (await screen.findByText(/Core still holds 12 g/)).closest('[role="status"]') as HTMLElement;
    expect(within(readOnly).queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers Restore and Delete permanently for a retired spool', async () => {
    auth.permissions = MANAGE;
    serve();
    let restored: VersionRequest | undefined;
    server.use(
      http.post('*/api/v1/inventory/recycle-bin/spools/:id/restore', async ({ request }) => {
        restored = (await request.json()) as VersionRequest;
        return HttpResponse.json(mounted);
      }),
    );
    const retired = spool({
      lifecycle: 'archived',
      mounted: false,
      mountedOn: null,
      archivedAt: '2026-10-28T12:00:00Z',
      retiredOutcome: 'discarded',
      retiredQuantity: '40',
      retiredByName: 'Lena Hofer',
      remainingQuantity: '0',
      version: 9,
    });
    const user = userEvent.setup();
    renderPage(retired);
    expect(await screen.findByText(/40 g thrown away/, { selector: 'div' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Weigh' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('img', { name: 'More spool actions' }));
    expect(await screen.findByText('Delete permanently')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog', { name: /Restore S-PLA-BASIC-DARK BLUE-01/ });
    expect(within(dialog).getByText('The 40 g written off come back as stock.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restored).toEqual({ expectedVersion: 9 }));
  });

  it('gives readers no actions and explains a spool that no longer exists', async () => {
    auth.permissions = READ;
    serve();
    server.use(
      http.get(`*/api/v1/filament-spools/${invId(99)}`, () =>
        HttpResponse.json({ code: 'not_found', message: 'Not found.' }, { status: 404 }),
      ),
    );
    renderPageAt(invId(99));
    expect(await screen.findByText('This spool does not exist')).toBeInTheDocument();
  });
});
