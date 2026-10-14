package printing

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPrinterOperationsRequireTheirPermissions(t *testing.T) {
	s := NewService(nil)
	ctx := t.Context()
	p := authorization.Principal{}
	id := uuid.Must(uuid.NewV7())

	tests := []struct {
		name string
		call func() error
	}{
		{"machines.read printer profile", func() error { _, err := s.GetProfile(ctx, p, id); return err }},
		{"machines.manage printer profile", func() error { _, err := s.ConfigureProfile(ctx, p, id, true, 0, nil); return err }},
		{"machines.manage input unit", func() error { _, err := s.CreateInputUnit(ctx, p, id, "Direct", 0, nil, nil); return err }},
		{"machines.manage update input unit", func() error { _, err := s.UpdateInputUnit(ctx, p, id, "Direct", 0, nil, true, 1, nil); return err }},
		{"machines.manage slot", func() error { _, err := s.CreateSlot(ctx, p, id, "Slot", 0, "available", nil, nil); return err }},
		{"machines.manage update slot", func() error { _, err := s.UpdateSlot(ctx, p, id, "Slot", 0, "available", nil, 1, nil); return err }},
		{"printer_slots.assign mount", func() error { _, err := s.Mount(ctx, p, id, id, nil); return err }},
		{"printer_slots.assign unmount", func() error { _, err := s.Unmount(ctx, p, id, nil); return err }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.call(); !apperror.IsCode(err, "permission_denied") {
				t.Fatalf("expected permission_denied, got %v", err)
			}
		})
	}
}

func printingIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if err = pool.Ping(t.Context()); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestPrintingPostgresVerticalSlice(t *testing.T) {
	pool := printingIntegrationPool(t)
	ctx := t.Context()
	jobs := machinelogbook.NewService(pool)
	service := NewService(pool)
	personID := uuid.Must(uuid.NewV7())
	accountID := uuid.Must(uuid.NewV7())
	requestID := uuid.Must(uuid.NewV7())
	suffix := strings.ReplaceAll(personID.String(), "-", "")[:12]
	p := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}

	if _, err := pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Print', 'Operator', $2)`, personID, "printing-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}
	machineType, err := jobs.CreateMachineType(ctx, p, "Printer "+suffix, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := jobs.CreateMachine(ctx, p, machineType.ID, "Generic printer "+suffix, "active", nil, false, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	diameter := "1.75"
	material, err := jobs.CreateMaterialWithFilament(ctx, p, "Test filament "+suffix, "pla", nil, "g", nil, &diameter, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	purchased, err := jobs.AddPurchase(ctx, p, material.ID, material.InventoryVersion, "1000", "20", time.Now().UTC(), nil, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	spool, err := jobs.CreateFilamentSpool(ctx, p, machinelogbook.FilamentSpoolInput{MaterialID: material.ID, InitialNetWeightG: "500", StockMode: "existing_stock", OccurredAt: time.Now().UTC(), ExpectedInventoryVersion: purchased.Material.InventoryVersion}, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	allocatedMaterial, err := jobs.GetMaterial(ctx, p, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	consumed, err := jobs.ConsumeFilamentSpool(ctx, p, spool.ID, allocatedMaterial.InventoryVersion, spool.Version, "10", time.Now().UTC(), false, nil, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if consumed.Material.Quantity != "990" || consumed.Material.AssignedQuantity != "490" {
		t.Fatalf("spool consumption did not preserve derived balances: %+v", consumed.Material)
	}
	if _, err = jobs.ConsumeFilamentSpool(ctx, p, spool.ID, allocatedMaterial.InventoryVersion, spool.Version, "1", time.Now().UTC(), false, nil, nil, &requestID); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("expected stale spool consumption, got %v", err)
	}
	spool, err = jobs.GetFilamentSpool(ctx, p, spool.ID)
	if err != nil || spool.RemainingQuantity != "490" {
		t.Fatalf("spool remaining=%s err=%v", spool.RemainingQuantity, err)
	}

	profile, err := service.ConfigureProfile(ctx, p, machine.ID, true, 0, &requestID)
	if err != nil || !profile.Enabled {
		t.Fatalf("configure profile: profile=%+v err=%v", profile, err)
	}
	unit, err := service.CreateInputUnit(ctx, p, machine.ID, "Direct feed", 0, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	slot, err := service.CreateSlot(ctx, p, unit.ID, "Slot 1", 0, "available", nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	unitExternalID := "0"
	unit, err = service.UpdateInputUnit(ctx, p, unit.ID, "AMS 2 Pro", unit.Position, &unitExternalID, true, unit.Version, &requestID)
	if err != nil || unit.ExternalIdentifier == nil || *unit.ExternalIdentifier != "0" || unit.Name != "AMS 2 Pro" {
		t.Fatalf("update input unit: unit=%+v err=%v", unit, err)
	}
	if _, err = service.UpdateInputUnit(ctx, p, unit.ID, unit.Name, unit.Position, &unitExternalID, true, unit.Version-1, &requestID); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("expected stale input-unit update, got %v", err)
	}
	slotExternalID := "0"
	slot, err = service.UpdateSlot(ctx, p, slot.ID, "Slot 1", slot.Position, slot.Status, &slotExternalID, slot.Version, &requestID)
	if err != nil || slot.ExternalIdentifier == nil || *slot.ExternalIdentifier != "0" {
		t.Fatalf("update slot: slot=%+v err=%v", slot, err)
	}
	mounted, err := service.Mount(ctx, p, slot.ID, spool.ID, &requestID)
	if err != nil || mounted.SpoolID == nil || *mounted.SpoolID != spool.ID {
		t.Fatalf("mount result=%+v err=%v", mounted, err)
	}
	if _, err = service.Mount(ctx, p, slot.ID, spool.ID, &requestID); !apperror.IsCode(err, "slot_occupied") {
		t.Fatalf("expected occupied slot conflict, got %v", err)
	}

	// A spool without an open fill (or an archived one) cannot be mounted.
	emptyAllocation, err := jobs.GetMaterial(ctx, p, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	finishedSpool, err := jobs.CreateFilamentSpool(ctx, p, machinelogbook.FilamentSpoolInput{MaterialID: material.ID, InitialNetWeightG: "100", StockMode: "existing_stock", OccurredAt: time.Now().UTC(), ExpectedInventoryVersion: emptyAllocation.InventoryVersion}, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if finishedSpool, err = jobs.FinishFilamentSpool(ctx, p, finishedSpool.ID, machinelogbook.FinishSpoolInput{Leftover: machinelogbook.LeftoverInput{Basis: "none"}, OccurredAt: time.Now().UTC(), ExpectedVersion: finishedSpool.Version}, &requestID); err != nil {
		t.Fatal(err)
	}
	spareSlot, err := service.CreateSlot(ctx, p, unit.ID, "Slot 2", 1, "available", nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Mount(ctx, p, spareSlot.ID, finishedSpool.ID, &requestID); !apperror.IsCode(err, "spool_unavailable") {
		t.Fatalf("expected a finished spool to be refused, got %v", err)
	}

	if _, err = service.Unmount(ctx, p, slot.ID, &requestID); err != nil {
		t.Fatal(err)
	}
}
