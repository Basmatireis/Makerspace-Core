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

const currency = "EUR"

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

type MachineType struct {
	ID                   uuid.UUID
	Name                 string
	Active               bool
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type Machine struct {
	ID                                uuid.UUID
	MachineType                       MachineType
	Name, Status                      string
	ExternalIdentifier                *string
	AutomaticCollectionEnabled        bool
	LastIngestedAt                    *time.Time
	Version, JobCount, RuntimeSeconds int64
	FailureRate                       string
	CreatedAt, UpdatedAt              time.Time
}

type Organization struct {
	ID                            uuid.UUID
	Name, Kind                    string
	Active                        bool
	PricingGroup                  *PricingGroupSummary
	PricingGroupAssignmentVersion int64
	Version                       int64
	CreatedAt, UpdatedAt          time.Time
}

type PricingGroupSummary struct {
	ID   uuid.UUID
	Name string
}

type BillingParty struct {
	ID                            uuid.UUID
	Kind, DisplayName             string
	OrganizationKind              *string
	PricingGroup                  *PricingGroupSummary
	PricingGroupAssignmentVersion int64
}

type Operator struct {
	PersonID    uuid.UUID
	DisplayName string
}

type PricingRule struct {
	ID, PricingGroupID             uuid.UUID
	Kind                           string
	MachineTypeID                  *uuid.UUID
	MaterialCategory, MaterialUnit *string
	Rate                           string
	Active                         bool
	Version                        int64
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
	ID                                                           uuid.UUID
	Name, Category, Unit                                         string
	Color                                                        *string
	Active                                                       bool
	LowStockThreshold                                            *string
	Quantity, InventoryValue, AverageUnitCost, RecentConsumption string
	StockState                                                   string
	Version, InventoryVersion                                    int64
	CreatedAt, UpdatedAt                                         time.Time
}

type InventoryTransaction struct {
	ID, MaterialID                                                uuid.UUID
	Kind, QuantityDelta, UnitAcquisitionCost, InventoryValueDelta string
	TotalPurchasePrice                                            *string
	OccurredAt, CreatedAt                                         time.Time
	Supplier, Note, AdjustmentReason                              *string
	MachineJobID                                                  *uuid.UUID
	MachineJobDisplayID                                           *string
}

type InventoryMutationResult struct {
	Material    Material
	Transaction InventoryTransaction
}

type PartyReference struct {
	Kind string
	ID   uuid.UUID
}
type UsageInput struct {
	MaterialID uuid.UUID
	Quantity   string
}

type JobInput struct {
	MachineID        uuid.UUID
	StartsAt, EndsAt time.Time
	Customer         PartyReference
	OperatorPersonID uuid.UUID
	Outcome          string
	Notes            *string
	PricingGroupID   *uuid.UUID
	Usages           []UsageInput
}

type AutomaticJobInput struct {
	MachineID        uuid.UUID
	StartsAt, EndsAt time.Time
	ExternalID       string
	ExternalMetadata []byte
	Usages           []UsageInput
}

type JobFilters struct {
	Search                                        string
	MachineID, CustomerID, OperatorID, MaterialID *uuid.UUID
	Outcome, BillingStatus, Source, ReviewState   *string
	From, To                                      *time.Time
	Page, PageSize                                int
}

type MachineJobUsage struct {
	ID, MaterialID                         uuid.UUID
	MaterialName, Category, Unit, Quantity string
}

type PricingSnapshotRule struct {
	SourceRuleID                *uuid.UUID
	Kind, Label, Selector, Unit string
	Rate                        *string
	Missing                     bool
}

type PricingSnapshot struct {
	ID                                 uuid.UUID
	Revision                           int
	PricingGroupName, Currency, Reason string
	Complete                           bool
	CalculatedAmount                   *string
	Rules                              []PricingSnapshotRule
	CapturedAt                         time.Time
}

type MachineJob struct {
	ID                                          uuid.UUID
	DisplayID                                   string
	Machine                                     Machine
	StartsAt, EndsAt                            time.Time
	DurationSeconds                             int64
	Source                                      string
	ExternalID                                  *string
	ReviewState                                 string
	Customer                                    *BillingParty
	Operator                                    *Operator
	Outcome                                     string
	Notes                                       *string
	Usages                                      []MachineJobUsage
	PricingStatus                               string
	PricingSnapshot                             *PricingSnapshot
	CalculatedPrice, FinalPrice, EffectivePrice *string
	PriceOverrideReason                         *string
	PriceOverriddenAt                           *time.Time
	BillingStatus                               string
	BillingReference                            *string
	Version                                     int64
	CreatedAt, UpdatedAt                        time.Time
}

type StatisticPoint struct{ Key, Label, Value string }

type DailyActivity struct {
	Date time.Time
	Jobs int64
}

type Overview struct {
	JobsToday, JobsThisWeek, UnbilledJobs, NeedsReview, FailedOrPartialThisWeek, LowStockItems int64
	UnbilledAmount                                                                             string
	RecentJobs                                                                                 []MachineJob
	LowStockMaterials                                                                          []Material
	Activity                                                                                   []DailyActivity
}

type Statistics struct {
	MaterialUsageByCategory, MachineRuntimeHours, MachineJobCounts, AcquisitionCost, CustomerCharges, AdjustmentLoss, MachineFailureRates []StatisticPoint
}

func pageBounds(page, pageSize int) (int32, int32, error) {
	if page < 1 || pageSize < 1 || pageSize > 100 {
		return 0, 0, validation("page must be positive and pageSize must be between 1 and 100")
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
		return "", validation("name must be between 1 and 200 characters")
	}
	return name, nil
}

func cleanOptional(value *string) *string {
	if value == nil {
		return nil
	}
	v := strings.TrimSpace(*value)
	if v == "" {
		return nil
	}
	return &v
}

func newID() uuid.UUID { return uuid.Must(uuid.NewV7()) }

func parseDecimal(value string, positive bool) (decimal.Decimal, error) {
	d, err := decimal.NewFromString(strings.TrimSpace(value))
	if err != nil || (positive && !d.IsPositive()) {
		return decimal.Zero, validation("invalid decimal value")
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

func validation(message string) error     { return apperror.New(422, "validation_failed", message) }
func conflict(code, message string) error { return apperror.New(409, code, message) }

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return conflict("already_exists", "A conflicting resource already exists")
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

func writeAudit(ctx context.Context, tx pgx.Tx, p authorization.Principal, action, resource string, id uuid.UUID, requestID *uuid.UUID, fields []string) error {
	actor := p.AccountID
	return audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: action, ResourceType: resource, ResourceID: &id, RequestID: requestID, ChangedFields: fields})
}

func machineTypeFromRow(row machinelogbookdb.MachineType) MachineType {
	return MachineType{ID: row.ID, Name: row.Name, Active: row.Active, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func formatDisplayID(sequence int64, now time.Time) string {
	return fmt.Sprintf("J-%04d-%06d", now.UTC().Year(), sequence)
}
