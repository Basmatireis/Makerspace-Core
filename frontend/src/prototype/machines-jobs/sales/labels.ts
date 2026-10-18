import type { InvoiceRequestState, Payment, PaymentMethod, ReversalReasonKind } from './types';

// Human wording for every domain enum. No raw enum value is shown anywhere in the sales screens.

export const methodLabel = (method: PaymentMethod) => method === 'cash' ? 'Cash' : method === 'card' ? 'Card' : 'Bank transfer (wiRef)';
export const methodOptions: { id: PaymentMethod; label: string }[] = [{ id: 'cash', label: 'Cash' }, { id: 'card', label: 'Card' }, { id: 'external', label: 'Bank transfer (wiRef)' }];

export const reasonKindLabel = (kind: ReversalReasonKind) => kind === 'refund' ? 'Money given back' : kind === 'recording_error' ? 'Recorded by mistake' : 'External accounting correction';

/** Receipt, Refund or Correction: what a cashbook line is. */
export function paymentKind(payment: Payment): { label: string; type: 'green' | 'red' | 'purple' } {
  if (payment.entryKind === 'receipt') return { label: 'Receipt', type: 'green' };
  return payment.reasonKind === 'refund' ? { label: 'Refund', type: 'red' } : { label: 'Correction', type: 'purple' };
}

export const requestStateLabel: Record<InvoiceRequestState, string> = {
  draft: 'Draft', ready: 'Ready to submit', submitted: 'Submitted to wiRef', issued: 'Invoice issued', cancellation_requested: 'Cancellation requested', cancelled: 'Cancelled',
};
export const requestStateTag: Record<InvoiceRequestState, 'gray' | 'blue' | 'purple' | 'green' | 'red' | 'warm-gray'> = {
  draft: 'gray', ready: 'blue', submitted: 'purple', issued: 'green', cancellation_requested: 'red', cancelled: 'warm-gray',
};
/** What the next step in wiRef is, in plain words. */
export const requestNextStep: Record<InvoiceRequestState, string> = {
  draft: 'Complete the recipient details', ready: 'Submit to wiRef', submitted: 'Wait for wiRef to issue the invoice', issued: 'Confirm the payment when it arrives',
  cancellation_requested: 'Confirm the cancellation in wiRef', cancelled: 'None',
};

/** The signed-in staff member of the prototype; actions are attributed to them. */
export const CURRENT_ACTOR = 'Sara Kofler';

export const terminals = ['Terminal 1 · Front desk', 'Terminal 2 · Workshop'];
