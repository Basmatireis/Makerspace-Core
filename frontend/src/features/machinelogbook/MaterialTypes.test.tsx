import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Material, MaterialType } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { server } from '../../test/server';
import { testQueryClient } from '../../test/render';
import { InventoryPage } from './InventoryPage';
import { MaterialFormModal } from './dialogs/MaterialFormModal';
import { laserProcessId, printerProcessId, processes } from './printerTestData';
import { machineLogbookPaths } from './shared/paths';
import { ToastProvider } from './shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const now = '2026-09-15T11:26:00Z';
const type = (overrides: Partial<MaterialType>): MaterialType => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f001',
  name: 'PLA',
  code: 'PLAX',
  kind: 'filament',
  machineUse: true,
  unit: 'g',
  dimension: 'mass',
  processIds: [printerProcessId],
  active: true,
  materialCount: 3,
  pricingRuleCount: 2,
  variants: [],
  version: 2,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});
const pla = type({});
const plywood = type({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f002',
  name: 'Plywood',
  code: 'PLYWOOD',
  kind: 'consumable',
  unit: 'm2',
  dimension: 'area',
  processIds: [laserProcessId],
  materialCount: 0,
  pricingRuleCount: 0,
  version: 1,
});
const retired = type({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f003',
  name: 'ABS',
  code: 'ABSX',
  active: false,
  materialCount: 0,
  pricingRuleCount: 0,
});
const fasteners = type({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f004',
  name: 'Fasteners',
  code: 'FASTENERS',
  kind: 'part',
  machineUse: false,
  unit: 'piece',
  dimension: 'count',
  processIds: [],
  materialCount: 2,
  pricingRuleCount: 0,
  version: 1,
});

function renderWithProviders(node: ReactNode, path: string) {
  const router = createMemoryRouter([{ path: '*', element: node }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={testQueryClient()}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

function serveTypes(items: MaterialType[] = [pla, plywood, retired, fasteners]) {
  server.use(
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items })),
    http.get('*/api/v1/processes', () => HttpResponse.json({ items: processes })),
    http.get('*/api/v1/materials', () =>
      HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0, totalInventoryValue: '0' }),
    ),
    http.get('*/api/v1/inventory/suggestions', () =>
      HttpResponse.json({ variants: [], manufacturers: [], suppliers: [], storageLocations: [] }),
    ),
  );
}

async function openTypes(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Categories' }));
  return screen.findByRole('table', { name: 'Types and categories' });
}

async function newType(user: ReturnType<typeof userEvent.setup>, kindLabel: string) {
  await user.click(await screen.findByRole('button', { name: 'New type or category' }));
  const choice = await screen.findByRole('dialog', { name: 'New type or category' });
  await user.click(within(choice).getByRole('radio', { name: kindLabel }));
  await user.click(within(choice).getByRole('button', { name: 'Continue' }));
}

describe('Types and categories', () => {
  it('lists filament and consumable types and part categories in one table', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.machinesread];
    serveTypes();
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    const table = await openTypes(user);
    expect(await within(table).findByText('PLA')).toBeInTheDocument();
    expect(within(table).getByText('ABS')).toBeInTheDocument();
    expect(within(table).getByText('Plywood')).toBeInTheDocument();
    expect(within(table).getByText('Fasteners')).toBeInTheDocument();
    const plaRow = within(table).getByText('PLA').closest('tr') as HTMLElement;
    expect(within(plaRow).getByText('Filament')).toBeInTheDocument();
    expect(await within(plaRow).findByText('3D printer')).toBeInTheDocument();
    expect(within(plaRow).getByText('g')).toBeInTheDocument();
    // Readers cannot edit or add.
    expect(within(table).queryByRole('button', { name: 'PLA' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New type or category' })).not.toBeInTheDocument();
  });

  it('searches the kind, unit and process names the columns show', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.machinesread];
    serveTypes();
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    const table = await openTypes(user);
    expect(await within(table).findByText('PLA')).toBeInTheDocument();
    await within(table).findAllByText('Laser');
    await user.type(screen.getByLabelText('Search types and categories', { selector: 'input' }), 'laser');
    await waitFor(() => expect(within(table).queryByText('PLA')).not.toBeInTheDocument());
    expect(within(table).getByText('Plywood')).toBeInTheDocument();
  });

  it('narrows the types with the Process filter', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.machinesread];
    serveTypes();
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    const table = await openTypes(user);
    await within(table).findByText('PLA');
    await within(table).findAllByText('Laser');
    await user.click(screen.getByLabelText('Filters', { selector: 'button' }));
    await user.click(screen.getByRole('checkbox', { name: 'Laser' }));
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('Plywood')).toBeInTheDocument();
    expect(screen.queryByText('PLA')).not.toBeInTheDocument();
    expect(screen.queryByText('Fasteners')).not.toBeInTheDocument();
  });

  it('creates a filament type in grams without asking for processes', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
      PermissionId.machinesread,
    ];
    serveTypes();
    let submitted: unknown;
    server.use(
      http.post('*/api/v1/material-types', async ({ request }) => {
        submitted = await request.json();
        return HttpResponse.json(
          type({ ...(submitted as object), id: pla.id, materialCount: 0, pricingRuleCount: 0, version: 1 }),
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    await newType(user, 'Filament material type');
    const dialog = await screen.findByRole('dialog', { name: 'Add material type' });
    expect(within(dialog).getByLabelText('Unit')).toBeDisabled();
    expect(within(dialog).queryByText('Used for processes')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add material type' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'PETG-CF');
    await user.click(within(dialog).getByRole('button', { name: 'Add material type' }));
    await waitFor(() => expect(submitted).toEqual({ name: 'PETG-CF', kind: 'filament', machineUse: true, unit: 'g' }));
    expect(await screen.findByText('Material type added')).toBeInTheDocument();
  });

  it('creates a consumable type with its processes and a part category without any', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
      PermissionId.machinesread,
    ];
    serveTypes();
    const bodies: unknown[] = [];
    server.use(
      http.post('*/api/v1/material-types', async ({ request }) => {
        const body = (await request.json()) as object;
        bodies.push(body);
        return HttpResponse.json(type({ ...body, id: pla.id, materialCount: 0, pricingRuleCount: 0, version: 1 }), {
          status: 201,
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    await newType(user, 'Consumable material type');
    let dialog = await screen.findByRole('dialog', { name: 'Add material type' });
    await user.type(within(dialog).getByLabelText('Name'), 'Vinyl foil');
    await user.selectOptions(within(dialog).getByLabelText('Unit'), 'm2');
    // At least one process is required.
    await user.click(await within(dialog).findByRole('button', { name: 'Add material type' }));
    expect(await within(dialog).findByText('Choose at least one process.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: /Used for processes/ }));
    await user.click(await within(dialog).findByText('Laser'));
    await user.click(within(dialog).getByRole('button', { name: 'Add material type' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      name: 'Vinyl foil',
      kind: 'consumable',
      machineUse: true,
      unit: 'm2',
      processIds: [laserProcessId],
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add material type' })).not.toBeInTheDocument());

    await newType(user, 'Part category');
    dialog = await screen.findByRole('dialog', { name: 'Add category' });
    expect(within(dialog).queryByText('Used for processes')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'Bike');
    await user.click(within(dialog).getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ name: 'Bike', kind: 'part', machineUse: false, unit: 'piece' });
  });

  it('opens the edit dialog from a row and saves code and machine use', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    serveTypes();
    let submitted: Record<string, unknown> | undefined;
    server.use(
      http.patch(`*/api/v1/material-types/${fasteners.id}`, async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(fasteners);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    const table = await openTypes(user);
    const row = within(table).getByRole('button', { name: 'Fasteners' }).closest('tr') as HTMLElement;
    expect(within(row).getByText('FASTENERS')).toBeInTheDocument();
    expect(within(row).getByText('Not used in machine runs')).toBeInTheDocument();
    await user.click(within(row).getByText('FASTENERS'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit category' });
    expect(within(dialog).getByLabelText('Kind')).toBeDisabled();
    const code = within(dialog).getByLabelText('Code (optional)');
    await user.clear(code);
    await user.type(code, 'fix');
    await user.click(within(dialog).getByRole('switch', { name: 'Machine use' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save category' }));
    await waitFor(() => expect(submitted).toMatchObject({ name: 'Fasteners', code: 'FIX', machineUse: true }));
    expect(submitted).not.toHaveProperty('kind');
  });

  it('locks the unit of a used type and explains a refused delete', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    serveTypes();
    server.use(
      http.delete(`*/api/v1/material-types/${pla.id}`, () =>
        HttpResponse.json({ code: 'material_type_in_use', message: 'in use' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    const table = await openTypes(user);
    await user.click(await within(table).findByRole('button', { name: 'PLA' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit material type' });
    expect(within(dialog).getByLabelText('Unit')).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete this material type?');
    await user.click(await screen.findByRole('button', { name: 'Delete material type' }));
    expect(await screen.findByText('In use')).toBeInTheDocument();
  });
  it('offers only units of the same kind for a used type and no units across kinds', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    const usedPlywood = { ...plywood, materialCount: 2 };
    serveTypes([pla, usedPlywood, retired, fasteners]);
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    const table = await openTypes(user);
    await user.click(await within(table).findByRole('button', { name: 'Plywood' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit material type' });
    const select = within(dialog).getByLabelText('Unit');
    expect(select).toBeEnabled();
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Square centimetres (cm²)', 'Square metres (m²)']);
  });

  it('offers every unit grouped by kind for an unused type', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    serveTypes();
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    const table = await openTypes(user);
    await user.click(await within(table).findByRole('button', { name: 'Plywood' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit material type' });
    const options = within(within(dialog).getByLabelText('Unit')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Grams (g)',
      'Kilograms (kg)',
      'Millimetres (mm)',
      'Centimetres (cm)',
      'Metres (m)',
      'Square centimetres (cm²)',
      'Square metres (m²)',
      'Millilitres (ml)',
      'Litres (l)',
      'Pieces',
    ]);
  });
});

describe('Deleting a type', () => {
  const user0 = () => userEvent.setup();

  async function openDelete(row: string, heading: string, name: string) {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    serveTypes([
      {
        ...pla,
        materialCount: 0,
        variants: [{ id: 'v1', materialTypeId: pla.id, name: 'Matte', materialCount: 0, pricingRuleCount: 1 }],
      },
      fasteners,
    ]);
    const user = user0();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    const table = await openTypes(user);
    await user.click(await within(table).findByRole('button', { name: row }));
    const dialog = await screen.findByRole('dialog', { name: heading });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    return { user, name };
  }

  it('deletes a type that has pricing rules but no articles and names what goes with it', async () => {
    let deleted = false;
    server.use(
      http.delete(`*/api/v1/material-types/${pla.id}`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = await openDelete('PLA', 'Edit material type', 'PLA');
    await screen.findByText('Delete this material type?');
    expect(screen.getByText('Its 2 price rules and 1 variant are deleted with it.')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Delete material type' });
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(deleted).toBe(true));
  });

  it('keeps refusing a type that still has articles', async () => {
    server.use(
      http.delete(`*/api/v1/material-types/${fasteners.id}`, () =>
        HttpResponse.json({ code: 'material_type_in_use', message: 'in use' }, { status: 409 }),
      ),
    );
    const { user } = await openDelete('Fasteners', 'Edit category', 'Fasteners');
    await screen.findByText('Delete this category?');
    expect(screen.queryByText(/deleted with it/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete category' }));
    expect(await screen.findByText('In use')).toBeInTheDocument();
    expect(screen.getByText(/Articles use it/)).toBeInTheDocument();
  });
});

describe('Variants of a type', () => {
  const variantOf = (n: number, name: string, materialCount = 0, pricingRuleCount = 0) => ({
    id: `0192f6f8-743e-7c77-a349-cd07c3e8f9${String(n).padStart(2, '0')}`,
    materialTypeId: pla.id,
    name,
    materialCount,
    pricingRuleCount,
  });
  const basic = variantOf(1, 'Basic', 3, 1);
  const matte = variantOf(2, 'Matte');
  const group = (rules: object[]) => ({
    id: '0192f6f8-743e-7c77-a349-cd07c3e8fa01',
    name: 'Partner',
    description: null,
    active: true,
    isDefault: false,
    rules,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const rule = (overrides: object) => ({
    id: '0192f6f8-743e-7c77-a349-cd07c3e8fb01',
    pricingGroupId: '0192f6f8-743e-7c77-a349-cd07c3e8fa01',
    kind: 'material',
    materialTypeId: pla.id,
    materialTypeVariantId: null,
    rate: '0.040000',
    active: true,
    version: 1,
    ...overrides,
  });

  async function openPla(user: ReturnType<typeof userEvent.setup>) {
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    const table = await openTypes(user);
    await user.click(await within(table).findByRole('button', { name: 'PLA' }));
    return screen.findByRole('dialog', { name: 'Edit material type' });
  }

  it('lists variants in the table, adds and renames them, and blocks deleting a used one', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    let variants = [basic, matte];
    serveTypes();
    server.use(http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [{ ...pla, variants }] })));
    const bodies: { method: string; url: string; body: unknown }[] = [];
    server.use(
      http.post(`*/api/v1/material-types/${pla.id}/variants`, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        bodies.push({ method: 'POST', url: request.url, body });
        const created = variantOf(3, body.name);
        variants = [...variants, created];
        return HttpResponse.json(created, { status: 201 });
      }),
      http.patch(`*/api/v1/material-types/${pla.id}/variants/${matte.id}`, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        bodies.push({ method: 'PATCH', url: request.url, body });
        variants = variants.map((item) => (item.id === matte.id ? { ...item, name: body.name } : item));
        return HttpResponse.json({ ...matte, name: body.name });
      }),
    );
    const user = userEvent.setup();
    const table = await (async () => {
      renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
      return openTypes(user);
    })();
    const plaRow = (await within(table).findByText('PLA')).closest('tr') as HTMLElement;
    expect(await within(plaRow).findByText('Basic, Matte')).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: 'PLA' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit material type' });
    expect(within(dialog).getByText(/only saves the type itself/)).toBeInTheDocument();
    expect(within(dialog).getByText('Used by 3 articles and 1 price rule.')).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText('Basic is in use and cannot be deleted', { selector: 'button' }),
    ).toBeDisabled();
    expect(within(dialog).getByLabelText('Delete Matte', { selector: 'button' })).toBeEnabled();

    await user.type(within(dialog).getByLabelText('New variant'), 'Silk');
    await user.click(within(dialog).getByRole('button', { name: 'Add variant' }));
    await waitFor(() =>
      expect(bodies).toContainEqual(expect.objectContaining({ method: 'POST', body: { name: 'Silk' } })),
    );
    expect(await within(dialog).findByLabelText('Name of variant Silk')).toBeInTheDocument();

    const field = within(dialog).getByLabelText('Name of variant Matte');
    await user.clear(field);
    await user.type(field, 'Satin');
    await user.click(within(dialog).getByLabelText('Save name of Matte', { selector: 'button' }));
    await waitFor(() =>
      expect(bodies).toContainEqual(expect.objectContaining({ method: 'PATCH', body: { name: 'Satin' } })),
    );
  });

  it('deletes an unused variant at once', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    serveTypes();
    server.use(
      http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [{ ...pla, variants: [basic, matte] }] })),
    );
    let deleted = false;
    server.use(
      http.delete(`*/api/v1/material-types/${pla.id}/variants/${matte.id}`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    const dialog = await openPla(user);
    await user.click(await within(dialog).findByLabelText('Delete Matte', { selector: 'button' }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it('shows own and inherited rates and sends the variant when a cell is edited', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
      PermissionId.pricingread,
      PermissionId.pricingmanage,
    ];
    serveTypes();
    server.use(
      http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [{ ...pla, variants: [basic, matte] }] })),
      http.get('*/api/v1/pricing-groups', () =>
        HttpResponse.json({
          items: [
            group([
              rule({}),
              rule({
                id: '0192f6f8-743e-7c77-a349-cd07c3e8fb02',
                materialTypeVariantId: basic.id,
                rate: '0.050000',
              }),
            ]),
          ],
        }),
      ),
    );
    let created: unknown;
    server.use(
      http.post('*/api/v1/pricing-groups/:groupId/rules', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(rule({ materialTypeVariantId: matte.id, rate: '0.060000' }), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const dialog = await openPla(user);
    const rates = await within(dialog).findByRole('table', { name: 'Rates of PLA per variant' });
    expect(within(rates).getByRole('button', { name: 'Edit rate for All variants in Partner' })).toHaveTextContent(
      '0,04 €/g',
    );
    expect(within(rates).getByRole('button', { name: 'Edit rate for Basic in Partner' })).toHaveTextContent('0,05 €/g');
    expect(within(rates).getByRole('button', { name: 'Edit rate for Matte in Partner' })).toHaveTextContent(
      '0,04 €/g · inherited',
    );
    await user.click(within(rates).getByRole('button', { name: 'Edit rate for Matte in Partner' }));
    await user.type(within(rates).getByLabelText(/Rate for Matte in Partner/), '0,06');
    await user.click(within(rates).getByLabelText('Save rate for Matte in Partner', { selector: 'button' }));
    await waitFor(() =>
      expect(created).toEqual({
        kind: 'material',
        materialTypeId: pla.id,
        materialTypeVariantId: matte.id,
        rate: '0.06',
      }),
    );
  });

  it('deletes the rule of a variant when its rate is cleared', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
      PermissionId.pricingread,
      PermissionId.pricingmanage,
    ];
    serveTypes();
    const ownId = '0192f6f8-743e-7c77-a349-cd07c3e8fb02';
    server.use(
      http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [{ ...pla, variants: [basic, matte] }] })),
      http.get('*/api/v1/pricing-groups', () =>
        HttpResponse.json({
          items: [
            group([rule({}), rule({ id: ownId, materialTypeVariantId: basic.id, rate: '0.050000', version: 4 })]),
          ],
        }),
      ),
    );
    let deleted: unknown;
    server.use(
      http.delete(`*/api/v1/pricing-rules/${ownId}`, async ({ request }) => {
        deleted = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
      http.patch(`*/api/v1/pricing-rules/${ownId}`, () => HttpResponse.json({}, { status: 500 })),
    );
    const user = userEvent.setup();
    const dialog = await openPla(user);
    const rates = await within(dialog).findByRole('table', { name: 'Rates of PLA per variant' });
    await user.click(within(rates).getByLabelText('Clear rate for Basic in Partner', { selector: 'button' }));
    await waitFor(() => expect(deleted).toEqual({ expectedVersion: 4 }));
  });

  it('explains where to create a pricing group when none exists', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
      PermissionId.pricingread,
    ];
    serveTypes();
    server.use(
      http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [{ ...pla, variants: [basic, matte] }] })),
      http.get('*/api/v1/pricing-groups', () => HttpResponse.json({ items: [] })),
    );
    const user = userEvent.setup();
    const dialog = await openPla(user);
    expect(await within(dialog).findByText('Rates per variant')).toBeInTheDocument();
    expect(within(dialog).getByText(/Rates per variant appear once a pricing group exists under/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Sales → Pricing' })).toHaveAttribute('href', '/pricing');
    expect(within(dialog).queryByRole('table', { name: 'Rates of PLA per variant' })).not.toBeInTheDocument();
  });

  it('keeps the rates read-only without pricing.manage and hides them without pricing.read', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
      PermissionId.pricingread,
    ];
    serveTypes();
    server.use(
      http.get('*/api/v1/material-types', () => HttpResponse.json({ items: [{ ...pla, variants: [basic, matte] }] })),
      http.get('*/api/v1/pricing-groups', () => HttpResponse.json({ items: [group([rule({})])] })),
    );
    const user = userEvent.setup();
    const dialog = await openPla(user);
    const rates = await within(dialog).findByRole('table', { name: 'Rates of PLA per variant' });
    expect(within(rates).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rates).getAllByText('0,04 €/g · inherited')).toHaveLength(2);
  });

  it('shows no variants for part categories', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    serveTypes();
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('types'));
    const table = await openTypes(user);
    await user.click(await within(table).findByRole('button', { name: 'Fasteners' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit category' });
    expect(within(dialog).queryByText('Variants')).not.toBeInTheDocument();
  });
});

describe('Article form', () => {
  const material = {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8f100',
    displayId: 'A-0100',
    name: 'PLA Red',
    kind: 'filament',
    materialTypeCode: 'PLA',
    machineUse: true,
    prices: [],
    attention: [],
    materialTypeId: pla.id,
    materialTypeName: 'PLA',
    colorName: 'Red',
    colorHex: '#C62828',
    unit: 'g',
    dimension: 'mass',
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
    version: 4,
    createdAt: now,
    updatedAt: now,
  } as Material;

  it('validates the colour code, previews it and follows the generated name', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    serveTypes();
    let submitted: Record<string, unknown> | undefined;
    server.use(
      http.patch(`*/api/v1/materials/${material.id}`, async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(material);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<MaterialFormModal open onClose={() => undefined} material={material} />, '/');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Choose colour code')).toHaveValue('#c62828');
    // "PLA · Red" is not the stored name "PLA Red", so the stored name stays as typed.
    expect(within(dialog).getByLabelText('Name (optional)')).toHaveValue('PLA Red');
    const hex = within(dialog).getByLabelText('Colour code (optional)');
    await user.clear(hex);
    await user.type(hex, 'red');
    await user.click(within(dialog).getByRole('button', { name: 'Save article' }));
    expect(await within(dialog).findByText('Use the form #RRGGBB, for example #C62828.')).toBeInTheDocument();
    expect(submitted).toBeUndefined();
    await user.clear(hex);
    await user.type(hex, '#1a1a1a');
    await user.click(within(dialog).getByRole('button', { name: 'Save article' }));
    await waitFor(() =>
      expect(submitted).toMatchObject({
        materialTypeId: pla.id,
        name: 'PLA Red',
        colorName: 'Red',
        colorHex: '#1A1A1A',
        filamentDiameterMm: '1.75',
        expectedVersion: 4,
      }),
    );
  });

  it('leaves the name out when it is the generated one and takes the reported colour with one click', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    serveTypes();
    const generated = { ...material, name: 'PLA · Red', variant: null } as Material;
    let submitted: Record<string, unknown> | undefined;
    server.use(
      http.patch(`*/api/v1/materials/${material.id}`, async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(generated);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <MaterialFormModal open onClose={() => undefined} material={generated} reportedColorHex="1a1a1a" />,
      '/',
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Name (optional)')).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Use reported color (#1A1A1A)' }));
    expect(within(dialog).getByLabelText('Colour code (optional)')).toHaveValue('#1A1A1A');
    await user.click(within(dialog).getByRole('button', { name: 'Save article' }));
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).not.toHaveProperty('name');
  });

  it('limits the unit to the type dimension, warns about the conversion and sends the new unit', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    const tape = type({
      id: '0192f6f8-743e-7c77-a349-cd07c3e8f010',
      name: 'Tape',
      code: 'TAPE',
      kind: 'consumable',
      unit: 'm',
      dimension: 'length',
      processIds: [],
    });
    serveTypes([pla, tape]);
    const tapeRoll = {
      ...material,
      kind: 'consumable',
      materialTypeId: tape.id,
      materialTypeName: 'Tape',
      unit: 'm',
      dimension: 'length',
      colorName: null,
      colorHex: null,
      filamentDiameterMm: null,
      name: 'Tape roll',
      quantity: '5',
    } as Material;
    let submitted: Record<string, unknown> | undefined;
    server.use(
      http.patch(`*/api/v1/materials/${material.id}`, async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(tapeRoll);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<MaterialFormModal open onClose={() => undefined} material={tapeRoll} />, '/');
    const dialog = await screen.findByRole('dialog');
    const select = await within(dialog).findByLabelText('Unit');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Millimetres (mm)', 'Centimetres (cm)', 'Metres (m)']);
    expect(within(dialog).queryByText('Quantities are converted')).not.toBeInTheDocument();
    await user.selectOptions(select, 'cm');
    expect(await within(dialog).findByText('Quantities are converted')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save article' }));
    await waitFor(() => expect(submitted).toMatchObject({ unit: 'cm', countLabel: null }));
  });

  it('shows the count label only for pieces and sends it', async () => {
    auth.permissions = [
      PermissionId.inventoryread,
      PermissionId.inventoryarticlesmanage,
      PermissionId.inventoryreceive,
      PermissionId.inventoryconsume,
      PermissionId.inventorycorrect,
    ];
    serveTypes();
    const bolts = {
      ...material,
      kind: 'part',
      materialTypeId: fasteners.id,
      materialTypeName: 'Fasteners',
      unit: 'piece',
      dimension: 'count',
      colorName: null,
      colorHex: null,
      filamentDiameterMm: null,
      name: 'M3 bolt',
    } as Material;
    let submitted: Record<string, unknown> | undefined;
    server.use(
      http.patch(`*/api/v1/materials/${material.id}`, async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(bolts);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<MaterialFormModal open onClose={() => undefined} material={bolts} />, '/');
    const dialog = await screen.findByRole('dialog');
    await user.type(await within(dialog).findByLabelText('Count label (optional)'), 'pair');
    await user.click(within(dialog).getByRole('button', { name: 'Save article' }));
    await waitFor(() => expect(submitted).toMatchObject({ unit: 'piece', countLabel: 'pair' }));
  });
});
