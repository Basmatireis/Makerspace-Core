import { describe, expect, it } from 'vitest';
import * as base from '../mockData';
import {
  addJobItems, addManualItem, assignPricingGroup, cancelRequest, checkoutOrder, closeDay, commitReplacement, confirmRequestCancellation, correctRequestReference, createDraft, finalizeOrder,
  markRequestReady, markRequestSubmitted, prepareInvoiceRequest, recordPayments, recordRequestIssued, requestCancellation, reverseOrder, reversePayment, savePricingGroup, setPurchaseOrderRequirement,
  setRate, startReplacement, updateRequestDetails, SalesError, type Ctx, type SalesState,
} from './engine';
import { csvCell, toCsv } from './csv';
import { activeReceipts, buildOrderViews, cashDayFigures, readyToBill, requestReadiness, reversalOptions } from './logic';
import { dateInAppTimeZone } from './format';
import { quoteJob } from './pricing';
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

describe('wiRef request lifecycle', () => {
  const organization = base.people.find((party) => party.id === 'o-kreativ')!;
  function request(state: SalesState) {
    const draft = createDraft(state, ctx, { customer: organization, fulfillmentMode: 'immediate' });
    const item = addManualItem(draft.state, ctx, draft.orderId, { description: 'Service', quantity: 1, unit: 'piece', unitPrice: 50 });
    const done = finalizeOrder(item.state, ctx, draft.orderId).state;
    const prepared = prepareInvoiceRequest(done, ctx, draft.orderId);
    const details = { ...prepared.state.requests.find((r) => r.id === prepared.requestId)!.details, addressLine1: 'Street 1', postalCode: '8010', locality: 'Graz', contactName: 'Pat', purchaseOrderReference: 'PO-1' };
    return { ...prepared, orderId: draft.orderId, details };
  }
  it('needs the purchase order reference when the organization requires it, then freezes the details', () => {
    const { state, requestId, details } = request(fresh());
    expect(state.customers.find((c) => c.id === organization.id)!.requiresPurchaseOrder).toBe(true);
    const missing = { ...details, purchaseOrderReference: '' };
    const saved = updateRequestDetails(state, ctx, requestId, missing).state;
    expect(requestReadiness(saved.requests.find((r) => r.id === requestId)!, saved.customers.find((c) => c.id === organization.id)).filter((item) => !item.ok).map((item) => item.key)).toEqual(['po']);
    expect(thrown(() => markRequestReady(saved, ctx, requestId))?.code).toBe('validation');
    const ready = markRequestReady(updateRequestDetails(saved, ctx, requestId, details).state, ctx, requestId).state;
    expect(thrown(() => updateRequestDetails(ready, ctx, requestId, details))?.code).toBe('request_frozen');
    expect(thrown(() => markRequestReady(ready, ctx, requestId))?.code).toBe('invalid_request_transition');
  });
  it('allows one active request per order and blocks cash and card, then a successor after cancellation', () => {
    const { state, requestId, orderId } = request(fresh());
    expect(thrown(() => prepareInvoiceRequest(state, ctx, orderId))?.code).toBe('request_already_exists');
    expect(thrown(() => recordPayments(state, ctx, orderId, [cash(5)]))?.code).toBe('settlement_workflow_conflict');
    const cancelled = cancelRequest(state, ctx, requestId, 'Wrong address').state;
    const next = prepareInvoiceRequest(cancelled, ctx, orderId);
    expect(next.state.requests.find((r) => r.id === next.requestId)?.supersedesRequestId).toBe(requestId);
  });
  it('walks submitted, issued with a matching amount, cancellation and its confirmation', () => {
    const all = request(fresh());
    let state = updateRequestDetails(all.state, ctx, all.requestId, all.details).state;
    state = markRequestReady(state, ctx, all.requestId).state;
    expect(thrown(() => recordRequestIssued(state, ctx, all.requestId, { externalReference: 'RE-1', effectiveOn: '2026-01-02', amount: 50 }))?.code).toBe('invalid_request_transition');
    expect(thrown(() => cancelRequest(markRequestSubmitted(state, ctx, all.requestId).state, ctx, all.requestId))?.code).toBe('external_reconciliation_required');
    state = markRequestSubmitted(state, ctx, all.requestId).state;
    expect(thrown(() => recordRequestIssued(state, ctx, all.requestId, { externalReference: 'RE-1', effectiveOn: '2026-01-02', amount: 49 }))?.code).toBe('validation');
    state = recordRequestIssued(state, ctx, all.requestId, { externalReference: 'RE-1', effectiveOn: '2026-01-02', amount: 50 }).state;
    // Cash and card stay blocked, a wiRef payment is allowed, and an order reversal needs the cancellation first.
    expect(thrown(() => reverseOrder(state, ctx, all.orderId, { reason: 'x', reversals: [] }))?.code).toBe('external_reconciliation_required');
    state = correctRequestReference(state, ctx, all.requestId, { externalReference: 'RE-1A', reason: 'Typo', effectiveOn: '2026-01-03' }).state;
    expect(state.requests.find((r) => r.id === all.requestId)!.events.at(-1)?.externalReference).toBe('RE-1A');
    expect(thrown(() => confirmRequestCancellation(state, ctx, all.requestId, { reconciliationKind: 'credit_note', externalReference: 'CN-1', effectiveOn: '2026-01-04' }))?.code).toBe('invalid_request_transition');
    state = requestCancellation(state, ctx, all.requestId, 'Wrong amount').state;
    state = confirmRequestCancellation(state, ctx, all.requestId, { reconciliationKind: 'credit_note', externalReference: 'CN-1', effectiveOn: '2026-01-04' }).state;
    expect(state.requests.find((r) => r.id === all.requestId)?.state).toBe('cancelled');
  });
  it('records a wiRef payment only for an issued invoice, and corrects it only after cancellation', () => {
    const all = request(fresh());
    let state = updateRequestDetails(all.state, ctx, all.requestId, all.details).state;
    state = markRequestSubmitted(markRequestReady(state, ctx, all.requestId).state, ctx, all.requestId).state;
    const external: PaymentInput = { method: 'external', amount: 50, occurredAt: ctx.at, terminal: 'wiRef', transactionReference: 'WR-9' };
    expect(thrown(() => recordPayments(state, ctx, all.orderId, [external]))?.code).toBe('external_reconciliation_required');
    state = recordRequestIssued(state, ctx, all.requestId, { externalReference: 'RE-2', effectiveOn: '2026-01-02', amount: 50 }).state;
    state = recordPayments(state, ctx, all.orderId, [external]).state;
    const payment = activeReceipts(state.payments, state.allocations, all.orderId)[0];
    const options = reversalOptions(payment, state.orders.find((o) => o.id === all.orderId)!, state);
    expect(options.kinds).toEqual(['external_correction']);
    expect(options.prerequisite).not.toBeNull();
    const input = { paymentId: payment.id, reasonKind: 'external_correction' as const, reason: 'Credit note', occurredAt: ctx.at, transactionReference: 'CN-2' };
    expect(thrown(() => reversePayment(state, ctx, input))?.code).toBe('external_reconciliation_required');
  });
});

describe('cash day close', () => {
  it('expects cash receipts minus cash refunds and demands a note for a difference', () => {
    const { state, orderId } = finalizedDraft(fresh(), 40);
    const paid = recordPayments(state, ctx, orderId, [cash(30), card(10, 'TX-DAY-1')]).state;
    const day = dateInAppTimeZone(ctx.at);
    const before = cashDayFigures(paid.payments, day).expected;
    const receipt = activeReceipts(paid.payments, paid.allocations, orderId).find((p) => p.method === 'cash')!;
    const refunded = reversePayment(paid, ctx, { paymentId: receipt.id, reasonKind: 'refund', reason: 'Gave back', occurredAt: ctx.at, transactionReference: '' }).state;
    expect(cashDayFigures(refunded.payments, day).expected).toBe(before - 30);
    const expected = cashDayFigures(paid.payments, day).expected;
    expect(thrown(() => closeDay(paid, ctx, { day, countedCash: expected - 1, denominations: {}, note: '' }))?.message).toMatch(/Explain the difference/);
    const closed = closeDay(paid, ctx, { day, countedCash: expected - 1, denominations: {}, note: 'Missing coin' }).state;
    expect(closed.daySessions.at(-1)!.difference).toBe(-1);
    expect(thrown(() => closeDay(closed, ctx, { day, countedCash: expected, denominations: {}, note: '' }))?.code).toBe('day_already_closed');
  });
  it('locks the cash of a closed day against new cash and backdated corrections', () => {
    const { state, orderId } = finalizedDraft(fresh(), 40);
    const paid = recordPayments(state, ctx, orderId, [cash(10)]).state;
    const day = dateInAppTimeZone(ctx.at);
    const closed = closeDay(paid, ctx, { day, countedCash: cashDayFigures(paid.payments, day).expected, denominations: {}, note: '' }).state;
    expect(thrown(() => recordPayments(closed, ctx, orderId, [cash(5)]))?.code).toBe('day_closed');
    expect(recordPayments(closed, ctx, orderId, [card(5, 'TX-LOCK')]).state.payments.length).toBe(closed.payments.length + 1);
    const receipt = activeReceipts(closed.payments, closed.allocations, orderId)[0];
    expect(thrown(() => reversePayment(closed, ctx, { paymentId: receipt.id, reasonKind: 'recording_error', reason: 'Oops', occurredAt: ctx.at, transactionReference: '' }))?.code).toBe('day_closed');
  });
});

describe('customers and pricing', () => {
  it('assigns only active groups and only organizations have invoicing requirements', () => {
    const state = fresh();
    const inactive = savePricingGroup(state, ctx, { name: 'Alumni', description: '', active: false, isDefault: false }).state;
    expect(thrown(() => assignPricingGroup(inactive, ctx, 'p-lena', 'Alumni'))?.code).toBe('pricing_group_inactive');
    expect(assignPricingGroup(state, ctx, 'p-lena', null).state.customers.find((c) => c.id === 'p-lena')?.pricingGroup).toBeNull();
    expect(thrown(() => setPurchaseOrderRequirement(state, ctx, 'p-lena', true))?.code).toBe('validation');
    expect(setPurchaseOrderRequirement(state, ctx, 'o-racing', true).state.customers.find((c) => c.id === 'o-racing')?.requiresPurchaseOrder).toBe(true);
  });
  it('keeps exactly one active default group and rejects duplicate names', () => {
    const state = fresh();
    const group = state.pricing.groups.find((g) => !g.isDefault)!;
    expect(thrown(() => savePricingGroup(state, ctx, { id: group.id, name: group.name, description: '', active: false, isDefault: true }))?.code).toBe('validation');
    expect(thrown(() => savePricingGroup(state, ctx, { name: 'external', description: '', active: true, isDefault: false }))?.code).toBe('conflict');
    const moved = savePricingGroup(state, ctx, { id: group.id, name: group.name, description: '', active: true, isDefault: true }).state;
    expect(moved.pricing.groups.filter((g) => g.isDefault).map((g) => g.id)).toEqual([group.id]);
    const old = state.pricing.groups.find((g) => g.isDefault)!;
    expect(thrown(() => savePricingGroup(moved, ctx, { id: group.id, name: group.name, description: '', active: true, isDefault: false }))?.code).toBe('validation');
    expect(old.id).not.toBe(group.id);
  });
  it('prices with the configured rates and reports a missing one instead of guessing', () => {
    const state = fresh();
    const teams = state.pricing.groups.find((g) => g.name === 'Student teams')!;
    const input = { group: 'Student teams', durationSeconds: 3600, machineTypeId: 'type-sla', usages: [] };
    const gap = quoteJob(input, state.pricing);
    expect(gap.complete).toBe(false);
    expect(gap.missing[0]).toMatch(/machine time/);
    expect(thrown(() => setRate(state, ctx, { groupId: teams.id, kind: 'machine_runtime', machineTypeId: 'type-sla', category: null, unit: 'h', rate: -1 }))?.code).toBe('validation');
    const fixed = setRate(state, ctx, { groupId: teams.id, kind: 'machine_runtime', machineTypeId: 'type-sla', category: null, unit: 'h', rate: 3 }).state;
    expect(quoteJob(input, fixed.pricing)).toMatchObject({ complete: true, total: 3 });
  });
  it('builds a safe CSV', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-5.00')).toBe('-5.00');
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(toCsv(['A', 'B'], [['x', 1]])).toBe('\uFEFFA,B\r\nx,1\r\n');
  });
});
