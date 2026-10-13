package printing

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	printerconnectorsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printing/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

type Service struct {
	pool *pgxpool.Pool
	jobs *machinelogbook.Service
}

func NewService(pool *pgxpool.Pool, jobs *machinelogbook.Service) *Service {
	return &Service{pool: pool, jobs: jobs}
}

type InputUnit struct {
	ID, MachineID      uuid.UUID
	Name               string
	Position           int
	ExternalIdentifier *string
	Enabled            bool
	Version            int64
}
type Slot struct {
	ID, InputUnitID, MachineID uuid.UUID
	InputUnitName, Name        string
	Position                   int
	ExternalIdentifier         *string
	Status                     string
	AssignmentID, SpoolID      *uuid.UUID
	SpoolDisplayID             *string
	MountedAt                  *time.Time
	Version                    int64
}
type Profile struct {
	MachineID            uuid.UUID
	MachineName          string
	Enabled              bool
	InputUnits           []InputUnit
	Slots                []Slot
	Version              int64
	CreatedAt, UpdatedAt time.Time
}
type DeclarationInput struct {
	Ownership                                string
	MaterialID, SpoolID                      *uuid.UUID
	ExternalMaterialName, EstimatedQuantityG *string
}
type Declaration struct {
	ID uuid.UUID
	DeclarationInput
	MaterialName   string
	SpoolDisplayID *string
}
type PrinterEvent struct {
	ID                       uuid.UUID
	SourceID, EventKey, Kind string
	ProtocolVersion          int
	OccurredAt, ReceivedAt   time.Time
	Payload                  json.RawMessage
	ReconciliationState      string
}
type Attempt struct {
	ID, SubmissionID, MachineID    uuid.UUID
	AttemptNumber                  int
	MachineName, State             string
	MachineJobID                   *uuid.UUID
	AcceptedAt, StartedAt, EndedAt *time.Time
	Declarations                   []Declaration
	Events                         []PrinterEvent
	Version                        int64
	CreatedAt, UpdatedAt           time.Time
}
type Submission struct {
	ID, MachineID                        uuid.UUID
	DisplayID, MachineName, Title, State string
	Customer                             machinelogbook.PartyReference
	CustomerDisplayName                  *string
	Notes                                *string
	ReprintsSubmissionID                 *uuid.UUID
	Declarations                         []Declaration
	Attempts                             []Attempt
	Version                              int64
	CreatedAt, UpdatedAt                 time.Time
}
type SubmissionInput struct {
	MachineID            uuid.UUID
	Customer             machinelogbook.PartyReference
	Title                string
	Notes                *string
	ReprintsSubmissionID *uuid.UUID
	Declarations         []DeclarationInput
}
type EventInput struct {
	SourceID, EventKey, Kind string
	ProtocolVersion          int
	MachineID, AttemptID     *uuid.UUID
	OccurredAt               time.Time
	SourceSequence           *int64
	ExternalPrintID          *string
	Payload                  json.RawMessage
}

type ConnectorEventInput struct {
	EventID, ConnectorID, AssignmentID, MachineID uuid.UUID
	AttemptID, ObservedRunID                      *uuid.UUID
	ConfigurationVersion, Sequence                int64
	Kind                                          string
	OccurredAt                                    time.Time
	ExternalPrintID                               *string
	Payload                                       json.RawMessage
	ReportRevision                                *int64
	ApplicationState                              string
	ApplicationReason                             *string
}

func require(p authorization.Principal, permission authorization.Permission) error {
	if !p.Has(permission) {
		return apperror.PermissionDenied
	}
	return nil
}
func validation(message string) error     { return apperror.New(422, "validation_failed", message) }
func conflict(code, message string) error { return apperror.New(409, code, message) }
func noRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	return err
}
func dbError(err error) error {
	var e *pgconn.PgError
	if errors.As(err, &e) {
		if e.Code == "23505" {
			return conflict("already_exists", "A conflicting resource already exists")
		}
		if e.Code == "23503" || e.Code == "23514" {
			return apperror.Conflict
		}
	}
	return err
}
func newID() uuid.UUID { return uuid.Must(uuid.NewV7()) }
func clean(value *string) *string {
	if value == nil {
		return nil
	}
	v := strings.TrimSpace(*value)
	if v == "" {
		return nil
	}
	return &v
}
func nullableTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time
	return &v
}
func numeric(value *string) (pgtype.Numeric, error) {
	if value == nil {
		return pgtype.Numeric{}, nil
	}
	d, e := decimal.NewFromString(strings.TrimSpace(*value))
	if e != nil || !d.IsPositive() {
		return pgtype.Numeric{}, validation("quantity must be positive")
	}
	return pgtype.Numeric{Int: d.Coefficient(), Exp: d.Exponent(), Valid: true}, nil
}
func decimalString(value pgtype.Numeric) *string {
	if !value.Valid {
		return nil
	}
	d := decimal.NewFromBigInt(value.Int, value.Exp).String()
	return &d
}
func fingerprint(value any) string {
	raw, _ := json.Marshal(value)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func writeAudit(ctx context.Context, tx pgx.Tx, p authorization.Principal, action, resource string, id uuid.UUID, requestID *uuid.UUID, fields []string) error {
	actor := p.AccountID
	return audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: action, ResourceType: resource, ResourceID: &id, RequestID: requestID, ChangedFields: fields})
}

func inputUnit(row db.PrinterInputUnit) InputUnit {
	return InputUnit{ID: row.ID, MachineID: row.MachineID, Name: row.Name, Position: int(row.Position), ExternalIdentifier: row.ExternalIdentifier, Enabled: row.Enabled, Version: row.Version}
}
func slotFromGet(row db.GetPrinterSlotRow) Slot {
	return Slot{ID: row.ID, InputUnitID: row.InputUnitID, MachineID: row.MachineID, InputUnitName: row.InputUnitName, Name: row.Name, Position: int(row.Position), ExternalIdentifier: row.ExternalIdentifier, Status: row.Status, AssignmentID: row.AssignmentID, SpoolID: row.SpoolID, SpoolDisplayID: row.SpoolDisplayID, MountedAt: nullableTime(row.MountedAt), Version: row.Version}
}
func slotFromList(row db.ListPrinterSlotsRow) Slot {
	return Slot{ID: row.ID, InputUnitID: row.InputUnitID, MachineID: row.MachineID, InputUnitName: row.InputUnitName, Name: row.Name, Position: int(row.Position), ExternalIdentifier: row.ExternalIdentifier, Status: row.Status, AssignmentID: row.AssignmentID, SpoolID: row.SpoolID, SpoolDisplayID: row.SpoolDisplayID, MountedAt: nullableTime(row.MountedAt), Version: row.Version}
}

func (s *Service) GetProfile(ctx context.Context, p authorization.Principal, machineID uuid.UUID) (Profile, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return Profile{}, err
	}
	q := db.New(s.pool)
	row, err := q.GetPrinterProfile(ctx, machineID)
	if err != nil {
		return Profile{}, noRows(err)
	}
	units, err := q.ListPrinterInputUnits(ctx, machineID)
	if err != nil {
		return Profile{}, err
	}
	slots, err := q.ListPrinterSlots(ctx, machineID)
	if err != nil {
		return Profile{}, err
	}
	item := Profile{MachineID: row.MachineID, MachineName: row.MachineName, Enabled: row.Enabled, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, InputUnits: make([]InputUnit, 0, len(units)), Slots: make([]Slot, 0, len(slots))}
	for _, u := range units {
		item.InputUnits = append(item.InputUnits, inputUnit(u))
	}
	for _, sl := range slots {
		item.Slots = append(item.Slots, slotFromList(sl))
	}
	return item, nil
}

func (s *Service) ConfigureProfile(ctx context.Context, p authorization.Principal, machineID uuid.UUID, enabled bool, expected int64, requestID *uuid.UUID) (Profile, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Profile{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Profile{}, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM machines WHERE id=$1)", machineID).Scan(&exists); err != nil {
		return Profile{}, err
	}
	if !exists {
		return Profile{}, apperror.NotFound
	}
	row, err := db.New(tx).UpsertPrinterProfile(ctx, db.UpsertPrinterProfileParams{MachineID: machineID, Enabled: enabled, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Profile{}, apperror.StaleWrite
	}
	if err != nil {
		return Profile{}, dbError(err)
	}
	if err = writeAudit(ctx, tx, p, "printer_profile.configured", "machine", machineID, requestID, []string{"printerProfile", "enabled"}); err != nil {
		return Profile{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Profile{}, err
	}
	_ = row
	return s.GetProfile(ctx, p, machineID)
}

func (s *Service) CreateInputUnit(ctx context.Context, p authorization.Principal, machineID uuid.UUID, name string, position int, external *string, requestID *uuid.UUID) (InputUnit, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return InputUnit{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 || position < 0 {
		return InputUnit{}, validation("invalid input unit")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InputUnit{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	if _, err = q.GetPrinterProfile(ctx, machineID); err != nil {
		return InputUnit{}, noRows(err)
	}
	id := newID()
	row, err := q.CreatePrinterInputUnit(ctx, db.CreatePrinterInputUnitParams{ID: id, MachineID: machineID, Name: name, Position: int32(position), ExternalIdentifier: clean(external)})
	if err != nil {
		return InputUnit{}, dbError(err)
	}
	if err = writeAudit(ctx, tx, p, "printer_input_unit.created", "printer_input_unit", id, requestID, []string{"machineId", "name", "position"}); err != nil {
		return InputUnit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InputUnit{}, err
	}
	return inputUnit(row), nil
}

func (s *Service) CreateSlot(ctx context.Context, p authorization.Principal, inputUnitID uuid.UUID, name string, position int, status string, external *string, requestID *uuid.UUID) (Slot, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Slot{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 || position < 0 || (status != "available" && status != "unavailable" && status != "retired") {
		return Slot{}, validation("invalid printer slot")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Slot{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	if _, err = q.GetPrinterInputUnitForUpdate(ctx, inputUnitID); err != nil {
		return Slot{}, noRows(err)
	}
	id := newID()
	if _, err = q.CreatePrinterSlot(ctx, db.CreatePrinterSlotParams{ID: id, InputUnitID: inputUnitID, Name: name, Position: int32(position), ExternalIdentifier: clean(external), Status: status}); err != nil {
		return Slot{}, dbError(err)
	}
	if err = writeAudit(ctx, tx, p, "printer_slot.created", "printer_slot", id, requestID, []string{"inputUnitId", "name", "position", "status"}); err != nil {
		return Slot{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Slot{}, err
	}
	row, err := db.New(s.pool).GetPrinterSlot(ctx, id)
	return slotFromGet(row), err
}

func (s *Service) Mount(ctx context.Context, p authorization.Principal, slotID, spoolID uuid.UUID, requestID *uuid.UUID) (Slot, error) {
	if err := require(p, authorization.PrinterSlotsAssign); err != nil {
		return Slot{}, err
	}
	if err := require(p, authorization.MachinesRead); err != nil {
		return Slot{}, err
	}
	if err := require(p, authorization.InventoryRead); err != nil {
		return Slot{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Slot{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	slot, err := q.GetPrinterSlotForUpdate(ctx, slotID)
	if err != nil {
		return Slot{}, noRows(err)
	}
	if slot.Status != "available" {
		return Slot{}, conflict("slot_unavailable", "Printer slot is not available")
	}
	// A spool can be mounted while it is active and its open fill still holds stock.
	var lifecycle string
	if err = tx.QueryRow(ctx, "SELECT lifecycle FROM filament_spools WHERE id=$1 FOR UPDATE", spoolID).Scan(&lifecycle); err != nil {
		return Slot{}, noRows(err)
	}
	var remaining pgtype.Numeric
	if err = tx.QueryRow(ctx, `SELECT COALESCE(sum(CASE WHEN t.kind='spool_transfer' THEN CASE WHEN t.to_fill_id=f.id THEN t.transfer_quantity ELSE -t.transfer_quantity END ELSE t.quantity_delta END), 0)
		FROM filament_spool_fills f JOIN inventory_transactions t ON t.fill_id=f.id OR t.from_fill_id=f.id OR t.to_fill_id=f.id
		WHERE f.spool_id=$1 AND f.closed_at IS NULL`, spoolID).Scan(&remaining); err != nil {
		return Slot{}, err
	}
	if lifecycle != "active" || !remaining.Valid || !decimal.NewFromBigInt(remaining.Int, remaining.Exp).IsPositive() {
		return Slot{}, conflict("spool_unavailable", "Only active spools with an open, nonempty fill can be mounted")
	}
	if _, err = q.GetOpenAssignmentForSlot(ctx, slotID); err == nil {
		return Slot{}, conflict("slot_occupied", "Unmount the current spool before mounting another")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Slot{}, err
	}
	if _, err = q.GetOpenAssignmentForSpool(ctx, spoolID); err == nil {
		return Slot{}, conflict("spool_already_mounted", "Spool is already mounted")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Slot{}, err
	}
	actor := p.AccountID
	id := newID()
	if _, err = q.CreatePrinterSpoolAssignment(ctx, db.CreatePrinterSpoolAssignmentParams{ID: id, SlotID: slotID, SpoolID: spoolID, MountedAt: time.Now().UTC(), MountedByAccountID: &actor, Source: "manual"}); err != nil {
		return Slot{}, dbError(err)
	}
	if err = writeAudit(ctx, tx, p, "printer_slot.spool_mounted", "printer_slot", slotID, requestID, []string{"assignment", "spoolId"}); err != nil {
		return Slot{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Slot{}, err
	}
	row, err := db.New(s.pool).GetPrinterSlot(ctx, slotID)
	return slotFromGet(row), err
}

func (s *Service) Unmount(ctx context.Context, p authorization.Principal, slotID uuid.UUID, requestID *uuid.UUID) (Slot, error) {
	if err := require(p, authorization.PrinterSlotsAssign); err != nil {
		return Slot{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Slot{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	if _, err = q.GetPrinterSlotForUpdate(ctx, slotID); err != nil {
		return Slot{}, noRows(err)
	}
	assignment, err := q.GetOpenAssignmentForSlot(ctx, slotID)
	if err != nil {
		return Slot{}, noRows(err)
	}
	actor := p.AccountID
	if _, err = q.ClosePrinterSpoolAssignment(ctx, db.ClosePrinterSpoolAssignmentParams{UnmountedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}, UnmountedByAccountID: &actor, ID: assignment.ID}); err != nil {
		return Slot{}, err
	}
	if err = writeAudit(ctx, tx, p, "printer_slot.spool_unmounted", "printer_slot", slotID, requestID, []string{"assignment", "spoolId"}); err != nil {
		return Slot{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Slot{}, err
	}
	row, err := db.New(s.pool).GetPrinterSlot(ctx, slotID)
	return slotFromGet(row), err
}

func validateDeclarations(items []DeclarationInput) error {
	for _, d := range items {
		if d.Ownership == "makerspace" {
			if d.MaterialID == nil || d.ExternalMaterialName != nil {
				return validation("makerspace declaration requires a material")
			}
		} else if d.Ownership == "external" {
			if d.SpoolID != nil || clean(d.ExternalMaterialName) == nil {
				return validation("external declaration requires a description")
			}
		} else {
			return validation("invalid filament ownership")
		}
		if _, err := numeric(d.EstimatedQuantityG); err != nil {
			return err
		}
	}
	return nil
}
func declaration(row db.ListPrintFilamentDeclarationsRow) Declaration {
	return Declaration{ID: row.ID, DeclarationInput: DeclarationInput{Ownership: row.Ownership, MaterialID: row.MaterialID, SpoolID: row.SpoolID, ExternalMaterialName: row.ExternalMaterialName, EstimatedQuantityG: decimalString(row.EstimatedQuantityG)}, MaterialName: row.MaterialName, SpoolDisplayID: row.SpoolDisplayID}
}

func (s *Service) insertDeclarations(ctx context.Context, q *db.Queries, submissionID, attemptID *uuid.UUID, items []DeclarationInput) error {
	for _, item := range items {
		estimated, err := numeric(item.EstimatedQuantityG)
		if err != nil {
			return err
		}
		if item.SpoolID != nil {
			// Declarations no longer carry a database-level spool/material pair, so
			// the open fill of the spool must hold the declared material.
			fillMaterial, fillErr := q.GetSpoolOpenFillMaterial(ctx, *item.SpoolID)
			if errors.Is(fillErr, pgx.ErrNoRows) || (fillErr == nil && (item.MaterialID == nil || fillMaterial != *item.MaterialID)) {
				return conflict("spool_material_mismatch", "The spool's open fill does not hold the declared material")
			}
			if fillErr != nil {
				return fillErr
			}
		}
		if _, err = q.CreatePrintFilamentDeclaration(ctx, db.CreatePrintFilamentDeclarationParams{ID: newID(), SubmissionID: submissionID, AttemptID: attemptID, Ownership: item.Ownership, MaterialID: item.MaterialID, SpoolID: item.SpoolID, ExternalMaterialName: clean(item.ExternalMaterialName), EstimatedQuantityG: estimated}); err != nil {
			return dbError(err)
		}
	}
	return nil
}

func (s *Service) CreateSubmission(ctx context.Context, p authorization.Principal, input SubmissionInput, requestID *uuid.UUID) (Submission, error) {
	if err := require(p, authorization.PrintSubmissionsManage); err != nil {
		return Submission{}, err
	}
	if err := require(p, authorization.MachinesRead); err != nil {
		return Submission{}, err
	}
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" || len(input.Title) > 200 {
		return Submission{}, validation("title is required")
	}
	if err := validateDeclarations(input.Declarations); err != nil {
		return Submission{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Submission{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	profile, err := q.GetPrinterProfile(ctx, input.MachineID)
	if err != nil {
		return Submission{}, noRows(err)
	}
	if !profile.Enabled {
		return Submission{}, conflict("printer_disabled", "Printer profile is disabled")
	}
	var personID, organizationID *uuid.UUID
	if input.Customer.ID != uuid.Nil {
		if input.Customer.Kind == "person" {
			personID = &input.Customer.ID
		} else if input.Customer.Kind == "organization" {
			organizationID = &input.Customer.ID
		} else {
			return Submission{}, validation("invalid customer")
		}
	}
	sequence, err := q.NextPrintSubmissionSequence(ctx)
	if err != nil {
		return Submission{}, err
	}
	id := newID()
	actor := p.AccountID
	_, err = q.CreatePrintSubmission(ctx, db.CreatePrintSubmissionParams{ID: id, DisplayID: fmt.Sprintf("PS-%04d-%06d", time.Now().UTC().Year(), sequence), MachineID: input.MachineID, CustomerPersonID: personID, CustomerOrganizationID: organizationID, Title: input.Title, Notes: clean(input.Notes), ReprintsSubmissionID: input.ReprintsSubmissionID, CreatedByAccountID: &actor})
	if err != nil {
		return Submission{}, dbError(err)
	}
	if err = s.insertDeclarations(ctx, q, &id, nil, input.Declarations); err != nil {
		return Submission{}, err
	}
	if err = writeAudit(ctx, tx, p, "print_submission.created", "print_submission", id, requestID, []string{"machineId", "customer", "title", "declarations"}); err != nil {
		return Submission{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Submission{}, err
	}
	return s.loadSubmission(ctx, id)
}

func eventFromRow(row db.PrinterEvent) PrinterEvent {
	return PrinterEvent{ID: row.ID, SourceID: row.SourceID, EventKey: row.EventKey, ProtocolVersion: int(row.ProtocolVersion), Kind: row.Kind, OccurredAt: row.OccurredAt, ReceivedAt: row.ReceivedAt, Payload: row.Payload, ReconciliationState: row.ReconciliationState}
}

func connectorEventFromRow(row printerconnectorsdb.PrinterEvent) PrinterEvent {
	return PrinterEvent{ID: row.ID, SourceID: row.SourceID, EventKey: row.EventKey, ProtocolVersion: int(row.ProtocolVersion), Kind: row.Kind, OccurredAt: row.OccurredAt, ReceivedAt: row.ReceivedAt, Payload: row.Payload, ReconciliationState: row.ReconciliationState}
}
func (s *Service) loadAttempt(ctx context.Context, q *db.Queries, row db.GetPrintAttemptRow) (Attempt, error) {
	d, err := q.ListPrintFilamentDeclarations(ctx, db.ListPrintFilamentDeclarationsParams{AttemptID: &row.ID})
	if err != nil {
		return Attempt{}, err
	}
	events, err := q.ListPrinterEventsForAttempt(ctx, &row.ID)
	if err != nil {
		return Attempt{}, err
	}
	item := Attempt{ID: row.ID, SubmissionID: row.SubmissionID, AttemptNumber: int(row.AttemptNumber), MachineID: row.MachineID, MachineName: row.MachineName, State: row.State, MachineJobID: row.MachineJobID, AcceptedAt: nullableTime(row.AcceptedAt), StartedAt: nullableTime(row.StartedAt), EndedAt: nullableTime(row.EndedAt), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Declarations: make([]Declaration, 0, len(d)), Events: make([]PrinterEvent, 0, len(events))}
	for _, v := range d {
		item.Declarations = append(item.Declarations, declaration(v))
	}
	for _, v := range events {
		item.Events = append(item.Events, eventFromRow(v))
	}
	return item, nil
}
func (s *Service) loadSubmission(ctx context.Context, id uuid.UUID) (Submission, error) {
	q := db.New(s.pool)
	row, err := q.GetPrintSubmission(ctx, id)
	if err != nil {
		return Submission{}, noRows(err)
	}
	decls, err := q.ListPrintFilamentDeclarations(ctx, db.ListPrintFilamentDeclarationsParams{SubmissionID: &id})
	if err != nil {
		return Submission{}, err
	}
	attempts, err := q.ListPrintAttempts(ctx, id)
	if err != nil {
		return Submission{}, err
	}
	item := Submission{ID: row.ID, DisplayID: row.DisplayID, MachineID: row.MachineID, MachineName: row.MachineName, Title: row.Title, Notes: row.Notes, State: row.State, ReprintsSubmissionID: row.ReprintsSubmissionID, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Declarations: make([]Declaration, 0, len(decls)), Attempts: make([]Attempt, 0, len(attempts))}
	if row.CustomerPersonID != nil {
		item.Customer = machinelogbook.PartyReference{Kind: "person", ID: *row.CustomerPersonID}
		if row.CustomerFirstName != nil && row.CustomerLastName != nil {
			name := strings.TrimSpace(*row.CustomerFirstName + " " + *row.CustomerLastName)
			item.CustomerDisplayName = &name
		}
	} else if row.CustomerOrganizationID != nil {
		item.Customer = machinelogbook.PartyReference{Kind: "organization", ID: *row.CustomerOrganizationID}
		item.CustomerDisplayName = row.CustomerOrganizationName
	}
	for _, v := range decls {
		item.Declarations = append(item.Declarations, declaration(v))
	}
	for _, v := range attempts {
		attemptRow, loadErr := q.GetPrintAttempt(ctx, v.ID)
		if loadErr != nil {
			return Submission{}, loadErr
		}
		attempt, loadErr := s.loadAttempt(ctx, q, attemptRow)
		if loadErr != nil {
			return Submission{}, loadErr
		}
		item.Attempts = append(item.Attempts, attempt)
	}
	return item, nil
}
func (s *Service) GetSubmission(ctx context.Context, p authorization.Principal, id uuid.UUID) (Submission, error) {
	if err := require(p, authorization.PrintSubmissionsRead); err != nil {
		return Submission{}, err
	}
	return s.loadSubmission(ctx, id)
}
func (s *Service) ListSubmissions(ctx context.Context, p authorization.Principal, search, state string, machineID *uuid.UUID, page, pageSize int) ([]Submission, int64, error) {
	if err := require(p, authorization.PrintSubmissionsRead); err != nil {
		return nil, 0, err
	}
	if page < 1 || pageSize < 1 || pageSize > 100 {
		return nil, 0, validation("invalid pagination")
	}
	q := db.New(s.pool)
	params := db.ListPrintSubmissionsParams{Search: strings.TrimSpace(search), State: state, MachineID: machineID, PageOffset: int32((page - 1) * pageSize), PageLimit: int32(pageSize)}
	rows, err := q.ListPrintSubmissions(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountPrintSubmissions(ctx, db.CountPrintSubmissionsParams{Search: params.Search, State: state, MachineID: machineID})
	if err != nil {
		return nil, 0, err
	}
	items := make([]Submission, 0, len(rows))
	for _, row := range rows {
		item, loadErr := s.loadSubmission(ctx, row.ID)
		if loadErr != nil {
			return nil, 0, loadErr
		}
		items = append(items, item)
	}
	return items, total, nil
}

func (s *Service) CreateAttempt(ctx context.Context, p authorization.Principal, submissionID, machineID, operationKey uuid.UUID, expected int64, requestID *uuid.UUID) (Attempt, bool, error) {
	if err := require(p, authorization.PrintSubmissionsManage); err != nil {
		return Attempt{}, false, err
	}
	fp := fingerprint(struct {
		SubmissionID, MachineID uuid.UUID
		Expected                int64
	}{submissionID, machineID, expected})
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Attempt{}, false, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", operationKey.String()); err != nil {
		return Attempt{}, false, err
	}
	operation, err := q.GetPrintingOperation(ctx, operationKey)
	if err == nil {
		if operation.ActorAccountID != p.AccountID || operation.Kind != "attempt_create" || operation.Fingerprint != fp {
			return Attempt{}, false, conflict("idempotency_conflict", "Operation key was reused with different input")
		}
		if err = tx.Commit(ctx); err != nil {
			return Attempt{}, false, err
		}
		row, err := db.New(s.pool).GetPrintAttempt(ctx, operation.ResultID)
		if err != nil {
			return Attempt{}, false, err
		}
		item, err := s.loadAttempt(ctx, db.New(s.pool), row)
		return item, false, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Attempt{}, false, err
	}
	submission, err := q.GetPrintSubmissionForUpdate(ctx, submissionID)
	if err != nil {
		return Attempt{}, false, noRows(err)
	}
	if submission.Version != expected {
		return Attempt{}, false, apperror.StaleWrite
	}
	if submission.State == "completed" || submission.State == "cancelled" {
		return Attempt{}, false, conflict("submission_terminal", "Submission cannot start another attempt")
	}
	if _, err = q.GetPrinterProfile(ctx, machineID); err != nil {
		return Attempt{}, false, noRows(err)
	}
	number, err := q.NextPrintAttemptNumber(ctx, submissionID)
	if err != nil {
		return Attempt{}, false, err
	}
	id := newID()
	if _, err = q.CreatePrintAttempt(ctx, db.CreatePrintAttemptParams{ID: id, SubmissionID: submissionID, AttemptNumber: number, MachineID: machineID}); err != nil {
		return Attempt{}, false, dbError(err)
	}
	decls, err := q.ListPrintFilamentDeclarations(ctx, db.ListPrintFilamentDeclarationsParams{SubmissionID: &submissionID})
	if err != nil {
		return Attempt{}, false, err
	}
	for _, d := range decls {
		if err = s.insertDeclarations(ctx, q, nil, &id, []DeclarationInput{{Ownership: d.Ownership, MaterialID: d.MaterialID, SpoolID: d.SpoolID, ExternalMaterialName: d.ExternalMaterialName, EstimatedQuantityG: decimalString(d.EstimatedQuantityG)}}); err != nil {
			return Attempt{}, false, err
		}
	}
	if _, err = q.UpdatePrintSubmission(ctx, db.UpdatePrintSubmissionParams{Title: submission.Title, Notes: submission.Notes, State: "in_progress", ID: submissionID, ExpectedVersion: expected}); err != nil {
		return Attempt{}, false, err
	}
	if _, err = q.InsertPrintingOperation(ctx, db.InsertPrintingOperationParams{OperationKey: operationKey, ActorAccountID: p.AccountID, Kind: "attempt_create", Fingerprint: fp, ResultID: id}); err != nil {
		return Attempt{}, false, dbError(err)
	}
	if err = writeAudit(ctx, tx, p, "print_attempt.created", "print_attempt", id, requestID, []string{"submissionId", "machineId", "state"}); err != nil {
		return Attempt{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Attempt{}, false, err
	}
	row, err := db.New(s.pool).GetPrintAttempt(ctx, id)
	if err != nil {
		return Attempt{}, false, err
	}
	item, err := s.loadAttempt(ctx, db.New(s.pool), row)
	return item, true, err
}

func transitionAllowed(from, to string) bool {
	switch from {
	case "queued":
		return to == "accepted" || to == "printing" || to == "failed" || to == "cancelled"
	case "accepted":
		return to == "printing" || to == "failed" || to == "cancelled"
	case "printing":
		return to == "completed" || to == "failed" || to == "cancelled"
	}
	return false
}
func (s *Service) TransitionAttempt(ctx context.Context, p authorization.Principal, id uuid.UUID, state string, expected int64, requestID *uuid.UUID) (Attempt, error) {
	if err := require(p, authorization.PrintSubmissionsManage); err != nil {
		return Attempt{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Attempt{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	current, err := q.GetPrintAttemptForUpdate(ctx, id)
	if err != nil {
		return Attempt{}, noRows(err)
	}
	if current.Version != expected {
		return Attempt{}, apperror.StaleWrite
	}
	if !transitionAllowed(current.State, state) {
		return Attempt{}, conflict("invalid_attempt_transition", "Attempt state transition is not allowed")
	}
	now := time.Now().UTC()
	accepted, started, ended := current.AcceptedAt, current.StartedAt, current.EndedAt
	if (state == "accepted" || state == "printing") && !accepted.Valid {
		accepted = pgtype.Timestamptz{Time: now, Valid: true}
	}
	if state == "printing" && !started.Valid {
		started = pgtype.Timestamptz{Time: now, Valid: true}
	}
	if state == "completed" || state == "failed" || state == "cancelled" {
		ended = pgtype.Timestamptz{Time: now, Valid: true}
	}
	if _, err = q.UpdatePrintAttemptState(ctx, db.UpdatePrintAttemptStateParams{State: state, AcceptedAt: accepted, StartedAt: started, EndedAt: ended, ID: id, ExpectedVersion: expected}); err != nil {
		return Attempt{}, dbError(err)
	}
	submission, err := q.GetPrintSubmissionForUpdate(ctx, current.SubmissionID)
	if err != nil {
		return Attempt{}, err
	}
	submissionState := "in_progress"
	if state == "completed" {
		submissionState = "completed"
	} else if state == "failed" || state == "cancelled" {
		submissionState = "failed"
	}
	if _, err = q.UpdatePrintSubmission(ctx, db.UpdatePrintSubmissionParams{Title: submission.Title, Notes: submission.Notes, State: submissionState, ID: submission.ID, ExpectedVersion: submission.Version}); err != nil {
		return Attempt{}, err
	}
	if err = writeAudit(ctx, tx, p, "print_attempt.transitioned", "print_attempt", id, requestID, []string{"state", "timestamps"}); err != nil {
		return Attempt{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Attempt{}, err
	}
	row, err := db.New(s.pool).GetPrintAttempt(ctx, id)
	if err != nil {
		return Attempt{}, err
	}
	return s.loadAttempt(ctx, db.New(s.pool), row)
}

func (s *Service) LinkAttemptJob(ctx context.Context, p authorization.Principal, attemptID, jobID uuid.UUID, expected int64, requestID *uuid.UUID) (Attempt, error) {
	if err := require(p, authorization.PrintSubmissionsManage); err != nil {
		return Attempt{}, err
	}
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return Attempt{}, err
	}
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return Attempt{}, err
	}
	job, err := s.jobs.GetJob(ctx, p, jobID)
	if err != nil {
		return Attempt{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Attempt{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	attempt, err := q.GetPrintAttemptForUpdate(ctx, attemptID)
	if err != nil {
		return Attempt{}, noRows(err)
	}
	if attempt.Version != expected {
		return Attempt{}, apperror.StaleWrite
	}
	if attempt.MachineID != job.Machine.ID {
		return Attempt{}, conflict("attempt_job_machine_mismatch", "Machine job belongs to another printer")
	}
	if _, err = q.LinkPrintAttemptJob(ctx, db.LinkPrintAttemptJobParams{MachineJobID: &jobID, ID: attemptID, ExpectedVersion: expected}); err != nil {
		return Attempt{}, dbError(err)
	}
	if err = writeAudit(ctx, tx, p, "print_attempt.job_linked", "print_attempt", attemptID, requestID, []string{"machineJobId"}); err != nil {
		return Attempt{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Attempt{}, err
	}
	row, err := db.New(s.pool).GetPrintAttempt(ctx, attemptID)
	if err != nil {
		return Attempt{}, err
	}
	return s.loadAttempt(ctx, db.New(s.pool), row)
}

func (s *Service) IngestEvent(ctx context.Context, input EventInput) (PrinterEvent, bool, error) {
	input.SourceID = strings.TrimSpace(input.SourceID)
	input.EventKey = strings.TrimSpace(input.EventKey)
	if input.SourceID == "" || input.EventKey == "" || input.ProtocolVersion < 1 || input.OccurredAt.IsZero() {
		return PrinterEvent{}, false, validation("invalid printer event")
	}
	switch input.Kind {
	case "identity", "connectivity", "operational_state", "progress", "slot_observation", "consumption_report", "terminal_outcome":
	default:
		return PrinterEvent{}, false, validation("invalid printer event kind")
	}
	fp := fingerprint(input)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PrinterEvent{}, false, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", input.SourceID+"\n"+input.EventKey); err != nil {
		return PrinterEvent{}, false, err
	}
	existing, err := q.GetPrinterEventByKey(ctx, db.GetPrinterEventByKeyParams{SourceID: input.SourceID, EventKey: input.EventKey})
	if err == nil {
		if existing.Fingerprint != fp {
			return PrinterEvent{}, false, conflict("printer_event_mismatch", "Event key was reused with different facts")
		}
		if err = tx.Commit(ctx); err != nil {
			return PrinterEvent{}, false, err
		}
		return eventFromRow(existing), false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return PrinterEvent{}, false, err
	}
	state := "not_applicable"
	if input.Kind == "consumption_report" {
		state = "pending"
	}
	id := newID()
	row, err := q.InsertPrinterEvent(ctx, db.InsertPrinterEventParams{ID: id, SourceID: strings.TrimSpace(input.SourceID), EventKey: strings.TrimSpace(input.EventKey), Fingerprint: fp, ProtocolVersion: int32(input.ProtocolVersion), MachineID: input.MachineID, AttemptID: input.AttemptID, Kind: input.Kind, OccurredAt: input.OccurredAt.UTC(), SourceSequence: input.SourceSequence, ExternalPrintID: clean(input.ExternalPrintID), Payload: input.Payload, ReconciliationState: state})
	if err != nil {
		return PrinterEvent{}, false, dbError(err)
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "printer_event.ingested", ResourceType: "printer_event", ResourceID: &id, ChangedFields: []string{"kind", "state"}, Source: "system"}); err != nil {
		return PrinterEvent{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PrinterEvent{}, false, err
	}
	return eventFromRow(row), true, nil
}

// IngestConnectorEvent is the transaction-aware connector boundary. The caller
// validates and locks connector ownership in the same transaction before using
// this method, so event receipt, authorization, and audit cannot commit apart.
func (s *Service) IngestConnectorEvent(ctx context.Context, tx pgx.Tx, input ConnectorEventInput) (PrinterEvent, bool, error) {
	if input.EventID == uuid.Nil || input.ConnectorID == uuid.Nil || input.AssignmentID == uuid.Nil || input.MachineID == uuid.Nil ||
		input.ConfigurationVersion < 1 || input.Sequence < 1 || input.OccurredAt.IsZero() || len(input.Payload) == 0 || len(input.Payload) > 32768 {
		return PrinterEvent{}, false, validation("invalid printer event")
	}
	switch input.Kind {
	case "identity", "connectivity", "operational_state", "progress", "slot_observation", "consumption_report", "terminal_outcome":
	default:
		return PrinterEvent{}, false, validation("invalid printer event kind")
	}
	var payloadObject map[string]any
	if json.Unmarshal(input.Payload, &payloadObject) != nil || payloadObject == nil {
		return PrinterEvent{}, false, validation("printer event payload must be a JSON object")
	}
	if input.ApplicationState != "applied" && input.ApplicationState != "review_required" && input.ApplicationState != "recorded" {
		return PrinterEvent{}, false, validation("invalid printer event application state")
	}
	if input.Kind == "consumption_report" {
		if input.ReportRevision == nil || *input.ReportRevision < 1 {
			return PrinterEvent{}, false, validation("consumption reports require a positive report revision")
		}
	} else if input.ReportRevision != nil {
		return PrinterEvent{}, false, validation("only consumption reports may have a report revision")
	}
	sourceID := "printer-connector:" + input.AssignmentID.String()
	eventKey := input.EventID.String()
	fp := fingerprint(struct {
		EventID, AssignmentID, MachineID uuid.UUID
		AttemptID, ObservedRunID         *uuid.UUID
		ConfigurationVersion, Sequence   int64
		Kind                             string
		OccurredAt                       time.Time
		ExternalPrintID                  *string
		Payload                          json.RawMessage
		ReportRevision                   *int64
	}{input.EventID, input.AssignmentID, input.MachineID, input.AttemptID, input.ObservedRunID, input.ConfigurationVersion, input.Sequence, input.Kind, input.OccurredAt.UTC(), clean(input.ExternalPrintID), input.Payload, input.ReportRevision})
	q := printerconnectorsdb.New(tx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", sourceID+"\n"+eventKey); err != nil {
		return PrinterEvent{}, false, err
	}
	existing, err := q.GetConnectorEventByKey(ctx, printerconnectorsdb.GetConnectorEventByKeyParams{SourceID: sourceID, EventKey: eventKey})
	if err == nil {
		if existing.Fingerprint != fp {
			return PrinterEvent{}, false, conflict("printer_event_mismatch", "Event ID was reused with different facts")
		}
		return connectorEventFromRow(existing), false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return PrinterEvent{}, false, err
	}
	bySequence, err := q.GetConnectorEventBySequence(ctx, printerconnectorsdb.GetConnectorEventBySequenceParams{AssignmentID: &input.AssignmentID, SourceSequence: &input.Sequence})
	if err == nil {
		if bySequence.EventKey == eventKey && bySequence.Fingerprint == fp {
			return connectorEventFromRow(bySequence), false, nil
		}
		return PrinterEvent{}, false, conflict("printer_event_sequence_conflict", "Event sequence was reused with different facts")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return PrinterEvent{}, false, err
	}
	reconciliation := "not_applicable"
	if input.Kind == "consumption_report" {
		reconciliation = "pending"
	}
	row, err := q.InsertConnectorEvent(ctx, printerconnectorsdb.InsertConnectorEventParams{ID: input.EventID, SourceID: sourceID, EventKey: eventKey, Fingerprint: fp, ProtocolVersion: 1, MachineID: &input.MachineID, AttemptID: input.AttemptID, Kind: input.Kind, OccurredAt: input.OccurredAt.UTC(), SourceSequence: &input.Sequence, ExternalPrintID: clean(input.ExternalPrintID), Payload: input.Payload, ReconciliationState: reconciliation, ConnectorID: &input.ConnectorID, AssignmentID: &input.AssignmentID, ObservedRunID: input.ObservedRunID, ConfigurationVersion: &input.ConfigurationVersion, ApplicationState: input.ApplicationState, ApplicationReason: input.ApplicationReason, ReportRevision: input.ReportRevision})
	if err != nil {
		return PrinterEvent{}, false, dbError(err)
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "printer_event.ingested", ResourceType: "printer_event", ResourceID: &input.EventID, ChangedFields: []string{"kind", "state"}, Source: "http"}); err != nil {
		return PrinterEvent{}, false, err
	}
	return connectorEventFromRow(row), true, nil
}

// ApplyConnectorAttemptEvent advances an explicitly linked Print Attempt using
// an event already validated in the caller's transaction. It never creates an
// Attempt or MachineJob, and terminal/out-of-order events cannot move state
// backwards.
func (s *Service) ApplyConnectorAttemptEvent(ctx context.Context, tx pgx.Tx, attemptID, machineID uuid.UUID, kind string, payload json.RawMessage, occurredAt time.Time) error {
	q := db.New(tx)
	current, err := q.GetPrintAttemptForUpdate(ctx, attemptID)
	if err != nil {
		return noRows(err)
	}
	if current.MachineID != machineID {
		return conflict("printer_attempt_machine_mismatch", "Linked Print Attempt belongs to another machine")
	}
	target := ""
	switch kind {
	case "progress":
		target = "printing"
	case "operational_state":
		var state struct {
			State string `json:"state"`
		}
		if json.Unmarshal(payload, &state) == nil && state.State == "printing" {
			target = "printing"
		}
	case "terminal_outcome":
		var outcome struct {
			Outcome string `json:"outcome"`
		}
		if json.Unmarshal(payload, &outcome) != nil {
			return validation("terminal outcome payload is invalid")
		}
		switch outcome.Outcome {
		case "completed", "failed", "cancelled":
			target = outcome.Outcome
		default:
			return validation("terminal outcome is invalid")
		}
	}
	if target == "" || current.State == target || current.State == "completed" || current.State == "failed" || current.State == "cancelled" {
		return nil
	}
	if target == "printing" && current.State != "queued" && current.State != "accepted" {
		return nil
	}
	if target != "printing" && current.State != "queued" && current.State != "accepted" && current.State != "printing" {
		return nil
	}
	now := occurredAt.UTC()
	accepted, started, ended := current.AcceptedAt, current.StartedAt, current.EndedAt
	if !accepted.Valid {
		accepted = pgtype.Timestamptz{Time: now, Valid: true}
	}
	if !started.Valid {
		started = pgtype.Timestamptz{Time: now, Valid: true}
	}
	if target != "printing" {
		ended = pgtype.Timestamptz{Time: now, Valid: true}
	}
	if _, err = q.UpdatePrintAttemptState(ctx, db.UpdatePrintAttemptStateParams{State: target, AcceptedAt: accepted, StartedAt: started, EndedAt: ended, ID: attemptID, ExpectedVersion: current.Version}); err != nil {
		return dbError(err)
	}
	submission, err := q.GetPrintSubmissionForUpdate(ctx, current.SubmissionID)
	if err != nil {
		return err
	}
	submissionState := "in_progress"
	if target == "completed" {
		submissionState = "completed"
	} else if target == "failed" || target == "cancelled" {
		submissionState = "failed"
	}
	if _, err = q.UpdatePrintSubmission(ctx, db.UpdatePrintSubmissionParams{Title: submission.Title, Notes: submission.Notes, State: submissionState, ID: submission.ID, ExpectedVersion: submission.Version}); err != nil {
		return dbError(err)
	}
	return audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "print_attempt.connector_state_applied", ResourceType: "print_attempt", ResourceID: &attemptID, ChangedFields: []string{"state"}, Source: "http"})
}

func (s *Service) ReconcileEvent(ctx context.Context, p authorization.Principal, eventID uuid.UUID, decision string, operationKey uuid.UUID, jobID *uuid.UUID, expectedJobVersion *int64, usages []machinelogbook.UsageInput, requestID *uuid.UUID) error {
	if err := require(p, authorization.PrintSubmissionsManage); err != nil {
		return err
	}
	if decision != "accepted" && decision != "rejected" {
		return validation("invalid reconciliation decision")
	}
	if decision == "accepted" && (jobID == nil || expectedJobVersion == nil) {
		return validation("accepted reconciliation requires a machine job and version")
	}
	fp := fingerprint(struct {
		EventID  uuid.UUID
		Decision string
		JobID    *uuid.UUID
		Usages   []machinelogbook.UsageInput
	}{eventID, decision, jobID, usages})

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// A transaction advisory lock closes the missing-row race around operation
	// idempotency without introducing a separate coordination service.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", operationKey.String()); err != nil {
		return err
	}
	q := db.New(tx)
	operation, err := q.GetPrintingOperation(ctx, operationKey)
	if err == nil {
		if operation.ActorAccountID != p.AccountID || operation.Kind != "reconciliation_accept" || operation.Fingerprint != fp || operation.ResultID != eventID {
			return conflict("idempotency_conflict", "Operation key was reused with different input")
		}
		return tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	event, err := q.GetPrinterEventForUpdate(ctx, eventID)
	if err != nil {
		return noRows(err)
	}
	if event.Kind != "consumption_report" || event.ReconciliationState != "pending" {
		return conflict("event_not_pending", "Printer event is not awaiting reconciliation")
	}
	if decision == "accepted" {
		if event.AttemptID == nil || event.MachineID == nil {
			return conflict("event_not_correlated", "Consumption must be correlated to a print attempt before approval")
		}
		attempt, attemptErr := q.GetPrintAttemptForUpdate(ctx, *event.AttemptID)
		if attemptErr != nil {
			return noRows(attemptErr)
		}
		if attempt.MachineID != *event.MachineID || attempt.MachineJobID == nil || *attempt.MachineJobID != *jobID {
			return conflict("event_job_mismatch", "Consumption must be approved against the Machine Job linked to its print attempt")
		}
		if _, err = s.jobs.ReplaceJobUsagesInTransaction(ctx, tx, p, *jobID, *expectedJobVersion, usages, &eventID, requestID); err != nil {
			return err
		}
	}
	actor := p.AccountID
	if _, err = q.ReconcilePrinterEvent(ctx, db.ReconcilePrinterEventParams{ReconciliationState: decision, ReconciledByAccountID: &actor, ID: eventID}); err != nil {
		return dbError(err)
	}
	if _, err = q.InsertPrintingOperation(ctx, db.InsertPrintingOperationParams{OperationKey: operationKey, ActorAccountID: p.AccountID, Kind: "reconciliation_accept", Fingerprint: fp, ResultID: eventID}); err != nil {
		return dbError(err)
	}
	if err = writeAudit(ctx, tx, p, "printer_event.reconciled", "printer_event", eventID, requestID, []string{"reconciliationState"}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
