package orders

// OrderStatus is the lifecycle position of an order.
type OrderStatus string

const (
	OrderDraft     OrderStatus = "draft"
	OrderFinalized OrderStatus = "finalized"
	OrderReversed  OrderStatus = "reversed"
	OrderCancelled OrderStatus = "cancelled"
)

// CustomerKind says who an order is for; anonymous orders have no customer.
type CustomerKind string

const (
	CustomerPerson       CustomerKind = "person"
	CustomerOrganization CustomerKind = "organization"
	CustomerAnonymous    CustomerKind = "anonymous"
)

// FulfillmentMode says whether an order is settled at once or later.
type FulfillmentMode string

const (
	FulfillmentImmediate FulfillmentMode = "immediate"
	FulfillmentDeferred  FulfillmentMode = "deferred"
)

// OrderItemKind is where the charge of an order item comes from.
type OrderItemKind string

const (
	ItemManual     OrderItemKind = "manual"
	ItemMachineJob OrderItemKind = "machine_job"
	ItemInventory  OrderItemKind = "inventory_item"
)

// ItemAction is a change to the items of a draft order.
type ItemAction string

const (
	ItemActionAdd     ItemAction = "add"
	ItemActionRefresh ItemAction = "refresh"
	ItemActionRemove  ItemAction = "remove"
)

// OrderAction is a command that moves an order through its lifecycle.
type OrderAction string

const (
	OrderActionCancel       OrderAction = "cancel"
	OrderActionFinalize     OrderAction = "finalize"
	OrderActionCheckout     OrderAction = "checkout"
	OrderActionReverse      OrderAction = "reverse"
	OrderActionReplacements OrderAction = "replacements"
	OrderActionReplace      OrderAction = "replace"
)

// PaymentMethod is how a payment was made.
type PaymentMethod string

const (
	PaymentCash     PaymentMethod = "cash"
	PaymentCard     PaymentMethod = "card"
	PaymentExternal PaymentMethod = "external"
)

// PaymentEntryKind says whether a payment ledger entry takes money in or reverses an earlier entry.
type PaymentEntryKind string

const (
	EntryReceipt  PaymentEntryKind = "receipt"
	EntryReversal PaymentEntryKind = "reversal"
)

// ReversalReason is why a payment was reversed.
type ReversalReason string

const (
	ReversalRefund             ReversalReason = "refund"
	ReversalRecordingError     ReversalReason = "recording_error"
	ReversalExternalCorrection ReversalReason = "external_correction"
)

// SettlementState is how much of an order's charge has been paid.
type SettlementState string

const (
	SettlementUnpaid        SettlementState = "unpaid"
	SettlementNoPaymentDue  SettlementState = "no_payment_due"
	SettlementPaid          SettlementState = "paid"
	SettlementPartiallyPaid SettlementState = "partially_paid"
)

// InvoiceState is the lifecycle position of an external invoice request.
type InvoiceState string

const (
	InvoiceDraft                 InvoiceState = "draft"
	InvoiceSubmitted             InvoiceState = "submitted"
	InvoiceIssued                InvoiceState = "issued"
	InvoiceCancellationRequested InvoiceState = "cancellation_requested"
	InvoiceCancelled             InvoiceState = "cancelled"
)

// InvoiceAction is a command on an external invoice request.
type InvoiceAction string

const (
	InvoiceActionSubmit              InvoiceAction = "submit"
	InvoiceActionReturn              InvoiceAction = "return"
	InvoiceActionForward             InvoiceAction = "forward"
	InvoiceActionCancel              InvoiceAction = "cancel"
	InvoiceActionRequestCancellation InvoiceAction = "request-cancellation"
	InvoiceActionConfirmCancellation InvoiceAction = "confirm-cancellation"
	InvoiceActionReferenceCorrection InvoiceAction = "reference-corrections"
)

// InvoiceEventKind is what happened to an external invoice request.
type InvoiceEventKind string

const (
	InvoiceEventSubmitted             InvoiceEventKind = "submitted"
	InvoiceEventReturned              InvoiceEventKind = "returned"
	InvoiceEventIssued                InvoiceEventKind = "issued"
	InvoiceEventCancelled             InvoiceEventKind = "cancelled"
	InvoiceEventCancellationRequested InvoiceEventKind = "cancellation_requested"
	InvoiceEventReferenceAdded        InvoiceEventKind = "reference_added"
	InvoiceEventReferenceCorrected    InvoiceEventKind = "reference_corrected"
)

// ReconciliationKind is the external accounting procedure that closed a cancelled invoice.
type ReconciliationKind string

const (
	ReconciliationCancellation     ReconciliationKind = "cancellation"
	ReconciliationCreditNote       ReconciliationKind = "credit_note"
	ReconciliationCorrectedInvoice ReconciliationKind = "corrected_invoice"
	ReconciliationReallocation     ReconciliationKind = "reallocation"
	ReconciliationOther            ReconciliationKind = "other"
)

// CashMovementKind says whether money leaves or enters the cash register outside of sales.
type CashMovementKind string

const (
	CashWithdrawal CashMovementKind = "withdrawal"
	CashDeposit    CashMovementKind = "deposit"
)

// CashMovementReason is why cash was moved.
type CashMovementReason string

const (
	CashReasonBankDeposit CashMovementReason = "bank_deposit"
	CashReasonSafe        CashMovementReason = "safe"
	CashReasonFloat       CashMovementReason = "float"
	CashReasonOther       CashMovementReason = "other"
)

// reversalReasonText stores a reversal reason in its nullable text column.
func reversalReasonText(reason ReversalReason) *string {
	text := string(reason)
	return &text
}

// reversalReasonFromText reads a reversal reason from its nullable text column.
func reversalReasonFromText(text *string) *ReversalReason {
	if text == nil {
		return nil
	}
	reason := ReversalReason(*text)
	return &reason
}
