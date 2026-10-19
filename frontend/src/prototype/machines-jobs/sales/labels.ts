import type { CashMovement, CashMovementKind, CashMovementReason, InvoiceEventKind, InvoiceRequestState, OrganizationKind, Payment, PaymentMethod, ReconciliationKind, ReversalReasonKind } from './types';

// Human wording for every domain enum. No raw enum value is shown anywhere in the sales screens.

export const methodLabel = (method: PaymentMethod) => method === 'cash' ? 'Cash' : method === 'card' ? 'Card' : 'Invoice (wiRef)';
export const methodOptions: { id: PaymentMethod; label: string }[] = [{ id: 'cash', label: 'Cash' }, { id: 'card', label: 'Card' }];
/** Every method a cashbook line can have, for filters and tiles. The invoice method is never recorded by hand. */
export const methodFilterOptions: { id: PaymentMethod; label: string }[] = [...methodOptions, { id: 'external', label: 'Invoice (wiRef)' }];

export const reasonKindLabel = (kind: ReversalReasonKind) => kind === 'refund' ? 'Money given back' : kind === 'recording_error' ? 'Recorded by mistake' : 'External accounting correction';

/** Receipt, Refund or Correction: what a cashbook line is. */
export function paymentKind(payment: Payment): { label: string; type: 'green' | 'red' | 'purple' } {
  if (payment.entryKind === 'receipt') return { label: 'Receipt', type: 'green' };
  return payment.reasonKind === 'refund' ? { label: 'Refund', type: 'red' } : { label: 'Correction', type: 'purple' };
}

export const requestStateLabel: Record<InvoiceRequestState, string> = {
  draft: 'Draft', submitted: 'Awaiting approval', issued: 'Issued', cancellation_requested: 'Cancellation requested', cancelled: 'Cancelled',
};
export const requestStateTag: Record<InvoiceRequestState, 'gray' | 'blue' | 'purple' | 'green' | 'red' | 'warm-gray'> = {
  draft: 'gray', submitted: 'purple', issued: 'green', cancellation_requested: 'red', cancelled: 'warm-gray',
};
/** What the next step in wiRef is, in plain words. */
export const requestNextStep: Record<InvoiceRequestState, string> = {
  draft: 'Complete the recipient details', submitted: 'Approve and forward to wiRef', issued: 'Complete, invoice issued and paid',
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
  created: 'Prepared', details_saved: 'Details saved', submitted: 'Submitted for approval', returned: 'Returned for correction', issued: 'Issued, forwarded to wiRef',
  reference_added: 'Invoice number added', cancellation_requested: 'Cancellation requested', cancelled: 'Cancelled', reference_corrected: 'Reference corrected',
};

export const customerKindLabel = (kind: 'person' | 'organization') => kind === 'person' ? 'Person' : 'Organization';

export const organizationKindLabel: Record<OrganizationKind, string> = { institute: 'Institute', company: 'Company', association: 'Association' };
export const organizationKinds = (Object.keys(organizationKindLabel) as OrganizationKind[]).map((id) => ({ id, label: organizationKindLabel[id] }));

export const cashMovementKindLabel = (kind: CashMovementKind) => kind === 'withdrawal' ? 'Cash withdrawal' : 'Cash deposit';
export const cashMovementReasonLabel: Record<CashMovementReason, string> = { bank_deposit: 'Bank deposit', safe: 'Moved to safe', float: 'Change float', other: 'Other' };
export const cashMovementReasons = (Object.keys(cashMovementReasonLabel) as CashMovementReason[]).map((id) => ({ id, label: cashMovementReasonLabel[id] }));
/** The cashbook kind of a movement, next to Receipt, Refund and Correction. */
export const movementKind = (movement: Pick<CashMovement, 'kind'>): { label: string; type: 'cyan' | 'teal' } => ({ label: cashMovementKindLabel(movement.kind), type: movement.kind === 'withdrawal' ? 'cyan' : 'teal' });

/** The main-menu wording for the "Invoice" column and section. */
export const invoiceStateText = (state: InvoiceRequestState) => requestStateLabel[state];
