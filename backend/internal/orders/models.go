package orders

import (
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/google/uuid"
)

// Actor is the display name of the person behind a recorded action. It carries no other personal data.
type Actor struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"displayName"`
}

type OrderCustomer struct {
	Kind CustomerKind `json:"kind"`
	ID   uuid.UUID    `json:"id"`
}

type OrderDraftInput struct {
	Customer        *OrderCustomer  `json:"customer,omitempty"`
	FulfillmentMode FulfillmentMode `json:"fulfillmentMode"`
}

type UpdateOrderDraftInput struct {
	PreserveCustomer bool            `json:"-"`
	Customer         *OrderCustomer  `json:"customer,omitempty"`
	FulfillmentMode  FulfillmentMode `json:"fulfillmentMode"`
	ExpectedVersion  int64           `json:"expectedVersion"`
}

type OrderItemInput struct {
	Kind               OrderItemKind `json:"kind"`
	Description        string        `json:"description,omitempty"`
	Quantity           string        `json:"quantity,omitempty"`
	Unit               string        `json:"unit,omitempty"`
	UnitPrice          string        `json:"unitPrice,omitempty"`
	MachineJobID       uuid.UUID     `json:"machineJobId,omitempty"`
	MaterialID         uuid.UUID     `json:"materialId,omitempty"`
	ExpectedJobVersion int64         `json:"expectedJobVersion,omitempty"`
	ExpectedVersion    int64         `json:"expectedVersion"`
}

type PaymentInput struct {
	Method            PaymentMethod `json:"method"`
	Amount            string        `json:"amount"`
	OccurredAt        time.Time     `json:"occurredAt"`
	ExternalSource    string        `json:"externalSource,omitempty"`
	ExternalReference string        `json:"externalReference,omitempty"`
	// splitPart numbers the receipts one payment entry is split into when it settles several orders; 0 means 1.
	splitPart int16
}

type PaymentReversalInput struct {
	PaymentID         uuid.UUID      `json:"paymentId"`
	ReasonKind        ReversalReason `json:"reasonKind"`
	Reason            string         `json:"reason"`
	OccurredAt        time.Time      `json:"occurredAt"`
	ExternalReference string         `json:"externalReference,omitempty"`
}

type OrderCommand struct {
	OperationKey               uuid.UUID              `json:"operationKey"`
	ExpectedVersion            int64                  `json:"expectedVersion"`
	Reason                     string                 `json:"reason,omitempty"`
	ReplacementOrderID         uuid.UUID              `json:"replacementOrderId,omitempty"`
	ExpectedReplacementVersion int64                  `json:"expectedReplacementVersion,omitempty"`
	Payments                   []PaymentInput         `json:"payments,omitempty"`
	Reversals                  []PaymentReversalInput `json:"reversals,omitempty"`
}

type RecordOrderPayment struct {
	OperationKey    uuid.UUID    `json:"operationKey"`
	ExpectedVersion int64        `json:"expectedVersion"`
	Payment         PaymentInput `json:"payment"`
}

type ReversePaymentCommand struct {
	OperationKey       uuid.UUID            `json:"operationKey"`
	ExpectedVersion    int64                `json:"expectedVersion"`
	Reversal           PaymentReversalInput `json:"reversal"`
	ReplacementPayment *PaymentInput        `json:"replacementPayment,omitempty"`
}

type JobChargeSnapshot struct {
	DisplayID           string                       `json:"displayId"`
	MachineID           uuid.UUID                    `json:"machineId"`
	MachineName         string                       `json:"machineName"`
	MachineTypeID       uuid.UUID                    `json:"machineTypeId"`
	MachineTypeName     string                       `json:"machineTypeName"`
	StartsAt            time.Time                    `json:"startsAt"`
	EndsAt              time.Time                    `json:"endsAt"`
	DurationNanoseconds string                       `json:"durationNanoseconds"`
	Outcome             machinelogbook.JobOutcome    `json:"outcome"`
	Usages              []JobUsage                   `json:"usages"`
	Pricing             PricingEvidence              `json:"pricing"`
	PricingStatus       machinelogbook.PricingStatus `json:"pricingStatus"`
	CalculatedAmount    *string                      `json:"calculatedAmount,omitempty"`
	FinalAmount         *string                      `json:"finalAmount,omitempty"`
	EffectiveAmount     string                       `json:"effectiveAmount"`
	OverrideReason      *string                      `json:"overrideReason,omitempty"`
	OverriddenAt        *time.Time                   `json:"overriddenAt,omitempty"`
	CapturedAt          time.Time                    `json:"capturedAt"`
}

type OrderItem struct {
	ID                 uuid.UUID          `json:"id"`
	Position           int64              `json:"position"`
	Kind               OrderItemKind      `json:"kind"`
	Description        string             `json:"description"`
	Quantity           string             `json:"quantity"`
	Unit               string             `json:"unit"`
	UnitPrice          string             `json:"unitPrice"`
	Amount             string             `json:"amount"`
	SourceMachineJobID *uuid.UUID         `json:"sourceMachineJobId,omitempty"`
	SourceJobVersion   *int64             `json:"sourceJobVersion,omitempty"`
	SourceMaterialID   *uuid.UUID         `json:"sourceMaterialId,omitempty"`
	SourceChanged      bool               `json:"sourceChanged"`
	Snapshot           *JobChargeSnapshot `json:"snapshot,omitempty"`
	CreatedAt          time.Time          `json:"createdAt"`
	RemovedAt          *time.Time         `json:"removedAt,omitempty"`
}

type OrderAllocation struct {
	ID               uuid.UUID  `json:"id"`
	PaymentID        *uuid.UUID `json:"paymentId"`
	PaymentReference string     `json:"paymentReference"`
	OrderID          *uuid.UUID `json:"orderId"`
	OrderReference   string     `json:"orderReference"`
	Amount           string     `json:"amount"`
	OperationID      uuid.UUID  `json:"operationId"`
	CreatedAt        time.Time  `json:"createdAt"`
}

type OrderAdjustment struct {
	ID        uuid.UUID `json:"id"`
	Reference string    `json:"reference"`
	Amount    string    `json:"amount"`
	Reason    string    `json:"reason"`
	CreatedAt time.Time `json:"createdAt"`
}

type Order struct {
	ActiveExternalRequestID        *uuid.UUID        `json:"activeExternalRequestId"`
	ActiveExternalRequestReference *string           `json:"activeExternalRequestReference"`
	ActiveExternalRequestState     *InvoiceState     `json:"activeExternalRequestState"`
	LatestExternalRequestID        *uuid.UUID        `json:"latestExternalRequestId"`
	LatestExternalRequestReference *string           `json:"latestExternalRequestReference"`
	LatestExternalRequestState     *InvoiceState     `json:"latestExternalRequestState"`
	ReplacedByOrderID              *uuid.UUID        `json:"replacedByOrderId"`
	ReplacedByOrderReference       *string           `json:"replacedByOrderReference"`
	ID                             uuid.UUID         `json:"id"`
	Reference                      string            `json:"reference"`
	Status                         OrderStatus       `json:"status"`
	Currency                       string            `json:"currency"`
	CustomerKind                   CustomerKind      `json:"customerKind"`
	Customer                       *OrderCustomer    `json:"customer"`
	CustomerName                   *string           `json:"customerName"`
	FulfillmentMode                FulfillmentMode   `json:"fulfillmentMode"`
	TotalAmount                    string            `json:"totalAmount"`
	NetCharge                      string            `json:"netCharge"`
	SettledAmount                  string            `json:"settledAmount"`
	OutstandingAmount              string            `json:"outstandingAmount"`
	SettlementState                SettlementState   `json:"settlementState"`
	ReplacesOrderID                *uuid.UUID        `json:"replacesOrderId"`
	ReplacesOrderReference         *string           `json:"replacesOrderReference"`
	Items                          []OrderItem       `json:"items"`
	Allocations                    []OrderAllocation `json:"allocations"`
	Adjustments                    []OrderAdjustment `json:"adjustments"`
	Version                        int64             `json:"version"`
	CreatedAt                      time.Time         `json:"createdAt"`
	UpdatedAt                      time.Time         `json:"updatedAt"`
	CreatedBy                      *Actor            `json:"createdBy"`
}

type OrderPayment struct {
	ID                       uuid.UUID         `json:"id"`
	Reference                string            `json:"reference"`
	EntryKind                PaymentEntryKind  `json:"entryKind"`
	Method                   PaymentMethod     `json:"method"`
	Amount                   string            `json:"amount"`
	OccurredAt               time.Time         `json:"occurredAt"`
	RecordedAt               time.Time         `json:"recordedAt"`
	ReversesPaymentID        *uuid.UUID        `json:"reversesPaymentId"`
	ReversedPaymentReference *string           `json:"reversedPaymentReference"`
	ReasonKind               *ReversalReason   `json:"reasonKind"`
	Reason                   string            `json:"reason"`
	ExternalSource           string            `json:"externalSource"`
	ExternalReference        string            `json:"externalReference"`
	Allocations              []OrderAllocation `json:"allocations"`
	RecordedBy               *Actor            `json:"recordedBy"`
}

type OrderPage struct {
	Items    []Order `json:"items"`
	Page     int64   `json:"page"`
	PageSize int64   `json:"pageSize"`
	Total    int64   `json:"total"`
}

type OrderPaymentPage struct {
	Items    []OrderPayment `json:"items"`
	Page     int64          `json:"page"`
	PageSize int64          `json:"pageSize"`
	Total    int64          `json:"total"`
}

type ExternalInvoiceRequestPage struct {
	Items    []ExternalInvoiceRequest `json:"items"`
	Page     int64                    `json:"page"`
	PageSize int64                    `json:"pageSize"`
	Total    int64                    `json:"total"`
}

type PaymentReconciliation struct {
	Cash     string         `json:"cash"`
	Card     string         `json:"card"`
	External string         `json:"external"`
	Entries  []OrderPayment `json:"entries"`
	Page     int64          `json:"page"`
	PageSize int64          `json:"pageSize"`
	Total    int64          `json:"total"`
}

type InvoicingRequirements struct {
	RequirePurchaseOrderReference bool  `json:"requirePurchaseOrderReference"`
	Version                       int64 `json:"version"`
}

type UpdateInvoicingRequirements struct {
	RequirePurchaseOrderReference bool  `json:"requirePurchaseOrderReference"`
	ExpectedVersion               int64 `json:"expectedVersion"`
}

type InvoiceRequestDetails struct {
	RecipientName          string     `json:"recipientName,omitempty"`
	AddressLine1           string     `json:"addressLine1,omitempty"`
	AddressLine2           string     `json:"addressLine2,omitempty"`
	PostalCode             string     `json:"postalCode,omitempty"`
	Locality               string     `json:"locality,omitempty"`
	Region                 string     `json:"region,omitempty"`
	CountryCode            string     `json:"countryCode,omitempty"`
	ContactPersonID        *uuid.UUID `json:"contactPersonId,omitempty"`
	ContactName            string     `json:"contactName,omitempty"`
	ContactChannel         string     `json:"contactChannel,omitempty"`
	ServiceStartsOn        string     `json:"serviceStartsOn,omitempty"`
	ServiceEndsOn          string     `json:"serviceEndsOn,omitempty"`
	ServiceDescription     string     `json:"serviceDescription,omitempty"`
	PurchaseOrderReference string     `json:"purchaseOrderReference,omitempty"`
}

type CreateInvoiceRequest struct {
	OperationKey    uuid.UUID             `json:"operationKey"`
	ExpectedVersion int64                 `json:"expectedVersion"`
	Details         InvoiceRequestDetails `json:"details"`
}

type UpdateInvoiceRequest struct {
	ExpectedVersion int64                 `json:"expectedVersion"`
	Details         InvoiceRequestDetails `json:"details"`
}

type InvoiceRequestCommand struct {
	OperationKey       uuid.UUID          `json:"operationKey"`
	ExpectedVersion    int64              `json:"expectedVersion"`
	ExternalReference  string             `json:"externalReference,omitempty"`
	ReconciliationKind ReconciliationKind `json:"reconciliationKind,omitempty"`
	Reason             string             `json:"reason,omitempty"`
	EffectiveAt        time.Time          `json:"effectiveAt,omitempty"`
	Amount             string             `json:"amount,omitempty"`
}

type InvoiceRequestEvent struct {
	ID                 uuid.UUID          `json:"id"`
	Kind               InvoiceEventKind   `json:"kind"`
	ExternalReference  string             `json:"externalReference"`
	ReconciliationKind ReconciliationKind `json:"reconciliationKind"`
	Reason             string             `json:"reason"`
	EffectiveAt        time.Time          `json:"effectiveAt"`
	RecordedAt         time.Time          `json:"recordedAt"`
	RecordedBy         *Actor             `json:"recordedBy"`
}

type ExternalInvoiceRequest struct {
	ID                            uuid.UUID             `json:"id"`
	Reference                     string                `json:"reference"`
	OrderID                       *uuid.UUID            `json:"orderId"`
	OrderReference                string                `json:"orderReference"`
	Provider                      string                `json:"provider"`
	State                         InvoiceState          `json:"state"`
	Currency                      string                `json:"currency"`
	RequestedAmount               string                `json:"requestedAmount"`
	AlreadyPaid                   string                `json:"alreadyPaid"`
	Details                       InvoiceRequestDetails `json:"details"`
	RequirePurchaseOrderReference bool                  `json:"requirePurchaseOrderReference"`
	RequirementsVersion           int64                 `json:"requirementsVersion"`
	ItemSummary                   []OrderItem           `json:"itemSummary"`
	Events                        []InvoiceRequestEvent `json:"events"`
	SupersedesRequestID           *uuid.UUID            `json:"supersedesRequestId"`
	WiRefDelivery                 *WiRefDelivery        `json:"wirefDelivery"`
	Version                       int64                 `json:"version"`
	CreatedAt                     time.Time             `json:"createdAt"`
}

// WiRefDelivery records whether the approved request reached the accounting office.
type WiRefDelivery struct {
	Status      string    `json:"status"`
	AttemptedAt time.Time `json:"attemptedAt"`
	FailureCode string    `json:"failureCode"`
}

type JobOrderAssociation struct {
	OrderID        *uuid.UUID `json:"orderId"`
	OrderItemID    *uuid.UUID `json:"orderItemId"`
	OrderReference *string    `json:"orderReference"`
	SourceChanged  bool       `json:"sourceChanged"`
}

type JobUsage struct {
	ID                 uuid.UUID                       `json:"id"`
	MaterialID         *uuid.UUID                      `json:"materialId,omitempty"`
	SpoolID            *uuid.UUID                      `json:"spoolId,omitempty"`
	SpoolDisplayID     *string                         `json:"spoolDisplayId,omitempty"`
	Ownership          machinelogbook.UsageOwnership   `json:"ownership"`
	MaterialName       string                          `json:"materialName"`
	Category           string                          `json:"category"`
	Unit               string                          `json:"unit"`
	Quantity           string                          `json:"quantity"`
	QuantityBasis      machinelogbook.QuantityBasis    `json:"quantityBasis"`
	EstimationMethod   *string                         `json:"estimationMethod,omitempty"`
	CalculationVersion *string                         `json:"calculationVersion,omitempty"`
	EstimateQuality    *machinelogbook.EstimateQuality `json:"estimateQuality,omitempty"`
	ReportRevision     *int64                          `json:"reportRevision,omitempty"`
	StaffCorrected     bool                            `json:"staffCorrected,omitempty"`
}
type PricingEvidence struct {
	ID               uuid.UUID                     `json:"id"`
	Revision         int                           `json:"revision"`
	PricingGroupName string                        `json:"pricingGroupName"`
	Currency         string                        `json:"currency"`
	Reason           machinelogbook.SnapshotReason `json:"reason"`
	Complete         bool                          `json:"complete"`
	CalculatedAmount *string                       `json:"calculatedAmount"`
	CapturedAt       time.Time                     `json:"capturedAt"`
	Rules            []PriceRule                   `json:"rules"`
}
type PriceRule struct {
	SourceRuleID *uuid.UUID                     `json:"sourceRuleId"`
	Kind         machinelogbook.PricingRuleKind `json:"kind"`
	Label        string                         `json:"label"`
	Selector     string                         `json:"selector"`
	Unit         string                         `json:"unit"`
	Rate         *string                        `json:"rate"`
	Missing      bool                           `json:"missing"`
}

type CashMovementInput struct {
	OperationKey uuid.UUID          `json:"operationKey"`
	Kind         CashMovementKind   `json:"kind"`
	Amount       string             `json:"amount"`
	Reason       CashMovementReason `json:"reason"`
	Note         string             `json:"note,omitempty"`
	OccurredAt   time.Time          `json:"occurredAt"`
}

type CashMovement struct {
	ID         uuid.UUID          `json:"id"`
	Reference  string             `json:"reference"`
	Kind       CashMovementKind   `json:"kind"`
	Amount     string             `json:"amount"`
	Reason     CashMovementReason `json:"reason"`
	Note       string             `json:"note"`
	OccurredAt time.Time          `json:"occurredAt"`
	CreatedAt  time.Time          `json:"createdAt"`
	RecordedBy *Actor             `json:"recordedBy"`
}

type CashMovementPage struct {
	Items    []CashMovement `json:"items"`
	Page     int64          `json:"page"`
	PageSize int64          `json:"pageSize"`
	Total    int64          `json:"total"`
}

// CashRegister counts cash only: card and external (wiRef) payments never change it.
type CashRegister struct {
	Receipts    string     `json:"receipts"`
	Refunds     string     `json:"refunds"`
	Withdrawals string     `json:"withdrawals"`
	Deposits    string     `json:"deposits"`
	Expected    string     `json:"expected"`
	To          *time.Time `json:"to"`
}
