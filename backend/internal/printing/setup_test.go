package printing

import (
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/google/uuid"
)

type setupFixture struct {
	t         *testing.T
	service   *Service
	jobs      *machinelogbook.Service
	principal authorization.Principal
	machineID uuid.UUID
	suffix    string
	request   uuid.UUID
}

func newSetupFixture(t *testing.T) *setupFixture {
	t.Helper()
	pool := printingIntegrationPool(t)
	ctx := t.Context()
	f := &setupFixture{
		t:       t,
		service: NewService(pool),
		jobs:    machinelogbook.NewService(pool, inbox.NewEmitter()),
		request: ids.New(),
	}
	personID, accountID := ids.New(), ids.New()
	f.suffix = strings.ReplaceAll(personID.String(), "-", "")[:12]
	f.principal = authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Setup', 'Operator', $2)`,
		personID,
		"setup-"+f.suffix+"@example.test",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`,
		accountID,
		personID,
	); err != nil {
		t.Fatal(err)
	}
	machineType, err := f.jobs.CreateMachineType(
		ctx,
		f.principal,
		"Setup printer "+f.suffix,
		"fdm_printing",
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := f.jobs.CreateMachine(
		ctx,
		f.principal,
		machineType.ID,
		"Setup machine "+f.suffix,
		"active",
		nil,
		false,
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	f.machineID = machine.ID
	return f
}

func str(v string) *string { return &v }

func (f *setupFixture) save(expected int64, input SetupInput) (Profile, error) {
	f.t.Helper()
	input.ExpectedVersion = expected
	return f.service.SaveSetup(f.t.Context(), f.principal, f.machineID, input, &f.request)
}

func (f *setupFixture) mustSave(expected int64, input SetupInput) Profile {
	f.t.Helper()
	profile, err := f.save(expected, input)
	if err != nil {
		f.t.Fatalf("save setup: %v", err)
	}
	return profile
}

func activeUnits(p Profile) []InputUnit {
	var result []InputUnit
	for _, u := range p.InputUnits {
		if u.Enabled {
			result = append(result, u)
		}
	}
	return result
}

func slotsOf(p Profile, unitID uuid.UUID, status ...string) []Slot {
	var result []Slot
	for _, s := range p.Slots {
		if s.InputUnitID != unitID {
			continue
		}
		if len(status) == 0 || string(s.Status) == status[0] || (status[0] == "active" && s.Status != SlotRetired) {
			result = append(result, s)
		}
	}
	return result
}

func h2dSetup() SetupInput {
	return SetupInput{Enabled: true, Model: optional.Of(PrinterModel("bambu_h2d")), InputUnits: []SetupUnitInput{
		{Name: "AMS 2 Pro", Nozzle: optional.Of(Nozzle("left")), ExternalIdentifier: str("0"), Slots: []SetupSlotInput{
			{Name: "Slot 1", Status: "available", ExternalIdentifier: str("0")},
			{Name: "Slot 2", Status: "available", ExternalIdentifier: str("1")},
		}},
		{Name: "AMS HT", Nozzle: optional.Of(Nozzle("right")), ExternalIdentifier: str("128"), Slots: []SetupSlotInput{
			{Name: "Slot 1", Status: "available", ExternalIdentifier: str("0")},
		}},
	}}
}

func TestSaveSetupRequiresMachinesManage(t *testing.T) {
	service := NewService(nil)
	_, err := service.SaveSetup(t.Context(), authorization.Principal{}, ids.New(), SetupInput{}, nil)
	if !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("expected permission_denied, got %v", err)
	}
}

func TestSaveSetupValidatesBeforeTouchingTheDatabase(t *testing.T) {
	service := NewService(nil)
	master := authorization.Principal{Master: true}
	id := ids.New()
	dupUnits := h2dSetup()
	dupUnits.InputUnits[1].ExternalIdentifier = str("0")
	dupSlots := h2dSetup()
	dupSlots.InputUnits[0].Slots[1].ExternalIdentifier = str("0")
	badModel := h2dSetup()
	badModel.Model = optional.Of(PrinterModel("toaster"))
	badNozzle := h2dSetup()
	badNozzle.InputUnits[0].Nozzle = optional.Of(Nozzle("middle"))
	badStatus := h2dSetup()
	badStatus.InputUnits[0].Slots[0].Status = "retired"
	dupID := h2dSetup()
	dupID.InputUnits[0].ID, dupID.InputUnits[1].ID = &id, &id
	tests := []struct {
		name  string
		input SetupInput
		code  string
	}{
		{"duplicate unit identifier", dupUnits, "duplicate_external_identifier"},
		{"duplicate slot identifier", dupSlots, "duplicate_external_identifier"},
		{"unknown model", badModel, "validation_failed"},
		{"unknown nozzle", badNozzle, "validation_failed"},
		{"retired is not requestable", badStatus, "validation_failed"},
		{"duplicate unit ids", dupID, "validation_failed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := service.SaveSetup(t.Context(), master, id, test.input, nil); !apperror.IsCode(err, test.code) {
				t.Fatalf("expected %s, got %v", test.code, err)
			}
		})
	}
}

func TestSaveSetupCreatesAndEditsTheProfile(t *testing.T) {
	f := newSetupFixture(t)
	ctx := t.Context()
	pool := printingIntegrationPool(t)

	created := f.mustSave(0, h2dSetup())
	if created.Version != 1 || !created.Enabled || created.Model == nil || *created.Model != "bambu_h2d" {
		t.Fatalf("created profile = %+v", created)
	}
	units := activeUnits(created)
	if len(units) != 2 || units[0].Name != "AMS 2 Pro" || units[0].Position != 0 || units[1].Position != 1 ||
		units[0].Nozzle == nil || *units[0].Nozzle != "left" || units[1].Nozzle == nil || *units[1].Nozzle != "right" {
		t.Fatalf("created units = %+v", created.InputUnits)
	}
	if len(created.Slots) != 3 {
		t.Fatalf("created slots = %+v", created.Slots)
	}
	var audits int
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE action = 'printer_profile.setup_saved' AND resource_id = $1 AND actor_account_id = $2`,
		f.machineID,
		f.principal.AccountID,
	).Scan(&audits); err != nil ||
		audits != 1 {
		t.Fatalf("audit rows = %d err=%v", audits, err)
	}

	// Rename, reorder the units and swap the slot identifiers within a unit.
	first, second := units[0], units[1]
	firstSlots := slotsOf(created, first.ID)
	secondSlots := slotsOf(created, second.ID)
	edit := SetupInput{Enabled: true, Model: optional.Of(PrinterModel("bambu_h2d")), InputUnits: []SetupUnitInput{
		{
			ID:                 &second.ID,
			Name:               "AMS HT renamed",
			Nozzle:             optional.Of(Nozzle("right")),
			ExternalIdentifier: str("128"),
			Slots: []SetupSlotInput{
				{ID: &secondSlots[0].ID, Name: "Slot 1", Status: "available", ExternalIdentifier: str("0")},
			},
		},
		{
			ID:                 &first.ID,
			Name:               "AMS 2 Pro",
			Nozzle:             optional.Of(Nozzle("left")),
			ExternalIdentifier: str("0"),
			Slots: []SetupSlotInput{
				{ID: &firstSlots[1].ID, Name: "Slot 2 first", Status: "unavailable", ExternalIdentifier: str("0")},
				{ID: &firstSlots[0].ID, Name: "Slot 1 second", Status: "available", ExternalIdentifier: str("1")},
			},
		},
	}}
	edited := f.mustSave(created.Version, edit)
	if edited.Version != 2 {
		t.Fatalf("profile version = %d", edited.Version)
	}
	units = activeUnits(edited)
	if len(units) != 2 || units[0].ID != second.ID || units[0].Name != "AMS HT renamed" || units[0].Position != 0 ||
		units[1].ID != first.ID ||
		units[1].Position != 1 {
		t.Fatalf("reordered units = %+v", units)
	}
	if units[1].Version != first.Version+1 && units[1].Version != first.Version {
		t.Fatalf("unexpected unit version %d", units[1].Version)
	}
	slots := slotsOf(edited, first.ID)
	if len(slots) != 2 || slots[0].ID != firstSlots[1].ID || slots[0].Position != 0 ||
		slots[0].Status != "unavailable" ||
		slots[0].ExternalIdentifier == nil ||
		*slots[0].ExternalIdentifier != "0" ||
		slots[1].ID != firstSlots[0].ID ||
		*slots[1].ExternalIdentifier != "1" {
		t.Fatalf("reordered slots = %+v", slots)
	}
	untouched := slotsOf(edited, second.ID)[0]
	if untouched.Version != secondSlots[0].Version {
		t.Fatalf("an unchanged slot must keep its version: %d -> %d", secondSlots[0].Version, untouched.Version)
	}
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE action = 'printer_profile.setup_saved' AND resource_id = $1`,
		f.machineID,
	).Scan(&audits); err != nil ||
		audits != 2 {
		t.Fatalf("audit rows after edit = %d err=%v", audits, err)
	}

	// Removing a slot retires it; removing a unit disables it and retires its slots.
	removeOne := SetupInput{Enabled: true, Model: optional.Of(PrinterModel("bambu_h2d")), InputUnits: []SetupUnitInput{
		{
			ID:                 &first.ID,
			Name:               "AMS 2 Pro",
			Nozzle:             optional.Of(Nozzle("left")),
			ExternalIdentifier: str("0"),
			Slots: []SetupSlotInput{
				{ID: &firstSlots[0].ID, Name: "Slot 1 second", Status: "available", ExternalIdentifier: str("1")},
			},
		},
	}}
	pruned := f.mustSave(edited.Version, removeOne)
	prunedUnits := activeUnits(pruned)
	if len(prunedUnits) != 1 || prunedUnits[0].ID != first.ID || prunedUnits[0].Position != 0 {
		t.Fatalf("active units after removal = %+v", pruned.InputUnits)
	}
	for _, u := range pruned.InputUnits {
		if u.ID == second.ID && (u.Enabled || u.ExternalIdentifier != nil || u.Position < 1) {
			t.Fatalf("removed unit must be disabled, unidentified, and behind: %+v", u)
		}
	}
	retired := slotsOf(pruned, first.ID, "retired")
	if len(retired) != 1 || retired[0].ID != firstSlots[1].ID || retired[0].ExternalIdentifier != nil ||
		retired[0].Position != 1 {
		t.Fatalf("retired slots = %+v", retired)
	}
	for _, s := range slotsOf(pruned, second.ID) {
		if s.Status != "retired" || s.ExternalIdentifier != nil {
			t.Fatalf("slot of a removed unit must be retired: %+v", s)
		}
	}

	// A retired identifier can be reused by a new slot, and a removed unit can be added back by ID.
	again := SetupInput{Enabled: false, Model: optional.Of(PrinterModel("generic")), InputUnits: []SetupUnitInput{
		{ID: &first.ID, Name: "AMS 2 Pro", Nozzle: nil, ExternalIdentifier: str("0"), Slots: []SetupSlotInput{
			{ID: &firstSlots[0].ID, Name: "Slot 1 second", Status: "available", ExternalIdentifier: str("1")},
			{Name: "New slot", Status: "available", ExternalIdentifier: str("0")},
		}},
		{
			ID:                 &second.ID,
			Name:               "AMS HT",
			Nozzle:             optional.Of(Nozzle("right")),
			ExternalIdentifier: str("128"),
			Slots: []SetupSlotInput{
				{ID: &secondSlots[0].ID, Name: "Slot 1", Status: "available", ExternalIdentifier: str("0")},
			},
		},
	}}
	final := f.mustSave(pruned.Version, again)
	if final.Enabled || final.Model == nil || *final.Model != "generic" || len(activeUnits(final)) != 2 {
		t.Fatalf("final profile = %+v", final)
	}
	if got := slotsOf(final, first.ID, "active"); len(got) != 2 || got[1].Name != "New slot" ||
		got[1].ID == firstSlots[1].ID {
		t.Fatalf("slots after re-adding = %+v", got)
	}
	if got := slotsOf(final, first.ID, "retired"); len(got) != 1 || got[0].ID != firstSlots[1].ID ||
		got[0].Position != 2 {
		t.Fatalf("retired slot must move behind the active ones: %+v", got)
	}
}

func TestSaveSetupRejectsStaleAndUnknownReferences(t *testing.T) {
	f := newSetupFixture(t)

	if _, err := f.save(3, h2dSetup()); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("creating with an expected version must be stale, got %v", err)
	}
	created := f.mustSave(0, h2dSetup())
	if _, err := f.save(0, h2dSetup()); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("saving without the version of an existing profile must be stale, got %v", err)
	}
	if _, err := f.save(created.Version+4, h2dSetup()); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("expected stale_write, got %v", err)
	}
	unknown := ids.New()
	input := h2dSetup()
	input.InputUnits[0].ID = &unknown
	if _, err := f.save(created.Version, input); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("unknown unit id: %v", err)
	}
	units := activeUnits(created)
	input = h2dSetup()
	input.InputUnits[0].ID = &units[0].ID
	otherUnitsSlot := slotsOf(created, units[1].ID)[0].ID
	input.InputUnits[0].Slots[0].ID = &otherUnitsSlot
	if _, err := f.save(created.Version, input); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("a slot cannot move to another unit: %v", err)
	}
	if _, err := f.service.SaveSetup(
		t.Context(),
		f.principal,
		ids.New(),
		h2dSetup(),
		nil,
	); !apperror.IsCode(
		err,
		"not_found",
	) {
		t.Fatalf("unknown machine: %v", err)
	}
	unchanged, err := f.service.GetProfile(t.Context(), f.principal, f.machineID)
	if err != nil || unchanged.Version != created.Version {
		t.Fatalf("a rejected save must not change the profile: %+v err=%v", unchanged, err)
	}
}

func TestSaveSetupRefusesToRemoveAMountedSlotAndRollsBack(t *testing.T) {
	f := newSetupFixture(t)
	ctx := t.Context()
	created := f.mustSave(0, h2dSetup())
	units := activeUnits(created)
	mountedSlot := slotsOf(created, units[0].ID)[0]

	diameter, total := "1.75", "20"
	materialType, err := f.jobs.CreateMaterialType(
		ctx,
		f.principal,
		"PLA "+f.suffix,
		"filament",
		"g",
		[]string{"fdm_printing"},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	material, err := f.jobs.CreateMaterial(
		ctx,
		f.principal,
		machinelogbook.MaterialInput{
			Name:               "Setup filament " + f.suffix,
			MaterialTypeID:     materialType.ID,
			FilamentDiameterMM: &diameter,
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	spool, err := f.jobs.CreateFilamentSpool(
		ctx,
		f.principal,
		machinelogbook.FilamentSpoolInput{
			MaterialID:               material.ID,
			InitialNetWeightG:        "1000",
			StockMode:                "new_acquisition",
			TotalPrice:               &total,
			OccurredAt:               time.Now().UTC(),
			ExpectedInventoryVersion: material.InventoryVersion,
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Mount(ctx, f.principal, mountedSlot.ID, spool.ID, &f.request); err != nil {
		t.Fatal(err)
	}

	// Dropping the mounted slot, and dropping the whole unit that contains it.
	dropSlot := h2dSetup()
	dropSlot.InputUnits[0].ID = &units[0].ID
	dropSlot.InputUnits[0].Name = "Renamed in a failing save"
	dropSlot.InputUnits[0].Slots = dropSlot.InputUnits[0].Slots[1:]
	keptSlotID, otherUnitSlotID := slotsOf(created, units[0].ID)[1].ID, slotsOf(created, units[1].ID)[0].ID
	dropSlot.InputUnits[0].Slots[0].ID = &keptSlotID
	dropSlot.InputUnits[1].ID = &units[1].ID
	dropSlot.InputUnits[1].Slots[0].ID = &otherUnitSlotID
	if _, err = f.save(created.Version, dropSlot); !apperror.IsCode(err, "slot_occupied") {
		t.Fatalf("expected slot_occupied, got %v", err)
	}
	dropUnit := SetupInput{
		Enabled:    true,
		Model:      optional.Of(PrinterModel("bambu_h2d")),
		InputUnits: []SetupUnitInput{h2dSetup().InputUnits[1]},
	}
	dropUnit.InputUnits[0].ID = &units[1].ID
	if _, err = f.save(created.Version, dropUnit); !apperror.IsCode(err, "slot_occupied") {
		t.Fatalf("expected slot_occupied for a removed unit, got %v", err)
	}
	after, err := f.service.GetProfile(ctx, f.principal, f.machineID)
	if err != nil || after.Version != created.Version || activeUnits(after)[0].Name != "AMS 2 Pro" {
		t.Fatalf("the failed save must leave everything untouched: %+v err=%v", after, err)
	}

	// Unmounting first makes the same removal succeed.
	if _, err = f.service.Unmount(ctx, f.principal, mountedSlot.ID, &f.request); err != nil {
		t.Fatal(err)
	}
	dropSlot.InputUnits[0].ID = &units[0].ID
	saved := f.mustSave(created.Version, dropSlot)
	if retired := slotsOf(saved, units[0].ID, "retired"); len(retired) != 1 || retired[0].ID != mountedSlot.ID {
		t.Fatalf("retired = %+v", retired)
	}
}

func TestSaveSetupBumpsTheConnectorConfigurationWhenEnabledChanges(t *testing.T) {
	f := newSetupFixture(t)
	pool := printingIntegrationPool(t)
	ctx := t.Context()
	created := f.mustSave(0, h2dSetup())
	connectorID, assignmentID := ids.New(), ids.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO printer_connectors (id, name, lifecycle) VALUES ($1, $2, 'active')`,
		connectorID,
		"Setup connector "+f.suffix,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind, settings) VALUES ($1, $2, $3, 'simulator', '{}')`,
		assignmentID,
		connectorID,
		f.machineID,
	); err != nil {
		t.Fatal(err)
	}
	revision := func() (value int64) {
		if err := pool.QueryRow(
			ctx,
			`SELECT configuration_revision FROM printer_connectors WHERE id = $1`,
			connectorID,
		).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := revision()
	same := h2dSetup()
	units := activeUnits(created)
	same.InputUnits[0].ID, same.InputUnits[1].ID = &units[0].ID, &units[1].ID
	saved := f.mustSave(created.Version, same)
	if revision() != before {
		t.Fatal("saving without an enabled change must not bump the connector")
	}
	same.Enabled = false
	f.mustSave(saved.Version, same)
	if revision() != before+1 {
		t.Fatalf("disabling printing must bump the connector configuration: %d -> %d", before, revision())
	}
}
