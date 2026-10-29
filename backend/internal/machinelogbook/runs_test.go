package machinelogbook

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

type runHarness struct {
	*jobFixture
	connectorID uuid.UUID
	assignments map[uuid.UUID]uuid.UUID
	sequence    int64
	revision    int      // report revision of the next consumption_report event; 0 means 1
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

func newRunHarness(t *testing.T) *runHarness { return newRunHarnessAt(t, jobsClock) }

// newLiveRunHarness runs on the real clock for tests that need running runs.
func newLiveRunHarness(t *testing.T) *runHarness {
	return newRunHarnessAt(t, time.Now().UTC().Truncate(time.Second))
}

func newRunHarnessAt(t *testing.T, now time.Time) *runHarness {
	t.Helper()
	f := newJobFixtureAt(t, now)
	h := &runHarness{jobFixture: f, connectorID: ids.New(), assignments: map[uuid.UUID]uuid.UUID{}}
	ctx := t.Context()
	suffix := strings.ReplaceAll(h.connectorID.String(), "-", "")[:12]
	if _, err := f.pool.Exec(
		ctx,
		`INSERT INTO printer_connectors (id, name, lifecycle) VALUES ($1, $2, 'active')`,
		h.connectorID,
		"Prints connector "+suffix,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, machineID := range []uuid.UUID{f.machine.ID, f.bareMachine.ID} {
			_, _ = f.pool.Exec(
				cleanup,
				`DELETE FROM machine_runs WHERE machine_id = $1 AND source = 'manual'`,
				machineID,
			)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_jobs WHERE machine_id = $1`, machineID)
			_, _ = f.pool.Exec(
				cleanup,
				`UPDATE machine_runs SET reported_event_id = NULL WHERE machine_id = $1`,
				machineID,
			)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM printer_events WHERE machine_id = $1`, machineID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_runs WHERE machine_id = $1`, machineID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM printer_connector_assignments WHERE machine_id = $1`, machineID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM printer_profiles WHERE machine_id = $1`, machineID)
		}
		_, _ = f.pool.Exec(cleanup, `DELETE FROM printer_connectors WHERE id = $1`, h.connectorID)
		if h.spool.ID != uuid.Nil {
			_, _ = f.pool.Exec(cleanup, `DELETE FROM inventory_transactions WHERE material_id = $1`, h.material.ID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_run_usages WHERE spool_id = $1`, h.spool.ID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM filament_spools WHERE id = $1`, h.spool.ID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM materials WHERE id = $1`, h.material.ID)
		}
	})
	for _, machineID := range []uuid.UUID{f.machine.ID, f.bareMachine.ID} {
		assignmentID := ids.New()
		if _, err := f.pool.Exec(ctx, `INSERT INTO printer_profiles (machine_id) VALUES ($1)`, machineID); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(
			ctx,
			`INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind) VALUES ($1, $2, $3, 'simulator')`,
			assignmentID,
			h.connectorID,
			machineID,
		); err != nil {
			t.Fatal(err)
		}
		h.assignments[machineID] = assignmentID
	}
	// A filament material with one spool; its material type has the pricing rule.
	diameter := "1.75"
	var err error
	h.material, err = f.s.CreateMaterial(
		ctx,
		f.p,
		MaterialInput{Name: "Prints PLA " + suffix, MaterialTypeID: f.materialType.ID, FilamentDiameterMM: &diameter},
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	total := "20"
	h.spool, err = f.s.CreateFilamentSpool(
		ctx,
		f.p,
		FilamentSpoolInput{
			MaterialID:               h.material.ID,
			InitialNetWeightG:        "1000",
			StockMode:                "new_acquisition",
			TotalPrice:               &total,
			OccurredAt:               f.now,
			ExpectedInventoryVersion: h.material.InventoryVersion,
		},
		&f.request,
	)
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
func (h *runHarness) insertRun(t *testing.T, spec runSpec) uuid.UUID {
	t.Helper()
	ctx := t.Context()
	id := ids.New()
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
		state = "finished"
	}
	var fileName any
	if spec.fileName != "" {
		fileName = spec.fileName
	}
	var percent any
	if spec.percent != nil {
		percent = *spec.percent
	}
	if _, err := h.pool.Exec(ctx, `INSERT INTO machine_runs (id, display_id, source, assignment_id, machine_id, state, first_observed_at, last_observed_at, started_at, ended_at, file_name, progress_percent)
		VALUES ($1, 'R-2031-' || lpad((('x' || substr(replace($1::uuid::text, '-', ''), 17, 7))::bit(28)::int)::text, 9, '0'), 'recorded', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		id,
		h.assignments[spec.machine],
		spec.machine,
		state,
		first,
		last,
		spec.started,
		spec.ended,
		fileName,
		percent); err != nil {
		t.Fatal(err)
	}
	if spec.grams != "" {
		eventID := h.insertEvent(
			t,
			id,
			spec.machine,
			"consumption_report",
			last,
			`{"quantityGrams":"`+spec.grams+`","quantityBasis":"`+spec.basis+`"}`,
		)
		if _, err := h.pool.Exec(
			ctx,
			`UPDATE machine_runs SET reported_quantity_g = $2::numeric, reported_quantity_basis = $3, reported_spool_id = $4, reported_event_id = $5 WHERE id = $1`,
			id,
			spec.grams,
			spec.basis,
			spec.spool,
			eventID,
		); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func (h *runHarness) insertEvent(
	t *testing.T,
	runID, machineID uuid.UUID,
	kind RunEventKind,
	occurredAt time.Time,
	payload string,
) uuid.UUID {
	t.Helper()
	h.sequence++
	id := ids.New()
	assignmentID := h.assignments[machineID]
	var revision any
	if kind == "consumption_report" {
		revision = 1
		if h.revision > 0 {
			revision = h.revision
		}
	}
	if _, err := h.pool.Exec(t.Context(), `INSERT INTO printer_events (id, source_id, event_key, fingerprint, protocol_version, machine_id, kind, occurred_at, source_sequence, payload,
		connector_id, connector_assignment_id, run_id, configuration_version, application_state, report_revision)
		VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, 1, 'applied', $13)`,
		id,
		"printer-connector:"+assignmentID.String(),
		id.String(),
		strings.Repeat("a", 64),
		machineID,
		kind,
		occurredAt,
		h.sequence,
		payload,
		h.connectorID,
		assignmentID,
		runID,
		revision); err != nil {
		t.Fatal(err)
	}
	return id
}

// report stores a newer consumption report on the run like the ingest would.
func (h *runHarness) report(t *testing.T, runID, machineID uuid.UUID, grams string, revision int, spool uuid.UUID) {
	t.Helper()
	h.revision = revision
	eventID := h.insertEvent(
		t,
		runID,
		machineID,
		"consumption_report",
		h.now,
		`{"quantityGrams":"`+grams+`","quantityBasis":"actual"}`,
	)
	h.revision = 0
	if _, err := h.pool.Exec(
		t.Context(),
		`UPDATE machine_runs SET reported_quantity_g = $2::numeric, reported_quantity_basis = 'actual', reported_spool_id = $3, reported_event_id = $4 WHERE id = $1`,
		runID,
		grams,
		spool,
		eventID,
	); err != nil {
		t.Fatal(err)
	}
}

// finish ends a running recorded run the way a terminal event does.
func (h *runHarness) finish(t *testing.T, runID uuid.UUID, state string, ended time.Time) {
	t.Helper()
	if _, err := h.pool.Exec(
		t.Context(),
		`UPDATE machine_runs SET state = $2, ended_at = $3, version = version + 1 WHERE id = $1`,
		runID,
		state,
		ended,
	); err != nil {
		t.Fatal(err)
	}
}

// apply runs the logbook's reaction to a connector event in its own transaction.
func (h *runHarness) apply(t *testing.T, runID uuid.UUID, kind RunEventKind) RecordedRunChange {
	t.Helper()
	tx, err := h.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	change, err := h.s.ApplyRecordedRunEvent(t.Context(), tx, RecordedRunEvent{RunID: runID, Kind: string(kind)})
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	return change
}

func (h *runHarness) attach(t *testing.T, runID uuid.UUID, job MachineJob, replace bool) MachineJob {
	t.Helper()
	attached, err := h.s.AttachRun(t.Context(), h.p, runID, job.ID, replace, job.Version, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	return attached
}

func (h *runHarness) run(t *testing.T, id uuid.UUID) MachineRun {
	t.Helper()
	d, err := h.s.GetRun(t.Context(), h.p, id)
	if err != nil {
		t.Fatal(err)
	}
	return d.MachineRun
}

func (h *runHarness) auditCount(t *testing.T, action string, resource uuid.UUID) int {
	t.Helper()
	var count int
	if err := h.pool.QueryRow(
		t.Context(),
		`SELECT count(*) FROM audit_events WHERE action = $1 AND resource_id = $2`,
		action,
		resource,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestAttachRunReplacingManualRunsReversesTheirMaterial(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	started, ended := at(h.now, -3*time.Hour), at(h.now, -90*time.Minute)
	runID := h.insertRun(
		t,
		runSpec{
			machine:  h.machine.ID,
			started:  started,
			ended:    ended,
			fileName: "benchy.gcode",
			grams:    "100",
			basis:    "actual",
			spool:    &h.spool.ID,
		},
	)
	h.finish(t, runID, "finished", *ended)

	input := h.input(-8*time.Hour, time.Hour, "unknown")
	input.Usages = []UsageInput{{MaterialID: h.jobFixture.material.ID, Quantity: "30"}}
	job := h.create(t, input)
	job = h.adjust(t, job, "discount_percent", "50")
	if price(job.CalculatedPrice) != "13" {
		t.Fatalf("manual calculated = %s", price(job.CalculatedPrice))
	}
	first := job.Runs[0]
	if _, err := h.s.AttachRun(
		ctx,
		authorization.Principal{AccountID: h.p.AccountID},
		runID,
		job.ID,
		true,
		job.Version,
		&h.request,
	); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("attach without edit: %v", err)
	}
	if _, err := h.s.AttachRun(ctx, h.p, runID, job.ID, true, job.Version+1, &h.request); !apperror.IsCode(
		err,
		"stale_write",
	) {
		t.Fatalf("stale attach: %v", err)
	}
	other := h.insertRun(t, runSpec{machine: h.bareMachine.ID, started: started, ended: ended})
	if _, err := h.s.AttachRun(ctx, h.p, other, job.ID, true, job.Version, &h.request); !apperror.IsCode(
		err,
		"run_machine_mismatch",
	) {
		t.Fatalf("machine mismatch: %v", err)
	}
	if _, err := h.s.AttachRun(
		ctx,
		h.p,
		ids.New(),
		job.ID,
		true,
		job.Version,
		&h.request,
	); !apperror.IsCode(
		err,
		"not_found",
	) {
		t.Fatalf("unknown run: %v", err)
	}

	linked := h.attach(t, runID, job, true)
	if len(linked.Runs) != 2 || linked.Runs[0].ID != first.ID || linked.Runs[0].State != "replaced" ||
		linked.Runs[1].ID != runID {
		t.Fatalf("runs after attach: %+v", linked.Runs)
	}
	if linked.StartedAt == nil || !linked.StartedAt.Equal(*started) || linked.EndedAt == nil ||
		!linked.EndedAt.Equal(*ended) ||
		linked.Outcome != "unknown" ||
		linked.Status != "needs_outcome" {
		t.Fatalf(
			"job after attach: started=%v ended=%v outcome=%s status=%s",
			linked.StartedAt,
			linked.EndedAt,
			linked.Outcome,
			linked.Status,
		)
	}
	// The recorded run has no automatic usage yet (no connector event ran), so only its runtime counts: 1.5 h.
	if price(linked.CalculatedPrice) != "15" || price(linked.EffectivePrice) != "7.5" || len(linked.Usages) != 0 {
		t.Fatalf(
			"repriced calculated=%s effective=%s usages=%d",
			price(linked.CalculatedPrice),
			price(linked.EffectivePrice),
			len(linked.Usages),
		)
	}
	if got := h.quantity(t, h.jobFixture.material.ID); got != "1000" {
		t.Fatalf("manual material quantity = %s", got)
	}
	var compensations int
	if err := h.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM inventory_transactions WHERE material_id = $1 AND kind = 'adjustment' AND quantity_delta = 30`,
		h.jobFixture.material.ID,
	).Scan(&compensations); err != nil ||
		compensations != 1 {
		t.Fatalf("compensating transactions = %d err=%v", compensations, err)
	}
	if h.auditCount(t, "machine_job.run_attached", job.ID) != 1 {
		t.Fatal("attach audit is missing")
	}
	if _, err := h.s.AttachRun(ctx, h.p, runID, job.ID, false, linked.Version, &h.request); !apperror.IsCode(
		err,
		"run_already_assigned",
	) {
		t.Fatalf("second attach: %v", err)
	}
}

func TestConnectorEventsSettleOutcomeUsageAndJob(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	started := at(h.now, -2*time.Hour)
	runID := h.insertRun(t, runSpec{machine: h.machine.ID, state: "running", started: started, fileName: "live.gcode"})
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE machine_runs SET estimated_end_at = $2 WHERE id = $1`,
		runID,
		h.now.Add(time.Hour),
	); err != nil {
		t.Fatal(err)
	}
	// A running recorded run can be attached mid-run: the job is running.
	job := h.attach(t, runID, h.create(t, h.input(-2*time.Hour, time.Hour, "unknown")), true)
	if job.Status != "running" || job.Outcome != "unknown" || job.EndedAt != nil {
		t.Fatalf("job with a running run: status=%s ended=%v", job.Status, job.EndedAt)
	}
	// Progress refreshes the price without a new version.
	h.apply(t, runID, "progress")
	progressed, err := h.s.GetJob(ctx, h.p, job.ID)
	if err != nil || progressed.Version != job.Version || progressed.Status != "running" {
		t.Fatalf("progress changed the job version: %v %d vs %d", err, progressed.Version, job.Version)
	}

	// The machine reports the end and its consumption; a connector event settles the run and its job.
	ended := h.now.Truncate(time.Second).Add(-10 * time.Minute)
	h.finish(t, runID, "finished", ended)
	h.report(t, runID, h.machine.ID, "100", 1, h.spool.ID)
	change := h.apply(t, runID, "terminal_outcome")
	settled, err := h.s.GetJob(ctx, h.p, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	run := h.run(t, runID)
	if settled.Status != "successful" || settled.Version <= job.Version || run.Outcome == nil ||
		*run.Outcome != "successful" ||
		!run.OutcomeFromMachine ||
		!run.UsagesFromMachine ||
		len(run.Usages) != 1 ||
		run.Usages[0].Quantity != "100" ||
		run.Usages[0].SpoolID == nil ||
		*run.Usages[0].SpoolID != h.spool.ID {
		t.Fatalf("settled: job=%s run=%+v", settled.Status, run)
	}
	// 1 h 50 m at 10/h plus 100 g at 0.1/g.
	if price(settled.CalculatedPrice) != "28.33" {
		t.Fatalf("calculated = %s", price(settled.CalculatedPrice))
	}
	if got := h.quantity(t, h.material.ID); got != "900" {
		t.Fatalf("spool material quantity = %s", got)
	}
	// The change is reported to the connector's activity log, not audited.
	if change.RunID != runID || !slices.Contains(change.RunFields, "outcome") ||
		!slices.Contains(change.RunFields, "usages") || change.JobID == nil || *change.JobID != job.ID ||
		!slices.Contains(change.JobFields, "effectivePrice") {
		t.Fatalf("reported change: %+v", change)
	}
	var audited int
	if err = h.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE resource_id IN ($1, $2) AND actor_type = 'system'`,
		job.ID,
		runID,
	).Scan(&audited); err != nil || audited != 0 {
		t.Fatalf("automatic run changes were audited: %d %v", audited, err)
	}
	// A repeated event does not consume twice.
	h.apply(t, runID, "consumption_report")
	if got := h.quantity(t, h.material.ID); got != "900" {
		t.Fatalf("double consumption: %s", got)
	}
	// A later report replaces the machine's usage with compensating transactions.
	h.report(t, runID, h.machine.ID, "80", 2, h.spool.ID)
	h.apply(t, runID, "consumption_report")
	run = h.run(t, runID)
	if len(run.Usages) != 1 || run.Usages[0].Quantity != "80" {
		t.Fatalf("replaced usage: %+v", run.Usages)
	}
	if got := h.quantity(t, h.material.ID); got != "920" {
		t.Fatalf("spool material quantity after the second report = %s", got)
	}
	// Staff corrections win over later reports and change outcomeFromMachine.
	patched, err := h.s.UpdateRun(
		ctx,
		h.p,
		runID,
		run.Version,
		RunUpdate{Outcome: outcomePtr("partial_failure")},
		&h.request,
	)
	if err != nil || patched.Run.OutcomeFromMachine || patched.Job.Outcome != "partial_failure" {
		t.Fatalf("patched recorded run: %v %+v", err, patched.Run)
	}
	if _, err = h.s.UpdateRun(
		ctx,
		h.p,
		runID,
		patched.Run.Version,
		RunUpdate{StartsAt: &ended, EndsAt: &ended},
		&h.request,
	); !apperror.IsCode(
		err,
		"run_times_read_only",
	) {
		t.Fatalf("times of a recorded run: %v", err)
	}
	staff, err := h.s.ReplaceRunUsages(
		ctx,
		h.p,
		runID,
		patched.Run.Version,
		[]UsageInput{{MaterialID: h.material.ID, SpoolID: &h.spool.ID, Quantity: "70"}},
		&h.request,
	)
	if err != nil || staff.Run.UsagesFromMachine {
		t.Fatalf("staff usage: %v %+v", err, staff.Run)
	}
	h.report(t, runID, h.machine.ID, "60", 3, h.spool.ID)
	h.apply(t, runID, "consumption_report")
	if run = h.run(t, runID); len(run.Usages) != 1 || run.Usages[0].Quantity != "70" {
		t.Fatalf("a report replaced usage entered by staff: %+v", run.Usages)
	}
}

func TestUnassignedRecordedRunConsumesAndCanBecomeAJob(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	started := at(h.now, -3*time.Hour)
	runID := h.insertRun(t, runSpec{machine: h.machine.ID, state: "running", started: started, fileName: "x.gcode"})
	// Create a job from the run while it still runs.
	title := "From the machine"
	in := RunJobInput{
		Title:            &title,
		Customer:         PartyReference{Kind: "person", ID: h.person},
		OperatorPersonID: h.person,
		PricingGroupID:   &h.group.ID,
	}
	if _, err := h.s.CreateJobFromRun(
		ctx,
		authorization.Principal{AccountID: h.p.AccountID},
		runID,
		in,
		&h.request,
	); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("create without permission: %v", err)
	}
	// Consumption also happens when the run has no job.
	ended := h.now.Truncate(time.Second).Add(-time.Hour)
	other := h.insertRun(t, runSpec{machine: h.machine.ID, state: "running", started: started})
	h.finish(t, other, "finished", ended)
	h.report(t, other, h.machine.ID, "40", 1, h.spool.ID)
	h.apply(t, other, "terminal_outcome")
	if run := h.run(t, other); len(run.Usages) != 1 || run.Usages[0].Quantity != "40" || !run.UsagesFromMachine ||
		run.Job != nil {
		t.Fatalf("unassigned run: %+v", run)
	}
	if got := h.quantity(t, h.material.ID); got != "960" {
		t.Fatalf("spool material quantity = %s", got)
	}

	job, err := h.s.CreateJobFromRun(ctx, h.p, runID, in, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != "running" || len(job.Runs) != 1 || job.Runs[0].ID != runID || job.Machine.ID != h.machine.ID ||
		job.Title == nil {
		t.Fatalf("job from running run: %+v", job)
	}
	if _, err = h.s.CreateJobFromRun(ctx, h.p, runID, in, &h.request); !apperror.IsCode(err, "run_already_assigned") {
		t.Fatalf("second create: %v", err)
	}
	if _, err = h.s.CreateJobFromRun(ctx, h.p, ids.New(), in, &h.request); !apperror.IsCode(
		err,
		"not_found",
	) {
		t.Fatalf("unknown run: %v", err)
	}
}

func TestDetachRun(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	started, ended := at(h.now, -3*time.Hour), at(h.now, -2*time.Hour)
	runID := h.insertRun(
		t,
		runSpec{
			machine: h.machine.ID,
			started: started,
			ended:   ended,
			grams:   "100",
			basis:   "actual",
			spool:   &h.spool.ID,
		},
	)
	h.finish(t, runID, "finished", *ended)
	h.attach(t, runID, h.create(t, h.input(-8*time.Hour, time.Hour, "unknown")), true)
	job := func() MachineJob {
		j, err := h.s.UpdateRun(
			ctx,
			h.p,
			runID,
			h.run(t, runID).Version,
			RunUpdate{Outcome: outcomePtr("failed")},
			&h.request,
		)
		if err != nil {
			t.Fatal(err)
		}
		return *j.Job
	}()
	if _, err := h.s.DetachRun(
		ctx,
		authorization.Principal{AccountID: h.p.AccountID},
		runID,
		job.Version,
		&h.request,
	); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("detach without edit: %v", err)
	}
	if _, err := h.s.DetachRun(ctx, h.p, runID, job.Version+1, &h.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale detach: %v", err)
	}
	if _, err := h.s.DetachRun(ctx, h.p, job.Runs[0].ID, job.Version, &h.request); !apperror.IsCode(
		err,
		"run_not_recorded",
	) {
		t.Fatalf("detach of a manual run: %v", err)
	}
	detached, err := h.s.DetachRun(ctx, h.p, runID, job.Version, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	// The last run was detached: the job gets a manual copy of start, end and outcome, without material.
	var manual *MachineRun
	for i := range detached.Runs {
		if detached.Runs[i].Source == "manual" && detached.Runs[i].State != "replaced" {
			manual = &detached.Runs[i]
		}
	}
	if manual == nil || !manual.StartedAt.Equal(*started) || manual.EndedAt == nil || !manual.EndedAt.Equal(*ended) ||
		manual.Outcome == nil ||
		*manual.Outcome != "failed" ||
		len(manual.Usages) != 0 ||
		detached.Status != "failed" {
		t.Fatalf("manual copy: %+v job=%s", manual, detached.Status)
	}
	run := h.run(t, runID)
	if run.Job != nil || run.Outcome == nil {
		t.Fatalf("detached run: %+v", run)
	}
	if h.auditCount(t, "machine_job.run_detached", job.ID) != 1 {
		t.Fatal("detach audit is missing")
	}
	if _, err = h.s.DetachRun(ctx, h.p, runID, detached.Version, &h.request); !apperror.IsCode(
		err,
		"run_not_assigned",
	) {
		t.Fatalf("second detach: %v", err)
	}
}

func TestListAndGetRuns(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	token := strings.ReplaceAll(h.connectorID.String(), "-", "")[:8]
	finished := h.insertRun(
		t,
		runSpec{
			machine:  h.machine.ID,
			started:  at(h.now, -6*time.Hour),
			ended:    at(h.now, -5*time.Hour),
			fileName: "gear_" + token + ".gcode",
			grams:    "12.5",
			basis:    "estimated",
			spool:    &h.spool.ID,
		},
	)
	h.finish(t, finished, "finished", *at(h.now, -5*time.Hour))
	running := h.insertRun(
		t,
		runSpec{
			machine:  h.machine.ID,
			state:    "running",
			started:  at(h.now, -time.Hour),
			fileName: "lid_" + token + ".gcode",
		},
	)
	manual := h.create(t, h.input(-9*time.Hour, time.Hour, "successful"))
	job := h.attach(t, finished, manual, false)

	list := func(filters RunFilters) []MachineRun {
		t.Helper()
		filters.Page, filters.PageSize = 1, 50
		filters.MachineID = &h.machine.ID
		items, _, err := h.s.ListRuns(ctx, h.p, filters)
		if err != nil {
			t.Fatal(err)
		}
		return items
	}
	if items := list(RunFilters{}); len(items) != 3 || items[0].ID != running {
		t.Fatalf("newest first: %+v", items)
	}
	recorded, no, yes := RunSourceRecorded, false, true
	if items := list(RunFilters{Source: &recorded, Assigned: &no}); len(items) != 1 || items[0].ID != running ||
		items[0].State != "running" {
		t.Fatalf("unassigned recorded = %+v", items)
	}
	if items := list(RunFilters{Assigned: &yes}); len(items) != 2 {
		t.Fatalf("assigned = %d", len(items))
	}
	if items := list(RunFilters{States: []RunState{"finished"}, Source: &recorded}); len(items) != 1 ||
		items[0].ID != finished ||
		items[0].Job == nil ||
		items[0].Job.ID != job.ID ||
		items[0].ReportedUsage == nil ||
		items[0].ReportedUsage.MaterialName == nil {
		t.Fatalf("finished recorded = %+v", items)
	}
	if items := list(RunFilters{Search: "LID_" + token}); len(items) != 1 || items[0].ID != running {
		t.Fatalf("file search = %+v", items)
	}
	if items := list(RunFilters{Search: "%"}); len(items) != 0 {
		t.Fatalf("wildcard matched %d runs", len(items))
	}
	title := "Bracket" + token
	job = h.edit(t, job, func(u *JobUpdate) { u.Title = &title })
	manualRunID := job.Runs[0].ID
	if manualRunID == finished {
		manualRunID = job.Runs[len(job.Runs)-1].ID
	}
	searchIDs := func(label, search string, want ...uuid.UUID) {
		t.Helper()
		got := make([]uuid.UUID, 0)
		for _, item := range list(RunFilters{Search: search}) {
			got = append(got, item.ID)
		}
		slices.SortFunc(got, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
		slices.SortFunc(want, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
		if !slices.Equal(got, want) {
			t.Fatalf("%s: search %q = %v, want %v", label, search, got, want)
		}
	}
	searchIDs("machine name", strings.ToLower(h.machine.Name), finished, running, manualRunID)
	searchIDs("job display id", job.DisplayID, finished, manualRunID)
	searchIDs("job title", "bracket"+token, finished, manualRunID)
	searchIDs("material of the reported spool", strings.ToUpper(h.material.Name), finished)
	searchIDs("spool display id", h.spool.DisplayID, finished)
	searchIDs("recipient name", "job tes", finished, manualRunID)
	searchIDs("operator name", "tester", finished, manualRunID)
	searchIDs("nothing matches", "no-such-term-"+token)
	searchIDs("underscore stays literal", "_", finished, running)
	if _, _, err := h.s.ListRuns(
		ctx,
		h.p,
		RunFilters{States: []RunState{"bogus"}, Page: 1, PageSize: 10},
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("bogus state: %v", err)
	}
	if _, _, err := h.s.ListRuns(
		ctx,
		authorization.Principal{AccountID: h.p.AccountID},
		RunFilters{Page: 1, PageSize: 10},
	); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("list without read: %v", err)
	}
	h.insertEvent(
		t,
		finished,
		h.machine.ID,
		"terminal_outcome",
		*at(h.now, -5*time.Hour),
		`{"outcome":"completed","note":"SECRET-VALUE"}`,
	)
	detail, err := h.s.GetRun(ctx, h.p, finished)
	if err != nil || len(detail.Events) != 2 {
		t.Fatalf("events: %+v %v", detail.Events, err)
	}
	encoded, _ := json.Marshal(detail)
	if strings.Contains(string(encoded), "SECRET-VALUE") {
		t.Fatalf("raw payload leaked: %s", encoded)
	}
	if _, err = h.s.GetRun(ctx, authorization.Principal{AccountID: h.p.AccountID}, finished); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("get without read: %v", err)
	}
	if _, err = h.s.GetRun(ctx, h.p, ids.New()); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown run: %v", err)
	}
}
