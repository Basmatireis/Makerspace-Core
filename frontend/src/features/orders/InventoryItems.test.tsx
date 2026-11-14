import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Material, OrderItem } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { lineAmountCents } from './money';
import { as, at, everything, ids, order } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const materialId = '01995ea6-6d00-7000-8000-000000000201';
const groupId = '01995ea6-6d00-7000-8000-000000000204';
const withInventory = [...everything, PermissionId.inventoryread];

const article = (overrides: Partial<Material> = {}): Material =>
  ({
    id: materialId,
    displayId: 'A-0007',
    name: 'M3 heat-set insert',
    kind: 'part',
    materialTypeId: '01995ea6-6d00-7000-8000-000000000202',
    materialTypeName: 'Fasteners',
    materialTypeCode: 'FAST',
    machineUse: false,
    variant: null,
    manufacturer: null,
    packageSize: '100',
    storageLocation: null,
    notes: null,
    colorName: null,
    colorHex: null,
    unit: 'piece',
    active: true,
    lowStockThreshold: null,
    quantity: '12',
    assignedQuantity: '0',
    unassignedQuantity: '12',
    filamentDiameterMm: null,
    averageUnitCost: '0.1',
    inventoryValue: '1.2',
    stockState: 'in_stock',
    inventoryVersion: 2,
    recentConsumption: '0',
    prices: [
      {
        pricingGroupId: groupId,
        pricingGroupName: 'Partners',
        rate: '0.25',
        source: 'stock_article',
        pricingRuleId: '01995ea6-6d00-7000-8000-000000000205',
      },
    ],
    attention: [],
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }) as Material;

const stockItem: OrderItem = {
  id: '01995ea6-6d00-7000-8000-000000000203',
  position: 2,
  kind: 'inventory_item',
  description: 'M3 heat-set insert',
  quantity: '4',
  unit: 'piece',
  unitPrice: '0.25',
  amount: '1.00',
  sourceChanged: false,
  sourceMaterialId: materialId,
  createdAt: at,
};

function serve(articles: Material[] = [article()], current = order()) {
  server.use(
    http.get(`*/api/v1/orders/${current.id}`, () => HttpResponse.json(current)),
    http.get('*/api/v1/orders', () => HttpResponse.json({ items: [current], page: 1, pageSize: 100, total: 1 })),
    http.get('*/api/v1/materials', () =>
      HttpResponse.json({ items: articles, page: 1, pageSize: 25, total: articles.length, totalInventoryValue: '0' }),
    ),
    // The customer is an organization of the Partners group, so its price is prefilled.
    http.get('*/api/v1/billing-parties', () =>
      HttpResponse.json({
        items: [
          {
            kind: 'organization',
            id: ids.customer,
            displayName: 'Example institute',
            pricingGroup: { id: groupId, name: 'Partners' },
            pricingGroupAssignmentVersion: 1,
          },
        ],
      }),
    ),
    http.get('*/api/v1/machine-logbook/work-items', () =>
      HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 }),
    ),
  );
}

/** Carbon modals are named by their label; the heading identifies them. */
async function dialogTitled(title: string) {
  const heading = await screen.findByRole('heading', { name: title });
  return heading.closest<HTMLElement>('[role="dialog"]')!;
}

/** Opens "Add from inventory": a new item starts in the article picker; picking the insert shows the form. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add item' }));
  const choice = await dialogTitled('Add to order');
  await user.click(within(choice).getByText('Something from inventory'));
  await user.click(within(choice).getByRole('button', { name: 'Continue' }));
  const picker = await dialogTitled('Select article');
  await user.click(await within(picker).findByText('M3 heat-set insert'));
  return dialogTitled('Add from inventory');
}

function captureAdd() {
  const captured: { body?: Record<string, unknown> } = {};
  server.use(
    http.post(`*/api/v1/orders/${ids.order}/items`, async ({ request }) => {
      captured.body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(order({ version: 3 }), { status: 201 });
    }),
  );
  return captured;
}

describe('order items from inventory', () => {
  it('rounds the line amount half up to cents', () => {
    expect(lineAmountCents('3', '0.25')).toBe(75);
    expect(lineAmountCents('1.5', '0.01')).toBe(2);
    expect(lineAmountCents('0.5', '0.01')).toBe(1);
    expect(lineAmountCents('0.4', '0.01')).toBe(0);
    expect(lineAmountCents('250', '0.018')).toBe(450);
  });

  it('does not offer inventory without inventory.read', async () => {
    as(everything);
    serve();
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    await user.click(await screen.findByRole('button', { name: 'Add item' }));
    const choice = await dialogTitled('Add to order');
    expect(within(choice).getByText('A custom line')).toBeInTheDocument();
    expect(within(choice).queryByText('Something from inventory')).not.toBeInTheDocument();
  });

  it('prefills the price of the customer’s pricing group', async () => {
    as(withInventory);
    serve();
    const captured = captureAdd();
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    const dialog = await openDialog(user);
    await waitFor(() => expect(within(dialog).getByLabelText(/^Unit price/)).toHaveValue('0.25'));
    await user.clear(within(dialog).getByLabelText(/^Quantity/));
    await user.type(within(dialog).getByLabelText(/^Quantity/), '4');
    expect(within(dialog).getByText('€1.00')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }));
    await waitFor(() =>
      expect(captured.body).toMatchObject({
        kind: 'inventory_item',
        materialId,
        quantity: '4',
        unitPrice: '0.25',
        expectedVersion: 2,
      }),
    );
  });

  it('sends an overridden unit price', async () => {
    as(withInventory);
    serve();
    const captured = captureAdd();
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    const dialog = await openDialog(user);
    await user.clear(within(dialog).getByLabelText(/^Unit price/));
    await user.type(within(dialog).getByLabelText(/^Unit price/), '0,4');
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }));
    await waitFor(() =>
      expect(captured.body).toMatchObject({ kind: 'inventory_item', materialId, quantity: '1', unitPrice: '0.4' }),
    );
  });

  it('leaves the price to the server without one and explains a missing group price', async () => {
    as([...withInventory, PermissionId.pricingread]);
    serve([article({ prices: [] })]);
    const captured: { body?: Record<string, unknown> } = {};
    server.use(
      http.post(`*/api/v1/orders/${ids.order}/items`, async ({ request }) => {
        captured.body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { code: 'article_price_missing', message: 'No price.', details: { pricingGroup: 'Partners' } },
          { status: 422 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    const dialog = await openDialog(user);
    expect(within(dialog).getByText(/This article has no price in any group/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }));
    expect(await within(dialog).findByText('No price for this customer')).toBeInTheDocument();
    expect(within(dialog).getByText(/has no price in the Partners pricing group/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing');
    expect(captured.body).toMatchObject({ kind: 'inventory_item', materialId, quantity: '1' });
    expect(captured.body).not.toHaveProperty('unitPrice');
  });

  it('warns, without blocking, when the quantity exceeds the loose stock', async () => {
    as(withInventory);
    serve();
    const captured = captureAdd();
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    const dialog = await openDialog(user);
    expect(within(dialog).queryByText(/in loose stock/)).not.toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/^Quantity/));
    await user.type(within(dialog).getByLabelText(/^Quantity/), '20');
    expect(
      await within(dialog).findByText('Only 12 pcs in loose stock — finalizing will fail until stock is received.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(captured.body).toMatchObject({ quantity: '20' }));
  });

  it('shows stock lines with a link to the article', async () => {
    as(withInventory);
    serve([article()], order({ items: [...order().items, stockItem] }));
    renderRoute(<App />, `/orders/${ids.order}`);
    const link = await screen.findByRole('link', { name: 'M3 heat-set insert' });
    expect(link).toHaveAttribute('href', `/workshop/inventory/materials/${materialId}`);
    expect(screen.getByText('Stock')).toBeInTheDocument();
  });

  it('shows a stock line without a link when the user cannot read inventory', async () => {
    as(everything);
    serve([article()], order({ items: [stockItem] }));
    renderRoute(<App />, `/orders/${ids.order}`);
    expect(await screen.findByText('M3 heat-set insert')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'M3 heat-set insert' })).not.toBeInTheDocument();
  });

  it('explains a finalization refused for missing stock and links to the article', async () => {
    as(withInventory.filter((permission) => permission !== PermissionId.paymentsrecord));
    serve([article()], order({ items: [stockItem] }));
    server.use(
      http.post(`*/api/v1/orders/${ids.order}/finalize`, () =>
        HttpResponse.json(
          { code: 'insufficient_stock', message: 'Not enough stock.', details: { materialId, available: '2' } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    await user.click(await screen.findByRole('button', { name: 'Finalize' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Finalize' }));
    const messages = await screen.findAllByText(/Not enough loose stock for M3 heat-set insert: 2 pcs available\./);
    expect(messages.length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Open the article' })[0]).toHaveAttribute(
      'href',
      `/workshop/inventory/materials/${materialId}`,
    );
  });
});
