package machinelogbook

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

type printHarness struct {
	*jobFixture
	connectorID uuid.UUID
	assignments map[uuid.UUID]uuid.UUID
	sequence    int64
	material    Material // filament material the spool belongs to
	spool       FilamentSpool
}

type runSpec struct {
	machine  uuid.UUID
	state    string
	started  *time.Time
	ended    *time.Time
	fileName string
	percent  *int
	grams    string // reported grams; empty means none
	basis    string
	spool    *uuid.UUID
}

func newPrintHarness(t *testing.T) *printHarness {
	t.Helper()
	f := newJobFixture(t)
	h := &printHarness{jobFixture: f, connectorID: uuid.Must(uuid.NewV7()), assignments: map[uuid.UUID]uuid.UUID{}}
	ctx := t.Context()
	suffix := strings.ReplaceAll(h.connectorID.String(), "-", "")[:12]
	if _, err := f.pool.Exec(ctx, `INSERT INTO printer_connectors (id, name, lifecycle) VALUES ($1, $2, 'active')`, h.connectorID, "Prints connector "+suffix); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, machineID := range []uuid.UUID{f.machine.ID, f.bareMachine.ID} {
			_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_jobs WHERE machine_id = $1`, machineID)
			_, _ = f.pool.Exec(cleanup, `UPDATE printer_observed_runs SET reported_event_id = NULL WHERE machine_id = $1`, machineID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM printer_events WHERE machine_id = $1`, machineID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM printer_observed_runs WHERE machine_id = $1`, machineID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM printer_connector_assignments WHERE machine_id = $1`, machineID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM printer_profiles WHERE machine_id = $1`, machineID)
		}
		_, _ = f.pool.Exec(cleanup, `DELETE FROM printer_connectors WHERE id = $1`, h.connectorID)
		if h.spool.ID != uuid.Nil {
			_, _ = f.pool.Exec(cleanup, `DELETE FROM inventory_transactions WHERE material_id = $1`, h.material.ID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_job_material_usages WHERE spool_id = $1`, h.spool.ID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM filament_spools WHERE id = $1`, h.spool.ID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM materials WHERE id = $1`, h.material.ID)
		}
	})
	for _, machineID := range []uuid.UUID{f.machine.ID, f.bareMachine.ID} {
		assignmentID := uuid.Must(uuid.NewV7())
		if _, err := f.pool.Exec(ctx, `INSERT INTO printer_profiles (machine_id) VALUES ($1)`, machineID); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(ctx, `INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind) VALUES ($1, $2, $3, 'simulator')`, assignmentID, h.connectorID, machineID); err != nil {
			t.Fatal(err)
		}
		h.assignments[machineID] = assignmentID
	}
	// A filament material with one spool; its category and unit match the pricing rule.
	diameter := "1.75"
	var err error
	h.material, err = f.s.CreateMaterialWithFilament(ctx, f.p, "Prints PLA "+suffix, "pla", nil, "g", nil, &diameter, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	total := "20"
	h.spool, err = f.s.CreateFilamentSpool(ctx, f.p, FilamentSpoolInput{MaterialID: h.material.ID, InitialNetWeightG: "1000", StockMode: "new_acquisition", TotalPrice: &total, OccurredAt: f.now, ExpectedInventoryVersion: h.material.InventoryVersion}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func at(base time.Time, offset time.Duration) *time.Time {
	value := base.Truncate(time.Second).Add(offset)
	return &value
}

// insertRun stores an observed run as the connector ingest would have left it.
func (h *printHarness) insertRun(t *testing.T, spec runSpec) uuid.UUID {
	t.Helper()
	ctx := t.Context()
	id := uuid.Must(uuid.NewV7())
	first := h.now.Truncate(time.Second).Add(-5 * time.Hour)
	if spec.started != nil {
		first = *spec.started
	}
	last := first.Add(time.Minute)
	if spec.ended != nil {
		last = *spec.ended
	}
	state := spec.state
	if state == "" {
		state = "completed"
	}
	var fileName any
	if spec.fileName != "" {
		fileName = spec.fileName
	}
	var percent any
	if spec.percent != nil {
		percent = *spec.percent
	}
	if _, err := h.pool.Exec(ctx, `INSERT INTO printer_observed_runs (id, display_id, assignment_id, machine_id, state, first_observed_at, last_observed_at, started_at, ended_at, file_name, progress_percent)
		VALUES ($1, 'PR-2031-' || lpad((('x' || substr(replace($1::uuid::text, '-', ''), 17, 7))::bit(28)::int)::text, 9, '0'), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		id, h.assignments[spec.machine], spec.machine, state, first, last, spec.started, spec.ended, fileName, percent); err != nil {
		t.Fatal(err)
	}
	if spec.grams != "" {
		eventID := h.insertEvent(t, id, spec.machine, "consumption_report", last, `{"quantityGrams":"`+spec.grams+`","quantityBasis":"`+spec.basis+`"}`)
		if _, err := h.pool.Exec(ctx, `UPDATE printer_observed_runs SET reported_quantity_g = $2::numeric, reported_quantity_basis = $3, reported_spool_id = $4, reported_event_id = $5 WHERE id = $1`, id, spec.grams, spec.basis, spec.spool, eventID); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func (h *printHarness) insertEvent(t *testing.T, runID, machineID uuid.UUID, kind string, occurredAt time.Time, payload string) uuid.UUID {
	t.Helper()
	h.sequence++
	id := uuid.Must(uuid.NewV7())
	assignmentID := h.assignments[machineID]
	var revision any
	reconciliation := "not_applicable"
	if kind == "consumption_report" {
		revision, reconciliation = 1, "pending"
	}
	if _, err := h.pool.Exec(t.Context(), `INSERT INTO printer_events (id, source_id, event_key, fingerprint, protocol_version, machine_id, kind, occurred_at, source_sequence, payload,
		reconciliation_state, connector_id, connector_assignment_id, observed_run_id, configuration_version, application_state, report_revision)
		VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, 1, 'applied', $14)`,
		id, "printer-connector:"+assignmentID.String(), id.String(), strings.Repeat("a", 64), machineID, kind, occurredAt, h.sequence, payload, reconciliation, h.connectorID, assignmentID, runID, revision); err != nil {
		t.Fatal(err)
	}
	return id
}

func (h *printHarness) link(t *testing.T, printID uuid.UUID, job MachineJob) MachineJob {
	t.Helper()
	linked, err := h.s.LinkPrintToJob(t.Context(), h.p, printID, job.ID, job.Version, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	return linked
}

func (h *printHarness) quantity(t *testing.T, materialID uuid.UUID) string {
	t.Helper()
	var sum string
	if err := h.pool.QueryRow(t.Context(), `SELECT COALESCE(sum(quantity_delta), 0)::text FROM inventory_transactions WHERE material_id = $1`, materialID).Scan(&sum); err != nil {
		t.Fatal(err)
	}
	value, err := decimal.NewFromString(sum)
	if err != nil {
		t.Fatal(err)
	}
	return value.String()
}

func (h *printHarness) auditCount(t *testing.T, action string, resource uuid.UUID) int {
	t.Helper()
	var count int
	if err := h.pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_events WHERE action = $1 AND resource_id = $2 AND request_id = $3`, action, resource, h.request).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestLinkPrintReplacesTheManualRun(t *testing.T) {
	h := newPrintHarness(t)
	ctx := t.Context()
	started, ended := at(h.now, -3*time.Hour), at(h.now, -90*time.Minute)
	printID := h.insertRun(t, runSpec{machine: h.machine.ID, started: started, ended: ended, fileName: "benchy.gcode", grams: "100", basis: "actual", spool: &h.spool.ID})

	input := h.input(-8*time.Hour, time.Hour, "unknown")
	input.Usages = []UsageInput{{MaterialID: h.jobFixture.material.ID, Quantity: "30"}}
	job := h.create(t, input)
	job = h.adjust(t, job, "discount_percent", "50")
	if price(job.CalculatedPrice) != "13" {
		t.Fatalf("manual calculated = %s", price(job.CalculatedPrice))
	}
	if job.Run != "manual" || job.Print != nil {
		t.Fatalf("manual run = %s print=%+v", job.Run, job.Print)
	}

	linked := h.link(t, printID, job)
	if !linked.StartsAt.Equal(*started) || !linked.EndsAt.Equal(*ended) || linked.Outcome != "successful" || linked.Run != "automatic" {
		t.Fatalf("linked job: starts=%s ends=%s outcome=%s run=%s", linked.StartsAt, linked.EndsAt, linked.Outcome, linked.Run)
	}
	if linked.Print == nil || linked.Print.ID != printID || linked.Print.State != "finished" || linked.Print.FileName == nil || *linked.Print.FileName != "benchy.gcode" {
		t.Fatalf("print reference: %+v", linked.Print)
	}
	if len(linked.Usages) != 1 || linked.Usages[0].SpoolID == nil || *linked.Usages[0].SpoolID != h.spool.ID || linked.Usages[0].Quantity != "100" || linked.Usages[0].QuantityBasis != "actual" || linked.Usages[0].MaterialID == nil || *linked.Usages[0].MaterialID != h.material.ID {
		t.Fatalf("usages: %+v", linked.Usages)
	}
	// 1.5 h at 10/h plus 100 g at 0.1/g, halved by the retained discount.
	if price(linked.CalculatedPrice) != "25" || price(linked.EffectivePrice) != "12.5" || linked.PriceAdjustment == nil {
		t.Fatalf("repriced calculated=%s effective=%s", price(linked.CalculatedPrice), price(linked.EffectivePrice))
	}
	// The manual 30 g went back to stock and the reported 100 g left the spool's material.
	if got := h.quantity(t, h.jobFixture.material.ID); got != "1000" {
		t.Fatalf("manual material quantity = %s", got)
	}
	if got := h.quantity(t, h.material.ID); got != "900" {
		t.Fatalf("spool material quantity = %s", got)
	}
	var compensations int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM inventory_transactions WHERE material_id = $1 AND kind = 'adjustment' AND quantity_delta = 30`, h.jobFixture.material.ID).Scan(&compensations); err != nil || compensations != 1 {
		t.Fatalf("compensating transactions = %d err=%v", compensations, err)
	}
	var state string
	var reconciledBy *uuid.UUID
	if err := h.pool.QueryRow(ctx, `SELECT e.reconciliation_state, e.reconciled_by_account_id FROM printer_events e JOIN printer_observed_runs r ON r.reported_event_id = e.id WHERE r.id = $1`, printID).Scan(&state, &reconciledBy); err != nil || state != "accepted" || reconciledBy == nil || *reconciledBy != h.p.AccountID {
		t.Fatalf("reconciliation state=%s by=%v err=%v", state, reconciledBy, err)
	}
	if h.auditCount(t, "machine_job.print_linked", job.ID) != 1 || h.auditCount(t, "machine_job.usages_replaced", job.ID) != 1 {
		t.Fatal("link audit events are missing")
	}
	var fields []string
	if err := h.pool.QueryRow(ctx, `SELECT changed_fields FROM audit_events WHERE action = 'machine_job.print_linked' AND resource_id = $1 AND request_id = $2`, job.ID, h.request).Scan(&fields); err != nil || len(fields) == 0 {
		t.Fatalf("link audit fields=%v err=%v", fields, err)
	}
	detail, err := h.s.GetPrint(ctx, h.p, printID)
	if err != nil || detail.Job == nil || detail.Job.ID != job.ID || detail.Job.DisplayID != job.DisplayID {
		t.Fatalf("print job reference: %+v err=%v", detail.Job, err)
	}
}

func TestLinkPrintKeepsUsagesWithoutAResolvableSpoolAndKeepsARecordedOutcome(t *testing.T) {
	h := newPrintHarness(t)
	ctx := t.Context()
	started, ended := at(h.now, -3*time.Hour), at(h.now, -2*time.Hour)
	printID := h.insertRun(t, runSpec{machine: h.machine.ID, state: "failed", started: started, ended: ended, grams: "40", basis: "estimated"})

	input := h.input(-8*time.Hour, time.Hour, "partial_failure")
	input.Usages = []UsageInput{{MaterialID: h.jobFixture.material.ID, Quantity: "30"}}
	job := h.create(t, input)
	linked := h.link(t, printID, job)
	if linked.Outcome != "partial_failure" {
		t.Fatalf("recorded outcome was replaced: %s", linked.Outcome)
	}
	if len(linked.Usages) != 1 || linked.Usages[0].Quantity != "30" || linked.Usages[0].SpoolID != nil {
		t.Fatalf("usages were replaced without a spool: %+v", linked.Usages)
	}
	if got := h.quantity(t, h.jobFixture.material.ID); got != "970" {
		t.Fatalf("material quantity = %s", got)
	}
	// 1 h at 10/h plus the kept 30 g at 0.1/g.
	if price(linked.CalculatedPrice) != "13" {
		t.Fatalf("calculated = %s", price(linked.CalculatedPrice))
	}
	var state string
	if err := h.pool.QueryRow(ctx, `SELECT e.reconciliation_state FROM printer_events e JOIN printer_observed_runs r ON r.reported_event_id = e.id WHERE r.id = $1`, printID).Scan(&state); err != nil || state != "pending" {
		t.Fatalf("consumption report state = %s err=%v", state, err)
	}

	// An unknown outcome follows the print state.
	cancelledPrint := h.insertRun(t, runSpec{machine: h.machine.ID, state: "cancelled", started: at(h.now, -6*time.Hour), ended: at(h.now, -5*time.Hour)})
	followed := h.link(t, cancelledPrint, h.create(t, h.input(-8*time.Hour, time.Hour, "unknown")))
	if followed.Outcome != "cancelled" {
		t.Fatalf("derived outcome = %s", followed.Outcome)
	}
	// A zero-length print still yields a positive run.
	instant := h.insertRun(t, runSpec{machine: h.machine.ID, started: at(h.now, -4*time.Hour), ended: at(h.now, -4*time.Hour)})
	short := h.link(t, instant, h.create(t, h.input(-8*time.Hour, time.Hour, "unknown")))
	if short.DurationSeconds != 1 {
		t.Fatalf("duration = %d", short.DurationSeconds)
	}
}

func TestLinkPrintConflictsAndPermissions(t *testing.T) {
	h := newPrintHarness(t)
	ctx := t.Context()
	started, ended := at(h.now, -3*time.Hour), at(h.now, -2*time.Hour)
	printID := h.insertRun(t, runSpec{machine: h.machine.ID, started: started, ended: ended})
	job := h.create(t, h.input(-8*time.Hour, time.Hour, "unknown"))

	if _, err := h.s.LinkPrintToJob(ctx, authorization.Principal{AccountID: h.p.AccountID}, printID, job.ID, job.Version, &h.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("link without edit: %v", err)
	}
	if _, err := h.s.LinkPrintToJob(ctx, h.p, printID, job.ID, job.Version-1, &h.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale link: %v", err)
	}
	if _, err := h.s.LinkPrintToJob(ctx, h.p, uuid.Must(uuid.NewV7()), job.ID, job.Version, &h.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown print: %v", err)
	}
	running := h.insertRun(t, runSpec{machine: h.machine.ID, state: "printing", started: at(h.now, -time.Hour)})
	if _, err := h.s.LinkPrintToJob(ctx, h.p, running, job.ID, job.Version, &h.request); !apperror.IsCode(err, "print_in_progress") {
		t.Fatalf("running print: %v", err)
	}
	otherMachine := h.insertRun(t, runSpec{machine: h.bareMachine.ID, started: started, ended: ended})
	if _, err := h.s.LinkPrintToJob(ctx, h.p, otherMachine, job.ID, job.Version, &h.request); !apperror.IsCode(err, "print_machine_mismatch") {
		t.Fatalf("machine mismatch: %v", err)
	}
	review := h.insertLegacyReviewJob(t, "10")
	if _, err := h.s.LinkPrintToJob(ctx, h.p, printID, review.ID, review.Version, &h.request); !apperror.IsCode(err, "job_not_confirmed") {
		t.Fatalf("unconfirmed job: %v", err)
	}
	// No partial change survives a rejected link.
	unchanged, err := h.s.GetJob(ctx, h.p, job.ID)
	if err != nil || unchanged.Version != job.Version || unchanged.Run != "manual" {
		t.Fatalf("rejected links changed the job: %+v err=%v", unchanged, err)
	}

	linked := h.link(t, printID, job)
	second := h.create(t, h.input(-8*time.Hour, time.Hour, "unknown"))
	if _, err = h.s.LinkPrintToJob(ctx, h.p, printID, second.ID, second.Version, &h.request); !apperror.IsCode(err, "print_already_linked") {
		t.Fatalf("print linked twice: %v", err)
	}
	another := h.insertRun(t, runSpec{machine: h.machine.ID, started: started, ended: ended})
	if _, err = h.s.LinkPrintToJob(ctx, h.p, another, job.ID, linked.Version, &h.request); !apperror.IsCode(err, "job_already_linked") {
		t.Fatalf("job linked twice: %v", err)
	}
}

func TestUnlinkPrintKeepsTheJobValues(t *testing.T) {
	h := newPrintHarness(t)
	ctx := t.Context()
	printID := h.insertRun(t, runSpec{machine: h.machine.ID, started: at(h.now, -3*time.Hour), ended: at(h.now, -2*time.Hour), grams: "100", basis: "actual", spool: &h.spool.ID})
	linked := h.link(t, printID, h.create(t, h.input(-8*time.Hour, time.Hour, "unknown")))

	if _, err := h.s.UnlinkPrint(ctx, authorization.Principal{AccountID: h.p.AccountID}, printID, linked.Version, &h.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("unlink without edit: %v", err)
	}
	if _, err := h.s.UnlinkPrint(ctx, h.p, printID, linked.Version-1, &h.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale unlink: %v", err)
	}
	unlinked, err := h.s.UnlinkPrint(ctx, h.p, printID, linked.Version, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	if unlinked.Run != "manual" || unlinked.Print != nil {
		t.Fatalf("run after unlink = %s print=%+v", unlinked.Run, unlinked.Print)
	}
	if !unlinked.StartsAt.Equal(linked.StartsAt) || !unlinked.EndsAt.Equal(linked.EndsAt) || unlinked.Outcome != linked.Outcome || len(unlinked.Usages) != 1 || unlinked.Usages[0].Quantity != "100" || price(unlinked.CalculatedPrice) != price(linked.CalculatedPrice) {
		t.Fatalf("unlink changed the job: %+v", unlinked)
	}
	if h.auditCount(t, "machine_job.print_unlinked", unlinked.ID) != 1 {
		t.Fatal("unlink audit event is missing")
	}
	if _, err = h.s.UnlinkPrint(ctx, h.p, printID, unlinked.Version, &h.request); !apperror.IsCode(err, "print_not_linked") {
		t.Fatalf("second unlink: %v", err)
	}
	if _, err = h.s.UnlinkPrint(ctx, h.p, uuid.Must(uuid.NewV7()), 1, &h.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown print: %v", err)
	}
	// The print can be linked again after the unlink.
	h.link(t, printID, h.create(t, h.input(-8*time.Hour, time.Hour, "unknown")))
}

func TestCreateJobFromPrint(t *testing.T) {
	h := newPrintHarness(t)
	ctx := t.Context()
	printID := h.insertRun(t, runSpec{machine: h.machine.ID, state: "failed", started: at(h.now, -3*time.Hour), ended: at(h.now, -2*time.Hour)})
	title := "From the printer"
	input := PrintJobInput{Title: &title, Customer: PartyReference{Kind: "person", ID: h.person}, OperatorPersonID: h.person, PricingGroupID: &h.group.ID, Usages: []UsageInput{{MaterialID: h.jobFixture.material.ID, Quantity: "10"}}}

	if _, err := h.s.CreateJobFromPrint(ctx, authorization.Principal{AccountID: h.p.AccountID}, printID, input, &h.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("create without permission: %v", err)
	}
	running := h.insertRun(t, runSpec{machine: h.machine.ID, state: "printing", started: at(h.now, -time.Hour)})
	if _, err := h.s.CreateJobFromPrint(ctx, h.p, running, input, &h.request); !apperror.IsCode(err, "print_in_progress") {
		t.Fatalf("running print: %v", err)
	}
	job, err := h.s.CreateJobFromPrint(ctx, h.p, printID, input, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	if job.Machine.ID != h.machine.ID || job.Outcome != "failed" || job.Run != "automatic" || job.Print == nil || job.Print.ID != printID || job.DurationSeconds != 3600 || job.Title == nil || *job.Title != title || job.ReviewState != "confirmed" {
		t.Fatalf("created job: %+v", job)
	}
	// 1 h at 10/h plus 10 g at 0.1/g.
	if price(job.CalculatedPrice) != "11" {
		t.Fatalf("calculated = %s", price(job.CalculatedPrice))
	}
	if h.auditCount(t, "machine_job.created", job.ID) != 1 || h.auditCount(t, "machine_job.print_linked", job.ID) != 1 {
		t.Fatal("create audit events are missing")
	}
	if _, err = h.s.CreateJobFromPrint(ctx, h.p, printID, input, &h.request); !apperror.IsCode(err, "print_already_linked") {
		t.Fatalf("second create: %v", err)
	}
	explicit := "partial_failure"
	input.Outcome = &explicit
	other := h.insertRun(t, runSpec{machine: h.machine.ID, started: at(h.now, -6*time.Hour), ended: at(h.now, -5*time.Hour)})
	job, err = h.s.CreateJobFromPrint(ctx, h.p, other, input, &h.request)
	if err != nil || job.Outcome != "partial_failure" {
		t.Fatalf("explicit outcome: %+v err=%v", job, err)
	}
}

func TestListAndGetPrints(t *testing.T) {
	h := newPrintHarness(t)
	ctx := t.Context()
	token := strings.ReplaceAll(h.connectorID.String(), "-", "")[:8]
	percent := 100
	finished := h.insertRun(t, runSpec{machine: h.machine.ID, started: at(h.now, -6*time.Hour), ended: at(h.now, -5*time.Hour), fileName: "gear_" + token + ".gcode", percent: &percent, grams: "12.5", basis: "estimated", spool: &h.spool.ID})
	failed := h.insertRun(t, runSpec{machine: h.machine.ID, state: "failed", started: at(h.now, -4*time.Hour), ended: at(h.now, -3*time.Hour), fileName: "vase_" + token + ".gcode"})
	running := h.insertRun(t, runSpec{machine: h.machine.ID, state: "printing", started: at(h.now, -time.Hour), fileName: "lid_" + token + ".gcode"})
	h.insertRun(t, runSpec{machine: h.bareMachine.ID, state: "uncertain", started: at(h.now, -2*time.Hour), ended: at(h.now, -time.Hour)})
	linked := h.link(t, finished, h.create(t, h.input(-9*time.Hour, time.Hour, "unknown")))

	list := func(filters PrintFilters) []Print {
		t.Helper()
		filters.Page, filters.PageSize = 1, 50
		items, _, err := h.s.ListPrints(ctx, h.p, filters)
		if err != nil {
			t.Fatal(err)
		}
		return items
	}
	machine := h.machine.ID
	all := list(PrintFilters{MachineID: &machine})
	if len(all) != 3 || all[0].ID != running || all[1].ID != failed || all[2].ID != finished {
		t.Fatalf("newest first: %+v", all)
	}
	if all[2].Job == nil || all[2].Job.ID != linked.ID || all[2].ReportedUsage == nil || all[2].ReportedUsage.SpoolDisplayID == nil || *all[2].ReportedUsage.SpoolDisplayID != h.spool.DisplayID || all[2].ReportedUsage.MaterialName == nil || *all[2].ReportedUsage.MaterialName != h.material.Name || all[2].State != "finished" || all[2].ConnectorName == nil {
		t.Fatalf("finished print: %+v", all[2])
	}
	if all[0].State != "printing" || all[1].State != "failed" || all[0].Job != nil {
		t.Fatalf("states: %s %s", all[0].State, all[1].State)
	}
	no, yes := false, true
	if items := list(PrintFilters{MachineID: &machine, Linked: &no}); len(items) != 2 {
		t.Fatalf("unlinked prints = %d", len(items))
	}
	if items := list(PrintFilters{MachineID: &machine, Linked: &yes}); len(items) != 1 || items[0].ID != finished {
		t.Fatalf("linked prints = %+v", items)
	}
	state := "failed"
	if items := list(PrintFilters{MachineID: &machine, State: &state}); len(items) != 1 || items[0].ID != failed {
		t.Fatalf("failed filter = %+v", items)
	}
	state = "printing"
	if items := list(PrintFilters{MachineID: &machine, State: &state}); len(items) != 1 || items[0].ID != running {
		t.Fatalf("printing filter = %+v", items)
	}
	state = "unknown"
	bare := h.bareMachine.ID
	if items := list(PrintFilters{MachineID: &bare, State: &state}); len(items) != 1 {
		t.Fatalf("unknown filter = %+v", items)
	}
	if items := list(PrintFilters{Search: "VASE_" + token}); len(items) != 1 || items[0].ID != failed {
		t.Fatalf("file search = %+v", items)
	}
	if items := list(PrintFilters{Search: all[2].DisplayID}); len(items) != 1 || items[0].ID != finished {
		t.Fatalf("display id search = %+v", items)
	}
	if items := list(PrintFilters{Search: "%"}); len(items) != 0 {
		t.Fatalf("wildcard search matched %d prints", len(items))
	}
	from, to := h.now.Add(-4*time.Hour-time.Minute), h.now.Add(-2*time.Hour)
	if items := list(PrintFilters{MachineID: &machine, From: &from, To: &to}); len(items) != 1 || items[0].ID != failed {
		t.Fatalf("time filter = %+v", items)
	}
	state = "bogus"
	if _, _, err := h.s.ListPrints(ctx, h.p, PrintFilters{State: &state, Page: 1, PageSize: 10}); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("bogus state: %v", err)
	}
	if _, _, err := h.s.ListPrints(ctx, authorization.Principal{AccountID: h.p.AccountID}, PrintFilters{Page: 1, PageSize: 10}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("list without read: %v", err)
	}

	h.insertEvent(t, finished, h.machine.ID, "progress", *at(h.now, -330*time.Minute), `{"state":"printing","percent":40,"fileName":"gear.gcode","apiKey":"SECRET-VALUE"}`)
	h.insertEvent(t, finished, h.machine.ID, "terminal_outcome", *at(h.now, -5*time.Hour), `{"outcome":"completed","note":"SECRET-VALUE"}`)
	detail, err := h.s.GetPrint(ctx, h.p, finished)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Events) != 3 || detail.Events[0].Kind != "progress" || detail.Events[0].ProgressPercent == nil || *detail.Events[0].ProgressPercent != 40 || detail.Events[0].State == nil || *detail.Events[0].State != "printing" {
		t.Fatalf("events: %+v", detail.Events)
	}
	if report := detail.Events[1]; report.Kind != "consumption_report" || report.Quantity == nil || *report.Quantity != "12.5" {
		t.Fatalf("report event: %+v", report)
	}
	if terminal := detail.Events[2]; terminal.Kind != "terminal_outcome" || terminal.State == nil || *terminal.State != "completed" {
		t.Fatalf("terminal event: %+v", terminal)
	}
	encoded, err := json.Marshal(detail)
	if err != nil || strings.Contains(string(encoded), "SECRET-VALUE") {
		t.Fatalf("raw payload leaked: %s err=%v", encoded, err)
	}
	if _, err = h.s.GetPrint(ctx, authorization.Principal{AccountID: h.p.AccountID}, finished); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("get without read: %v", err)
	}
	if _, err = h.s.GetPrint(ctx, h.p, uuid.Must(uuid.NewV7())); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown print: %v", err)
	}
}

func TestCancelRunRejectsAJobLinkedToAPrint(t *testing.T) {
	h := newPrintHarness(t)
	printID := h.insertRun(t, runSpec{machine: h.machine.ID, started: at(h.now, -3*time.Hour), ended: at(h.now, -2*time.Hour)})
	// The job's own run is still in progress until the print replaces it with
	// a run in the future of the clock.
	job := h.link(t, printID, h.create(t, h.input(-8*time.Hour, time.Hour, "unknown")))
	if _, err := h.pool.Exec(t.Context(), `UPDATE machine_jobs SET outcome = 'unknown', ends_at = $2 WHERE id = $1`, job.ID, h.now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.s.CancelJobRun(t.Context(), h.p, job.ID, job.Version, &h.request); !apperror.IsCode(err, "run_not_running") {
		t.Fatalf("cancel of linked job: %v", err)
	}
}
