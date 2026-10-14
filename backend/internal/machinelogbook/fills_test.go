package machinelogbook

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// fillsClock sits far from real data so cleanup cutoffs only see these tests.
var fillsClock = time.Date(2032, time.May, 10, 12, 0, 0, 0, time.UTC)

type fillFixture struct {
	pool    *pgxpool.Pool
	s       *Service
	p       authorization.Principal
	request uuid.UUID
	now     time.Time
	suffix  string
	counter int
}

func newFillFixture(t *testing.T) *fillFixture {
	t.Helper()
	pool := integrationPool(t)
	ctx := t.Context()
	person, account := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	f := &fillFixture{pool: pool, request: uuid.Must(uuid.NewV7()), now: fillsClock, suffix: strings.ReplaceAll(person.String(), "-", "")[:12]}
	f.s = NewService(pool, WithClock(func() time.Time { return f.now }))
	f.p = authorization.Principal{AccountID: account, PersonID: person, Master: true}
	if _, err := pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Fill', 'Tester', $2)`, person, "fills-"+f.suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, account, person); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = pool.Exec(cleanup, `DELETE FROM audit_events WHERE request_id = $1`, f.request)
		_, _ = pool.Exec(cleanup, `DELETE FROM accounts WHERE id = $1`, account)
		_, _ = pool.Exec(cleanup, `DELETE FROM people WHERE id = $1`, person)
	})
	return f
}

func (f *fillFixture) unique(prefix string) string {
	f.counter++
	return fmt.Sprintf("%s %s %d", prefix, f.suffix, f.counter)
}

// material creates a filament material that holds the given loose stock.
func (f *fillFixture) material(t *testing.T, stock string) Material {
	t.Helper()
	diameter := "1.75"
	m, err := f.s.CreateMaterialWithFilament(t.Context(), f.p, f.unique("Fill PLA"), "pla", nil, "g", nil, &diameter, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if stock != "" {
		m = f.purchase(t, m, stock, "20")
	}
	return m
}

func (f *fillFixture) purchase(t *testing.T, m Material, quantity, total string) Material {
	t.Helper()
	result, err := f.s.AddPurchase(t.Context(), f.p, m.ID, f.refresh(t, m).InventoryVersion, quantity, total, f.now, nil, nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return result.Material
}

func (f *fillFixture) refresh(t *testing.T, m Material) Material {
	t.Helper()
	fresh, err := f.s.GetMaterial(t.Context(), f.p, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	return fresh
}

func (f *fillFixture) spoolInput(m Material, kind, weight string) FilamentSpoolInput {
	tare := "200"
	return FilamentSpoolInput{Kind: kind, Label: f.unique("Label"), MaterialID: m.ID, InitialNetWeightG: weight, StockMode: "existing_stock", TareWeightG: &tare, OccurredAt: f.now, ExpectedInventoryVersion: f.refresh2(m)}
}

func (f *fillFixture) refresh2(m Material) int64 {
	fresh, err := f.s.GetMaterial(context.Background(), f.p, m.ID)
	if err != nil {
		panic(err)
	}
	return fresh.InventoryVersion
}

// spool creates a spool whose first fill takes weight grams from loose stock.
func (f *fillFixture) spool(t *testing.T, m Material, kind, weight string) FilamentSpool {
	t.Helper()
	spool, err := f.s.CreateFilamentSpool(t.Context(), f.p, f.spoolInput(m, kind, weight), &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return spool
}

// purchasedSpool creates a spool whose fill is bought, so its ledger has no transfer rows.
func (f *fillFixture) purchasedSpool(t *testing.T, m Material, kind, weight string) FilamentSpool {
	t.Helper()
	input := f.spoolInput(m, kind, weight)
	input.StockMode, input.TotalPrice = "new_acquisition", ptr("10")
	spool, err := f.s.CreateFilamentSpool(t.Context(), f.p, input, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return spool
}

func (f *fillFixture) get(t *testing.T, id uuid.UUID) FilamentSpool {
	t.Helper()
	spool, err := f.s.GetFilamentSpool(t.Context(), f.p, id)
	if err != nil {
		t.Fatal(err)
	}
	return spool
}

func (f *fillFixture) consume(t *testing.T, spool FilamentSpool, m Material, quantity string) {
	t.Helper()
	fresh := f.get(t, spool.ID)
	if _, err := f.s.ConsumeFilamentSpool(t.Context(), f.p, spool.ID, f.refresh(t, m).InventoryVersion, fresh.Version, quantity, f.now, false, nil, nil, &f.request); err != nil {
		t.Fatal(err)
	}
}

func (f *fillFixture) newFill(m Material, weight string) NewFillInput {
	return NewFillInput{MaterialID: m.ID, NetWeightG: weight, Source: "loose_stock"}
}

func (f *fillFixture) change(t *testing.T, spoolID uuid.UUID, leftover *LeftoverInput, fill NewFillInput) (FilamentSpool, error) {
	t.Helper()
	current := f.get(t, spoolID)
	return f.s.ChangeFilamentSpoolFill(t.Context(), f.p, spoolID, ChangeFillInput{Leftover: leftover, Fill: fill, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: current.Version}, &f.request)
}

type ledgerLine struct {
	kind, reason, delta, transfer                string
	spoolID, fillID                              *uuid.UUID
	display, fromDisplay, toDisplay              *string
	fillNumber, fromFill, toFill                 *int32
	fromSpoolID, toSpoolID, fromFillID, toFillID *uuid.UUID
}

func (f *fillFixture) ledger(t *testing.T, materialID uuid.UUID) []ledgerLine {
	t.Helper()
	rows, err := f.pool.Query(t.Context(), `SELECT kind, COALESCE(adjustment_reason, ''), quantity_delta::text, COALESCE(transfer_quantity::text, ''), spool_id, fill_id,
		spool_display_id, fill_number, from_spool_id, from_fill_id, from_spool_display_id, from_fill_number, to_spool_id, to_fill_id, to_spool_display_id, to_fill_number
		FROM inventory_transactions WHERE material_id = $1 ORDER BY created_at, id`, materialID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var lines []ledgerLine
	for rows.Next() {
		var l ledgerLine
		if err = rows.Scan(&l.kind, &l.reason, &l.delta, &l.transfer, &l.spoolID, &l.fillID, &l.display, &l.fillNumber, &l.fromSpoolID, &l.fromFillID, &l.fromDisplay, &l.fromFill, &l.toSpoolID, &l.toFillID, &l.toDisplay, &l.toFill); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, l)
	}
	return lines
}

func norm(value string) string {
	if value == "" {
		return ""
	}
	return decimal.RequireFromString(value).String()
}

func place(display *string, fill *int32) string {
	if display == nil {
		return "loose"
	}
	return fmt.Sprintf("%s#%d", *display, *fill)
}

// String summarizes a ledger row: "kind[/reason] delta place" or "transfer qty from->to".
func (l ledgerLine) String() string {
	if l.kind == "spool_transfer" {
		return fmt.Sprintf("transfer %s %s->%s", norm(l.transfer), place(l.fromDisplay, l.fromFill), place(l.toDisplay, l.toFill))
	}
	reason := ""
	if l.reason != "" {
		reason = "/" + l.reason
	}
	return fmt.Sprintf("%s%s %s %s", l.kind, reason, norm(l.delta), place(l.display, l.fillNumber))
}

func summarize(lines []ledgerLine) []string {
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, l.String())
	}
	return out
}

func assertLines(t *testing.T, got []ledgerLine, from int, want ...string) {
	t.Helper()
	if len(got) < from {
		t.Fatalf("ledger has %d rows, want at least %d", len(got), from)
	}
	have := summarize(got[from:])
	if strings.Join(have, "\n") != strings.Join(want, "\n") {
		t.Fatalf("ledger rows\n got: %q\nwant: %q", have, want)
	}
}

func assertMaterial(t *testing.T, m Material, quantity, assigned, unassigned string) {
	t.Helper()
	if m.Quantity != quantity || m.AssignedQuantity != assigned || m.UnassignedQuantity != unassigned {
		t.Fatalf("material quantity/assigned/unassigned = %s/%s/%s, want %s/%s/%s", m.Quantity, m.AssignedQuantity, m.UnassignedQuantity, quantity, assigned, unassigned)
	}
}

func TestNewSpoolHasFillOneAndKeepsMaterialTotals(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "2000")
	assertMaterial(t, f.refresh(t, m), "2000", "0", "2000")
	spool := f.spool(t, m, "", "1000")
	if spool.Kind != "single_use" || spool.Status != "active" || spool.FillNumber != 1 || spool.FillID == nil || spool.RemainingQuantity != "1000" || spool.InitialNetWeightG == nil || *spool.InitialNetWeightG != "1000" || spool.MaterialID == nil || *spool.MaterialID != m.ID {
		t.Fatalf("new spool: %+v", spool)
	}
	assertMaterial(t, f.refresh(t, m), "2000", "1000", "1000")
	f.consume(t, spool, m, "250")
	spool = f.get(t, spool.ID)
	if spool.RemainingQuantity != "750" || len(spool.Fills) != 0 {
		t.Fatalf("after consumption: %+v", spool)
	}
	assertMaterial(t, f.refresh(t, m), "1750", "750", "1000")
	lines := f.ledger(t, m.ID)
	assertLines(t, lines, 1, fmt.Sprintf("transfer 1000 loose->%s#1", spool.DisplayID), fmt.Sprintf("manual_consumption -250 %s#1", spool.DisplayID))

	// A new acquisition buys the fill: stock grows by the fill weight.
	total := "30"
	input := f.spoolInput(m, "reusable", "500")
	input.StockMode, input.TotalPrice = "new_acquisition", &total
	bought, err := f.s.CreateFilamentSpool(t.Context(), f.p, input, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if bought.Kind != "reusable" || bought.Status != "loaded" || bought.RemainingQuantity != "500" {
		t.Fatalf("bought spool: %+v", bought)
	}
	assertMaterial(t, f.refresh(t, m), "2250", "1250", "1000")
}

func TestChangeFilamentLeftoverBasisAndDisposition(t *testing.T) {
	tests := []struct {
		name         string
		leftover     LeftoverInput
		wantClosing  func(display string) []string
		wantOutcome  string
		wantLeftover string
		wantTotal    string // material total after the change
	}{
		{"system returned to stock", LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")},
			func(d string) []string { return []string{fmt.Sprintf("transfer 600 %s#1->loose", d)} }, "returned_to_stock", "600", "1600"},
		{"system disposed", LeftoverInput{Basis: "system", Disposition: ptr("disposed")},
			func(d string) []string { return []string{fmt.Sprintf("disposal/disposed -600 %s#1", d)} }, "disposed", "600", "1000"},
		{"weighed below system returned", LeftoverInput{Basis: "weighed", GrossWeightG: ptr("700"), Disposition: ptr("returned_to_stock")},
			func(d string) []string {
				return []string{fmt.Sprintf("adjustment/inventory_count -100 %s#1", d), fmt.Sprintf("transfer 500 %s#1->loose", d)}
			}, "returned_to_stock", "500", "1500"},
		{"weighed above system disposed", LeftoverInput{Basis: "weighed", GrossWeightG: ptr("900"), Disposition: ptr("disposed")},
			func(d string) []string {
				return []string{fmt.Sprintf("adjustment/inventory_count 100 %s#1", d), fmt.Sprintf("disposal/disposed -700 %s#1", d)}
			}, "disposed", "700", "1000"},
		{"none writes the rest off", LeftoverInput{Basis: "none"},
			func(d string) []string { return []string{fmt.Sprintf("adjustment/mark_empty -600 %s#1", d)} }, "used_up", "0", "1000"},
		{"weighed below tare clamps to used up", LeftoverInput{Basis: "weighed", GrossWeightG: ptr("150")},
			func(d string) []string { return []string{fmt.Sprintf("adjustment/inventory_count -600 %s#1", d)} }, "used_up", "0", "1000"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			f := newFillFixture(t)
			m := f.material(t, "2000")
			spool := f.spool(t, m, "reusable", "1000")
			f.consume(t, spool, m, "400")
			before := len(f.ledger(t, m.ID))
			changed, err := f.change(t, spool.ID, &test.leftover, f.newFill(m, "300"))
			if err != nil {
				t.Fatal(err)
			}
			if changed.FillNumber != 2 || changed.Status != "loaded" || changed.RemainingQuantity != "300" || changed.InitialNetWeightG == nil || *changed.InitialNetWeightG != "300" {
				t.Fatalf("changed spool: %+v", changed)
			}
			want := append(test.wantClosing(spool.DisplayID), fmt.Sprintf("transfer 300 loose->%s#2", spool.DisplayID))
			assertLines(t, f.ledger(t, m.ID), before, want...)
			loose := decimal.RequireFromString(test.wantTotal).Sub(decimal.NewFromInt(300))
			assertMaterial(t, f.refresh(t, m), test.wantTotal, "300", loose.String())
			history := f.get(t, spool.ID).Fills
			if len(history) != 1 || history[0].FillNumber != 1 || history[0].Outcome != test.wantOutcome || history[0].LeftoverG != test.wantLeftover || history[0].UsedG != "400" || history[0].InitialNetWeightG != "1000" {
				t.Fatalf("fill history: %+v", history)
			}
			if changed.Version != spool.Version+2 && changed.Version <= spool.Version {
				t.Fatalf("spool version did not advance: %d -> %d", spool.Version, changed.Version)
			}
		})
	}
}

func TestChangeFilamentToAnotherMaterialMovesOnlyThroughLedgerRows(t *testing.T) {
	f := newFillFixture(t)
	oldMaterial := f.material(t, "1000")
	newMaterial := f.material(t, "800")
	spool := f.spool(t, oldMaterial, "reusable", "500")
	changed, err := f.change(t, spool.ID, &LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}, f.newFill(newMaterial, "400"))
	if err != nil {
		t.Fatal(err)
	}
	if changed.MaterialID == nil || *changed.MaterialID != newMaterial.ID || changed.FillNumber != 2 {
		t.Fatalf("changed spool: %+v", changed)
	}
	assertMaterial(t, f.refresh(t, oldMaterial), "1000", "0", "1000")
	assertMaterial(t, f.refresh(t, newMaterial), "800", "400", "400")
	history := f.get(t, spool.ID).Fills
	if len(history) != 1 || history[0].MaterialID != oldMaterial.ID {
		t.Fatalf("history: %+v", history)
	}
}

func TestChangeFilamentValidationAndPurchase(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "1000")
	spool := f.spool(t, m, "reusable", "600")
	ctx := t.Context()
	leftover := &LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}

	expectNoChange := func(label string, err error, code string) {
		t.Helper()
		if !apperror.IsCode(err, code) {
			t.Fatalf("%s: got %v, want %s", label, err, code)
		}
		fresh := f.get(t, spool.ID)
		if fresh.FillNumber != 1 || fresh.RemainingQuantity != "600" || fresh.Version != spool.Version {
			t.Fatalf("%s changed the spool: %+v", label, fresh)
		}
		assertMaterial(t, f.refresh(t, m), "1000", "600", "400")
	}
	// Returned leftover is loose again, so 1000 is available but 1001 is not.
	_, err := f.change(t, spool.ID, leftover, f.newFill(m, "1001"))
	expectNoChange("insufficient loose stock", err, "insufficient_loose_stock")
	_, err = f.change(t, spool.ID, nil, f.newFill(m, "10"))
	expectNoChange("leftover required", err, "leftover_required")
	_, err = f.change(t, spool.ID, &LeftoverInput{Basis: "system"}, f.newFill(m, "10"))
	expectNoChange("disposition required", err, "disposition_required")
	_, err = f.change(t, spool.ID, &LeftoverInput{Basis: "weighed", GrossWeightG: ptr("500"), Disposition: ptr("disposed")}, f.newFill(m, "10"))
	if err != nil {
		t.Fatalf("weighed leftover with tare: %v", err)
	}

	// A purchase needs a price and adds stock instead of moving loose stock.
	purchaseFill := NewFillInput{MaterialID: m.ID, NetWeightG: "250", Source: "purchase", Supplier: ptr("Filament Shop")}
	current := f.get(t, spool.ID)
	_, err = f.s.ChangeFilamentSpoolFill(ctx, f.p, spool.ID, ChangeFillInput{Leftover: &LeftoverInput{Basis: "none"}, Fill: purchaseFill, OccurredAt: f.now.Add(2 * time.Hour), ExpectedVersion: current.Version}, &f.request)
	if !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("purchase without price: %v", err)
	}
	before := len(f.ledger(t, m.ID))
	purchaseFill.TotalPrice = ptr("12.5")
	bought, err := f.s.ChangeFilamentSpoolFill(ctx, f.p, spool.ID, ChangeFillInput{Leftover: &LeftoverInput{Basis: "none"}, Fill: purchaseFill, OccurredAt: f.now.Add(2 * time.Hour), ExpectedVersion: current.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if bought.FillNumber != 3 || bought.RemainingQuantity != "250" {
		t.Fatalf("bought fill: %+v", bought)
	}
	lines := f.ledger(t, m.ID)
	assertLines(t, lines, before, fmt.Sprintf("adjustment/mark_empty -10 %s#2", spool.DisplayID), fmt.Sprintf("purchase 250 %s#3", spool.DisplayID))
	var supplier string
	var price string
	if err = f.pool.QueryRow(ctx, `SELECT supplier, total_purchase_price::text FROM inventory_transactions WHERE id = (SELECT id FROM inventory_transactions WHERE material_id = $1 AND kind = 'purchase' AND fill_number = 3)`, m.ID).Scan(&supplier, &price); err != nil || supplier != "Filament Shop" || norm(price) != "12.5" {
		t.Fatalf("purchase row supplier=%q price=%q err=%v", supplier, price, err)
	}
	assertMaterial(t, f.refresh(t, m), "640", "250", "390")

	// A spool that needs a refill takes a new fill without any leftover.
	finished, err := f.s.FinishFilamentSpool(ctx, f.p, spool.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "none"}, OccurredAt: f.now.Add(3 * time.Hour), ExpectedVersion: bought.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != "needs_refill" || finished.FillID != nil || finished.MaterialID != nil || finished.RemainingQuantity != "0" || finished.FillNumber != 3 || finished.Lifecycle != "active" {
		t.Fatalf("finished reusable spool: %+v", finished)
	}
	_, err = f.s.ChangeFilamentSpoolFill(ctx, f.p, spool.ID, ChangeFillInput{Leftover: leftover, Fill: f.newFill(m, "100"), OccurredAt: f.now.Add(4 * time.Hour), ExpectedVersion: finished.Version}, &f.request)
	if !apperror.IsCode(err, "leftover_not_allowed") {
		t.Fatalf("leftover on a spool without fill: %v", err)
	}
	refilled, err := f.s.ChangeFilamentSpoolFill(ctx, f.p, spool.ID, ChangeFillInput{Fill: f.newFill(m, "100"), OccurredAt: f.now.Add(4 * time.Hour), ExpectedVersion: finished.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if refilled.FillNumber != 4 || refilled.Status != "loaded" || refilled.RemainingQuantity != "100" {
		t.Fatalf("refilled spool: %+v", refilled)
	}
	if got := len(f.get(t, spool.ID).Fills); got != 3 {
		t.Fatalf("closed fills = %d", got)
	}
}

func TestChangeFilamentProductRules(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "1000")
	other := f.material(t, "")
	ctx := t.Context()
	product, err := f.s.CreateFilamentProduct(ctx, f.p, FilamentProductInput{Manufacturer: "Prusa " + f.suffix, Name: "PLA Galaxy", MaterialID: m.ID, NetWeightG: "1000", DefaultPrice: ptr("19.9"), Packaging: "refill", Active: true}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	spool := f.spool(t, m, "reusable", "200")
	leftover := &LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}

	fill := f.newFill(m, "100")
	fill.ProductID = &product.ID
	changed, err := f.change(t, spool.ID, leftover, fill)
	if err != nil {
		t.Fatal(err)
	}
	if changed.ProductID == nil || *changed.ProductID != product.ID || changed.Manufacturer == nil || *changed.Manufacturer != product.Manufacturer || changed.ProductName == nil || *changed.ProductName != "PLA Galaxy" {
		t.Fatalf("product snapshot not defaulted: %+v", changed)
	}
	count := func() int64 {
		p, err := f.s.GetFilamentProduct(ctx, f.p, product.ID)
		if err != nil {
			t.Fatal(err)
		}
		return p.InUseCount
	}
	if count() != 1 {
		t.Fatalf("inUseCount = %d", count())
	}

	// Editing the product never touches the fill's snapshot.
	edited, err := f.s.UpdateFilamentProduct(ctx, f.p, product.ID, FilamentProductInput{Manufacturer: product.Manufacturer, Name: "PLA Galaxy 2", MaterialID: m.ID, NetWeightG: "1000", Packaging: "refill", Active: true, ExpectedVersion: product.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if after := f.get(t, spool.ID); after.ProductName == nil || *after.ProductName != "PLA Galaxy" {
		t.Fatalf("product edit leaked into the fill: %+v", after)
	}

	// Material mismatch, unknown and inactive products are refused without side effects.
	mismatch := f.newFill(other, "50")
	mismatch.ProductID = &product.ID
	if _, err = f.change(t, spool.ID, leftover, mismatch); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("material mismatch: %v", err)
	}
	unknown := f.newFill(m, "50")
	unknown.ProductID = ptr(uuid.Must(uuid.NewV7()))
	if _, err = f.change(t, spool.ID, leftover, unknown); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("unknown product: %v", err)
	}
	if _, err = f.s.UpdateFilamentProduct(ctx, f.p, product.ID, FilamentProductInput{Manufacturer: product.Manufacturer, Name: "PLA Galaxy 2", MaterialID: m.ID, NetWeightG: "1000", Packaging: "refill", Active: false, ExpectedVersion: edited.Version}, &f.request); err != nil {
		t.Fatal(err)
	}
	inactive := f.newFill(m, "50")
	inactive.ProductID = &product.ID
	if _, err = f.change(t, spool.ID, leftover, inactive); !apperror.IsCode(err, "product_inactive") {
		t.Fatalf("inactive product: %v", err)
	}
	if got := f.get(t, spool.ID); got.FillNumber != 2 {
		t.Fatalf("refused changes created fills: %+v", got)
	}

	// Explicit manufacturer and product name win over the product defaults.
	other2 := f.material(t, "")
	plain := f.newFill(other2, "20")
	plain.Manufacturer, plain.ProductName = ptr("Handmade"), ptr("Spooled by hand")
	purchase := plain
	purchase.Source, purchase.TotalPrice = "purchase", ptr("5")
	again, err := f.change(t, spool.ID, leftover, purchase)
	if err != nil {
		t.Fatal(err)
	}
	if again.Manufacturer == nil || *again.Manufacturer != "Handmade" || again.ProductID != nil {
		t.Fatalf("manual fill: %+v", again)
	}
}

func TestChangeFilamentIdentifiers(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "2000")
	ctx := t.Context()
	spool := f.spool(t, m, "reusable", "300")
	stranger := f.spool(t, m, "reusable", "300")
	tag := func(kind string) string { return strings.ToUpper(kind) + "-" + f.suffix }
	add := func(id uuid.UUID, kind string) FilamentSpoolIdentifier {
		t.Helper()
		identifier, err := f.s.AddFilamentSpoolIdentifier(ctx, f.p, id, kind, tag(kind), &f.request)
		if err != nil {
			t.Fatal(err)
		}
		return identifier
	}
	nfc := add(spool.ID, "nfc")
	barcode := add(spool.ID, "barcode")
	foreign, err := f.s.AddFilamentSpoolIdentifier(ctx, f.p, stranger.ID, "qr", "QR-"+f.suffix, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	leftover := &LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}
	run := func(keep []uuid.UUID, fresh []NewSpoolIdentifier) (FilamentSpool, error) {
		current := f.get(t, spool.ID)
		return f.s.ChangeFilamentSpoolFill(ctx, f.p, spool.ID, ChangeFillInput{Leftover: leftover, Fill: f.newFill(m, "100"), KeepIdentifierIDs: keep, NewIdentifiers: fresh, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: current.Version}, &f.request)
	}

	// Clashes and foreign identifiers roll everything back.
	if _, err = run(nil, []NewSpoolIdentifier{{Kind: "qr", Value: "qr-" + f.suffix}}); !apperror.IsCode(err, "identifier_in_use") {
		t.Fatalf("clash with another spool: %v", err)
	}
	if _, err = run([]uuid.UUID{foreign.ID}, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("keeping a foreign identifier: %v", err)
	}
	if _, err = run([]uuid.UUID{nfc.ID}, []NewSpoolIdentifier{{Kind: "nfc", Value: tag("nfc")}}); !apperror.IsCode(err, "identifier_in_use") {
		t.Fatalf("keeping and adding the same tag: %v", err)
	}
	if untouched := f.get(t, spool.ID); untouched.FillNumber != 1 || len(untouched.Identifiers) != 2 || untouched.RemainingQuantity != "300" {
		t.Fatalf("failed changes were not rolled back: %+v", untouched)
	}

	// The kept tag is re-inserted for the new fill, the other one is retired.
	changed, err := run([]uuid.UUID{nfc.ID}, []NewSpoolIdentifier{{Kind: "qr", Value: "NEW-" + f.suffix}})
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]bool{}
	for _, identifier := range changed.Identifiers {
		values[identifier.Kind+":"+identifier.Value] = true
		if identifier.ID == nfc.ID {
			t.Fatal("kept identifier was not re-inserted for the new fill")
		}
	}
	if len(values) != 2 || !values["nfc:"+tag("nfc")] || !values["qr:NEW-"+f.suffix] {
		t.Fatalf("identifiers after change: %+v", changed.Identifiers)
	}
	found, err := f.s.LookupFilamentSpool(ctx, f.p, "nfc", tag("nfc"))
	if err != nil || found.ID != spool.ID || found.FillNumber != 2 {
		t.Fatalf("lookup of kept tag: %+v %v", found, err)
	}
	if _, err = f.s.LookupFilamentSpool(ctx, f.p, "barcode", tag("barcode")); !apperror.IsCode(err, "not_found") {
		t.Fatalf("retired tag still resolves: %v", err)
	}
	history := f.get(t, spool.ID).Fills
	if len(history) != 1 || len(history[0].Identifiers) != 2 {
		t.Fatalf("fill 1 keeps its retired tags: %+v", history)
	}
	// A retired tag is free again; the kept tag is not.
	if _, err = f.s.AddFilamentSpoolIdentifier(ctx, f.p, stranger.ID, "barcode", tag("barcode"), &f.request); err != nil {
		t.Fatalf("reusing a retired tag: %v", err)
	}
	if _, err = f.s.AddFilamentSpoolIdentifier(ctx, f.p, stranger.ID, "nfc", tag("nfc"), &f.request); err == nil {
		t.Fatal("an unretired tag was assigned twice")
	}
	_ = barcode
}

func TestChangeFilamentRefusalsAndPermissions(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "2000")
	ctx := t.Context()
	leftover := &LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}

	single := f.spool(t, m, "single_use", "100")
	if _, err := f.change(t, single.ID, leftover, f.newFill(m, "50")); !apperror.IsCode(err, "spool_not_reusable") {
		t.Fatalf("single-use spool: %v", err)
	}

	archived := f.spool(t, m, "reusable", "100")
	archived, err := f.s.FinishFilamentSpool(ctx, f.p, archived.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: archived.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	update := FilamentSpoolUpdate{ExpectedVersion: archived.Version, Lifecycle: "archived"}
	if archived, err = f.s.UpdateFilamentSpool(ctx, f.p, archived.ID, update, &f.request); err != nil {
		t.Fatal(err)
	}
	if archived.Status != "archived" || archived.ArchivedAt == nil {
		t.Fatalf("archived reusable spool: %+v", archived)
	}
	if _, err = f.change(t, archived.ID, nil, f.newFill(m, "50")); !apperror.IsCode(err, "spool_archived") {
		t.Fatalf("archived spool: %v", err)
	}

	spool := f.spool(t, m, "reusable", "100")
	if _, err = f.s.ChangeFilamentSpoolFill(ctx, f.p, spool.ID, ChangeFillInput{Leftover: leftover, Fill: f.newFill(m, "50"), OccurredAt: f.now.Add(time.Hour), ExpectedVersion: spool.Version + 5}, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale version: %v", err)
	}
	if _, err = f.s.ChangeFilamentSpoolFill(ctx, f.p, spool.ID, ChangeFillInput{Leftover: leftover, Fill: f.newFill(m, "50"), OccurredAt: f.now.Add(-100 * 24 * time.Hour), ExpectedVersion: spool.Version}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("change before the fill started: %v", err)
	}

	input := ChangeFillInput{Leftover: leftover, Fill: f.newFill(m, "50"), OccurredAt: f.now.Add(time.Hour), ExpectedVersion: spool.Version}
	finishInput := FinishSpoolInput{Leftover: LeftoverInput{Basis: "none"}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: spool.Version}
	for name, permissions := range map[string][]authorization.Permission{
		"spools only":     {authorization.FilamentSpoolsManage},
		"inventory only":  {authorization.InventoryManage},
		"read only":       {authorization.InventoryRead},
		"no permissions":  {},
		"spools and read": {authorization.FilamentSpoolsManage, authorization.InventoryRead},
	} {
		denied := restrictedPrincipal(t, f.pool, permissions...)
		if _, err = f.s.ChangeFilamentSpoolFill(ctx, denied, spool.ID, input, nil); !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("change fill with %s: %v", name, err)
		}
		if _, err = f.s.FinishFilamentSpool(ctx, denied, spool.ID, finishInput, nil); !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("finish with %s: %v", name, err)
		}
		if _, _, err = f.s.CleanUpFilamentSpools(ctx, denied, 3, true, nil, nil); !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("cleanup with %s: %v", name, err)
		}
	}
	allowed := restrictedPrincipal(t, f.pool, authorization.FilamentSpoolsManage, authorization.InventoryManage)
	if _, err = f.s.ChangeFilamentSpoolFill(ctx, allowed, spool.ID, input, &f.request); err != nil {
		t.Fatalf("change fill with both permissions: %v", err)
	}
	if _, _, err = f.s.CleanUpFilamentSpools(ctx, allowed, 3, true, nil, &f.request); err != nil {
		t.Fatalf("cleanup dry run with both permissions: %v", err)
	}
}

func TestFinishFilamentSpool(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "2000")
	ctx := t.Context()

	mount := func(spool FilamentSpool) {
		t.Helper()
		typ, err := f.s.CreateMachineType(ctx, f.p, f.unique("Finish type"), false, &f.request)
		if err != nil {
			t.Fatal(err)
		}
		machine, err := f.s.CreateMachine(ctx, f.p, typ.ID, f.unique("Finish machine"), "active", nil, false, &f.request)
		if err != nil {
			t.Fatal(err)
		}
		unit, slot := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
		for _, step := range []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO printer_profiles (machine_id) VALUES ($1)`, []any{machine.ID}},
			{`INSERT INTO printer_input_units (id, machine_id, name, position) VALUES ($1, $2, 'Unit', 0)`, []any{unit, machine.ID}},
			{`INSERT INTO printer_slots (id, input_unit_id, name, position) VALUES ($1, $2, 'Slot', 0)`, []any{slot, unit}},
			{`INSERT INTO printer_spool_assignments (id, slot_id, spool_id, mounted_at, source) VALUES ($1, $2, $3, $4, 'manual')`, []any{uuid.Must(uuid.NewV7()), slot, spool.ID, f.now.Add(-time.Hour)}},
		} {
			if _, err = f.pool.Exec(ctx, step.sql, step.args...); err != nil {
				t.Fatal(err)
			}
		}
	}

	single := f.spool(t, m, "single_use", "400")
	single = f.get(t, single.ID)
	mount(single)
	if !f.get(t, single.ID).Mounted {
		t.Fatal("spool is not mounted")
	}
	finished, err := f.s.FinishFilamentSpool(ctx, f.p, single.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: single.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != "archived" || finished.Lifecycle != "archived" || finished.ArchivedAt == nil || !finished.ArchivedAt.Equal(f.now) || finished.Mounted || finished.FillID != nil || finished.RemainingQuantity != "0" {
		t.Fatalf("finished single-use spool: %+v", finished)
	}
	assertMaterial(t, f.refresh(t, m), "2000", "0", "2000")
	if _, err = f.s.FinishFilamentSpool(ctx, f.p, single.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "none"}, OccurredAt: f.now.Add(2 * time.Hour), ExpectedVersion: finished.Version}, &f.request); !apperror.IsCode(err, "no_open_fill") {
		t.Fatalf("finishing twice: %v", err)
	}

	reusable := f.spool(t, m, "reusable", "400")
	mount(reusable)
	f.consume(t, reusable, m, "100")
	reusable = f.get(t, reusable.ID)
	if _, err = f.s.FinishFilamentSpool(ctx, f.p, reusable.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "weighed", GrossWeightG: ptr("500")}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: reusable.Version}, &f.request); !apperror.IsCode(err, "disposition_required") {
		t.Fatalf("leftover without disposition: %v", err)
	}
	noTare := f.spoolInput(m, "reusable", "100")
	noTare.TareWeightG = nil
	untared, err := f.s.CreateFilamentSpool(ctx, f.p, noTare, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.FinishFilamentSpool(ctx, f.p, untared.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "weighed", GrossWeightG: ptr("500"), Disposition: ptr("disposed")}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: untared.Version}, &f.request); !apperror.IsCode(err, "tare_required") {
		t.Fatalf("weighing without tare: %v", err)
	}
	waiting, err := f.s.FinishFilamentSpool(ctx, f.p, reusable.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "weighed", GrossWeightG: ptr("450"), Disposition: ptr("disposed")}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: reusable.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if waiting.Status != "needs_refill" || waiting.Lifecycle != "active" || waiting.Mounted || waiting.ArchivedAt != nil {
		t.Fatalf("finished reusable spool: %+v", waiting)
	}
	history := f.get(t, reusable.ID).Fills
	if len(history) != 1 || history[0].LeftoverG != "250" || history[0].Outcome != "disposed" || history[0].UsedG != "100" {
		t.Fatalf("history: %+v", history)
	}
	// Spool-level stock movements are refused without an open fill.
	if _, err = f.s.ConsumeFilamentSpool(ctx, f.p, reusable.ID, f.refresh(t, m).InventoryVersion, waiting.Version, "1", f.now, false, nil, nil, &f.request); !apperror.IsCode(err, "spool_not_consumable") {
		t.Fatalf("consume without fill: %v", err)
	}
}

func TestSpoolMovementsRequireAnOpenFill(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "1000")
	ctx := t.Context()
	healthy := f.spool(t, m, "reusable", "300")
	empty := f.spool(t, m, "reusable", "300")
	empty, err := f.s.FinishFilamentSpool(ctx, f.p, empty.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: empty.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	version := f.refresh(t, m).InventoryVersion
	if _, err = f.s.CorrectFilamentSpoolStock(ctx, f.p, empty.ID, version, empty.Version, "10", nil, f.now, "inventory_count", nil, &f.request); !apperror.IsCode(err, "spool_not_consumable") {
		t.Fatalf("correct without fill: %v", err)
	}
	if _, err = f.s.TransferSpoolStock(ctx, f.p, m.ID, version, nil, &empty.ID, "10", f.now, nil, &f.request); !apperror.IsCode(err, "spool_not_consumable") {
		t.Fatalf("transfer to a spool without fill: %v", err)
	}
	if _, err = f.s.TransferSpoolStock(ctx, f.p, m.ID, version, &empty.ID, nil, "10", f.now, nil, &f.request); !apperror.IsCode(err, "spool_not_consumable") {
		t.Fatalf("transfer from a spool without fill: %v", err)
	}
	// Transfers, corrections and consumption work against the open fill and carry snapshots.
	tx, err := f.s.TransferSpoolStock(ctx, f.p, m.ID, version, nil, &healthy.ID, "50", f.now, nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if tx.ToSpoolDisplayID == nil || *tx.ToSpoolDisplayID != healthy.DisplayID || tx.ToFillNumber == nil || *tx.ToFillNumber != 1 || tx.FromSpoolID != nil {
		t.Fatalf("transfer snapshots: %+v", tx)
	}
	current := f.get(t, healthy.ID)
	corrected, err := f.s.CorrectFilamentSpoolStock(ctx, f.p, healthy.ID, f.refresh(t, m).InventoryVersion, current.Version, "320", nil, f.now, "inventory_count", nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if corrected.Transaction.SpoolDisplayID == nil || *corrected.Transaction.SpoolDisplayID != healthy.DisplayID || corrected.Transaction.FillNumber == nil || *corrected.Transaction.FillNumber != 1 || corrected.Transaction.QuantityDelta != "-30" {
		t.Fatalf("correction: %+v", corrected.Transaction)
	}
	// The spool's own history includes transfers.
	items, total, err := f.s.ListFilamentSpoolTransactions(ctx, f.p, healthy.ID, 1, 25)
	if err != nil || total != 3 || len(items) != 3 {
		t.Fatalf("spool transactions total=%d err=%v", total, err)
	}
	for _, item := range items {
		if item.SpoolDisplayID == nil && item.ToSpoolDisplayID == nil {
			t.Fatalf("transaction without snapshot: %+v", item)
		}
	}
}

func TestSpoolListFiltersAndStatus(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "2000")
	ctx := t.Context()
	reusable := f.spool(t, m, "reusable", "100")
	single := f.spool(t, m, "single_use", "100")
	waiting := f.spool(t, m, "reusable", "100")
	waiting, err := f.s.FinishFilamentSpool(ctx, f.p, waiting.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "none"}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: waiting.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	gone := f.spool(t, m, "single_use", "100")
	if _, err = f.s.FinishFilamentSpool(ctx, f.p, gone.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "none"}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: gone.Version}, &f.request); err != nil {
		t.Fatal(err)
	}
	ids := func(filters SpoolFilters) map[uuid.UUID]bool {
		t.Helper()
		filters.Page, filters.PageSize = 1, 100
		filters.Search = f.suffix
		items, _, err := f.s.ListFilamentSpools(ctx, f.p, filters)
		if err != nil {
			t.Fatal(err)
		}
		result := map[uuid.UUID]bool{}
		for _, item := range items {
			result[item.ID] = true
		}
		return result
	}
	mine := []uuid.UUID{reusable.ID, single.ID, waiting.ID, gone.ID}
	check := func(label string, filters SpoolFilters, want ...uuid.UUID) {
		t.Helper()
		got := ids(filters)
		wanted := map[uuid.UUID]bool{}
		for _, id := range want {
			wanted[id] = true
		}
		for _, id := range mine {
			if got[id] != wanted[id] {
				t.Fatalf("%s: spool %s present=%v want %v", label, id, got[id], wanted[id])
			}
		}
	}
	check("kind reusable", SpoolFilters{Kind: "reusable"}, reusable.ID, waiting.ID)
	check("needs_refill", SpoolFilters{Statuses: []string{"needs_refill"}}, waiting.ID)
	check("loaded or active", SpoolFilters{Statuses: []string{"loaded", "active"}}, reusable.ID, single.ID)
	check("archived", SpoolFilters{Statuses: []string{"archived"}}, gone.ID)
	check("consumable", SpoolFilters{Consumable: true}, reusable.ID, single.ID)
	check("lifecycle archived", SpoolFilters{Lifecycle: "archived"}, gone.ID)
	check("not mounted", SpoolFilters{Mounted: ptr(false)}, reusable.ID, single.ID, waiting.ID, gone.ID)
	check("mounted", SpoolFilters{Mounted: ptr(true)})
	if _, _, err = f.s.ListFilamentSpools(ctx, f.p, SpoolFilters{Statuses: []string{"bogus"}, Page: 1, PageSize: 10}); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("invalid status: %v", err)
	}
	withMaterial, _, err := f.s.ListFilamentSpools(ctx, f.p, SpoolFilters{MaterialID: &m.ID, Page: 1, PageSize: 100})
	if err != nil || len(withMaterial) != 2 {
		t.Fatalf("material filter matches only spools with an open fill of that material: %d %v", len(withMaterial), err)
	}
}

func TestCleanUpDeletesOnlyQualifyingArchivedSingleUseSpools(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "5000")
	ctx := t.Context()
	finish := func(spool FilamentSpool) FilamentSpool {
		t.Helper()
		done, err := f.s.FinishFilamentSpool(ctx, f.p, spool.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "none"}, OccurredAt: f.now.Add(time.Minute), ExpectedVersion: spool.Version}, &f.request)
		if err != nil {
			t.Fatal(err)
		}
		return done
	}
	old := finish(f.purchasedSpool(t, m, "single_use", "100"))
	oldWithHistory := f.purchasedSpool(t, m, "single_use", "100")
	f.consume(t, oldWithHistory, m, "40")
	oldWithHistory = finish(f.get(t, oldWithHistory.ID))
	reusable := finish(f.purchasedSpool(t, m, "reusable", "100"))
	active := f.purchasedSpool(t, m, "single_use", "100")
	retiredOpen := f.purchasedSpool(t, m, "single_use", "100")
	f.consume(t, retiredOpen, m, "100")
	retiredOpen = f.get(t, retiredOpen.ID)
	retiredOpen, err := f.s.UpdateFilamentSpool(ctx, f.p, retiredOpen.ID, FilamentSpoolUpdate{ExpectedVersion: retiredOpen.Version, Lifecycle: "archived"}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	f.now = f.now.AddDate(0, 4, 0)
	recent := finish(f.purchasedSpool(t, m, "single_use", "100"))
	f.now = f.now.AddDate(0, 0, 1)

	candidates, deleted, err := f.s.CleanUpFilamentSpools(ctx, f.p, 3, true, nil, &f.request)
	if err != nil || deleted {
		t.Fatalf("dry run: deleted=%v err=%v", deleted, err)
	}
	listed := map[uuid.UUID]bool{}
	for _, c := range candidates {
		listed[c.ID] = true
	}
	for id, want := range map[uuid.UUID]bool{old.ID: true, oldWithHistory.ID: true, reusable.ID: false, active.ID: false, retiredOpen.ID: false, recent.ID: false} {
		if listed[id] != want {
			t.Fatalf("candidate %s listed=%v want %v", id, listed[id], want)
		}
	}
	// Dry runs change nothing; deletion needs explicit ids.
	if _, err = f.s.GetFilamentSpool(ctx, f.p, old.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.s.CleanUpFilamentSpools(ctx, f.p, 3, false, nil, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("delete without ids: %v", err)
	}
	if _, _, err = f.s.CleanUpFilamentSpools(ctx, f.p, 2, true, nil, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("invalid months: %v", err)
	}

	ledgerBefore := len(f.ledger(t, m.ID))
	items, deleted, err := f.s.CleanUpFilamentSpools(ctx, f.p, 3, false, []uuid.UUID{old.ID, oldWithHistory.ID, reusable.ID, active.ID, retiredOpen.ID, recent.ID, uuid.Must(uuid.NewV7())}, &f.request)
	if err != nil || !deleted || len(items) != 2 {
		t.Fatalf("delete: items=%v deleted=%v err=%v", items, deleted, err)
	}
	for _, id := range []uuid.UUID{old.ID, oldWithHistory.ID} {
		if _, err = f.s.GetFilamentSpool(ctx, f.p, id); !apperror.IsCode(err, "not_found") {
			t.Fatalf("spool %s still exists: %v", id, err)
		}
	}
	for _, id := range []uuid.UUID{reusable.ID, active.ID, retiredOpen.ID, recent.ID} {
		if _, err = f.s.GetFilamentSpool(ctx, f.p, id); err != nil {
			t.Fatalf("spool %s must survive: %v", id, err)
		}
	}
	// Ledger rows stay, lose only their references and keep the snapshots.
	lines := f.ledger(t, m.ID)
	if len(lines) != ledgerBefore {
		t.Fatalf("ledger length changed from %d to %d", ledgerBefore, len(lines))
	}
	kept := 0
	for _, l := range lines {
		for _, spool := range []FilamentSpool{old, oldWithHistory} {
			if l.display != nil && *l.display == spool.DisplayID {
				kept++
				if l.spoolID != nil || l.fillID != nil || l.fillNumber == nil || *l.fillNumber != 1 {
					t.Fatalf("ledger row of a deleted spool: %+v", l)
				}
			}
			if l.toDisplay != nil && *l.toDisplay == spool.DisplayID && (l.toSpoolID != nil || l.toFillID != nil || l.toFill == nil) {
				t.Fatalf("transfer row of a deleted spool: %+v", l)
			}
		}
	}
	if kept == 0 {
		t.Fatal("no ledger snapshots found")
	}
	history, total, err := f.s.ListMaterialTransactions(ctx, f.p, m.ID, 1, 100)
	if err != nil || total != int64(ledgerBefore) {
		t.Fatalf("material history total=%d err=%v", total, err)
	}
	snapshots := 0
	for _, item := range history {
		if item.SpoolDisplayID != nil && (*item.SpoolDisplayID == old.DisplayID || *item.SpoolDisplayID == oldWithHistory.DisplayID) && item.SpoolID == nil {
			snapshots++
		}
	}
	if snapshots == 0 {
		t.Fatal("deleted spools lost their snapshots in the API view")
	}
	var audits int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE request_id = $1 AND action = 'filament_spool.deleted' AND resource_id = ANY($2)`, f.request, []uuid.UUID{old.ID, oldWithHistory.ID}).Scan(&audits); err != nil || audits != 2 {
		t.Fatalf("delete audit events = %d err=%v", audits, err)
	}
	var survivors int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE request_id = $1 AND action = 'filament_spool.deleted' AND resource_id <> ALL($2)`, f.request, []uuid.UUID{old.ID, oldWithHistory.ID}).Scan(&survivors); err != nil || survivors != 0 {
		t.Fatalf("unexpected delete audits = %d err=%v", survivors, err)
	}
}

func TestJobUsagesAttachToFillsAndSurviveSpoolDeletion(t *testing.T) {
	jf := newJobFixture(t)
	f := &fillFixture{pool: jf.pool, s: jf.s, p: jf.p, request: jf.request, now: jf.now, suffix: strings.ReplaceAll(jf.person.String(), "-", "")[:12]}
	ctx := t.Context()
	m := f.material(t, "2000")
	refill := f.spool(t, m, "reusable", "500")
	single := f.purchasedSpool(t, m, "single_use", "300")

	job := jf.create(t, func() JobInput {
		in := jf.input(-4*time.Hour, time.Hour, "successful")
		in.Usages = []UsageInput{{MaterialID: m.ID, SpoolID: &refill.ID, Quantity: "100"}, {MaterialID: m.ID, SpoolID: &single.ID, Quantity: "50"}}
		return in
	}())
	if len(job.Usages) != 2 {
		t.Fatalf("usages: %+v", job.Usages)
	}
	for _, u := range job.Usages {
		if u.SpoolDisplayID == nil || u.FillNumber == nil || *u.FillNumber != 1 {
			t.Fatalf("usage without snapshots: %+v", u)
		}
	}
	if got := f.get(t, refill.ID).RemainingQuantity; got != "400" {
		t.Fatalf("remaining after job = %s", got)
	}
	// A usage that names a spool without an open fill is refused.
	f.now = jf.now
	emptied := f.spool(t, m, "reusable", "100")
	emptied, err := f.s.FinishFilamentSpool(ctx, f.p, emptied.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}, OccurredAt: f.now.Add(time.Minute), ExpectedVersion: emptied.Version}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	refused := jf.input(-8*time.Hour, time.Hour, "successful")
	refused.Usages = []UsageInput{{MaterialID: m.ID, SpoolID: &emptied.ID, Quantity: "10"}}
	if _, err = jf.s.CreateManualJob(ctx, jf.p, refused, &jf.request); !apperror.IsCode(err, "spool_not_consumable") {
		t.Fatalf("usage of a spool without fill: %v", err)
	}

	// Refilling moves the spool on to fill 2; the recorded usage keeps fill 1.
	current := f.get(t, refill.ID)
	if _, err = f.s.ChangeFilamentSpoolFill(ctx, f.p, refill.ID, ChangeFillInput{Leftover: &LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}, Fill: f.newFill(m, "200"), OccurredAt: f.now.Add(time.Hour), ExpectedVersion: current.Version}, &f.request); err != nil {
		t.Fatal(err)
	}
	reloaded, err := jf.s.GetJob(ctx, jf.p, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range reloaded.Usages {
		if u.FillNumber == nil || *u.FillNumber != 1 {
			t.Fatalf("usage lost its fill: %+v", u)
		}
	}
	// Correcting the job returns the old usage to stock and takes the new one from fill 2.
	before := len(f.ledger(t, m.ID))
	correctedResult, err := jf.s.ReplaceRunUsages(ctx, jf.p, reloaded.Runs[0].ID, reloaded.Runs[0].Version, []UsageInput{{MaterialID: m.ID, SpoolID: &refill.ID, Quantity: "30"}, {MaterialID: m.ID, SpoolID: &single.ID, Quantity: "50"}}, &jf.request)
	if err != nil {
		t.Fatal(err)
	}
	corrected := *correctedResult.Job
	newest := f.ledger(t, m.ID)[before:]
	want := []string{
		fmt.Sprintf("adjustment/job_corrected 100 loose"),
		fmt.Sprintf("adjustment/job_corrected 50 %s#1", single.DisplayID),
		fmt.Sprintf("machine_run_consumption -30 %s#2", refill.DisplayID),
		fmt.Sprintf("machine_run_consumption -50 %s#1", single.DisplayID),
	}
	got := summarize(newest)
	if len(got) != len(want) {
		t.Fatalf("correction rows %q", got)
	}
	have := map[string]bool{}
	for _, row := range got {
		have[row] = true
	}
	for _, row := range want {
		if !have[row] {
			t.Fatalf("missing correction row %q in %q", row, got)
		}
	}
	for _, u := range corrected.Usages {
		if u.SpoolID != nil && *u.SpoolID == refill.ID && (u.FillNumber == nil || *u.FillNumber != 2) {
			t.Fatalf("new usage not on fill 2: %+v", u)
		}
	}

	// Archive and hard-delete the single-use spool: the job keeps the snapshot.
	single = f.get(t, single.ID)
	if _, err = f.s.FinishFilamentSpool(ctx, f.p, single.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "none"}, OccurredAt: f.now.Add(2 * time.Hour), ExpectedVersion: single.Version}, &f.request); err != nil {
		t.Fatal(err)
	}
	jf.now = jf.now.AddDate(0, 7, 0)
	items, _, err := f.s.CleanUpFilamentSpools(ctx, f.p, 6, false, []uuid.UUID{single.ID}, &f.request)
	if err != nil || len(items) != 1 {
		t.Fatalf("cleanup: %v %v", items, err)
	}
	after, err := jf.s.GetJob(ctx, jf.p, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, u := range after.Usages {
		if u.SpoolDisplayID != nil && *u.SpoolDisplayID == single.DisplayID {
			found = true
			if u.SpoolID != nil || u.FillNumber == nil || *u.FillNumber != 1 || u.Quantity != "50" {
				t.Fatalf("usage after spool deletion: %+v", u)
			}
		}
	}
	if !found {
		t.Fatalf("job usage with the deleted spool is gone: %+v", after.Usages)
	}
	// The deleted spool's consumption stays in the material history.
	history, _, err := f.s.ListMaterialTransactions(ctx, f.p, m.ID, 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range history {
		if item.SpoolDisplayID != nil && *item.SpoolDisplayID == single.DisplayID && item.SpoolID != nil {
			t.Fatalf("history row still references the deleted spool: %+v", item)
		}
	}
}

// A spool that took part in transfers keeps its transfer rows readable after deletion.
func TestCleanUpKeepsTransferRowsOfDeletedSpools(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "1000")
	ctx := t.Context()
	spool := f.spool(t, m, "single_use", "300")
	if _, err := f.s.FinishFilamentSpool(ctx, f.p, spool.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "system", Disposition: ptr("returned_to_stock")}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: spool.Version}, &f.request); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.AddDate(0, 2, 0)
	items, _, err := f.s.CleanUpFilamentSpools(ctx, f.p, 1, false, []uuid.UUID{spool.ID}, &f.request)
	if err != nil || len(items) != 1 {
		t.Fatalf("cleanup of a spool with transfers: %v %v", items, err)
	}
	assertLines(t, f.ledger(t, m.ID), 1, fmt.Sprintf("transfer 300 loose->%s#1", spool.DisplayID), fmt.Sprintf("transfer 300 %s#1->loose", spool.DisplayID))
	for _, l := range f.ledger(t, m.ID) {
		if l.toSpoolID != nil || l.fromSpoolID != nil || l.toFillID != nil || l.fromFillID != nil {
			t.Fatalf("transfer still references the deleted spool: %+v", l)
		}
	}
	assertMaterial(t, f.refresh(t, m), "1000", "0", "1000")
}

func TestFilamentProductsCatalog(t *testing.T) {
	f := newFillFixture(t)
	m := f.material(t, "")
	other := f.material(t, "")
	ctx := t.Context()
	input := FilamentProductInput{Manufacturer: "Maker " + f.suffix, Name: "Silk PLA", MaterialID: m.ID, NetWeightG: "1000", DefaultPrice: ptr("21.5"), Packaging: "spool", Notes: ptr("note"), Active: true}
	product, err := f.s.CreateFilamentProduct(ctx, f.p, input, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if product.Version != 1 || !product.Active || product.InUseCount != 0 || product.MaterialName == "" || product.NetWeightG != "1000" || product.DefaultPrice == nil || *product.DefaultPrice != "21.5" {
		t.Fatalf("product: %+v", product)
	}
	dup := input
	dup.Manufacturer, dup.Name = strings.ToUpper(input.Manufacturer), strings.ToLower(input.Name)
	if _, err = f.s.CreateFilamentProduct(ctx, f.p, dup, &f.request); !apperror.IsCode(err, "product_exists") {
		t.Fatalf("case-insensitive duplicate: %v", err)
	}
	missing := input
	missing.Name, missing.MaterialID = "Other", uuid.Must(uuid.NewV7())
	if _, err = f.s.CreateFilamentProduct(ctx, f.p, missing, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown material: %v", err)
	}
	bad := input
	bad.Name, bad.Packaging = "Bad", "box"
	if _, err = f.s.CreateFilamentProduct(ctx, f.p, bad, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("bad packaging: %v", err)
	}
	second := input
	second.Name = "Matte PLA"
	other2, err := f.s.CreateFilamentProduct(ctx, f.p, second, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	// Renaming into a collision is a conflict, a stale version is stale.
	collide := input
	collide.Name, collide.ExpectedVersion = "matte pla", product.Version
	if _, err = f.s.UpdateFilamentProduct(ctx, f.p, product.ID, collide, &f.request); !apperror.IsCode(err, "product_exists") {
		t.Fatalf("rename into collision: %v", err)
	}
	stale := input
	stale.ExpectedVersion = 9
	if _, err = f.s.UpdateFilamentProduct(ctx, f.p, product.ID, stale, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale update: %v", err)
	}
	// In-use counts follow open fills of non-archived spools.
	spoolInput := f.spoolInput(m, "single_use", "100")
	spoolInput.StockMode, spoolInput.TotalPrice, spoolInput.ProductID = "new_acquisition", ptr("10"), &product.ID
	spool, err := f.s.CreateFilamentSpool(ctx, f.p, spoolInput, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if spool.ProductID == nil || spool.Manufacturer == nil || *spool.Manufacturer != input.Manufacturer {
		t.Fatalf("spool from product: %+v", spool)
	}
	if got, _ := f.s.GetFilamentProduct(ctx, f.p, product.ID); got.InUseCount != 1 {
		t.Fatalf("inUseCount = %d", got.InUseCount)
	}
	mismatch := f.spoolInput(other, "single_use", "100")
	mismatch.StockMode, mismatch.TotalPrice, mismatch.ProductID = "new_acquisition", ptr("10"), &product.ID
	if _, err = f.s.CreateFilamentSpool(ctx, f.p, mismatch, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("spool with a product of another material: %v", err)
	}
	if _, err = f.s.FinishFilamentSpool(ctx, f.p, spool.ID, FinishSpoolInput{Leftover: LeftoverInput{Basis: "none"}, OccurredAt: f.now.Add(time.Hour), ExpectedVersion: spool.Version}, &f.request); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.s.GetFilamentProduct(ctx, f.p, product.ID); got.InUseCount != 0 {
		t.Fatalf("inUseCount after finishing = %d", got.InUseCount)
	}
	// Deactivation hides the product from the default list.
	deactivated := input
	deactivated.Active, deactivated.ExpectedVersion = false, product.Version
	updated, err := f.s.UpdateFilamentProduct(ctx, f.p, product.ID, deactivated, &f.request)
	if err != nil || updated.Active || updated.Version != 2 {
		t.Fatalf("deactivate: %+v %v", updated, err)
	}
	list := func(includeInactive bool) map[uuid.UUID]bool {
		items, _, err := f.s.ListFilamentProducts(ctx, f.p, FilamentProductFilters{Search: f.suffix, IncludeInactive: includeInactive, Page: 1, PageSize: 50})
		if err != nil {
			t.Fatal(err)
		}
		result := map[uuid.UUID]bool{}
		for _, item := range items {
			result[item.ID] = true
		}
		return result
	}
	if got := list(false); got[product.ID] || !got[other2.ID] {
		t.Fatalf("default list: %v", got)
	}
	if got := list(true); !got[product.ID] || !got[other2.ID] {
		t.Fatalf("list with inactive: %v", got)
	}
	filtered, total, err := f.s.ListFilamentProducts(ctx, f.p, FilamentProductFilters{MaterialID: &other.ID, IncludeInactive: true, Page: 1, PageSize: 10})
	if err != nil || total != 0 || len(filtered) != 0 {
		t.Fatalf("material filter: %d %v", total, err)
	}

	// Permissions: reading needs inventory.read, writing inventory.manage.
	reader := restrictedPrincipal(t, f.pool, authorization.InventoryRead)
	writer := restrictedPrincipal(t, f.pool, authorization.InventoryManage)
	nobody := restrictedPrincipal(t, f.pool, authorization.MachinesRead)
	if _, err = f.s.GetFilamentProduct(ctx, reader, product.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.s.ListFilamentProducts(ctx, reader, FilamentProductFilters{Page: 1, PageSize: 5}); err != nil {
		t.Fatal(err)
	}
	for name, call := range map[string]func() error{
		"get without read": func() error { _, err := f.s.GetFilamentProduct(ctx, nobody, product.ID); return err },
		"list without read": func() error {
			_, _, err := f.s.ListFilamentProducts(ctx, nobody, FilamentProductFilters{Page: 1, PageSize: 5})
			return err
		},
		"create read only": func() error { _, err := f.s.CreateFilamentProduct(ctx, reader, second, nil); return err },
		"update read only": func() error {
			_, err := f.s.UpdateFilamentProduct(ctx, reader, product.ID, deactivated, nil)
			return err
		},
		"create without manage": func() error { _, err := f.s.CreateFilamentProduct(ctx, nobody, second, nil); return err },
	} {
		if err := call(); !apperror.IsCode(err, "permission_denied") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	renamed := input
	renamed.Name, renamed.ExpectedVersion = "Writer PLA", updated.Version
	if _, err = f.s.UpdateFilamentProduct(ctx, writer, product.ID, renamed, &f.request); err != nil {
		t.Fatal(err)
	}
}
