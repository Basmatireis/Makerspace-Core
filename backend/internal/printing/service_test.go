package printing

import (
	"encoding/json"
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

func TestPrintingOperationsRequireTheirPermissions(t *testing.T) {
	s := NewService(nil, machinelogbook.NewService(nil))
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
		{"machines.manage slot", func() error { _, err := s.CreateSlot(ctx, p, id, "Slot", 0, "available", nil, nil); return err }},
		{"printer_slots.assign mount", func() error { _, err := s.Mount(ctx, p, id, id, nil); return err }},
		{"printer_slots.assign unmount", func() error { _, err := s.Unmount(ctx, p, id, nil); return err }},
		{"print_submissions.read get", func() error { _, err := s.GetSubmission(ctx, p, id); return err }},
		{"print_submissions.read list", func() error { _, _, err := s.ListSubmissions(ctx, p, "", "", nil, 1, 25); return err }},
		{"print_submissions.manage create", func() error { _, err := s.CreateSubmission(ctx, p, SubmissionInput{}, nil); return err }},
		{"print_submissions.manage attempt", func() error { _, _, err := s.CreateAttempt(ctx, p, id, id, id, 1, nil); return err }},
		{"print_submissions.manage transition", func() error { _, err := s.TransitionAttempt(ctx, p, id, "accepted", 1, nil); return err }},
		{"print_submissions.manage reconciliation", func() error { return s.ReconcileEvent(ctx, p, id, "rejected", id, nil, nil, nil, nil) }},
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
	service := NewService(pool, jobs)
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
	mounted, err := service.Mount(ctx, p, slot.ID, spool.ID, &requestID)
	if err != nil || mounted.SpoolID == nil || *mounted.SpoolID != spool.ID {
		t.Fatalf("mount result=%+v err=%v", mounted, err)
	}
	if _, err = service.Mount(ctx, p, slot.ID, spool.ID, &requestID); !apperror.IsCode(err, "slot_occupied") {
		t.Fatalf("expected occupied slot conflict, got %v", err)
	}

	estimate := "120"
	submission, err := service.CreateSubmission(ctx, p, SubmissionInput{MachineID: machine.ID, Customer: machinelogbook.PartyReference{Kind: "person", ID: personID}, Title: "Bracket " + suffix, Declarations: []DeclarationInput{{Ownership: "makerspace", MaterialID: &material.ID, SpoolID: &spool.ID, EstimatedQuantityG: &estimate}}}, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	operationKey := uuid.Must(uuid.NewV7())
	attempt, created, err := service.CreateAttempt(ctx, p, submission.ID, machine.ID, operationKey, submission.Version, &requestID)
	if err != nil || !created {
		t.Fatalf("create attempt created=%v err=%v", created, err)
	}
	repeated, created, err := service.CreateAttempt(ctx, p, submission.ID, machine.ID, operationKey, submission.Version, &requestID)
	if err != nil || created || repeated.ID != attempt.ID {
		t.Fatalf("repeat attempt created=%v repeated=%+v err=%v", created, repeated, err)
	}
	if _, err = service.TransitionAttempt(ctx, p, attempt.ID, "completed", attempt.Version, &requestID); !apperror.IsCode(err, "invalid_attempt_transition") {
		t.Fatalf("expected invalid transition, got %v", err)
	}

	eventInput := EventInput{SourceID: " connector-" + suffix + " ", EventKey: " consumption-1 ", ProtocolVersion: 1, MachineID: &machine.ID, AttemptID: &attempt.ID, Kind: "consumption_report", OccurredAt: time.Now().UTC(), Payload: json.RawMessage(`{"quantity":"118"}`)}
	event, inserted, err := service.IngestEvent(ctx, eventInput)
	if err != nil || !inserted || event.ReconciliationState != "pending" {
		t.Fatalf("ingest event inserted=%v event=%+v err=%v", inserted, event, err)
	}
	repeatedEvent, inserted, err := service.IngestEvent(ctx, eventInput)
	if err != nil || inserted || repeatedEvent.ID != event.ID {
		t.Fatalf("repeat event inserted=%v event=%+v err=%v", inserted, repeatedEvent, err)
	}
	conflictingEvent := eventInput
	conflictingEvent.Payload = json.RawMessage(`{"quantity":"119"}`)
	if _, _, err = service.IngestEvent(ctx, conflictingEvent); !apperror.IsCode(err, "printer_event_mismatch") {
		t.Fatalf("expected event mismatch, got %v", err)
	}
	reconcileKey := uuid.Must(uuid.NewV7())
	if err = service.ReconcileEvent(ctx, p, event.ID, "rejected", reconcileKey, nil, nil, nil, &requestID); err != nil {
		t.Fatal(err)
	}
	if err = service.ReconcileEvent(ctx, p, event.ID, "rejected", reconcileKey, nil, nil, nil, &requestID); err != nil {
		t.Fatalf("idempotent reconciliation failed: %v", err)
	}
	if _, err = service.Unmount(ctx, p, slot.ID, &requestID); err != nil {
		t.Fatal(err)
	}
}
