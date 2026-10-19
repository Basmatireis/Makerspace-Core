import { describe, expect, it } from 'vitest';
import * as base from '../mockData';
import {
  addJobItems, addManualItem, cancelRequest, checkoutOrder, commitReplacement, confirmRequestCancellation, createDraft, finalizeOrder, forwardRequestToWiRef,
  prepareInvoiceRequest, recordCashMovement, recordPayments, recordRequestReference, requestCancellation, returnRequestForCorrection, reverseOrder, reversePayment, saveOrganization, savePricingGroup, setRate, setRoleGroup,
  startReplacement, submitRequestForApproval, updateRequestDetails, SalesError, type Ctx, type SalesState,
} from './engine';
import { csvCell, toCsv } from './csv';
import { acceptedMethods, activeReceipts, buildOrderViews, cashInRegister, invoiceFilterKey, invoiceNeedsStep, invoiceNumberOf, latestReturn, readyToBill, requestNext, requestProgress, requestReadiness, reversalOptions, wiRefCopyText } from './logic';
import { quoteJob, resolveGroup } from './pricing';
import { salesSeed } from './mockData';
import { orderStatus } from './status';
import type { PaymentInput } from './types';

const ctx: Ctx = { at: new Date().toISOString(), actor: 'Test', canApproveInvoices: true, machines: base.machines, machineTypes: base.machineTypes, prints: base.prints };
/** Staff without the approve permission. */
const staff: Ctx = { ...ctx, actor: 'Staff', canApproveInvoices: false };
const cash = (amount: number): PaymentInput => ({ method: 'cash', amount, occurredAt: ctx.at, terminal: '', transactionReference: '' });
const card = (amount: number, reference: string): PaymentInput => ({ method: 'card', amount, occurredAt: ctx.at, terminal: 'Terminal 1', transactionReference: reference });
const transfer = (amount: number, reference: string): PaymentInput => ({ method: 'external', amount, occurredAt: ctx.at, terminal: 'wiRef', transactionReference: reference });
const views = (state: SalesState) => buildOrderViews(state);
const lena = base.people[0];

function fresh(): SalesState { return structuredClone(salesSeed); }
function finalizedDraft(state: SalesState, price = 10, customer: (typeof base.people)[number] = lena) {
  const draft = createDraft(state, ctx, { customer, fulfillmentMode: 'immediate' });
  const withItem = addManualItem(draft.state, ctx, draft.orderId, { description: 'Test item', quantity: 1, unit: 'piece', unitPrice: price });
  return { state: finalizeOrder(withItem.state, ctx, draft.orderId).state, orderId: draft.orderId };
}
const thrown = (fn: () => unknown) => { try { fn(); } catch (error) { return error as SalesError; } return null; };
const view = (state: SalesState, orderId: string) => views(state).find((order) => order.id === orderId)!;

describe('sales seed', () => {
  const state = salesSeed;
  it('covers every state with consistent settlement', () => {
    const all = views(state);
    expect(all.length).toBeGreaterThanOrEqual(25);
    expect(state.payments.length).toBeGreaterThanOrEqual(35);
    expect(new Set(all.map((order) => orderStatus(order).key))).toEqual(new Set(['draft', 'awaiting_payment', 'partially_paid', 'paid', 'no_payment_due', 'reversed', 'cancelled']));
    for (const order of all) {
      expect(order.settled).toBeGreaterThanOrEqual(0);
      expect(order.settled).toBeLessThanOrEqual(order.net + 0.001);
    }
  });
  it('has unique references and a customer on every order and job', () => {
    const refs = [...state.orders.map((order) => order.reference), ...state.payments.map((payment) => payment.reference), ...state.cashMovements.map((movement) => movement.reference)];
    expect(new Set(refs).size).toBe(refs.length);
    for (const order of state.orders) expect(order.customer.id && order.customerName).toBeTruthy();
    for (const job of state.jobs) expect(job.customer.id).toBeTruthy();
  });
  it('lists billable jobs per customer and keeps blocked ones visible', () => {
    const groups = readyToBill(state.jobs, state.orders, base.prints, Date.now());
    expect(groups.length).toBeGreaterThanOrEqual(5);
    expect(groups.flatMap((group) => group.rows).some((row) => row.reason !== null)).toBe(true);
  });
  it('has cash movements and invoices that were requested for paid orders', () => {
    expect(state.cashMovements.length).toBeGreaterThanOrEqual(3);
    expect(cashInRegister(state.payments, state.cashMovements).expected).toBeGreaterThan(0);
    expect(state.requests.some((request) => request.alreadyPaid > 0)).toBe(true);
    expect(state.payments.some((payment) => payment.method === 'external') && state.payments.some((payment) => payment.method === 'cash')).toBe(true);
  });
});

describe('sales engine rules', () => {
  it('finalizes and records split payments, rejects overpayment', () => {
    const { state, orderId } = finalizedDraft(fresh());
    expect(thrown(() => recordPayments(state, ctx, orderId, [cash(11)]))?.code).toBe('payment_exceeds_outstanding');
    const paid = recordPayments(state, ctx, orderId, [cash(4), card(6, 'TX-NEW-1')]).state;
    expect(view(paid, orderId).settlement).toBe('paid');
  });
  it('rejects a card reference that was already recorded', () => {
    const { state, orderId } = finalizedDraft(fresh());
    const first = recordPayments(state, ctx, orderId, [card(5, 'TX-DUP')]).state;
    expect(thrown(() => recordPayments(first, ctx, orderId, [card(5, 'TX-DUP')]))?.code).toBe('duplicate_transaction');
  });
  it('needs a customer for every order', () => {
    expect(thrown(() => createDraft(fresh(), ctx, { customer: null, fulfillmentMode: 'immediate' }))?.code).toBe('customer_required');
    const draft = createDraft(fresh(), ctx, { customer: lena, fulfillmentMode: 'deferred' });
    expect(thrown(() => createDraft(draft.state, ctx, { customer: null, fulfillmentMode: 'immediate' }))?.code).toBe('customer_required');
  });
  it('"Finalize and take payment" finalizes and records in one step, partial payments are fine', () => {
    const draft = createDraft(fresh(), ctx, { customer: lena, fulfillmentMode: 'immediate' });
    const item = addManualItem(draft.state, ctx, draft.orderId, { description: 'Spool', quantity: 1, unit: 'piece', unitPrice: 20 });
    expect(thrown(() => checkoutOrder(item.state, ctx, draft.orderId, []))?.code).toBe('validation');
    expect(thrown(() => checkoutOrder(item.state, ctx, draft.orderId, [cash(25)]))?.code).toBe('payment_exceeds_outstanding');
    const partial = checkoutOrder(item.state, ctx, draft.orderId, [cash(5)]).state;
    expect(view(partial, draft.orderId)).toMatchObject({ status: 'finalized', settlement: 'partially_paid', outstanding: 15 });
    expect(view(checkoutOrder(item.state, ctx, draft.orderId, [cash(8), card(12, 'TX-CO-1')]).state, draft.orderId).settlement).toBe('paid');
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
  it('keeps why a job was priced the way it was on the order item', () => {
    const state = fresh();
    const job = state.jobs.find((item) => item.id === 'j-1069')!;
    const draft = createDraft(state, ctx, { customer: job.customer, fulfillmentMode: 'immediate' });
    const added = addJobItems(draft.state, ctx, draft.orderId, [job.id]).state;
    const snapshot = added.orders.find((order) => order.id === draft.orderId)!.items[0].snapshot!;
    expect(snapshot.pricingGroupName).toBeTruthy();
    expect(snapshot.pricingVia).toMatch(/default|role|organization|job/);
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
    expect(view(committed.state, orderId).status).toBe('reversed');
    expect(view(committed.state, started.orderId).settlement).toBe('paid');
  });
  it('reversing an order needs its payments handled first', () => {
    const { state, orderId } = finalizedDraft(fresh());
    const paid = recordPayments(state, ctx, orderId, [cash(10)]).state;
    expect(thrown(() => reverseOrder(paid, ctx, orderId, { reason: 'Cancelled', reversals: [] }))?.code).toBe('payment_reconciliation_required');
    const receipt = activeReceipts(paid.payments, paid.allocations, orderId)[0];
    const reversed = reverseOrder(paid, ctx, orderId, { reason: 'Cancelled', reversals: [{ paymentId: receipt.id, reasonKind: 'refund', reason: 'Refund', occurredAt: ctx.at, transactionReference: '' }] }).state;
    expect(view(reversed, orderId).status).toBe('reversed');
  });
  it('a recording error can be fixed with the right receipt in the same step', () => {
    const { state, orderId } = finalizedDraft(fresh(), 10);
    const paid = recordPayments(state, ctx, orderId, [cash(10)]).state;
    const receipt = activeReceipts(paid.payments, paid.allocations, orderId)[0];
    const fixed = reversePayment(paid, ctx, { paymentId: receipt.id, reasonKind: 'recording_error', reason: 'Paid by card', occurredAt: ctx.at, transactionReference: '' }, card(10, 'TX-FIX-1')).state;
    expect(view(fixed, orderId)).toMatchObject({ settlement: 'paid' });
    expect(activeReceipts(fixed.payments, fixed.allocations, orderId).map((payment) => payment.method)).toEqual(['card']);
  });
});

describe('invoice requests (wiRef)', () => {
  const organization = base.people.find((party) => party.id === 'o-kreativ')!;
  const completeDetails = (state: SalesState, requestId: string) => ({ ...state.requests.find((r) => r.id === requestId)!.details, addressLine1: 'Street 1', postalCode: '8010', locality: 'Graz', contactName: 'Pat', purchaseOrderReference: 'PO-1' });
  function request(state: SalesState, price = 50, customer = organization) {
    const { state: done, orderId } = finalizedDraft(state, price, customer);
    const prepared = prepareInvoiceRequest(done, ctx, orderId);
    return { ...prepared, orderId, details: completeDetails(prepared.state, prepared.requestId) };
  }
  /** Fill in the details, submit as staff, approve and forward as management. */
  const issue = (state: SalesState, requestId: string) => {
    const next = updateRequestDetails(state, staff, requestId, completeDetails(state, requestId)).state;
    return forwardRequestToWiRef(submitRequestForApproval(next, staff, requestId).state, ctx, requestId).state;
  };
  const submitted = (state: SalesState, requestId: string) => submitRequestForApproval(updateRequestDetails(state, staff, requestId, completeDetails(state, requestId)).state, staff, requestId).state;
  const stateOf = (state: SalesState, requestId: string) => state.requests.find((r) => r.id === requestId)!;

  it('needs the purchase order reference when the organization requires it before it can be submitted', () => {
    const { state, requestId, details } = request(fresh());
    expect(state.organizations.find((c) => c.id === organization.id)!.requiresPurchaseOrder).toBe(true);
    const missing = { ...details, purchaseOrderReference: '' };
    const saved = updateRequestDetails(state, staff, requestId, missing).state;
    const org = saved.organizations.find((c) => c.id === organization.id);
    expect(requestReadiness(stateOf(saved, requestId), organization, org).filter((item) => !item.ok).map((item) => item.key)).toEqual(['po']);
    expect(thrown(() => submitRequestForApproval(saved, staff, requestId))?.code).toBe('validation');
    const awaiting = submitRequestForApproval(updateRequestDetails(saved, staff, requestId, details).state, staff, requestId).state;
    expect(stateOf(awaiting, requestId).state).toBe('submitted');
    expect(thrown(() => submitRequestForApproval(awaiting, staff, requestId))?.code).toBe('invalid_request_transition');
  });
  it('lets only management edit, return and forward a request that awaits approval', () => {
    const { state, requestId, details } = request(fresh());
    const awaiting = submitted(state, requestId);
    expect(stateOf(awaiting, requestId)).toMatchObject({ state: 'submitted' });
    // Without the approve permission nothing changes.
    expect(thrown(() => updateRequestDetails(awaiting, staff, requestId, { ...details, contactName: 'Other' }))?.code).toBe('permission_denied');
    expect(thrown(() => returnRequestForCorrection(awaiting, staff, requestId, 'Please check'))?.code).toBe('permission_denied');
    expect(thrown(() => forwardRequestToWiRef(awaiting, staff, requestId))?.code).toBe('permission_denied');
    expect(thrown(() => cancelRequest(awaiting, staff, requestId, 'x'))?.code).toBe('permission_denied');
    // Management edits with an audit entry.
    const edited = updateRequestDetails(awaiting, ctx, requestId, { ...details, contactName: 'Corrected Contact' }).state;
    expect(stateOf(edited, requestId).details.contactName).toBe('Corrected Contact');
    expect(stateOf(edited, requestId).events.at(-1)).toMatchObject({ kind: 'details_saved', actor: 'Test', text: 'Recipient details edited while awaiting approval' });
    expect(edited.orders.find((order) => order.id === stateOf(edited, requestId).orderId)!.events.at(-1)?.kind).toBe('invoicing');
    // Staff can edit the draft, but nothing once it is issued.
    expect(thrown(() => updateRequestDetails(issue(state, requestId), ctx, requestId, details))?.code).toBe('request_frozen');
  });
  it('returns a request with a required comment, shows it on the draft until it is submitted again', () => {
    const { state, requestId } = request(fresh());
    const awaiting = submitted(state, requestId);
    expect(thrown(() => returnRequestForCorrection(awaiting, ctx, requestId, '   '))?.code).toBe('validation');
    expect(thrown(() => returnRequestForCorrection(state, ctx, requestId, 'Not submitted yet'))?.code).toBe('invalid_request_transition');
    const returned = returnRequestForCorrection(awaiting, ctx, requestId, ' Wrong recipient ').state;
    const draft = stateOf(returned, requestId);
    expect(draft.state).toBe('draft');
    expect(latestReturn(draft)).toMatchObject({ kind: 'returned', reason: 'Wrong recipient', actor: 'Test' });
    expect(requestNext(draft, false, true)).toBe('Submit for approval again');
    expect(requestProgress(draft)).toEqual({ index: 0, invalid: false });
    const again = submitRequestForApproval(returned, staff, requestId).state;
    expect(latestReturn(stateOf(again, requestId))).toBeNull();
    const second = returnRequestForCorrection(again, ctx, requestId, 'Still wrong').state;
    expect(latestReturn(stateOf(second, requestId))?.reason).toBe('Still wrong');
  });
  it('forwarding issues the request, the wiRef invoice number is optional and added afterwards', () => {
    const { state, requestId, orderId } = request(fresh());
    const awaiting = submitted(state, requestId);
    expect(requestProgress(stateOf(awaiting, requestId))).toEqual({ index: 1, invalid: false });
    const issued = forwardRequestToWiRef(awaiting, ctx, requestId).state;
    expect(stateOf(issued, requestId).state).toBe('issued');
    expect(requestProgress(stateOf(issued, requestId))).toEqual({ index: 3, invalid: false });
    expect(invoiceNumberOf(stateOf(issued, requestId))).toBeNull();
    expect(thrown(() => forwardRequestToWiRef(issued, ctx, requestId))?.code).toBe('invalid_request_transition');
    expect(thrown(() => recordRequestReference(issued, staff, requestId, { externalReference: '', reason: '', effectiveOn: '2026-01-02' }))?.code).toBe('validation');
    const numbered = recordRequestReference(issued, staff, requestId, { externalReference: 'RE-1', reason: '', effectiveOn: '2026-01-02' }).state;
    expect(invoiceNumberOf(stateOf(numbered, requestId))).toMatchObject({ kind: 'reference_added', externalReference: 'RE-1' });
    // A number on record can only be corrected with a reason.
    expect(thrown(() => recordRequestReference(numbered, staff, requestId, { externalReference: 'RE-1A', reason: '', effectiveOn: '2026-01-03' }))?.code).toBe('validation');
    const corrected = recordRequestReference(numbered, staff, requestId, { externalReference: 'RE-1A', reason: 'Typo', effectiveOn: '2026-01-03' }).state;
    expect(invoiceNumberOf(stateOf(corrected, requestId))).toMatchObject({ kind: 'reference_corrected', externalReference: 'RE-1A' });
    // Settling needs no invoice number.
    expect(view(issued, orderId)).toMatchObject({ outstanding: 0, settlement: 'paid' });
  });
  it('cannot forward an incomplete request that was edited into an incomplete state', () => {
    const { state, requestId, details } = request(fresh());
    const awaiting = submitted(state, requestId);
    const broken = updateRequestDetails(awaiting, ctx, requestId, { ...details, purchaseOrderReference: '' }).state;
    expect(thrown(() => forwardRequestToWiRef(broken, ctx, requestId))?.code).toBe('validation');
  });
  it('copies the invoice data as plain text for wiRef', () => {
    const all = request(fresh());
    const { requestId, orderId } = all;
    const state = submitted(all.state, requestId);
    const text = wiRefCopyText(stateOf(state, requestId), view(state, orderId));
    expect(text).toContain(`Order: ${view(state, orderId).reference}`);
    expect(text).toContain(`Invoice request: ${stateOf(state, requestId).reference}`);
    expect(text).toContain('Purchase order: PO-1');
    expect(text).toMatch(/1\. Test item · 1 piece/);
    expect(text).toContain('Still to pay (by bank transfer to HTU)');
    expect(text).toContain('Bank transfer note:');
  });
  it('allows one active request per order, then a successor after cancellation', () => {
    const { state, requestId, orderId } = request(fresh());
    expect(thrown(() => prepareInvoiceRequest(state, ctx, orderId))?.code).toBe('request_already_exists');
    const cancelled = cancelRequest(state, staff, requestId, 'Wrong address').state;
    const next = prepareInvoiceRequest(cancelled, { ...ctx, at: new Date(Date.parse(ctx.at) + 1000).toISOString() }, orderId);
    expect(next.state.requests.find((r) => r.id === next.requestId)?.supersedesRequestId).toBe(requestId);
    expect(invoiceFilterKey(view(cancelled, orderId))).toBe('cancelled');
    expect(invoiceFilterKey(view(next.state, orderId))).toBe('draft');
  });
  it('can be requested for an order that was already paid by cash or card, and is then marked paid', () => {
    const { state: done, orderId } = finalizedDraft(fresh(), 40, organization);
    const paid = recordPayments(done, ctx, orderId, [cash(15), card(25, 'TX-INV-1')]).state;
    expect(view(paid, orderId).settlement).toBe('paid');
    const prepared = prepareInvoiceRequest(paid, ctx, orderId);
    const requestId = prepared.requestId;
    expect(prepared.state.requests.find((r) => r.id === requestId)).toMatchObject({ alreadyPaid: 40, requestedAmount: 40, state: 'draft' });
    const issued = issue(prepared.state, requestId);
    const order = view(issued, orderId);
    expect(order.settlement).toBe('paid');
    expect(invoiceNeedsStep(order.activeRequest, true)).toBe(false);
    expect(invoiceFilterKey(order)).toBe('issued');
    expect(requestNext(stateOf(issued, requestId), true)).toBe('Complete, invoice paid');
    // Nothing was open, so the invoice adds no entry.
    expect(activeReceipts(issued.payments, issued.allocations, orderId).filter((payment) => payment.method === 'external')).toHaveLength(0);
  });
  it('keeps the order open until the invoice is issued, then the invoice settles the balance (no manual bank transfer)', () => {
    const { state, requestId, orderId } = request(fresh());
    expect(acceptedMethods(view(state, orderId))).toEqual(['cash', 'card']);
    // Nobody can record an invoice payment by hand.
    expect(thrown(() => recordPayments(state, ctx, orderId, [transfer(50, 'WR-1')]))?.code).toBe('invoice_settles_balance');
    const awaiting = submitted(state, requestId);
    expect(view(awaiting, orderId)).toMatchObject({ settlement: 'unpaid', outstanding: 50 });
    expect(acceptedMethods(view(awaiting, orderId))).toEqual([]);
    const returned = returnRequestForCorrection(awaiting, ctx, requestId, 'Check').state;
    expect(view(returned, orderId)).toMatchObject({ settlement: 'unpaid', outstanding: 50 });
    const issued = issue(state, requestId);
    expect(acceptedMethods(view(issued, orderId))).toEqual([]);
    expect(view(issued, orderId)).toMatchObject({ settlement: 'paid', outstanding: 0, settled: 50 });
    const settling = activeReceipts(issued.payments, issued.allocations, orderId).filter((payment) => payment.method === 'external');
    expect(settling).toHaveLength(1);
    expect(settling[0]).toMatchObject({ amount: 50, entryKind: 'receipt', transactionReference: stateOf(issued, requestId).reference });
    expect(thrown(() => recordPayments(issued, ctx, orderId, [cash(1)]))?.code).toBe('invoice_amount_frozen');
    expect(orderStatus(view(issued, orderId)).key).toBe('paid');
  });
  it('settles only the rest when cash or card was paid before the request', () => {
    const { state: done, orderId } = finalizedDraft(fresh(), 100, organization);
    const partlyPaid = recordPayments(done, ctx, orderId, [cash(30)]).state;
    const prepared = prepareInvoiceRequest(partlyPaid, ctx, orderId);
    const awaiting = submitted(prepared.state, prepared.requestId);
    expect(view(awaiting, orderId)).toMatchObject({ settlement: 'partially_paid', outstanding: 70 });
    expect(thrown(() => recordPayments(awaiting, ctx, orderId, [cash(10)]))?.code).toBe('invoice_amount_frozen');
    const issued = forwardRequestToWiRef(awaiting, ctx, prepared.requestId).state;
    expect(view(issued, orderId)).toMatchObject({ settlement: 'paid', outstanding: 0 });
    expect(activeReceipts(issued.payments, issued.allocations, orderId).map((payment) => payment.method).sort()).toEqual(['cash', 'external']);
    expect(activeReceipts(issued.payments, issued.allocations, orderId).find((payment) => payment.method === 'external')?.amount).toBe(70);
  });
  it('keeps "already paid" in step with cash and card while the request is a draft, then freezes it from approval on', () => {
    const { state, requestId, orderId } = request(fresh());
    expect(state.requests.find((r) => r.id === requestId)!.alreadyPaid).toBe(0);
    const paid = recordPayments(state, ctx, orderId, [cash(20)]).state;
    expect(paid.requests.find((r) => r.id === requestId)!.alreadyPaid).toBe(20);
    const receipt = activeReceipts(paid.payments, paid.allocations, orderId)[0];
    const refunded = reversePayment(paid, ctx, { paymentId: receipt.id, reasonKind: 'refund', reason: 'Gave back', occurredAt: ctx.at, transactionReference: '' }).state;
    expect(refunded.requests.find((r) => r.id === requestId)!.alreadyPaid).toBe(0);
    const awaiting = submitted(paid, requestId);
    expect(thrown(() => recordPayments(awaiting, ctx, orderId, [card(5, 'TX-LATE')]))?.code).toBe('invoice_amount_frozen');
    expect(thrown(() => reversePayment(awaiting, ctx, { paymentId: receipt.id, reasonKind: 'refund', reason: 'Gave back', occurredAt: ctx.at, transactionReference: '' }))?.code).toBe('invoice_amount_frozen');
    expect(reversalOptions(receipt, view(awaiting, orderId), awaiting).prerequisite).not.toBeNull();
    // Returned to the draft, the figure follows the payments again.
    const returned = returnRequestForCorrection(awaiting, ctx, requestId, 'Check').state;
    expect(acceptedMethods(view(returned, orderId))).toEqual(['cash', 'card']);
  });
  it('does not invoice orders that are not finalized or charge nothing', () => {
    const draft = createDraft(fresh(), ctx, { customer: organization, fulfillmentMode: 'immediate' });
    expect(thrown(() => prepareInvoiceRequest(draft.state, ctx, draft.orderId))?.code).toBe('order_not_finalized');
    const free = finalizedDraft(fresh(), 0, organization);
    expect(thrown(() => prepareInvoiceRequest(free.state, ctx, free.orderId))?.code).toBe('validation');
  });
  it('walks awaiting approval, issued, cancellation and its confirmation', () => {
    const all = request(fresh());
    let state = submitted(all.state, all.requestId);
    // Awaiting approval has not reached wiRef, so only the draft/approval cancellation applies and external cancellation does not.
    expect(thrown(() => requestCancellation(state, ctx, all.requestId, 'Too early'))?.code).toBe('invalid_request_transition');
    state = forwardRequestToWiRef(state, ctx, all.requestId).state;
    expect(thrown(() => cancelRequest(state, ctx, all.requestId))?.code).toBe('external_reconciliation_required');
    expect(thrown(() => reverseOrder(state, ctx, all.orderId, { reason: 'x', reversals: [] }))?.code).toBe('external_reconciliation_required');
    expect(thrown(() => confirmRequestCancellation(state, ctx, all.requestId, { reconciliationKind: 'credit_note', externalReference: 'CN-1', effectiveOn: '2026-01-04' }))?.code).toBe('invalid_request_transition');
    state = requestCancellation(state, ctx, all.requestId, 'Wrong amount').state;
    expect(requestProgress(stateOf(state, all.requestId))).toEqual({ index: 2, invalid: true });
    state = confirmRequestCancellation(state, ctx, all.requestId, { reconciliationKind: 'credit_note', externalReference: 'CN-1', effectiveOn: '2026-01-04' }).state;
    expect(stateOf(state, all.requestId).state).toBe('cancelled');
  });
  it('cancels a request that awaits approval locally, marking the step it reached', () => {
    const all = request(fresh());
    const cancelled = cancelRequest(submitted(all.state, all.requestId), ctx, all.requestId, 'Not needed').state;
    expect(stateOf(cancelled, all.requestId).state).toBe('cancelled');
    expect(requestProgress(stateOf(cancelled, all.requestId))).toEqual({ index: 1, invalid: true });
  });
  it('corrects the invoice payment only after the request is cancelled', () => {
    const all = request(fresh());
    const issued = issue(all.state, all.requestId);
    const payment = activeReceipts(issued.payments, issued.allocations, all.orderId)[0];
    expect(payment.method).toBe('external');
    const options = reversalOptions(payment, view(issued, all.orderId), issued);
    expect(options.kinds).toEqual(['external_correction']);
    expect(options.prerequisite).not.toBeNull();
    const input = { paymentId: payment.id, reasonKind: 'external_correction' as const, reason: 'Credit note', occurredAt: ctx.at, transactionReference: 'CN-2' };
    expect(thrown(() => reversePayment(issued, ctx, input))?.code).toBe('external_reconciliation_required');
    const cancelled = confirmRequestCancellation(requestCancellation(issued, ctx, all.requestId, 'Wrong').state, ctx, all.requestId, { reconciliationKind: 'credit_note', externalReference: 'CN-2', effectiveOn: '2026-01-04' }).state;
    const corrected = reversePayment(cancelled, ctx, input).state;
    expect(corrected.payments.at(-1)?.entryKind).toBe('reversal');
    expect(view(corrected, all.orderId)).toMatchObject({ outstanding: 50 });
  });
  it('has a seed with a request in every step, including a returned draft and an issued one without number', () => {
    const states = salesSeed.requests.map((r) => r.state);
    for (const expected of ['draft', 'submitted', 'issued', 'cancellation_requested', 'cancelled']) expect(states).toContain(expected);
    expect(salesSeed.requests.some((r) => latestReturn(r) !== null)).toBe(true);
    expect(salesSeed.requests.some((r) => r.state === 'issued' && invoiceNumberOf(r) === null)).toBe(true);
    // Every order with an issued invoice is paid.
    const all = buildOrderViews(salesSeed);
    for (const request of salesSeed.requests.filter((r) => r.state === 'issued')) expect(all.find((order) => order.id === request.orderId)!.settlement).toBe('paid');
  });
});

describe('cash register', () => {
  it('ignores card and invoice payments and their reversals', () => {
    const { state, orderId } = finalizedDraft(fresh(), 40);
    const before = cashInRegister(state.payments, state.cashMovements).expected;
    const paid = recordPayments(state, ctx, orderId, [card(25, 'TX-REG-NOCASH'), cash(0.5)]).state;
    expect(cashInRegister(paid.payments, paid.cashMovements).expected).toBe(before + 0.5);
    const cardReceipt = activeReceipts(paid.payments, paid.allocations, orderId).find((p) => p.method === 'card')!;
    const refunded = reversePayment(paid, ctx, { paymentId: cardReceipt.id, reasonKind: 'refund', reason: 'Gave back', occurredAt: ctx.at, transactionReference: 'TX-REG-REFUND' }).state;
    expect(cashInRegister(refunded.payments, refunded.cashMovements).expected).toBe(before + 0.5);
    // An invoice settles the rest and is no cash either; correcting it later does not touch the register.
    const organization = base.people.find((party) => party.id === 'o-kreativ')!;
    const invoiced = finalizedDraft(fresh(), 60, organization);
    const requested = prepareInvoiceRequest(invoiced.state, ctx, invoiced.orderId);
    const details = { ...requested.state.requests.find((r) => r.id === requested.requestId)!.details, addressLine1: 'Street 1', postalCode: '8010', locality: 'Graz', contactName: 'Pat', purchaseOrderReference: 'PO-1' };
    const awaiting = submitRequestForApproval(updateRequestDetails(requested.state, ctx, requested.requestId, details).state, ctx, requested.requestId).state;
    const issued = forwardRequestToWiRef(awaiting, ctx, requested.requestId).state;
    expect(issued.payments.length).toBeGreaterThan(invoiced.state.payments.length);
    expect(cashInRegister(issued.payments, issued.cashMovements).expected).toBe(cashInRegister(invoiced.state.payments, invoiced.state.cashMovements).expected);
    const settling = activeReceipts(issued.payments, issued.allocations, invoiced.orderId).find((p) => p.method === 'external')!;
    const cancelled = confirmRequestCancellation(requestCancellation(issued, ctx, requested.requestId, 'Wrong').state, ctx, requested.requestId, { reconciliationKind: 'credit_note', externalReference: 'CN-REG', effectiveOn: '2026-01-04' }).state;
    const corrected = reversePayment(cancelled, ctx, { paymentId: settling.id, reasonKind: 'external_correction', reason: 'Credit note', occurredAt: ctx.at, transactionReference: 'CN-REG' }).state;
    expect(cashInRegister(corrected.payments, corrected.cashMovements).expected).toBe(cashInRegister(invoiced.state.payments, invoiced.state.cashMovements).expected);
  });
  it('expects cash receipts minus refunds minus withdrawals plus deposits', () => {
    const { state, orderId } = finalizedDraft(fresh(), 40);
    const before = cashInRegister(state.payments, state.cashMovements).expected;
    const paid = recordPayments(state, ctx, orderId, [cash(30), card(10, 'TX-REG-1')]).state;
    expect(cashInRegister(paid.payments, paid.cashMovements).expected).toBe(before + 30);
    const receipt = activeReceipts(paid.payments, paid.allocations, orderId).find((p) => p.method === 'cash')!;
    const refunded = reversePayment(paid, ctx, { paymentId: receipt.id, reasonKind: 'refund', reason: 'Gave back', occurredAt: ctx.at, transactionReference: '' }).state;
    expect(cashInRegister(refunded.payments, refunded.cashMovements).expected).toBe(before);
    const withdrawn = recordCashMovement(paid, ctx, { kind: 'withdrawal', amount: 12.5, occurredAt: ctx.at, reason: 'bank_deposit', note: '' }).state;
    const deposited = recordCashMovement(withdrawn, ctx, { kind: 'deposit', amount: 20, occurredAt: ctx.at, reason: 'float', note: '' }).state;
    expect(cashInRegister(deposited.payments, deposited.cashMovements)).toMatchObject({ withdrawals: expect.any(Number), deposits: expect.any(Number), expected: before + 30 - 12.5 + 20 });
  });
  it('only looks at entries before the end of a period', () => {
    const { state } = finalizedDraft(fresh(), 40);
    const all = cashInRegister(state.payments, state.cashMovements, Infinity).expected;
    const early = cashInRegister(state.payments, state.cashMovements, new Date(state.cashMovements[0].occurredAt).getTime());
    expect(early.deposits).toBe(0);
    expect(early.expected).toBeLessThan(all);
  });
  it('validates cash movements', () => {
    const state = fresh();
    const held = cashInRegister(state.payments, state.cashMovements).expected;
    const move = (patch: Partial<Parameters<typeof recordCashMovement>[2]>) => recordCashMovement(state, ctx, { kind: 'withdrawal', amount: 5, occurredAt: ctx.at, reason: 'safe', note: '', ...patch });
    expect(thrown(() => move({ amount: 0 }))?.code).toBe('validation');
    expect(thrown(() => move({ amount: 1.234 }))?.code).toBe('validation');
    expect(thrown(() => move({ amount: held + 1 }))?.code).toBe('insufficient_cash');
    expect(thrown(() => move({ reason: 'other' }))?.code).toBe('validation');
    expect(thrown(() => move({ occurredAt: new Date(Date.now() + 3_600_000).toISOString() }))?.code).toBe('validation');
    expect(move({ reason: 'other', note: 'Coffee beans' }).state.cashMovements.at(-1)).toMatchObject({ kind: 'withdrawal', recordedBy: 'Test', reason: 'other', note: 'Coffee beans' });
    expect(move({ kind: 'deposit', amount: held + 500, reason: 'float' }).state.cashMovements.at(-1)?.reference).toMatch(/^C-\d{4}-\d{6}$/);
  });
});

describe('pricing groups, roles and organizations', () => {
  const person = (roles: string[]) => ({ kind: 'person' as const, id: 'p-x', roles });
  it('resolves the group: set on the job, then organization, then role by priority, then default', () => {
    const state = fresh();
    const { pricing, organizations } = state;
    const robotics = { kind: 'organization' as const, id: 'o-robotics', roles: [] };
    expect(resolveGroup(pricing, organizations, robotics, 'Staff')).toMatchObject({ group: { name: 'Staff' }, reason: 'set on the job' });
    expect(resolveGroup(pricing, organizations, robotics)).toMatchObject({ group: { name: 'Institutes' }, reason: 'via the organization' });
    expect(resolveGroup(pricing, organizations, person(['student']))).toMatchObject({ group: { name: 'Students' }, reason: 'via role Student' });
    // Staff comes before Student in the priority order.
    expect(resolveGroup(pricing, organizations, person(['student', 'staff']))).toMatchObject({ group: { name: 'Staff' }, reason: 'via role Staff' });
    expect(resolveGroup(pricing, organizations, person(['member'])).group.isDefault).toBe(true);
    expect(resolveGroup(pricing, organizations, person([])).reason).toMatch(/no role/);
    expect(resolveGroup(pricing, organizations, { kind: 'organization', id: 'o-kreativ', roles: [] }).group.isDefault).toBe(true);
  });
  it('maps roles to active groups and skips a deactivated group', () => {
    const state = fresh();
    const students = state.pricing.groups.find((g) => g.name === 'Students')!;
    expect(resolveGroup(setRoleGroup(state, ctx, 'student', 'Staff').state.pricing, state.organizations, person(['student'])).group.name).toBe('Staff');
    const unmapped = setRoleGroup(state, ctx, 'student', null).state;
    expect(resolveGroup(unmapped.pricing, unmapped.organizations, person(['student'])).group.isDefault).toBe(true);
    expect(thrown(() => setRoleGroup(state, ctx, 'astronaut', 'Staff'))?.code).toBe('not_found');
    const inactive = savePricingGroup(state, ctx, { id: students.id, name: students.name, description: '', active: false, isDefault: false }).state;
    expect(thrown(() => setRoleGroup(inactive, ctx, 'member', 'Students'))?.code).toBe('pricing_group_inactive');
    expect(resolveGroup(inactive.pricing, inactive.organizations, person(['student'])).group.isDefault).toBe(true);
  });
  it('renames a group everywhere it is used', () => {
    const state = fresh();
    const students = state.pricing.groups.find((g) => g.name === 'Students')!;
    const renamed = savePricingGroup(state, ctx, { id: students.id, name: 'Learners', description: '', active: true, isDefault: false }).state;
    expect(renamed.pricing.roleGroups.student).toBe('Learners');
    expect(resolveGroup(renamed.pricing, renamed.organizations, person(['student'])).group.name).toBe('Learners');
    const institutes = state.pricing.groups.find((g) => g.name === 'Institutes')!;
    const org = savePricingGroup(state, ctx, { id: institutes.id, name: 'Labs', description: '', active: true, isDefault: false }).state;
    expect(org.organizations.find((o) => o.id === 'o-robotics')?.pricingGroup).toBe('Labs');
  });
  it('adds and edits organizations with unique names and active groups', () => {
    const state = fresh();
    const input = { name: 'Atelier Eins', kind: 'company' as const, pricingGroup: 'Staff', requiresPurchaseOrder: true, active: true, billing: { addressLine1: 'Gasse 1', postalCode: '8010', locality: 'Graz', countryCode: 'at', contactName: 'Pat' } };
    const added = saveOrganization(state, ctx, input);
    const record = added.state.organizations.find((o) => o.id === added.organizationId)!;
    expect(record).toMatchObject({ name: 'Atelier Eins', requiresPurchaseOrder: true, billing: { countryCode: 'AT' } });
    expect(thrown(() => saveOrganization(added.state, ctx, { ...input, name: 'atelier eins' }))?.code).toBe('conflict');
    expect(thrown(() => saveOrganization(state, ctx, { ...input, pricingGroup: 'Nobody' }))?.code).toBe('pricing_group_inactive');
    expect(thrown(() => saveOrganization(state, ctx, { ...input, name: ' ' }))?.code).toBe('validation');
    const edited = saveOrganization(added.state, ctx, { ...input, id: record.id, requiresPurchaseOrder: false, active: false }).state;
    expect(edited.organizations.find((o) => o.id === record.id)).toMatchObject({ requiresPurchaseOrder: false, active: false });
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
    expect(csvCell('-5,00')).toBe('-5,00');
    expect(csvCell(12.5)).toBe('12,5');
    expect(csvCell('a "b"; c')).toBe('"a ""b""; c"');
    expect(csvCell('1,5 kg, ok')).toBe('1,5 kg, ok');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    const csv = toCsv(['A', 'B'], [['x', 1.25]]);
    expect(csv).toBe('﻿A;B\r\nx;1,25\r\n');
    expect(csv.startsWith('﻿A;B')).toBe(true);
  });
});
