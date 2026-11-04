package machinelogbook

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// spoolsClock sits far from real data.
var spoolsClock = time.Date(2032, time.May, 10, 12, 0, 0, 0, time.UTC)

type spoolFixture struct {
	pool    *pgxpool.Pool
	s       *Service
	p       authorization.Principal
	request uuid.UUID
	now     time.Time
	suffix  string
	counter int
	code    string
	typeID  uuid.UUID
	// fdm serves the filament type; plain is a process without integration for consumables.
	fdm, plain Process
}

func newSpoolFixture(t *testing.T) *spoolFixture {
	t.Helper()
	pool := integrationPool(t)
	ctx := t.Context()
	person, account := ids.New(), ids.New()
	f := &spoolFixture{
		pool:    pool,
		request: ids.New(),
		now:     spoolsClock,
		suffix:  strings.ReplaceAll(person.String(), "-", "")[:12],
	}
	f.code = strings.ToUpper("T" + f.suffix[1:])
	f.s = NewService(pool, inbox.NewEmitter(), WithClock(func() time.Time { return f.now }))
	f.p = authorization.Principal{AccountID: account, PersonID: person, Master: true}
	if _, err := pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Spool', 'Tester', $2)`, person, "spools-"+f.suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, account, person); err != nil {
		t.Fatal(err)
	}
	var err error
	if f.fdm, err = f.s.CreateProcess(ctx, f.p, "Spool FDM "+f.suffix, IntegrationFDMPrinter, nil, &f.request); err != nil {
		t.Fatal(err)
	}
	if f.plain, err = f.s.CreateProcess(ctx, f.p, "Spool plain "+f.suffix, IntegrationNone, nil, &f.request); err != nil {
		t.Fatal(err)
	}
	materialType, err := f.s.CreateMaterialTypeWithOptions(
		ctx,
		f.p,
		"Spool PLA "+f.suffix,
		KindFilament,
		"g",
		[]uuid.UUID{f.fdm.ID},
		MaterialTypeOptions{Code: &f.code},
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	f.typeID = materialType.ID
	return f
}

func (f *spoolFixture) unique(prefix string) string {
	f.counter++
	return fmt.Sprintf("%s %s %d", prefix, f.suffix, f.counter)
}

// material creates a filament article with a variant and colour that holds the given loose stock.
func (f *spoolFixture) material(t *testing.T, stock string) Material {
	t.Helper()
	diameter, variant, color := "1.75", "Basic", "Dark Blue"
	m, err := f.s.CreateMaterial(
		t.Context(),
		f.p,
		MaterialInput{
			Name:               f.unique("Spool PLA"),
			MaterialTypeID:     f.typeID,
			FilamentDiameterMM: &diameter,
			Variant:            &variant,
			ColorName:          &color,
		},
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	if stock != "" {
		result, purchaseErr := f.s.AddPurchase(t.Context(), f.p, m.ID, m.InventoryVersion, stock, "20", f.now, nil, nil, nil, &f.request)
		if purchaseErr != nil {
			t.Fatal(purchaseErr)
		}
		m = result.Material
	}
	return m
}

func (f *spoolFixture) refresh(t *testing.T, id uuid.UUID) Material {
	t.Helper()
	m, err := f.s.GetMaterial(t.Context(), f.p, id)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func (f *spoolFixture) spool(t *testing.T, m Material, weight string) FilamentSpool {
	t.Helper()
	spool, err := f.s.CreateFilamentSpool(t.Context(), f.p, FilamentSpoolInput{
		MaterialID:               m.ID,
		InitialNetWeightG:        weight,
		StockMode:                StockModeExistingStock,
		OccurredAt:               f.now,
		ExpectedInventoryVersion: f.refresh(t, m.ID).InventoryVersion,
	}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return spool
}

func (f *spoolFixture) get(t *testing.T, id uuid.UUID) FilamentSpool {
	t.Helper()
	spool, err := f.s.GetFilamentSpool(t.Context(), f.p, id)
	if err != nil {
		t.Fatal(err)
	}
	return spool
}

func (f *spoolFixture) consume(t *testing.T, spool FilamentSpool, quantity string) {
	t.Helper()
	fresh := f.get(t, spool.ID)
	if _, err := f.s.ConsumeFilamentSpool(t.Context(), f.p, spool.ID, f.refresh(t, spool.MaterialID).InventoryVersion,
		fresh.Version, quantity, f.now, false, nil, nil, &f.request); err != nil {
		t.Fatal(err)
	}
}

func (f *spoolFixture) retire(t *testing.T, id uuid.UUID, outcome SpoolRetireOutcome) FilamentSpool {
	t.Helper()
	spool, err := f.s.RetireFilamentSpool(t.Context(), f.p, id, f.get(t, id).Version, outcome, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return spool
}

// lastLedgerRow describes the newest ledger row of a material as "kind/reason delta label".
func (f *spoolFixture) lastLedgerRow(t *testing.T, materialID uuid.UUID) string {
	t.Helper()
	var kind, reason, delta, label string
	if err := f.pool.QueryRow(t.Context(), `SELECT kind, COALESCE(adjustment_reason, ''), quantity_delta::numeric::float8::text,
		COALESCE(spool_display_id, 'loose') FROM inventory_transactions WHERE material_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
		materialID).Scan(&kind, &reason, &delta, &label); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%s/%s %s %s", kind, reason, delta, label)
}

func assertStock(t *testing.T, m Material, quantity, assigned string) {
	t.Helper()
	if m.Quantity != quantity || m.AssignedQuantity != assigned {
		t.Fatalf("quantity/assigned = %s/%s, want %s/%s", m.Quantity, m.AssignedQuantity, quantity, assigned)
	}
}

func TestSpoolLabelsTakeTheSmallestFreeNumber(t *testing.T) {
	f := newSpoolFixture(t)
	m := f.material(t, "5000")
	prefix := "S-" + f.code + "-BASIC-DARK BLUE-"
	first, second := f.spool(t, m, "1000"), f.spool(t, m, "1000")
	if first.DisplayID != prefix+"01" || second.DisplayID != prefix+"02" {
		t.Fatalf("labels %q %q", first.DisplayID, second.DisplayID)
	}
	if first.MaterialDisplayID == "" || first.InitialNetWeightG != "1000" || first.RemainingQuantity != "1000" {
		t.Fatalf("spool facts: %+v", first)
	}
	assertStock(t, f.refresh(t, m.ID), "5000", "2000")

	// Retiring frees the number; a new spool takes it, so the restored spool needs the next free one.
	f.retire(t, first.ID, SpoolRetiredDiscarded)
	third := f.spool(t, m, "500")
	if third.DisplayID != prefix+"01" {
		t.Fatalf("freed number not reused: %q", third.DisplayID)
	}
	restored, err := f.s.RestoreFilamentSpool(t.Context(), f.p, first.ID, f.get(t, first.ID).Version, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if restored.DisplayID != prefix+"03" || restored.Lifecycle != SpoolActive || restored.RemainingQuantity != "1000" {
		t.Fatalf("restored spool: %s %s %s", restored.DisplayID, restored.Lifecycle, restored.RemainingQuantity)
	}
	assertStock(t, f.refresh(t, m.ID), "5000", "2500")
}

func TestSpoolLabelPrefixLeavesOutMissingParts(t *testing.T) {
	variant, color := "Silk", " light  · grey "
	if got := spoolLabelPrefix("PETG", &variant, &color); got != "S-PETG-SILK-LIGHT GREY" {
		t.Fatalf("prefix %q", got)
	}
	if got := spoolLabelPrefix("TPU", nil, nil); got != "S-TPU" {
		t.Fatalf("prefix %q", got)
	}
	if !regexp.MustCompile(`^S-[^-\s].*-[0-9]{2,}$`).MatchString(spoolLabelPrefix("TPU", nil, nil) + "-01") {
		t.Fatal("label does not match the database pattern")
	}
}

func TestRetireSpoolWritesTheRemainderOff(t *testing.T) {
	f := newSpoolFixture(t)
	m := f.material(t, "3000")
	empty, discarded := f.spool(t, m, "1000"), f.spool(t, m, "1000")
	f.consume(t, empty, "980")
	f.consume(t, discarded, "400")
	if _, err := f.s.AddFilamentSpoolIdentifier(t.Context(), f.p, empty.ID, IdentifierNFC, "TAG-"+f.suffix, &f.request); err != nil {
		t.Fatal(err)
	}

	retired := f.retire(t, empty.ID, SpoolRetiredEmpty)
	if retired.Lifecycle != SpoolArchived || retired.RetiredOutcome == nil || *retired.RetiredOutcome != SpoolRetiredEmpty ||
		retired.RetiredQuantity == nil || *retired.RetiredQuantity != "20" || retired.RemainingQuantity != "0" ||
		retired.RetiredByName == nil || len(retired.Identifiers) != 0 || retired.ArchivedAt == nil {
		t.Fatalf("retired empty: %+v", retired)
	}
	if got := f.lastLedgerRow(t, m.ID); got != "manual_consumption/unrecorded_consumption -20 "+empty.DisplayID {
		t.Fatalf("empty write-off: %s", got)
	}
	f.retire(t, discarded.ID, SpoolRetiredDiscarded)
	if got := f.lastLedgerRow(t, m.ID); got != "disposal/disposed -600 "+discarded.DisplayID {
		t.Fatalf("discard write-off: %s", got)
	}
	assertStock(t, f.refresh(t, m.ID), "1000", "0")
	if _, err := f.s.LookupFilamentSpool(t.Context(), f.p, IdentifierNFC, "TAG-"+f.suffix); !apperror.IsCode(err, "not_found") {
		t.Fatalf("retired tag still resolves: %v", err)
	}
	// A retired spool takes no more movements and cannot be retired twice.
	if _, err := f.s.RetireFilamentSpool(t.Context(), f.p, empty.ID, f.get(t, empty.ID).Version, SpoolRetiredEmpty, &f.request); !apperror.IsCode(err, "spool_not_consumable") {
		t.Fatalf("second retire: %v", err)
	}
	// Restoring an empty spool books nothing back; its tag comes back.
	restored, err := f.s.RestoreFilamentSpool(t.Context(), f.p, empty.ID, f.get(t, empty.ID).Version, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if restored.RemainingQuantity != "0" || len(restored.Identifiers) != 1 {
		t.Fatalf("restored empty spool: %+v", restored)
	}
}

func TestSpoolLifecyclePermissions(t *testing.T) {
	f := newSpoolFixture(t)
	ctx := t.Context()
	m := f.material(t, "2000")
	spool := f.spool(t, m, "1000")
	inventoryOnly := restrictedPrincipal(t, f.pool, authorization.InventoryRead, authorization.InventoryManage)
	if _, err := f.s.RetireFilamentSpool(ctx, inventoryOnly, spool.ID, spool.Version, SpoolRetiredEmpty, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("retire without filament_spools.manage: %v", err)
	}
	manager := restrictedPrincipal(t, f.pool, authorization.InventoryRead, authorization.InventoryManage, authorization.FilamentSpoolsManage)
	retired, err := f.s.RetireFilamentSpool(ctx, manager, spool.ID, spool.Version, SpoolRetiredDiscarded, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.PurgeFilamentSpool(ctx, manager, spool.ID, retired.Version, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("purge without inventory.delete: %v", err)
	}
	if _, err = f.s.RestoreFilamentSpool(ctx, inventoryOnly, spool.ID, retired.Version, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("restore without filament_spools.manage: %v", err)
	}
	active := f.spool(t, m, "500")
	if err = f.s.PurgeFilamentSpool(ctx, f.p, active.ID, active.Version, &f.request); !apperror.IsCode(err, "spool_not_retired") {
		t.Fatalf("purge of an active spool: %v", err)
	}
	bin, err := f.s.GetInventoryRecycleBin(ctx, inventoryOnly)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range bin.Spools {
		found = found || item.ID == spool.ID
	}
	if !found {
		t.Fatal("retired spool missing from the recycle bin")
	}
	purger := restrictedPrincipal(t, f.pool, authorization.FilamentSpoolsManage, authorization.InventoryDelete)
	if err = f.s.PurgeFilamentSpool(ctx, purger, spool.ID, retired.Version, &f.request); err != nil {
		t.Fatal(err)
	}
	var kept int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM inventory_transactions WHERE spool_id IS NULL AND spool_display_id = $1 AND material_id = $2`,
		spool.DisplayID, m.ID).Scan(&kept); err != nil || kept == 0 {
		t.Fatalf("ledger rows keep the label after a purge: %d %v", kept, err)
	}
	if _, err = f.s.GetFilamentSpool(ctx, f.p, spool.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("purged spool: %v", err)
	}
}

func TestSpoolAttentionWhenLittleIsLeft(t *testing.T) {
	f := newSpoolFixture(t)
	m := f.material(t, "1000")
	spool := f.spool(t, m, "1000")
	f.consume(t, spool, "900")
	if got := f.get(t, spool.ID).Attention; len(got) != 0 {
		t.Fatalf("10 %% left is not low yet: %+v", got)
	}
	f.consume(t, spool, "1")
	got := f.get(t, spool.ID).Attention
	if len(got) != 1 || got[0].Code != AttentionRemainderLow || got[0].Message == "" {
		t.Fatalf("attention: %+v", got)
	}
}

func TestMaterialLowStockAttention(t *testing.T) {
	f := newSpoolFixture(t)
	m := f.material(t, "400")
	threshold := "500"
	input := MaterialInput{
		Name:               m.Name,
		MaterialTypeID:     m.MaterialTypeID,
		Variant:            m.Variant,
		ColorName:          m.ColorName,
		FilamentDiameterMM: m.FilamentDiameterMM,
		LowStockThreshold:  &threshold,
		Active:             true,
		ExpectedVersion:    m.Version,
	}
	updated, err := f.s.UpdateMaterial(t.Context(), f.p, m.ID, input, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.Attention) != 1 || updated.Attention[0].Code != AttentionLowStock {
		t.Fatalf("attention: %+v", updated.Attention)
	}
	if !regexp.MustCompile(`^A-[0-9]{4,}$`).MatchString(updated.DisplayID) || updated.MaterialTypeCode != f.code {
		t.Fatalf("display id or code: %q %q", updated.DisplayID, updated.MaterialTypeCode)
	}
}

func TestMaterialRecycleBinRestoreAndPurge(t *testing.T) {
	f := newSpoolFixture(t)
	ctx := t.Context()
	m := f.material(t, "2000")
	spool := f.spool(t, m, "1000")
	m = f.refresh(t, m.ID)

	manager := restrictedPrincipal(t, f.pool, authorization.InventoryRead, authorization.InventoryManage)
	if err := f.s.DeleteMaterial(ctx, manager, m.ID, m.Version, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("delete without inventory.delete: %v", err)
	}
	deleter := restrictedPrincipal(t, f.pool, authorization.InventoryRead, authorization.InventoryDelete)
	if err := f.s.DeleteMaterial(ctx, deleter, m.ID, m.Version, &f.request); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.GetMaterial(ctx, f.p, m.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("deleted article still readable: %v", err)
	}
	if _, err := f.s.GetFilamentSpool(ctx, f.p, spool.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("spool of a deleted article still readable: %v", err)
	}
	bin, err := f.s.GetInventoryRecycleBin(ctx, f.p)
	if err != nil {
		t.Fatal(err)
	}
	var deleted *DeletedMaterial
	for i := range bin.Materials {
		if bin.Materials[i].ID == m.ID {
			deleted = &bin.Materials[i]
		}
	}
	if deleted == nil || deleted.SpoolCount != 1 || deleted.Quantity != "2000" || deleted.DeletedByName == nil {
		t.Fatalf("bin entry: %+v", deleted)
	}
	if _, err = f.s.RestoreMaterial(ctx, manager, m.ID, deleted.Version, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("restore without inventory.delete: %v", err)
	}
	restored, err := f.s.RestoreMaterial(ctx, deleter, m.ID, deleted.Version, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	assertStock(t, restored, "2000", "1000")
	if f.get(t, spool.ID).Lifecycle != SpoolActive {
		t.Fatal("spool did not come back with its article")
	}

	if err = f.s.PurgeMaterial(ctx, deleter, m.ID, restored.Version, &f.request); !apperror.IsCode(err, "material_not_in_bin") {
		t.Fatalf("purge of a live article: %v", err)
	}
	if err = f.s.DeleteMaterial(ctx, deleter, m.ID, restored.Version, &f.request); err != nil {
		t.Fatal(err)
	}
	if err = f.s.PurgeMaterial(ctx, manager, m.ID, restored.Version+1, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("purge without inventory.delete: %v", err)
	}
	if err = f.s.PurgeMaterial(ctx, deleter, m.ID, restored.Version+1, &f.request); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err = f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM inventory_transactions WHERE material_id = $1)
		+ (SELECT count(*) FROM filament_spools WHERE material_id = $1) + (SELECT count(*) FROM materials WHERE id = $1)`,
		m.ID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("rows left after purge: %d %v", rows, err)
	}
}

func TestLedgerEntryDeleteRestoreAndPurge(t *testing.T) {
	f := newSpoolFixture(t)
	ctx := t.Context()
	m := f.material(t, "1000")
	spool := f.spool(t, m, "600")
	f.consume(t, spool, "100")
	m = f.refresh(t, m.ID)
	var consumption, purchase uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM inventory_transactions WHERE material_id = $1 AND kind = 'manual_consumption'`, m.ID).Scan(&consumption); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT id FROM inventory_transactions WHERE material_id = $1 AND kind = 'purchase'`, m.ID).Scan(&purchase); err != nil {
		t.Fatal(err)
	}

	manager := restrictedPrincipal(t, f.pool, authorization.InventoryRead, authorization.InventoryManage, authorization.InventoryDelete)
	if err := f.s.DeleteInventoryTransaction(ctx, manager, consumption, m.InventoryVersion, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("delete without inventory.ledger.delete: %v", err)
	}
	ledger := restrictedPrincipal(t, f.pool, authorization.InventoryRead, authorization.InventoryLedgerDelete)
	if err := f.s.DeleteInventoryTransaction(ctx, ledger, consumption, m.InventoryVersion+5, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale delete: %v", err)
	}
	if err := f.s.DeleteInventoryTransaction(ctx, ledger, consumption, m.InventoryVersion, &f.request); err != nil {
		t.Fatal(err)
	}
	m = f.refresh(t, m.ID)
	assertStock(t, m, "1000", "600")
	if f.get(t, spool.ID).RemainingQuantity != "600" {
		t.Fatal("spool remainder ignores the deleted entry")
	}
	transactions, _, err := f.s.ListMaterialTransactions(ctx, f.p, m.ID, 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range transactions {
		if item.ID == consumption {
			t.Fatal("deleted entry still listed in the ledger")
		}
	}
	// The purchase cannot go: 600 g of it sit on the spool.
	if err = f.s.DeleteInventoryTransaction(ctx, ledger, purchase, m.InventoryVersion, &f.request); !apperror.IsCode(err, "insufficient_stock") &&
		!apperror.IsCode(err, "insufficient_unassigned_stock") {
		t.Fatalf("deleting stock that is used elsewhere: %v", err)
	}
	if err = f.s.RestoreInventoryTransaction(ctx, manager, consumption, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("restore without inventory.ledger.delete: %v", err)
	}
	if err = f.s.RestoreInventoryTransaction(ctx, ledger, consumption, &f.request); err != nil {
		t.Fatal(err)
	}
	assertStock(t, f.refresh(t, m.ID), "900", "500")
	if err = f.s.PurgeInventoryTransaction(ctx, ledger, consumption, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("purge of a live entry: %v", err)
	}
	if err = f.s.DeleteInventoryTransaction(ctx, ledger, consumption, f.refresh(t, m.ID).InventoryVersion, &f.request); err != nil {
		t.Fatal(err)
	}
	if err = f.s.PurgeInventoryTransaction(ctx, ledger, consumption, &f.request); err != nil {
		t.Fatal(err)
	}
	var left int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM inventory_transactions WHERE id = $1`, consumption).Scan(&left); err != nil || left != 0 {
		t.Fatalf("purged entry left: %d %v", left, err)
	}
	// The ledger stays immutable outside a purge.
	if _, err = f.pool.Exec(context.Background(), `DELETE FROM inventory_transactions WHERE id = $1`, purchase); err == nil {
		t.Fatal("ledger row deleted without a purge")
	}
}

func TestStockArticlePricesPerGroup(t *testing.T) {
	f := newSpoolFixture(t)
	ctx := t.Context()
	m := f.material(t, "")
	group, err := f.s.CreatePricingGroup(ctx, f.p, "Spool group "+f.suffix, nil, false, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = f.pool.Exec(context.Background(), `DELETE FROM pricing_groups WHERE id = $1`, group.ID) })
	if _, err = f.s.CreatePricingRule(ctx, f.p, group.ID, PricingRuleMaterial, nil, &f.typeID, nil, "0.04", &f.request); err != nil {
		t.Fatal(err)
	}
	priceIn := func(id uuid.UUID) *MaterialPrice {
		for _, price := range f.refresh(t, id).Prices {
			if price.PricingGroupID == group.ID {
				return &price
			}
		}
		return nil
	}
	if price := priceIn(m.ID); price == nil || price.Source != PriceFromMaterialType || price.Rate != "0.04" {
		t.Fatalf("type price: %+v", price)
	}
	pricingRead := restrictedPrincipal(t, f.pool, authorization.PricingRead)
	if _, err = f.s.CreateStockArticlePricingRule(ctx, pricingRead, group.ID, m.ID, "0.05", &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("stock price without pricing.manage: %v", err)
	}
	rule, err := f.s.CreateStockArticlePricingRule(ctx, f.p, group.ID, m.ID, "0.05", &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if rule.Kind != PricingRuleStockArticle || rule.MaterialID == nil || *rule.MaterialID != m.ID || rule.MaterialName == nil {
		t.Fatalf("rule: %+v", rule)
	}
	if price := priceIn(m.ID); price == nil || price.Source != PriceFromStockArticle || price.Rate != "0.05" {
		t.Fatalf("stock price: %+v", price)
	}
	if _, err = f.s.CreateStockArticlePricingRule(ctx, f.p, group.ID, m.ID, "0.06", &f.request); err == nil {
		t.Fatal("second active stock price in one group")
	}
	updated, err := f.s.UpdateStockArticlePricingRule(ctx, f.p, rule.ID, rule.Version, m.ID, "0.07", false, &f.request)
	if err != nil || updated.Active {
		t.Fatalf("update: %+v %v", updated, err)
	}
	if price := priceIn(m.ID); price == nil || price.Source != PriceFromMaterialType {
		t.Fatalf("inactive stock price must fall back to the type rate: %+v", price)
	}
}

func TestSpoolCorrectionValuesFoundFilamentAtTheSpoolCost(t *testing.T) {
	f := newSpoolFixture(t)
	ctx := t.Context()
	correct := func(spool FilamentSpool, physical string, cost *string) string {
		t.Helper()
		fresh := f.get(t, spool.ID)
		if _, err := f.s.CorrectFilamentSpoolStock(ctx, f.p, spool.ID, f.refresh(t, spool.MaterialID).InventoryVersion,
			fresh.Version, physical, cost, f.now, "inventory_count", nil, &f.request); err != nil {
			t.Fatal(err)
		}
		var unitCost string
		if err := f.pool.QueryRow(ctx, `SELECT unit_acquisition_cost::numeric::float8::text FROM inventory_transactions
			WHERE spool_id = $1 AND kind = 'adjustment' ORDER BY created_at DESC, id DESC LIMIT 1`, spool.ID).Scan(&unitCost); err != nil {
			t.Fatal(err)
		}
		return unitCost
	}

	// Existing stock without a known purchase price is booked at 0 instead of being refused.
	free := f.material(t, "")
	if _, err := f.s.AddPurchase(ctx, f.p, free.ID, free.InventoryVersion, "1000", "0", f.now, nil, nil, nil, &f.request); err != nil {
		t.Fatal(err)
	}
	legacy := f.spool(t, free, "1000")
	if got := correct(legacy, "1047", nil); got != "0" {
		t.Fatalf("legacy spool unit cost = %s, want 0", got)
	}

	// A bought spool keeps its own price although the material average differs.
	priced := f.material(t, "1000")
	total := "25"
	bought, err := f.s.CreateFilamentSpool(ctx, f.p, FilamentSpoolInput{
		MaterialID:               priced.ID,
		InitialNetWeightG:        "1000",
		StockMode:                StockModeNewAcquisition,
		TotalPrice:               &total,
		OccurredAt:               f.now,
		ExpectedInventoryVersion: f.refresh(t, priced.ID).InventoryVersion,
	}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if got := correct(bought, "1100", nil); got != "0.025" {
		t.Fatalf("bought spool unit cost = %s, want 0.025", got)
	}

	// Existing stock of a priced material falls back to the material average.
	stocked := f.spool(t, priced, "500")
	if got := correct(stocked, "550", nil); got == "0" || got == "0.025" {
		t.Fatalf("existing-stock spool unit cost = %s, want the material average", got)
	}

	// An explicit cost, including 0, wins.
	zero := "0"
	if got := correct(bought, "1150", &zero); got != "0" {
		t.Fatalf("explicit unit cost = %s, want 0", got)
	}
}
