package machinelogbook

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// Option customizes a Service.
type Option func(*Service)

// WithClock replaces the wall clock, which tests use to make running and
// finished jobs deterministic.
func WithClock(now func() time.Time) Option { return func(s *Service) { s.now = now } }

func NewService(pool *pgxpool.Pool, options ...Option) *Service {
	s := &Service{pool: pool, now: func() time.Time { return time.Now().UTC() }}
	for _, option := range options {
		option(s)
	}
	return s
}

type MachineType struct {
	ID                   uuid.UUID
	Name                 string
	Process              string
	Active               bool
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type Machine struct {
	ID                                uuid.UUID
	MachineType                       MachineType
	Name                              string
	Status                            MachineStatus
	ExternalIdentifier                *string
	AutomaticCollectionEnabled        bool
	LastIngestedAt                    *time.Time
	Version, JobCount, RuntimeSeconds int64
	FailureRate                       string
	CreatedAt, UpdatedAt              time.Time
}

type Organization struct {
	ID     uuid.UUID
	Name   string
	Kind   OrganizationKind
	Active bool
	OrganizationDetails
	MemberCount                   int64
	PricingGroup                  *PricingGroupSummary
	PricingGroupAssignmentVersion int64
	Version                       int64
	CreatedAt, UpdatedAt          time.Time
}

// OrganizationDetails holds the invoice address and contact; empty means not set.
type OrganizationDetails struct {
	AddressLine, PostalCode, Locality, CountryCode string
	ContactName, ContactEmail                      string
}

// OrganizationDetailsInput carries optional detail changes; nil keeps the stored value.
type OrganizationDetailsInput struct {
	AddressLine, PostalCode, Locality, CountryCode *string
	ContactName, ContactEmail                      *string
}

type OrganizationFilters struct {
	Search         string
	Active         *bool
	Kind           *OrganizationKind
	PricingGroupID *uuid.UUID
	Page, PageSize int
}

type OrganizationMember struct {
	PersonID    uuid.UUID
	DisplayName string
	AddedAt     time.Time
}

type OrganizationReference struct {
	ID   uuid.UUID
	Name string
}

type PricingGroupSummary struct {
	ID   uuid.UUID
	Name string
}

type BillingParty struct {
	ID                            uuid.UUID
	Kind                          PartyKind
	DisplayName                   string
	OrganizationKind              *OrganizationKind
	PricingGroup                  *PricingGroupSummary
	PricingGroupAssignmentVersion int64
	MemberOrganizations           []OrganizationReference
}

type Operator struct {
	PersonID    uuid.UUID
	DisplayName string
}

type PricingRule struct {
	ID, PricingGroupID uuid.UUID
	Kind               PricingRuleKind
	MachineTypeID      *uuid.UUID
	// MaterialTypeID, its name and MaterialUnit are set on material rules only;
	// the unit is the unit of the type.
	MaterialTypeID   *uuid.UUID
	MaterialTypeName *string
	MaterialUnit     *string
	// Measure and BlockSize are set on machine_measure rules: Rate is the price
	// per BlockSize units of the measure on machines of MachineTypeID.
	Measure   *string
	BlockSize *int32
	Rate      string
	Active    bool
	Version   int64
}

// MaterialType is the level material prices attach to (PLA, PETG, ...). All
// materials of a type and its pricing rules share the type's unit.
type MaterialType struct {
	ID                              uuid.UUID
	Name, Unit                      string
	Kind                            MaterialKind
	Processes                       []string
	Active                          bool
	MaterialCount, PricingRuleCount int64
	Version                         int64
	CreatedAt, UpdatedAt            time.Time
}

type PricingGroup struct {
	ID                   uuid.UUID
	Name                 string
	Description          *string
	Active, IsDefault    bool
	Rules                []PricingRule
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type Material struct {
	ID                                                 uuid.UUID
	Name, Unit                                         string
	Kind                                               MaterialKind
	MaterialTypeID                                     uuid.UUID
	MaterialTypeName                                   string
	ColorName, ColorHex                                *string
	Variant, Manufacturer, StorageLocation, Notes      *string
	SalePrice, PackageSize                             *string
	Active, Deletable                                  bool
	LowStockThreshold                                  *string
	FilamentDiameterMM                                 *string
	Quantity, AssignedQuantity, UnassignedQuantity     string
	InventoryValue, AverageUnitCost, RecentConsumption string
	StockState                                         StockState
	Version, InventoryVersion                          int64
	CreatedAt, UpdatedAt                               time.Time
}

type InventoryTransaction struct {
	ID, MaterialID                                          uuid.UUID
	Kind                                                    InventoryKind
	QuantityDelta, UnitAcquisitionCost, InventoryValueDelta string
	TotalPurchasePrice                                      *string
	OccurredAt, CreatedAt                                   time.Time
	Supplier, Note, AdjustmentReason, Reference             *string
	MachineJobID                                            *uuid.UUID
	MachineJobDisplayID                                     *string
	OrderID                                                 *uuid.UUID
	OrderReference                                          *string
	SpoolID, FromSpoolID, ToSpoolID                         *uuid.UUID
	SpoolDisplayID, FromSpoolDisplayID, ToSpoolDisplayID    *string
	FillNumber, FromFillNumber, ToFillNumber                *int32
	TransferQuantity                                        *string
	ActorName                                               *string
}

type InventoryMutationResult struct {
	Material    Material
	Transaction InventoryTransaction
}

type PartyReference struct {
	Kind PartyKind
	ID   uuid.UUID
}
type UsageInput struct {
	MaterialID           uuid.UUID
	SpoolID              *uuid.UUID
	Ownership            UsageOwnership
	ExternalMaterialName *string
	Quantity             string
	QuantityBasis        QuantityBasis
}

type PriceAdjustment struct {
	Kind          PriceAdjustmentKind
	Value, Reason string
	AdjustedAt    time.Time
}

// JobInput creates a job together with its first, manual run. Outcome "" or
// "unknown" records no outcome yet.
type JobInput struct {
	MachineID        uuid.UUID
	Title            *string
	StartsAt, EndsAt time.Time
	Customer         PartyReference
	OperatorPersonID uuid.UUID
	Outcome          JobOutcome
	Notes            *string
	PricingGroupID   *uuid.UUID
	Usages           []UsageInput
	Measures         RunMeasures
}

// JobUpdate carries the staff-editable facts of a job. The times, material and
// outcome of a job come from its runs; OutcomeOverride replaces the derived
// outcome and nil derives it again.
type JobUpdate struct {
	MachineID        uuid.UUID
	Title            *string
	Customer         PartyReference
	OperatorPersonID uuid.UUID
	Notes            *string
	PricingGroupID   *uuid.UUID
	OutcomeOverride  *RunOutcome
}

// ManualRunInput is a manually entered run. A nil Outcome records none yet.
type ManualRunInput struct {
	StartsAt, EndsAt time.Time
	Outcome          *RunOutcome
	Usages           []UsageInput
	Measures         RunMeasures
}

type JobFilters struct {
	Search                                        string
	MachineID, CustomerID, OperatorID, MaterialID *uuid.UUID
	Outcome                                       *JobOutcome
	From, To                                      *time.Time
	Page, PageSize                                int
}

type MachineJobUsage struct {
	ID                                   uuid.UUID
	MaterialID, SpoolID                  *uuid.UUID
	MaterialName, Unit, Quantity         string
	MaterialTypeID                       *uuid.UUID
	MaterialTypeName                     string
	Ownership                            UsageOwnership
	QuantityBasis                        QuantityBasis
	SpoolDisplayID                       *string
	FillNumber                           *int32
	EstimationMethod, CalculationVersion *string
	EstimateQuality                      *EstimateQuality
	ReportRevision                       *int64
	StaffCorrected                       bool
}

type ArtifactReference struct {
	ID                   uuid.UUID
	SHA256, ParserStatus string
}

type FilamentSpoolIdentifier struct {
	ID        uuid.UUID
	Kind      IdentifierKind
	Value     string
	CreatedAt time.Time
}

// FilamentSpool is a physical spool. Material, product, weights and
// identifiers describe its open fill; they are empty while no fill is open.
// SpoolMount locates the machine slot a spool is currently mounted in.
type SpoolMount struct {
	MachineID, SlotID     uuid.UUID
	MachineName, SlotName string
	InputUnitName         *string
}

type FilamentSpool struct {
	ID                                           uuid.UUID
	DisplayID                                    string
	Kind                                         SpoolKind
	Status                                       SpoolStatus
	Label                                        *string
	FillNumber                                   int32
	FillID, MaterialID                           *uuid.UUID
	FilledAt, ArchivedAt                         *time.Time
	MaterialName, MaterialTypeName, Unit         *string
	ColorName, ColorHex                          *string
	Manufacturer, ProductName                    *string
	InitialNetWeightG                            *string
	RemainingQuantity                            string
	TareWeightG                                  *string
	AcquiredOn                                   *time.Time
	AcquisitionReference, StorageLocation, Notes *string
	Lifecycle                                    SpoolLifecycle
	Mounted                                      bool
	MountedOn                                    *SpoolMount
	Identifiers                                  []FilamentSpoolIdentifier
	Fills                                        []FilamentSpoolFill
	Version                                      int64
	CreatedAt, UpdatedAt                         time.Time
}

// FilamentSpoolFill is a closed fill of a spool.
type FilamentSpoolFill struct {
	ID, MaterialID                      uuid.UUID
	FillNumber                          int32
	MaterialName                        string
	Manufacturer, ProductName           *string
	InitialNetWeightG, UsedG, LeftoverG string
	Outcome                             FillOutcome
	FilledAt, ClosedAt                  time.Time
	Identifiers                         []FilamentSpoolIdentifier
}

type FilamentSpoolInput struct {
	Kind                                         SpoolKind
	Label                                        string
	MaterialID                                   uuid.UUID
	InitialNetWeightG                            string
	StockMode                                    StockMode
	Supplier                                     *string
	TotalPrice                                   *string
	Manufacturer, ProductName, TareWeightG       *string
	AcquiredOn                                   *time.Time
	AcquisitionReference, StorageLocation, Notes *string
	OccurredAt                                   time.Time
	ExpectedInventoryVersion                     int64
	// Identifiers tag the first fill.
	Identifiers []NewSpoolIdentifier
}

type FilamentSpoolUpdate struct {
	ExpectedVersion                               int64
	Kind                                          *SpoolKind
	Label, Manufacturer, ProductName, TareWeightG *string
	AcquiredOn                                    *time.Time
	AcquisitionReference, StorageLocation, Notes  *string
	Lifecycle                                     SpoolLifecycle
}

type SpoolFilters struct {
	Search, Location, Manufacturer string
	Lifecycle                      SpoolLifecycle
	Kind                           SpoolKind
	MaterialID                     *uuid.UUID
	Statuses                       []SpoolStatus
	Mounted                        *bool
	Consumable                     bool
	Page, PageSize                 int
}

// LeftoverInput describes what is left on a fill that is being closed.
type LeftoverInput struct {
	Basis        LeftoverBasis
	GrossWeightG *string
	Disposition  *LeftoverDisposition
}

type NewFillInput struct {
	MaterialID                uuid.UUID
	Manufacturer, ProductName *string
	NetWeightG                string
	Source                    FillSource
	TotalPrice, Supplier      *string
}

type NewSpoolIdentifier struct {
	Kind  IdentifierKind
	Value string
}

type ChangeFillInput struct {
	Leftover          *LeftoverInput
	Fill              NewFillInput
	KeepIdentifierIDs []uuid.UUID
	NewIdentifiers    []NewSpoolIdentifier
	OccurredAt        time.Time
	ExpectedVersion   int64
}

type FinishSpoolInput struct {
	Leftover        LeftoverInput
	OccurredAt      time.Time
	ExpectedVersion int64
}

type CleanUpCandidate struct {
	ID         uuid.UUID
	DisplayID  string
	Label      *string
	ArchivedAt time.Time
}

type PricingSnapshotRule struct {
	SourceRuleID          *uuid.UUID
	Kind                  PricingRuleKind
	Label, Selector, Unit string
	Measure               *string
	BlockSize             *int32
	Rate                  *string
	Missing               bool
}

type PricingSnapshot struct {
	ID                         uuid.UUID
	Revision                   int
	PricingGroupName, Currency string
	Reason                     SnapshotReason
	Complete                   bool
	CalculatedAmount           *string
	Rules                      []PricingSnapshotRule
	CapturedAt                 time.Time
}

type MachineJob struct {
	ID                                uuid.UUID
	DisplayID                         string
	Title                             *string
	Artifact                          *ArtifactReference
	Status                            JobStatus
	Machine                           Machine
	Runs                              []MachineRun
	StartedAt, EndedAt, ExpectedEndAt *time.Time
	DurationSeconds                   int64
	Measures                          RunMeasures
	Customer                          *BillingParty
	Operator                          *Operator
	Outcome                           JobOutcome
	OutcomeOverridden                 bool
	Notes                             *string
	// Usages is the material of all runs that are not replaced. It feeds order
	// snapshots and is not part of the API representation.
	Usages                          []MachineJobUsage
	PricingStatus                   PricingStatus
	PricingSnapshot                 *PricingSnapshot
	CalculatedPrice, EffectivePrice *string
	PriceAdjustment                 *PriceAdjustment
	Version                         int64
	CreatedAt, UpdatedAt            time.Time
}

type StatisticPoint struct{ Key, Label, Value string }

type DailyActivity struct {
	Date time.Time
	Jobs int64
}

type Overview struct {
	JobsToday, JobsThisWeek, UnassignedJobs, FailedOrPartialThisWeek, LowStockItems int64
	UnassignedEstimatedAmount                                                       string
	RecentJobs                                                                      []MachineJob
	LowStockMaterials                                                               []Material
	Activity                                                                        []DailyActivity
	// The work-item fields are nil unless the caller may read machine jobs.
	RunningNow, NeedsOutcome, UnassignedRuns, BillingIssues, ActiveTotal *int64
	RunningMachineNames                                                  []string
	ActiveItems                                                          []WorkItem
}

type Statistics struct {
	MaterialUsageByType,
	MachineRuntimeHours,
	MachineJobCounts,
	AcquisitionCost,
	CustomerCharges,
	AdjustmentLoss,
	MachineFailureRates []StatisticPoint
	Totals,
	PreviousTotals StatisticTotals
	Months             []StatisticMonth
	RuntimeGranularity string
	Runtime            []StatisticRuntimePoint
	MaterialCostByType []StatisticPoint
	Machines           []StatisticMachine
}

type StatisticTotals struct {
	Jobs                                             int64
	RuntimeHours, Charges, MaterialCost, FailureRate string
}

type StatisticMonth struct{ Month, Charges, MaterialCost, Losses string }

type StatisticRuntimePoint struct {
	BucketStart time.Time
	MachineID   uuid.UUID
	Hours       string
}

type StatisticMachine struct {
	MachineID                                                               uuid.UUID
	Name, MachineTypeName, RuntimeHours, FailureRate, Charges, RuntimeShare string
	Jobs                                                                    int64
}

func pageBounds(page, pageSize int) (int32, int32, error) {
	if page < 1 || pageSize < 1 || pageSize > 100 {
		return 0, 0, apperror.Invalid("page must be positive and pageSize must be between 1 and 100")
	}
	return int32((page - 1) * pageSize), int32(pageSize), nil
}

func require(p authorization.Principal, permission authorization.Permission) error {
	if !p.Has(permission) {
		return apperror.PermissionDenied
	}
	return nil
}

func validateName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 200 {
		return "", apperror.Invalid("name must be between 1 and 200 characters")
	}
	return name, nil
}

func parseDecimal(value string, positive bool) (decimal.Decimal, error) {
	d, err := decimal.NewFromString(strings.TrimSpace(value))
	if err != nil || (positive && !d.IsPositive()) {
		return decimal.Zero, apperror.Invalid("invalid decimal value")
	}
	return d, nil
}

func numericFromDecimal(value decimal.Decimal) pgtype.Numeric {
	return pgtype.Numeric{Int: value.Coefficient(), Exp: value.Exponent(), Valid: true}
}

func numericFromString(value string, positive bool) (pgtype.Numeric, error) {
	d, err := parseDecimal(value, positive)
	if err != nil {
		return pgtype.Numeric{}, err
	}
	return numericFromDecimal(d), nil
}

func decimalFromNumeric(value pgtype.Numeric) decimal.Decimal {
	if !value.Valid || value.NaN || value.InfinityModifier != pgtype.Finite {
		return decimal.Zero
	}
	return decimal.NewFromBigInt(value.Int, value.Exp)
}

func decimalString(value pgtype.Numeric) string { return decimalFromNumeric(value).String() }

func nullableDecimal(value pgtype.Numeric) *string {
	if !value.Valid {
		return nil
	}
	v := decimalString(value)
	return &v
}

func nullableTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time
	return &v
}

func pgNullableNumeric(value *string, positive bool) (pgtype.Numeric, error) {
	if value == nil {
		return pgtype.Numeric{}, nil
	}
	return numericFromString(*value, positive)
}

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apperror.Conflicting("already_exists", "A conflicting resource already exists")
		case "23503", "23514":
			return apperror.Conflict
		}
	}
	return err
}

func noRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	return err
}

// accountPointer is the account behind a principal. Changes made by a machine
// connector run with an empty principal and have no account.
func accountPointer(p authorization.Principal) *uuid.UUID {
	if p.AccountID == uuid.Nil {
		return nil
	}
	account := p.AccountID
	return &account
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	action, resource string,
	id uuid.UUID,
	requestID *uuid.UUID,
	fields []string,
) error {
	event := audit.Event{
		ActorAccountID: accountPointer(p),
		Action:         action,
		ResourceType:   resource,
		ResourceID:     &id,
		RequestID:      requestID,
		ChangedFields:  fields,
	}
	if event.ActorAccountID == nil {
		event.ActorType = "system"
	}
	return audit.Write(ctx, tx, event)
}

func machineTypeFromRow(row machinelogbookdb.MachineType) MachineType {
	return MachineType{
		ID:        row.ID,
		Name:      row.Name,
		Active:    row.Active,
		Process:   row.Process,
		Version:   row.Version,
		CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt,
	}
}

func formatDisplayID(sequence int64, now time.Time) string {
	return fmt.Sprintf("J-%04d-%06d", now.UTC().Year(), sequence)
}

func formatRunDisplayID(sequence int64, at time.Time) string {
	return fmt.Sprintf("R-%04d-%06d", at.UTC().Year(), sequence)
}
