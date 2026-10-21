import type { ReactElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChangeFilamentSpoolFillRequest,
  CleanUpFilamentSpoolsRequest,
  CreateFilamentSpoolRequest,
  FilamentSpool,
  FinishFilamentSpoolRequest,
  Material,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { renderRoute, testQueryClient } from '../../test/render';
import { server } from '../../test/server';
import { ChangeFilamentModal } from './dialogs/ChangeFilamentModal';
import { CleanupSpoolsModal } from './dialogs/CleanupSpoolsModal';
import { FinishSpoolModal } from './dialogs/FinishSpoolModal';
import { SpoolFormModal } from './dialogs/SpoolFormModal';
import { InventorySpoolsTable } from './components/InventorySpoolsTable';
import { FilamentSpoolDetailPage } from './FilamentSpoolDetailPage';
import { ToastProvider } from './shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const BOTH = [PermissionId.inventoryread, PermissionId.filament_spoolsmanage, PermissionId.inventorymanage];

const id = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e8b${String(n).padStart(3, '0')}`;
const materialId = id(1);
const nfcId = id(10);
const barcodeId = id(11);

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
  lowStockThreshold: null,
  quantity: '5000',
  assignedQuantity: '600',
  unassignedQuantity: '4400',
  filamentDiameterMm: '1.75',
  averageUnitCost: '0.02',
  inventoryValue: '100',
  stockState: 'in_stock',
  inventoryVersion: 7,
  recentConsumption: '0',
  version: 3,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const spool = (overrides: Partial<FilamentSpool> = {}): FilamentSpool => ({
  id: id(20),
  displayId: 'S-2026-000001',
  kind: 'reusable',
  label: 'Bambu spool 01',
  status: 'loaded',
  fillNumber: 3,
  fillId: id(30),
  filledAt: '2026-10-02T08:00:00Z',
  archivedAt: null,
  materialId,
  materialName: 'PLA Black',
  materialTypeName: 'PLA',
  colorName: 'Black',
  colorHex: '#1A1A1A',
  unit: 'g',
  manufacturer: 'Bambu Lab',
  productName: 'PLA Basic Black',
  initialNetWeightG: '1000',
  remainingQuantity: '600',
  tareWeightG: '200',
  acquiredOn: '2026-09-01',
  acquisitionReference: null,
  storageLocation: 'Shelf A',
  notes: null,
  lifecycle: 'active',
  mounted: false,
  identifiers: [
    { id: nfcId, kind: 'nfc', value: '04AA11', createdAt: '2026-10-02T08:00:00Z' },
    { id: barcodeId, kind: 'barcode', value: 'BC-100', createdAt: '2026-09-01T08:00:00Z' },
  ],
  fills: [],
  version: 5,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-10-02T08:00:00Z',
  ...overrides,
});

const mountedOn = {
  machineId: id(40),
  machineName: 'Bambu H2D #1',
  inputUnitName: 'AMS A',
  slotId: id(41),
  slotName: 'Slot 3',
};

const page = <T,>(items: T[]) => ({ items, page: 1, pageSize: 100, total: items.length });

function useCatalog(spools: FilamentSpool[] = [spool()]) {
  server.use(
    http.get('*/api/v1/filament-spools', () => HttpResponse.json(page(spools))),
    http.get('*/api/v1/materials', () => HttpResponse.json({ ...page([material]), totalInventoryValue: '100' })),
  );
}

function renderModal(ui: ReactElement) {
  return renderRoute(<ToastProvider>{ui}</ToastProvider>);
}

describe('Change filament', () => {
  it('walks the steps and sends the weighed leftover, the loose-stock fill and the kept and new tags', async () => {
    auth.permissions = BOTH;
    useCatalog();
    let body: ChangeFilamentSpoolFillRequest | undefined;
    server.use(
      http.post(`*/api/v1/filament-spools/${id(20)}/fills`, async ({ request }) => {
        body = (await request.json()) as ChangeFilamentSpoolFillRequest;
        return HttpResponse.json(spool({ fillNumber: 4 }));
      }),
    );
    const user = userEvent.setup();
    renderModal(<ChangeFilamentModal open onClose={vi.fn()} spool={spool()} />);

    // The spool is preselected, so the dialog opens on the leftover step.
    const dialog = await screen.findByRole('dialog', { name: 'Change filament' });
    await user.click(await within(dialog).findByLabelText('Weigh the spool'));
    await user.type(within(dialog).getByLabelText(/Weight of the spool with filament/), '850');
    expect(
      within(dialog).getByText('Leftover 650 g (system expected 600 g, difference +50 g recorded as correction).'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));

    // New filament: the spool's current filament is preselected.
    expect(await within(dialog).findByLabelText('Net weight of the new filament (g)')).toHaveValue('1000');
    expect(
      within(dialog).getByText(
        /Moves 1,000 g from loose stock to this spool\. The material total stays 5,050 g\. 5,050 g of loose stock is available\./,
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));

    // Tags: the barcode is kept, the NFC tag is not; one new NFC tag is added.
    expect(await within(dialog).findByLabelText('Barcode BC-100')).toBeChecked();
    expect(within(dialog).getByLabelText('NFC tag 04AA11')).not.toBeChecked();
    await user.type(within(dialog).getByLabelText('Value'), '04BB22');
    expect(within(dialog).getByText('Close fill 3')).toBeInTheDocument();
    expect(within(dialog).getByText('Start fill 4')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      leftover: { basis: 'weighed', grossWeightG: '850', disposition: 'returned_to_stock' },
      fill: {
        materialId,
        manufacturer: 'Bambu Lab',
        productName: 'PLA Basic Black',
        netWeightG: '1000',
        source: 'loose_stock',
        totalPrice: null,
        supplier: null,
      },
      keepIdentifierIds: [barcodeId],
      newIdentifiers: [{ kind: 'nfc', value: '04BB22' }],
      occurredAt: expect.any(String),
      expectedVersion: 5,
    });
    expect(await screen.findByText('S-2026-000001 refilled with PLA Black (fill 4)')).toBeInTheDocument();
  });

  it('validates each step before moving on', async () => {
    auth.permissions = BOTH;
    useCatalog();
    const user = userEvent.setup();
    renderModal(<ChangeFilamentModal open onClose={vi.fn()} spool={spool()} />);
    const dialog = await screen.findByRole('dialog', { name: 'Change filament' });

    await user.click(await within(dialog).findByLabelText('Weigh the spool'));
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByText('Enter the weight of the spool.')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Net weight of the new filament (g)')).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/Weight of the spool with filament/), '100');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByText('The spool cannot weigh less than its empty weight.')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/Weight of the spool with filament/));
    await user.type(within(dialog).getByLabelText(/Weight of the spool with filament/), '700');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));

    const weight = await within(dialog).findByLabelText('Net weight of the new filament (g)');
    await user.clear(weight);
    await user.type(weight, '9000');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByText(/Only 4,900 g of loose stock is available\./)).toBeInTheDocument();
    expect(within(dialog).queryByText('Review')).not.toBeInTheDocument();
  });

  it('skips the leftover step for a spool that needs a refill and sends no leftover', async () => {
    auth.permissions = BOTH;
    const empty = spool({
      status: 'needs_refill',
      fillId: null,
      filledAt: null,
      materialId: null,
      materialName: null,
      manufacturer: null,
      productName: null,
      initialNetWeightG: null,
      remainingQuantity: '0',
      identifiers: [],
      fillNumber: 2,
    });
    useCatalog([empty]);
    let body: ChangeFilamentSpoolFillRequest | undefined;
    server.use(
      http.post(`*/api/v1/filament-spools/${id(20)}/fills`, async ({ request }) => {
        body = (await request.json()) as ChangeFilamentSpoolFillRequest;
        return HttpResponse.json(spool({ fillNumber: 3 }));
      }),
    );
    const user = userEvent.setup();
    renderModal(<ChangeFilamentModal open onClose={vi.fn()} spool={empty} />);
    const dialog = await screen.findByRole('dialog', { name: 'Change filament' });

    expect(within(dialog).queryByText('Leftover')).not.toBeInTheDocument();
    expect(within(dialog).getByText('New filament')).toBeInTheDocument();
    expect(await within(dialog).findByText('Needs refill')).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Filament'), materialId);
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      leftover: null,
      fill: { materialId, netWeightG: '1000', source: 'loose_stock' },
      keepIdentifierIds: [],
      newIdentifiers: [],
      expectedVersion: 5,
    });
  });

  it('shows the backend reason when the fill is rejected and stays open', async () => {
    auth.permissions = BOTH;
    useCatalog();
    server.use(
      http.post(`*/api/v1/filament-spools/${id(20)}/fills`, () =>
        HttpResponse.json({ code: 'insufficient_loose_stock', message: 'Not enough loose stock' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal(<ChangeFilamentModal open onClose={onClose} spool={spool()} />);
    const dialog = await screen.findByRole('dialog', { name: 'Change filament' });
    await user.click(await within(dialog).findByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        'There is not enough loose stock for this. Check the available amount and try again.',
      ),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Finish spool', () => {
  it('finishes a single-use spool with the used-up leftover', async () => {
    auth.permissions = BOTH;
    let body: FinishFilamentSpoolRequest | undefined;
    server.use(
      http.post(`*/api/v1/filament-spools/${id(21)}/finish`, async ({ request }) => {
        body = (await request.json()) as FinishFilamentSpoolRequest;
        return HttpResponse.json(spool({ id: id(21), status: 'archived' }));
      }),
    );
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal(
      <FinishSpoolModal
        open
        onClose={onClose}
        spool={spool({ id: id(21), kind: 'single_use', status: 'active', remainingQuantity: '120', label: null })}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: /S-2026-000001/ });
    await user.click(within(dialog).getByLabelText('Nothing left, used up'));
    await user.click(within(dialog).getByRole('button', { name: 'Finish spool' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(body).toEqual({
      leftover: { basis: 'none', disposition: null },
      occurredAt: expect.any(String),
      expectedVersion: 5,
    });
    expect(await screen.findByText('S-2026-000001 finished')).toBeInTheDocument();
  });

  it('asks what happens to a leftover and sends the system value with its disposition', async () => {
    auth.permissions = BOTH;
    let body: FinishFilamentSpoolRequest | undefined;
    server.use(
      http.post(`*/api/v1/filament-spools/${id(20)}/finish`, async ({ request }) => {
        body = (await request.json()) as FinishFilamentSpoolRequest;
        return HttpResponse.json(spool({ status: 'needs_refill' }));
      }),
    );
    const user = userEvent.setup();
    renderModal(<FinishSpoolModal open onClose={vi.fn()} spool={spool()} />);
    const dialog = await screen.findByRole('dialog', { name: /S-2026-000001/ });
    expect(within(dialog).getByText('What happens to the remaining 600 g?')).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText('Dispose'));
    await user.click(within(dialog).getByRole('button', { name: 'Empty spool' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.leftover).toEqual({ basis: 'system', disposition: 'disposed' });
  });
});

describe('Clean up archived spools', () => {
  const candidate = (n: number) => ({
    id: id(40 + n),
    displayId: `S-2026-0000${n}`,
    label: null,
    archivedAt: '2026-01-05T08:00:00Z',
  });

  it('previews with a dry run and then deletes exactly the previewed spools', async () => {
    auth.permissions = BOTH;
    const requests: CleanUpFilamentSpoolsRequest[] = [];
    server.use(
      http.post('*/api/v1/filament-spools/cleanup', async ({ request }) => {
        const body = (await request.json()) as CleanUpFilamentSpoolsRequest;
        requests.push(body);
        const items =
          body.olderThanMonths === 3 ? [candidate(1), candidate(2)] : [candidate(1), candidate(2), candidate(3)];
        return HttpResponse.json({ items, deleted: !body.dryRun });
      }),
    );
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal(<CleanupSpoolsModal open onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Clean up archived spools' });
    expect(
      await within(dialog).findByText('2 archived single-use spools match and will be deleted permanently.'),
    ).toBeInTheDocument();
    expect(requests).toEqual([{ olderThanMonths: 3, dryRun: true }]);

    // A different age previews again; the deletion uses that preview.
    await user.selectOptions(within(dialog).getByLabelText('Archived'), '6');
    expect(
      await within(dialog).findByText('3 archived single-use spools match and will be deleted permanently.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete 3 spools' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(requests.find((request) => !request.dryRun)).toEqual({
      olderThanMonths: 6,
      dryRun: false,
      spoolIds: [id(41), id(42), id(43)],
    });
    expect(await screen.findByText('3 archived spools deleted')).toBeInTheDocument();
  });

  it('cannot delete when nothing matches', async () => {
    auth.permissions = BOTH;
    server.use(http.post('*/api/v1/filament-spools/cleanup', () => HttpResponse.json({ items: [], deleted: false })));
    renderModal(<CleanupSpoolsModal open onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'Clean up archived spools' });
    expect(
      await within(dialog).findByText('No archived single-use spools are older than 3 months.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled();
  });
});

// The overflow trigger is an icon button; its name comes from a tooltip, so it is found by its Carbon class.
const overflowButton = () => document.querySelector<HTMLElement>('.cds--overflow-menu') as HTMLElement;
const menuItem = (name: string) =>
  screen.queryByText(name, { selector: '.cds--overflow-menu-options__option-content' });
const waitForOverflowButton = () =>
  waitFor(() => {
    const button = overflowButton();
    expect(button).toBeTruthy();
    return button;
  });

function renderDetail(route: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/machine-logbook/inventory/spools/:spoolId',
        element: (
          <ToastProvider>
            <FilamentSpoolDetailPage />
          </ToastProvider>
        ),
      },
    ],
    { initialEntries: [route] },
  );
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function useDetail(item: FilamentSpool) {
  useCatalog([item]);
  server.use(
    http.get(`*/api/v1/filament-spools/${item.id}`, () => HttpResponse.json(item)),
    http.get(`*/api/v1/materials/${materialId}`, () => HttpResponse.json(material)),
    http.get(`*/api/v1/filament-spools/${item.id}/transactions`, () =>
      HttpResponse.json({ ...page([]), pageSize: 100 }),
    ),
  );
}

describe('Spool detail', () => {
  const closedFill = {
    id: id(31),
    fillNumber: 2,
    materialId,
    materialName: 'PLA Black',
    manufacturer: 'Prusament',
    productName: 'PLA Galaxy Black',
    initialNetWeightG: '1000',
    usedG: '940',
    leftoverG: '60',
    leftoverOutcome: 'returned_to_stock' as const,
    filledAt: '2026-09-01T08:00:00Z',
    closedAt: '2026-10-02T08:00:00Z',
    identifiers: [{ id: id(12), kind: 'nfc' as const, value: '04OLD1', createdAt: '2026-09-01T08:00:00Z' }],
  };

  it('shows the fill, its tags, the fill history and no raw ids', async () => {
    auth.permissions = BOTH;
    const item = spool({ fills: [closedFill] });
    useDetail(item);
    renderDetail(`/machine-logbook/inventory/spools/${item.id}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'S-2026-000001' })).toBeInTheDocument();
    const heading = within(screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement);
    expect(heading.getByText('Reusable')).toBeInTheDocument();
    expect(heading.getByText('Loaded')).toBeInTheDocument();
    expect(screen.getByText('Fill 3 · since 02.10.2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change filament' })).toBeInTheDocument();
    expect(screen.getByText('BC-100')).toBeInTheDocument();
    const fills = screen.getByRole('table', { name: 'Fills' });
    expect(within(fills).getByText('PLA Galaxy Black')).toBeInTheDocument();
    expect(within(fills).getByText('Returned to stock')).toBeInTheDocument();
    expect(within(fills).getByRole('button', { name: 'Show the 1 tags of fill 2' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(item.id);
  });

  it('offers Fill spool for a spool that needs a refill', async () => {
    auth.permissions = BOTH;
    const item = spool({
      status: 'needs_refill',
      fillId: null,
      filledAt: null,
      materialId: null,
      materialName: null,
      manufacturer: null,
      productName: null,
      initialNetWeightG: null,
      remainingQuantity: '0',
      identifiers: [],
    });
    useCatalog([item]);
    server.use(
      http.get(`*/api/v1/filament-spools/${item.id}`, () => HttpResponse.json(item)),
      http.get(`*/api/v1/filament-spools/${item.id}/transactions`, () =>
        HttpResponse.json({ ...page([]), pageSize: 100 }),
      ),
    );
    renderDetail(`/machine-logbook/inventory/spools/${item.id}`);
    expect(await screen.findByRole('button', { name: 'Fill spool' })).toBeInTheDocument();
    expect(screen.getByText('Needs refill', { selector: '.cds--inline-notification__title' })).toBeInTheDocument();
  });

  it('gives each action to the permission that guards it', async () => {
    const reusable = spool();
    const single = spool({ id: id(22), kind: 'single_use', status: 'active', label: null, fills: [] });
    useDetail(reusable);
    server.use(
      http.get(`*/api/v1/filament-spools/${single.id}`, () => HttpResponse.json(single)),
      http.get(`*/api/v1/filament-spools/${single.id}/transactions`, () =>
        HttpResponse.json({ ...page([]), pageSize: 100 }),
      ),
    );
    const user = userEvent.setup();

    // Read only: no actions at all.
    auth.permissions = [PermissionId.inventoryread];
    const readOnly = renderDetail(`/machine-logbook/inventory/spools/${reusable.id}`);
    await screen.findByRole('heading', { level: 1, name: 'S-2026-000001' });
    expect(screen.queryByRole('button', { name: 'Change filament' })).not.toBeInTheDocument();
    expect(document.querySelector('.cds--overflow-menu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add identifier' })).not.toBeInTheDocument();
    readOnly.unmount();

    // Managing spools without managing inventory: descriptive changes only, nothing that moves stock.
    auth.permissions = [PermissionId.inventoryread, PermissionId.filament_spoolsmanage];
    const spoolsOnly = renderDetail(`/machine-logbook/inventory/spools/${reusable.id}`);
    await screen.findByRole('heading', { level: 1, name: 'S-2026-000001' });
    expect(screen.queryByRole('button', { name: 'Change filament' })).not.toBeInTheDocument();
    await user.click(overflowButton());
    await waitFor(() => expect(menuItem('Edit spool')).toBeInTheDocument());
    expect(menuItem('Add identifier')).toBeInTheDocument();
    expect(menuItem('Correct stock')).toBeNull();
    expect(menuItem('Empty spool')).toBeNull();
    spoolsOnly.unmount();

    // Inventory only: stock can be corrected, but the spool cannot be edited or refilled.
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    const inventoryOnly = renderDetail(`/machine-logbook/inventory/spools/${single.id}`);
    await screen.findByRole('heading', { level: 1, name: 'S-2026-000001' });
    expect(await screen.findByRole('button', { name: 'Record consumption' })).toBeInTheDocument();
    await user.click(overflowButton());
    await waitFor(() => expect(menuItem('Correct stock')).toBeInTheDocument());
    expect(menuItem('Edit spool')).toBeNull();
    expect(menuItem('Finish spool')).toBeNull();
    inventoryOnly.unmount();

    // Both: single-use spools are finished, reusable ones refilled.
    auth.permissions = BOTH;
    renderDetail(`/machine-logbook/inventory/spools/${single.id}`);
    await screen.findByRole('heading', { level: 1, name: 'S-2026-000001' });
    await user.click(await waitForOverflowButton());
    await waitFor(() => expect(menuItem('Finish spool')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Change filament' })).not.toBeInTheDocument();
  });

  it('explains a spool that no longer exists', async () => {
    auth.permissions = BOTH;
    server.use(
      http.get(`*/api/v1/filament-spools/${id(99)}`, () =>
        HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 }),
      ),
    );
    renderDetail(`/machine-logbook/inventory/spools/${id(99)}`);
    expect(await screen.findByText('This spool does not exist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to spools' })).toHaveAttribute(
      'href',
      '/machine-logbook/inventory?tab=spools',
    );
  });

  it('archives a spool with the whole record and the loaded version', async () => {
    auth.permissions = BOTH;
    const item = spool({
      remainingQuantity: '0',
      kind: 'single_use',
      status: 'active',
      label: 'Spare',
      storageLocation: 'Shelf B',
      notes: 'Keep dry',
    });
    useDetail(item);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch(`*/api/v1/filament-spools/${item.id}`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...item, status: 'archived', lifecycle: 'archived' });
      }),
    );
    const user = userEvent.setup();
    renderDetail(`/machine-logbook/inventory/spools/${item.id}`);
    await user.click(await waitForOverflowButton());
    await user.click(await screen.findByText('Archive'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive this spool?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(body).toBeDefined());
    // The backend replaces the descriptive record, so unchanged fields are sent back as they were.
    expect(body).toEqual({
      label: 'Spare',
      manufacturer: 'Bambu Lab',
      productName: 'PLA Basic Black',
      tareWeightG: '200',
      acquiredOn: '2026-09-01',
      acquisitionReference: null,
      storageLocation: 'Shelf B',
      notes: 'Keep dry',
      lifecycle: 'archived',
      expectedVersion: 5,
    });
  });
});

describe('Spools table', () => {
  it('hides archived spools unless asked and offers New, Register and Change filament only with both permissions', async () => {
    useCatalog();
    const requests: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/filament-spools')) requests.push(new URL(request.url).search);
    });
    const user = userEvent.setup();

    auth.permissions = [PermissionId.inventoryread, PermissionId.filament_spoolsmanage];
    const readOnly = renderRoute(
      <ToastProvider>
        <InventorySpoolsTable />
      </ToastProvider>,
    );
    const table = await screen.findByRole('table', { name: 'Spools' });
    expect(within(table).getByRole('link', { name: 'S-2026-000001' })).toHaveAttribute(
      'href',
      `/machine-logbook/inventory/spools/${id(20)}`,
    );
    expect(within(table).getByText('Loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New' })).not.toBeInTheDocument();
    expect(requests[0]).toContain('lifecycle=active');
    readOnly.unmount();

    auth.permissions = BOTH;
    renderRoute(
      <ToastProvider>
        <InventorySpoolsTable />
      </ToastProvider>,
      '/?spoolsarchived=1',
    );
    await screen.findByRole('table', { name: 'Spools' });
    expect(requests.at(-1)).not.toContain('lifecycle');
    await user.click(screen.getByRole('button', { name: 'New' }));
    expect(await screen.findByRole('menuitem', { name: 'Register spool' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Change filament' })).toBeInTheDocument();
  });

  it('shows a compact, material-filtered table with a plain Register spool button', async () => {
    auth.permissions = BOTH;
    useCatalog();
    let search = '';
    server.use(
      http.get('*/api/v1/filament-spools', ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json(page([spool()]));
      }),
    );
    renderRoute(
      <ToastProvider>
        <InventorySpoolsTable materialId={materialId} compact />
      </ToastProvider>,
    );
    const table = await screen.findByRole('table', { name: 'Spools' });
    expect(search).toContain(`materialId=${materialId}`);
    expect(within(table).queryByRole('columnheader', { name: 'Material' })).not.toBeInTheDocument();
    const toolbar = screen.getByLabelText('Spools table toolbar');
    expect(within(toolbar).getByRole('button', { name: 'Register spool' })).toBeInTheDocument();
    expect(within(toolbar).queryByRole('button', { name: 'New' })).not.toBeInTheDocument();
  });
});

describe('Spool mount and ledger attribution', () => {
  it('lists derived quantities and links the mount to the machine printer tab', async () => {
    auth.permissions = [PermissionId.inventoryread];
    useCatalog([
      spool({ mounted: true, mountedOn, remainingQuantity: '842' }),
      spool({ id: id(22), displayId: 'S-2026-000002', label: null }),
    ]);
    renderRoute(
      <ToastProvider>
        <InventorySpoolsTable />
      </ToastProvider>,
    );
    const table = await screen.findByRole('table', { name: 'Spools' });
    expect(within(table).getByText('842 g of 1,000 g')).toBeInTheDocument();
    const link = within(table).getByRole('link', { name: 'Bambu H2D #1 · Slot 3' });
    expect(link).toHaveAttribute('href', `/machine-logbook/machines/${id(40)}?tab=printer`);
  });

  it('shows where the spool is mounted on its page and names the slot in the finish dialog', async () => {
    auth.permissions = BOTH;
    const item = spool({ mounted: true, mountedOn });
    useDetail(item);
    renderDetail(`/machine-logbook/inventory/spools/${item.id}`);
    expect(await screen.findByRole('link', { name: 'Bambu H2D #1 · Slot 3' })).toHaveAttribute(
      'href',
      `/machine-logbook/machines/${id(40)}?tab=printer`,
    );
  });

  it('names the machine and slot in the finish dialog', async () => {
    auth.permissions = BOTH;
    renderModal(<FinishSpoolModal open onClose={vi.fn()} spool={spool({ mounted: true, mountedOn })} />);
    const dialog = await screen.findByRole('dialog', { name: /S-2026-000001/ });
    expect(dialog.textContent).toContain('It is also removed from Bambu H2D #1 (Slot 3).');
  });

  it('shows who recorded each ledger entry', async () => {
    auth.permissions = BOTH;
    const item = spool();
    useCatalog([item]);
    server.use(
      http.get(`*/api/v1/filament-spools/${item.id}`, () => HttpResponse.json(item)),
      http.get(`*/api/v1/materials/${materialId}`, () => HttpResponse.json(material)),
      http.get(`*/api/v1/filament-spools/${item.id}/transactions`, () =>
        HttpResponse.json(
          page([
            {
              id: id(50),
              materialId,
              kind: 'purchase',
              quantityDelta: '1000',
              unitAcquisitionCost: '0.02',
              inventoryValueDelta: '20',
              totalPurchasePrice: '20',
              occurredAt: '2026-10-02T08:00:00Z',
              supplier: 'Filament Shop',
              note: null,
              adjustmentReason: null,
              actorName: 'Lena Maier',
              spoolId: item.id,
              spoolDisplayId: item.displayId,
              fillNumber: 3,
              createdAt: '2026-10-02T08:00:00Z',
            },
          ]),
        ),
      ),
    );
    renderDetail(`/machine-logbook/inventory/spools/${item.id}`);
    expect(await screen.findByText('Lena Maier')).toBeInTheDocument();
    expect(screen.getByText('Filament Shop')).toBeInTheDocument();
  });
});

describe('Register spool', () => {
  const openDialog = async () => {
    const dialog = await screen.findByRole('dialog', { name: 'Register spool' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Register spool' })).toBeEnabled());
    return dialog;
  };

  it('registers a reusable spool empty and fills it later, without material, weight or version', async () => {
    auth.permissions = BOTH;
    useCatalog();
    let body: CreateFilamentSpoolRequest | undefined;
    server.use(
      http.post('*/api/v1/filament-spools', async ({ request }) => {
        body = (await request.json()) as CreateFilamentSpoolRequest;
        return HttpResponse.json(spool({ status: 'needs_refill', fillId: null, materialId: null, materialName: null }));
      }),
    );
    const user = userEvent.setup();
    renderModal(<SpoolFormModal open onClose={vi.fn()} />);
    const dialog = await openDialog();
    expect(within(dialog).getByLabelText(/With filament from loose stock/)).toBeChecked();
    await user.click(within(dialog).getByLabelText(/Register empty and fill later/));
    expect(within(dialog).queryByLabelText('Net weight (g)')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Stock source')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Register spool' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ kind: 'reusable', stockMode: 'empty', occurredAt: expect.any(String) });
    expect(body).not.toHaveProperty('materialId');
    expect(body).not.toHaveProperty('initialNetWeightG');
    expect(body).not.toHaveProperty('expectedInventoryVersion');
  });

  it('does not offer an empty registration for single-use spools', async () => {
    auth.permissions = BOTH;
    useCatalog();
    const user = userEvent.setup();
    renderModal(<SpoolFormModal open onClose={vi.fn()} />);
    const dialog = await openDialog();
    await user.click(within(dialog).getByLabelText('Single-use'));
    expect(within(dialog).queryByLabelText(/Register empty and fill later/)).not.toBeInTheDocument();
  });

  it('registers a spool from loose stock of the chosen filament', async () => {
    auth.permissions = BOTH;
    useCatalog();
    let body: CreateFilamentSpoolRequest | undefined;
    server.use(
      http.post('*/api/v1/filament-spools', async ({ request }) => {
        body = (await request.json()) as CreateFilamentSpoolRequest;
        return HttpResponse.json(spool());
      }),
    );
    const user = userEvent.setup();
    renderModal(<SpoolFormModal open onClose={vi.fn()} initialMaterialId={materialId} />);
    const dialog = await openDialog();
    await user.type(within(dialog).getByLabelText('Manufacturer (optional)'), 'Bambu Lab');
    await user.click(within(dialog).getByRole('button', { name: 'Register spool' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      stockMode: 'existing_stock',
      materialId,
      initialNetWeightG: '1000',
      manufacturer: 'Bambu Lab',
      expectedInventoryVersion: 7,
    });
    expect(body).not.toHaveProperty('totalPrice');
  });
});
