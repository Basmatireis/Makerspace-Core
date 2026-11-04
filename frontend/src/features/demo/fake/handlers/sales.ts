import type {
  CashJournalEntry,
  CashRegister,
  Order,
  OrderAllocation,
  OrderItemInput,
  OrderPayment,
  PaymentInput,
  PriceQuote,
} from '../../../../api/generated/models';
import { actorOf, buildOrderItem, newOrder, recalculateOrder, recordPayment } from '../orderModel';
import { created, fail, notFound, ok, paged, type DemoReply, type DemoRouter } from '../router';
import { decimal, money, nextId, nextReference, toCents, type DemoStore } from '../store';

const lower = (value: unknown) => String(value ?? '').toLowerCase();
const findOrder = (store: DemoStore, id: string) => store.orders.find((order) => order.id === id);

function inRange(value: string, query: URLSearchParams): boolean {
  const from = query.get('from');
  const to = query.get('to');
  return (!from || value >= from) && (!to || value < to);
}

function finalize(order: Order, store: DemoStore): DemoReply | null {
  if (order.status !== 'draft') return fail(409, 'order_not_draft', 'Only a draft order can be finalized.');
  if (order.items.filter((item) => !item.removedAt).length === 0) {
    return fail(422, 'order_empty', 'Add at least one item first.');
  }
  order.status = 'finalized';
  recalculateOrder(store, order);
  return null;
}

function payInto(store: DemoStore, order: Order, inputs: PaymentInput[] | undefined) {
  for (const input of inputs ?? []) {
    if (toCents(order.outstandingAmount) <= 0) break;
    recordPayment(store, order, input);
    recalculateOrder(store, order);
  }
}

function cashEntries(store: DemoStore): CashJournalEntry[] {
  const cash = store.payments
    .filter((payment) => payment.method === 'cash')
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  let balance = 0;
  return cash.map((payment) => {
    const reversal = payment.entryKind === 'reversal';
    const cents = toCents(payment.amount);
    balance += reversal ? -cents : cents;
    const order = store.orders.find((item) => item.allocations.some((a) => a.paymentId === payment.id));
    return {
      id: payment.id,
      source: 'payment',
      kind: reversal ? 'refund' : 'receipt',
      reference: payment.reference,
      occurredAt: payment.occurredAt,
      day: payment.occurredAt.slice(0, 10),
      amountIn: reversal ? null : money(cents),
      amountOut: reversal ? money(cents) : null,
      balanceAfter: decimal(balance / 100, 2),
      recordedBy: payment.recordedBy,
      order: order ? { id: order.id, reference: order.reference, customerName: order.customerName } : null,
      paymentReason: payment.reason,
      reversedPaymentReference: payment.reversedPaymentReference,
      movementReason: null,
      note: '',
      count: null,
      version: null,
      updatedAt: null,
    };
  });
}

function cashRegister(store: DemoStore): CashRegister {
  const entries = cashEntries(store);
  const receipts = entries.reduce((sum, entry) => sum + toCents(entry.amountIn ?? 0), 0);
  const refunds = entries.reduce((sum, entry) => sum + toCents(entry.amountOut ?? 0), 0);
  return {
    receipts: money(receipts),
    refunds: money(refunds),
    paymentCorrections: '0.00',
    corrections: '0.00',
    countSurpluses: '0.00',
    countShortfalls: '0.00',
    refundsAndCorrections: decimal(refunds / 100, 2),
    withdrawals: '0.00',
    deposits: '0.00',
    expected: decimal((receipts - refunds) / 100, 2),
    to: null,
    lastCount: null,
  };
}

function quote(store: DemoStore, query: URLSearchParams): PriceQuote {
  const machine = store.machines.find((item) => item.id === query.get('machineId'));
  const material = store.materials.find((item) => item.id === query.get('materialId'));
  const hours = query.get('hours');
  const quantity = query.get('quantity');
  return {
    machine: machine ? { id: machine.id, name: machine.name, processName: machine.process.name } : null,
    material: material
      ? {
          id: material.id,
          displayId: material.displayId,
          name: material.name,
          unit: material.unit,
          materialTypeName: material.materialTypeName,
          variant: material.variant,
        }
      : null,
    hours,
    quantity,
    groups: store.pricingGroups.map((group) => {
      const machineRate = machine
        ? group.rules.find((rule) => rule.kind === 'machine_runtime' && rule.processId === machine.process.id)?.rate
        : undefined;
      const materialRate = material
        ? group.rules.find((rule) => rule.kind === 'material' && rule.materialTypeId === material.materialTypeId)?.rate
        : undefined;
      const machineCents = machineRate && hours ? Math.round(Number(hours) * toCents(machineRate)) : null;
      const materialCents = materialRate && quantity ? Math.round(Number(quantity) * toCents(materialRate)) : null;
      return {
        pricingGroupId: group.id,
        name: group.name,
        isDefault: group.isDefault,
        machineRate: machineRate ?? null,
        machineAmount: machineCents === null ? null : money(machineCents),
        materialRate: materialRate ?? null,
        materialAmount: materialCents === null ? null : money(materialCents),
        materialPriceSource: materialRate ? 'material_type' : null,
        total: money((machineCents ?? 0) + (materialCents ?? 0)),
        complete: (!machine || machineRate !== undefined) && (!material || materialRate !== undefined),
      };
    }),
  };
}

export function registerSales(router: DemoRouter<DemoStore>): void {
  router
    .get('/orders', ({ store, query }) => {
      const search = lower(query.get('search'));
      const status = query.get('status');
      const items = store.orders
        .filter(
          (order) =>
            (!status || order.status === status) &&
            (!search || lower(`${order.reference} ${order.customerName ?? ''}`).includes(search)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return ok(paged(items, query));
    })
    .get('/orders/{orderId}', ({ store, params }) => {
      const order = findOrder(store, params.orderId);
      return order ? ok(order) : notFound('Order');
    })
    .get('/payments/cash-register', ({ store }) => ok(cashRegister(store)))
    .get('/payments/cash-journal', ({ store, query }) => {
      const entries = cashEntries(store)
        .filter((entry) => inRange(entry.occurredAt, query))
        .reverse();
      const register = cashRegister(store);
      const cashIn = entries.reduce((sum, entry) => sum + toCents(entry.amountIn ?? 0), 0);
      const cashOut = entries.reduce((sum, entry) => sum + toCents(entry.amountOut ?? 0), 0);
      const days = [...new Set(entries.map((entry) => entry.day))].sort().map((date) => {
        const ofDay = entries.filter((entry) => entry.day === date);
        const dayIn = ofDay.reduce((sum, entry) => sum + toCents(entry.amountIn ?? 0), 0);
        const dayOut = ofDay.reduce((sum, entry) => sum + toCents(entry.amountOut ?? 0), 0);
        return {
          date,
          openingBalance: decimal((Number(ofDay.at(-1)?.balanceAfter ?? 0) * 100 - dayIn + dayOut) / 100, 2),
          closingBalance: ofDay[0]?.balanceAfter ?? '0.00',
          cashIn: money(dayIn),
          cashOut: money(dayOut),
        };
      });
      return ok({
        ...paged(entries, query, {}),
        from: query.get('from'),
        to: query.get('to'),
        days,
        openingBalance: '0.00',
        register,
        facts: {
          cashIn: money(cashIn),
          cashInEntries: entries.filter((entry) => entry.amountIn).length,
          receipts: entries.filter((entry) => entry.kind === 'receipt').length,
          deposits: 0,
          cashOut: money(cashOut),
          cashOutEntries: entries.filter((entry) => entry.amountOut).length,
          refunds: entries.filter((entry) => entry.kind === 'refund').length,
          corrections: 0,
          withdrawals: 0,
          net: decimal((cashIn - cashOut) / 100, 2),
          counts: 0,
        },
      });
    })
    .get('/payments/cash-counts', ({ query }) => ok(paged([], query)))
    .get('/payments/reconciliation', ({ store, query }) => {
      const entries = store.payments.filter((payment) => inRange(payment.occurredAt, query));
      const sum = (method: OrderPayment['method']) =>
        decimal(
          entries
            .filter((payment) => payment.method === method)
            .reduce(
              (total, payment) => total + (payment.entryKind === 'reversal' ? -1 : 1) * toCents(payment.amount),
              0,
            ) / 100,
          2,
        );
      return ok(paged(entries, query, { cash: sum('cash'), card: sum('card'), external: sum('external') }));
    })
    .get('/cash-movements', ({ query }) => ok(paged([], query)))
    .get('/payments', ({ store, query }) => {
      const method = query.get('method');
      const items = store.payments
        .filter((payment) => (!method || payment.method === method) && inRange(payment.occurredAt, query))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      return ok(paged(items, query));
    })
    .get('/payments/{paymentId}', ({ store, params }) => {
      const payment = store.payments.find((item) => item.id === params.paymentId);
      return payment ? ok(payment) : notFound('Payment');
    })
    .get('/external-invoice-requests', ({ query }) => ok(paged([], query)))
    .get('/pricing-groups', ({ store }) => ok({ items: store.pricingGroups }))
    .get('/pricing-role-groups', ({ store }) => ok({ items: store.rolePricingGroups }))
    .get('/pricing/quote', ({ store, query }) => ok(quote(store, query)))
    .get('/organizations', ({ store, query }) => {
      const search = lower(query.get('search'));
      return ok(
        paged(
          store.organizations.filter((item) => lower(item.name).includes(search)),
          query,
        ),
      );
    })
    .get('/organizations/{organizationId}', ({ store, params }) => {
      const organization = store.organizations.find((item) => item.id === params.organizationId);
      return organization ? ok(organization) : notFound('Organization');
    })
    .get('/organizations/{organizationId}/invoicing-requirements', () =>
      ok({ requirePurchaseOrderReference: false, version: 1 }),
    )
    .add(
      'POST',
      '/orders',
      ({ store, body }) => {
        const customer = body.customer as { kind: 'person' | 'organization'; id: string } | null | undefined;
        const order = newOrder(
          store,
          customer ?? null,
          (body.fulfillmentMode as Order['fulfillmentMode']) ?? 'immediate',
        );
        store.orders.push(order);
        return created(order);
      },
      'orders.write',
    )
    .add(
      'PATCH',
      '/orders/{orderId}',
      ({ store, params, body }) => {
        const order = findOrder(store, params.orderId);
        if (!order) return notFound('Order');
        if (order.status !== 'draft') return fail(409, 'order_not_draft', 'Only a draft order can be changed.');
        const customer = body.customer as { kind: 'person' | 'organization'; id: string } | null | undefined;
        if (customer !== undefined) {
          const draft = newOrder(store, customer, order.fulfillmentMode);
          Object.assign(order, {
            customer: draft.customer,
            customerKind: draft.customerKind,
            customerName: draft.customerName,
          });
        }
        order.fulfillmentMode = (body.fulfillmentMode as Order['fulfillmentMode']) ?? order.fulfillmentMode;
        return ok(recalculateOrder(store, order));
      },
      'orders.write',
    )
    .add(
      'POST',
      '/orders/{orderId}/items',
      ({ store, params, body }) => {
        const order = findOrder(store, params.orderId);
        if (!order) return notFound('Order');
        if (order.status !== 'draft') return fail(409, 'order_not_draft', 'Only a draft order can be changed.');
        const input = body as unknown as OrderItemInput;
        if (
          input.kind === 'machine_job' &&
          store.orders.some((other) =>
            other.items.some(
              (line) =>
                !line.removedAt && line.sourceMachineJobId === input.machineJobId && other.status !== 'cancelled',
            ),
          )
        ) {
          return fail(409, 'job_already_on_order', 'This job is already on an order.');
        }
        const item = buildOrderItem(store, order, input);
        if (!item) return fail(422, 'invalid_item', 'The item refers to something that does not exist.');
        order.items.push(item);
        return created(recalculateOrder(store, order));
      },
      'orders.write',
    )
    .add(
      'DELETE',
      '/orders/{orderId}/items/{itemId}',
      ({ store, params }) => {
        const order = findOrder(store, params.orderId);
        if (!order) return notFound('Order');
        if (order.status !== 'draft') return fail(409, 'order_not_draft', 'Only a draft order can be changed.');
        order.items = order.items.filter((item) => item.id !== params.itemId);
        order.items.forEach((item, index) => (item.position = index + 1));
        return ok(recalculateOrder(store, order));
      },
      'orders.write',
    )
    .add(
      'POST',
      '/orders/{orderId}/finalize',
      ({ store, params }) => {
        const order = findOrder(store, params.orderId);
        if (!order) return notFound('Order');
        return finalize(order, store) ?? created(order);
      },
      'orders.finalize',
    )
    .add(
      'POST',
      '/orders/{orderId}/checkout',
      ({ store, params, body }) => {
        const order = findOrder(store, params.orderId);
        if (!order) return notFound('Order');
        const problem = order.status === 'draft' ? finalize(order, store) : null;
        if (problem) return problem;
        payInto(store, order, body.payments as PaymentInput[] | undefined);
        return created(order);
      },
      'orders.finalize',
    )
    .add(
      'POST',
      '/orders/{orderId}/cancel',
      ({ store, params }) => {
        const order = findOrder(store, params.orderId);
        if (!order) return notFound('Order');
        if (order.allocations.length > 0) return fail(409, 'order_paid', 'Reverse the payments first.');
        order.status = 'cancelled';
        return created(recalculateOrder(store, order));
      },
      'orders.write',
    )
    .add(
      'POST',
      '/orders/{orderId}/payments',
      ({ store, params, body }) => {
        const order = findOrder(store, params.orderId);
        if (!order) return notFound('Order');
        if (order.status !== 'finalized') return fail(409, 'order_not_finalized', 'Finalize the order before paying.');
        if (toCents(order.outstandingAmount) <= 0) return fail(409, 'order_settled', 'Nothing is outstanding.');
        recordPayment(store, order, body.payment as PaymentInput);
        return created(recalculateOrder(store, order));
      },
      'payments.record',
    )
    .add(
      'POST',
      '/payments/{paymentId}/reverse',
      ({ store, params, body }) => {
        const payment = store.payments.find((item) => item.id === params.paymentId);
        const order = store.orders.find((item) => item.allocations.some((a) => a.paymentId === params.paymentId));
        if (!payment || !order) return notFound('Payment');
        if (payment.entryKind === 'reversal' || store.payments.some((item) => item.reversesPaymentId === payment.id)) {
          return fail(409, 'payment_reversed', 'This payment is already reversed.');
        }
        const reversal = body.reversal as { reasonKind: string; reason: string; occurredAt: string };
        const id = nextId(store);
        const reference = nextReference(store, 'PAY', 1);
        const share = (paymentId: string): OrderAllocation => ({
          id: nextId(store),
          paymentId,
          paymentReference: reference,
          orderId: order.id,
          orderReference: order.reference,
          amount: `-${payment.amount}`,
          operationId: nextId(store),
          createdAt: store.now.toISOString(),
        });
        store.payments.push({
          id,
          reference,
          entryKind: 'reversal',
          method: payment.method,
          amount: payment.amount,
          occurredAt: reversal.occurredAt,
          recordedAt: store.now.toISOString(),
          reversesPaymentId: payment.id,
          reversedPaymentReference: payment.reference,
          reasonKind: reversal.reasonKind,
          reason: reversal.reason,
          externalSource: '',
          externalReference: '',
          allocations: [share(id)],
          recordedBy: actorOf(store),
        });
        order.allocations.push(share(payment.id));
        return created(recalculateOrder(store, order));
      },
      'payments.record',
    );
}
