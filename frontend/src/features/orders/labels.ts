import type {
  CashMovementKind,
  CashMovementReason,
  ExternalInvoiceRequestState,
  InvoiceRequestCommandReconciliationKind,
  OrderPayment,
  OrderPaymentMethod,
  PaymentReversalInputReasonKind,
} from '../../api/generated/models';

// Human wording for every domain value. No raw enum is shown on the sales screens.

export const methodLabel = (method: OrderPaymentMethod) =>
  method === 'cash' ? 'Cash' : method === 'card' ? 'Card' : 'Invoice (wiRef)';
/** Every method a cashbook line can have, for filters and tiles. The invoice method is never recorded by hand. */
export const methodFilterOptions: { id: OrderPaymentMethod; label: string }[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'card', label: 'Card' },
  { id: 'external', label: 'Invoice (wiRef)' },
];

export const reasonKindLabel = (kind: string | null | undefined) =>
  kind === 'refund'
    ? 'Money given back'
    : kind === 'recording_error'
      ? 'Recorded by mistake'
      : 'External accounting correction';

/** Receipt, Refund or Correction: what a cashbook line is. */
export function paymentKind(payment: Pick<OrderPayment, 'entryKind' | 'reasonKind'>): {
  id: 'receipt' | 'refund' | 'correction';
  label: string;
  type: 'green' | 'red' | 'purple';
} {
  if (payment.entryKind === 'receipt') return { id: 'receipt', label: 'Receipt', type: 'green' };
  return payment.reasonKind === 'refund'
    ? { id: 'refund', label: 'Refund', type: 'red' }
    : { id: 'correction', label: 'Correction', type: 'purple' };
}

export const requestStateLabel: Record<ExternalInvoiceRequestState, string> = {
  draft: 'Draft',
  submitted: 'Awaiting approval',
  issued: 'Issued',
  cancellation_requested: 'Cancellation requested',
  cancelled: 'Cancelled',
};
export const requestStateTag: Record<ExternalInvoiceRequestState, 'gray' | 'purple' | 'green' | 'red' | 'warm-gray'> = {
  draft: 'gray',
  submitted: 'purple',
  issued: 'green',
  cancellation_requested: 'red',
  cancelled: 'warm-gray',
};
/** What the next step in wiRef is, in plain words. */
export const requestNextStep: Record<ExternalInvoiceRequestState, string> = {
  draft: 'Complete the recipient details',
  submitted: 'Approve and forward to wiRef',
  issued: 'Complete, invoice issued and paid',
  cancellation_requested: 'Confirm the cancellation in wiRef',
  cancelled: 'None',
};

/** How the cashbook names each kind of line, and what happens in each case, in the words of the Refund or correct dialog. */
export const reasonKindHelp: Record<PaymentReversalInputReasonKind, { title: string; help: string }> = {
  refund: {
    title: 'Give the money back (refund)',
    help: 'The customer gets the money back now. It is booked at the time you give it back, so the original day stays as it was.',
  },
  recording_error: {
    title: 'It was recorded by mistake (correction)',
    help: 'The entry was wrong, for example the wrong method or amount. It is booked at the original time, as if it had never happened.',
  },
  external_correction: {
    title: 'Accounting correction in wiRef',
    help: 'wiRef changed or cancelled the payment afterwards. Record the reference of that correction.',
  },
};

export const reconciliationKinds: InvoiceRequestCommandReconciliationKind[] = [
  'cancellation',
  'credit_note',
  'corrected_invoice',
  'reallocation',
  'other',
];
export const reconciliationLabels: Record<InvoiceRequestCommandReconciliationKind, { label: string; help: string }> = {
  cancellation: { label: 'Invoice cancelled', help: 'wiRef cancelled the invoice.' },
  credit_note: { label: 'Credit note issued', help: 'wiRef issued a credit note that offsets the invoice.' },
  corrected_invoice: { label: 'Corrected invoice issued', help: 'wiRef replaced the invoice with a corrected one.' },
  reallocation: { label: 'Amount reallocated', help: 'The amount was moved to another invoice or case.' },
  other: {
    label: 'Other accounting procedure',
    help: 'Something else that settles the invoice. Describe it in the reference.',
  },
};

export const requestEventLabel: Record<string, string> = {
  submitted: 'Submitted for approval',
  returned: 'Returned for correction',
  issued: 'Issued, forwarded to wiRef',
  reference_added: 'Invoice number added',
  cancellation_requested: 'Cancellation requested',
  cancelled: 'Cancelled',
  reference_corrected: 'Reference corrected',
};

export const customerKindLabel = (kind: string) =>
  kind === 'person' ? 'Person' : kind === 'organization' ? 'Organization' : 'Anonymous';
export const customerTypeOptions = [
  { id: 'person', label: 'Person' },
  { id: 'organization', label: 'Organization' },
];

export const cashMovementKindLabel = (kind: CashMovementKind) =>
  kind === 'withdrawal' ? 'Cash withdrawal' : 'Cash deposit';
export const cashMovementReasonLabel: Record<CashMovementReason, string> = {
  bank_deposit: 'Bank deposit',
  safe: 'Moved to safe',
  float: 'Change float',
  other: 'Other',
};
export const cashMovementReasons = (Object.keys(cashMovementReasonLabel) as CashMovementReason[]).map((id) => ({
  id,
  label: cashMovementReasonLabel[id],
}));
export const movementTagType = (kind: CashMovementKind): 'cyan' | 'teal' => (kind === 'withdrawal' ? 'cyan' : 'teal');

export const cashbookKindOptions = [
  { id: 'receipt', label: 'Receipt' },
  { id: 'refund', label: 'Refund' },
  { id: 'correction', label: 'Correction' },
  { id: 'withdrawal', label: cashMovementKindLabel('withdrawal') },
  { id: 'deposit', label: cashMovementKindLabel('deposit') },
];
