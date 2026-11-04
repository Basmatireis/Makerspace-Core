package printerconnectors

import (
	"fmt"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// refillRig is one AMS slot whose first spool ran out during a print and was
// replaced by second at change.
type refillRig struct {
	name, unit, slot string
	first, second    uuid.UUID
	start, change    time.Time
}

// newSpool registers a spool of material, or of a fresh article (and type) when material is nil.
func (h *ingestHarness) newSpool(name string, material *uuid.UUID, at time.Time) uuid.UUID {
	h.t.Helper()
	ctx := h.t.Context()
	if material == nil {
		diameter := "1.75"
		materialType, err := h.logbook.CreateMaterialType(ctx, h.principal, "PETG "+name+" "+h.suffix, "filament", "g", nil, nil)
		if err != nil {
			h.t.Fatal(err)
		}
		created, err := h.logbook.CreateMaterial(
			ctx,
			h.principal,
			machinelogbook.MaterialInput{
				Name:               "Segment " + name + " " + h.suffix,
				MaterialTypeID:     materialType.ID,
				FilamentDiameterMM: &diameter,
			},
			nil,
		)
		if err != nil {
			h.t.Fatal(err)
		}
		material = &created.ID
	}
	var version int64
	if err := h.pool.QueryRow(ctx, `SELECT version FROM material_balances WHERE material_id = $1`, *material).Scan(&version); err != nil {
		h.t.Fatal(err)
	}
	total := "20"
	spool, err := h.logbook.CreateFilamentSpool(
		ctx,
		h.principal,
		machinelogbook.FilamentSpoolInput{
			MaterialID:               *material,
			InitialNetWeightG:        "1000",
			StockMode:                "new_acquisition",
			TotalPrice:               &total,
			OccurredAt:               at,
			ExpectedInventoryVersion: version,
		},
		nil,
	)
	if err != nil {
		h.t.Fatal(err)
	}
	return spool.ID
}

// swapSpool closes the open mount of from and, unless to is nil, mounts to in the same slot.
func (h *ingestHarness) swapSpool(from uuid.UUID, to *uuid.UUID, at time.Time) {
	h.t.Helper()
	var slotID uuid.UUID
	if err := h.pool.QueryRow(
		h.t.Context(),
		`UPDATE printer_spool_assignments SET unmounted_at = $2 WHERE spool_id = $1 AND unmounted_at IS NULL RETURNING slot_id`,
		from,
		at,
	).Scan(&slotID); err != nil {
		h.t.Fatal(err)
	}
	if to == nil {
		return
	}
	if _, err := h.pool.Exec(
		h.t.Context(),
		`INSERT INTO printer_spool_assignments (id, slot_id, spool_id, mounted_at, source) VALUES ($1, $2, $3, $4, 'manual')`,
		ids.New(),
		slotID,
		*to,
		at,
	); err != nil {
		h.t.Fatal(err)
	}
}

// newRefillRig mounts a spool and replaces it 20 minutes into a print that
// starts at start: with a spool of the same article, of another article, with
// nothing Core knows of ("unknown"), or not at all in Core ("none").
func (h *ingestHarness) newRefillRig(name, refill string) refillRig {
	h.t.Helper()
	rig := refillRig{name: name, unit: h.unitExternal(name), slot: "slot-" + name + "-" + h.suffix}
	rig.start = time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	rig.change = rig.start.Add(20 * time.Minute)
	rig.first = h.mountSpool(name, &rig.slot, rig.start.Add(-time.Hour))
	switch refill {
	case "same":
		material := h.materialOfSpool(rig.first)
		rig.second = h.newSpool(name+" refill", &material, rig.start.Add(-time.Hour))
		h.swapSpool(rig.first, &rig.second, rig.change)
	case "other":
		rig.second = h.newSpool(name+" refill", nil, rig.start.Add(-time.Hour))
		h.swapSpool(rig.first, &rig.second, rig.change)
	case "none":
	default:
		h.swapSpool(rig.first, nil, rig.change)
	}
	return rig
}

// segmentReport is a G-code checkpoint report of one 12.5 g line fed by the
// rig's slot before and after the change, split as given.
func (rig refillRig) segmentReport(firstGrams, secondGrams string) string {
	segment := func(at time.Time, layer int, grams string) string {
		quantity := ""
		if grams != "" {
			quantity = fmt.Sprintf(`,"estimatedQuantityGrams":%q,"split":"gcode_layer"`, grams)
		}
		return fmt.Sprintf(
			`{"inputUnitExternalId":%q,"slotExternalId":%q,"startedAt":%q,"startLayer":%d%s}`,
			rig.unit, rig.slot, at.Format(time.RFC3339), layer, quantity,
		)
	}
	return `{"items":[{"slicerFilamentId":"1","estimatedQuantityGrams":"12.5","method":"gcode_checkpoint",` +
		`"calculationVersion":"bambu-gcode-v1","quality":"medium","segments":[` +
		segment(rig.start.Add(time.Minute), 1, firstGrams) + `,` +
		segment(rig.change.Add(time.Minute), 40, secondGrams) + `]}]}`
}

// print records a completed run of the rig and its revision 1 report.
func (h *ingestHarness) print(rig refillRig, report string) uuid.UUID {
	h.t.Helper()
	runID := ids.New()
	h.accepted(runID, "progress", rig.start, `{"state":"printing","percent":1}`)
	h.accepted(runID, "terminal_outcome", rig.start.Add(30*time.Minute), `{"outcome":"completed"}`)
	h.report(runID, rig.start.Add(31*time.Minute), report, 1)
	return runID
}

// activeUsages maps each active usage's spool to its quantity and article.
func (h *ingestHarness) activeUsages(runID uuid.UUID) (map[uuid.UUID]string, map[uuid.UUID]uuid.UUID) {
	h.t.Helper()
	rows, err := h.pool.Query(
		h.t.Context(),
		`SELECT spool_id, material_id, quantity::numeric(20,3)::text FROM machine_run_usages WHERE run_id = $1 AND active`,
		runID,
	)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()
	quantities, materials := map[uuid.UUID]string{}, map[uuid.UUID]uuid.UUID{}
	for rows.Next() {
		var spool, material uuid.UUID
		var quantity string
		if err = rows.Scan(&spool, &material, &quantity); err != nil {
			h.t.Fatal(err)
		}
		quantities[spool], materials[spool] = quantity, material
	}
	if err = rows.Err(); err != nil {
		h.t.Fatal(err)
	}
	return quantities, materials
}

func (h *ingestHarness) spoolAttention(spoolID uuid.UUID) []machinelogbook.AttentionCode {
	h.t.Helper()
	spool, err := h.logbook.GetFilamentSpool(h.t.Context(), h.principal, spoolID)
	if err != nil {
		h.t.Fatal(err)
	}
	codes := make([]machinelogbook.AttentionCode, 0, len(spool.Attention))
	for _, item := range spool.Attention {
		codes = append(codes, item.Code)
	}
	return codes
}

func hasAttention(codes []machinelogbook.AttentionCode, code machinelogbook.AttentionCode) bool {
	for _, item := range codes {
		if item == code {
			return true
		}
	}
	return false
}

// A line fed by two spools of the same article during one print is booked on
// both, each with its segment's quantity; the spool that ran out is flagged
// until someone weighs it.
func TestIngestBooksEachSpoolSegmentOnItsOwnSpool(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	rig := h.newRefillRig("Refill", "same")
	runID := h.print(rig, rig.segmentReport("6.875000", "5.625000"))

	quantities, _ := h.activeUsages(runID)
	if len(quantities) != 2 || quantities[rig.first] != "6.875" || quantities[rig.second] != "5.625" {
		t.Fatalf("usages = %v", quantities)
	}
	run, err := h.logbook.GetRun(ctx, h.principal, runID)
	if err != nil {
		t.Fatal(err)
	}
	if run.ConsumptionStatus == nil || run.ConsumptionStatus.State != machinelogbook.ConsumptionRecorded ||
		run.MaterialChangedDuringRun || len(run.ReportedUsageItems) != 1 {
		t.Fatalf("run status=%+v changed=%v items=%d", run.ConsumptionStatus, run.MaterialChangedDuringRun, len(run.ReportedUsageItems))
	}
	segments := run.ReportedUsageItems[0].Segments
	if run.ReportedUsageItems[0].SpoolID != nil || len(segments) != 2 || segments[0].SpoolID == nil ||
		*segments[0].SpoolID != rig.first || segments[1].SpoolID == nil || *segments[1].SpoolID != rig.second ||
		segments[1].StartLayer == nil || *segments[1].StartLayer != 40 || segments[1].Split == nil ||
		*segments[1].Split != "gcode_layer" || !segments[1].StartedAt.Equal(rig.change.Add(time.Minute)) {
		t.Fatalf("segments = %+v", segments)
	}

	if codes := h.spoolAttention(rig.first); !hasAttention(codes, machinelogbook.AttentionRanOutDuringRun) {
		t.Fatalf("ran-out spool attention = %v", codes)
	}
	if codes := h.spoolAttention(rig.second); hasAttention(codes, machinelogbook.AttentionRanOutDuringRun) {
		t.Fatalf("refill spool attention = %v", codes)
	}
	listed, _, err := h.logbook.ListFilamentSpools(ctx, h.principal, machinelogbook.SpoolFilters{Search: "Refill " + h.suffix, Page: 1, PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	flagged := 0
	for _, spool := range listed {
		for _, item := range spool.Attention {
			if item.Code == machinelogbook.AttentionRanOutDuringRun {
				flagged++
			}
		}
	}
	if flagged != 1 {
		t.Fatalf("listed ran-out spools = %d of %d", flagged, len(listed))
	}

	// Weighing the spool answers the suggestion.
	spool, err := h.logbook.GetFilamentSpool(ctx, h.principal, rig.first)
	if err != nil {
		t.Fatal(err)
	}
	var inventory int64
	if err = h.pool.QueryRow(ctx, `SELECT version FROM material_balances WHERE material_id = $1`, spool.MaterialID).Scan(&inventory); err != nil {
		t.Fatal(err)
	}
	if _, err = h.logbook.CorrectFilamentSpoolStock(
		ctx, h.principal, rig.first, inventory, spool.Version, "3", nil, time.Now().UTC(), "inventory_count", nil, nil,
	); err != nil {
		t.Fatal(err)
	}
	if codes := h.spoolAttention(rig.first); hasAttention(codes, machinelogbook.AttentionRanOutDuringRun) {
		t.Fatalf("attention after weighing = %v", codes)
	}
}

// Segments on spools of different articles book each article and price it;
// the run says that the material changed, and retiring the empty spool clears
// its flag.
func TestIngestBooksSegmentsOfDifferentArticlesAndFlagsTheChange(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	rig := h.newRefillRig("Colour", "other")
	firstMaterial, secondMaterial := h.materialOfSpool(rig.first), h.materialOfSpool(rig.second)
	group, err := h.logbook.CreatePricingGroup(ctx, h.principal, "Segment pricing "+h.suffix, nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.logbook.CreatePricingRule(ctx, h.principal, group.ID, "machine_runtime", &h.machine.Process.ID, nil, nil, "10", nil); err != nil {
		t.Fatal(err)
	}
	for material, rate := range map[uuid.UUID]string{firstMaterial: "1", secondMaterial: "2"} {
		var typeID uuid.UUID
		if err = h.pool.QueryRow(ctx, `SELECT material_type_id FROM materials WHERE id = $1`, material).Scan(&typeID); err != nil {
			t.Fatal(err)
		}
		if _, err = h.logbook.CreatePricingRule(ctx, h.principal, group.ID, "material", nil, &typeID, nil, rate, nil); err != nil {
			t.Fatal(err)
		}
	}
	runID := ids.New()
	h.accepted(runID, "progress", rig.start, `{"state":"printing","percent":1}`)
	job, err := h.logbook.CreateJobFromRun(
		ctx,
		h.principal,
		runID,
		machinelogbook.RunJobInput{
			Customer:         machinelogbook.PartyReference{Kind: "person", ID: h.principal.PersonID},
			OperatorPersonID: h.principal.PersonID,
			PricingGroupID:   &group.ID,
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	h.accepted(runID, "terminal_outcome", rig.start.Add(30*time.Minute), `{"outcome":"completed"}`)
	h.report(runID, rig.start.Add(31*time.Minute), rig.segmentReport("6.875000", "5.625000"), 1)

	quantities, materials := h.activeUsages(runID)
	if quantities[rig.first] != "6.875" || quantities[rig.second] != "5.625" ||
		materials[rig.first] != firstMaterial || materials[rig.second] != secondMaterial {
		t.Fatalf("usages = %v materials = %v", quantities, materials)
	}
	settled, err := h.logbook.GetJob(ctx, h.principal, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 30 minutes at 10/h, 6.875 g at 1 and 5.625 g at 2.
	if settled.PricingStatus != "complete" || settled.CalculatedPrice == nil || *settled.CalculatedPrice != "23.13" ||
		!settled.Runs[0].MaterialChangedDuringRun {
		t.Fatalf("job pricing %s price %v changed %v", settled.PricingStatus, settled.CalculatedPrice, settled.Runs[0].MaterialChangedDuringRun)
	}
	segments := settled.Runs[0].ReportedUsageItems[0].Segments
	if len(segments) != 2 || segments[0].SpoolMaterialID == nil || *segments[0].SpoolMaterialID != firstMaterial ||
		segments[1].SpoolMaterialID == nil || *segments[1].SpoolMaterialID != secondMaterial {
		t.Fatalf("segments = %+v", segments)
	}

	if codes := h.spoolAttention(rig.first); !hasAttention(codes, machinelogbook.AttentionRanOutDuringRun) {
		t.Fatalf("ran-out spool attention = %v", codes)
	}
	spool, err := h.logbook.GetFilamentSpool(ctx, h.principal, rig.first)
	if err != nil {
		t.Fatal(err)
	}
	retired, err := h.logbook.RetireFilamentSpool(ctx, h.principal, rig.first, spool.Version, machinelogbook.SpoolRetiredEmpty, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range retired.Attention {
		if item.Code == machinelogbook.AttentionRanOutDuringRun {
			t.Fatalf("retired spool attention = %+v", retired.Attention)
		}
	}
}

// A segment that resolves to no spool is not booked: the other one is, the
// run is partial with segment_without_spool, and staff complete the usage
// with the existing usage replacement.
func TestIngestLeavesASegmentWithoutSpoolToStaff(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	rig := h.newRefillRig("Stray", "unknown")
	runID := h.print(rig, rig.segmentReport("6.875000", "5.625000"))

	quantities, _ := h.activeUsages(runID)
	if len(quantities) != 1 || quantities[rig.first] != "6.875" {
		t.Fatalf("usages = %v", quantities)
	}
	run, err := h.logbook.GetRun(ctx, h.principal, runID)
	if err != nil {
		t.Fatal(err)
	}
	if run.ConsumptionStatus == nil || run.ConsumptionStatus.State != machinelogbook.ConsumptionPartial ||
		run.ConsumptionStatus.Reason == nil || *run.ConsumptionStatus.Reason != machinelogbook.ReasonSegmentWithoutSpool {
		t.Fatalf("status = %+v", run.ConsumptionStatus)
	}
	// The feed moved on to a tray Core has no spool for: the first spool still ran out.
	if codes := h.spoolAttention(rig.first); !hasAttention(codes, machinelogbook.AttentionRanOutDuringRun) {
		t.Fatalf("ran-out spool attention = %v", codes)
	}

	// Staff record the refill they loaded; the machine's part stays as it is.
	material := h.materialOfSpool(rig.first)
	refill := h.newSpool("Stray refill", &material, rig.start.Add(-time.Hour))
	staff := []machinelogbook.UsageInput{
		{MaterialID: material, SpoolID: &rig.first, Ownership: "makerspace", Quantity: "6.875", QuantityBasis: "estimated"},
		{MaterialID: material, SpoolID: &refill, Ownership: "makerspace", Quantity: "5.625", QuantityBasis: "estimated"},
	}
	result, err := h.logbook.ReplaceRunUsages(ctx, h.principal, runID, run.Version, staff, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Run.ConsumptionStatus == nil || result.Run.ConsumptionStatus.State != machinelogbook.ConsumptionRecorded ||
		result.Run.UsagesFromMachine {
		t.Fatalf("after staff fix status=%+v fromMachine=%v", result.Run.ConsumptionStatus, result.Run.UsagesFromMachine)
	}
	if _, _, _, net := h.runUsageState(runID); net != "12.500" {
		t.Fatalf("net consumption after staff fix = %s", net)
	}

	// Without a split, no segment is booked and the run says why.
	unsplit := h.print(rig, rig.segmentReport("", ""))
	if quantities, _ = h.activeUsages(unsplit); len(quantities) != 0 {
		t.Fatalf("unsplit usages = %v", quantities)
	}
	detail, err := h.logbook.GetRun(ctx, h.principal, unsplit)
	if err != nil || detail.ConsumptionStatus == nil || detail.ConsumptionStatus.State != machinelogbook.ConsumptionMissing ||
		detail.ConsumptionStatus.Reason == nil ||
		*detail.ConsumptionStatus.Reason != machinelogbook.ReasonSegmentQuantityUnavailable {
		t.Fatalf("unsplit status = %+v err=%v", detail.ConsumptionStatus, err)
	}
}

// A newer report revision replaces every segment usage exactly once.
func TestIngestReplacesSegmentUsagesByANewerRevision(t *testing.T) {
	h := newIngestHarness(t)
	rig := h.newRefillRig("Revise", "same")
	runID := h.print(rig, rig.segmentReport("6.875000", "5.625000"))
	h.report(runID, rig.start.Add(40*time.Minute), rig.segmentReport("8.000000", "4.500000"), 2)

	quantities, _ := h.activeUsages(runID)
	if len(quantities) != 2 || quantities[rig.first] != "8.000" || quantities[rig.second] != "4.500" {
		t.Fatalf("usages after revision 2 = %v", quantities)
	}
	rows, active, _, net := h.runUsageState(runID)
	if rows != 4 || active != 2 || net != "12.500" {
		t.Fatalf("after revision 2 rows=%d active=%d net=%s", rows, active, net)
	}
	// Later events do not book the applied report again.
	h.accepted(runID, "terminal_outcome", rig.start.Add(41*time.Minute), `{"outcome":"completed"}`)
	if rows2, active2, _, net2 := h.runUsageState(runID); rows2 != rows || active2 != 2 || net2 != "12.500" {
		t.Fatalf("after later events rows=%d active=%d net=%s", rows2, active2, net2)
	}
	run, err := h.logbook.GetRun(t.Context(), h.principal, runID)
	if err != nil || len(run.ReportedUsageItems) != 1 || run.ReportedUsageItems[0].ReportRevision != 2 ||
		len(run.ReportedUsageItems[0].Segments) != 2 ||
		*run.ReportedUsageItems[0].Segments[0].EstimatedQuantityGrams != "8" {
		t.Fatalf("latest reported items = %+v err=%v", run.ReportedUsageItems, err)
	}
	// Mounting the spool that ran out again answers the suggestion.
	if codes := h.spoolAttention(rig.first); !hasAttention(codes, machinelogbook.AttentionRanOutDuringRun) {
		t.Fatalf("ran-out spool attention = %v", codes)
	}
	h.mountExisting(rig.first, "Revise again", time.Now().UTC())
	if codes := h.spoolAttention(rig.first); hasAttention(codes, machinelogbook.AttentionRanOutDuringRun) {
		t.Fatalf("attention after remount = %v", codes)
	}
}

// mountExisting mounts a spool in a new slot of the machine.
func (h *ingestHarness) mountExisting(spoolID uuid.UUID, name string, at time.Time) {
	h.t.Helper()
	ctx := h.t.Context()
	unitID, slotID := ids.New(), ids.New()
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO printer_input_units (id, machine_id, name, position, external_identifier)
		 SELECT $1, $2, $3, COALESCE(max(position) + 1, 0), $4 FROM printer_input_units WHERE machine_id = $2`,
		unitID, h.machine.ID, "Unit "+name, h.unitExternal(name),
	); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO printer_slots (id, input_unit_id, name, position) VALUES ($1, $2, $3, 0)`,
		slotID, unitID, "Slot "+name,
	); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO printer_spool_assignments (id, slot_id, spool_id, mounted_at, source) VALUES ($1, $2, $3, $4, 'manual')`,
		ids.New(), slotID, spoolID, at,
	); err != nil {
		h.t.Fatal(err)
	}
}

// Segments that Core resolves to the same spool (a tagless spool reloaded
// while Core's mount stayed) are one usage, and that spool is not flagged.
func TestIngestMergesSegmentsOnTheSameSpool(t *testing.T) {
	h := newIngestHarness(t)
	rig := h.newRefillRig("Reload", "none")
	runID := h.print(rig, rig.segmentReport("6.875000", "5.625000"))
	quantities, _ := h.activeUsages(runID)
	if len(quantities) != 1 || quantities[rig.first] != "12.500" {
		t.Fatalf("usages = %v", quantities)
	}
	if codes := h.spoolAttention(rig.first); hasAttention(codes, machinelogbook.AttentionRanOutDuringRun) {
		t.Fatalf("attention = %v", codes)
	}
}

// A report without segments resolves and books its line exactly as before.
func TestIngestBooksALineWithoutSegmentsAsBefore(t *testing.T) {
	h := newIngestHarness(t)
	rig := h.newRefillRig("Plain", "same")
	report := fmt.Sprintf(
		`{"items":[{"slicerFilamentId":"1","estimatedQuantityGrams":"12.5","method":"slicer_complete",`+
			`"calculationVersion":"bambu-3mf-v1","quality":"high","inputUnitExternalId":%q,"slotExternalId":%q}]}`,
		rig.unit, rig.slot,
	)
	runID := h.print(rig, report)
	// The line is resolved at the report's time, after the change: on the refill.
	quantities, _ := h.activeUsages(runID)
	if len(quantities) != 1 || quantities[rig.second] != "12.500" {
		t.Fatalf("usages = %v", quantities)
	}
	run, err := h.logbook.GetRun(t.Context(), h.principal, runID)
	if err != nil || run.MaterialChangedDuringRun || len(run.ReportedUsageItems) != 1 ||
		len(run.ReportedUsageItems[0].Segments) != 0 || run.ReportedUsageItems[0].SpoolID == nil ||
		run.ConsumptionStatus.State != machinelogbook.ConsumptionRecorded {
		t.Fatalf("run = %+v err=%v", run.MachineRun, err)
	}
	if codes := h.spoolAttention(rig.first); hasAttention(codes, machinelogbook.AttentionRanOutDuringRun) {
		t.Fatalf("attention without segments = %v", codes)
	}
}
