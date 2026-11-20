package workinggroups

import (
	"time"

	"github.com/google/uuid"
)

// Money is carried as exact decimal text with two places ("12.50") between the database, this package and the API.

// Period is a budget period. Current is true for an open period that contains today in the makerspace time zone.
type Period struct {
	ID          uuid.UUID
	Name        string
	StartsOn    time.Time
	EndsOn      time.Time
	TotalAmount string
	// Income figures are for finance managers: what the cash register brought into this period.
	IncomeTotal, IncomeDeposited, IncomeBookedAhead string
	Closed                                          bool
	ClosedAt                                        *time.Time
	Current                                         bool
	Version                                         int64
	CreatedAt                                       time.Time
}

// PeriodInput creates a period; the shares of CopySharesFromPeriodID are copied when it is set.
type PeriodInput struct {
	Name                   string
	StartsOn               time.Time
	EndsOn                 time.Time
	TotalAmount            string
	CopySharesFromPeriodID *uuid.UUID
}

// PeriodUpdate changes the fields that are set.
type PeriodUpdate struct {
	ExpectedVersion int64
	Name            *string
	StartsOn        *time.Time
	EndsOn          *time.Time
	TotalAmount     *string
}

// GroupBudget is the figures of one group in one period. Free may be negative.
type GroupBudget struct {
	GroupID   uuid.UUID
	GroupName string
	Given     string
	Spent     string
	Reserved  string
	Free      string
}

// BudgetTotals are the figures of a whole period, only for finance managers. KeptBack and FreeSum may be negative.
type BudgetTotals struct {
	TotalAmount string
	GivenSum    string
	KeptBack    string
	SpentSum    string
	ReservedSum string
	FreeSum     string
}

// Budget is a period with the group figures the caller may see; Totals is nil for everybody but finance managers.
type Budget struct {
	Period Period
	Groups []GroupBudget
	Totals *BudgetTotals
}

// Purchase statuses and ways of buying.
const (
	PurchasePlanned  = "planned"
	PurchaseWanted   = "wanted"
	PurchaseApproved = "approved"
	PurchaseDeclined = "declined"
	PurchaseOrdered  = "ordered"
	PurchaseReceived = "received"
	PurchaseBought   = "bought"
	PurchaseRefunded = "refunded"

	HowSelf    = "self"
	HowCentral = "central"
)

// PurchaseFlags say what the caller may do with a purchase right now.
type PurchaseFlags struct {
	CanApprove       bool
	CanDecline       bool
	CanHandInReceipt bool
	CanMarkArrived   bool
	CanMarkRefunded  bool
	CanDelete        bool
}

// Purchase is one wished purchase of a group. ActualTotal is empty until a receipt was handed in.
type Purchase struct {
	ID             uuid.UUID
	GroupID        uuid.UUID
	GroupName      string
	PeriodID       uuid.UUID
	PeriodName     string
	PeriodClosed   bool
	Item           string
	Link           *string
	Quantity       int32
	UnitPrice      string
	EstimatedTotal string
	ActualTotal    *string
	How            string
	Status         string
	DeclineReason  *string
	Requester      *Person
	NeedsProject   bool
	HasAttachment  bool
	HasReceipt     bool
	OrderID        *uuid.UUID
	CreatedAt      time.Time
	ApprovedAt     *time.Time
	DeclinedAt     *time.Time
	OrderedAt      *time.Time
	ReceivedAt     *time.Time
	BoughtAt       *time.Time
	RefundedAt     *time.Time
	ProjectID      *uuid.UUID
	ProjectItemID  *uuid.UUID
	PurchaseFlags
	Version int64
}

// PurchaseFilter narrows the purchase list.
type PurchaseFilter struct {
	GroupID  *uuid.UUID
	PeriodID *uuid.UUID
	Status   *string
}

// PurchaseItemInput is one line of "Add purchases".
type PurchaseItemInput struct {
	Item      string
	Link      *string
	Quantity  int
	UnitPrice string
}

// CreatePurchasesInput adds several purchases of one group with one way of buying.
type CreatePurchasesInput struct {
	GroupID uuid.UUID
	How     string
	Items   []PurchaseItemInput
	// ProjectID adds the purchases to a project of the group (as planned purchases while it is not running).
	ProjectID     *uuid.UUID
	ProjectItemID *uuid.UUID
}

// FileUpload is an uploaded file: name and type as declared by the client, and its content.
type FileUpload struct {
	Filename    string
	ContentType string
	Data        []byte
}

// ReceiptInput hands in the receipt of a self purchase: the actual total and the receipt file.
type ReceiptInput struct {
	ExpectedVersion int64
	Amount          string
	File            FileUpload
}

// PurchaseOrder is a collective order of approved central purchases.
type PurchaseOrder struct {
	ID               uuid.UUID
	PeriodID         uuid.UUID
	Shop             string
	TotalAmount      string
	Status           string
	ProjectRequestID *uuid.UUID
	ProjectNumber    *string
	PurchaseIDs      []uuid.UUID
	HasInvoice       bool
	CreatedAt        time.Time
	ArrivedAt        *time.Time
	Version          int64
}

// CreateOrderInput places a collective order.
type CreateOrderInput struct {
	Shop             string
	PurchaseIDs      []uuid.UUID
	ProjectRequestID *uuid.UUID
}

// Booking is a cost booked directly against the budget of a group.
type Booking struct {
	ID        uuid.UUID
	GroupID   uuid.UUID
	GroupName string
	PeriodID  uuid.UUID
	Text      string
	Amount    string
	BookedOn  time.Time
	CreatedAt time.Time
}

// CreateBookingInput books a cost.
type CreateBookingInput struct {
	GroupID  uuid.UUID
	PeriodID uuid.UUID
	Text     string
	Amount   string
	BookedOn time.Time
}

// ProjectRequest is a standing project request ("Projektantrag") that large orders refer to.
type ProjectRequest struct {
	ID     uuid.UUID
	Number string
	Label  string
}

// FinanceRules are the thresholds and the standing project requests. OffersThreshold is only stored for now.
type FinanceRules struct {
	ProjectThreshold string
	OffersThreshold  string
	Request          RequestDefaults
	ProjectRequests  []ProjectRequest
	Version          int64
}

// FinanceRulesInput sets the thresholds.
type FinanceRulesInput struct {
	ExpectedVersion  int64
	ProjectThreshold string
	OffersThreshold  string
	Request          *RequestDefaultsInput
}
