package printerconnectors

import (
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/google/uuid"
)

// newSlot adds a unit with one slot of the machine; the connector names them by name's external identifiers.
func (h *ingestHarness) newSlot(name string, externalSlot string) uuid.UUID {
	h.t.Helper()
	ctx := h.t.Context()
	unitID, slotID := ids.New(), ids.New()
	var position int
	if err := h.pool.QueryRow(
		ctx,
		`SELECT COALESCE(max(position) + 1, 0) FROM printer_input_units WHERE machine_id = $1`,
		h.machine.ID,
	).Scan(&position); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO printer_input_units (id, machine_id, name, position, external_identifier) VALUES ($1, $2, $3, $4, $5)`,
		unitID, h.machine.ID, "Unit "+name, position, h.unitExternal(name),
	); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO printer_slots (id, input_unit_id, name, position, external_identifier) VALUES ($1, $2, $3, 0, $4)`,
		slotID, unitID, "Slot "+name, externalSlot,
	); err != nil {
		h.t.Fatal(err)
	}
	return slotID
}

// mountCustomerAt mounts customer filament in the slot as of a past time, like the printing service does now.
func (h *ingestHarness) mountCustomerAt(slotID uuid.UUID, at time.Time, typeID *uuid.UUID, colour *string) {
	h.t.Helper()
	if _, err := h.pool.Exec(
		h.t.Context(),
		`INSERT INTO printer_spool_assignments (id, slot_id, kind, customer_material_type_id, customer_color_name, mounted_at, source)
		 VALUES ($1, $2, 'customer', $3, $4, $5, 'manual')`,
		ids.New(), slotID, typeID, colour, at,
	); err != nil {
		h.t.Fatal(err)
	}
}

func (h *ingestHarness) newMaterialType(name string) uuid.UUID {
	h.t.Helper()
	materialType, err := h.logbook.CreateMaterialType(
		h.t.Context(), h.principal, name+" "+h.suffix, "filament", "g", nil, nil,
	)
	if err != nil {
		h.t.Fatal(err)
	}
	return materialType.ID
}

func (h *ingestHarness) typeOfSpool(spoolID uuid.UUID) uuid.UUID {
	h.t.Helper()
	var id uuid.UUID
	if err := h.pool.QueryRow(
		h.t.Context(),
		`SELECT m.material_type_id FROM filament_spools s JOIN materials m ON m.id = s.material_id WHERE s.id = $1`,
		spoolID,
	).Scan(&id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

// pricedJobOfRun attaches the run to a new job whose pricing charges 10 per hour of runtime and 0.1 per gram of
// material of the given type.
func (h *ingestHarness) pricedJobOfRun(runID, typeID uuid.UUID) machinelogbook.MachineJob {
	h.t.Helper()
	ctx := h.t.Context()
	group, err := h.logbook.CreatePricingGroup(ctx, h.principal, "Customer pricing "+h.suffix, nil, false, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err = h.logbook.CreatePricingRule(
		ctx, h.principal, group.ID, "machine_runtime", &h.machine.Process.ID, nil, nil, "10", nil,
	); err != nil {
		h.t.Fatal(err)
	}
	if _, err = h.logbook.CreatePricingRule(
		ctx, h.principal, group.ID, "material", nil, &typeID, nil, "0.1", nil,
	); err != nil {
		h.t.Fatal(err)
	}
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
		h.t.Fatal(err)
	}
	return job
}

func (h *ingestHarness) ledgerNet(runID uuid.UUID) string {
	h.t.Helper()
	var net string
	if err := h.pool.QueryRow(
		h.t.Context(),
		`SELECT COALESCE(-sum(t.quantity_delta), 0)::numeric(20,3)::text FROM inventory_transactions t
		 JOIN machine_run_usages u ON u.id = t.run_usage_id WHERE u.run_id = $1`,
		runID,
	).Scan(&net); err != nil {
		h.t.Fatal(err)
	}
	return net
}

func TestCustomerFilamentIsMountedAndUnmountedLikeASpoolWithoutStock(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	service := printing.NewService(h.pool)
	slotID := h.newSlot("Cust", "slot-cust-"+h.suffix)
	typeID := h.newMaterialType("PLA customer")
	colour := "  Galaxy black "

	slot, err := service.MountCustomerFilament(ctx, h.principal, slotID, &typeID, &colour, nil)
	if err != nil {
		t.Fatal(err)
	}
	if slot.MountKind == nil || *slot.MountKind != printing.MountCustomer || slot.AssignmentID == nil ||
		slot.SpoolID != nil || slot.SpoolDisplayID != nil || slot.CustomerMaterialTypeID == nil ||
		*slot.CustomerMaterialTypeID != typeID || slot.CustomerColorName == nil ||
		*slot.CustomerColorName != "Galaxy black" || slot.CustomerMaterialTypeName == nil {
		t.Fatalf("mounted slot = %+v", slot)
	}
	profile, err := service.GetProfile(ctx, h.principal, h.machine.ID)
	if err != nil {
		t.Fatal(err)
	}
	var listed *printing.Slot
	for i := range profile.Slots {
		if profile.Slots[i].ID == slotID {
			listed = &profile.Slots[i]
		}
	}
	if listed == nil || listed.MountKind == nil || *listed.MountKind != printing.MountCustomer {
		t.Fatalf("profile slot = %+v", listed)
	}

	// One open mount per slot, whatever it holds.
	if _, err = service.MountCustomerFilament(ctx, h.principal, slotID, nil, nil, nil); !apperror.IsCode(err, "slot_occupied") {
		t.Fatalf("second mount: %v", err)
	}
	if _, err = h.pool.Exec(
		ctx,
		`INSERT INTO printer_spool_assignments (id, slot_id, kind, mounted_at, source) VALUES ($1, $2, 'customer', now(), 'manual')`,
		ids.New(), slotID,
	); err == nil {
		t.Fatal("the database accepted a second open mount for one slot")
	}
	// The kind decides what an assignment may hold.
	if _, err = h.pool.Exec(
		ctx,
		`INSERT INTO printer_spool_assignments (id, slot_id, kind, mounted_at, source, customer_color_name) VALUES ($1, $2, 'spool', now(), 'manual', 'x')`,
		ids.New(), h.newSlot("Cust2", "slot-cust2-"+h.suffix),
	); err == nil {
		t.Fatal("the database accepted a spool mount without a spool")
	}

	// Nothing is validated away silently.
	other := h.newSlot("Cust3", "slot-cust3-"+h.suffix)
	unknown := ids.New()
	if _, err = service.MountCustomerFilament(ctx, h.principal, other, &unknown, nil, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("unknown type: %v", err)
	}
	long := strings.Repeat("x", printing.MaxCustomerColorNameLength+1)
	if _, err = service.MountCustomerFilament(ctx, h.principal, other, nil, &long, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("long colour: %v", err)
	}

	// A person without printer_slots.assign can neither mount nor unmount.
	nobody := authorization.Principal{AccountID: h.principal.AccountID, PersonID: h.principal.PersonID}
	if _, err = service.MountCustomerFilament(ctx, nobody, other, nil, nil, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("mount without permission: %v", err)
	}
	if _, err = service.Unmount(ctx, nobody, slotID, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("unmount without permission: %v", err)
	}

	slot, err = service.Unmount(ctx, h.principal, slotID, nil)
	if err != nil || slot.AssignmentID != nil || slot.MountKind != nil || slot.CustomerColorName != nil {
		t.Fatalf("unmounted slot = %+v err=%v", slot, err)
	}
	var open int
	if err = h.pool.QueryRow(
		ctx, `SELECT count(*) FROM printer_spool_assignments WHERE slot_id = $1 AND unmounted_at IS NULL`, slotID,
	).Scan(&open); err != nil || open != 0 {
		t.Fatalf("open mounts = %d err=%v", open, err)
	}
	// Customer filament never touches stock: no ledger row can point at a mount without a spool.
	var colourless printing.Slot
	if colourless, err = service.MountCustomerFilament(ctx, h.principal, slotID, nil, nil, nil); err != nil ||
		colourless.CustomerMaterialTypeID != nil || colourless.CustomerColorName != nil {
		t.Fatalf("mount without description = %+v err=%v", colourless, err)
	}
}

func TestAutoRecordedRunOnCustomerFilamentBooksCustomerMaterialWithoutStock(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	slot := "slot-own-" + h.suffix
	typeID := h.newMaterialType("PLA own")
	colour := "Galaxy black"
	h.mountCustomerAt(h.newSlot("Own", slot), t0.Add(-time.Hour), &typeID, &colour)

	runID := ids.New()
	h.accepted(runID, "progress", t0, `{"state":"printing","percent":10}`)
	job := h.pricedJobOfRun(runID, typeID)
	h.accepted(runID, "terminal_outcome", t0.Add(30*time.Minute), `{"outcome":"completed"}`)
	h.report(
		runID,
		t0.Add(31*time.Minute),
		`{"quantityGrams":"25","quantityBasis":"estimated","inputUnitExternalId":"`+h.unitExternal("Own")+
			`","slotExternalId":"`+slot+`"}`,
		1,
	)

	settled, err := h.logbook.GetJob(ctx, h.principal, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	run := settled.Runs[0]
	if !run.UsagesFromMachine || len(run.Usages) != 1 {
		t.Fatalf("usages = %+v", run.Usages)
	}
	usage := run.Usages[0]
	if usage.Ownership != machinelogbook.OwnershipExternal || usage.SpoolID != nil || usage.MaterialID != nil ||
		usage.Quantity != "25" || usage.Label == nil || *usage.Label != colour || usage.MaterialTypeID == nil ||
		*usage.MaterialTypeID != typeID {
		t.Fatalf("customer usage = %+v", usage)
	}
	if net := h.ledgerNet(runID); net != "0.000" {
		t.Fatalf("customer material moved stock: net %s", net)
	}
	if len(run.ReportedUsageItems) != 1 || run.ReportedUsageItems[0].CustomerAssignmentID == nil {
		t.Fatalf("reported lines = %+v", run.ReportedUsageItems)
	}
	if run.ConsumptionStatus == nil || run.ConsumptionStatus.State != machinelogbook.ConsumptionRecorded {
		t.Fatalf("consumption status = %+v", run.ConsumptionStatus)
	}
	// Runtime only: 30 minutes at 10 per hour; the customer's 25 g are not charged although the type has a rate.
	if settled.EffectivePrice == nil || !strings.HasPrefix(*settled.EffectivePrice, "5") ||
		settled.PricingStatus != "complete" {
		t.Fatalf("price = %v status %s", settled.EffectivePrice, settled.PricingStatus)
	}

	// A newer report replaces the customer usage without leaving a second one behind.
	h.report(
		runID,
		t0.Add(32*time.Minute),
		`{"quantityGrams":"20","quantityBasis":"estimated","inputUnitExternalId":"`+h.unitExternal("Own")+
			`","slotExternalId":"`+slot+`"}`,
		2,
	)
	rows, active, ledger, net := h.runUsageState(runID)
	if rows != 2 || active != 1 || ledger != 0 || net != "0.000" {
		t.Fatalf("after revision 2 rows=%d active=%d ledger=%d net=%s", rows, active, ledger, net)
	}
}

// A line fed by a spool first and by customer filament after a refill books the spool on stock and the rest as
// customer material.
func TestAutoRecordedSegmentsMixSpoolAndCustomerFilament(t *testing.T) {
	h := newIngestHarness(t)
	rig := h.newRefillRig("Mixed", "gone")
	var slotID uuid.UUID
	if err := h.pool.QueryRow(
		t.Context(), `SELECT slot_id FROM printer_spool_assignments WHERE spool_id = $1`, rig.first,
	).Scan(&slotID); err != nil {
		t.Fatal(err)
	}
	colour := "Red"
	h.mountCustomerAt(slotID, rig.change, nil, &colour)
	runID := h.print(rig, rig.segmentReport("6.875000", "5.625000"))

	run, err := h.logbook.GetRun(t.Context(), h.principal, runID)
	if err != nil {
		t.Fatal(err)
	}
	var spoolQuantity, customerQuantity string
	for _, usage := range run.Usages {
		switch usage.Ownership {
		case machinelogbook.OwnershipExternal:
			customerQuantity = usage.Quantity
		default:
			spoolQuantity = usage.Quantity
		}
	}
	if len(run.Usages) != 2 || spoolQuantity != "6.875" || customerQuantity != "5.625" {
		t.Fatalf("usages = %+v", run.Usages)
	}
	segments := run.ReportedUsageItems[0].Segments
	if len(segments) != 2 || segments[0].CustomerAssignmentID != nil || segments[1].CustomerAssignmentID == nil ||
		segments[1].SpoolID != nil {
		t.Fatalf("segments = %+v", segments)
	}
	if net := h.ledgerNet(runID); net != "6.875" {
		t.Fatalf("stock net = %s, want only the spool's share", net)
	}
	if run.ConsumptionStatus == nil || run.ConsumptionStatus.State != machinelogbook.ConsumptionRecorded {
		t.Fatalf("consumption status = %+v", run.ConsumptionStatus)
	}
}

func TestCustomerFilamentMountIsNotReplacedByTheConnector(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	slot := "slot-keep-" + h.suffix
	slotID := h.newSlot("Keep", slot)
	h.mountCustomerAt(slotID, t0, nil, nil)
	spoolID := h.newSpool("Keep", nil, t0)
	if _, err := h.pool.Exec(
		ctx,
		`INSERT INTO filament_spool_identifiers (id, spool_id, kind, value) VALUES ($1, $2, 'nfc', $3)`,
		ids.New(), spoolID, "AB"+strings.ToUpper(h.suffix),
	); err != nil {
		t.Fatal(err)
	}
	h.sequence++
	receipt := h.sendEvent(EventInput{
		EventID:              ids.New(),
		AssignmentID:         h.assignment.ID,
		HistoryComplete:      true,
		ConfigurationVersion: h.assignment.ConfigurationVersion,
		Sequence:             h.sequence,
		OccurredAt:           time.Now().UTC(),
		Kind:                 printing.EventSlotObservation,
		Payload: []byte(`{"inputUnitExternalId":"` + h.unitExternal("Keep") + `","slotExternalId":"` + slot +
			`","tagUid":"AB` + strings.ToUpper(h.suffix) + `"}`),
	})
	if receipt.Status != "accepted" {
		t.Fatalf("receipt = %+v", receipt)
	}
	var kind string
	if err := h.pool.QueryRow(
		ctx, `SELECT kind FROM printer_spool_assignments WHERE slot_id = $1 AND unmounted_at IS NULL`, slotID,
	).Scan(&kind); err != nil || kind != "customer" {
		t.Fatalf("open mount kind = %q err=%v", kind, err)
	}
}

// An auto-booked makerspace usage can be switched to customer material afterwards: the stock comes back and the
// job is priced again without the material.
func TestSwitchingAnAutoBookedUsageToCustomerMaterialRestoresStockAndReprices(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-2 * time.Hour)
	slot := "slot-sw-" + h.suffix
	spoolID := h.mountSpool("Sw", &slot, t0.Add(-time.Hour))
	typeID := h.typeOfSpool(spoolID)

	runID := ids.New()
	h.accepted(runID, "progress", t0, `{"state":"printing","percent":10}`)
	job := h.pricedJobOfRun(runID, typeID)
	h.accepted(runID, "terminal_outcome", t0.Add(30*time.Minute), `{"outcome":"completed"}`)
	h.report(
		runID,
		t0.Add(31*time.Minute),
		`{"quantityGrams":"25","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal("Sw")+
			`","slotExternalId":"`+slot+`"}`,
		1,
	)
	booked, err := h.logbook.GetJob(ctx, h.principal, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if h.ledgerNet(runID) != "25.000" || booked.EffectivePrice == nil || !strings.HasPrefix(*booked.EffectivePrice, "7.5") {
		t.Fatalf("before: ledger %s price %v", h.ledgerNet(runID), booked.EffectivePrice)
	}
	usage := booked.Runs[0].Usages[0]
	version := booked.Runs[0].Version

	nobody := authorization.Principal{AccountID: h.principal.AccountID, PersonID: h.principal.PersonID}
	if _, err = h.logbook.SwitchRunUsageToCustomerMaterial(
		ctx, nobody, runID, usage.ID, version, machinelogbook.CustomerMaterialInput{}, nil,
	); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("switch without permission: %v", err)
	}
	if h.ledgerNet(runID) != "25.000" {
		t.Fatal("a refused switch changed the stock")
	}

	result, err := h.logbook.SwitchRunUsageToCustomerMaterial(
		ctx, h.principal, runID, usage.ID, version, machinelogbook.CustomerMaterialInput{}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if h.ledgerNet(runID) != "0.000" {
		t.Fatalf("stock not restored: net %s", h.ledgerNet(runID))
	}
	if len(result.Run.Usages) != 1 || result.Run.Usages[0].Ownership != machinelogbook.OwnershipExternal ||
		result.Run.Usages[0].Quantity != "25" || result.Run.Usages[0].MaterialTypeID == nil ||
		*result.Run.Usages[0].MaterialTypeID != typeID || !result.Run.Usages[0].StaffCorrected {
		t.Fatalf("usages after switch = %+v", result.Run.Usages)
	}
	if result.Job == nil || result.Job.EffectivePrice == nil || !strings.HasPrefix(*result.Job.EffectivePrice, "5") ||
		strings.HasPrefix(*result.Job.EffectivePrice, "7.5") {
		t.Fatalf("job not repriced: %+v", result.Job)
	}
	// Again, and with a stale version, is refused; later machine reports do not undo the switch.
	if _, err = h.logbook.SwitchRunUsageToCustomerMaterial(
		ctx, h.principal, runID, result.Run.Usages[0].ID, result.Run.Version, machinelogbook.CustomerMaterialInput{}, nil,
	); !apperror.IsCode(err, "usage_already_customer_material") {
		t.Fatalf("switch of customer material: %v", err)
	}
	if _, err = h.logbook.SwitchRunUsageToCustomerMaterial(
		ctx, h.principal, runID, usage.ID, version, machinelogbook.CustomerMaterialInput{}, nil,
	); err == nil {
		t.Fatal("a stale version was accepted")
	}
	h.report(
		runID,
		t0.Add(40*time.Minute),
		`{"quantityGrams":"40","quantityBasis":"actual","inputUnitExternalId":"`+h.unitExternal("Sw")+
			`","slotExternalId":"`+slot+`"}`,
		2,
	)
	if h.ledgerNet(runID) != "0.000" {
		t.Fatalf("a newer machine report booked stock again: net %s", h.ledgerNet(runID))
	}
}
