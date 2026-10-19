package machinelogbook

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// bulkBlockers reads the blocking items out of a bulk_blocked error as
// "kind:code" strings.
func bulkBlockers(t *testing.T, err error) []string {
	t.Helper()
	var appErr *apperror.Error
	if !apperror.IsCode(err, "bulk_blocked") {
		t.Fatalf("want bulk_blocked, got %v", err)
	}
	appErr = err.(*apperror.Error)
	items, ok := appErr.Details["items"].([]map[string]any)
	if !ok {
		t.Fatalf("details.items = %#v", appErr.Details["items"])
	}
	var result []string
	for _, item := range items {
		result = append(result, fmt.Sprintf("%v:%v", item["kind"], item["code"]))
	}
	return result
}

func hasBlocker(blockers []string, want string) bool {
	for _, b := range blockers {
		if b == want {
			return true
		}
	}
	return false
}

// putOnOrder claims the job by a draft order, as adding it to an order does.
func (f *jobFixture) putOnOrder(t *testing.T, job MachineJob) {
	t.Helper()
	ctx := t.Context()
	orderID, itemID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	reference := fmt.Sprintf("O-2020-%09d", time.Now().UnixNano()%1_000_000_000)
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = f.pool.Exec(cleanup, `DELETE FROM orders WHERE id = $1`, orderID)
	})
	for _, step := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO orders (id, reference, customer_kind, fulfillment_mode) VALUES ($1, $2, 'anonymous', 'deferred')`, []any{orderID, reference}},
		{`INSERT INTO order_items (id, order_id, position, kind, description, quantity, unit, unit_price, amount, source_machine_job_id, source_job_version, machine_job_snapshot)
			VALUES ($1, $2, 1, 'machine_job', 'Job', 1, 'job', 1, 1, $3, $4, '{}'::jsonb)`, []any{itemID, orderID, job.ID, job.Version}},
		{`INSERT INTO order_job_claims (machine_job_id, order_item_id) VALUES ($1, $2)`, []any{job.ID, itemID}},
	} {
		if _, err := f.pool.Exec(ctx, step.sql, step.args...); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *jobFixture) jobAlive(t *testing.T, id uuid.UUID) bool {
	t.Helper()
	deleted, _ := f.tombstone(t, "machine_jobs", id)
	return !deleted
}

func (f *jobFixture) manualJob(t *testing.T, offset time.Duration, grams string) MachineJob {
	t.Helper()
	input := f.input(offset, time.Hour, "successful")
	if grams != "" {
		input.Usages = []UsageInput{{MaterialID: f.material.ID, Quantity: grams}}
	}
	return f.create(t, input)
}

func (f *jobFixture) item(job MachineJob) BulkItem {
	return BulkItem{ID: job.ID, ExpectedVersion: job.Version}
}

func (h *runHarness) unassigned(t *testing.T, machine uuid.UUID, offset time.Duration, name string) BulkItem {
	t.Helper()
	started, ended := at(h.now, offset), at(h.now, offset+time.Hour)
	id := h.insertRun(t, runSpec{machine: machine, started: started, ended: ended, fileName: name})
	h.finish(t, id, "finished", *ended)
	return BulkItem{ID: id, ExpectedVersion: h.run(t, id).Version}
}

func (h *runHarness) jobCount(t *testing.T, machine uuid.UUID) int {
	t.Helper()
	var count int
	if err := h.pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_jobs WHERE machine_id = $1 AND deleted_at IS NULL`, machine).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func (h *runHarness) runAssigned(t *testing.T, id uuid.UUID) (deleted, assigned bool) {
	t.Helper()
	return h.tombstone(t, "machine_runs", id)
}

func TestBulkDeleteAuthorizationAndValidation(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()
	job := f.manualJob(t, -10*time.Hour, "")
	input := BulkDeleteInput{Jobs: []BulkItem{f.item(job)}}
	for name, principal := range map[string]authorization.Principal{
		"no permission":     {AccountID: f.p.AccountID},
		"create, edit only": restrictedPrincipal(t, f.pool, authorization.MachineJobsRead, authorization.MachineJobsEdit, authorization.MachineJobsCreate),
	} {
		if err := f.s.BulkDelete(ctx, principal, input, &f.request); !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if err := f.s.BulkDelete(ctx, f.p, BulkDeleteInput{}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("empty request: %v", err)
	}
	if err := f.s.BulkDelete(ctx, f.p, BulkDeleteInput{Jobs: []BulkItem{{ID: job.ID}}}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("missing version: %v", err)
	}
	if err := f.s.BulkDelete(ctx, f.p, BulkDeleteInput{Jobs: []BulkItem{f.item(job), f.item(job)}}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("duplicate item: %v", err)
	}
	// With machine_jobs.delete the same request goes through.
	deleter := restrictedPrincipal(t, f.pool, authorization.MachineJobsRead, authorization.MachineJobsDelete)
	if err := f.s.BulkDelete(ctx, deleter, input, &f.request); err != nil {
		t.Fatalf("delete with machine_jobs.delete: %v", err)
	}
	if f.jobAlive(t, job.ID) {
		t.Fatal("job must be deleted")
	}
}

func TestBulkDeleteRefusesEverythingWhenAnItemIsBlocked(t *testing.T) {
	h := newRunHarness(t)
	f := h.jobFixture
	ctx := t.Context()
	good := f.manualJob(t, -10*time.Hour, "50")
	onOrder := f.manualJob(t, -9*time.Hour, "20")
	f.putOnOrder(t, onOrder)
	stale := f.manualJob(t, -8*time.Hour, "")
	owned := h.unassigned(t, h.machine.ID, -7*time.Hour, "owned.gcode")
	title := "Holds a run"
	if _, err := h.s.CreateJobFromRun(ctx, h.p, owned.ID, RunJobInput{Title: &title, Customer: PartyReference{Kind: "person", ID: h.person}, OperatorPersonID: h.person, PricingGroupID: &h.group.ID}, &h.request); err != nil {
		t.Fatal(err)
	}
	free := h.unassigned(t, h.machine.ID, -6*time.Hour, "free.gcode")
	before := f.quantity(t, f.material.ID)

	err := f.s.BulkDelete(ctx, f.p, BulkDeleteInput{
		Jobs:               []BulkItem{f.item(good), f.item(onOrder), {ID: stale.ID, ExpectedVersion: stale.Version + 5}, {ID: uuid.Must(uuid.NewV7()), ExpectedVersion: 1}},
		Runs:               []BulkItem{free, {ID: owned.ID, ExpectedVersion: owned.ExpectedVersion + 1}},
		ReverseConsumption: true,
	}, &f.request)
	blockers := bulkBlockers(t, err)
	for _, want := range []string{"job:job_on_order", "job:stale_write", "job:not_found", "run:run_assigned"} {
		if !hasBlocker(blockers, want) {
			t.Fatalf("blockers %v lack %s", blockers, want)
		}
	}
	if len(blockers) != 4 {
		t.Fatalf("blockers = %v", blockers)
	}
	var appErr = err.(*apperror.Error)
	if appErr.HTTPStatus != 409 {
		t.Fatalf("status = %d", appErr.HTTPStatus)
	}
	// All-or-nothing: the valid items and the ledger are untouched, nothing was audited.
	if !f.jobAlive(t, good.ID) || !f.jobAlive(t, onOrder.ID) || !f.jobAlive(t, stale.ID) {
		t.Fatal("a job was deleted although the request was refused")
	}
	if deleted, _ := h.runAssigned(t, free.ID); deleted {
		t.Fatal("the unassigned run was deleted although the request was refused")
	}
	if got := f.quantity(t, f.material.ID); got != before {
		t.Fatalf("quantity changed %s -> %s", before, got)
	}
	if n := f.auditCount(t, "machine_job.deleted", good.ID); n != 0 {
		t.Fatalf("audit events of a refused request = %d", n)
	}

	// A stale unassigned run alone refuses too, and the run stays.
	if err = f.s.BulkDelete(ctx, f.p, BulkDeleteInput{Runs: []BulkItem{{ID: free.ID, ExpectedVersion: free.ExpectedVersion + 1}}}, &f.request); !hasBlocker(bulkBlockers(t, err), "run:stale_write") {
		t.Fatalf("stale run: %v", err)
	}
}

func TestBulkDeleteDeletesJobsAndRunsWithOneAuditEventEach(t *testing.T) {
	h := newRunHarness(t)
	f := h.jobFixture
	ctx := t.Context()
	first := f.manualJob(t, -10*time.Hour, "50")
	second := f.manualJob(t, -9*time.Hour, "30")
	if got := f.quantity(t, f.material.ID); got != "920" {
		t.Fatalf("setup quantity = %s", got)
	}
	// A job with a recorded run, and an unassigned run with consumption.
	held := h.unassigned(t, h.machine.ID, -8*time.Hour, "held.gcode")
	withRun, err := h.s.CreateJobFromRun(ctx, h.p, held.ID, RunJobInput{Customer: PartyReference{Kind: "person", ID: h.person}, OperatorPersonID: h.person, PricingGroupID: &h.group.ID}, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	started, ended := at(h.now, -5*time.Hour), at(h.now, -4*time.Hour)
	loose := h.insertRun(t, runSpec{machine: h.machine.ID, state: "running", started: started, fileName: "loose.gcode"})
	h.finish(t, loose, "finished", *ended)
	h.report(t, loose, h.machine.ID, "40", 1, h.spool.ID)
	h.apply(t, loose, "terminal_outcome")
	if got := h.quantity(t, h.material.ID); got != "960" {
		t.Fatalf("spool material quantity = %s", got)
	}
	looseItem := BulkItem{ID: loose, ExpectedVersion: h.run(t, loose).Version}

	// Reverse restores the material of every deleted run; deleteRuns=false detaches the recorded run.
	err = f.s.BulkDelete(ctx, f.p, BulkDeleteInput{
		Jobs:               []BulkItem{f.item(first), f.item(second), f.item(withRun)},
		Runs:               []BulkItem{looseItem},
		ReverseConsumption: true,
	}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.quantity(t, f.material.ID); got != "1000" {
		t.Fatalf("manual material after reversal = %s", got)
	}
	if got := h.quantity(t, h.material.ID); got != "1000" {
		t.Fatalf("recorded material after reversal = %s", got)
	}
	for _, job := range []MachineJob{first, second, withRun} {
		if f.jobAlive(t, job.ID) {
			t.Fatalf("job %s must be deleted", job.DisplayID)
		}
		if n := f.auditCount(t, "machine_job.deleted", job.ID); n != 1 {
			t.Fatalf("machine_job.deleted audit for %s = %d", job.DisplayID, n)
		}
	}
	for _, run := range append(first.Runs, second.Runs...) {
		if n := f.auditCount(t, "machine_run.deleted", run.ID); n != 1 {
			t.Fatalf("machine_run.deleted audit for %s = %d", run.DisplayID, n)
		}
	}
	if deleted, _ := h.runAssigned(t, loose); !deleted || f.auditCount(t, "machine_run.deleted", loose) != 1 {
		t.Fatal("the unassigned run must be deleted and audited")
	}
	if deleted, assigned := h.runAssigned(t, held.ID); deleted || assigned {
		t.Fatalf("recorded run of a deleted job: deleted=%v assigned=%v (it must stay as an unassigned run)", deleted, assigned)
	}
	var fields []string
	if err = f.pool.QueryRow(ctx, `SELECT changed_fields FROM audit_events WHERE action = 'machine_job.deleted' AND resource_id = $1`, withRun.ID).Scan(&fields); err != nil || !strings.Contains(strings.Join(fields, ","), "recordedRunsDetached") {
		t.Fatalf("job audit fields = %v err=%v", fields, err)
	}
}

func TestBulkDeleteKeepsTheLedgerAndCanDeleteRecordedRuns(t *testing.T) {
	h := newRunHarness(t)
	f := h.jobFixture
	ctx := t.Context()
	job := f.manualJob(t, -10*time.Hour, "50")
	held := h.unassigned(t, h.machine.ID, -8*time.Hour, "held.gcode")
	withRun, err := h.s.CreateJobFromRun(ctx, h.p, held.ID, RunJobInput{Customer: PartyReference{Kind: "person", ID: h.person}, OperatorPersonID: h.person, PricingGroupID: &h.group.ID}, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	var ledger int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM inventory_transactions WHERE material_id = $1`, f.material.ID).Scan(&ledger); err != nil {
		t.Fatal(err)
	}
	if err = f.s.BulkDelete(ctx, f.p, BulkDeleteInput{Jobs: []BulkItem{f.item(job), f.item(withRun)}, DeleteRecordedRuns: true}, &f.request); err != nil {
		t.Fatal(err)
	}
	var after int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM inventory_transactions WHERE material_id = $1`, f.material.ID).Scan(&after); err != nil || after != ledger {
		t.Fatalf("ledger rows %d -> %d err=%v", ledger, after, err)
	}
	if got := f.quantity(t, f.material.ID); got != "950" {
		t.Fatalf("quantity with keep = %s", got)
	}
	if deleted, _ := h.runAssigned(t, held.ID); !deleted {
		t.Fatal("deleteRuns must delete the recorded run too")
	}
}

func TestBulkCreateJobsFromRuns(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	late := h.unassigned(t, h.machine.ID, -3*time.Hour, "late.gcode")
	early := h.unassigned(t, h.machine.ID, -6*time.Hour, "early.gcode")
	otherMachine := h.unassigned(t, h.bareMachine.ID, -5*time.Hour, "bare.gcode")
	input := BulkRunJobInput{Runs: []BulkItem{late, early, otherMachine}, Customer: PartyReference{Kind: "person", ID: h.person}, OperatorPersonID: h.person, PricingGroupID: &h.group.ID}

	for name, principal := range map[string]authorization.Principal{
		"no permission":   {AccountID: h.p.AccountID},
		"read, edit only": restrictedPrincipal(t, h.pool, authorization.MachineJobsRead, authorization.MachineJobsEdit, authorization.MachineJobsDelete),
	} {
		if _, err := h.s.BulkCreateJobsFromRuns(ctx, principal, input, &h.request); !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := h.s.BulkCreateJobsFromRuns(ctx, h.p, BulkRunJobInput{Customer: input.Customer, OperatorPersonID: h.person}, &h.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("no runs: %v", err)
	}

	// One stale run refuses the request: no job exists afterwards.
	stale := input
	stale.Runs = []BulkItem{late, {ID: early.ID, ExpectedVersion: early.ExpectedVersion + 1}}
	_, err := h.s.BulkCreateJobsFromRuns(ctx, h.p, stale, &h.request)
	if !hasBlocker(bulkBlockers(t, err), "run:stale_write") {
		t.Fatalf("stale run: %v", err)
	}
	if n := h.jobCount(t, h.machine.ID); n != 0 {
		t.Fatalf("jobs after a refused request = %d", n)
	}
	// A run on a retired machine blocks as well.
	if _, err = h.pool.Exec(ctx, `UPDATE machines SET status = 'retired' WHERE id = $1`, h.bareMachine.ID); err != nil {
		t.Fatal(err)
	}
	_, err = h.s.BulkCreateJobsFromRuns(ctx, h.p, input, &h.request)
	if !hasBlocker(bulkBlockers(t, err), "run:machine_retired") || h.jobCount(t, h.machine.ID) != 0 {
		t.Fatalf("retired machine: %v", err)
	}
	if _, err = h.pool.Exec(ctx, `UPDATE machines SET status = 'active' WHERE id = $1`, h.bareMachine.ID); err != nil {
		t.Fatal(err)
	}

	created, err := h.s.BulkCreateJobsFromRuns(ctx, h.p, input, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 3 {
		t.Fatalf("created %d jobs", len(created))
	}
	// Jobs are numbered in the order the runs started and named after their run's file.
	order := []uuid.UUID{early.ID, otherMachine.ID, late.ID}
	for i, job := range created {
		detail, err := h.s.GetJob(ctx, h.p, job.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(detail.Runs) != 1 || detail.Runs[0].ID != order[i] || detail.Title != nil || detail.Customer == nil || detail.Customer.ID != h.person {
			t.Fatalf("job %d: runs=%d title=%v customer=%v", i, len(detail.Runs), detail.Title, detail.Customer)
		}
		if h.auditCount(t, "machine_job.created", job.ID) != 1 || h.auditCount(t, "machine_run.assigned", order[i]) != 1 {
			t.Fatalf("audit events of job %d are missing", i)
		}
	}
	if created[0].DisplayID >= created[1].DisplayID || created[1].DisplayID >= created[2].DisplayID {
		t.Fatalf("display IDs not ascending: %v", created)
	}
	if _, err = h.s.BulkCreateJobsFromRuns(ctx, h.p, input, &h.request); !hasBlocker(bulkBlockers(t, err), "run:run_already_assigned") {
		t.Fatalf("second request: %v", err)
	}
}

func TestBulkCombineRuns(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	a := h.unassigned(t, h.machine.ID, -6*time.Hour, "a.gcode")
	b := h.unassigned(t, h.machine.ID, -4*time.Hour, "b.gcode")
	c := h.unassigned(t, h.machine.ID, -2*time.Hour, "c.gcode")
	elsewhere := h.unassigned(t, h.bareMachine.ID, -5*time.Hour, "bare.gcode")
	title := "Combined"
	input := BulkRunJobInput{Runs: []BulkItem{a, b, c}, Title: &title, Customer: PartyReference{Kind: "person", ID: h.person}, OperatorPersonID: h.person, PricingGroupID: &h.group.ID}

	if _, err := h.s.BulkCombineRuns(ctx, authorization.Principal{AccountID: h.p.AccountID}, input, &h.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("no permission: %v", err)
	}
	editor := restrictedPrincipal(t, h.pool, authorization.MachineJobsRead, authorization.MachineJobsEdit)
	if _, err := h.s.BulkCombineRuns(ctx, editor, input, &h.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("edit only: %v", err)
	}
	single := input
	single.Runs = []BulkItem{a}
	if _, err := h.s.BulkCombineRuns(ctx, h.p, single, &h.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("one run: %v", err)
	}
	mixed := input
	mixed.Runs = []BulkItem{a, elsewhere}
	if _, err := h.s.BulkCombineRuns(ctx, h.p, mixed, &h.request); !apperror.IsCode(err, "runs_on_different_machines") {
		t.Fatalf("different machines: %v", err)
	} else if err.(*apperror.Error).HTTPStatus != 422 {
		t.Fatalf("status = %d", err.(*apperror.Error).HTTPStatus)
	}
	stale := input
	stale.Runs = []BulkItem{a, {ID: b.ID, ExpectedVersion: b.ExpectedVersion + 1}}
	if _, err := h.s.BulkCombineRuns(ctx, h.p, stale, &h.request); !hasBlocker(bulkBlockers(t, err), "run:stale_write") {
		t.Fatalf("stale run: %v", err)
	}
	if n := h.jobCount(t, h.machine.ID) + h.jobCount(t, h.bareMachine.ID); n != 0 {
		t.Fatalf("jobs after refused requests = %d", n)
	}

	job, err := h.s.BulkCombineRuns(ctx, h.p, input, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	if len(job.Runs) != 3 || job.Machine.ID != h.machine.ID || job.Title == nil || *job.Title != title || job.Customer == nil {
		t.Fatalf("combined job: runs=%d title=%v", len(job.Runs), job.Title)
	}
	// 3 h of runtime at 10 per hour.
	if price(job.CalculatedPrice) != "30" {
		t.Fatalf("calculated price = %s", price(job.CalculatedPrice))
	}
	if h.auditCount(t, "machine_job.created", job.ID) != 1 {
		t.Fatal("job audit is missing")
	}
	for _, item := range input.Runs {
		if h.auditCount(t, "machine_run.assigned", item.ID) != 1 {
			t.Fatalf("run %s has no assignment audit", item.ID)
		}
	}
}

func TestBulkAttachRuns(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	manual := h.manualJob(t, -10*time.Hour, "30")
	a := h.unassigned(t, h.machine.ID, -8*time.Hour, "a.gcode")
	b := h.unassigned(t, h.machine.ID, -6*time.Hour, "b.gcode")
	elsewhere := h.unassigned(t, h.bareMachine.ID, -5*time.Hour, "bare.gcode")
	input := BulkAttachInput{JobID: manual.ID, ExpectedJobVersion: manual.Version, Runs: []BulkItem{a, b}, ReplaceManualRuns: true}

	if _, err := h.s.BulkAttachRuns(ctx, authorization.Principal{AccountID: h.p.AccountID}, input, &h.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("no permission: %v", err)
	}
	creator := restrictedPrincipal(t, h.pool, authorization.MachineJobsRead, authorization.MachineJobsCreate, authorization.MachineJobsDelete)
	if _, err := h.s.BulkAttachRuns(ctx, creator, input, &h.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("create and delete only: %v", err)
	}
	staleJob := input
	staleJob.ExpectedJobVersion++
	if _, err := h.s.BulkAttachRuns(ctx, h.p, staleJob, &h.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale job: %v", err)
	}
	if _, err := h.s.BulkAttachRuns(ctx, h.p, BulkAttachInput{JobID: uuid.Must(uuid.NewV7()), ExpectedJobVersion: 1, Runs: input.Runs}, &h.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown job: %v", err)
	}
	if _, err := h.s.BulkAttachRuns(ctx, h.p, BulkAttachInput{JobID: manual.ID, ExpectedJobVersion: manual.Version}, &h.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("no runs: %v", err)
	}
	mixed := input
	mixed.Runs = []BulkItem{a, elsewhere}
	if _, err := h.s.BulkAttachRuns(ctx, h.p, mixed, &h.request); !hasBlocker(bulkBlockers(t, err), "run:run_machine_mismatch") {
		t.Fatalf("machine mismatch: %v", err)
	}
	// Nothing changed: the manual run still counts and its material is still booked.
	untouched, err := h.s.GetJob(ctx, h.p, manual.ID)
	if err != nil || len(untouched.Runs) != 1 || untouched.Version != manual.Version || h.quantity(t, h.jobFixture.material.ID) != "970" {
		t.Fatalf("job after refused requests: %v runs=%d version=%d", err, len(untouched.Runs), untouched.Version)
	}

	job, err := h.s.BulkAttachRuns(ctx, h.p, input, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	if len(job.Runs) != 3 || job.Runs[0].State != "replaced" {
		t.Fatalf("runs after attach: %+v", job.Runs)
	}
	// 2 recorded hours at 10 per hour; the manual run is replaced and its material returned.
	if price(job.CalculatedPrice) != "20" || h.quantity(t, h.jobFixture.material.ID) != "1000" {
		t.Fatalf("price=%s quantity=%s", price(job.CalculatedPrice), h.quantity(t, h.jobFixture.material.ID))
	}
	if h.auditCount(t, "machine_job.run_attached", job.ID) != 1 || h.auditCount(t, "machine_run.assigned", a.ID) != 1 || h.auditCount(t, "machine_run.assigned", b.ID) != 1 {
		t.Fatal("attach audit events are missing")
	}
	var metadata []byte
	if err = h.pool.QueryRow(ctx, `SELECT metadata FROM audit_events WHERE action = 'machine_run.assigned' AND resource_id = $1`, a.ID).Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]string
	if err = json.Unmarshal(metadata, &decoded); err != nil || decoded["jobId"] != job.ID.String() {
		t.Fatalf("assignment metadata = %s err=%v", metadata, err)
	}
	if _, err = h.s.BulkAttachRuns(ctx, h.p, BulkAttachInput{JobID: job.ID, ExpectedJobVersion: job.Version, Runs: []BulkItem{a}}, &h.request); !hasBlocker(bulkBlockers(t, err), "run:run_already_assigned") {
		t.Fatalf("second attach: %v", err)
	}
}
