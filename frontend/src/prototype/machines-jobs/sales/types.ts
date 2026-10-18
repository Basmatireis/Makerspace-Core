// Prototype sales types. They mirror the real orders domain (backend/internal/orders/models.go, docs/orders.md):
// order lifecycle, item kinds, job charge snapshots, signed allocations, whole-receipt reversals, wiRef requests.
// Money is a plain number in EUR (the API uses decimal strings). Fields marked [proposed] need NEW backend capability.

export type OrderStatus = 'draft' | 'finalized' | 'cancelled' | 'reversed';
export type SettlementState = 'unpaid' | 'partially_paid' | 'paid' | 'no_payment_due';
export type FulfillmentMode = 'immediate' | 'deferred';
export type OrderItemKind = 'manual' | 'machine_job';
/** `external` is a bank transfer to the HTU account against a wiRef invoice [proposed rule: only after the invoice is issued]. */
export type PaymentMethod = 'cash' | 'card' | 'external';
export type PaymentEntryKind = 'receipt' | 'reversal';
export type ReversalReasonKind = 'refund' | 'recording_error' | 'external_correction';
export type InvoiceRequestState = 'draft' | 'ready' | 'submitted' | 'issued' | 'cancellation_requested' | 'cancelled';

/** The payer reference of an order. Every order has one: an account (person) or an organization. */
export type OrderCustomer = { kind: 'person' | 'organization'; id: string };

/** What an order keeps of a job at charge time. Excludes customer/operator names and notes, like the real snapshot. */
export type JobChargeSnapshot = {
  displayId: string;
  machineName: string;
  machineTypeName: string;
  startsAt: string;
  endsAt: string;
  durationSeconds: number;
  outcome: string;
  usages: { materialName: string; unit: string; quantity: number; ownership: 'makerspace' | 'external' }[];
  pricingGroupName: string;
  /** Why that group priced the job, e.g. "via role Student". */
  pricingVia: string;
  calculatedAmount: number | null;
  effectiveAmount: number;
  overrideReason: string | null;
  capturedAt: string;
};

export type OrderItem = {
  id: string;
  position: number;
  kind: OrderItemKind;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  /** Line amount, rounded half-up to cents. */
  amount: number;
  sourceJobId: string | null;
  /** Job version at capture; a different live version means "job changed since charged". */
  sourceJobVersion: number | null;
  snapshot: JobChargeSnapshot | null;
  /** [proposed] Sale catalog entry this manual item was created from. */
  catalogItemId: string | null;
  createdAt: string;
  /** Removed rows stay visible as history. */
  removedAt: string | null;
};

export type OrderEventKind =
  | 'created' | 'item_added' | 'item_removed' | 'item_refreshed' | 'edited' | 'finalized' | 'paid' | 'refund' | 'correction'
  | 'reversed' | 'replacement_started' | 'replaced' | 'cancelled' | 'invoicing';
/** [proposed] Order audit trail as a read endpoint. The real audit events only hold identifiers and changed field names. */
export type OrderEvent = { id: string; at: string; actor: string; kind: OrderEventKind; text: string };

export type Order = {
  id: string;
  /** O-YYYY-NNNNNN */
  reference: string;
  status: OrderStatus;
  customer: OrderCustomer;
  /** Name snapshot at creation. */
  customerName: string;
  fulfillmentMode: FulfillmentMode;
  items: OrderItem[];
  replacesOrderId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** [proposed] The real API does not return who created an order. */
  createdBy: string;
  events: OrderEvent[];
};

export type Payment = {
  id: string;
  /** P-YYYY-NNNNNN, suitable for the physical cashbook. */
  reference: string;
  entryKind: PaymentEntryKind;
  method: PaymentMethod;
  /** Always positive; reversals carry the amount of the receipt they undo. */
  amount: number;
  occurredAt: string;
  recordedAt: string;
  /** [proposed] Display name of the recording actor. */
  recordedBy: string;
  reversesPaymentId: string | null;
  reasonKind: ReversalReasonKind | null;
  reason: string;
  /** Card terminal / provider, or the external source. */
  terminal: string;
  /** Confirmed terminal transaction reference, or the external confirmation reference. */
  transactionReference: string;
};

/** Signed immutable allocation of a payment to an order. A transfer is a negative plus a positive entry with one operation id. */
export type Allocation = { id: string; paymentId: string; orderId: string; amount: number; operationId: string; at: string };

/** A full-reversal charge adjustment (A-YYYY-NNNNNN). */
export type OrderAdjustment = { id: string; reference: string; orderId: string; amount: number; reason: string; at: string; by: string };

export type InvoiceRequestDetails = {
  recipientName: string; addressLine1: string; postalCode: string; locality: string; countryCode: string; contactName: string;
  serviceStartsOn: string; serviceEndsOn: string; serviceDescription: string; purchaseOrderReference: string;
};
export type InvoiceEventKind = 'created' | 'details_saved' | 'ready' | 'submitted' | 'issued' | 'cancellation_requested' | 'cancelled' | 'reference_corrected';
/** How an external cancellation was settled in wiRef. */
export type ReconciliationKind = 'cancellation' | 'credit_note' | 'corrected_invoice' | 'reallocation' | 'other';
export type InvoiceRequestEvent = {
  id: string; at: string; actor: string; kind: InvoiceEventKind; text: string;
  /** Invoice number, credit note number or similar from wiRef. */
  externalReference?: string;
  /** The date the fact is effective in wiRef (YYYY-MM-DD). */
  effectiveOn?: string;
  reconciliationKind?: ReconciliationKind;
  reason?: string;
};
export type InvoiceRequest = {
  id: string;
  /** W-YYYY-NNNNNN */
  reference: string;
  orderId: string;
  orderReference: string;
  state: InvoiceRequestState;
  requestedAmount: number;
  /** [proposed] Cash and card already received for the order when the request was made (kept in sync while the request is a draft). The invoice is then marked paid for that part. */
  alreadyPaid: number;
  details: InvoiceRequestDetails;
  events: InvoiceRequestEvent[];
  supersedesRequestId: string | null;
  version: number;
  createdAt: string;
};

export type OrganizationKind = 'institute' | 'company' | 'association';
export type BillingContact = { addressLine1: string; postalCode: string; locality: string; countryCode: string; contactName: string };
/**
 * The only customers that are not accounts: institutes, companies and associations. Everybody else is an account (person) that is priced by account role.
 * [proposed] Organization-level pricing group (organization invoicing requirements exist today).
 */
export type OrganizationRecord = {
  id: string; name: string; kind: OrganizationKind;
  /** Null means "follow the default group". */
  pricingGroup: string | null;
  /** wiRef requests need a purchase order reference (organization_invoicing_requirements). */
  requiresPurchaseOrder: boolean;
  active: boolean;
  billing: BillingContact;
};

export type CashMovementKind = 'withdrawal' | 'deposit';
export type CashMovementReason = 'bank_deposit' | 'safe' | 'float' | 'other';
/** [proposed] Money taken out of or added to the cash register, not tied to an order. */
export type CashMovement = {
  id: string;
  /** C-YYYY-NNNNNN */
  reference: string;
  kind: CashMovementKind;
  /** Always positive. */
  amount: number;
  occurredAt: string;
  recordedAt: string;
  recordedBy: string;
  reason: CashMovementReason;
  note: string;
};

/** [proposed] Sale catalog: fixed-price items for orders. */
export type CatalogItem = { id: string; name: string; unit: string; unitPrice: number; category: string };

export type SalesCounters = { order: number; payment: number; adjustment: number; request: number; movement: number };

/** What a payment input looks like before it becomes a Payment (cash: tendered amount only matters in the UI). */
export type PaymentInput = { method: PaymentMethod; amount: number; occurredAt: string; terminal: string; transactionReference: string };
export type ReversalInput = { paymentId: string; reasonKind: ReversalReasonKind; reason: string; occurredAt: string; transactionReference: string };
