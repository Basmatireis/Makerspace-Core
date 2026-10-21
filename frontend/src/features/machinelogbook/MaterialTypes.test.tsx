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
import { machineLogbookPaths } from './shared/paths';
import { ToastProvider } from './shared/toasts';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const now = '2026-09-15T11:26:00Z';
const type = (overrides: Partial<MaterialType>): MaterialType => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f001', name: 'PLA', kind: 'filament', unit: 'g', processes: ['fdm_printing'], active: true, materialCount: 3, pricingRuleCount: 2, version: 2, createdAt: now, updatedAt: now, ...overrides,
});
const pla = type({});
const plywood = type({ id: '0192f6f8-743e-7c77-a349-cd07c3e8f002', name: 'Plywood', kind: 'consumable', unit: 'm2', processes: ['laser_cutting'], materialCount: 0, pricingRuleCount: 0, version: 1 });
const retired = type({ id: '0192f6f8-743e-7c77-a349-cd07c3e8f003', name: 'ABS', active: false, materialCount: 0, pricingRuleCount: 0 });
const fasteners = type({ id: '0192f6f8-743e-7c77-a349-cd07c3e8f004', name: 'Fasteners', kind: 'part', unit: 'piece', processes: [], materialCount: 2, pricingRuleCount: 0, version: 1 });

function renderWithProviders(node: ReactNode, path: string) {
  const router = createMemoryRouter([{ path: '*', element: node }], { initialEntries: [path] });
  render(<QueryClientProvider client={testQueryClient()}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>);
  return router;
}

function serveTypes(items: MaterialType[] = [pla, plywood, retired, fasteners]) {
  server.use(
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items })),
    http.get('*/api/v1/materials', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0, totalInventoryValue: '0' })),
    http.get('*/api/v1/inventory/suggestions', () => HttpResponse.json({ variants: [], manufacturers: [], suppliers: [], storageLocations: [] })),
  );
}

async function openTypes(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('img', { name: 'More inventory actions' }));
  await user.click(await screen.findByText('Types & categories'));
  return screen.findByRole('dialog', { name: 'Types & categories' });
}

describe('Types and categories', () => {
  it('lists the types of a kind and switches to part categories', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveTypes();
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory());
    const dialog = await openTypes(user);
    const table = await within(dialog).findByRole('table', { name: 'Filament types' });
    expect(within(table).getByText('PLA')).toBeInTheDocument();
    expect(within(table).getByText('ABS')).toBeInTheDocument();
    expect(within(table).queryByText('Plywood')).not.toBeInTheDocument();
    // Readers cannot edit or add.
    expect(within(table).queryByRole('button', { name: 'PLA' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add material type' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('tab', { name: 'Part categories' }));
    const categories = await within(dialog).findByRole('table', { name: 'Part categories' });
    expect(within(categories).getByText('Fasteners')).toBeInTheDocument();
    expect(within(categories).queryByRole('columnheader', { name: 'Processes' })).not.toBeInTheDocument();
  });

  it('creates a filament type in grams without asking for processes', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveTypes();
    let submitted: unknown;
    server.use(http.post('*/api/v1/material-types', async ({ request }) => {
      submitted = await request.json();
      return HttpResponse.json(type({ ...(submitted as object), id: pla.id, materialCount: 0, pricingRuleCount: 0, version: 1 }), { status: 201 });
    }));
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory());
    const list = await openTypes(user);
    await user.click(within(list).getByRole('button', { name: 'Add material type' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add material type' });
    expect(within(dialog).getByLabelText('Unit')).toBeDisabled();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add material type' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'PETG-CF');
    await user.click(within(dialog).getByRole('button', { name: 'Add material type' }));
    await waitFor(() => expect(submitted).toEqual({ name: 'PETG-CF', kind: 'filament', unit: 'g' }));
    expect(await screen.findByText('Material type added')).toBeInTheDocument();
  });

  it('creates a consumable type with its processes and a part category without any', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveTypes();
    const bodies: unknown[] = [];
    server.use(http.post('*/api/v1/material-types', async ({ request }) => {
      const body = await request.json() as object;
      bodies.push(body);
      return HttpResponse.json(type({ ...body, id: pla.id, materialCount: 0, pricingRuleCount: 0, version: 1 }), { status: 201 });
    }));
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('consumables'));
    const list = await openTypes(user);
    await user.click(within(list).getByRole('button', { name: 'Add material type' }));
    let dialog = await screen.findByRole('dialog', { name: 'Add material type' });
    await user.type(within(dialog).getByLabelText('Name'), 'Vinyl foil');
    await user.selectOptions(within(dialog).getByLabelText('Unit'), 'm2');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Other' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Vinyl cutting' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add material type' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ name: 'Vinyl foil', kind: 'consumable', unit: 'm2', processes: ['vinyl_cutting'] });

    // Back in the list: parts have categories.
    const again = await screen.findByRole('dialog', { name: 'Types & categories' });
    await user.click(within(again).getByRole('tab', { name: 'Part categories' }));
    await user.click(within(again).getByRole('button', { name: 'Add category' }));
    dialog = await screen.findByRole('dialog', { name: 'Add category' });
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'Bike');
    await user.click(within(dialog).getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ name: 'Bike', kind: 'part', unit: 'piece' });
  });

  it('locks the unit of a used type and explains a refused delete', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveTypes();
    server.use(http.delete(`*/api/v1/material-types/${pla.id}`, () => HttpResponse.json({ code: 'material_type_in_use', message: 'in use' }, { status: 409 })));
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory());
    const list = await openTypes(user);
    await user.click(await within(list).findByRole('button', { name: 'PLA' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit material type' });
    expect(within(dialog).getByLabelText('Unit')).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete this material type?');
    await user.click(await screen.findByRole('button', { name: 'Delete material type' }));
    expect(await screen.findByText('In use')).toBeInTheDocument();
  });
});

describe('Article form', () => {
  const material = {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8f100', name: 'PLA Red', kind: 'filament', materialTypeId: pla.id, materialTypeName: 'PLA', colorName: 'Red', colorHex: '#C62828', unit: 'g', active: true,
    lowStockThreshold: null, quantity: '0', assignedQuantity: '0', unassignedQuantity: '0', filamentDiameterMm: '1.75', averageUnitCost: '0', inventoryValue: '0', stockState: 'empty',
    inventoryVersion: 1, recentConsumption: '0', version: 4, createdAt: now, updatedAt: now,
  } as Material;

  it('validates the colour code, previews it and follows the generated name', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveTypes();
    let submitted: Record<string, unknown> | undefined;
    server.use(http.patch(`*/api/v1/materials/${material.id}`, async ({ request }) => { submitted = await request.json() as Record<string, unknown>; return HttpResponse.json(material); }));
    const user = userEvent.setup();
    renderWithProviders(<MaterialFormModal open onClose={() => undefined} material={material} />, '/');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'Colour #C62828' })).toBeInTheDocument();
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
    await waitFor(() => expect(submitted).toMatchObject({ materialTypeId: pla.id, name: 'PLA Red', colorName: 'Red', colorHex: '#1A1A1A', filamentDiameterMm: '1.75', expectedVersion: 4 }));
  });

  it('leaves the name out when it is the generated one and takes the reported colour with one click', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveTypes();
    const generated = { ...material, name: 'PLA · Red', variant: null } as Material;
    let submitted: Record<string, unknown> | undefined;
    server.use(http.patch(`*/api/v1/materials/${material.id}`, async ({ request }) => { submitted = await request.json() as Record<string, unknown>; return HttpResponse.json(generated); }));
    const user = userEvent.setup();
    renderWithProviders(<MaterialFormModal open onClose={() => undefined} material={generated} reportedColorHex="1a1a1a" />, '/');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Name (optional)')).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Use reported color (#1A1A1A)' }));
    expect(within(dialog).getByLabelText('Colour code (optional)')).toHaveValue('#1A1A1A');
    await user.click(within(dialog).getByRole('button', { name: 'Save article' }));
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).not.toHaveProperty('name');
  });
});
