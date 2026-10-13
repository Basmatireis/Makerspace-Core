package printerconnectors

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ingestHarness struct {
	t          *testing.T
	pool       *pgxpool.Pool
	service    *Service
	logbook    *machinelogbook.Service
	principal  authorization.Principal
	connector  Context
	assignment Assignment
	machine    machinelogbook.Machine
	suffix     string
	sequence   int64
}

func newIngestHarness(t *testing.T) *ingestHarness {
	t.Helper()
	pool := printerConnectorIntegrationPool(t)
	ctx := t.Context()
	h := &ingestHarness{t: t, pool: pool, logbook: machinelogbook.NewService(pool)}
	printingService := printing.NewService(pool, h.logbook)
	var err error
	h.service, err = NewService(pool, printingService, nil)
	if err != nil {
		t.Fatal(err)
	}
	personID, accountID, requestID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	h.suffix = strings.ReplaceAll(personID.String(), "-", "")[:12]
	h.principal = authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	if _, err = pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Print', 'Ingest', $2)`, personID, "prints-"+h.suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}
	machineType, err := h.logbook.CreateMachineType(ctx, h.principal, "Ingest printer "+h.suffix, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	h.machine, err = h.logbook.CreateMachine(ctx, h.principal, machineType.ID, "Ingest machine "+h.suffix, "active", nil, false, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = printingService.ConfigureProfile(ctx, h.principal, h.machine.ID, true, 0, &requestID); err != nil {
		t.Fatal(err)
	}
	connector, err := h.service.Create(ctx, h.principal, "Ingest connector "+h.suffix, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	issue, err := h.service.IssueEnrollment(ctx, h.principal, connector.ID, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.service.Enroll(ctx, issue.Secret, uuid.Must(uuid.NewV7()), secret, "test", 1); err != nil {
		t.Fatal(err)
	}
	connectorContext, err := h.service.Authenticate(ctx, secret)
	if err != nil || connectorContext == nil {
		t.Fatalf("authenticate: %v", err)
	}
	h.connector = *connectorContext
	h.assignment, err = h.service.CreateAssignment(ctx, h.principal, connector.ID, AssignmentInput{MachineID: h.machine.ID, AdapterKind: "simulator", AdapterSchemaVersion: 1, Settings: json.RawMessage(`{"scenario":"idle"}`)}, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *ingestHarness) send(runID uuid.UUID, kind string, at time.Time, payload string, revision *int64) EventReceipt {
	h.t.Helper()
	h.sequence++
	return h.sendEvent(EventInput{EventID: uuid.Must(uuid.NewV7()), AssignmentID: h.assignment.ID, RunID: &runID, HistoryComplete: true, ConfigurationVersion: h.assignment.ConfigurationVersion, Sequence: h.sequence, OccurredAt: at, Kind: kind, ReportRevision: revision, Payload: json.RawMessage(payload)})
}

func (h *ingestHarness) sendEvent(input EventInput) EventReceipt {
	h.t.Helper()
	receipts, err := h.service.IngestEvents(h.t.Context(), h.connector, []EventInput{input})
	if err != nil || len(receipts) != 1 {
		h.t.Fatalf("ingest receipts=%+v err=%v", receipts, err)
	}
	return receipts[0]
}

func (h *ingestHarness) accepted(runID uuid.UUID, kind string, at time.Time, payload string) {
	h.t.Helper()
	if receipt := h.send(runID, kind, at, payload, nil); receipt.Status != "accepted" {
		h.t.Fatalf("%s receipt = %+v", kind, receipt)
	}
}

func (h *ingestHarness) report(runID uuid.UUID, at time.Time, payload string, revision int64) {
	h.t.Helper()
	if receipt := h.send(runID, "consumption_report", at, payload, &revision); receipt.Status != "accepted" {
		h.t.Fatalf("report receipt = %+v", receipt)
	}
}

type runRow struct {
	displayID, state             string
	fileName                     *string
	started, ended, estimatedEnd *time.Time
	percent                      *int
	grams, basis                 *string
	spoolID, reportedEventID     *uuid.UUID
	version                      int64
}

func (h *ingestHarness) run(runID uuid.UUID) runRow {
	h.t.Helper()
	var r runRow
	err := h.pool.QueryRow(h.t.Context(), `SELECT display_id, state, file_name, started_at, ended_at, estimated_end_at, progress_percent, reported_quantity_g::text, reported_quantity_basis, reported_spool_id, reported_event_id, version FROM printer_observed_runs WHERE id = $1`, runID).
		Scan(&r.displayID, &r.state, &r.fileName, &r.started, &r.ended, &r.estimatedEnd, &r.percent, &r.grams, &r.basis, &r.spoolID, &r.reportedEventID, &r.version)
	if err != nil {
		h.t.Fatal(err)
	}
	return r
}

func (h *ingestHarness) sequenceValue() int64 {
	h.t.Helper()
	var value int64
	if err := h.pool.QueryRow(h.t.Context(), `SELECT last_value FROM print_display_sequence`).Scan(&value); err != nil {
		h.t.Fatal(err)
	}
	return value
}

// mountSpool creates a spool of a fresh filament material and mounts it in a new slot.
func (h *ingestHarness) mountSpool(name string, externalSlot *string, mountedAt time.Time) uuid.UUID {
	h.t.Helper()
	ctx := h.t.Context()
	diameter, total := "1.75", "20"
	material, err := h.logbook.CreateMaterialWithFilament(ctx, h.principal, "Ingest "+name+" "+h.suffix, "pla", nil, "g", nil, &diameter, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	spool, err := h.logbook.CreateFilamentSpool(ctx, h.principal, machinelogbook.FilamentSpoolInput{MaterialID: material.ID, InitialNetWeightG: "1000", StockMode: "new_acquisition", TotalPrice: &total, OccurredAt: mountedAt, ExpectedInventoryVersion: material.InventoryVersion}, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	unitID, slotID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	var position int
	if err = h.pool.QueryRow(ctx, `SELECT COALESCE(max(position) + 1, 0) FROM printer_input_units WHERE machine_id = $1`, h.machine.ID).Scan(&position); err != nil {
		h.t.Fatal(err)
	}
	if _, err = h.pool.Exec(ctx, `INSERT INTO printer_input_units (id, machine_id, name, position) VALUES ($1, $2, $3, $4)`, unitID, h.machine.ID, "Unit "+name, position); err != nil {
		h.t.Fatal(err)
	}
	if _, err = h.pool.Exec(ctx, `INSERT INTO printer_slots (id, input_unit_id, name, position, external_identifier) VALUES ($1, $2, $3, 0, $4)`, slotID, unitID, "Slot "+name, externalSlot); err != nil {
		h.t.Fatal(err)
	}
	if _, err = h.pool.Exec(ctx, `INSERT INTO printer_spool_assignments (id, slot_id, spool_id, mounted_at, source) VALUES ($1, $2, $3, $4, 'manual')`, uuid.Must(uuid.NewV7()), slotID, spool.ID, mountedAt); err != nil {
		h.t.Fatal(err)
	}
	return spool.ID
}

func TestIngestRecordsPrintFacts(t *testing.T) {
	h := newIngestHarness(t)
	runID := uuid.Must(uuid.NewV7())
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	spoolID := h.mountSpool("A", nil, t0.Add(-time.Hour))

	before := h.sequenceValue()
	h.accepted(runID, "operational_state", t0, `{"state":"printing","fileName":"  part.gcode  "}`)
	created := h.run(runID)
	if want := fmt.Sprintf("PR-%04d-", t0.Year()); !strings.HasPrefix(created.displayID, want) || h.sequenceValue() != before+1 {
		t.Fatalf("display id %q sequence %d -> %d", created.displayID, before, h.sequenceValue())
	}
	if created.state != "printing" || created.started == nil || !created.started.Equal(t0) || created.fileName == nil || *created.fileName != "part.gcode" {
		t.Fatalf("created run: %+v", created)
	}

	h.accepted(runID, "progress", t0.Add(time.Minute), `{"state":"printing","percent":40,"remainingSeconds":600}`)
	progressed := h.run(runID)
	if progressed.percent == nil || *progressed.percent != 40 || progressed.estimatedEnd == nil || !progressed.estimatedEnd.Equal(t0.Add(11*time.Minute)) || progressed.displayID != created.displayID {
		t.Fatalf("progressed run: %+v", progressed)
	}
	// An older observation arriving late changes neither progress nor estimate; invalid values are ignored.
	h.accepted(runID, "progress", t0.Add(30*time.Second), `{"percent":10,"remainingSeconds":9000,"fileName":""}`)
	h.accepted(runID, "progress", t0.Add(2*time.Minute), `{"percent":150,"remainingSeconds":-5,"fileName":42}`)
	late := h.run(runID)
	if late.percent == nil || *late.percent != 40 || late.estimatedEnd == nil || !late.estimatedEnd.Equal(t0.Add(11*time.Minute)) || late.fileName == nil || *late.fileName != "part.gcode" {
		t.Fatalf("late or invalid observations changed the run: %+v", late)
	}

	// Duplicates change nothing and never allocate a number.
	duplicate := EventInput{EventID: uuid.Must(uuid.NewV7()), AssignmentID: h.assignment.ID, RunID: &runID, HistoryComplete: true, ConfigurationVersion: h.assignment.ConfigurationVersion, Sequence: 1000, OccurredAt: t0.Add(5 * time.Minute), Kind: "progress", Payload: json.RawMessage(`{"percent":60,"remainingSeconds":300}`)}
	if receipt := h.sendEvent(duplicate); receipt.Status != "accepted" {
		t.Fatalf("receipt = %+v", receipt)
	}
	snapshot := h.run(runID)
	if receipt := h.sendEvent(duplicate); receipt.Status != "duplicate" {
		t.Fatalf("duplicate receipt = %+v", receipt)
	}
	if again := h.run(runID); again.version != snapshot.version || *again.percent != *snapshot.percent || !again.estimatedEnd.Equal(*snapshot.estimatedEnd) {
		t.Fatalf("duplicate changed the run: %+v -> %+v", snapshot, again)
	}
	if h.sequenceValue() != before+1 {
		t.Fatalf("updates burned display numbers: %d -> %d", before, h.sequenceValue())
	}

	// Reports resolve their spool and only a newer or equal revision replaces the current one.
	h.report(runID, t0.Add(6*time.Minute), `{"quantityGrams":"20","quantityBasis":"estimated"}`, 2)
	first := h.run(runID)
	if first.grams == nil || *first.grams != "20.000000" || first.basis == nil || *first.basis != "estimated" || first.spoolID == nil || *first.spoolID != spoolID || first.reportedEventID == nil {
		t.Fatalf("first report: %+v", first)
	}
	h.report(runID, t0.Add(7*time.Minute), `{"quantityGrams":"15","quantityBasis":"actual"}`, 1)
	if stale := h.run(runID); *stale.grams != "20.000000" || *stale.reportedEventID != *first.reportedEventID {
		t.Fatalf("older revision replaced the report: %+v", stale)
	}
	h.report(runID, t0.Add(8*time.Minute), `{"quantityGrams":"21.5","quantityBasis":"actual"}`, 3)
	if newer := h.run(runID); *newer.grams != "21.500000" || *newer.basis != "actual" || *newer.reportedEventID == *first.reportedEventID {
		t.Fatalf("newer revision was not applied: %+v", newer)
	}
	h.report(runID, t0.Add(9*time.Minute), `{"quantityGrams":"-3","quantityBasis":"actual"}`, 4)
	h.report(runID, t0.Add(9*time.Minute+time.Second), `{"quantityGrams":"3","quantityBasis":"guess"}`, 5)
	if invalid := h.run(runID); *invalid.grams != "21.500000" {
		t.Fatalf("invalid report replaced the usage: %+v", invalid)
	}

	h.accepted(runID, "terminal_outcome", t0.Add(10*time.Minute), `{"outcome":"completed"}`)
	done := h.run(runID)
	if done.state != "completed" || done.ended == nil || !done.ended.Equal(t0.Add(10*time.Minute)) || done.percent == nil || *done.percent != 100 || done.started == nil || !done.started.Equal(t0) {
		t.Fatalf("finished run: %+v", done)
	}
	h.accepted(runID, "terminal_outcome", t0.Add(20*time.Minute), `{"outcome":"failed"}`)
	if sticky := h.run(runID); sticky.state != "completed" || !sticky.ended.Equal(t0.Add(10*time.Minute)) {
		t.Fatalf("terminal state moved: %+v", sticky)
	}
	if h.sequenceValue() != before+1 {
		t.Fatalf("display numbers burned: %d -> %d", before, h.sequenceValue())
	}
}

func TestIngestResolvesTheReportedSpool(t *testing.T) {
	h := newIngestHarness(t)
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	slotA, slotB := "slot-a-"+h.suffix, "slot-b-"+h.suffix
	spoolA := h.mountSpool("A", &slotA, t0.Add(-time.Hour))

	one := uuid.Must(uuid.NewV7())
	h.accepted(one, "progress", t0, `{"percent":10}`)
	h.report(one, t0.Add(time.Minute), `{"quantityGrams":"5","quantityBasis":"actual"}`, 1)
	if run := h.run(one); run.spoolID == nil || *run.spoolID != spoolA {
		t.Fatalf("single mounted spool not used: %+v", run)
	}
	spoolB := h.mountSpool("B", &slotB, t0.Add(-time.Hour))

	ambiguous := uuid.Must(uuid.NewV7())
	h.accepted(ambiguous, "progress", t0, `{"percent":10}`)
	h.report(ambiguous, t0.Add(time.Minute), `{"quantityGrams":"5","quantityBasis":"actual"}`, 1)
	if run := h.run(ambiguous); run.grams == nil || run.spoolID != nil {
		t.Fatalf("ambiguous mounts must stay unresolved: %+v", run)
	}
	for slot, want := range map[string]uuid.UUID{slotA: spoolA, slotB: spoolB} {
		runID := uuid.Must(uuid.NewV7())
		h.accepted(runID, "progress", t0, `{"percent":10}`)
		h.report(runID, t0.Add(time.Minute), `{"quantityGrams":"5","quantityBasis":"actual","slotExternalId":"`+slot+`"}`, 1)
		if run := h.run(runID); run.spoolID == nil || *run.spoolID != want {
			t.Fatalf("slot %s resolved to %v, want %s", slot, run.spoolID, want)
		}
	}
	// A slot id that is unknown on this machine falls back to the mount count.
	unknown := uuid.Must(uuid.NewV7())
	h.accepted(unknown, "progress", t0, `{"percent":10}`)
	h.report(unknown, t0.Add(time.Minute), `{"quantityGrams":"5","quantityBasis":"actual","slotExternalId":"missing"}`, 1)
	if run := h.run(unknown); run.spoolID != nil {
		t.Fatalf("unknown slot with two mounts resolved: %+v", run)
	}
	// A spool that was mounted only after the report is not used for the slot.
	early := uuid.Must(uuid.NewV7())
	h.accepted(early, "progress", t0.Add(-3*time.Hour), `{"percent":10}`)
	h.report(early, t0.Add(-2*time.Hour-30*time.Minute), `{"quantityGrams":"5","quantityBasis":"actual","slotExternalId":"`+slotA+`"}`, 1)
	if run := h.run(early); run.spoolID != nil {
		t.Fatalf("slot resolved to a spool mounted later: %+v", run)
	}
}

func TestIngestClampsTheEndToTheStart(t *testing.T) {
	h := newIngestHarness(t)
	t0 := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	runID := uuid.Must(uuid.NewV7())
	h.accepted(runID, "terminal_outcome", t0, `{"outcome":"failed"}`)
	if run := h.run(runID); run.state != "failed" || run.ended == nil || run.started != nil || run.percent != nil {
		t.Fatalf("terminal-first run: %+v", run)
	}
	h.accepted(runID, "progress", t0.Add(time.Minute), `{"percent":50}`)
	run := h.run(runID)
	if run.started == nil || run.ended == nil || run.ended.Before(*run.started) {
		t.Fatalf("end before start: %+v", run)
	}
}
