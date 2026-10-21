import type { ReactElement } from 'react';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChangeFilamentSpoolFillRequest,
  CreateFilamentSpoolRequest,
  CreateMaterialRequest,
  FilamentSpool,
  Material,
  MaterialType,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { ChangeFilamentModal } from './dialogs/ChangeFilamentModal';
import { SpoolFormModal } from './dialogs/SpoolFormModal';
import { ToastProvider } from './shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const BOTH = [PermissionId.inventoryread, PermissionId.filament_spoolsmanage, PermissionId.inventorymanage];
const id = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e8b${String(n).padStart(3, '0')}`;
const now = '2026-09-01T00:00:00Z';

const plaType: MaterialType = {
  id: id(1),
  name: 'PLA',
  kind: 'filament',
  unit: 'g',
  processes: ['fdm_printing'],
  active: true,
  materialCount: 0,
  pricingRuleCount: 0,
  version: 1,
  createdAt: now,
  updatedAt: now,
};

const created: Material = {
  id: id(5),
  name: 'PLA Matte · Red · Prusa',
  kind: 'filament',
  materialTypeId: plaType.id,
  materialTypeName: 'PLA',
  unit: 'g',
  active: true,
  lowStockThreshold: null,
  quantity: '0',
  assignedQuantity: '0',
  unassignedQuantity: '0',
  filamentDiameterMm: '1.75',
  averageUnitCost: '0',
  inventoryValue: '0',
  stockState: 'empty',
  inventoryVersion: 1,
  recentConsumption: '0',
  version: 1,
  createdAt: now,
  updatedAt: now,
};

const emptySpool = {
  id: id(20),
  displayId: 'S-2026-000001',
  kind: 'reusable',
  label: 'Bambu spool 01',
  status: 'needs_refill',
  fillNumber: 1,
  fillId: null,
  filledAt: null,
  archivedAt: null,
  materialId: null,
  materialName: null,
  unit: 'g',
  initialNetWeightG: null,
  remainingQuantity: '0',
  tareWeightG: '200',
  lifecycle: 'active',
  mounted: false,
  identifiers: [],
  fills: [],
  version: 5,
  createdAt: now,
  updatedAt: now,
} as unknown as FilamentSpool;

const page = <T,>(items: T[]) => ({ items, page: 1, pageSize: 100, total: items.length });

function serve() {
  server.use(
    http.get('*/api/v1/filament-spools', () => HttpResponse.json(page([emptySpool]))),
    http.get('*/api/v1/materials', () => HttpResponse.json({ ...page([]), totalInventoryValue: '0' })),
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [plaType] })),
    http.get('*/api/v1/inventory/suggestions', () =>
      HttpResponse.json({ variants: [], manufacturers: [], suppliers: [], storageLocations: [] }),
    ),
  );
}

/** Serves createMaterial and counts and records its calls. */
function serveCreate() {
  const bodies: CreateMaterialRequest[] = [];
  server.use(
    http.post('*/api/v1/materials', async ({ request }) => {
      bodies.push((await request.json()) as CreateMaterialRequest);
      return HttpResponse.json(created, { status: 201 });
    }),
  );
  server.use(http.get(`*/api/v1/materials/${created.id}`, () => HttpResponse.json(created)));
  return bodies;
}

function renderModal(ui: ReactElement) {
  return renderRoute(<ToastProvider>{ui}</ToastProvider>);
}

async function describeArticle(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(await within(dialog).findByRole('button', { name: 'Add new filament' }));
  await user.click(await within(dialog).findByRole('combobox', { name: 'Material type' }));
  await user.click(await screen.findByText('PLA (g)'));
  await user.type(within(dialog).getByRole('combobox', { name: 'Variant (optional)' }), 'Matte');
  await user.type(within(dialog).getByLabelText('Colour name (optional)'), 'Red');
}

const expectedArticle = { materialTypeId: plaType.id, variant: 'Matte', colorName: 'Red', filamentDiameterMm: '1.75' };

describe('Change filament with a new filament article', () => {
  it('creates the article and fills the spool from a purchase', async () => {
    auth.permissions = BOTH;
    serve();
    const articles = serveCreate();
    let fill: ChangeFilamentSpoolFillRequest | undefined;
    server.use(
      http.post(`*/api/v1/filament-spools/${id(20)}/fills`, async ({ request }) => {
        fill = (await request.json()) as ChangeFilamentSpoolFillRequest;
        return HttpResponse.json({ ...emptySpool, fillNumber: 1, materialName: created.name });
      }),
    );
    const user = userEvent.setup();
    renderModal(<ChangeFilamentModal open onClose={vi.fn()} spool={emptySpool} />);
    const dialog = await screen.findByRole('dialog', { name: 'Change filament' });

    await describeArticle(user, dialog);
    expect(within(dialog).queryByLabelText(/From loose stock/)).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Total price (€)'), '24');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fill).toBeDefined());
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject(expectedArticle);
    expect(fill?.fill).toMatchObject({
      materialId: created.id,
      source: 'purchase',
      netWeightG: '1000',
      totalPrice: '24',
    });
  });

  it('does not create the article twice when the fill is retried', async () => {
    auth.permissions = BOTH;
    serve();
    const articles = serveCreate();
    const fills: ChangeFilamentSpoolFillRequest[] = [];
    server.use(
      http.post(`*/api/v1/filament-spools/${id(20)}/fills`, async ({ request }) => {
        fills.push((await request.json()) as ChangeFilamentSpoolFillRequest);
        return fills.length === 1
          ? HttpResponse.json({ code: 'stale_write', message: 'Stale' }, { status: 409 })
          : HttpResponse.json({ ...emptySpool, fillNumber: 1, materialName: created.name });
      }),
    );
    const user = userEvent.setup();
    renderModal(<ChangeFilamentModal open onClose={vi.fn()} spool={emptySpool} />);
    const dialog = await screen.findByRole('dialog', { name: 'Change filament' });

    await describeArticle(user, dialog);
    await user.type(within(dialog).getByLabelText('Total price (€)'), '24');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Not saved')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(await within(dialog).findByText('Filament article created')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fills).toHaveLength(2));
    expect(articles).toHaveLength(1);
    expect(fills[1]?.fill.materialId).toBe(created.id);
  });
});

describe('Register spool with a new filament article', () => {
  const openDialog = async () => {
    const dialog = await screen.findByRole('dialog', { name: 'Register spool' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Register spool' })).toBeEnabled());
    return dialog;
  };

  it('creates the article and registers the spool as a new acquisition', async () => {
    auth.permissions = BOTH;
    serve();
    const articles = serveCreate();
    let body: CreateFilamentSpoolRequest | undefined;
    server.use(
      http.post('*/api/v1/filament-spools', async ({ request }) => {
        body = (await request.json()) as CreateFilamentSpoolRequest;
        return HttpResponse.json(emptySpool);
      }),
    );
    const user = userEvent.setup();
    renderModal(<SpoolFormModal open onClose={vi.fn()} />);
    const dialog = await openDialog();

    await describeArticle(user, dialog);
    await user.type(within(dialog).getByLabelText('Total price (€)'), '24');
    await user.click(within(dialog).getByRole('button', { name: 'Register spool' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject(expectedArticle);
    expect(body).toMatchObject({
      stockMode: 'new_acquisition',
      materialId: created.id,
      initialNetWeightG: '1000',
      totalPrice: '24.00',
    });
    expect(body?.expectedInventoryVersion).toBe(created.inventoryVersion);
  });

  it('does not create the article twice when the registration is retried', async () => {
    auth.permissions = BOTH;
    serve();
    const articles = serveCreate();
    const bodies: CreateFilamentSpoolRequest[] = [];
    server.use(
      http.post('*/api/v1/filament-spools', async ({ request }) => {
        bodies.push((await request.json()) as CreateFilamentSpoolRequest);
        return bodies.length === 1
          ? HttpResponse.json({ code: 'stale_write', message: 'Stale' }, { status: 409 })
          : HttpResponse.json(emptySpool);
      }),
    );
    const user = userEvent.setup();
    renderModal(<SpoolFormModal open onClose={vi.fn()} />);
    const dialog = await openDialog();

    await describeArticle(user, dialog);
    await user.type(within(dialog).getByLabelText('Total price (€)'), '24');
    await user.click(within(dialog).getByRole('button', { name: 'Register spool' }));
    expect(await within(dialog).findByText('Not saved')).toBeInTheDocument();
    expect(within(dialog).getByText('Filament article created')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Register spool' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(articles).toHaveLength(1);
    expect(bodies[1]?.materialId).toBe(created.id);
    expect(bodies[1]?.expectedInventoryVersion).toBe(created.inventoryVersion);
  });
});
