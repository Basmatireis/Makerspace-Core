package machinelogbook

import (
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// tombstone reads the deletion columns of a job or run row.
func (f *jobFixture) tombstone(t *testing.T, table string, id uuid.UUID) (deleted bool, hasJob bool) {
	t.Helper()
	query := `SELECT deleted_at IS NOT NULL, false FROM machine_jobs WHERE id = $1`
	if table == "machine_runs" {
		query = `SELECT deleted_at IS NOT NULL, job_id IS NOT NULL FROM machine_runs WHERE id = $1`
	}
	if err := f.pool.QueryRow(t.Context(), query, id).Scan(&deleted, &hasJob); err != nil {
		t.Fatalf("row %s in %s is gone: %v", id, table, err)
	}
	return deleted, hasJob
}

func (f *jobFixture) deleteRun(t *testing.T, run MachineRun, reverse bool) {
	t.Helper()
	if err := f.s.DeleteRun(t.Context(), f.p, run.ID, run.Version, reverse, &f.request); err != nil {
		t.Fatal(err)
	}
}

func (f *jobFixture) reload(t *testing.T, id uuid.UUID) MachineJob {
	t.Helper()
	job, err := f.s.GetJob(t.Context(), f.p, id)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func TestDeleteRunGuardsAndConsumptionChoice(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()
	input := f.input(-10*time.Hour, time.Hour, "successful")
	input.Usages = []UsageInput{{MaterialID: f.material.ID, Quantity: "50"}}
	job := f.create(t, input)
	only := job.Runs[0]
	if err := f.s.DeleteRun(ctx, f.p, only.ID, only.Version, true, &f.request); !apperror.IsCode(err, "last_run") {
		t.Fatalf("delete of the only run: %v", err)
	}
	job = f.addRun(t, job, -8*time.Hour, time.Hour, outcomePtr("successful"), UsageInput{MaterialID: f.material.ID, Quantity: "20"})
	job = f.addRun(t, job, -6*time.Hour, time.Hour, outcomePtr("failed"))
	job = f.addRun(t, job, -4*time.Hour, time.Hour, outcomePtr("successful"), UsageInput{MaterialID: f.material.ID, Quantity: "10"})
	if len(job.Runs) != 4 || f.quantity(t, f.material.ID) != "920" {
		t.Fatalf("setup: runs=%d quantity=%s", len(job.Runs), f.quantity(t, f.material.ID))
	}
	reversed, noUsage, kept := job.Runs[1], job.Runs[2], job.Runs[3]

	if err := f.s.DeleteRun(ctx, authorization.Principal{AccountID: f.p.AccountID}, noUsage.ID, noUsage.Version, false, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("delete without machine_jobs.delete: %v", err)
	}
	if err := f.s.DeleteRun(ctx, f.p, noUsage.ID, noUsage.Version+1, false, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale delete: %v", err)
	}
	if err := f.s.DeleteRun(ctx, f.p, uuid.Must(uuid.NewV7()), 1, false, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown run: %v", err)
	}

	f.deleteRun(t, noUsage, false)
	if deleted, hasJob := f.tombstone(t, "machine_runs", noUsage.ID); !deleted || hasJob {
		t.Fatalf("run tombstone: deleted=%v attached=%v", deleted, hasJob)
	}
	if _, err := f.s.GetRun(ctx, f.p, noUsage.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("get of a deleted run: %v", err)
	}
	if err := f.s.DeleteRun(ctx, f.p, noUsage.ID, noUsage.Version+1, false, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("second delete: %v", err)
	}

	// Reversing restores the material with a compensating ledger entry that
	// belongs to the run's usage.
	f.deleteRun(t, reversed, true)
	if got := f.quantity(t, f.material.ID); got != "940" {
		t.Fatalf("quantity after reversal = %s", got)
	}
	var reversals int
	var activeUsages int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM inventory_transactions t JOIN machine_run_usages u ON u.id = t.run_usage_id
		WHERE u.run_id = $1 AND t.kind = 'adjustment' AND t.adjustment_reason = 'job_corrected' AND t.quantity_delta = 20 AND t.unit_acquisition_cost = 0.02`, reversed.ID).Scan(&reversals); err != nil || reversals != 1 {
		t.Fatalf("reversal ledger entries = %d err=%v", reversals, err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM machine_run_usages WHERE run_id = $1 AND active`, reversed.ID).Scan(&activeUsages); err != nil || activeUsages != 0 {
		t.Fatalf("active usages of the reversed run = %d err=%v", activeUsages, err)
	}

	// Keeping the consumption leaves the ledger untouched.
	var ledgerBefore int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM inventory_transactions WHERE material_id = $1`, f.material.ID).Scan(&ledgerBefore); err != nil {
		t.Fatal(err)
	}
	f.deleteRun(t, kept, false)
	var ledgerAfter int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM inventory_transactions WHERE material_id = $1`, f.material.ID).Scan(&ledgerAfter); err != nil || ledgerAfter != ledgerBefore {
		t.Fatalf("ledger rows %d -> %d err=%v", ledgerBefore, ledgerAfter, err)
	}
	if got := f.quantity(t, f.material.ID); got != "940" {
		t.Fatalf("quantity after keeping consumption = %s", got)
	}

	// Only the first run is left: it has 1h at 10 plus 50 g at 0.1.
	after := f.reload(t, job.ID)
	if len(after.Runs) != 1 || after.Runs[0].ID != only.ID || price(after.CalculatedPrice) != "15" || after.Version <= job.Version {
		t.Fatalf("job after run deletions: runs=%d price=%s", len(after.Runs), price(after.CalculatedPrice))
	}
	remaining := after.Runs[0]
	if err := f.s.DeleteRun(ctx, f.p, remaining.ID, remaining.Version, true, &f.request); !apperror.IsCode(err, "last_run") {
		t.Fatalf("delete of the last remaining run: %v", err)
	}
	if f.auditCount(t, "machine_run.deleted", reversed.ID) != 1 || f.auditCount(t, "machine_run.deleted", noUsage.ID) != 1 {
		t.Fatal("run deletion audit is missing")
	}
	var fields []string
	var metadataJob string
	if err := f.pool.QueryRow(ctx, `SELECT changed_fields, metadata->>'jobId' FROM audit_events WHERE action = 'machine_run.deleted' AND resource_id = $1`, reversed.ID).Scan(&fields, &metadataJob); err != nil || strings.Join(fields, ",") != "deletedAt,usages,inventory" || metadataJob != job.ID.String() {
		t.Fatalf("audit fields=%v job=%s err=%v", fields, metadataJob, err)
	}
}

func (f *jobFixture) auditCount(t *testing.T, action string, resource uuid.UUID) int {
	t.Helper()
	var count int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_events WHERE action = $1 AND resource_id = $2`, action, resource).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestDeleteJobReversesOrKeepsConsumption(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()
	build := func(grams string) MachineJob {
		input := f.input(-10*time.Hour, time.Hour, "successful")
		input.Usages = []UsageInput{{MaterialID: f.material.ID, Quantity: grams}}
		job := f.create(t, input)
		return f.addRun(t, job, -8*time.Hour, time.Hour, outcomePtr("successful"), UsageInput{MaterialID: f.material.ID, Quantity: "20"})
	}
	reverse, keep := build("50"), build("30")
	if got := f.quantity(t, f.material.ID); got != "880" {
		t.Fatalf("setup quantity = %s", got)
	}

	if err := f.s.DeleteJob(ctx, authorization.Principal{AccountID: f.p.AccountID}, reverse.ID, DeleteJobInput{ExpectedVersion: reverse.Version, ReverseConsumption: true}, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("delete without permission: %v", err)
	}
	editor := restrictedPrincipal(t, f.pool, authorization.MachineJobsRead, authorization.MachineJobsEdit, authorization.MachineJobsCreate)
	if err := f.s.DeleteJob(ctx, editor, reverse.ID, DeleteJobInput{ExpectedVersion: reverse.Version}, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("delete with edit and create only: %v", err)
	}
	if err := f.s.DeleteJob(ctx, f.p, reverse.ID, DeleteJobInput{ExpectedVersion: reverse.Version + 1}, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale delete: %v", err)
	}
	if err := f.s.DeleteJob(ctx, f.p, reverse.ID, DeleteJobInput{}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("missing version: %v", err)
	}
	if err := f.s.DeleteJob(ctx, f.p, uuid.Must(uuid.NewV7()), DeleteJobInput{ExpectedVersion: 1}, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown job: %v", err)
	}

	if err := f.s.DeleteJob(ctx, f.p, reverse.ID, DeleteJobInput{ExpectedVersion: reverse.Version, ReverseConsumption: true}, &f.request); err != nil {
		t.Fatal(err)
	}
	if got := f.quantity(t, f.material.ID); got != "950" {
		t.Fatalf("quantity after reversing 70 g = %s", got)
	}
	var reversals int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM inventory_transactions t JOIN machine_run_usages u ON u.id = t.run_usage_id JOIN machine_runs r ON r.id = u.run_id
		WHERE r.machine_id = $1 AND t.kind = 'adjustment' AND t.adjustment_reason = 'job_corrected' AND t.quantity_delta > 0`, f.machine.ID).Scan(&reversals); err != nil || reversals != 2 {
		t.Fatalf("reversal ledger entries = %d err=%v", reversals, err)
	}
	if deleted, _ := f.tombstone(t, "machine_jobs", reverse.ID); !deleted {
		t.Fatal("job row must remain as a tombstone")
	}
	for _, run := range reverse.Runs {
		if deleted, attached := f.tombstone(t, "machine_runs", run.ID); !deleted || attached {
			t.Fatalf("manual run %s: deleted=%v attached=%v", run.DisplayID, deleted, attached)
		}
	}
	if _, err := f.s.GetJob(ctx, f.p, reverse.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("get of a deleted job: %v", err)
	}
	if err := f.s.DeleteJob(ctx, f.p, reverse.ID, DeleteJobInput{ExpectedVersion: reverse.Version}, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("second delete: %v", err)
	}
	if _, err := f.s.UpdateJobFacts(ctx, f.p, reverse.ID, reverse.Version+1, JobUpdate{MachineID: f.machine.ID, Customer: PartyReference{Kind: "person", ID: f.person}, OperatorPersonID: f.person}, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("edit of a deleted job: %v", err)
	}
	if f.auditCount(t, "machine_job.deleted", reverse.ID) != 1 || f.auditCount(t, "machine_run.deleted", reverse.Runs[0].ID) != 1 {
		t.Fatal("deletion audit is missing")
	}

	// Keeping the consumption: the material stays consumed.
	if err := f.s.DeleteJob(ctx, f.p, keep.ID, DeleteJobInput{ExpectedVersion: keep.Version}, &f.request); err != nil {
		t.Fatal(err)
	}
	if got := f.quantity(t, f.material.ID); got != "950" {
		t.Fatalf("quantity after keeping 50 g consumed = %s", got)
	}
	var active int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM machine_run_usages u JOIN machine_runs r ON r.id = u.run_id WHERE r.machine_id = $1 AND u.active AND r.deleted_at IS NOT NULL`, f.machine.ID).Scan(&active); err != nil || active != 2 {
		t.Fatalf("usages kept for the ledger = %d err=%v", active, err)
	}
	page, total, err := f.s.ListJobs(ctx, f.p, JobFilters{MachineID: &f.machine.ID, Page: 1, PageSize: 50})
	if err != nil || total != 0 || len(page) != 0 {
		t.Fatalf("jobs of the machine after deletion: %d %v", total, err)
	}
	// The ledger still names the deleted job's usages but no longer links the job.
	transactions, _, err := f.s.ListMaterialTransactions(ctx, f.p, f.material.ID, 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, tx := range transactions {
		if tx.MachineJobID != nil {
			t.Fatalf("ledger links the deleted job %s", tx.MachineJobID)
		}
	}
}

func TestDeleteJobWithRecordedRuns(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	started, ended := at(h.now, -3*time.Hour), at(h.now, -2*time.Hour)
	book := func(grams string) uuid.UUID {
		t.Helper()
		id := h.insertRun(t, runSpec{machine: h.machine.ID, started: started, ended: ended, fileName: "part.gcode", grams: grams, basis: "actual", spool: &h.spool.ID})
		h.finish(t, id, "finished", *ended)
		h.apply(t, id, "terminal_outcome")
		return id
	}
	fillSum := func() string {
		t.Helper()
		var sum string
		if err := h.pool.QueryRow(ctx, `SELECT COALESCE(sum(t.quantity_delta), 0)::text FROM inventory_transactions t WHERE t.spool_id = $1`, h.spool.ID).Scan(&sum); err != nil {
			t.Fatal(err)
		}
		return sum
	}
	jobWith := func(runID uuid.UUID) MachineJob {
		t.Helper()
		return h.attach(t, runID, h.create(t, h.input(-8*time.Hour, time.Hour, "successful")), false)
	}
	detachedRun, deletedRun := book("40"), book("25")
	if !dec(t, fillSum()).Equal(dec(t, "935")) {
		t.Fatalf("spool quantity before = %s", fillSum())
	}
	detachJob, deleteJob := jobWith(detachedRun), jobWith(deletedRun)
	if len(detachJob.Runs) != 2 {
		t.Fatalf("job runs = %d", len(detachJob.Runs))
	}

	// Recorded runs are detached and keep their consumption.
	if err := h.s.DeleteJob(ctx, h.p, detachJob.ID, DeleteJobInput{ExpectedVersion: detachJob.Version}, &h.request); err != nil {
		t.Fatal(err)
	}
	run := h.run(t, detachedRun)
	if run.Job != nil || len(run.Usages) != 1 || !dec(t, fillSum()).Equal(dec(t, "935")) {
		t.Fatalf("detached run: job=%v usages=%d spool=%s", run.Job, len(run.Usages), fillSum())
	}
	manual := detachJob.Runs[0]
	if manual.Source != "manual" {
		manual = detachJob.Runs[1]
	}
	if deleted, _ := h.tombstone(t, "machine_runs", manual.ID); !deleted {
		t.Fatal("the manual run must be deleted with the job")
	}
	unassigned := false
	runs, _, err := h.s.ListRuns(ctx, h.p, RunFilters{MachineID: &h.machine.ID, Assigned: ptr(false), Page: 1, PageSize: 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range runs {
		unassigned = unassigned || r.ID == detachedRun
	}
	if !unassigned {
		t.Fatal("the detached recorded run must be listed as unassigned")
	}

	// Recorded runs are deleted and their consumption goes back to the open spool fill.
	if err = h.s.DeleteJob(ctx, h.p, deleteJob.ID, DeleteJobInput{ExpectedVersion: deleteJob.Version, ReverseConsumption: true, DeleteRecordedRuns: true}, &h.request); err != nil {
		t.Fatal(err)
	}
	if _, err = h.s.GetRun(ctx, h.p, deletedRun); !apperror.IsCode(err, "not_found") {
		t.Fatalf("get of the deleted recorded run: %v", err)
	}
	if got := fillSum(); !dec(t, got).Equal(dec(t, "960")) {
		t.Fatalf("spool quantity after reversal = %s", got)
	}
	var fillID *uuid.UUID
	var note string
	if err = h.pool.QueryRow(ctx, `SELECT t.fill_id, t.note FROM inventory_transactions t JOIN machine_run_usages u ON u.id = t.run_usage_id
		WHERE u.run_id = $1 AND t.kind = 'adjustment'`, deletedRun).Scan(&fillID, &note); err != nil || fillID == nil || !strings.Contains(note, "R-") {
		t.Fatalf("reversal fill=%v note=%q err=%v", fillID, note, err)
	}
	if fields := h.auditFields(t, "machine_job.deleted", deleteJob.ID); !strings.Contains(fields, "recordedRunsDeleted") {
		t.Fatalf("job audit fields = %s", fields)
	}
	if fields := h.auditFields(t, "machine_job.deleted", detachJob.ID); !strings.Contains(fields, "recordedRunsDetached") {
		t.Fatalf("job audit fields = %s", fields)
	}
}

func (f *jobFixture) auditFields(t *testing.T, action string, resource uuid.UUID) string {
	t.Helper()
	var fields []string
	if err := f.pool.QueryRow(t.Context(), `SELECT changed_fields FROM audit_events WHERE action = $1 AND resource_id = $2`, action, resource).Scan(&fields); err != nil {
		t.Fatal(err)
	}
	return strings.Join(fields, ",")
}

func TestReversalToLooseStockWhenTheSpoolFillIsClosed(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	started, ended := at(h.now, -3*time.Hour), at(h.now, -2*time.Hour)
	id := h.insertRun(t, runSpec{machine: h.machine.ID, started: started, ended: ended, grams: "40", basis: "actual", spool: &h.spool.ID})
	h.finish(t, id, "finished", *ended)
	h.apply(t, id, "terminal_outcome")
	if _, err := h.pool.Exec(ctx, `UPDATE filament_spool_fills SET closed_at = $2, leftover_g = 0, leftover_outcome = 'used_up' WHERE spool_id = $1 AND closed_at IS NULL`, h.spool.ID, h.now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	before := h.quantity(t, h.material.ID)
	run := h.run(t, id)
	if err := h.s.DeleteRun(ctx, h.p, id, run.Version, true, &h.request); err != nil {
		t.Fatal(err)
	}
	var fillID *uuid.UUID
	var note string
	if err := h.pool.QueryRow(ctx, `SELECT t.fill_id, t.note FROM inventory_transactions t JOIN machine_run_usages u ON u.id = t.run_usage_id WHERE u.run_id = $1 AND t.kind = 'adjustment'`, id).Scan(&fillID, &note); err != nil {
		t.Fatal(err)
	}
	if fillID != nil || !strings.Contains(note, "loose stock") {
		t.Fatalf("closed fill reversal: fill=%v note=%q", fillID, note)
	}
	if got := h.quantity(t, h.material.ID); got == before {
		t.Fatalf("material quantity did not change: %s", got)
	}
}

func TestDeletedJobsAndRunsDisappearFromEveryAggregate(t *testing.T) {
	w := newWorkItemFixture(t)
	ctx := t.Context()
	machineFilter := JobFilters{MachineID: &w.machine.ID, Page: 1, PageSize: 100}
	_, jobsBefore, err := w.s.ListJobs(ctx, w.p, machineFilter)
	if err != nil {
		t.Fatal(err)
	}
	machineBefore, err := w.s.GetMachine(ctx, w.p, w.machine.ID)
	if err != nil {
		t.Fatal(err)
	}
	items, total := w.list(t, WorkItemFilters{})
	if total != 7 {
		t.Fatalf("work items before = %d", total)
	}
	activity := func() map[uuid.UUID]MachineActivity {
		t.Helper()
		list, activityErr := w.s.MachineActivity(ctx, w.p)
		if activityErr != nil {
			t.Fatal(activityErr)
		}
		result := map[uuid.UUID]MachineActivity{}
		for _, a := range list {
			result[a.MachineID] = a
		}
		return result
	}
	if a := activity(); a[w.machine.ID].Current == nil || a[w.bareMachine.ID].Current == nil {
		t.Fatalf("both machines should be busy before: %+v", a)
	}
	_ = items

	// Delete the running manual job, the printing unassigned run, an ended unassigned run and a finished job.
	if err = w.s.DeleteJob(ctx, w.p, w.running.ID, DeleteJobInput{ExpectedVersion: w.running.Version}, &w.request); err != nil {
		t.Fatal(err)
	}
	for _, id := range []uuid.UUID{w.printing, w.ended} {
		run := w.run(t, id)
		if err = w.s.DeleteRun(ctx, w.p, id, run.Version, false, &w.request); err != nil {
			t.Fatal(err)
		}
	}
	if err = w.s.DeleteJob(ctx, w.p, w.recorded.ID, DeleteJobInput{ExpectedVersion: w.recorded.Version, ReverseConsumption: true}, &w.request); err != nil {
		t.Fatal(err)
	}

	items, total = w.list(t, WorkItemFilters{})
	if total != 3 {
		t.Fatalf("work items after = %d", total)
	}
	sameIDs(t, "remaining work items", items, w.needsOutcome.ID, w.linked.ID, w.noPrice.ID)
	// Lists, search, counts per machine.
	jobs, jobsAfter, err := w.s.ListJobs(ctx, w.p, machineFilter)
	if err != nil || jobsAfter != jobsBefore-2 {
		t.Fatalf("jobs of the machine %d -> %d err=%v", jobsBefore, jobsAfter, err)
	}
	for _, job := range jobs {
		if job.ID == w.running.ID || job.ID == w.recorded.ID {
			t.Fatalf("deleted job %s is listed", job.DisplayID)
		}
	}
	if _, searched, searchErr := w.s.ListJobs(ctx, w.p, JobFilters{Search: w.recorded.DisplayID, Page: 1, PageSize: 10}); searchErr != nil || searched != 0 {
		t.Fatalf("search finds the deleted job: %d %v", searched, searchErr)
	}
	if _, searched, searchErr := w.s.ListRuns(ctx, w.p, RunFilters{Search: "vase.gcode", Page: 1, PageSize: 10}); searchErr != nil || searched != 0 {
		t.Fatalf("run search finds the deleted run: %d %v", searched, searchErr)
	}
	machineAfter, err := w.s.GetMachine(ctx, w.p, w.machine.ID)
	if err != nil || machineAfter.JobCount != machineBefore.JobCount-2 || machineAfter.RuntimeSeconds >= machineBefore.RuntimeSeconds {
		t.Fatalf("machine metrics before=%+v after=%+v err=%v", machineBefore, machineAfter, err)
	}
	machines, _, err := w.s.ListMachines(ctx, w.p, machineAfter.Name, nil, 1, 10)
	if err != nil || len(machines) != 1 || machines[0].JobCount != machineAfter.JobCount {
		t.Fatalf("machine list metrics: %+v err=%v", machines, err)
	}
	// Activity: neither the deleted job nor the deleted printing run keep a machine busy.
	if a := activity(); a[w.machine.ID].Current != nil || a[w.bareMachine.ID].Current != nil || a[w.machine.ID].Availability != "available" || a[w.bareMachine.ID].Availability != "available" {
		t.Fatalf("activity after deletion: %+v", a)
	}
	overview, err := w.s.Overview(ctx, w.p)
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range overview.RecentJobs {
		if job.ID == w.running.ID || job.ID == w.recorded.ID {
			t.Fatalf("overview lists the deleted job %s", job.DisplayID)
		}
	}
	for _, name := range overview.RunningMachineNames {
		if name == w.machine.Name || name == w.bareMachine.Name {
			t.Fatalf("overview lists %s as running", name)
		}
	}
}

func TestDeletedJobsLeaveStatistics(t *testing.T) {
	f := newJobFixture(t)
	y := uniqueYear()
	f.now = time.Date(y, time.June, 15, 12, 0, 0, 0, time.UTC)
	ctx := t.Context()
	day := func(d, hour int) time.Time { return time.Date(y, time.June, d, hour, 0, 0, 0, time.UTC) }
	mk := func(start time.Time, duration time.Duration, outcome string, grams string) MachineJob {
		input := JobInput{MachineID: f.machine.ID, StartsAt: start, EndsAt: start.Add(duration), Customer: PartyReference{Kind: "person", ID: f.person}, OperatorPersonID: f.person, Outcome: outcome, PricingGroupID: &f.group.ID}
		if grams != "" {
			input.Usages = []UsageInput{{MaterialID: f.material.ID, Quantity: grams}}
		}
		return f.create(t, input)
	}
	keep := mk(day(2, 10), 2*time.Hour, "successful", "")
	gone := mk(day(4, 10), 3*time.Hour, "failed", "100")
	goneRuns := mk(day(5, 10), time.Hour, "successful", "")
	extra := f.addRun(t, goneRuns, -10*24*time.Hour, time.Hour, outcomePtr("failed"))
	from, to := time.Date(y, time.June, 1, 0, 0, 0, 0, time.UTC), time.Date(y, time.July, 1, 0, 0, 0, 0, time.UTC)
	before, err := f.s.Statistics(ctx, f.p, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if before.Totals.Jobs != 3 {
		t.Fatalf("jobs before = %d", before.Totals.Jobs)
	}
	assertDecimal(t, "material usage before", usageOfType(t, before, f.materialType.ID), "100")

	if err = f.s.DeleteJob(ctx, f.p, gone.ID, DeleteJobInput{ExpectedVersion: gone.Version, ReverseConsumption: true}, &f.request); err != nil {
		t.Fatal(err)
	}
	// The extra run of the other job is deleted on its own.
	if err = f.s.DeleteRun(ctx, f.p, extra.Runs[1].ID, extra.Runs[1].Version, false, &f.request); err != nil {
		t.Fatal(err)
	}
	after, err := f.s.Statistics(ctx, f.p, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if after.Totals.Jobs != 2 {
		t.Fatalf("jobs after = %d", after.Totals.Jobs)
	}
	// 2 h of the kept job and 1 h of the remaining run; the 3 h job and the 1 h run are gone.
	assertDecimal(t, "runtime after", after.Totals.RuntimeHours, "3")
	assertDecimal(t, "failure rate after", after.Totals.FailureRate, "0")
	assertDecimal(t, "material cost after reversal", after.Totals.MaterialCost, "0")
	assertDecimal(t, "material usage after reversal", usageOfType(t, after, f.materialType.ID), "0")
	var main StatisticMachine
	for _, m := range after.Machines {
		if m.MachineID == f.machine.ID {
			main = m
		}
	}
	assertDecimal(t, "machine runtime", main.RuntimeHours, "3")
	for _, point := range after.MachineJobCounts {
		if point.Key == f.machine.ID.String() {
			assertDecimal(t, "machine job count", point.Value, "2")
		}
	}
	_ = keep
}

func TestDeleteRunAuthorizationBySource(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	editor := restrictedPrincipal(t, h.pool, authorization.MachineJobsRead, authorization.MachineJobsEdit)
	deleter := restrictedPrincipal(t, h.pool, authorization.MachineJobsRead, authorization.MachineJobsDelete)
	started, ended := at(h.now, -3*time.Hour), at(h.now, -2*time.Hour)
	recorded := func() uuid.UUID {
		id := h.insertRun(t, runSpec{machine: h.machine.ID, started: started, ended: ended})
		h.finish(t, id, "finished", *ended)
		return id
	}
	// A manual run that is not the last one can be removed with machine_jobs.edit.
	job := h.create(t, h.input(-10*time.Hour, time.Hour, "successful"))
	job = h.addRun(t, job, -8*time.Hour, time.Hour, outcomePtr("successful"))
	manual := job.Runs[1]
	if err := h.s.DeleteRun(ctx, editor, manual.ID, manual.Version, false, &h.request); err != nil {
		t.Fatalf("edit-only delete of a manual run: %v", err)
	}
	// A recorded run, assigned or not, needs machine_jobs.delete.
	assigned, unassigned := recorded(), recorded()
	withRun := h.attach(t, assigned, h.create(t, h.input(-20*time.Hour, time.Hour, "successful")), false)
	for _, id := range []uuid.UUID{assigned, unassigned} {
		run := h.run(t, id)
		if err := h.s.DeleteRun(ctx, editor, id, run.Version, false, &h.request); !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("edit-only delete of a recorded run: %v", err)
		}
	}
	if len(withRun.Runs) != 2 {
		t.Fatalf("job runs = %d", len(withRun.Runs))
	}
	for _, id := range []uuid.UUID{assigned, unassigned} {
		run := h.run(t, id)
		if err := h.s.DeleteRun(ctx, deleter, id, run.Version, false, &h.request); err != nil {
			t.Fatalf("delete of a recorded run: %v", err)
		}
	}
	// Deleting a job needs machine_jobs.delete.
	if err := h.s.DeleteJob(ctx, editor, job.ID, DeleteJobInput{ExpectedVersion: job.Version}, &h.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("edit-only job delete: %v", err)
	}
}

// usageOfType is the usage row of one material type; rows of other types can
// belong to earlier test runs that happened to pick the same year.
func usageOfType(t *testing.T, stats Statistics, typeID uuid.UUID) string {
	t.Helper()
	for _, point := range stats.MaterialUsageByType {
		if point.Key == typeID.String() {
			return point.Value
		}
	}
	t.Fatalf("no material usage row for type %s in %+v", typeID, stats.MaterialUsageByType)
	return ""
}
