package machinelogbook

import (
	"context"
	"slices"
	"testing"
	"time"

	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
)

func TestAJobKeptOffSignageHidesAllItsRuns(t *testing.T) {
	h := newLiveRunHarness(t)
	ctx := t.Context()
	signage := signagedb.New(h.pool)
	hiddenMachines := func() []uuid.UUID {
		t.Helper()
		ids, err := signage.ListSignageHiddenMachineIDs(ctx, time.Now().UTC())
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}
	runID := h.insertRun(
		t,
		runSpec{machine: h.machine.ID, state: "running", started: at(h.now, -time.Hour), fileName: "hidden.gcode"},
	)
	if slices.Contains(hiddenMachines(), h.machine.ID) {
		t.Fatal("a run without any flag hides its machine")
	}
	hidden := true
	job, err := h.s.CreateJobFromRun(
		ctx,
		h.p,
		runID,
		RunJobInput{
			Customer:          PartyReference{Kind: "person", ID: h.person},
			OperatorPersonID:  h.person,
			PricingGroupID:    &h.group.ID,
			HiddenFromSignage: &hidden,
		},
		&h.request,
	)
	if err != nil || !job.HiddenFromSignage {
		t.Fatalf("claim hidden: %v %+v", err, job.HiddenFromSignage)
	}
	run := h.run(t, runID)
	if run.HiddenFromSignage || !run.JobHiddenFromSignage {
		t.Fatalf("run flags = own %v job %v", run.HiddenFromSignage, run.JobHiddenFromSignage)
	}
	if !slices.Contains(hiddenMachines(), h.machine.ID) {
		t.Fatal("the hidden job's running run does not hide its machine")
	}
	// Showing the job again through the update keeps the job version semantics of an ordinary edit.
	shown := false
	updated, err := h.s.UpdateJobFacts(ctx, h.p, job.ID, job.Version, JobUpdate{
		MachineID:         job.Machine.ID,
		OperatorPersonID:  h.person,
		HiddenFromSignage: &shown,
	}, &h.request)
	if err != nil || updated.HiddenFromSignage {
		t.Fatalf("show job: %v %v", err, updated.HiddenFromSignage)
	}
	if slices.Contains(hiddenMachines(), h.machine.ID) {
		t.Fatal("a shown job still hides its machine")
	}
	// Attaching a run can hide an existing job without bumping its version for orders.
	other := h.insertRun(t, runSpec{machine: h.machine.ID, state: "running", started: at(h.now, -time.Minute)})
	attached, err := h.s.AttachRun(ctx, h.p, other, job.ID, false, updated.Version, &hidden, &h.request)
	if err != nil || !attached.HiddenFromSignage {
		t.Fatalf("attach hidden: %v", err)
	}
	if h.auditCount(t, "machine_job.run_attached", job.ID) != 1 {
		t.Fatal("attach audit missing")
	}
	// A finished run of a hidden job never offers its timelapse to signage.
	h.finish(t, runID, "finished", h.now)
	fileID := insertTimelapse(t, h, runID)
	if _, err = signage.GetSignageTimelapse(ctx, runID); err == nil {
		t.Fatal("the timelapse of a hidden job's run is served to signage")
	}
	if _, err = h.pool.Exec(ctx, `UPDATE machine_jobs SET hidden_from_signage = false WHERE id = $1`, job.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := signage.GetSignageTimelapse(ctx, runID); err != nil || got.FileID != fileID {
		t.Fatalf("visible timelapse: %v", err)
	}
}

func insertTimelapse(t *testing.T, h *runHarness, runID uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := t.Context()
	fileID := uuid.Must(uuid.NewV7())
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO files (id, storage_key, original_filename, content_type, size_bytes, sha256)
		 VALUES ($1, $2, 'timelapse.mp4', 'video/mp4', 10, decode(repeat('ab', 32), 'hex'))`,
		fileID,
		"test/"+fileID.String(),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO machine_run_timelapses (run_id, file_id, size_bytes, sha256) VALUES ($1, $2, 10, decode(repeat('ab', 32), 'hex'))`,
		runID,
		fileID,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(), `DELETE FROM machine_run_timelapses WHERE run_id = $1`, runID)
		_, _ = h.pool.Exec(context.Background(), `DELETE FROM files WHERE id = $1`, fileID)
	})
	return fileID
}
