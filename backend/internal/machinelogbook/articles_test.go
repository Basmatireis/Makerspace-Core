package machinelogbook

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func (f *fillFixture) receipt(material *MaterialInput, id *uuid.UUID, version int64) ReceiptInput {
	return ReceiptInput{MaterialID: id, Material: material, ExpectedInventoryVersion: version, PackageCount: 1, PackageSize: ptr("1000"), TotalPrice: "20.00", OccurredAt: f.now, Supplier: ptr("Shop " + f.suffix), Reference: ptr("PO-1")}
}

func (f *fillFixture) auditCount(t *testing.T, action string, id uuid.UUID) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_events WHERE action = $1 AND resource_id = $2`, action, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestMaterialTypeKindRules(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	s, p := f.s, f.p
	name := func(n string) string { return n + " " + f.suffix }
	var typeIDs []uuid.UUID
	t.Cleanup(func() {
		for _, id := range typeIDs {
			_, _ = f.pool.Exec(ctx, `DELETE FROM material_types WHERE id = $1`, id)
		}
	})
	// Filament: grams and FDM printing (the default), possibly next to others.
	if _, err := s.CreateMaterialType(ctx, p, name("Bad filament"), "filament", "m", nil, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("filament in metres: %v", err)
	}
	if _, err := s.CreateMaterialType(ctx, p, name("Bad filament"), "filament", "g", []string{"other"}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("filament without fdm_printing: %v", err)
	}
	mixed, err := s.CreateMaterialType(ctx, p, name("Mixed filament"), "filament", "g", []string{"fdm_printing", "other"}, &f.request)
	if err != nil {
		t.Fatalf("filament with another process: %v", err)
	}
	typeIDs = append(typeIDs, mixed.ID)
	filament, err := s.CreateMaterialType(ctx, p, name("Filament"), "filament", "g", nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	typeIDs = append(typeIDs, filament.ID)
	if filament.Kind != "filament" || len(filament.Processes) != 1 || filament.Processes[0] != "fdm_printing" {
		t.Fatalf("filament type: %+v", filament)
	}
	// Consumables need a process, parts take none.
	if _, err = s.CreateMaterialType(ctx, p, name("Bad consumable"), "consumable", "m", nil, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("consumable without process: %v", err)
	}
	if _, err = s.CreateMaterialType(ctx, p, name("Bad part"), "part", "piece", []string{"other"}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("part with process: %v", err)
	}
	if _, err = s.CreateMaterialType(ctx, p, name("Bad kind"), "tool", "piece", nil, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("unknown kind: %v", err)
	}
	part, err := s.CreateMaterialType(ctx, p, name("Fasteners"), "part", "piece", nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	typeIDs = append(typeIDs, part.ID)
	if part.Kind != "part" || len(part.Processes) != 0 {
		t.Fatalf("part type: %+v", part)
	}

	// The kind cannot change while the type has materials, but may before.
	updated, err := s.UpdateMaterialType(ctx, p, part.ID, part.Version, part.Name, "consumable", "piece", []string{"other"}, true, &f.request)
	if err != nil || updated.Kind != "consumable" || len(updated.Processes) != 1 {
		t.Fatalf("kind change without materials: %+v %v", updated, err)
	}
	updated, err = s.UpdateMaterialType(ctx, p, part.ID, updated.Version, part.Name, "part", "piece", nil, true, &f.request)
	if err != nil || updated.Kind != "part" || len(updated.Processes) != 0 {
		t.Fatalf("back to part: %+v %v", updated, err)
	}
	screw, err := s.CreateMaterial(ctx, p, MaterialInput{Name: name("M3 screw"), MaterialTypeID: part.ID}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if screw.Kind != "part" || screw.FilamentDiameterMM != nil {
		t.Fatalf("part article: %+v", screw)
	}
	if _, err = s.UpdateMaterialType(ctx, p, part.ID, updated.Version, part.Name, "consumable", "piece", []string{"other"}, true, &f.request); !apperror.IsCode(err, "material_type_in_use") {
		t.Fatalf("kind change with materials: %v", err)
	}
	// Parts cannot be used in a machine run: their type serves no process.
	jf := newJobFixture(t)
	buy, err := s.AddPurchase(ctx, p, screw.ID, screw.InventoryVersion, "10", "5", f.now, nil, nil, nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	in := jf.input(-3*time.Hour, time.Hour, "successful")
	in.Usages = []UsageInput{{MaterialID: buy.Material.ID, Ownership: "makerspace", Quantity: "1"}}
	if _, err = jf.s.CreateManualJob(ctx, jf.p, in, &jf.request); !apperror.IsCode(err, "material_process_mismatch") {
		t.Fatalf("part in a run: %v", err)
	}
	// Parts are priced by their sale price: no pricing rule may target them, and
	// a type with an active rule cannot become a part category.
	if _, err = jf.s.CreatePricingRule(ctx, jf.p, jf.group.ID, "material", nil, &part.ID, nil, "1", &jf.request); !apperror.IsCode(err, "material_type_not_priced") {
		t.Fatalf("pricing rule on a part type: %v", err)
	}
	priced, err := s.CreateMaterialType(ctx, p, name("Priced"), "consumable", "piece", []string{"other"}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	typeIDs = append(typeIDs, priced.ID)
	if _, err = jf.s.CreatePricingRule(ctx, jf.p, jf.group.ID, "material", nil, &priced.ID, nil, "1", &jf.request); err != nil {
		t.Fatal(err)
	}
	if _, err = s.UpdateMaterialType(ctx, p, priced.ID, priced.Version, priced.Name, "part", "piece", nil, true, &f.request); !apperror.IsCode(err, "material_type_in_use") {
		t.Fatalf("priced type to part: %v", err)
	}
	// Kind filter on the list.
	items, _, _, err := s.ListMaterials(ctx, p, f.suffix, nil, "part", "", 1, 50)
	if err != nil || len(items) != 1 || items[0].ID != screw.ID {
		t.Fatalf("kind filter: %+v %v", items, err)
	}
}

func TestArticleNamesDiameterAndFields(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	s, p := f.s, f.p
	typeName := "Fill PLA " + f.suffix
	m, err := s.CreateMaterial(ctx, p, MaterialInput{MaterialTypeID: f.typeID, Variant: ptr("Basic"), ColorName: ptr("Black"), Manufacturer: ptr("Bambu Lab"), SalePrice: ptr("0.03"), PackageSize: ptr("1000"), StorageLocation: ptr("Shelf 1"), Notes: ptr("note")}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if want := typeName + " Basic · Black · Bambu Lab"; m.Name != want {
		t.Fatalf("name %q, want %q", m.Name, want)
	}
	if m.Kind != "filament" || m.FilamentDiameterMM == nil || *m.FilamentDiameterMM != "1.75" || m.Variant == nil || m.SalePrice == nil || *m.SalePrice != "0.03" || m.PackageSize == nil || *m.PackageSize != "1000" {
		t.Fatalf("article: %+v", m)
	}
	// The same combination is a name conflict that points at the existing article.
	_, err = s.CreateMaterial(ctx, p, MaterialInput{MaterialTypeID: f.typeID, Variant: ptr("basic"), ColorName: ptr("black"), Manufacturer: ptr("bambu lab")}, &f.request)
	var appErr *apperror.Error
	if !apperror.IsCode(err, "material_name_conflict") {
		t.Fatalf("duplicate: %v", err)
	}
	appErr = err.(*apperror.Error)
	if appErr.HTTPStatus != 409 || appErr.Details["materialId"] != m.ID.String() {
		t.Fatalf("conflict details: %+v", appErr)
	}
	plain, err := s.CreateMaterial(ctx, p, MaterialInput{MaterialTypeID: f.typeID}, &f.request)
	if err != nil || plain.Name != typeName {
		t.Fatalf("name without parts: %+v %v", plain, err)
	}
	if _, err = s.CreateMaterial(ctx, p, MaterialInput{MaterialTypeID: f.typeID, FilamentDiameterMM: ptr("-1")}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("bad diameter: %v", err)
	}
	// Non-filament kinds have no diameter and parts need a name.
	cons, err := s.CreateMaterialType(ctx, p, "Acrylic "+f.suffix, "consumable", "cm2", []string{"laser_cutting"}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = f.pool.Exec(ctx, `DELETE FROM material_types WHERE id = $1`, cons.ID) })
	if _, err = s.CreateMaterial(ctx, p, MaterialInput{MaterialTypeID: cons.ID, FilamentDiameterMM: ptr("1.75")}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("diameter on consumable: %v", err)
	}
	clear, err := s.CreateMaterial(ctx, p, MaterialInput{MaterialTypeID: cons.ID, Variant: ptr("3 mm"), ColorName: ptr("Clear")}, &f.request)
	if err != nil || clear.Name != "Acrylic "+f.suffix+" 3 mm · Clear" || clear.FilamentDiameterMM != nil {
		t.Fatalf("consumable: %+v %v", clear, err)
	}
	part, err := s.CreateMaterialType(ctx, p, "Bike "+f.suffix, "part", "piece", nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = f.pool.Exec(ctx, `DELETE FROM material_types WHERE id = $1`, part.ID) })
	if _, err = s.CreateMaterial(ctx, p, MaterialInput{MaterialTypeID: part.ID}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("part without name: %v", err)
	}
	if _, err = s.CreateMaterial(ctx, p, MaterialInput{Name: "Bad " + f.suffix, MaterialTypeID: part.ID, SalePrice: ptr("-1")}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("negative sale price: %v", err)
	}
	// Updating without a name regenerates it, and an article stays within its kind.
	renamed, err := s.UpdateMaterial(ctx, p, m.ID, MaterialInput{MaterialTypeID: f.typeID, Variant: ptr("Matte"), ColorName: ptr("Black"), Manufacturer: ptr("Bambu Lab"), Active: true, ExpectedVersion: m.Version}, &f.request)
	if err != nil || renamed.Name != typeName+" Matte · Black · Bambu Lab" || renamed.FilamentDiameterMM == nil {
		t.Fatalf("regenerated: %+v %v", renamed, err)
	}
	if _, err = s.UpdateMaterial(ctx, p, renamed.ID, MaterialInput{Name: "x " + f.suffix, MaterialTypeID: part.ID, Active: true, ExpectedVersion: renamed.Version}, &f.request); !apperror.IsCode(err, "material_kind_change") {
		t.Fatalf("kind move: %v", err)
	}
}

func TestReceiveStockToStorageAndNewArticle(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	s, p := f.s, f.p
	input := MaterialInput{MaterialTypeID: f.typeID, Variant: ptr("Silk"), Manufacturer: ptr("Maker " + f.suffix), StorageLocation: ptr("Shelf 9")}
	got, err := s.ReceiveStock(ctx, p, f.receipt(&input, nil, 0), &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if got.Material.Quantity != "1000" || got.Material.InventoryValue != "20" || len(got.Transactions) != 1 || len(got.Spools) != 0 {
		t.Fatalf("receipt: %+v", got)
	}
	tx := got.Transactions[0]
	if tx.Reference == nil || *tx.Reference != "PO-1" || tx.Kind != "purchase" || tx.TotalPurchasePrice == nil {
		t.Fatalf("transaction: %+v", tx)
	}
	if f.auditCount(t, "inventory.receipt_recorded", got.Material.ID) != 1 || f.auditCount(t, "material.created", got.Material.ID) != 1 {
		t.Fatal("audit events missing")
	}
	// An existing article with its default package size.
	again := f.receipt(nil, &got.Material.ID, got.Material.InventoryVersion)
	again.PackageSize, again.PackageCount, again.TotalPrice = nil, 2, "30.00"
	if _, err = s.ReceiveStock(ctx, p, again, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("no package size: %v", err)
	}
	m, err := s.UpdateMaterial(ctx, p, got.Material.ID, MaterialInput{MaterialTypeID: f.typeID, Variant: ptr("Silk"), Manufacturer: ptr("Maker " + f.suffix), PackageSize: ptr("500"), Active: true, ExpectedVersion: got.Material.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	again.ExpectedInventoryVersion = m.InventoryVersion
	got, err = s.ReceiveStock(ctx, p, again, &f.request)
	if err != nil || got.Material.Quantity != "2000" {
		t.Fatalf("default package size: %+v %v", got.Material, err)
	}
	// Stale version, future date, bad price, and both/none of material and materialId.
	stale := f.receipt(nil, &m.ID, 1)
	if _, err = s.ReceiveStock(ctx, p, stale, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale: %v", err)
	}
	future := f.receipt(nil, &m.ID, got.Material.InventoryVersion)
	future.OccurredAt = f.now.Add(time.Hour)
	if _, err = s.ReceiveStock(ctx, p, future, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("future: %v", err)
	}
	for _, price := range []string{"-1", "1.234", "abc"} {
		bad := f.receipt(nil, &m.ID, got.Material.InventoryVersion)
		bad.TotalPrice = price
		if _, err = s.ReceiveStock(ctx, p, bad, &f.request); !apperror.IsCode(err, "validation_failed") {
			t.Fatalf("price %q: %v", price, err)
		}
	}
	both := f.receipt(&input, &m.ID, got.Material.InventoryVersion)
	if _, err = s.ReceiveStock(ctx, p, both, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("both: %v", err)
	}
	// A failing receipt rolls the inline article back.
	rollback := MaterialInput{MaterialTypeID: f.typeID, Variant: ptr("Rollback"), Manufacturer: ptr("R " + f.suffix)}
	failing := f.receipt(&rollback, nil, 0)
	failing.Placement = &ReceiptPlacement{Mode: PlacementReusableSpool, ReusableSpoolID: ptr(uuid.Must(uuid.NewV7())), ReusableSpoolExpectedVersion: 1}
	if _, err = s.ReceiveStock(ctx, p, failing, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown spool: %v", err)
	}
	failing.Placement = nil
	failing.PackageSize, failing.OccurredAt = nil, f.now
	if _, err = s.ReceiveStock(ctx, p, failing, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("missing package size: %v", err)
	}
	var n int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM materials WHERE manufacturer = $1`, "R "+f.suffix).Scan(&n); err != nil || n != 0 {
		t.Fatalf("inline article survived the failed receipt: %d %v", n, err)
	}
}

func TestReceiveStockOnNewSpools(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	s, p := f.s, f.p
	input := MaterialInput{MaterialTypeID: f.typeID, Variant: ptr("Spools"), Manufacturer: ptr("Maker " + f.suffix), StorageLocation: ptr("Rack A")}
	in := f.receipt(&input, nil, 0)
	in.PackageCount, in.TotalPrice = 3, "100.00"
	in.Placement = &ReceiptPlacement{Mode: PlacementNewSpools, TareWeightG: ptr("210")}
	got, err := s.ReceiveStock(ctx, p, in, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if got.Material.Quantity != "3000" || got.Material.InventoryValue != "100" || got.Material.AssignedQuantity != "3000" || len(got.Spools) != 3 || len(got.Transactions) != 3 {
		t.Fatalf("receipt: %+v", got.Material)
	}
	prices := []string{"33.33", "33.33", "33.34"}
	for i, spool := range got.Spools {
		if spool.Kind != "single_use" || spool.RemainingQuantity != "1000" || spool.FillNumber != 1 || spool.StorageLocation == nil || *spool.StorageLocation != "Rack A" ||
			spool.Manufacturer == nil || *spool.Manufacturer != "Maker "+f.suffix || spool.TareWeightG == nil || *spool.TareWeightG != "210" {
			t.Fatalf("spool %d: %+v", i, spool)
		}
		if tx := got.Transactions[i]; tx.TotalPurchasePrice == nil || *tx.TotalPurchasePrice != prices[i] || tx.SpoolID == nil || *tx.SpoolID != spool.ID {
			t.Fatalf("transaction %d: %+v", i, tx)
		}
	}
	if f.auditCount(t, "inventory.receipt_recorded", got.Material.ID) != 1 {
		t.Fatal("one receipt audit event expected")
	}
	// Identifiers need exactly one spool; a reused identifier is refused.
	in2 := f.receipt(nil, &got.Material.ID, got.Material.InventoryVersion)
	in2.PackageCount = 2
	in2.Placement = &ReceiptPlacement{Mode: PlacementNewSpools, Identifiers: []NewSpoolIdentifier{{Kind: "barcode", Value: "RC-" + f.suffix}}}
	if _, err = s.ReceiveStock(ctx, p, in2, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("identifier with two spools: %v", err)
	}
	in2.PackageCount = 1
	one, err := s.ReceiveStock(ctx, p, in2, &f.request)
	if err != nil || len(one.Spools) != 1 || len(one.Spools[0].Identifiers) != 1 {
		t.Fatalf("one spool with identifier: %+v %v", one, err)
	}
	in3 := f.receipt(nil, &got.Material.ID, one.Material.InventoryVersion)
	in3.Placement = in2.Placement
	if _, err = s.ReceiveStock(ctx, p, in3, &f.request); !apperror.IsCode(err, "identifier_in_use") {
		t.Fatalf("identifier reuse: %v", err)
	}
	if after := f.refresh(t, got.Material); after.Quantity != "4000" {
		t.Fatalf("refused receipt changed stock: %+v", after)
	}
}

func TestReceiveStockOntoReusableSpool(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	s, p := f.s, f.p
	m := f.material(t, "")
	empty, err := s.CreateFilamentSpool(ctx, p, FilamentSpoolInput{Kind: "reusable", StockMode: "empty", OccurredAt: f.now}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	placement := func(spool FilamentSpool) *ReceiptPlacement {
		return &ReceiptPlacement{Mode: PlacementReusableSpool, ReusableSpoolID: &spool.ID, ReusableSpoolExpectedVersion: spool.Version}
	}
	in := f.receipt(nil, &m.ID, m.InventoryVersion)
	in.Placement = placement(empty)
	in.PackageCount = 2
	if _, err = s.ReceiveStock(ctx, p, in, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("two packages on one spool: %v", err)
	}
	in.PackageCount = 1
	got, err := s.ReceiveStock(ctx, p, in, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Spools) != 1 || got.Spools[0].ID != empty.ID || got.Spools[0].FillNumber != 1 || got.Spools[0].RemainingQuantity != "1000" || got.Material.AssignedQuantity != "1000" {
		t.Fatalf("loaded spool: %+v", got.Spools)
	}
	// Loaded, single-use and archived spools are refused without side effects.
	loaded := f.get(t, empty.ID)
	again := f.receipt(nil, &m.ID, got.Material.InventoryVersion)
	again.Placement = placement(loaded)
	if _, err = s.ReceiveStock(ctx, p, again, &f.request); !apperror.IsCode(err, "spool_already_loaded") {
		t.Fatalf("loaded spool: %v", err)
	}
	single := f.purchasedSpool(t, m, "single_use", "100")
	again = f.receipt(nil, &m.ID, f.refresh(t, m).InventoryVersion)
	again.Placement = placement(single)
	if _, err = s.ReceiveStock(ctx, p, again, &f.request); !apperror.IsCode(err, "spool_not_reusable") {
		t.Fatalf("single-use spool: %v", err)
	}
	stale := f.receipt(nil, &m.ID, f.refresh(t, m).InventoryVersion)
	stale.Placement = &ReceiptPlacement{Mode: PlacementReusableSpool, ReusableSpoolID: &empty.ID, ReusableSpoolExpectedVersion: 99}
	if _, err = s.ReceiveStock(ctx, p, stale, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale spool: %v", err)
	}
	if after := f.refresh(t, m); after.Quantity != "1100" {
		t.Fatalf("refused receipts changed stock: %+v", after)
	}
}

func TestReceiveStockRefusesSpoolPlacementForOtherKinds(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	part, err := f.s.CreateMaterialType(ctx, f.p, "Parts "+f.suffix, "part", "piece", nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = f.pool.Exec(ctx, `DELETE FROM material_types WHERE id = $1`, part.ID) })
	article := MaterialInput{Name: "Insert " + f.suffix, MaterialTypeID: part.ID, PackageSize: ptr("100")}
	in := f.receipt(&article, nil, 0)
	in.Placement = &ReceiptPlacement{Mode: PlacementNewSpools}
	if _, err = f.s.ReceiveStock(ctx, f.p, in, &f.request); !apperror.IsCode(err, "placement_requires_filament") {
		t.Fatalf("spool placement of a part: %v", err)
	}
	var n int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM materials WHERE name = $1`, article.Name).Scan(&n); err != nil || n != 0 {
		t.Fatalf("article survived: %d %v", n, err)
	}
	in.Placement = &ReceiptPlacement{Mode: PlacementStorage}
	in.PackageCount, in.PackageSize, in.TotalPrice = 3, nil, "15.00"
	got, err := f.s.ReceiveStock(ctx, f.p, in, &f.request)
	if err != nil || got.Material.Quantity != "300" || got.Material.Kind != "part" || len(got.Transactions) != 1 {
		t.Fatalf("part receipt: %+v %v", got.Material, err)
	}
}

func TestReceiptsAndSuggestionsRequirePermissions(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	nobody := authorization.Principal{AccountID: uuid.Must(uuid.NewV7()), PersonID: uuid.Must(uuid.NewV7())}
	m := f.material(t, "")
	in := f.receipt(nil, &m.ID, m.InventoryVersion)
	if _, err := f.s.ReceiveStock(ctx, nobody, in, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("receipt: %v", err)
	}
	in.Placement = &ReceiptPlacement{Mode: PlacementNewSpools}
	if _, err := f.s.ReceiveStock(ctx, nobody, in, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("spool receipt: %v", err)
	}
	if _, err := f.s.ListInventorySuggestions(ctx, nobody, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("suggestions: %v", err)
	}
}

func TestInventorySuggestionsAreOrderedByFrequency(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	for i, variant := range []string{"Zeta", "Alpha", "Zeta"} {
		in := MaterialInput{MaterialTypeID: f.typeID, Variant: ptr(variant), Manufacturer: ptr("Maker " + f.suffix), ColorName: ptr(string(rune('A' + i)))}
		receipt := f.receipt(&in, nil, 0)
		receipt.Supplier = ptr("Shop " + f.suffix)
		receipt.Reference = nil
		if _, err := f.s.ReceiveStock(ctx, f.p, receipt, &f.request); err != nil {
			t.Fatal(err)
		}
	}
	got, err := f.s.ListInventorySuggestions(ctx, f.p, &f.typeID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Variants) != 2 || got.Variants[0] != "Zeta" || got.Variants[1] != "Alpha" {
		t.Fatalf("variants: %v", got.Variants)
	}
	has := func(values []string, want string) bool {
		for _, v := range values {
			if v == want {
				return true
			}
		}
		return false
	}
	if !has(got.Manufacturers, "Maker "+f.suffix) || !has(got.Suppliers, "Shop "+f.suffix) || len(got.Variants) > 50 {
		t.Fatalf("suggestions: %+v", got)
	}
	other, err := f.s.ListInventorySuggestions(ctx, f.p, ptr(uuid.Must(uuid.NewV7())))
	if err != nil || len(other.Variants) != 0 {
		t.Fatalf("variants of an unknown type: %+v %v", other, err)
	}
}

func TestPurchaseReferenceIsImmutable(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	m := f.material(t, "")
	res, err := f.s.AddPurchase(ctx, f.p, m.ID, m.InventoryVersion, "100", "5", f.now, nil, ptr("INV-7"), nil, &f.request)
	if err != nil || res.Transaction.Reference == nil || *res.Transaction.Reference != "INV-7" {
		t.Fatalf("purchase: %+v %v", res.Transaction, err)
	}
	if _, err = f.pool.Exec(ctx, `UPDATE inventory_transactions SET purchase_reference = 'changed' WHERE id = $1`, res.Transaction.ID); err == nil {
		t.Fatal("purchase reference must be immutable")
	}
	if _, err = f.s.AddPurchase(ctx, f.p, m.ID, res.Material.InventoryVersion, "100", "5", f.now, nil, ptr(string(make([]byte, 201))), nil, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("long reference: %v", err)
	}
	if _, err = f.pool.Exec(ctx, `UPDATE inventory_transactions SET purchase_reference = 'x' WHERE id = $1 AND kind <> 'purchase'`, res.Transaction.ID); err != nil {
		t.Fatal(err)
	}
}
