package workinggroups

import (
	"time"

	"github.com/google/uuid"
)

// Statuses of a project.
const (
	ProjectDraft     = "draft"
	ProjectSubmitted = "submitted"
	ProjectReturned  = "returned"
	ProjectDeclined  = "declined"
	ProjectWiRef     = "wiref"
	ProjectRunning   = "running"
	ProjectCompleted = "completed"

	PaidFromGroup    = "group"
	PaidFromExternal = "external"

	AdvanceAsked    = "asked"
	AdvanceReceived = "received"

	UnitStv     = "stv"
	UnitUV      = "uv"
	UnitReferat = "referat"

	MaxProjectItems       = 100
	MaxOffersPerItem      = 10
	MaxProjectListRows    = 200
	MinOffersForThreshold = 3
	MaxSignatureBytes     = 512 << 10
)

// ProjectFields are the editable fields of a project.
type ProjectFields struct {
	Title            string
	Goal             string
	Benefit          string
	StartsOn, EndsOn *time.Time
	People           int
	PlannedIncome    string
	Alcohol          bool
	AdvanceRequested bool
	AdvanceAmount    *string
}

// CreateProjectInput starts a project draft.
type CreateProjectInput struct {
	GroupID uuid.UUID
	ProjectFields
}

// UpdateProjectInput replaces the editable fields of a project.
type UpdateProjectInput struct {
	ExpectedVersion int64
	ProjectFields
}

// ProjectItemInput is a cost plan item. ExpectedVersion is checked when it is positive.
type ProjectItemInput struct {
	ExpectedVersion int64
	Text            string
	PlannedAmount   string
	Link, Note      *string
}

// ProjectOfferInput is an offer for a cost plan item.
type ProjectOfferInput struct {
	ExpectedVersion int64
	Shop, Price     string
}

// ProjectOffer is an offer of an item.
type ProjectOffer struct {
	ID      uuid.UUID
	Shop    string
	Price   string
	HasFile bool
}

// ProjectPurchase is the summary of a purchase that belongs to a project.
type ProjectPurchase struct {
	ID            uuid.UUID
	ItemID        *uuid.UUID
	Item          string
	Link          *string
	Quantity      int32
	UnitPrice     string
	Status        string
	HasAttachment bool
}

// ProjectItem is one line of the cost plan.
type ProjectItem struct {
	ID            uuid.UUID
	Position      int32
	Text          string
	PlannedAmount string
	Link, Note    *string
	NeedsOffers   bool
	ChosenOfferID *uuid.UUID
	Offers        []ProjectOffer
	Purchases     []ProjectPurchase
}

// ProjectChecklist is what is still open before a project can be handed in.
type ProjectChecklist struct {
	Complete bool
	Open     []string
}

// ProjectTotals are the sums of a project.
type ProjectTotals struct {
	Planned, InPurchases, Spent, Left string
}

// ProjectHistoryEntry is one status change or decision.
type ProjectHistoryEntry struct {
	Status string
	Actor  *Person
	Reason string
	At     time.Time
}

// RequestForm is the Projektantrag as it is stored with a project.
type RequestForm struct {
	UnitKind             string `json:"unitKind"`
	UnitName             string `json:"unitName"`
	Number               string `json:"number"`
	ProjectName          string `json:"projectName"`
	Alcohol              bool   `json:"alcohol"`
	StartsOn             string `json:"startsOn"`
	EndsOn               string `json:"endsOn"`
	People               int    `json:"people"`
	Advance              bool   `json:"advance"`
	Description          string `json:"description"`
	MaxExpenses          string `json:"maxExpenses"`
	MaxIncome            string `json:"maxIncome"`
	ResponsibleFirstName string `json:"responsibleFirstName"`
	ResponsibleLastName  string `json:"responsibleLastName"`
	Place                string `json:"place"`
	Date                 string `json:"date"`
}

// RequestFormInput overrides fields of the Projektantrag for one request; a nil field keeps the default.
type RequestFormInput struct {
	UnitKind, UnitName, ProjectName *string
	Alcohol                         *bool
	StartsOn, EndsOn, Date          *time.Time
	People                          *int
	Advance                         *bool
	Description                     *string
	MaxExpenses, MaxIncome          *string
	ResponsibleFirstName            *string
	ResponsibleLastName, Place      *string
	Signature                       []byte
	UseSavedSignature               bool
}

// RequestDefaults are the defaults of the Projektantrag kept in the finance rules.
type RequestDefaults struct {
	UnitKind          string
	UnitName          string
	AddGroupName      bool
	ResponsiblePerson *Person
	Place             string
}

// RequestDefaultsInput sets the defaults of the Projektantrag.
type RequestDefaultsInput struct {
	UnitKind            string
	UnitName            string
	AddGroupName        bool
	ResponsiblePersonID *uuid.UUID
	Place               string
}

// ApproveProjectInput approves a submitted project.
type ApproveProjectInput struct {
	ExpectedVersion int64
	PaidFrom        string
	Form            RequestFormInput
}

// ChosenOffer is the offer the wiRef chose for an item.
type ChosenOffer struct {
	ItemID, OfferID uuid.UUID
}

// WiRefDecisionInput records the decision of the wiRef.
type WiRefDecisionInput struct {
	ExpectedVersion int64
	Number          string
	ChosenOffers    []ChosenOffer
}

// Project is a bigger plan of a group with its cost plan.
type Project struct {
	ID, GroupID         uuid.UUID
	GroupName           string
	Title, Goal         string
	Benefit             string
	StartsOn, EndsOn    *time.Time
	People              int32
	PlannedIncome       string
	Alcohol             bool
	AdvanceRequested    bool
	AdvanceAmount       *string
	AdvanceStatus       *string
	PaidFrom            *string
	WiRefNumber         string
	Status              string
	Requester           *Person
	CompletionReport    string
	Totals              ProjectTotals
	WiRefNeeded         bool
	WiRefRequestPending bool
	HasRequestPDF       bool
	RequestForm         *RequestForm
	CanEdit             bool
	CanSubmit           bool
	CanDecide           bool
	CanComplete         bool
	Items               []ProjectItem
	Checklist           ProjectChecklist
	History             []ProjectHistoryEntry
	CreatedAt           time.Time
	Version             int64
}

// ProjectFilter narrows the project list.
type ProjectFilter struct {
	GroupID *uuid.UUID
	Status  *string
}
