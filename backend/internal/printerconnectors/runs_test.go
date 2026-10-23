package printerconnectors

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

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
	secret     string
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
	printingService := printing.NewService(pool)
	var err error
	h.service, err = NewService(pool, printingService, nil)
	if err != nil {
		t.Fatal(err)
	}
	personID, accountID, requestID := ids.New(), ids.New(), ids.New()
	h.suffix = strings.ReplaceAll(personID.String(), "-", "")[:12]
	h.principal = authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	if _, err = pool.Exec(
		ctx,
		`INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Print', 'Ingest', $2)`,
		personID,
		"prints-"+h.suffix+"@example.test",
	); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(
		ctx,
		`INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`,
		accountID,
		personID,
	); err != nil {
		t.Fatal(err)
	}
	machineType, err := h.logbook.CreateMachineType(
		ctx,
		h.principal,
		"Ingest printer "+h.suffix,
		"fdm_printing",
		&requestID,
	)
	if err != nil {
		t.Fatal(err)
	}
	h.machine, err = h.logbook.CreateMachine(
		ctx,
		h.principal,
		machineType.ID,
		"Ingest machine "+h.suffix,
		"active",
		nil,
		false,
		&requestID,
	)
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
	if _, err = h.service.Enroll(ctx, issue.Secret, ids.New(), secret, "test", 1); err != nil {
		t.Fatal(err)
	}
	connectorContext, err := h.service.Authenticate(ctx, secret)
	if err != nil || connectorContext == nil {
		t.Fatalf("authenticate: %v", err)
	}
	h.connector = *connectorContext
	h.secret = secret
	h.assignment, err = h.service.CreateAssignment(
		ctx,
		h.principal,
		connector.ID,
		AssignmentInput{
			MachineID:            h.machine.ID,
			AdapterKind:          "simulator",
			AdapterSchemaVersion: 1,
			Settings:             json.RawMessage(`{"scenario":"idle"}`),
			Enabled:              true,
		},
		&requestID,
	)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *ingestHarness) send(
	runID uuid.UUID,
	kind printing.EventKind,
	at time.Time,
	payload string,
	revision *int64,
) EventReceipt {
	h.t.Helper()
	h.sequence++
	return h.sendEvent(
		EventInput{
			EventID:              ids.New(),
			AssignmentID:         h.assignment.ID,
			RunID:                &runID,
			HistoryComplete:      true,
			ConfigurationVersion: h.assignment.ConfigurationVersion,
			Sequence:             h.sequence,
			OccurredAt:           at,
			Kind:                 kind,
			ReportRevision:       revision,
			Payload:              json.RawMessage(payload),
		},
	)
}

func (h *ingestHarness) sendEvent(input EventInput) EventReceipt {
	h.t.Helper()
	receipts, err := h.service.IngestEvents(h.t.Context(), h.connector, []EventInput{input})
	if err != nil || len(receipts) != 1 {
		h.t.Fatalf("ingest receipts=%+v err=%v", receipts, err)
	}
	return receipts[0]
}

func (h *ingestHarness) accepted(runID uuid.UUID, kind printing.EventKind, at time.Time, payload string) {
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
	err := h.pool.QueryRow(
		h.t.Context(),
		`SELECT display_id, state, file_name, started_at, ended_at, estimated_end_at, progress_percent, reported_quantity_g::text, reported_quantity_basis, reported_spool_id, reported_event_id, version FROM machine_runs WHERE id = $1`,
		runID,
	).
		Scan(
			&r.displayID,
			&r.state,
			&r.fileName,
			&r.started,
			&r.ended,
			&r.estimatedEnd,
			&r.percent,
			&r.grams,
			&r.basis,
			&r.spoolID,
			&r.reportedEventID,
			&r.version,
		)
	if err != nil {
		h.t.Fatal(err)
	}
	return r
}

func (h *ingestHarness) sequenceValue() int64 {
	h.t.Helper()
	var value int64
	if err := h.pool.QueryRow(
		h.t.Context(),
		`SELECT last_value FROM machine_run_display_sequence`,
	).Scan(&value); err != nil {
		h.t.Fatal(err)
	}
	return value
}

// burnedDisplayNumbers counts sequence values taken since before that did not
// become a print. Other tests may create prints concurrently, so the sequence
// itself only proves anything relative to the prints that exist.
func (h *ingestHarness) burnedDisplayNumbers(before int64) int64 {
	h.t.Helper()
	var created int64
	if err := h.pool.QueryRow(
		h.t.Context(),
		`SELECT count(*) FROM machine_runs WHERE substring(display_id from '[0-9]+$')::bigint BETWEEN $1 + 1 AND (SELECT last_value FROM machine_run_display_sequence)`,
		before,
	).Scan(&created); err != nil {
		h.t.Fatal(err)
	}
	return h.sequenceValue() - before - created
}

// settledBurnedDisplayNumbers waits briefly for concurrent tests whose open
// transactions already took a sequence value but have not committed their run
// yet, so only numbers that stay unused are reported.
func (h *ingestHarness) settledBurnedDisplayNumbers(before int64) int64 {
	h.t.Helper()
	burned := h.burnedDisplayNumbers(before)
	for attempt := 0; burned != 0 && attempt < 30; attempt++ {
		time.Sleep(100 * time.Millisecond)
		burned = h.burnedDisplayNumbers(before)
	}
	return burned
}

// mountSpool creates a spool of a fresh filament material and mounts it in a new slot.
func (h *ingestHarness) mountSpool(name string, externalSlot *string, mountedAt time.Time) uuid.UUID {
	h.t.Helper()
	ctx := h.t.Context()
	diameter, total := "1.75", "20"
	materialType, err := h.logbook.CreateMaterialType(
		ctx,
		h.principal,
		"PLA "+name+" "+h.suffix,
		"filament",
		"g",
		[]string{"fdm_printing"},
		nil,
	)
	if err != nil {
		h.t.Fatal(err)
	}
	material, err := h.logbook.CreateMaterial(
		ctx,
		h.principal,
		machinelogbook.MaterialInput{
			Name:               "Ingest " + name + " " + h.suffix,
			MaterialTypeID:     materialType.ID,
			FilamentDiameterMM: &diameter,
		},
		nil,
	)
	if err != nil {
		h.t.Fatal(err)
	}
	spool, err := h.logbook.CreateFilamentSpool(
		ctx,
		h.principal,
		machinelogbook.FilamentSpoolInput{
			MaterialID:               material.ID,
			InitialNetWeightG:        "1000",
			StockMode:                "new_acquisition",
			TotalPrice:               &total,
			OccurredAt:               mountedAt,
			ExpectedInventoryVersion: material.InventoryVersion,
		},
		nil,
	)
	if err != nil {
		h.t.Fatal(err)
	}
	unitID, slotID := ids.New(), ids.New()
	var position int
	if err = h.pool.QueryRow(
		ctx,
		`SELECT COALESCE(max(position) + 1, 0) FROM printer_input_units WHERE machine_id = $1`,
		h.machine.ID,
	).Scan(&position); err != nil {
		h.t.Fatal(err)
	}
	if _, err = h.pool.Exec(
		ctx,
		`INSERT INTO printer_input_units (id, machine_id, name, position, external_identifier) VALUES ($1, $2, $3, $4, $5)`,
		unitID,
		h.machine.ID,
		"Unit "+name,
		position,
		h.unitExternal(name),
	); err != nil {
		h.t.Fatal(err)
	}
	if _, err = h.pool.Exec(
		ctx,
		`INSERT INTO printer_slots (id, input_unit_id, name, position, external_identifier) VALUES ($1, $2, $3, 0, $4)`,
		slotID,
		unitID,
		"Slot "+name,
		externalSlot,
	); err != nil {
		h.t.Fatal(err)
	}
	if _, err = h.pool.Exec(
		ctx,
		`INSERT INTO printer_spool_assignments (id, slot_id, spool_id, mounted_at, source) VALUES ($1, $2, $3, $4, 'manual')`,
		ids.New(),
		slotID,
		spool.ID,
		mountedAt,
	); err != nil {
		h.t.Fatal(err)
	}
	return spool.ID
}

func (h *ingestHarness) unitExternal(name string) string {
	return "unit-" + name + "-" + h.suffix
}

func TestIngestRecordsPrintFacts(t *testing.T) {
	h := newIngestHarness(t)
	runID := ids.New()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	slot := "slot-a-" + h.suffix
	spoolID := h.mountSpool("A", &slot, t0.Add(-time.Hour))

	before := h.sequenceValue()
	h.accepted(runID, "operational_state", t0, `{"state":"printing","fileName":"  part.gcode  "}`)
	created := h.run(runID)
	if want := fmt.Sprintf("R-%04d-", t0.Year()); !strings.HasPrefix(created.displayID, want) ||
		h.settledBurnedDisplayNumbers(before) != 0 {
		t.Fatalf(
			"display id %q: %d display numbers burned since %d",
			created.displayID,
			h.burnedDisplayNumbers(before),
			before,
		)
	}
	if created.state != "running" || created.started == nil || !created.started.Equal(t0) || created.fileName == nil ||
		*created.fileName != "part.gcode" {
		t.Fatalf("created run: %+v", created)
	}

	h.accepted(runID, "progress", t0.Add(time.Minute), `{"state":"printing","percent":40,"remainingSeconds":600}`)
	progressed := h.run(runID)
	if progressed.percent == nil || *progressed.percent != 40 || progressed.estimatedEnd == nil ||
		!progressed.estimatedEnd.Equal(t0.Add(11*time.Minute)) ||
		progressed.displayID != created.displayID {
		t.Fatalf("progressed run: %+v", progressed)
	}
	// An older observation arriving late changes neither progress nor estimate; invalid values are ignored.
	h.accepted(runID, "progress", t0.Add(30*time.Second), `{"percent":10,"remainingSeconds":9000,"fileName":""}`)
	h.accepted(runID, "progress", t0.Add(2*time.Minute), `{"percent":150,"remainingSeconds":-5,"fileName":42}`)
	late := h.run(runID)
	if late.percent == nil || *late.percent != 40 || late.estimatedEnd == nil ||
		!late.estimatedEnd.Equal(t0.Add(11*time.Minute)) ||
		late.fileName == nil ||
		*late.fileName != "part.gcode" {
		t.Fatalf("late or invalid observations changed the run: %+v", late)
	}

	// Duplicates change nothing and never allocate a number.
	duplicate := EventInput{
		EventID:              ids.New(),
		AssignmentID:         h.assignment.ID,
		RunID:                &runID,
		HistoryComplete:      true,
		ConfigurationVersion: h.assignment.ConfigurationVersion,
		Sequence:             1000,
		OccurredAt:           t0.Add(5 * time.Minute),
		Kind:                 "progress",
		Payload:              json.RawMessage(`{"percent":60,"remainingSeconds":300}`),
	}
	if receipt := h.sendEvent(duplicate); receipt.Status != "accepted" {
		t.Fatalf("receipt = %+v", receipt)
	}
	snapshot := h.run(runID)
	if receipt := h.sendEvent(duplicate); receipt.Status != "duplicate" {
		t.Fatalf("duplicate receipt = %+v", receipt)
	}
	if again := h.run(runID); again.version != snapshot.version || *again.percent != *snapshot.percent ||
		!again.estimatedEnd.Equal(*snapshot.estimatedEnd) {
		t.Fatalf("duplicate changed the run: %+v -> %+v", snapshot, again)
	}
	if burned := h.settledBurnedDisplayNumbers(before); burned != 0 {
		t.Fatalf("updates burned %d display numbers", burned)
	}

	// Reports resolve their spool and only a newer or equal revision replaces the current one.
	h.report(
		runID,
		t0.Add(6*time.Minute),
		`{"quantityGrams":"20","quantityBasis":"estimated","inputUnitExternalId":"`+h.unitExternal(
			"A",
		)+`","slotExternalId":"`+slot+`"}`,
		2,
	)
	first := h.run(runID)
	if first.grams == nil || *first.grams != "20.000000" || first.basis == nil || *first.basis != "estimated" ||
		first.spoolID == nil ||
		*first.spoolID != spoolID ||
		first.reportedEventID == nil {
		t.Fatalf("first report: %+v", first)
	}
	h.report(
		runID,
		t0.Add(7*time.Minute),
		`{"quantityGrams":"15","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal(
			"A",
		)+`","slotExternalId":"`+slot+`"}`,
		1,
	)
	if stale := h.run(runID); *stale.grams != "20.000000" || *stale.reportedEventID != *first.reportedEventID {
		t.Fatalf("older revision replaced the report: %+v", stale)
	}
	h.report(
		runID,
		t0.Add(8*time.Minute),
		`{"quantityGrams":"21.5","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal(
			"A",
		)+`","slotExternalId":"`+slot+`"}`,
		3,
	)
	if newer := h.run(runID); *newer.grams != "21.500000" || *newer.basis != "actual" ||
		*newer.reportedEventID == *first.reportedEventID {
		t.Fatalf("newer revision was not applied: %+v", newer)
	}
	h.report(runID, t0.Add(9*time.Minute), `{"quantityGrams":"-3","quantityBasis":"actual"}`, 4)
	h.report(runID, t0.Add(9*time.Minute+time.Second), `{"quantityGrams":"3","quantityBasis":"guess"}`, 5)
	if invalid := h.run(runID); *invalid.grams != "21.500000" {
		t.Fatalf("invalid report replaced the usage: %+v", invalid)
	}

	h.accepted(runID, "terminal_outcome", t0.Add(10*time.Minute), `{"outcome":"completed"}`)
	done := h.run(runID)
	if done.state != "finished" || done.ended == nil || !done.ended.Equal(t0.Add(10*time.Minute)) ||
		done.percent == nil ||
		*done.percent != 100 ||
		done.started == nil ||
		!done.started.Equal(t0) {
		t.Fatalf("finished run: %+v", done)
	}
	h.accepted(runID, "terminal_outcome", t0.Add(20*time.Minute), `{"outcome":"failed"}`)
	if sticky := h.run(runID); sticky.state != "finished" || !sticky.ended.Equal(t0.Add(10*time.Minute)) {
		t.Fatalf("terminal state moved: %+v", sticky)
	}
	if burned := h.settledBurnedDisplayNumbers(before); burned != 0 {
		t.Fatalf("%d display numbers burned", burned)
	}
}

func TestIngestResolvesTheReportedSpool(t *testing.T) {
	h := newIngestHarness(t)
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	slotA, slotB := "slot-a-"+h.suffix, "slot-b-"+h.suffix
	spoolA := h.mountSpool("A", &slotA, t0.Add(-time.Hour))

	one := ids.New()
	h.accepted(one, "progress", t0, `{"percent":10}`)
	h.report(one, t0.Add(time.Minute), `{"quantityGrams":"5","quantityBasis":"actual"}`, 1)
	if run := h.run(one); run.spoolID != nil {
		t.Fatalf("report without exact slot evidence resolved a spool: %+v", run)
	}
	spoolB := h.mountSpool("B", &slotB, t0.Add(-time.Hour))

	ambiguous := ids.New()
	h.accepted(ambiguous, "progress", t0, `{"percent":10}`)
	h.report(ambiguous, t0.Add(time.Minute), `{"quantityGrams":"5","quantityBasis":"actual"}`, 1)
	if run := h.run(ambiguous); run.grams == nil || run.spoolID != nil {
		t.Fatalf("ambiguous mounts must stay unresolved: %+v", run)
	}
	for slot, test := range map[string]struct {
		spool uuid.UUID
		unit  string
	}{slotA: {spoolA, h.unitExternal("A")}, slotB: {spoolB, h.unitExternal("B")}} {
		runID := ids.New()
		h.accepted(runID, "progress", t0, `{"percent":10}`)
		h.report(
			runID,
			t0.Add(time.Minute),
			`{"quantityGrams":"5","quantityBasis":"actual","inputUnitExternalId":"`+test.unit+`","slotExternalId":"`+slot+`"}`,
			1,
		)
		if run := h.run(runID); run.spoolID == nil || *run.spoolID != test.spool {
			t.Fatalf("slot %s resolved to %v, want %s", slot, run.spoolID, test.spool)
		}
	}
	// A slot id that is unknown on this machine falls back to the mount count.
	unknown := ids.New()
	h.accepted(unknown, "progress", t0, `{"percent":10}`)
	h.report(
		unknown,
		t0.Add(time.Minute),
		`{"quantityGrams":"5","quantityBasis":"actual","slotExternalId":"missing"}`,
		1,
	)
	if run := h.run(unknown); run.spoolID != nil {
		t.Fatalf("unknown slot with two mounts resolved: %+v", run)
	}
	// A spool that was mounted only after the report is not used for the slot.
	early := ids.New()
	h.accepted(early, "progress", t0.Add(-3*time.Hour), `{"percent":10}`)
	h.report(
		early,
		t0.Add(-2*time.Hour-30*time.Minute),
		`{"quantityGrams":"5","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal(
			"A",
		)+`","slotExternalId":"`+slotA+`"}`,
		1,
	)
	if run := h.run(early); run.spoolID != nil {
		t.Fatalf("slot resolved to a spool mounted later: %+v", run)
	}
}

func TestIngestAutoMountsExactBambuRFIDWithoutReplacingManualMounts(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	at := time.Now().UTC().Truncate(time.Second).Add(-10 * time.Minute)
	slotExternal := "tray-auto-" + h.suffix
	spoolID := h.mountSpool("Auto", &slotExternal, at.Add(-time.Hour))
	tag := "E2C92C29" + strings.ToUpper(h.suffix[:8])
	if _, err := h.logbook.AddFilamentSpoolIdentifier(ctx, h.principal, spoolID, "nfc", tag, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE printer_spool_assignments SET unmounted_at=$2 WHERE spool_id=$1 AND unmounted_at IS NULL`,
		spoolID,
		at.Add(-30*time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	settings := `{"ipAddress":"192.168.1.42","serialNumber":"01P00A123456789","autoDetectSpools":true}`
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE printer_connector_assignments SET adapter_kind='bambu_h2d',settings=$2::jsonb WHERE id=$1`,
		h.assignment.ID,
		settings,
	); err != nil {
		t.Fatal(err)
	}
	h.sequence++
	receipt := h.sendEvent(
		EventInput{
			EventID:              ids.New(),
			AssignmentID:         h.assignment.ID,
			ConfigurationVersion: h.assignment.ConfigurationVersion,
			Sequence:             h.sequence,
			OccurredAt:           at,
			Kind:                 "slot_observation",
			Payload: json.RawMessage(
				`{"inputUnitExternalId":"` + h.unitExternal(
					"Auto",
				) + `","slotExternalId":"` + slotExternal + `","tagUid":"` + tag + `"}`,
			),
		},
	)
	if receipt.Status != "accepted" {
		t.Fatalf("auto mount receipt = %+v", receipt)
	}
	var mounted uuid.UUID
	var source string
	if err := h.pool.QueryRow(
		ctx,
		`SELECT spool_id,source FROM printer_spool_assignments WHERE spool_id=$1 AND unmounted_at IS NULL`,
		spoolID,
	).Scan(&mounted, &source); err != nil ||
		mounted != spoolID ||
		source != "connector_reconciled" {
		t.Fatalf("auto mount spool=%s source=%q err=%v", mounted, source, err)
	}

	// Once staff replace the connector mount manually, an old or conflicting
	// RFID observation may not take the slot back.
	var slotID uuid.UUID
	if err := h.pool.QueryRow(
		ctx,
		`SELECT slot_id FROM printer_spool_assignments WHERE spool_id=$1 AND unmounted_at IS NULL`,
		spoolID,
	).Scan(&slotID); err != nil {
		t.Fatal(err)
	}
	h.sequence++
	receipt = h.sendEvent(
		EventInput{
			EventID:              ids.New(),
			AssignmentID:         h.assignment.ID,
			ConfigurationVersion: h.assignment.ConfigurationVersion,
			Sequence:             h.sequence,
			OccurredAt:           at.Add(time.Minute),
			Kind:                 "slot_observation",
			Payload: json.RawMessage(
				`{"inputUnitExternalId":"` + h.unitExternal(
					"Auto",
				) + `","slotExternalId":"` + slotExternal + `","empty":true}`,
			),
		},
	)
	if receipt.Status != "accepted" {
		t.Fatalf("auto unmount receipt = %+v", receipt)
	}
	var openCount int
	if err := h.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM printer_spool_assignments WHERE slot_id=$1 AND unmounted_at IS NULL`,
		slotID,
	).Scan(&openCount); err != nil ||
		openCount != 0 {
		t.Fatalf("confirmed empty tray kept connector mount: count=%d err=%v", openCount, err)
	}
	h.sequence++
	receipt = h.sendEvent(
		EventInput{
			EventID:              ids.New(),
			AssignmentID:         h.assignment.ID,
			ConfigurationVersion: h.assignment.ConfigurationVersion,
			Sequence:             h.sequence,
			OccurredAt:           at.Add(2 * time.Minute),
			Kind:                 "slot_observation",
			Payload: json.RawMessage(
				`{"inputUnitExternalId":"` + h.unitExternal(
					"Auto",
				) + `","slotExternalId":"` + slotExternal + `","tagUid":"` + tag + `"}`,
			),
		},
	)
	if receipt.Status != "accepted" {
		t.Fatalf("automatic remount receipt = %+v", receipt)
	}
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE printer_spool_assignments SET unmounted_at=$2 WHERE spool_id=$1 AND unmounted_at IS NULL`,
		spoolID,
		at.Add(3*time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	manualSpool := h.mountSpool("ManualConflict", nil, at.Add(-time.Hour))
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE printer_spool_assignments SET unmounted_at=$2 WHERE spool_id=$1 AND unmounted_at IS NULL`,
		manualSpool,
		at.Add(-30*time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO printer_spool_assignments (id,slot_id,spool_id,mounted_at,source) VALUES ($1,$2,$3,$4,'manual')`,
		ids.New(),
		slotID,
		manualSpool,
		at.Add(4*time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	h.sequence++
	receipt = h.sendEvent(
		EventInput{
			EventID:              ids.New(),
			AssignmentID:         h.assignment.ID,
			ConfigurationVersion: h.assignment.ConfigurationVersion,
			Sequence:             h.sequence,
			OccurredAt:           at.Add(5 * time.Minute),
			Kind:                 "slot_observation",
			Payload: json.RawMessage(
				`{"inputUnitExternalId":"` + h.unitExternal(
					"Auto",
				) + `","slotExternalId":"` + slotExternal + `","empty":true}`,
			),
		},
	)
	if receipt.Status != "accepted" {
		t.Fatalf("manual empty conflict receipt = %+v", receipt)
	}
	if err := h.pool.QueryRow(
		ctx,
		`SELECT spool_id,source FROM printer_spool_assignments WHERE slot_id=$1 AND unmounted_at IS NULL`,
		slotID,
	).Scan(&mounted, &source); err != nil ||
		mounted != manualSpool ||
		source != "manual" {
		t.Fatalf("manual mount was auto-unmounted: spool=%s source=%q err=%v", mounted, source, err)
	}
	h.sequence++
	receipt = h.sendEvent(
		EventInput{
			EventID:              ids.New(),
			AssignmentID:         h.assignment.ID,
			ConfigurationVersion: h.assignment.ConfigurationVersion,
			Sequence:             h.sequence,
			OccurredAt:           at.Add(6 * time.Minute),
			Kind:                 "slot_observation",
			Payload: json.RawMessage(
				`{"inputUnitExternalId":"` + h.unitExternal(
					"Auto",
				) + `","slotExternalId":"` + slotExternal + `","tagUid":"` + tag + `"}`,
			),
		},
	)
	if receipt.Status != "accepted" {
		t.Fatalf("conflict receipt = %+v", receipt)
	}
	if err := h.pool.QueryRow(
		ctx,
		`SELECT spool_id,source FROM printer_spool_assignments WHERE slot_id=$1 AND unmounted_at IS NULL`,
		slotID,
	).Scan(&mounted, &source); err != nil ||
		mounted != manualSpool ||
		source != "manual" {
		t.Fatalf("manual mount was replaced: spool=%s source=%q err=%v", mounted, source, err)
	}
}

func TestIngestClampsTheEndToTheStart(t *testing.T) {
	h := newIngestHarness(t)
	t0 := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	runID := ids.New()
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

// A run attached to a job while it still runs settles the job when the machine
// reports its end and consumption; the connector is the audit actor.
func TestIngestSettlesTheJobOfAnAttachedRunAndConsumesUnassignedRuns(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	slot := "slot-j-" + h.suffix
	spoolID := h.mountSpool("J", &slot, t0.Add(-time.Hour))
	group, err := h.logbook.CreatePricingGroup(ctx, h.principal, "Ingest pricing "+h.suffix, nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	rate := "10"
	if _, err = h.logbook.CreatePricingRule(
		ctx,
		h.principal,
		group.ID,
		"machine_runtime",
		&h.machine.MachineType.ID,
		nil,
		nil,
		rate,
		nil,
	); err != nil {
		t.Fatal(err)
	}

	runID := ids.New()
	h.accepted(runID, "progress", t0, `{"state":"printing","percent":10,"remainingSeconds":3600}`)
	job, err := h.logbook.CreateJobFromRun(
		ctx,
		h.principal,
		runID,
		machinelogbook.RunJobInput{
			Customer:         machinelogbook.PartyReference{Kind: "person", ID: h.principal.PersonID},
			OperatorPersonID: h.principal.PersonID,
			PricingGroupID:   &group.ID,
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != "running" {
		t.Fatalf("job status = %s", job.Status)
	}
	h.accepted(runID, "terminal_outcome", t0.Add(30*time.Minute), `{"outcome":"completed"}`)
	h.report(
		runID,
		t0.Add(31*time.Minute),
		`{"quantityGrams":"25","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal(
			"J",
		)+`","slotExternalId":"`+slot+`"}`,
		1,
	)
	settled, err := h.logbook.GetJob(ctx, h.principal, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	run := settled.Runs[0]
	if settled.Status != "successful" || settled.Version <= job.Version || run.Outcome == nil ||
		*run.Outcome != "successful" ||
		!run.OutcomeFromMachine ||
		!run.UsagesFromMachine ||
		len(run.Usages) != 1 ||
		run.Usages[0].SpoolID == nil ||
		*run.Usages[0].SpoolID != spoolID ||
		run.Usages[0].Quantity != "25" {
		t.Fatalf("settled job %s: %+v", settled.Status, run)
	}
	// The machine's final report tells the job's operator once, in the ingest transaction.
	t.Cleanup(func() {
		_, _ = h.pool.Exec(
			context.Background(),
			`DELETE FROM inbox_notifications WHERE id IN (SELECT notification_id FROM inbox_recipients WHERE account_id = $1)`,
			h.principal.AccountID,
		)
	})
	var finished int
	if err = h.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM inbox_recipients r JOIN inbox_notifications n ON n.id = r.notification_id
		 WHERE r.account_id = $1 AND n.kind = 'run_finished' AND n.link = $2`,
		h.principal.AccountID, "/machine-logbook/jobs/runs/"+runID.String(),
	).Scan(&finished); err != nil || finished != 1 {
		t.Fatalf("run_finished notifications for the operator = %d, %v", finished, err)
	}
	// 30 minutes at 10/h; the material has no pricing rule yet, so the price stays incomplete.
	if settled.DurationSeconds != 1800 || settled.PricingStatus != "incomplete" {
		t.Fatalf("job runtime %d pricing %s", settled.DurationSeconds, settled.PricingStatus)
	}
	// The automatic job and run changes are in the connector's activity log, not in the audit log.
	var logged, audited int
	if err = h.pool.QueryRow(
		ctx,
		`SELECT
			(SELECT count(*) FROM printer_connector_activity WHERE connector_id = $1 AND machine_id = $2
				AND ((kind = 'job_run_updated' AND resource_id = $3) OR (kind = 'run_recorded' AND resource_id = $4))),
			(SELECT count(*) FROM audit_events WHERE resource_id IN ($3, $4) AND actor_type = 'system')`,
		h.connector.ID,
		h.machine.ID,
		job.ID,
		runID,
	).Scan(&logged, &audited); err != nil || logged < 2 || audited != 0 {
		t.Fatalf("activity entries = %d, system audit events = %d, err=%v", logged, audited, err)
	}
	// A later report replaces the machine's usage without double counting.
	h.report(
		runID,
		t0.Add(32*time.Minute),
		`{"quantityGrams":"20","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal(
			"J",
		)+`","slotExternalId":"`+slot+`"}`,
		2,
	)
	again, _ := h.logbook.GetJob(ctx, h.principal, job.ID)
	if len(again.Runs[0].Usages) != 1 || again.Runs[0].Usages[0].Quantity != "20" {
		t.Fatalf("usage after the second report: %+v", again.Runs[0].Usages)
	}
	var consumed string
	if err = h.pool.QueryRow(
		ctx,
		`SELECT COALESCE(-sum(quantity_delta), 0)::text FROM inventory_transactions t JOIN machine_run_usages u ON u.id = t.run_usage_id WHERE u.run_id = $1`,
		runID,
	).Scan(&consumed); err != nil ||
		consumed != "20.000000" && consumed != "20" {
		t.Fatalf("net consumption = %s err=%v", consumed, err)
	}

	// A run without a job consumes as well.
	free := ids.New()
	h.accepted(free, "progress", t0, `{"percent":10}`)
	h.accepted(free, "terminal_outcome", t0.Add(10*time.Minute), `{"outcome":"failed"}`)
	h.report(
		free,
		t0.Add(11*time.Minute),
		`{"quantityGrams":"5","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal(
			"J",
		)+`","slotExternalId":"`+slot+`"}`,
		1,
	)
	detail, err := h.logbook.GetRun(ctx, h.principal, free)
	if err != nil || detail.Job != nil || len(detail.Usages) != 1 || detail.Usages[0].Quantity != "5" ||
		detail.Outcome == nil ||
		*detail.Outcome != "failed" {
		t.Fatalf("unassigned run: %+v err=%v", detail, err)
	}
}

// runUsageState counts the usage rows of a run, the active ones, the
// machine_run_consumption ledger rows booked against them and the net grams
// consumed.
func (h *ingestHarness) runUsageState(runID uuid.UUID) (rows, active, ledger int, net string) {
	h.t.Helper()
	err := h.pool.QueryRow(h.t.Context(), `SELECT (SELECT count(*) FROM machine_run_usages WHERE run_id = $1),
		(SELECT count(*) FROM machine_run_usages WHERE run_id = $1 AND active),
		(SELECT count(*) FROM inventory_transactions t JOIN machine_run_usages u ON u.id = t.run_usage_id WHERE u.run_id = $1 AND t.kind = 'machine_run_consumption'),
		(SELECT COALESCE(-sum(t.quantity_delta), 0)::numeric(20,3)::text FROM inventory_transactions t JOIN machine_run_usages u ON u.id = t.run_usage_id WHERE u.run_id = $1)`, runID).Scan(&rows, &active, &ledger, &net)
	if err != nil {
		h.t.Fatal(err)
	}
	return
}

// endedRunWithReport creates an ended run on a fresh spool with a machine
// report of 25 g (revision 1).
func (h *ingestHarness) endedRunWithReport(name string) (runID, spoolID uuid.UUID, slot string, at time.Time) {
	h.t.Helper()
	at = time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	slot = "slot-" + name + "-" + h.suffix
	spoolID = h.mountSpool(name, &slot, at.Add(-time.Hour))
	runID = ids.New()
	h.accepted(runID, "progress", at, `{"state":"printing","percent":10}`)
	h.accepted(runID, "terminal_outcome", at.Add(30*time.Minute), `{"outcome":"completed"}`)
	h.report(
		runID,
		at.Add(31*time.Minute),
		`{"quantityGrams":"25","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal(
			name,
		)+`","slotExternalId":"`+slot+`"}`,
		1,
	)
	if rows, active, ledger, net := h.runUsageState(runID); rows != 1 || active != 1 || ledger != 1 || net != "25.000" {
		h.t.Fatalf("setup usage rows=%d active=%d ledger=%d net=%s", rows, active, ledger, net)
	}
	return
}

func (h *ingestHarness) materialOfSpool(spoolID uuid.UUID) uuid.UUID {
	h.t.Helper()
	var id uuid.UUID
	if err := h.pool.QueryRow(
		h.t.Context(),
		`SELECT material_id FROM filament_spool_fills WHERE spool_id = $1 ORDER BY fill_number DESC LIMIT 1`,
		spoolID,
	).Scan(&id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

// Staff clearing the machine's usage is final: later connector events for the
// run must not book the report again.
func TestIngestDoesNotRebookUsageStaffCleared(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	runID, _, slot, at := h.endedRunWithReport("Clear")
	if _, err := h.logbook.ReplaceRunUsages(ctx, h.principal, runID, h.run(runID).version, nil, nil); err != nil {
		t.Fatal(err)
	}
	rows, active, ledger, net := h.runUsageState(runID)
	if active != 0 || net != "0.000" {
		t.Fatalf("after clear rows=%d active=%d ledger=%d net=%s", rows, active, ledger, net)
	}
	h.accepted(runID, "progress", at.Add(32*time.Minute), `{"percent":100}`)
	h.accepted(runID, "terminal_outcome", at.Add(33*time.Minute), `{"outcome":"completed"}`)
	// A newer report revision must not resurrect the cleared usage either.
	h.report(
		runID,
		at.Add(35*time.Minute),
		`{"quantityGrams":"30","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal(
			"Clear",
		)+`","slotExternalId":"`+slot+`"}`,
		2,
	)
	rows2, active2, ledger2, net2 := h.runUsageState(runID)
	if rows2 != rows || active2 != 0 || ledger2 != ledger || net2 != "0.000" {
		t.Fatalf(
			"usage re-booked: rows %d->%d active=%d ledger %d->%d net=%s",
			rows,
			rows2,
			active2,
			ledger,
			ledger2,
			net2,
		)
	}
}

// Usage that staff entered is never overridden by a newer machine report.
func TestIngestKeepsStaffUsageOverNewerReports(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	runID, spoolID, slot, at := h.endedRunWithReport("Staff")
	materialID := h.materialOfSpool(spoolID)
	staff := []machinelogbook.UsageInput{
		{MaterialID: materialID, SpoolID: &spoolID, Ownership: "makerspace", Quantity: "12", QuantityBasis: "actual"},
	}
	if _, err := h.logbook.ReplaceRunUsages(ctx, h.principal, runID, h.run(runID).version, staff, nil); err != nil {
		t.Fatal(err)
	}
	rows, active, ledger, net := h.runUsageState(runID)
	if active != 1 || net != "12.000" {
		t.Fatalf("after staff usage rows=%d active=%d ledger=%d net=%s", rows, active, ledger, net)
	}
	h.report(
		runID,
		at.Add(40*time.Minute),
		`{"quantityGrams":"40","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal(
			"Staff",
		)+`","slotExternalId":"`+slot+`"}`,
		2,
	)
	rows2, active2, ledger2, net2 := h.runUsageState(runID)
	if rows2 != rows || active2 != 1 || ledger2 != ledger || net2 != "12.000" {
		t.Fatalf(
			"staff usage overridden: rows %d->%d active=%d ledger %d->%d net=%s",
			rows,
			rows2,
			active2,
			ledger,
			ledger2,
			net2,
		)
	}
	var quantity string
	if err := h.pool.QueryRow(
		ctx,
		`SELECT quantity::numeric(20,3)::text FROM machine_run_usages WHERE run_id = $1 AND active`,
		runID,
	).Scan(&quantity); err != nil ||
		quantity != "12.000" {
		t.Fatalf("active quantity = %s err=%v", quantity, err)
	}
}

// A newer report revision replaces an active machine usage exactly once.
func TestIngestReplacesActiveMachineUsageOnce(t *testing.T) {
	h := newIngestHarness(t)
	runID, _, slot, at := h.endedRunWithReport("Once")
	payload := `{"quantityGrams":"18","quantityBasis":"actual","inputUnitExternalId":"` + h.unitExternal(
		"Once",
	) + `","slotExternalId":"` + slot + `"}`
	h.report(runID, at.Add(40*time.Minute), payload, 2)
	rows, active, _, net := h.runUsageState(runID)
	if rows != 2 || active != 1 || net != "18.000" {
		t.Fatalf("after revision 2 rows=%d active=%d net=%s", rows, active, net)
	}
	// Later events for the run must not book the applied report a second time.
	h.accepted(runID, "progress", at.Add(41*time.Minute), `{"percent":100}`)
	h.accepted(runID, "terminal_outcome", at.Add(42*time.Minute), `{"outcome":"completed"}`)
	rows2, active2, _, net2 := h.runUsageState(runID)
	if rows2 != rows || active2 != 1 || net2 != "18.000" {
		t.Fatalf("after later events rows=%d active=%d net=%s", rows2, active2, net2)
	}
}

func TestIngestIgnoresEventsOfADeletedRun(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	runID := ids.New()
	h.accepted(runID, "progress", t0, `{"state":"printing","percent":10,"remainingSeconds":3600}`)
	before := h.run(runID)
	if err := h.logbook.DeleteRun(ctx, h.principal, runID, before.version, false, nil); err != nil {
		t.Fatal(err)
	}
	before = h.run(runID)
	// A running recorded run may be deleted; later reports are stored but change nothing.
	receipt := h.send(runID, "terminal_outcome", t0.Add(time.Hour), `{"outcome":"completed"}`, nil)
	if receipt.Status != "accepted" {
		t.Fatalf("receipt = %+v", receipt)
	}
	after := h.run(runID)
	if after.state != before.state || after.version != before.version || after.ended != nil {
		t.Fatalf("deleted run changed: before=%+v after=%+v", before, after)
	}
	var deleted bool
	var state string
	var reason *string
	if err := h.pool.QueryRow(
		ctx,
		`SELECT r.deleted_at IS NOT NULL, e.application_state, e.application_reason FROM machine_runs r JOIN printer_events e ON e.run_id = r.id WHERE r.id = $1 AND e.kind = 'terminal_outcome'`,
		runID,
	).Scan(&deleted, &state, &reason); err != nil {
		t.Fatal(err)
	}
	if !deleted || state != "recorded" || reason == nil || *reason != "run_deleted" {
		t.Fatalf("deleted=%v state=%s reason=%v", deleted, state, reason)
	}
	// Replays stay duplicates and the run stays out of the observed runs.
	runs, err := h.service.ListObservedRuns(ctx, h.principal, h.connector.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range runs {
		if r.ID == runID {
			t.Fatal("deleted run is listed as observed")
		}
	}
}

func TestClearEventsHidesThemUntilIncluded(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	runID := ids.New()
	h.accepted(runID, "progress", t0, `{"state":"printing","percent":10}`)
	events, err := h.service.ListEvents(ctx, h.principal, h.connector.ID, false)
	if err != nil || len(events) == 0 {
		t.Fatalf("events before clearing: %d %v", len(events), err)
	}
	reader := authorization.Principal{AccountID: h.principal.AccountID}
	if _, err = h.service.ClearEvents(ctx, reader, h.connector.ID, nil); err == nil {
		t.Fatal("clearing needs printer_connectors.manage")
	}
	if _, err = h.service.ClearEvents(ctx, h.principal, ids.New(), nil); err == nil {
		t.Fatal("unknown connector")
	}
	cleared, err := h.service.ClearEvents(ctx, h.principal, h.connector.ID, nil)
	if err != nil || cleared.EventsClearedAt == nil || cleared.EventsClearedByName == nil {
		t.Fatalf("cleared connector: %+v err=%v", cleared, err)
	}
	if events, err = h.service.ListEvents(ctx, h.principal, h.connector.ID, false); err != nil || len(events) != 0 {
		t.Fatalf("events after clearing: %d %v", len(events), err)
	}
	if events, err = h.service.ListEvents(ctx, h.principal, h.connector.ID, true); err != nil || len(events) == 0 {
		t.Fatalf("events with includeCleared: %d %v", len(events), err)
	}
	h.accepted(runID, "progress", t0.Add(time.Minute), `{"state":"printing","percent":20}`)
	if events, err = h.service.ListEvents(ctx, h.principal, h.connector.ID, false); err != nil || len(events) != 1 {
		t.Fatalf("events after new event: %d %v", len(events), err)
	}
	var audits int
	if err = h.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE action = 'printer_connector.events_cleared' AND resource_id = $1`,
		h.connector.ID,
	).Scan(&audits); err != nil ||
		audits != 1 {
		t.Fatalf("audits = %d %v", audits, err)
	}
	got, err := h.service.Get(ctx, h.principal, h.connector.ID)
	if err != nil || got.EventsClearedAt == nil || got.EventsClearedByName == nil {
		t.Fatalf("get: %+v %v", got, err)
	}
}
