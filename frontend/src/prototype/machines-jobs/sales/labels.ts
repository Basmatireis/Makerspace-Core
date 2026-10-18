import type { InvoiceEventKind, InvoiceRequestState, Payment, PaymentMethod, ReconciliationKind, ReversalReasonKind } from './types';

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

/** How the cashbook names each kind of line, and what happens in each case, in the words of the Refund or correct dialog. */
export const reasonKindHelp: Record<ReversalReasonKind, { title: string; help: string }> = {
  refund: { title: 'Give the money back (refund)', help: 'The customer gets the money back now. It is booked at the time you give it back, so the original day stays as it was.' },
  recording_error: { title: 'It was recorded by mistake (correction)', help: 'The entry was wrong, for example the wrong method or amount. It is booked at the original time, as if it had never happened.' },
  external_correction: { title: 'Accounting correction in wiRef', help: 'wiRef changed or cancelled the payment afterwards. Record the reference of that correction.' },
};

export const reconciliationLabels: Record<ReconciliationKind, { label: string; help: string }> = {
  cancellation: { label: 'Invoice cancelled', help: 'wiRef cancelled the invoice.' },
  credit_note: { label: 'Credit note issued', help: 'wiRef issued a credit note that offsets the invoice.' },
  corrected_invoice: { label: 'Corrected invoice issued', help: 'wiRef replaced the invoice with a corrected one.' },
  reallocation: { label: 'Amount reallocated', help: 'The amount was moved to another invoice or case.' },
  other: { label: 'Other accounting procedure', help: 'Something else that settles the invoice. Describe it in the reference.' },
};

export const requestEventLabel: Record<InvoiceEventKind, string> = {
  created: 'Prepared', details_saved: 'Details saved', ready: 'Marked ready', submitted: 'Submitted', issued: 'Invoice issued', cancellation_requested: 'Cancellation requested',
  cancelled: 'Cancelled', reference_corrected: 'Reference corrected',
};

export const customerKindLabel = (kind: 'person' | 'organization' | 'walk_in') => kind === 'person' ? 'Person' : kind === 'organization' ? 'Organization' : 'Walk-in customer';
