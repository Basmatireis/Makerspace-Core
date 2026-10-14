package machinelogbook

import (
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func TestJobMachineChangeMovesManualRunsAndIsRefusedWithARecordedRun(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	job := h.create(t, h.input(-4*time.Hour, time.Hour, "successful"))
	job = h.addRun(t, job, -2*time.Hour, time.Hour, outcomePtr("successful"))
	moved := h.edit(t, job, func(u *JobUpdate) { u.MachineID = h.bareMachine.ID; u.PricingGroupID = &h.group.ID })
	if moved.Machine.ID != h.bareMachine.ID || len(moved.Runs) != 2 {
		t.Fatalf("moved job: %+v", moved)
	}
	for _, run := range moved.Runs {
		if got := h.run(t, run.ID); got.MachineID != h.bareMachine.ID {
			t.Fatalf("manual run %s stayed on machine %s", run.ID, got.MachineID)
		}
	}
	// A recorded run pins the job to its machine.
	recorded := h.insertRun(t, runSpec{machine: h.bareMachine.ID, started: at(h.now, -time.Hour), ended: at(h.now, -30*time.Minute)})
	attached := h.attach(t, recorded, moved, false)
	update := JobUpdate{MachineID: h.machine.ID, OperatorPersonID: h.person, Customer: PartyReference{Kind: "person", ID: h.person}}
	if _, err := h.s.UpdateJobFacts(ctx, h.p, attached.ID, attached.Version, update, &h.request); !apperror.IsCode(err, "machine_change_not_allowed") {
		t.Fatalf("machine change with a recorded run: %v", err)
	}
}

// Job operations and connector events for the same job lock the job first, so
// running them against each other never deadlocks.
func TestConcurrentJobUpdateAndConnectorEventDoNotDeadlock(t *testing.T) {
	h := newRunHarness(t)
	ctx := t.Context()
	runID := h.insertRun(t, runSpec{machine: h.machine.ID, state: "running", started: at(h.now, -2*time.Hour), fileName: "live.gcode"})
	job := h.attach(t, runID, h.create(t, h.input(-2*time.Hour, time.Hour, "unknown")), true)
	const iterations = 20
	edits := 0
	for i := 0; i < iterations; i++ {
		title := "Concurrent edit " + time.Duration(i).String()
		var wg sync.WaitGroup
		start := make(chan struct{})
		var editErr, eventErr error
		var updated MachineJob
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			update := JobUpdate{MachineID: job.Machine.ID, Title: &title, OperatorPersonID: h.person, Customer: PartyReference{Kind: "person", ID: h.person}}
			updated, editErr = h.s.UpdateJobFacts(ctx, h.p, job.ID, job.Version, update, &h.request)
		}()
		go func() {
			defer wg.Done()
			<-start
			tx, err := h.pool.Begin(ctx)
			if err != nil {
				eventErr = err
				return
			}
			defer tx.Rollback(ctx)
			if eventErr = h.s.ApplyRecordedRunEvent(ctx, tx, RecordedRunEvent{RunID: runID, ConnectorID: h.connectorID, Kind: "progress"}); eventErr == nil {
				eventErr = tx.Commit(ctx)
			}
		}()
		close(start)
		wg.Wait()
		if eventErr != nil && !apperror.IsCode(eventErr, "retry_conflict") {
			t.Fatalf("iteration %d: connector event: %v", i, eventErr)
		}
		if editErr != nil && !apperror.IsCode(editErr, "retry_conflict") {
			t.Fatalf("iteration %d: job update: %v", i, editErr)
		}
		if editErr == nil {
			edits++
			job = updated
		}
		current, err := h.s.GetJob(ctx, h.p, job.ID)
		if err != nil || current.Version != job.Version || current.Status != "running" || len(current.Runs) != 2 {
			t.Fatalf("iteration %d: inconsistent job %v %+v", i, err, current)
		}
	}
	if edits == 0 {
		t.Fatal("no job update succeeded")
	}
	if run := h.run(t, runID); run.Job == nil || run.Job.ID != job.ID {
		t.Fatalf("run left the job: %+v", run)
	}
}
