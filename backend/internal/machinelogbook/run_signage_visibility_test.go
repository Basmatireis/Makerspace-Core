package machinelogbook

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func TestRunSignageVisibilityIsLimitedToEditorsAndTheJobsPeople(t *testing.T) {
	h := newLiveRunHarness(t)
	ctx := t.Context()
	runID := h.insertRun(
		t,
		runSpec{machine: h.machine.ID, state: "running", started: at(h.now, -time.Hour), fileName: "x.gcode"},
	)
	customer := restrictedPrincipal(t, h.pool)
	stranger := restrictedPrincipal(t, h.pool, authorization.MachineJobsRead)
	editor := restrictedPrincipal(t, h.pool, authorization.MachineJobsEdit)
	// The operator is the master's person, but acts here without any permission.
	operator := authorization.Principal{AccountID: h.p.AccountID, PersonID: h.person}
	denied := func(who authorization.Principal, label string) {
		t.Helper()
		if _, err := h.s.SetRunSignageHidden(ctx, who, runID, true, &h.request); !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("%s: %v", label, err)
		}
	}
	denied(stranger, "unrelated person on a run without job")
	title := "Hidden"
	if _, err := h.s.CreateJobFromRun(
		ctx,
		h.p,
		runID,
		RunJobInput{
			Title:            &title,
			Customer:         PartyReference{Kind: "person", ID: customer.PersonID},
			OperatorPersonID: h.person,
			PricingGroupID:   &h.group.ID,
		},
		&h.request,
	); err != nil {
		t.Fatal(err)
	}
	if h.run(t, runID).HiddenFromSignage {
		t.Fatal("a new run must start visible")
	}
	denied(stranger, "unrelated person")
	denied(authorization.Principal{AccountID: h.p.AccountID}, "principal without person or permissions")
	if h.run(t, runID).HiddenFromSignage || h.auditCount(t, "machine_run.signage_visibility_set", runID) != 0 {
		t.Fatal("a denied call changed the run or wrote an audit event")
	}
	before := h.run(t, runID).Version
	people := map[string]authorization.Principal{"operator": operator, "customer": customer, "editor": editor}
	for name, who := range people {
		for _, hidden := range []bool{true, false} {
			run, err := h.s.SetRunSignageHidden(ctx, who, runID, hidden, &h.request)
			if err != nil || run.HiddenFromSignage != hidden {
				t.Fatalf("%s sets hidden=%v: %v %+v", name, hidden, err, run)
			}
		}
	}
	run, err := h.s.SetRunSignageHidden(ctx, operator, runID, true, &h.request)
	if err != nil || !run.HiddenFromSignage || run.Version != before {
		t.Fatalf("hide: %v hidden=%v version %d -> %d", err, run.HiddenFromSignage, before, run.Version)
	}
	if got := h.auditCount(t, "machine_run.signage_visibility_set", runID); got != 7 {
		t.Fatalf("audit events = %d", got)
	}
	// Once the run has ended, the flag is frozen in both directions.
	h.finish(t, runID, "finished", h.now)
	for _, hidden := range []bool{true, false} {
		_, err = h.s.SetRunSignageHidden(ctx, operator, runID, hidden, &h.request)
		if !apperror.IsCode(err, "run_ended") {
			t.Fatalf("ended run hidden=%v: %v", hidden, err)
		}
	}
}

func TestManualRunSignageVisibilityFollowsItsPlannedEnd(t *testing.T) {
	f := newLiveJobFixture(t)
	ctx := t.Context()
	running := f.create(t, f.input(-time.Hour, 3*time.Hour, JobOutcomeUnknown))
	if len(running.Runs) != 1 {
		t.Fatalf("runs: %+v", running.Runs)
	}
	run, err := f.s.SetRunSignageHidden(ctx, f.p, running.Runs[0].ID, true, &f.request)
	if err != nil || !run.HiddenFromSignage {
		t.Fatalf("running manual run: %v %+v", err, run)
	}
	finished := f.create(t, f.input(-5*time.Hour, time.Hour, JobOutcomeSuccessful))
	if _, err = f.s.SetRunSignageHidden(ctx, f.p, finished.Runs[0].ID, true, &f.request); !apperror.IsCode(err, "run_ended") {
		t.Fatalf("finished manual run: %v", err)
	}
	if _, err = f.s.SetRunSignageHidden(ctx, f.p, finished.ID, true, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown run: %v", err)
	}
}
