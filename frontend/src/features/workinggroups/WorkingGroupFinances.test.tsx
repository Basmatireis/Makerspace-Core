import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkingGroupBudget,
  WorkingGroupBudgetPeriod,
  WorkingGroupPurchase,
  WorkingGroupSummary,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, fixturePersonId, otherPersonId } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const printId = '0192f6f8-743e-7c77-a349-cd07c3e8e001';
const woodId = '0192f6f8-743e-7c77-a349-cd07c3e8e002';
const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a001';
const requestId = '0192f6f8-743e-7c77-a349-cd07c3e8b001';
const pid = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e8d${String(n).padStart(3, '0')}`;
const ada = { personId: fixturePersonId, displayName: 'Ada Lovelace' };
const grace = { personId: otherPersonId, displayName: 'Grace Hopper' };

const groupSummary = (id: string, name: string, isMember: boolean): WorkingGroupSummary => ({
  id,
  name,
  description: '',
  lead: grace,
  memberCount: 3,
  machineCount: 0,
  isMember,
  isLead: false,
});

const period: WorkingGroupBudgetPeriod = {
  id: periodId,
  name: 'Year 2026',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  totalAmount: '1000.00',
  closed: false,
  current: true,
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
};

const budget: WorkingGroupBudget = {
  period,
  groups: [
    { groupId: printId, groupName: 'Printing', given: '400.00', spent: '50.00', reserved: '30.00', free: '320.00' },
    { groupId: woodId, groupName: 'Woodworking', given: '100.00', spent: '0.00', reserved: '0.00', free: '100.00' },
  ],
  totals: {
    totalAmount: '1000.00',
    givenSum: '500.00',
    keptBack: '500.00',
    spentSum: '50.00',
    reservedSum: '30.00',
    freeSum: '420.00',
  },
};

const purchase = (n: number, over: Partial<WorkingGroupPurchase>): WorkingGroupPurchase => ({
  id: pid(n),
  groupId: printId,
  groupName: 'Printing',
  periodId,
  periodName: 'Year 2026',
  periodClosed: false,
  item: `Item ${n}`,
  quantity: 2,
  unitPrice: '10.00',
  estimatedTotal: '20.00',
  how: 'central',
  status: 'wanted',
  requester: ada,
  needsProject: false,
  hasAttachment: false,
  hasReceipt: false,
  createdAt: '2026-03-01T10:00:00Z',
  canApprove: false,
  canDecline: false,
  canHandInReceipt: false,
  canMarkArrived: false,
  canMarkRefunded: false,
  canDelete: false,
  version: 3,
  ...over,
});

interface Served {
  bodies: Record<string, unknown[]>;
  headers: Record<string, Headers[]>;
}

function serve(
  permissions: PermissionId[],
  options: { member?: boolean; purchases?: WorkingGroupPurchase[]; truncated?: boolean } = {},
): Served {
  const served: Served = { bodies: {}, headers: {} };
  const record = async (name: string, request: Request, json = true) => {
    (served.headers[name] ??= []).push(request.headers);
    (served.bodies[name] ??= []).push(json ? await request.json() : await request.arrayBuffer());
  };
  const groups = [
    groupSummary(printId, 'Printing', options.member ?? true),
    groupSummary(woodId, 'Woodworking', false),
  ];
  const purchases = options.purchases ?? [];
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/working-groups', () => HttpResponse.json({ items: groups })),
    http.get('*/api/v1/working-group-tickets', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-todos', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-budget-periods', () => HttpResponse.json({ items: [period] })),
    http.get('*/api/v1/working-group-budget', () => HttpResponse.json(budget)),
    http.get('*/api/v1/working-group-purchases', () =>
      HttpResponse.json({ items: purchases, truncated: options.truncated }),
    ),
    http.get('*/api/v1/working-group-bookings', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-purchase-orders', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-finance-rules', () =>
      HttpResponse.json({
        projectThreshold: '500.00',
        offersThreshold: '200.00',
        projectRequests: [{ id: requestId, number: 'P-1', label: 'Workshop' }],
        version: 1,
      }),
    ),
    http.post('*/api/v1/working-group-purchases', async ({ request }) => {
      await record('create', request);
      return HttpResponse.json({ items: [purchase(99, {})] });
    }),
    ...(['approve', 'decline', 'arrived', 'refunded'] as const).map((action) =>
      http.post(`*/api/v1/working-group-purchases/:id/${action}`, async ({ request }) => {
        await record(action, request);
        return HttpResponse.json(purchase(1, {}));
      }),
    ),
    http.post('*/api/v1/working-group-purchases/:id/receipt', async ({ request }) => {
      await record('receipt', request, false);
      return HttpResponse.json(purchase(1, {}));
    }),
    http.post('*/api/v1/working-group-purchase-orders', async ({ request }) => {
      await record('order', request);
      return HttpResponse.json({});
    }),
    http.put('*/api/v1/working-group-budget-periods/:id/shares/:groupId', async ({ request }) => {
      await record('share', request);
      return HttpResponse.json(budget.groups[0]);
    }),
  );
  return served;
}

const member = [PermissionId.working_groupsread];
const financeManager = [PermissionId.working_groupsread, PermissionId.working_group_financesmanage];

beforeEach(() => {
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

const rowOf = (item: RegExp) => screen.findByRole('button', { name: item });

describe('working group purchases', () => {
  it('shows a member only their own group and no Budget navigation', async () => {
    serve(member, { purchases: [purchase(1, {})] });
    renderRoute(<App />, '/working-groups/purchases');

    expect(await screen.findByRole('heading', { name: 'Purchases' })).toBeInTheDocument();
    expect((await screen.findAllByRole('tab')).map((tab) => tab.textContent)).toEqual(['Printing']);
    expect(await rowOf(/Item 1/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Purchases' }).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('link', { name: 'Budget' })).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'Budget' })).toHaveTextContent('€320.00');
  });

  it('offers no Purchases navigation to a group manager who is neither member nor finance manager', async () => {
    serve([...member, PermissionId.working_groupsmanage], { member: false });
    renderRoute(<App />, '/working-groups/tasks');

    expect(await screen.findByRole('heading', { name: 'Tickets & to-dos' })).toBeInTheDocument();
    await screen.findAllByRole('link', { name: 'Overview' });
    expect(screen.queryAllByRole('link', { name: 'Purchases' })).toHaveLength(0);
  });

  it('shows finance managers the All groups tab and the Budget navigation', async () => {
    serve(financeManager, { member: false });
    renderRoute(<App />, '/working-groups/purchases');

    expect((await screen.findAllByRole('tab')).map((tab) => tab.textContent)).toEqual([
      'All groups',
      'Printing',
      'Woodworking',
    ]);
    expect(await screen.findAllByRole('link', { name: 'Budget' })).not.toHaveLength(0);
  });

  it('sends the whole batch from the add dialog', async () => {
    const user = userEvent.setup();
    const served = serve(member);
    renderRoute(<App />, '/working-groups/purchases');

    await user.click(await screen.findByRole('button', { name: 'Add purchases' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Item'), 'Nozzles');
    await user.clear(within(dialog).getByLabelText('Amount'));
    await user.type(within(dialog).getByLabelText('Amount'), '3');
    await user.type(within(dialog).getByLabelText('Price each'), '12,5');
    expect(within(dialog).getByText('Estimated total')).toHaveTextContent('€37.50');
    await user.click(within(dialog).getByRole('radio', { name: /I buy it myself/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(served.bodies.create).toHaveLength(1));
    expect(served.bodies.create[0]).toEqual({
      groupId: printId,
      how: 'self',
      items: [{ item: 'Nozzles', quantity: 3, unitPrice: '12.50' }],
    });
  });

  it('approves and declines from the panel when the flags allow it', async () => {
    const user = userEvent.setup();
    const served = serve(financeManager, {
      purchases: [purchase(1, { canApprove: true, canDecline: true, canDelete: true })],
    });
    renderRoute(<App />, '/working-groups/purchases?group=all');

    await user.click(await rowOf(/Item 1/));
    expect(screen.queryByRole('button', { name: 'It arrived' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Money returned' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(served.bodies.approve).toEqual([{ expectedVersion: 3 }]));

    await user.click(screen.getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Too expensive');
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(served.bodies.decline).toEqual([{ expectedVersion: 3, reason: 'Too expensive' }]));
  });

  it('shows no actions without flags and no Approve for a purchase that needs a project', async () => {
    const user = userEvent.setup();
    serve(financeManager, {
      purchases: [
        purchase(1, {}),
        purchase(2, { needsProject: true, canApprove: true, canDecline: true, estimatedTotal: '900.00' }),
      ],
    });
    renderRoute(<App />, '/working-groups/purchases?group=all');

    await user.click(await rowOf(/Item 1/));
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    await user.click(await rowOf(/Item 2/));
    expect(await screen.findAllByText('Needs a project')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });

  it('hands in a receipt with the amount and the version in headers', async () => {
    const user = userEvent.setup();
    const served = serve(member, {
      purchases: [purchase(1, { how: 'self', status: 'approved', canHandInReceipt: true })],
    });
    renderRoute(<App />, '/working-groups/purchases');

    await user.click(await rowOf(/Item 1/));
    await user.click(screen.getByRole('button', { name: 'Hand in the receipt' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Amount on the receipt'), '18,40');
    await user.upload(
      within(dialog).getByLabelText('Receipt file'),
      new File(['receipt'], 'receipt.pdf', { type: 'application/pdf' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Hand in' }));

    await waitFor(() => expect(served.headers.receipt).toHaveLength(1));
    const headers = served.headers.receipt[0];
    expect(headers.get('x-receipt-amount')).toBe('18.40');
    expect(headers.get('x-expected-version')).toBe('3');
    expect(headers.get('x-file-name')).toBe('receipt.pdf');
    expect((served.bodies.receipt[0] as ArrayBuffer).byteLength).toBe(7);
  });

  it('marks arrival and returned money', async () => {
    const user = userEvent.setup();
    const served = serve(financeManager, {
      purchases: [
        purchase(1, { status: 'ordered', canMarkArrived: true }),
        purchase(2, { how: 'self', status: 'bought', canMarkRefunded: true }),
      ],
    });
    renderRoute(<App />, '/working-groups/purchases?group=all');

    await user.click(await rowOf(/Item 1/));
    await user.click(screen.getByRole('button', { name: 'It arrived' }));
    await waitFor(() => expect(served.bodies.arrived).toEqual([{ expectedVersion: 3 }]));

    await user.click(await rowOf(/Item 2/));
    await user.click(screen.getByRole('button', { name: 'Money returned' }));
    await waitFor(() => expect(served.bodies.refunded).toEqual([{ expectedVersion: 3 }]));
  });

  it('asks for a project request when the order reaches the threshold', async () => {
    const user = userEvent.setup();
    const served = serve(financeManager, {
      member: false,
      purchases: [
        purchase(1, { status: 'approved', estimatedTotal: '300.00' }),
        purchase(2, { status: 'approved', estimatedTotal: '250.00' }),
      ],
    });
    renderRoute(<App />, '/working-groups/purchases');

    await user.click(await screen.findByRole('button', { name: /Collective order/ }));
    await user.click(await screen.findByRole('checkbox', { name: 'Select Item 1' }));
    expect(screen.queryByLabelText('Project request')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select Item 2' }));
    const select = await screen.findByLabelText('Project request');
    await user.type(screen.getByLabelText('Shop'), 'Reichelt');
    await user.click(screen.getByRole('button', { name: 'Mark as ordered' }));
    expect(await screen.findByText('Choose the project request.')).toBeInTheDocument();
    expect(served.bodies.order).toBeUndefined();

    await user.selectOptions(select, requestId);
    await user.click(screen.getByRole('button', { name: 'Mark as ordered' }));
    await waitFor(() => expect(served.bodies.order).toHaveLength(1));
    expect(served.bodies.order[0]).toEqual({
      shop: 'Reichelt',
      purchaseIds: [pid(1), pid(2)],
      projectRequestId: requestId,
    });
  });

  it('warns when the list is truncated', async () => {
    serve(member, { purchases: [purchase(1, {})], truncated: true });
    renderRoute(<App />, '/working-groups/purchases');
    expect(await screen.findByText('Not all purchases are shown.')).toBeInTheDocument();
  });
});

describe('working group budget', () => {
  it('saves a changed share of a group', async () => {
    const user = userEvent.setup();
    const served = serve(financeManager);
    renderRoute(<App />, '/working-groups/budget');

    expect(await screen.findByRole('heading', { name: 'Budget' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Printing/ }));
    const given = await screen.findByLabelText('Given');
    await user.clear(given);
    await user.type(given, '450');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(served.bodies.share).toEqual([{ amount: '450.00' }]));
  });
});
