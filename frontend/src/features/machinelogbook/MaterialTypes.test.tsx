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
  id: '0192f6f8-743e-7c77-a349-cd07c3e8f001', name: 'PLA', unit: 'g', processes: ['fdm_printing'], active: true, materialCount: 3, pricingRuleCount: 2, version: 2, createdAt: now, updatedAt: now, ...overrides,
});
const pla = type({});
const unused = type({ id: '0192f6f8-743e-7c77-a349-cd07c3e8f002', name: 'Plywood', unit: 'm2', materialCount: 0, pricingRuleCount: 0, version: 1 });
const retired = type({ id: '0192f6f8-743e-7c77-a349-cd07c3e8f003', name: 'ABS', active: false, materialCount: 0, pricingRuleCount: 0 });

function renderWithProviders(node: ReactNode, path: string) {
  const router = createMemoryRouter([{ path: '*', element: node }], { initialEntries: [path] });
  render(<QueryClientProvider client={testQueryClient()}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>);
  return router;
}

function serveTypes(items: MaterialType[] = [pla, unused, retired]) {
  server.use(
    http.get('*/api/v1/material-types', () => HttpResponse.json({ items })),
    http.get('*/api/v1/materials', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0, totalInventoryValue: '0' })),
  );
}

describe('Material types section', () => {
  it('lists types and filters them by unit and status', async () => {
    auth.permissions = [PermissionId.inventoryread];
    serveTypes();
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('material-types'));
    const table = await screen.findByRole('table', { name: 'Material types' });
    expect(await within(table).findByText('PLA')).toBeInTheDocument();
    expect(within(table).getByText('Plywood')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add material type' })).not.toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'PLA' })).not.toBeInTheDocument();

    await user.click(screen.getByText('Filters', { selector: '.cds--tooltip-content' }).closest('.cds--popover-container')!.querySelector('button') as HTMLElement);
    await user.click(await screen.findByRole('checkbox', { name: 'm²' }));
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Material types' })).queryByText('PLA')).not.toBeInTheDocument());
    expect(within(screen.getByRole('table', { name: 'Material types' })).getByText('Plywood')).toBeInTheDocument();
  });

  it('creates a material type', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveTypes([]);
    let submitted: unknown;
    server.use(http.post('*/api/v1/material-types', async ({ request }) => {
      submitted = await request.json();
      return HttpResponse.json(type({ ...(submitted as object), id: pla.id, materialCount: 0, pricingRuleCount: 0, version: 1 }), { status: 201 });
    }));
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('material-types'));
    await user.click((await screen.findAllByRole('button', { name: 'Add material type' }))[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add material type' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'PETG-CF');
    await user.selectOptions(within(dialog).getByLabelText('Unit'), 'g');
    // At least one process is required.
    await user.click(within(dialog).getByRole('button', { name: 'Add material type' }));
    expect(await within(dialog).findByText('Choose at least one process.')).toBeInTheDocument();
    expect(submitted).toBeUndefined();
    await user.click(within(dialog).getByRole('checkbox', { name: 'FDM 3D printing' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Other' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add material type' }));
    await waitFor(() => expect(submitted).toEqual({ name: 'PETG-CF', unit: 'g', processes: ['fdm_printing', 'other'] }));
    expect(await screen.findByText('Material type added')).toBeInTheDocument();
  });

  it('locks the unit of a used type and explains a refused delete', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveTypes();
    server.use(http.delete(`*/api/v1/material-types/${pla.id}`, () => HttpResponse.json({ code: 'material_type_in_use', message: 'in use' }, { status: 409 })));
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('material-types'));
    await user.click(await screen.findByRole('button', { name: 'PLA' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Unit')).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete this material type?');
    await user.click(await screen.findByRole('button', { name: 'Delete material type' }));
    expect(await screen.findByText('Material type is in use')).toBeInTheDocument();
  });

  it('deletes an unused type', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveTypes();
    let body: unknown;
    server.use(http.delete(`*/api/v1/material-types/${unused.id}`, async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }); }));
    const user = userEvent.setup();
    renderWithProviders(<InventoryPage />, machineLogbookPaths.inventory('material-types'));
    await user.click(await screen.findByRole('button', { name: 'Plywood' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete this material type?');
    await user.click(await screen.findByRole('button', { name: 'Delete material type' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: 1 }));
  });
});

describe('Material form colour', () => {
  const material = {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8f100', name: 'PLA Red', materialTypeId: pla.id, materialTypeName: 'PLA', colorName: 'Red', colorHex: '#C62828', unit: 'g', active: true,
    lowStockThreshold: null, quantity: '0', assignedQuantity: '0', unassignedQuantity: '0', filamentDiameterMm: '1.75', averageUnitCost: '0', inventoryValue: '0', stockState: 'empty',
    inventoryVersion: 1, recentConsumption: '0', version: 4, createdAt: now, updatedAt: now,
  } as Material;

  it('validates the colour code, previews it and shows the unit of the type read-only', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveTypes();
    let submitted: Record<string, unknown> | undefined;
    server.use(http.patch(`*/api/v1/materials/${material.id}`, async ({ request }) => { submitted = await request.json() as Record<string, unknown>; return HttpResponse.json(material); }));
    const user = userEvent.setup();
    renderWithProviders(<MaterialFormModal open onClose={() => undefined} material={material} />, '/');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Unit')).toHaveAttribute('readonly');
    expect(within(dialog).getByRole('img', { name: 'Colour #C62828' })).toBeInTheDocument();
    const hex = within(dialog).getByLabelText('Colour code (optional)');
    await user.clear(hex);
    await user.type(hex, 'red');
    await user.click(within(dialog).getByRole('button', { name: 'Save material' }));
    expect(await within(dialog).findByText('Use the form #RRGGBB, for example #C62828.')).toBeInTheDocument();
    expect(submitted).toBeUndefined();
    await user.clear(hex);
    await user.type(hex, '#1a1a1a');
    await user.click(within(dialog).getByRole('button', { name: 'Save material' }));
    await waitFor(() => expect(submitted).toMatchObject({ materialTypeId: pla.id, colorName: 'Red', colorHex: '#1A1A1A', expectedVersion: 4 }));
  });

  it('takes the reported colour with one click', async () => {
    auth.permissions = [PermissionId.inventoryread, PermissionId.inventorymanage];
    serveTypes();
    const user = userEvent.setup();
    renderWithProviders(<MaterialFormModal open onClose={() => undefined} reportedColorHex="1a1a1a" />, '/');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Use reported color (#1A1A1A)' }));
    expect(within(dialog).getByLabelText('Colour code (optional)')).toHaveValue('#1A1A1A');
  });
});
