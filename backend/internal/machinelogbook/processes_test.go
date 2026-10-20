package machinelogbook

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// processFixture adds an embroidery machine, a UV printer and cm2/ml/m material
// types to the job fixture.
type processFixture struct {
	*jobFixture
	embroideryType, uvType  MachineType
	embroidery, uv          Machine
	stabilizerType, inkType MaterialType
	stabilizer, ink         Material
	measureGroup            PricingGroup // prices stitches
	bareGroup               PricingGroup // runtime only: stitches stay unpriced
}

func newProcessFixture(t *testing.T) *processFixture {
	t.Helper()
	f := &processFixture{jobFixture: newJobFixture(t)}
	ctx := t.Context()
	suffix := strings.ReplaceAll(f.person.String(), "-", "")[:12]
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	var err error
	f.embroideryType, err = f.s.CreateMachineType(ctx, f.p, "Embroidery "+suffix, ProcessEmbroidery, &f.request)
	must(err)
	f.embroidery, err = f.s.CreateMachine(
		ctx,
		f.p,
		f.embroideryType.ID,
		"Embroidery machine "+suffix,
		"active",
		nil,
		false,
		&f.request,
	)
	must(err)
	f.uvType, err = f.s.CreateMachineType(ctx, f.p, "UV "+suffix, ProcessUVPrinting, &f.request)
	must(err)
	f.uv, err = f.s.CreateMachine(ctx, f.p, f.uvType.ID, "UV machine "+suffix, "active", nil, false, &f.request)
	must(err)
	f.stabilizerType, err = f.s.CreateMaterialType(
		ctx,
		f.p,
		"Stabilizer "+suffix,
		"m",
		[]string{ProcessEmbroidery},
		&f.request,
	)
	must(err)
	f.stabilizer, err = f.s.CreateMaterial(
		ctx,
		f.p,
		MaterialInput{Name: "Stabilizer " + suffix, MaterialTypeID: f.stabilizerType.ID},
		&f.request,
	)
	must(err)
	purchase, err := f.s.AddPurchase(
		ctx,
		f.p,
		f.stabilizer.ID,
		f.stabilizer.InventoryVersion,
		"100",
		"50",
		f.now,
		nil,
		nil,
		&f.request,
	)
	must(err)
	f.stabilizer = purchase.Material
	f.inkType, err = f.s.CreateMaterialType(ctx, f.p, "UV ink "+suffix, "ml", []string{ProcessUVPrinting}, &f.request)
	must(err)
	f.ink, err = f.s.CreateMaterial(
		ctx,
		f.p,
		MaterialInput{
			Name:           "UV ink cyan " + suffix,
			MaterialTypeID: f.inkType.ID,
			ColorName:      ptr("Cyan"),
			ColorHex:       ptr("#00AEEF"),
		},
		&f.request,
	)
	must(err)
	purchase, err = f.s.AddPurchase(
		ctx,
		f.p,
		f.ink.ID,
		f.ink.InventoryVersion,
		"100",
		"90",
		f.now,
		nil,
		nil,
		&f.request,
	)
	must(err)
	f.ink = purchase.Material

	f.measureGroup, err = f.s.CreatePricingGroup(ctx, f.p, "Measures "+suffix, nil, false, &f.request)
	must(err)
	f.bareGroup, err = f.s.CreatePricingGroup(ctx, f.p, "Bare "+suffix, nil, false, &f.request)
	must(err)
	stitches := MeasureStitches
	for _, group := range []PricingGroup{f.measureGroup, f.bareGroup} {
		_, err = f.s.CreatePricingRule(
			ctx,
			f.p,
			group.ID,
			"machine_runtime",
			&f.embroideryType.ID,
			nil,
			nil,
			"0",
			&f.request,
		)
		must(err)
		_, err = f.s.CreatePricingRule(ctx, f.p, group.ID, "material", nil, &f.stabilizerType.ID, nil, "1", &f.request)
		must(err)
	}
	_, err = f.s.CreatePricingRule(
		ctx,
		f.p,
		f.measureGroup.ID,
		"machine_measure",
		&f.embroideryType.ID,
		nil,
		&stitches,
		"0.5",
		&f.request,
	)
	must(err)
	_, err = f.s.CreatePricingRule(
		ctx,
		f.p,
		f.measureGroup.ID,
		"machine_runtime",
		&f.uvType.ID,
		nil,
		nil,
		"0",
		&f.request,
	)
	must(err)

	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		f.deleteWork(cleanup)
		for _, id := range []uuid.UUID{f.measureGroup.ID, f.bareGroup.ID} {
			_, _ = f.pool.Exec(cleanup, `DELETE FROM pricing_groups WHERE id = $1`, id)
		}
		for _, material := range []Material{f.stabilizer, f.ink} {
			_, _ = f.pool.Exec(cleanup, `DELETE FROM inventory_transactions WHERE material_id = $1`, material.ID)
			_, _ = f.pool.Exec(cleanup, `DELETE FROM materials WHERE id = $1`, material.ID)
		}
		for _, id := range []uuid.UUID{f.stabilizerType.ID, f.inkType.ID} {
			_, _ = f.pool.Exec(cleanup, `DELETE FROM material_types WHERE id = $1`, id)
		}
		for _, machine := range []Machine{f.embroidery, f.uv} {
			_, _ = f.pool.Exec(cleanup, `DELETE FROM machines WHERE id = $1`, machine.ID)
		}
		for _, id := range []uuid.UUID{f.embroideryType.ID, f.uvType.ID} {
			_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_types WHERE id = $1`, id)
		}
	})
	return f
}

func priceIs(value *string, want string) bool { return value != nil && sameDecimal(*value, want) }

func sameDecimal(a, b string) bool {
	x, err := decimal.NewFromString(a)
	if err != nil {
		return false
	}
	y, err := decimal.NewFromString(b)
	return err == nil && x.Equal(y)
}

// deleteWork removes the runs and jobs the process tests created.
func (f *processFixture) deleteWork(ctx context.Context) {
	for _, machine := range []Machine{f.embroidery, f.uv} {
		_, _ = f.pool.Exec(ctx, `DELETE FROM machine_runs WHERE machine_id = $1`, machine.ID)
		_, _ = f.pool.Exec(ctx, `DELETE FROM machine_jobs WHERE machine_id = $1`, machine.ID)
	}
}

func (f *processFixture) embroideryJob(
	t *testing.T,
	group PricingGroup,
	measures RunMeasures,
	usages ...UsageInput,
) MachineJob {
	t.Helper()
	input := f.input(-2*time.Hour, 6*time.Minute, "successful")
	input.MachineID = f.embroidery.ID
	input.PricingGroupID = &group.ID
	input.Measures = measures
	input.Usages = usages
	return f.create(t, input)
}

func TestMachineTypeProcessValidationAndAudit(t *testing.T) {
	f := newProcessFixture(t)
	ctx := t.Context()
	if f.embroideryType.Process != ProcessEmbroidery {
		t.Fatalf("process = %s", f.embroideryType.Process)
	}
	if _, err := f.s.CreateMachineType(
		ctx,
		f.p,
		"Invalid "+f.embroideryType.ID.String(),
		"milling",
		&f.request,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("unknown process: %v", err)
	}
	if _, err := f.s.CreateMachineType(
		ctx,
		f.p,
		"Empty "+f.embroideryType.ID.String(),
		"",
		&f.request,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("empty process: %v", err)
	}
	process := "milling"
	if _, err := f.s.UpdateMachineType(
		ctx,
		f.p,
		f.uvType.ID,
		f.uvType.Version,
		nil,
		nil,
		&process,
		&f.request,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("update to unknown process: %v", err)
	}
	laser := ProcessLaserCutting
	updated, err := f.s.UpdateMachineType(ctx, f.p, f.uvType.ID, f.uvType.Version, nil, nil, &laser, &f.request)
	if err != nil || updated.Process != ProcessLaserCutting {
		t.Fatalf("update process: %v %+v", err, updated)
	}
	machine, err := f.s.GetMachine(ctx, f.p, f.uv.ID)
	if err != nil || machine.MachineType.Process != ProcessLaserCutting {
		t.Fatalf("machine shows type process: %v %+v", err, machine.MachineType)
	}
	var audited int
	if err = f.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE request_id = $1 AND action = 'machine_type.updated' AND resource_id = $2 AND 'process' = ANY(changed_fields)`,
		f.request,
		f.uvType.ID,
	).Scan(&audited); err != nil ||
		audited != 1 {
		t.Fatalf("audit of process change: %d %v", audited, err)
	}
}

func TestMaterialTypeProcessesAreRequiredAndStored(t *testing.T) {
	f := newProcessFixture(t)
	ctx := t.Context()
	suffix := strings.ReplaceAll(f.person.String(), "-", "")[:12]
	if _, err := f.s.CreateMaterialType(ctx, f.p, "None "+suffix, "g", nil, &f.request); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("no processes: %v", err)
	}
	if _, err := f.s.CreateMaterialType(
		ctx,
		f.p,
		"Bad "+suffix,
		"g",
		[]string{"milling"},
		&f.request,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("unknown process: %v", err)
	}
	created, err := f.s.CreateMaterialType(
		ctx,
		f.p,
		"Sticker paper "+suffix,
		"cm2",
		[]string{ProcessUVPrinting, ProcessEmbroidery, ProcessUVPrinting},
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM material_types WHERE id = $1`, created.ID)
	})
	if created.Unit != "cm2" || strings.Join(created.Processes, ",") != "embroidery,uv_printing" {
		t.Fatalf("created = %+v", created)
	}
	updated, err := f.s.UpdateMaterialType(
		ctx,
		f.p,
		created.ID,
		created.Version,
		created.Name,
		"cm2",
		nil,
		true,
		&f.request,
	)
	if err != nil || strings.Join(updated.Processes, ",") != "embroidery,uv_printing" {
		t.Fatalf("nil processes keep: %v %+v", err, updated)
	}
	if _, err = f.s.UpdateMaterialType(
		ctx,
		f.p,
		created.ID,
		updated.Version,
		created.Name,
		"cm2",
		[]string{},
		true,
		&f.request,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("empty processes: %v", err)
	}
	replaced, err := f.s.UpdateMaterialType(
		ctx,
		f.p,
		created.ID,
		updated.Version,
		created.Name,
		"cm2",
		[]string{ProcessLaserCutting},
		true,
		&f.request,
	)
	if err != nil || strings.Join(replaced.Processes, ",") != "laser_cutting" {
		t.Fatalf("replace: %v %+v", err, replaced)
	}
	listed, err := f.s.ListMaterialTypes(ctx, f.p)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range listed {
		if item.ID == created.ID {
			found = strings.Join(item.Processes, ",") == "laser_cutting"
		}
	}
	if !found {
		t.Fatal("list does not show the replaced processes")
	}
}

func TestMaterialProcessMismatchIsRefusedForNewUsages(t *testing.T) {
	f := newProcessFixture(t)
	ctx := t.Context()
	fdmOnly := UsageInput{
		MaterialID:    f.material.ID,
		Ownership:     "makerspace",
		Quantity:      "10",
		QuantityBasis: "actual",
	} // fixture PLA: fdm_printing + other
	ink := UsageInput{MaterialID: f.ink.ID, Ownership: "makerspace", Quantity: "1.25", QuantityBasis: "actual"}
	stabilizer := UsageInput{
		MaterialID:    f.stabilizer.ID,
		Ownership:     "makerspace",
		Quantity:      "0.4",
		QuantityBasis: "actual",
	}

	// Creating a job on the embroidery machine with PLA or ink is refused; nothing is stored.
	for name, usage := range map[string]UsageInput{"fdm material": fdmOnly, "uv ink": ink} {
		input := f.input(-2*time.Hour, 6*time.Minute, "successful")
		input.MachineID = f.embroidery.ID
		input.PricingGroupID = &f.measureGroup.ID
		input.Usages = []UsageInput{usage}
		if _, err := f.s.CreateManualJob(ctx, f.p, input, &f.request); !apperror.IsCode(
			err,
			"material_process_mismatch",
		) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	var runs int
	if err := f.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM machine_runs WHERE machine_id = $1`,
		f.embroidery.ID,
	).Scan(&runs); err != nil ||
		runs != 0 {
		t.Fatalf("runs after refused jobs: %d %v", runs, err)
	}

	job := f.embroideryJob(t, f.measureGroup, nil, stabilizer)
	if len(job.Runs[0].Usages) != 1 {
		t.Fatalf("matching material was not recorded: %+v", job.Runs[0].Usages)
	}
	// Customer material is free text on any machine.
	external := UsageInput{
		Ownership:            "external",
		ExternalMaterialName: ptr("Customer cotton thread"),
		Quantity:             "3",
		QuantityBasis:        "actual",
	}
	job, err := f.s.AddManualRun(
		ctx,
		f.p,
		job.ID,
		job.Version,
		ManualRunInput{
			StartsAt: f.now.Add(-time.Hour),
			EndsAt:   f.now.Add(-50 * time.Minute),
			Usages:   []UsageInput{external},
		},
		&f.request,
	)
	if err != nil {
		t.Fatalf("external material: %v", err)
	}
	// AddManualRun and ReplaceRunUsages enforce the process as well.
	if _, err = f.s.AddManualRun(
		ctx,
		f.p,
		job.ID,
		job.Version,
		ManualRunInput{
			StartsAt: f.now.Add(-45 * time.Minute),
			EndsAt:   f.now.Add(-40 * time.Minute),
			Usages:   []UsageInput{ink},
		},
		&f.request,
	); !apperror.IsCode(
		err,
		"material_process_mismatch",
	) {
		t.Fatalf("add run: %v", err)
	}
	run := job.Runs[0]
	if _, err = f.s.ReplaceRunUsages(
		ctx,
		f.p,
		run.ID,
		run.Version,
		[]UsageInput{stabilizer, ink},
		&f.request,
	); !apperror.IsCode(
		err,
		"material_process_mismatch",
	) {
		t.Fatalf("replace usages: %v", err)
	}

	// Material that no longer matches keeps working on the run that already uses it
	// and stays visible, but cannot be chosen again elsewhere.
	if _, err = f.s.UpdateMaterialType(
		ctx,
		f.p,
		f.stabilizerType.ID,
		f.stabilizerType.Version,
		f.stabilizerType.Name,
		"m",
		[]string{ProcessUVPrinting},
		true,
		&f.request,
	); err != nil {
		t.Fatal(err)
	}
	stabilizer.Quantity = "0.6"
	result, err := f.s.ReplaceRunUsages(ctx, f.p, run.ID, run.Version, []UsageInput{stabilizer}, &f.request)
	if err != nil {
		t.Fatalf("correcting a run that used the material: %v", err)
	}
	if len(result.Run.Usages) != 1 || result.Run.Usages[0].MaterialID == nil ||
		*result.Run.Usages[0].MaterialID != f.stabilizer.ID {
		t.Fatalf("old material is not shown: %+v", result.Run.Usages)
	}
	other := job.Runs[1]
	if _, err = f.s.ReplaceRunUsages(
		ctx,
		f.p,
		other.ID,
		other.Version,
		[]UsageInput{stabilizer},
		&f.request,
	); !apperror.IsCode(
		err,
		"material_process_mismatch",
	) {
		t.Fatalf("same material on another run after the type changed: %v", err)
	}
}

func TestRunMeasuresAreValidatedAgainstTheProcess(t *testing.T) {
	f := newProcessFixture(t)
	ctx := t.Context()

	job := f.embroideryJob(t, f.measureGroup, RunMeasures{MeasureStitches: 12400})
	if got := job.Runs[0].Measures[MeasureStitches]; got != 12400 {
		t.Fatalf("run stitches = %d", got)
	}
	if got := job.Measures[MeasureStitches]; got != 12400 {
		t.Fatalf("job stitches = %d", got)
	}

	// A machine whose process records no stitches refuses them (create and add run).
	input := f.input(-2*time.Hour, 6*time.Minute, "successful")
	input.Measures = RunMeasures{MeasureStitches: 5}
	if _, err := f.s.CreateManualJob(ctx, f.p, input, &f.request); !apperror.IsCode(err, "run_measure_unsupported") {
		t.Fatalf("stitches on a non-embroidery machine: %v", err)
	}
	if _, err := f.s.AddManualRun(
		ctx,
		f.p,
		job.ID,
		job.Version,
		ManualRunInput{
			StartsAt: f.now.Add(-time.Hour),
			EndsAt:   f.now.Add(-50 * time.Minute),
			Measures: RunMeasures{"colour_changes": 3},
		},
		&f.request,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("unknown measure: %v", err)
	}
	if _, err := f.s.AddManualRun(
		ctx,
		f.p,
		job.ID,
		job.Version,
		ManualRunInput{
			StartsAt: f.now.Add(-time.Hour),
			EndsAt:   f.now.Add(-50 * time.Minute),
			Measures: RunMeasures{MeasureStitches: -1},
		},
		&f.request,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("negative stitches: %v", err)
	}

	// A second run adds up on the job; editing replaces a run's measures; clearing removes them.
	job, err := f.s.AddManualRun(
		ctx,
		f.p,
		job.ID,
		job.Version,
		ManualRunInput{
			StartsAt: f.now.Add(-time.Hour),
			EndsAt:   f.now.Add(-50 * time.Minute),
			Measures: RunMeasures{MeasureStitches: 600},
		},
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := job.Measures[MeasureStitches]; got != 13000 {
		t.Fatalf("job stitches over runs = %d", got)
	}
	run := job.Runs[1]
	result, err := f.s.UpdateRun(
		ctx,
		f.p,
		run.ID,
		run.Version,
		RunUpdate{Measures: RunMeasures{MeasureStitches: 100}},
		&f.request,
	)
	if err != nil || result.Run.Measures[MeasureStitches] != 100 || result.Job.Measures[MeasureStitches] != 12500 {
		t.Fatalf("update measures: %v %+v", err, result)
	}
	if _, err = f.s.UpdateRun(
		ctx,
		f.p,
		run.ID,
		result.Run.Version,
		RunUpdate{Measures: RunMeasures{"uv_ink": 1}},
		&f.request,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("unknown measure on update: %v", err)
	}
	cleared, err := f.s.UpdateRun(ctx, f.p, run.ID, result.Run.Version, RunUpdate{Measures: RunMeasures{}}, &f.request)
	if err != nil || len(cleared.Run.Measures) != 0 || cleared.Job.Measures[MeasureStitches] != 12400 {
		t.Fatalf("clear measures: %v %+v", err, cleared)
	}
	// Not giving measures leaves them alone.
	kept, err := f.s.UpdateRun(
		ctx,
		f.p,
		job.Runs[0].ID,
		job.Runs[0].Version,
		RunUpdate{Outcome: ptr(RunOutcomeSuccessful)},
		&f.request,
	)
	if err != nil || kept.Run.Measures[MeasureStitches] != 12400 {
		t.Fatalf("measures after outcome change: %v %+v", err, kept)
	}
	// The same update on a non-embroidery machine is refused.
	plain := f.create(t, f.input(-3*time.Hour, 6*time.Minute, "successful"))
	if _, err = f.s.UpdateRun(
		ctx,
		f.p,
		plain.Runs[0].ID,
		plain.Runs[0].Version,
		RunUpdate{Measures: RunMeasures{MeasureStitches: 1}},
		&f.request,
	); !apperror.IsCode(
		err,
		"run_measure_unsupported",
	) {
		t.Fatalf("update measures on other machine: %v", err)
	}
	// Moving a job with stitches to a machine whose process does not record them is refused.
	update := JobUpdate{
		MachineID:        f.machine.ID,
		OperatorPersonID: f.person,
		Customer:         PartyReference{Kind: "person", ID: f.person},
	}
	latest, err := f.s.GetJob(ctx, f.p, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.UpdateJobFacts(ctx, f.p, job.ID, latest.Version, update, &f.request); !apperror.IsCode(
		err,
		"run_measure_unsupported",
	) {
		t.Fatalf("machine change with stitches: %v", err)
	}
}

func TestMeasurePricingIsExactPerBlock(t *testing.T) {
	f := newProcessFixture(t)
	for _, test := range []struct {
		name     string
		stitches int64
		price    string
	}{
		{"exact on the stitch", 12400, "6.20"},
		{"fraction of a block rounds once", 12345, "6.17"}, // 6.1725
		{"single stitch rounds to zero", 1, "0.00"},        // 0.0005
		{"whole blocks", 2000, "1.00"},                     // 2 blocks
		{"half cent rounds up", 30, "0.02"},                // 0.015
		{"no stitches entered still complete", 0, "0.00"},  // no value, no charge
		{"big job", 1_000_001, "500.00"},                   // 500.0005
		{"just below a block boundary", 999, "0.50"},       // 0.4995
		{"just above a block boundary", 1001, "0.50"},      // 0.5005
		{"stitches per run exceed int32", 3_000_000_000, "1500000.00"},
	} {
		t.Run(test.name, func(t *testing.T) {
			measures := RunMeasures{}
			if test.stitches > 0 {
				measures[MeasureStitches] = test.stitches
			}
			job := f.embroideryJob(t, f.measureGroup, measures)
			if job.PricingStatus != "complete" || !priceIs(job.CalculatedPrice, test.price) {
				t.Fatalf("status %s price %s, want %s", job.PricingStatus, price(job.CalculatedPrice), test.price)
			}
			var rate *PricingSnapshotRule
			for i, rule := range job.PricingSnapshot.Rules {
				if rule.Kind == "machine_measure" {
					rate = &job.PricingSnapshot.Rules[i]
				}
			}
			if rate == nil || rate.Missing || rate.Rate == nil || !sameDecimal(*rate.Rate, "0.5") ||
				rate.BlockSize == nil ||
				*rate.BlockSize != 1000 ||
				rate.Measure == nil ||
				*rate.Measure != MeasureStitches ||
				rate.Unit != "stitch" {
				t.Fatalf("snapshot rule = %+v", rate)
			}
		})
	}
}

func TestMeasurePricingFollowsRunChangesAndKeepsItsSnapshot(t *testing.T) {
	f := newProcessFixture(t)
	ctx := t.Context()
	job := f.embroideryJob(
		t,
		f.measureGroup,
		RunMeasures{MeasureStitches: 12400},
		UsageInput{MaterialID: f.stabilizer.ID, Ownership: "makerspace", Quantity: "0.4", QuantityBasis: "actual"},
	)
	if !priceIs(job.CalculatedPrice, "6.60") { // 6.20 stitches + 0.4 m stabilizer at 1 per m
		t.Fatalf("price = %s", price(job.CalculatedPrice))
	}
	// Editing the stitches reprices from the same snapshot rate.
	run := job.Runs[0]
	result, err := f.s.UpdateRun(
		ctx,
		f.p,
		run.ID,
		run.Version,
		RunUpdate{Measures: RunMeasures{MeasureStitches: 20000}},
		&f.request,
	)
	if err != nil || !priceIs(result.Job.CalculatedPrice, "10.40") {
		t.Fatalf("after edit: %v %s", err, price(result.Job.CalculatedPrice))
	}
	// A later change of the group's rate does not touch the snapshot.
	var ruleID uuid.UUID
	var version int64
	if err = f.pool.QueryRow(
		ctx,
		`SELECT id, version FROM pricing_rules WHERE pricing_group_id = $1 AND kind = 'machine_measure'`,
		f.measureGroup.ID,
	).Scan(&ruleID, &version); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.UpdatePricingRule(
		ctx,
		f.p,
		ruleID,
		version,
		"machine_measure",
		&f.embroideryType.ID,
		nil,
		ptr(MeasureStitches),
		"5",
		true,
		&f.request,
	); err != nil {
		t.Fatal(err)
	}
	again, err := f.s.UpdateRun(
		ctx,
		f.p,
		run.ID,
		result.Run.Version,
		RunUpdate{Measures: RunMeasures{MeasureStitches: 24000}},
		&f.request,
	)
	if err != nil || !priceIs(again.Job.CalculatedPrice, "12.40") {
		t.Fatalf("after rate change: %v %s", err, price(again.Job.CalculatedPrice))
	}
	// A new job captures the new rate.
	fresh := f.embroideryJob(t, f.measureGroup, RunMeasures{MeasureStitches: 1000})
	if !priceIs(fresh.CalculatedPrice, "5.00") {
		t.Fatalf("new job price = %s", price(fresh.CalculatedPrice))
	}
}

func TestMeasurePricingIsIncompleteWithoutARuleAndFreeAtZero(t *testing.T) {
	f := newProcessFixture(t)
	ctx := t.Context()

	// The group has no stitches rule: a value cannot be priced.
	job := f.embroideryJob(t, f.bareGroup, RunMeasures{MeasureStitches: 12400})
	if job.PricingStatus != "incomplete" || job.CalculatedPrice != nil {
		t.Fatalf("status %s price %s", job.PricingStatus, price(job.CalculatedPrice))
	}
	var missing bool
	for _, rule := range job.PricingSnapshot.Rules {
		if rule.Kind == "machine_measure" {
			missing = rule.Missing && rule.Rate == nil
		}
	}
	if !missing {
		t.Fatalf("snapshot should record the missing measure rule: %+v", job.PricingSnapshot.Rules)
	}
	// Without a value the missing rule does not matter.
	free := f.embroideryJob(t, f.bareGroup, nil)
	if free.PricingStatus != "complete" || !priceIs(free.CalculatedPrice, "0.00") {
		t.Fatalf("no stitches: %s %s", free.PricingStatus, price(free.CalculatedPrice))
	}
	// Entering stitches later makes the job incomplete again; removing them completes it.
	run := free.Runs[0]
	result, err := f.s.UpdateRun(
		ctx,
		f.p,
		run.ID,
		run.Version,
		RunUpdate{Measures: RunMeasures{MeasureStitches: 500}},
		&f.request,
	)
	if err != nil || result.Job.PricingStatus != "incomplete" {
		t.Fatalf("stitches added: %v %s", err, result.Job.PricingStatus)
	}
	result, err = f.s.UpdateRun(ctx, f.p, run.ID, result.Run.Version, RunUpdate{Measures: RunMeasures{}}, &f.request)
	if err != nil || result.Job.PricingStatus != "complete" || !priceIs(result.Job.CalculatedPrice, "0.00") {
		t.Fatalf("stitches removed: %v %s", err, result.Job.PricingStatus)
	}

	// A zero rate is a price: stitches are free and the job is complete.
	zeroGroup, err := f.s.CreatePricingGroup(
		ctx,
		f.p,
		"Zero stitches "+f.embroideryType.ID.String(),
		nil,
		false,
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM pricing_groups WHERE id = $1`, zeroGroup.ID)
	})
	for _, rule := range []struct {
		kind    PricingRuleKind
		machine *uuid.UUID
		measure *string
	}{{"machine_runtime", &f.embroideryType.ID, nil}, {"machine_measure", &f.embroideryType.ID, ptr(MeasureStitches)}} {
		if _, err = f.s.CreatePricingRule(
			ctx,
			f.p,
			zeroGroup.ID,
			rule.kind,
			rule.machine,
			nil,
			rule.measure,
			"0",
			&f.request,
		); err != nil {
			t.Fatal(err)
		}
	}
	zero := f.embroideryJob(t, zeroGroup, RunMeasures{MeasureStitches: 50000})
	if zero.PricingStatus != "complete" || !priceIs(zero.CalculatedPrice, "0.00") {
		t.Fatalf("zero rate: %s %s", zero.PricingStatus, price(zero.CalculatedPrice))
	}
}

// A measure that first appears after the snapshot was taken (here: the machine type
// became an embroidery type later) makes the job capture its pricing group again.
func TestMeasureAppearingAfterTheSnapshotRecapturesIt(t *testing.T) {
	f := newProcessFixture(t)
	ctx := t.Context()
	suffix := strings.ReplaceAll(f.person.String(), "-", "")[:12]
	lateType, err := f.s.CreateMachineType(ctx, f.p, "Late embroidery "+suffix, ProcessOther, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	lateMachine, err := f.s.CreateMachine(
		ctx,
		f.p,
		lateType.ID,
		"Late machine "+suffix,
		"active",
		nil,
		false,
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup := context.Background()
		_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_runs WHERE machine_id = $1`, lateMachine.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_jobs WHERE machine_id = $1`, lateMachine.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM pricing_rules WHERE machine_type_id = $1`, lateType.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM machines WHERE id = $1`, lateMachine.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_types WHERE id = $1`, lateType.ID)
	})
	if _, err = f.s.CreatePricingRule(
		ctx,
		f.p,
		f.measureGroup.ID,
		"machine_runtime",
		&lateType.ID,
		nil,
		nil,
		"0",
		&f.request,
	); err != nil {
		t.Fatal(err)
	}
	input := f.input(-2*time.Hour, 6*time.Minute, "successful")
	input.MachineID = lateMachine.ID
	input.PricingGroupID = &f.measureGroup.ID
	job := f.create(t, input)
	for _, rule := range job.PricingSnapshot.Rules {
		if rule.Kind == "machine_measure" {
			t.Fatalf("a non-embroidery machine should not capture measure rules: %+v", rule)
		}
	}
	embroidery := ProcessEmbroidery
	if _, err = f.s.UpdateMachineType(
		ctx,
		f.p,
		lateType.ID,
		lateType.Version,
		nil,
		nil,
		&embroidery,
		&f.request,
	); err != nil {
		t.Fatal(err)
	}
	stitches := MeasureStitches
	if _, err = f.s.CreatePricingRule(
		ctx,
		f.p,
		f.measureGroup.ID,
		"machine_measure",
		&lateType.ID,
		nil,
		&stitches,
		"0.5",
		&f.request,
	); err != nil {
		t.Fatal(err)
	}
	run := job.Runs[0]
	result, err := f.s.UpdateRun(
		ctx,
		f.p,
		run.ID,
		run.Version,
		RunUpdate{Measures: RunMeasures{MeasureStitches: 2000}},
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Job.PricingStatus != "complete" || !priceIs(result.Job.CalculatedPrice, "1.00") {
		t.Fatalf("after stitches appeared: %s %s", result.Job.PricingStatus, price(result.Job.CalculatedPrice))
	}
	if result.Job.PricingSnapshot.Revision != 2 {
		t.Fatalf("snapshot revision = %d, want a new snapshot", result.Job.PricingSnapshot.Revision)
	}
}

func TestMeasureRulesNeedAMachineTypeWhoseProcessRecordsTheMeasure(t *testing.T) {
	f := newProcessFixture(t)
	ctx := t.Context()
	stitches := MeasureStitches
	// UV printing records no stitches.
	if _, err := f.s.CreatePricingRule(
		ctx,
		f.p,
		f.bareGroup.ID,
		"machine_measure",
		&f.uvType.ID,
		nil,
		&stitches,
		"1",
		&f.request,
	); !apperror.IsCode(
		err,
		"run_measure_unsupported",
	) {
		t.Fatalf("rule for unsupported process: %v", err)
	}
	for name, call := range map[string]func() error{
		"no measure": func() error {
			_, err := f.s.CreatePricingRule(
				ctx,
				f.p,
				f.bareGroup.ID,
				"machine_measure",
				&f.embroideryType.ID,
				nil,
				nil,
				"1",
				&f.request,
			)
			return err
		},
		"unknown measure": func() error {
			_, err := f.s.CreatePricingRule(
				ctx,
				f.p,
				f.bareGroup.ID,
				"machine_measure",
				&f.embroideryType.ID,
				nil,
				ptr("colour_changes"),
				"1",
				&f.request,
			)
			return err
		},
		"no machine type": func() error {
			_, err := f.s.CreatePricingRule(
				ctx,
				f.p,
				f.bareGroup.ID,
				"machine_measure",
				nil,
				nil,
				&stitches,
				"1",
				&f.request,
			)
			return err
		},
		"material selector": func() error {
			_, err := f.s.CreatePricingRule(
				ctx,
				f.p,
				f.bareGroup.ID,
				"machine_measure",
				&f.embroideryType.ID,
				&f.stabilizerType.ID,
				&stitches,
				"1",
				&f.request,
			)
			return err
		},
		"measure on runtime": func() error {
			_, err := f.s.CreatePricingRule(
				ctx,
				f.p,
				f.bareGroup.ID,
				"machine_runtime",
				&f.uvType.ID,
				nil,
				&stitches,
				"1",
				&f.request,
			)
			return err
		},
		"measure on material": func() error {
			_, err := f.s.CreatePricingRule(
				ctx,
				f.p,
				f.bareGroup.ID,
				"material",
				nil,
				&f.inkType.ID,
				&stitches,
				"1",
				&f.request,
			)
			return err
		},
		"negative rate": func() error {
			_, err := f.s.CreatePricingRule(
				ctx,
				f.p,
				f.bareGroup.ID,
				"machine_measure",
				&f.embroideryType.ID,
				nil,
				&stitches,
				"-1",
				&f.request,
			)
			return err
		},
	} {
		if err := call(); !apperror.IsCode(err, "validation_failed") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	rule, err := f.s.CreatePricingRule(
		ctx,
		f.p,
		f.bareGroup.ID,
		"machine_measure",
		&f.embroideryType.ID,
		nil,
		&stitches,
		"0.5",
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	if rule.Measure == nil || *rule.Measure != MeasureStitches || rule.BlockSize == nil || *rule.BlockSize != 1000 ||
		!sameDecimal(rule.Rate, "0.5") {
		t.Fatalf("rule = %+v", rule)
	}
	if _, err = f.s.CreatePricingRule(
		ctx,
		f.p,
		f.bareGroup.ID,
		"machine_measure",
		&f.embroideryType.ID,
		nil,
		&stitches,
		"0.7",
		&f.request,
	); err == nil {
		t.Fatal("second active rule for the same machine type and measure was accepted")
	}
	groups, err := f.s.ListPricingGroups(ctx, f.p)
	if err != nil {
		t.Fatal(err)
	}
	listed := false
	for _, group := range groups {
		if group.ID != f.bareGroup.ID {
			continue
		}
		for _, r := range group.Rules {
			listed = listed || (r.ID == rule.ID && r.Measure != nil && r.BlockSize != nil && *r.BlockSize == 1000)
		}
	}
	if !listed {
		t.Fatal("the group lists the measure rule with its block size")
	}
}

func TestSquareCentimetreAndMetreMaterialsAreConsumedAndPriced(t *testing.T) {
	f := newProcessFixture(t)
	ctx := t.Context()
	suffix := strings.ReplaceAll(f.person.String(), "-", "")[:12]
	paperType, err := f.s.CreateMaterialType(
		ctx,
		f.p,
		"DTF paper "+suffix,
		"cm2",
		[]string{ProcessUVPrinting},
		&f.request,
	)
	if err != nil || paperType.Unit != "cm2" {
		t.Fatalf("cm2 type: %v %+v", err, paperType)
	}
	paper, err := f.s.CreateMaterial(
		ctx,
		f.p,
		MaterialInput{Name: "DTF paper A4 " + suffix, MaterialTypeID: paperType.ID},
		&f.request,
	)
	if err != nil || paper.Unit != "cm2" {
		t.Fatalf("cm2 material: %v %+v", err, paper)
	}
	t.Cleanup(func() {
		cleanup := context.Background()
		f.deleteWork(cleanup)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM pricing_rules WHERE material_type_id = $1`, paperType.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM inventory_transactions WHERE material_id = $1`, paper.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM materials WHERE id = $1`, paper.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM material_types WHERE id = $1`, paperType.ID)
	})
	purchase, err := f.s.AddPurchase(
		ctx,
		f.p,
		paper.ID,
		paper.InventoryVersion,
		"20000",
		"60",
		f.now,
		nil,
		nil,
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	paper = purchase.Material
	if _, err = f.s.CreatePricingRule(
		ctx,
		f.p,
		f.measureGroup.ID,
		"material",
		nil,
		&paperType.ID,
		nil,
		"0.004",
		&f.request,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.CreateMaterialType(
		ctx,
		f.p,
		"Bad unit "+suffix,
		"mm2",
		[]string{"other"},
		&f.request,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("unknown unit: %v", err)
	}
	input := f.input(-2*time.Hour, 6*time.Minute, "successful")
	input.MachineID = f.uv.ID
	input.PricingGroupID = &f.measureGroup.ID
	input.Usages = []UsageInput{
		{MaterialID: paper.ID, Ownership: "makerspace", Quantity: "180", QuantityBasis: "actual"},
		{MaterialID: f.ink.ID, Ownership: "makerspace", Quantity: "3.20", QuantityBasis: "actual"},
	}
	job := f.create(t, input)
	// 180 cm2 * 0.004 = 0.72; ink has no rule in this group -> incomplete, rule list shows both.
	if job.PricingStatus != "incomplete" {
		t.Fatalf("status = %s", job.PricingStatus)
	}
	units := map[string]string{}
	for _, u := range job.Usages {
		units[u.MaterialName] = u.Unit
	}
	if units[paper.Name] != "cm2" || units[f.ink.Name] != "ml" {
		t.Fatalf("usage units = %v", units)
	}
	if _, err = f.s.CreatePricingRule(
		ctx,
		f.p,
		f.measureGroup.ID,
		"material",
		nil,
		&f.inkType.ID,
		nil,
		"0.9",
		&f.request,
	); err != nil {
		t.Fatal(err)
	}
	priced := f.create(t, input)
	// 0.72 + 3.20 ml * 0.9 = 0.72 + 2.88 = 3.60
	if priced.PricingStatus != "complete" || !priceIs(priced.CalculatedPrice, "3.60") {
		t.Fatalf("priced = %s %s", priced.PricingStatus, price(priced.CalculatedPrice))
	}
}

func TestWorkItemsSummariseConsumptionPerUnit(t *testing.T) {
	f := newProcessFixture(t)
	job := f.embroideryJob(
		t,
		f.measureGroup,
		RunMeasures{MeasureStitches: 12400},
		UsageInput{MaterialID: f.stabilizer.ID, Ownership: "makerspace", Quantity: "0.4", QuantityBasis: "actual"},
	)
	items, _, err := f.s.ListWorkItems(
		t.Context(),
		f.p,
		WorkItemFilters{MachineIDs: []uuid.UUID{f.embroidery.ID}, Page: 1, PageSize: 25},
	)
	if err != nil || len(items) != 1 || items[0].ID != job.ID {
		t.Fatalf("items = %+v, %v", items, err)
	}
	c := items[0].Consumption
	if c.Measures[MeasureStitches] != 12400 || len(c.Materials) != 1 || c.Materials[0].Unit != "m" ||
		!sameDecimal(c.Materials[0].Quantity, "0.4") ||
		c.Materials[0].MaterialTypeName != f.stabilizerType.Name {
		t.Fatalf("consumption = %+v", c)
	}
}
