package machinelogbook

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func TestRecycleBinRestoresAndPurgesJobsAndRuns(t *testing.T) {
	h := newRunHarness(t)
	f := h.jobFixture
	ctx := t.Context()
	manual := f.manualJob(t, -10*time.Hour, "50")
	held := h.unassigned(t, h.machine.ID, -8*time.Hour, "held.gcode")
	withRun, err := h.s.CreateJobFromRun(ctx, h.p, held.ID, RunJobInput{
		Customer: PartyReference{Kind: "person", ID: h.person}, OperatorPersonID: h.person, PricingGroupID: &h.group.ID,
	}, &h.request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.s.RecycleBin(ctx, authorization.Principal{}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("bin without the delete permission: %v", err)
	}

	// Deleting the manual job takes its runs along; deleting the job with the recorded run detaches that run.
	if err = h.s.DeleteJob(ctx, h.p, manual.ID, DeleteJobInput{ExpectedVersion: manual.Version}, &h.request); err != nil {
		t.Fatal(err)
	}
	if err = h.s.DeleteJob(ctx, h.p, withRun.ID, DeleteJobInput{ExpectedVersion: withRun.Version}, &h.request); err != nil {
		t.Fatal(err)
	}
	bin, err := h.s.RecycleBin(ctx, h.p)
	if err != nil {
		t.Fatal(err)
	}
	find := func(id uuid.UUID) *DeletedJob {
		for i := range bin.Jobs {
			if bin.Jobs[i].ID == id {
				return &bin.Jobs[i]
			}
		}
		return nil
	}
	manualEntry, runEntry := find(manual.ID), find(withRun.ID)
	if manualEntry == nil || manualEntry.DeletedRunCount < 1 || manualEntry.DetachedRunCount != 0 || manualEntry.DeletedByName == nil {
		t.Fatalf("manual job in the bin = %+v", manualEntry)
	}
	if runEntry == nil || runEntry.DeletedRunCount != 0 || runEntry.DetachedRunCount != 1 {
		t.Fatalf("job with recorded run in the bin = %+v", runEntry)
	}
	if deleted, assigned := h.runAssigned(t, held.ID); deleted || assigned {
		t.Fatalf("detached run: deleted=%v assigned=%v", deleted, assigned)
	}

	// Restoring brings the runs back: the manual ones out of the bin, the recorded one into the job again.
	if _, err = h.s.RestoreJob(ctx, h.p, manual.ID, manualEntry.Version+1, &h.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("restore with a stale version: %v", err)
	}
	restored, err := h.s.RestoreJob(ctx, h.p, manual.ID, manualEntry.Version, &h.request)
	if err != nil || restored.ID != manual.ID || len(restored.Runs) < 1 {
		t.Fatalf("restored manual job = %+v, %v", restored, err)
	}
	if _, err = h.s.RestoreJob(ctx, h.p, withRun.ID, runEntry.Version, &h.request); err != nil {
		t.Fatal(err)
	}
	if deleted, assigned := h.runAssigned(t, held.ID); deleted || !assigned {
		t.Fatalf("recorded run after restoring its job: deleted=%v assigned=%v", deleted, assigned)
	}
	if f.auditCount(t, "machine_job.restored", manual.ID) != 1 || f.auditCount(t, "machine_job.restored", withRun.ID) != 1 {
		t.Fatal("restore audit events missing")
	}
	if bin, err = h.s.RecycleBin(ctx, h.p); err != nil || find(manual.ID) != nil || find(withRun.ID) != nil {
		t.Fatalf("bin after restoring = %+v, %v", bin.Jobs, err)
	}

	// A run deleted on its own comes back as it was; a run whose job is in the bin comes back unassigned.
	loose := h.insertRun(t, runSpec{machine: h.machine.ID, state: "running", started: at(h.now, -5*time.Hour), fileName: "loose.gcode"})
	if err = h.s.DeleteRun(ctx, h.p, loose, h.run(t, loose).Version, false, &h.request); err != nil {
		t.Fatal(err)
	}
	bin, err = h.s.RecycleBin(ctx, h.p)
	if err != nil || len(bin.Runs) != 1 || bin.Runs[0].ID != loose || bin.Runs[0].FormerJobDisplayID != nil || bin.Runs[0].FormerJobInBin {
		t.Fatalf("deleted run in the bin = %+v, %v", bin.Runs, err)
	}
	if _, err = h.s.RestoreRun(ctx, h.p, loose, bin.Runs[0].Version, &h.request); err != nil {
		t.Fatal(err)
	}
	if deleted, assigned := h.runAssigned(t, loose); deleted || assigned {
		t.Fatalf("restored loose run: deleted=%v assigned=%v", deleted, assigned)
	}
	job, err := h.s.GetJob(ctx, h.p, withRun.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.s.DeleteJob(ctx, h.p, job.ID, DeleteJobInput{ExpectedVersion: job.Version, DeleteRecordedRuns: true}, &h.request); err != nil {
		t.Fatal(err)
	}
	bin, err = h.s.RecycleBin(ctx, h.p)
	if err != nil || len(bin.Runs) != 1 || bin.Runs[0].ID != held.ID || !bin.Runs[0].FormerJobInBin {
		t.Fatalf("run deleted with its job = %+v, %v", bin.Runs, err)
	}
	if _, err = h.s.RestoreRun(ctx, h.p, held.ID, bin.Runs[0].Version, &h.request); err != nil {
		t.Fatal(err)
	}
	if deleted, assigned := h.runAssigned(t, held.ID); deleted || assigned {
		t.Fatalf("run restored while its job is in the bin: deleted=%v assigned=%v", deleted, assigned)
	}

	// A job whose material is booked in the ledger stays in the bin: the ledger is immutable.
	manualAgain, err := h.s.GetJob(ctx, h.p, manual.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.s.DeleteJob(ctx, h.p, manual.ID, DeleteJobInput{ExpectedVersion: manualAgain.Version}, &h.request); err != nil {
		t.Fatal(err)
	}
	bin, err = h.s.RecycleBin(ctx, h.p)
	if err != nil || find(manual.ID) == nil || !find(manual.ID).HasInventoryBookings {
		t.Fatalf("bin with the booked job = %+v, %v", bin.Jobs, err)
	}
	if err = h.s.PurgeJob(ctx, h.p, manual.ID, find(manual.ID).Version, &h.request); !apperror.IsCode(err, "inventory_bookings_exist") {
		t.Fatalf("purging a job with ledger bookings: %v", err)
	}

	// Purging removes the rows for good; the job takes the runs that went into the bin with it.
	bin, err = h.s.RecycleBin(ctx, h.p)
	if err != nil {
		t.Fatal(err)
	}
	entry := find(withRun.ID)
	if entry == nil {
		t.Fatal("job missing from the bin before purging")
	}
	if err = h.s.PurgeJob(ctx, h.p, withRun.ID, entry.Version, &h.request); err != nil {
		t.Fatal(err)
	}
	var jobs int
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM machine_jobs WHERE id = $1`, withRun.ID).Scan(&jobs); err != nil || jobs != 0 {
		t.Fatalf("job rows after purging = %d, %v", jobs, err)
	}
	run := h.run(t, loose)
	if err = h.s.DeleteRun(ctx, h.p, loose, run.Version, false, &h.request); err != nil {
		t.Fatal(err)
	}
	if err = h.s.PurgeRun(ctx, h.p, loose, run.Version+1, &h.request); err != nil {
		t.Fatal(err)
	}
	var runs int
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM machine_runs WHERE id = $1`, loose).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("run rows after purging = %d, %v", runs, err)
	}
	if err = h.s.PurgeRun(ctx, h.p, loose, 1, &h.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("purging again: %v", err)
	}
	if f.auditCount(t, "machine_run.purged", loose) != 1 || f.auditCount(t, "machine_job.purged", withRun.ID) != 1 {
		t.Fatal("purge audit events missing")
	}
}
