package machinelogbook

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// mountSpool places the spool into a new machine slot and returns the names it was mounted under.
func (f *fillFixture) mountSpool(t *testing.T, spool FilamentSpool) (machine Machine, unitName, slotName string) {
	t.Helper()
	typ, err := f.s.CreateMachineType(t.Context(), f.p, f.unique("Mount type"), "other", &f.request)
	if err != nil {
		t.Fatal(err)
	}
	machine, err = f.s.CreateMachine(t.Context(), f.p, typ.ID, f.unique("Mount machine"), "active", nil, false, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	unit, slot := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	unitName, slotName = "AMS A", "Slot 3"
	for _, step := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO printer_profiles (machine_id) VALUES ($1)`, []any{machine.ID}},
		{`INSERT INTO printer_input_units (id, machine_id, name, position) VALUES ($1, $2, $3, 0)`, []any{unit, machine.ID, unitName}},
		{`INSERT INTO printer_slots (id, input_unit_id, name, position) VALUES ($1, $2, $3, 0)`, []any{slot, unit, slotName}},
		{`INSERT INTO printer_spool_assignments (id, slot_id, spool_id, mounted_at, source) VALUES ($1, $2, $3, $4, 'manual')`, []any{uuid.Must(uuid.NewV7()), slot, spool.ID, f.now.Add(-time.Hour)}},
	} {
		if _, err = f.pool.Exec(t.Context(), step.sql, step.args...); err != nil {
			t.Fatal(err)
		}
	}
	return machine, unitName, slotName
}

func TestCreateEmptyReusableSpool(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	m := f.material(t, "500")
	before := f.refresh(t, m)

	input := FilamentSpoolInput{Kind: "reusable", Label: f.unique("Empty"), StockMode: "empty", OccurredAt: f.now,
		// Material, weight and version are ignored for an empty spool.
		MaterialID: m.ID, InitialNetWeightG: "999", ExpectedInventoryVersion: 99}
	spool, err := f.s.CreateFilamentSpool(ctx, f.p, input, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if spool.Status != "needs_refill" || spool.Kind != "reusable" || spool.FillID != nil || spool.MaterialID != nil || spool.RemainingQuantity != "0" || spool.Mounted || spool.MountedOn != nil {
		t.Fatalf("empty spool: %+v", spool)
	}
	var fills, ledger int
	if err = f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM filament_spool_fills WHERE spool_id = $1), (SELECT count(*) FROM inventory_transactions WHERE spool_id = $1 OR from_spool_id = $1 OR to_spool_id = $1)`, spool.ID).Scan(&fills, &ledger); err != nil {
		t.Fatal(err)
	}
	if fills != 0 || ledger != 0 {
		t.Fatalf("empty spool has %d fills and %d ledger rows", fills, ledger)
	}
	after := f.refresh(t, m)
	if after.InventoryVersion != before.InventoryVersion || after.Quantity != before.Quantity {
		t.Fatalf("material changed: %+v -> %+v", before, after)
	}
	// Details and list tolerate a spool that never had a fill.
	if detail := f.get(t, spool.ID); detail.Status != "needs_refill" || detail.FillNumber != 0 || len(detail.Fills) != 0 {
		t.Fatalf("detail: %+v", detail)
	}
	// Narrow by display ID: the shared test database accumulates empty spools.
	items, _, err := f.s.ListFilamentSpools(ctx, f.p, SpoolFilters{Search: spool.DisplayID, Statuses: []string{"needs_refill"}, Kind: "reusable", Page: 1, PageSize: 100})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range items {
		found = found || item.ID == spool.ID
	}
	if !found {
		t.Fatal("empty spool is not listed as needs_refill")
	}

	// A later fill works like after a finished fill.
	filled, err := f.s.ChangeFilamentSpoolFill(ctx, f.p, spool.ID, ChangeFillInput{Fill: NewFillInput{MaterialID: m.ID, NetWeightG: "300", Source: "loose_stock"}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: spool.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if filled.Status != "loaded" || filled.FillNumber != 1 || filled.RemainingQuantity != "300" {
		t.Fatalf("filled: %+v", filled)
	}
}

func TestCreateEmptySpoolRules(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	m := f.material(t, "500")
	base := FilamentSpoolInput{Label: f.unique("Rules"), StockMode: "empty", OccurredAt: f.now}

	for _, kind := range []string{"", "single_use"} {
		input := base
		input.Kind = kind
		if _, err := f.s.CreateFilamentSpool(ctx, f.p, input, &f.request); !apperror.IsCode(err, "empty_requires_reusable") {
			t.Fatalf("kind %q: %v", kind, err)
		}
	}
	// New acquisitions and existing stock still require material, weight and version.
	for name, input := range map[string]FilamentSpoolInput{
		"no material": {Kind: "reusable", StockMode: "existing_stock", InitialNetWeightG: "100", OccurredAt: f.now, ExpectedInventoryVersion: 1},
		"no weight":   {Kind: "reusable", StockMode: "existing_stock", MaterialID: m.ID, OccurredAt: f.now, ExpectedInventoryVersion: 1},
		"no version":  {Kind: "reusable", StockMode: "new_acquisition", MaterialID: m.ID, InitialNetWeightG: "100", TotalPrice: ptr("5"), OccurredAt: f.now},
		"bad mode":    {Kind: "reusable", StockMode: "bogus", OccurredAt: f.now},
	} {
		if _, err := f.s.CreateFilamentSpool(ctx, f.p, input, &f.request); !apperror.IsCode(err, "validation_failed") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// Registering an empty spool needs the same permissions as any other spool.
	for name, p := range map[string]authorization.Principal{
		"spools only":    restrictedPrincipal(t, f.pool, authorization.InventoryRead, authorization.FilamentSpoolsManage),
		"inventory only": restrictedPrincipal(t, f.pool, authorization.InventoryRead, authorization.InventoryManage),
		"read only":      restrictedPrincipal(t, f.pool, authorization.InventoryRead),
	} {
		input := base
		input.Kind = "reusable"
		if _, err := f.s.CreateFilamentSpool(ctx, p, input, &f.request); !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	allowed := restrictedPrincipal(t, f.pool, authorization.FilamentSpoolsManage, authorization.InventoryManage)
	input := base
	input.Kind = "reusable"
	if _, err := f.s.CreateFilamentSpool(ctx, allowed, input, &f.request); err != nil {
		t.Fatal(err)
	}
}

func TestSpoolSupplierAndLedgerActorName(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	m := f.material(t, "")
	input := f.spoolInput(m, "single_use", "800")
	input.StockMode, input.TotalPrice, input.Supplier = "new_acquisition", ptr("24"), ptr("  Filament Shop  ")
	spool, err := f.s.CreateFilamentSpool(ctx, f.p, input, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	tooLong := input
	tooLong.Supplier = ptr(string(make([]byte, 201)))
	if _, err = f.s.CreateFilamentSpool(ctx, f.p, tooLong, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("supplier length: %v", err)
	}

	spoolRows, total, err := f.s.ListFilamentSpoolTransactions(ctx, f.p, spool.ID, 1, 25)
	if err != nil || total != 1 || len(spoolRows) != 1 {
		t.Fatalf("spool ledger: %+v %d %v", spoolRows, total, err)
	}
	if row := spoolRows[0]; row.Kind != "purchase" || row.Supplier == nil || *row.Supplier != "Filament Shop" || row.ActorName == nil || *row.ActorName != "Fill Tester" {
		t.Fatalf("spool purchase row: %+v", row)
	}
	materialRows, _, err := f.s.ListMaterialTransactions(ctx, f.p, m.ID, 1, 25)
	if err != nil || len(materialRows) != 1 {
		t.Fatalf("material ledger: %+v %v", materialRows, err)
	}
	if materialRows[0].ActorName == nil || *materialRows[0].ActorName != "Fill Tester" {
		t.Fatalf("material actor: %+v", materialRows[0])
	}
	// Entries without a recorded actor (for example after account deletion) stay anonymous.
	if _, err = f.pool.Exec(ctx, `UPDATE inventory_transactions SET actor_account_id = NULL WHERE id = $1`, materialRows[0].ID); err != nil {
		t.Fatal(err)
	}
	materialRows, _, err = f.s.ListMaterialTransactions(ctx, f.p, m.ID, 1, 25)
	if err != nil || materialRows[0].ActorName != nil {
		t.Fatalf("anonymous actor: %+v %v", materialRows, err)
	}
}

func TestSpoolMountedOn(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	m := f.material(t, "2000")
	mounted := f.spool(t, m, "reusable", "400")
	loose := f.spool(t, m, "reusable", "400")
	machine, unitName, slotName := f.mountSpool(t, mounted)

	check := func(label string, item FilamentSpool) {
		t.Helper()
		mo := item.MountedOn
		if !item.Mounted || mo == nil || mo.MachineID != machine.ID || mo.MachineName != machine.Name || mo.SlotName != slotName || mo.InputUnitName == nil || *mo.InputUnitName != unitName || mo.SlotID == uuid.Nil {
			t.Fatalf("%s: mounted=%v mountedOn=%+v", label, item.Mounted, mo)
		}
	}
	check("detail", f.get(t, mounted.ID))
	if other := f.get(t, loose.ID); other.Mounted || other.MountedOn != nil {
		t.Fatalf("unmounted detail: %+v", other)
	}
	items, _, err := f.s.ListFilamentSpools(ctx, f.p, SpoolFilters{MaterialID: &m.ID, Page: 1, PageSize: 100})
	if err != nil || len(items) != 2 {
		t.Fatalf("list: %d %v", len(items), err)
	}
	for _, item := range items {
		if item.ID == mounted.ID {
			check("list", item)
		} else if item.MountedOn != nil {
			t.Fatalf("list unmounted: %+v", item.MountedOn)
		}
	}
	yes := true
	filtered, _, err := f.s.ListFilamentSpools(ctx, f.p, SpoolFilters{MaterialID: &m.ID, Mounted: &yes, Page: 1, PageSize: 100})
	if err != nil || len(filtered) != 1 || filtered[0].ID != mounted.ID {
		t.Fatalf("mounted filter: %+v %v", filtered, err)
	}

	// Closed assignments no longer count.
	if _, err = f.pool.Exec(ctx, `UPDATE printer_spool_assignments SET unmounted_at = $2 WHERE spool_id = $1`, mounted.ID, f.now); err != nil {
		t.Fatal(err)
	}
	if after := f.get(t, mounted.ID); after.Mounted || after.MountedOn != nil {
		t.Fatalf("after unmount: %+v", after)
	}
}
