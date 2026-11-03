import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { as, orderList } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const machineId = '01995ea6-6d00-7000-8000-0000000000a1';
const materialId = '01995ea6-6d00-7000-8000-0000000000b1';
const sales = [PermissionId.ordersread, PermissionId.paymentsread];
const read = [...sales, PermissionId.pricingread, PermissionId.machinesread, PermissionId.inventoryread];

const group = (overrides: Record<string, unknown>) => ({
  pricingGroupId: 'g1',
  name: 'Members',
  isDefault: true,
  machineRate: null,
  machineAmount: null,
  materialRate: null,
  materialAmount: null,
  total: null,
  complete: false,
  ...overrides,
});

function serve(quote: (url: URL) => Record<string, unknown>) {
  orderList([]);
  const requests: URL[] = [];
  server.use(
    http.get('*/api/v1/payments', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
    http.get('*/api/v1/machines', () =>
      HttpResponse.json({
        items: [{ id: machineId, name: 'Laser 1', machineType: { name: 'Laser' }, status: 'active' }],
        page: 1,
        pageSize: 100,
        total: 1,
      }),
    ),
    http.get('*/api/v1/materials', () =>
      HttpResponse.json({
        items: [
          {
            id: materialId,
            displayId: 'A-0003',
            name: 'Birch plywood',
            unit: 'piece',
            machineUse: true,
            prices: [],
            active: true,
          },
        ],
        page: 1,
        pageSize: 100,
        total: 1,
        totalInventoryValue: '0.00',
      }),
    ),
    http.get('*/api/v1/pricing/quote', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      return HttpResponse.json(quote(url));
    }),
  );
  return requests;
}

async function open() {
  renderRoute(<App />, '/sales');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Price lookup' }));
  return { user, dialog: await screen.findByRole('dialog') };
}

async function pick(user: ReturnType<typeof userEvent.setup>, label: RegExp, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('price lookup', () => {
  it('prices a machine run with material for every group and flags missing rates', async () => {
    as(read);
    const requests = serve(() => ({
      machine: { id: machineId, name: 'Laser 1', machineTypeName: 'Laser' },
      material: {
        id: materialId,
        name: 'Birch plywood',
        unit: 'piece',
        materialTypeName: 'Plywood',
        displayId: 'A-0003',
      },
      hours: '1.5',
      quantity: '2',
      groups: [
        group({
          machineRate: '10.00',
          machineAmount: '15.00',
          materialRate: '2.00',
          materialAmount: '4.00',
          total: '19.00',
          complete: true,
        }),
        group({
          pricingGroupId: 'g2',
          name: 'External',
          isDefault: false,
          machineRate: '20.00',
          machineAmount: '30.00',
        }),
      ],
    }));
    const { user, dialog } = await open();
    await pick(user, /^Machine/, 'Laser 1');
    await user.type(within(dialog).getByRole('textbox', { name: 'Hours' }), '1,5');
    await pick(user, /Material article/, 'A-0003 · Birch plywood (piece)');
    await user.type(within(dialog).getByRole('textbox', { name: 'Quantity (piece)' }), '2');
    const table = await within(dialog).findByRole('table', { name: 'Prices by pricing group' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('Default')).toBeInTheDocument();
    expect(within(rows[1]).getByText('€19.00')).toBeInTheDocument();
    expect(within(rows[2]).getByText('€30.00')).toBeInTheDocument();
    expect(within(rows[2]).getByText('No rate')).toBeInTheDocument();
    const last = requests[requests.length - 1];
    expect(Object.fromEntries(last.searchParams)).toEqual({
      machineId,
      hours: '1.5',
      materialId,
      quantity: '2',
    });
  });

  it('prices an inventory item sold from stock with its price source', async () => {
    as(read);
    const requests = serve(() => ({
      machine: null,
      material: {
        id: materialId,
        name: 'Birch plywood',
        unit: 'piece',
        materialTypeName: 'Plywood',
        displayId: 'A-0003',
      },
      hours: null,
      quantity: '3',
      groups: [
        group({
          materialRate: '4.00',
          materialAmount: '12.00',
          materialPriceSource: 'stock_article',
          total: '12.00',
          complete: true,
        }),
      ],
    }));
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('tab', { name: 'Inventory item' }));
    await pick(user, /Inventory article/, 'A-0003 · Birch plywood (piece)');
    await user.type(within(dialog).getByRole('textbox', { name: 'Quantity (piece)' }), '3');
    expect((await within(dialog).findAllByText('€12.00')).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/article price/)).toBeInTheDocument();
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(Object.fromEntries(requests[requests.length - 1].searchParams)).toEqual({ materialId, quantity: '3' });
  });

  it('hides the entry point without pricing.read', async () => {
    as([...sales, PermissionId.machinesread, PermissionId.inventoryread]);
    serve(() => ({}));
    renderRoute(<App />, '/sales');
    await screen.findByRole('region', { name: 'Key figures' });
    expect(screen.queryByRole('button', { name: 'Price lookup' })).not.toBeInTheDocument();
  });
});
