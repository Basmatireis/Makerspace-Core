package printing

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
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
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

type InputUnit struct {
	ID, MachineID      uuid.UUID
	Name               string
	Position           int
	Nozzle             *string
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
	Model                *string
	InputUnits           []InputUnit
	Slots                []Slot
	Version              int64
	CreatedAt, UpdatedAt time.Time
}
type PrinterEvent struct {
	ID                       uuid.UUID
	SourceID, EventKey, Kind string
	ProtocolVersion          int
	OccurredAt, ReceivedAt   time.Time
	Payload                  json.RawMessage
}

type ConnectorEventInput struct {
	EventID, ConnectorID, AssignmentID, MachineID uuid.UUID
	RunID                                         *uuid.UUID
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
func fingerprint(value any) string {
	raw, _ := json.Marshal(value)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
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
	actor := p.AccountID
	return audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         action,
			ResourceType:   resource,
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  fields,
		},
	)
}

func inputUnit(row db.PrinterInputUnit) InputUnit {
	return InputUnit{
		ID:                 row.ID,
		MachineID:          row.MachineID,
		Name:               row.Name,
		Position:           int(row.Position),
		Nozzle:             row.Nozzle,
		ExternalIdentifier: row.ExternalIdentifier,
		Enabled:            row.Enabled,
		Version:            row.Version,
	}
}
func slotFromGet(row db.GetPrinterSlotRow) Slot {
	return Slot{
		ID:                 row.ID,
		InputUnitID:        row.InputUnitID,
		MachineID:          row.MachineID,
		InputUnitName:      row.InputUnitName,
		Name:               row.Name,
		Position:           int(row.Position),
		ExternalIdentifier: row.ExternalIdentifier,
		Status:             row.Status,
		AssignmentID:       row.AssignmentID,
		SpoolID:            row.SpoolID,
		SpoolDisplayID:     row.SpoolDisplayID,
		MountedAt:          nullableTime(row.MountedAt),
		Version:            row.Version,
	}
}
func slotFromList(row db.ListPrinterSlotsRow) Slot {
	return Slot{
		ID:                 row.ID,
		InputUnitID:        row.InputUnitID,
		MachineID:          row.MachineID,
		InputUnitName:      row.InputUnitName,
		Name:               row.Name,
		Position:           int(row.Position),
		ExternalIdentifier: row.ExternalIdentifier,
		Status:             row.Status,
		AssignmentID:       row.AssignmentID,
		SpoolID:            row.SpoolID,
		SpoolDisplayID:     row.SpoolDisplayID,
		MountedAt:          nullableTime(row.MountedAt),
		Version:            row.Version,
	}
}

func (s *Service) GetProfile(ctx context.Context, p authorization.Principal, machineID uuid.UUID) (Profile, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return Profile{}, err
	}
	return loadProfile(ctx, db.New(s.pool), machineID)
}

func loadProfile(ctx context.Context, q *db.Queries, machineID uuid.UUID) (Profile, error) {
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
	item := Profile{
		MachineID:   row.MachineID,
		MachineName: row.MachineName,
		Enabled:     row.Enabled,
		Model:       row.Model,
		Version:     row.Version,
		CreatedAt:   row.CreatedAt,
		UpdatedAt:   row.UpdatedAt,
		InputUnits:  make([]InputUnit, 0, len(units)),
		Slots:       make([]Slot, 0, len(slots)),
	}
	for _, u := range units {
		item.InputUnits = append(item.InputUnits, inputUnit(u))
	}
	for _, sl := range slots {
		item.Slots = append(item.Slots, slotFromList(sl))
	}
	return item, nil
}

// requireFDMPrinting answers 404 for an unknown machine and 409
// machine_not_fdm_printing when the machine's type has another process: only
// FDM printers have a printer setup.
func requireFDMPrinting(ctx context.Context, tx pgx.Tx, machineID uuid.UUID) error {
	var process string
	err := tx.QueryRow(ctx, "SELECT mt.process FROM machines m JOIN machine_types mt ON mt.id = m.machine_type_id WHERE m.id = $1", machineID).
		Scan(&process)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if process != "fdm_printing" {
		return conflict("machine_not_fdm_printing", "Only machines with the FDM printing process have a printer setup")
	}
	return nil
}

func (s *Service) ConfigureProfile(
	ctx context.Context,
	p authorization.Principal,
	machineID uuid.UUID,
	enabled bool,
	expected int64,
	requestID *uuid.UUID,
) (Profile, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Profile{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Profile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = requireFDMPrinting(ctx, tx, machineID); err != nil {
		return Profile{}, err
	}
	row, err := db.New(tx).
		UpsertPrinterProfile(ctx, db.UpsertPrinterProfileParams{MachineID: machineID, Enabled: enabled, ExpectedVersion: expected})
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

func (s *Service) CreateInputUnit(
	ctx context.Context,
	p authorization.Principal,
	machineID uuid.UUID,
	name string,
	position int,
	external *string,
	requestID *uuid.UUID,
) (InputUnit, error) {
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
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.GetPrinterProfile(ctx, machineID); err != nil {
		return InputUnit{}, noRows(err)
	}
	id := newID()
	row, err := q.CreatePrinterInputUnit(
		ctx,
		db.CreatePrinterInputUnitParams{
			ID:                 id,
			MachineID:          machineID,
			Name:               name,
			Position:           int32(position),
			ExternalIdentifier: clean(external),
		},
	)
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

func (s *Service) UpdateInputUnit(
	ctx context.Context,
	p authorization.Principal,
	inputUnitID uuid.UUID,
	name string,
	position int,
	external *string,
	enabled bool,
	expected int64,
	requestID *uuid.UUID,
) (InputUnit, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return InputUnit{}, err
	}
	name = strings.TrimSpace(name)
	external = clean(external)
	if name == "" || len(name) > 120 || position < 0 || expected < 1 || (external != nil && len(*external) > 200) {
		return InputUnit{}, validation("invalid input unit")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InputUnit{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.GetPrinterInputUnitForUpdate(ctx, inputUnitID); err != nil {
		return InputUnit{}, noRows(err)
	}
	row, err := q.UpdatePrinterInputUnit(
		ctx,
		db.UpdatePrinterInputUnitParams{
			ID:                 inputUnitID,
			Name:               name,
			Position:           int32(position),
			ExternalIdentifier: external,
			Enabled:            enabled,
			ExpectedVersion:    expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return InputUnit{}, apperror.StaleWrite
	}
	if err != nil {
		return InputUnit{}, dbError(err)
	}
	if err = writeAudit(ctx, tx, p, "printer_input_unit.updated", "printer_input_unit", inputUnitID, requestID, []string{"name", "position", "externalIdentifier", "enabled"}); err != nil {
		return InputUnit{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InputUnit{}, err
	}
	return inputUnit(row), nil
}

func (s *Service) CreateSlot(
	ctx context.Context,
	p authorization.Principal,
	inputUnitID uuid.UUID,
	name string,
	position int,
	status string,
	external *string,
	requestID *uuid.UUID,
) (Slot, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Slot{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 || position < 0 ||
		(status != "available" && status != "unavailable" && status != "retired") {
		return Slot{}, validation("invalid printer slot")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Slot{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
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

func (s *Service) UpdateSlot(
	ctx context.Context,
	p authorization.Principal,
	slotID uuid.UUID,
	name string,
	position int,
	status string,
	external *string,
	expected int64,
	requestID *uuid.UUID,
) (Slot, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Slot{}, err
	}
	name = strings.TrimSpace(name)
	external = clean(external)
	if name == "" || len(name) > 120 || position < 0 || expected < 1 || (external != nil && len(*external) > 200) ||
		(status != "available" && status != "unavailable" && status != "retired") {
		return Slot{}, validation("invalid printer slot")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Slot{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.GetPrinterSlotForUpdate(ctx, slotID); err != nil {
		return Slot{}, noRows(err)
	}
	if _, err = q.UpdatePrinterSlot(ctx, db.UpdatePrinterSlotParams{ID: slotID, Name: name, Position: int32(position), ExternalIdentifier: external, Status: status, ExpectedVersion: expected}); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return Slot{}, apperror.StaleWrite
	} else if err != nil {
		return Slot{}, dbError(err)
	}
	if err = writeAudit(ctx, tx, p, "printer_slot.updated", "printer_slot", slotID, requestID, []string{"name", "position", "externalIdentifier", "status"}); err != nil {
		return Slot{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Slot{}, err
	}
	row, err := db.New(s.pool).GetPrinterSlot(ctx, slotID)
	return slotFromGet(row), err
}

func (s *Service) Mount(
	ctx context.Context,
	p authorization.Principal,
	slotID, spoolID uuid.UUID,
	requestID *uuid.UUID,
) (Slot, error) {
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
	defer func() { _ = tx.Rollback(ctx) }()
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

func (s *Service) Unmount(
	ctx context.Context,
	p authorization.Principal,
	slotID uuid.UUID,
	requestID *uuid.UUID,
) (Slot, error) {
	if err := require(p, authorization.PrinterSlotsAssign); err != nil {
		return Slot{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Slot{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
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
func connectorEventFromRow(row printerconnectorsdb.PrinterEvent) PrinterEvent {
	return PrinterEvent{
		ID:              row.ID,
		SourceID:        row.SourceID,
		EventKey:        row.EventKey,
		ProtocolVersion: int(row.ProtocolVersion),
		Kind:            row.Kind,
		OccurredAt:      row.OccurredAt,
		ReceivedAt:      row.ReceivedAt,
		Payload:         row.Payload,
	}
}

// IngestConnectorEvent is the transaction-aware connector boundary. The caller
// validates and locks connector ownership in the same transaction before using
// this method, so event receipt, authorization, and audit cannot commit apart.
func (s *Service) IngestConnectorEvent(
	ctx context.Context,
	tx pgx.Tx,
	input ConnectorEventInput,
) (PrinterEvent, bool, error) {
	if input.EventID == uuid.Nil || input.ConnectorID == uuid.Nil || input.AssignmentID == uuid.Nil || input.MachineID == uuid.Nil ||
		input.ConfigurationVersion < 1 || input.Sequence < 1 || input.OccurredAt.IsZero() ||
		len(input.Payload) == 0 ||
		len(input.Payload) > 32768 {
		return PrinterEvent{}, false, validation("invalid printer event")
	}
	switch input.Kind {
	case "identity",
		"connectivity",
		"operational_state",
		"progress",
		"slot_observation",
		"consumption_report",
		"terminal_outcome":
	default:
		return PrinterEvent{}, false, validation("invalid printer event kind")
	}
	var payloadObject map[string]any
	if json.Unmarshal(input.Payload, &payloadObject) != nil || payloadObject == nil {
		return PrinterEvent{}, false, validation("printer event payload must be a JSON object")
	}
	if input.ApplicationState != "applied" && input.ApplicationState != "review_required" &&
		input.ApplicationState != "recorded" {
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
		RunID                            *uuid.UUID
		ConfigurationVersion, Sequence   int64
		Kind                             string
		OccurredAt                       time.Time
		ExternalPrintID                  *string
		Payload                          json.RawMessage
		ReportRevision                   *int64
	}{input.EventID, input.AssignmentID, input.MachineID, input.RunID, input.ConfigurationVersion, input.Sequence, input.Kind, input.OccurredAt.UTC(), clean(input.ExternalPrintID), input.Payload, input.ReportRevision})
	q := printerconnectorsdb.New(tx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", sourceID+"\n"+eventKey); err != nil {
		return PrinterEvent{}, false, err
	}
	existing, err := q.GetConnectorEventByKey(
		ctx,
		printerconnectorsdb.GetConnectorEventByKeyParams{SourceID: sourceID, EventKey: eventKey},
	)
	if err == nil {
		if existing.Fingerprint != fp {
			return PrinterEvent{}, false, conflict("printer_event_mismatch", "Event ID was reused with different facts")
		}
		return connectorEventFromRow(existing), false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return PrinterEvent{}, false, err
	}
	bySequence, err := q.GetConnectorEventBySequence(
		ctx,
		printerconnectorsdb.GetConnectorEventBySequenceParams{
			AssignmentID:   &input.AssignmentID,
			SourceSequence: &input.Sequence,
		},
	)
	if err == nil {
		if bySequence.EventKey == eventKey && bySequence.Fingerprint == fp {
			return connectorEventFromRow(bySequence), false, nil
		}
		return PrinterEvent{}, false, conflict(
			"printer_event_sequence_conflict",
			"Event sequence was reused with different facts",
		)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return PrinterEvent{}, false, err
	}
	row, err := q.InsertConnectorEvent(
		ctx,
		printerconnectorsdb.InsertConnectorEventParams{
			ID:                   input.EventID,
			SourceID:             sourceID,
			EventKey:             eventKey,
			Fingerprint:          fp,
			ProtocolVersion:      1,
			MachineID:            &input.MachineID,
			Kind:                 input.Kind,
			OccurredAt:           input.OccurredAt.UTC(),
			SourceSequence:       &input.Sequence,
			ExternalPrintID:      clean(input.ExternalPrintID),
			Payload:              input.Payload,
			ConnectorID:          &input.ConnectorID,
			AssignmentID:         &input.AssignmentID,
			RunID:                input.RunID,
			ConfigurationVersion: &input.ConfigurationVersion,
			ApplicationState:     input.ApplicationState,
			ApplicationReason:    input.ApplicationReason,
			ReportRevision:       input.ReportRevision,
		},
	)
	if err != nil {
		return PrinterEvent{}, false, dbError(err)
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "printer_event.ingested", ResourceType: "printer_event", ResourceID: &input.EventID, ChangedFields: []string{"kind", "state"}, Source: "http"}); err != nil {
		return PrinterEvent{}, false, err
	}
	return connectorEventFromRow(row), true, nil
}
