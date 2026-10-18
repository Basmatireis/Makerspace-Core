import { describe, expect, it } from 'vitest';
import * as base from '../mockData';
import {
  addJobItems, addManualItem, checkoutOrder, commitReplacement, createDraft, finalizeOrder, prepareInvoiceRequest, recordPayments, reverseOrder, reversePayment, startReplacement,
  SalesError, type Ctx, type SalesState,
} from './engine';
import { activeReceipts, buildOrderViews, readyToBill } from './logic';
import { salesSeed } from './mockData';
import { orderStatus } from './status';
import type { PaymentInput } from './types';

const ctx: Ctx = { at: new Date().toISOString(), actor: 'Test', machines: base.machines, machineTypes: base.machineTypes, prints: base.prints };
const cash = (amount: number): PaymentInput => ({ method: 'cash', amount, occurredAt: ctx.at, terminal: '', transactionReference: '' });
const card = (amount: number, reference: string): PaymentInput => ({ method: 'card', amount, occurredAt: ctx.at, terminal: 'Terminal 1', transactionReference: reference });
const views = (state: SalesState) => buildOrderViews(state);
const lena = base.people[0];

function fresh(): SalesState { return structuredClone(salesSeed); }
function finalizedDraft(state: SalesState, price = 10) {
  const draft = createDraft(state, ctx, { customer: lena, fulfillmentMode: 'immediate' });
  const withItem = addManualItem(draft.state, ctx, draft.orderId, { description: 'Test item', quantity: 1, unit: 'piece', unitPrice: price });
  return { state: finalizeOrder(withItem.state, ctx, draft.orderId).state, orderId: draft.orderId };
}
const thrown = (fn: () => unknown) => { try { fn(); } catch (error) { return error as SalesError; } return null; };

describe('sales seed', () => {
  const state = salesSeed;
  it('covers every state with consistent settlement', () => {
    const all = views(state);
    expect(all.length).toBeGreaterThanOrEqual(25);
    expect(state.payments.length).toBeGreaterThanOrEqual(35);
    expect(new Set(all.map((order) => orderStatus(order).key))).toEqual(new Set(['draft', 'awaiting_payment', 'partially_paid', 'paid', 'invoicing', 'no_payment_due', 'reversed', 'cancelled']));
    for (const order of all) {
      expect(order.settled).toBeGreaterThanOrEqual(0);
      expect(order.settled).toBeLessThanOrEqual(order.net + 0.001);
    }
  });
  it('has unique references and walk-in sales that are fully settled', () => {
    const refs = [...state.orders.map((order) => order.reference), ...state.payments.map((payment) => payment.reference)];
    expect(new Set(refs).size).toBe(refs.length);
    for (const order of views(state).filter((item) => !item.customer && item.status === 'finalized')) expect(order.outstanding).toBe(0);
  });
  it('lists billable jobs per customer and keeps blocked ones visible', () => {
    const groups = readyToBill(state.jobs, state.orders, base.prints, Date.now());
    expect(groups.length).toBeGreaterThanOrEqual(5);
    expect(groups.flatMap((group) => group.rows).some((row) => row.reason !== null)).toBe(true);
  });
});

describe('sales engine rules', () => {
  it('finalizes and records split payments, rejects overpayment', () => {
    const { state, orderId } = finalizedDraft(fresh());
    expect(thrown(() => recordPayments(state, ctx, orderId, [cash(11)]))?.code).toBe('payment_exceeds_outstanding');
    const paid = recordPayments(state, ctx, orderId, [cash(4), card(6, 'TX-NEW-1')]).state;
    expect(views(paid).find((order) => order.id === orderId)?.settlement).toBe('paid');
  });
  it('rejects a card reference that was already recorded', () => {
    const { state, orderId } = finalizedDraft(fresh());
    const first = recordPayments(state, ctx, orderId, [card(5, 'TX-DUP')]).state;
    expect(thrown(() => recordPayments(first, ctx, orderId, [card(5, 'TX-DUP')]))?.code).toBe('duplicate_transaction');
  });
  it('requires full settlement for a walk-in checkout', () => {
    const draft = createDraft(fresh(), ctx, { customer: null, fulfillmentMode: 'immediate' });
    const item = addManualItem(draft.state, ctx, draft.orderId, { description: 'Spool', quantity: 1, unit: 'piece', unitPrice: 20 });
    expect(thrown(() => checkoutOrder(item.state, ctx, draft.orderId, [cash(10)]))?.code).toBe('anonymous_requires_full_settlement');
    expect(views(checkoutOrder(item.state, ctx, draft.orderId, [cash(20)]).state).find((order) => order.id === draft.orderId)?.settlement).toBe('paid');
  });
  it('claims jobs on finalization and blocks a second order', () => {
    const state = fresh();
    const job = state.jobs.find((item) => item.id === 'j-1069')!;
    const draft = createDraft(state, ctx, { customer: job.customer, fulfillmentMode: 'immediate' });
    const added = addJobItems(draft.state, ctx, draft.orderId, [job.id]).state;
    const done = finalizeOrder(added, ctx, draft.orderId).state;
    expect(done.jobs.find((item) => item.id === job.id)?.order?.orderId).toBe(draft.orderId);
    const second = createDraft(done, ctx, { customer: job.customer, fulfillmentMode: 'immediate' });
    expect(thrown(() => addJobItems(second.state, ctx, second.orderId, [job.id]))?.code).toBe('job_already_ordered');
  });
  it('refuses to finalize when a job changed after it was added', () => {
    const state = fresh();
    const job = state.jobs.find((item) => item.id === 'j-1068')!;
    const draft = createDraft(state, ctx, { customer: job.customer, fulfillmentMode: 'immediate' });
    const added = addJobItems(draft.state, ctx, draft.orderId, [job.id]).state;
    added.jobs.find((item) => item.id === job.id)!.version += 1;
    expect(thrown(() => finalizeOrder(added, ctx, draft.orderId))?.code).toBe('source_snapshot_stale');
  });
  it('replacement carries receipts over, but a lower total needs a refund first', () => {
    const { state, orderId } = finalizedDraft(fresh(), 30);
    const paid = recordPayments(state, ctx, orderId, [cash(30)]).state;
    const started = startReplacement(paid, ctx, orderId);
    const replacement = started.state.orders.find((order) => order.id === started.orderId)!;
    replacement.items.find((item) => item.removedAt === null)!.removedAt = ctx.at;
    const lower = addManualItem(started.state, ctx, started.orderId, { description: 'Cheaper', quantity: 1, unit: 'piece', unitPrice: 20 }).state;
    expect(thrown(() => commitReplacement(lower, ctx, orderId, started.orderId, { reason: 'Price fix', reversals: [], payments: [] }))?.code).toBe('payment_exceeds_outstanding');
    const receipt = activeReceipts(lower.payments, lower.allocations, orderId)[0];
    const committed = commitReplacement(lower, ctx, orderId, started.orderId, {
      reason: 'Price fix', reversals: [{ paymentId: receipt.id, reasonKind: 'refund', reason: 'Gave back the difference', occurredAt: ctx.at, transactionReference: '' }],
      payments: [cash(20)],
    });
    const all = views(committed.state);
    expect(all.find((order) => order.id === orderId)?.status).toBe('reversed');
    expect(all.find((order) => order.id === started.orderId)?.settlement).toBe('paid');
  });
  it('reversing an order needs its payments handled first', () => {
    const { state, orderId } = finalizedDraft(fresh());
    const paid = recordPayments(state, ctx, orderId, [cash(10)]).state;
    expect(thrown(() => reverseOrder(paid, ctx, orderId, { reason: 'Cancelled', reversals: [] }))?.code).toBe('payment_reconciliation_required');
    const receipt = activeReceipts(paid.payments, paid.allocations, orderId)[0];
    const reversed = reverseOrder(paid, ctx, orderId, { reason: 'Cancelled', reversals: [{ paymentId: receipt.id, reasonKind: 'refund', reason: 'Refund', occurredAt: ctx.at, transactionReference: '' }] }).state;
    expect(views(reversed).find((order) => order.id === orderId)?.status).toBe('reversed');
  });
  it('a walk-in payment can only be reversed together with a replacement receipt', () => {
    const state = fresh();
    const walkIn = views(state).find((order) => !order.customer && order.status === 'finalized' && order.net > 0)!;
    const receipt = activeReceipts(state.payments, state.allocations, walkIn.id)[0];
    const input = { paymentId: receipt.id, reasonKind: 'recording_error' as const, reason: 'Wrong method', occurredAt: ctx.at, transactionReference: receipt.method === 'card' ? 'RF-1' : '' };
    expect(thrown(() => reversePayment(state, ctx, input))?.code).toBe('anonymous_requires_full_settlement');
    expect(() => reversePayment(state, ctx, input, receipt.method === 'cash' ? card(receipt.amount, 'TX-FIX') : cash(receipt.amount))).not.toThrow();
  });
  it('an active wiRef request blocks cash and card', () => {
    const { state, orderId } = finalizedDraft(fresh());
    const prepared = prepareInvoiceRequest(state, ctx, orderId).state;
    expect(thrown(() => recordPayments(prepared, ctx, orderId, [cash(5)]))?.code).toBe('settlement_workflow_conflict');
  });
});
