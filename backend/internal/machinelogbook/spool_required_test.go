package machinelogbook

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func TestManualRunFilamentMustComeFromASpool(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()

	loose := f.input(-10*time.Hour, time.Hour, "successful")
	loose.Usages = []UsageInput{{MaterialID: f.material.ID, Quantity: "50"}}
	if _, err := f.s.CreateManualJob(ctx, f.p, loose, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("filament without a spool: %v", err)
	}
	if got := f.quantity(t, f.material.ID); got != "1000" {
		t.Fatalf("a refused booking changed the stock: %s", got)
	}
	// The same rule holds for a run added to a job.
	job := f.create(t, f.input(-9*time.Hour, time.Hour, "successful"))
	start := f.now.Truncate(time.Second).Add(-8 * time.Hour)
	if _, err := f.s.AddManualRun(ctx, f.p, job.ID, job.Version, ManualRunInput{
		StartsAt: start, EndsAt: start.Add(time.Hour), Usages: []UsageInput{{MaterialID: f.material.ID, Quantity: "5"}},
	}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("added run without a spool: %v", err)
	}

	withSpool := f.input(-7*time.Hour, time.Hour, "successful")
	withSpool.Usages = []UsageInput{f.use("50")}
	created := f.create(t, withSpool)
	usages := created.Runs[0].Usages
	if len(usages) != 1 || usages[0].SpoolID == nil || *usages[0].SpoolID != f.spool.ID {
		t.Fatalf("usages = %+v", usages)
	}
	if got := f.quantity(t, f.material.ID); got != "950" {
		t.Fatalf("stock after booking on the spool = %s", got)
	}
	if spool := f.getSpool(t); spool.RemainingQuantity != "950" {
		t.Fatalf("spool remaining = %s", spool.RemainingQuantity)
	}
}

func (f *jobFixture) getSpool(t *testing.T) FilamentSpool {
	t.Helper()
	spool, err := f.s.GetFilamentSpool(t.Context(), f.p, f.spool.ID)
	if err != nil {
		t.Fatal(err)
	}
	return spool
}

func TestOtherMaterialKindsNeedNoSpool(t *testing.T) {
	f := newUnitsFixture(t)
	cm := "cm"
	m := f.stock(t, f.article(t, "Cord spool-free ", &cm), "1000", "10")
	in := f.input(-2*time.Hour, time.Hour, "successful")
	in.Usages = []UsageInput{{MaterialID: m.ID, Quantity: "200"}}
	job := f.create(t, in)
	if len(job.Runs[0].Usages) != 1 || job.Runs[0].Usages[0].SpoolID != nil {
		t.Fatalf("usages = %+v", job.Runs[0].Usages)
	}
	if got := f.quantity(t, m.ID); got != "800" {
		t.Fatalf("stock = %s", got)
	}
}

func TestLegacyLooseFilamentUsageStaysCorrectable(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()
	in := f.input(-10*time.Hour, time.Hour, "successful")
	in.Usages = []UsageInput{f.use("50")}
	job := f.create(t, in)
	run := job.Runs[0]
	// The service no longer books loose filament; turn the usage into one from before spools were required.
	if tag, err := f.pool.Exec(
		ctx,
		`UPDATE machine_run_usages SET spool_id = NULL, spool_display_id = NULL WHERE run_id = $1`, run.ID,
	); err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("convert usage: %v %d", err, tag.RowsAffected())
	}
	loose := UsageInput{MaterialID: f.material.ID, Quantity: "50"}

	// Raising what comes from loose stock is refused; the run stays as it was.
	if _, err := f.s.ReplaceRunUsages(
		ctx, f.p, run.ID, run.Version, []UsageInput{{MaterialID: f.material.ID, Quantity: "60"}}, &f.request,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("raised loose quantity: %v", err)
	}
	// Adding a second loose usage for the same article beyond the allowance is refused too.
	if _, err := f.s.ReplaceRunUsages(
		ctx, f.p, run.ID, run.Version, []UsageInput{loose, {MaterialID: f.material.ID, Quantity: "1"}}, &f.request,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("second loose usage: %v", err)
	}
	// Resubmitting it unchanged works, and lowering it does as well.
	result, err := f.s.ReplaceRunUsages(ctx, f.p, run.ID, run.Version, []UsageInput{loose}, &f.request)
	if err != nil {
		t.Fatalf("unchanged resubmit: %v", err)
	}
	result, err = f.s.ReplaceRunUsages(
		ctx, f.p, run.ID, result.Run.Version, []UsageInput{{MaterialID: f.material.ID, Quantity: "40"}}, &f.request,
	)
	if err != nil {
		t.Fatalf("lowered loose quantity: %v", err)
	}
	// Moving it onto a spool is always allowed.
	result, err = f.s.ReplaceRunUsages(ctx, f.p, run.ID, result.Run.Version, []UsageInput{f.use("60")}, &f.request)
	if err != nil {
		t.Fatalf("replace by a spool usage: %v", err)
	}
	if usages := result.Run.Usages; len(usages) != 1 || usages[0].SpoolID == nil || *usages[0].SpoolID != f.spool.ID {
		t.Fatalf("usages = %+v", usages)
	}
	// Now that the run holds no loose usage any more, loose filament is refused again.
	if _, err = f.s.ReplaceRunUsages(
		ctx, f.p, run.ID, result.Run.Version, []UsageInput{loose}, &f.request,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("loose usage after the move: %v", err)
	}
}
