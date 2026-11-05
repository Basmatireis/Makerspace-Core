package machinelogbook

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// unitsFixture adds a consumable type counted in metres to the job fixture, with a material rate of 3.5 per metre
// in the fixture's pricing group.
type unitsFixture struct {
	*jobFixture
	typ MaterialType
}

func newUnitsFixture(t *testing.T) *unitsFixture {
	t.Helper()
	f := &unitsFixture{jobFixture: newJobFixture(t)}
	typ, err := f.s.CreateMaterialType(
		t.Context(), f.p, "Cord "+f.person.String()[:8], KindConsumable, "m", []uuid.UUID{f.machine.Process.ID}, &f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	f.typ = typ
	t.Cleanup(func() {
		ctx := t.Context()
		_, _ = f.pool.Exec(ctx, `DELETE FROM machine_run_usages WHERE material_id IN (SELECT id FROM materials WHERE material_type_id = $1)`, typ.ID)
		_, _ = f.pool.Exec(ctx, `DELETE FROM materials WHERE material_type_id = $1`, typ.ID)
		_, _ = f.pool.Exec(ctx, `DELETE FROM pricing_rules WHERE material_type_id = $1`, typ.ID)
		_, _ = f.pool.Exec(ctx, `DELETE FROM material_types WHERE id = $1`, typ.ID)
	})
	if _, err = f.s.CreatePricingRule(
		t.Context(), f.p, f.group.ID, PricingRuleMaterial, nil, &typ.ID, nil, "3.5", &f.request,
	); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *unitsFixture) article(t *testing.T, name string, unit *string) Material {
	t.Helper()
	m, err := f.s.CreateMaterial(
		t.Context(), f.p, MaterialInput{Name: name + f.person.String()[:8], MaterialTypeID: f.typ.ID, Unit: unit}, &f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(t.Context(), `DELETE FROM inventory_transactions WHERE material_id = $1`, m.ID)
	})
	return m
}

func (f *unitsFixture) stock(t *testing.T, m Material, quantity, total string) Material {
	t.Helper()
	if _, err := f.s.AddPurchase(
		t.Context(), f.p, m.ID, m.InventoryVersion, quantity, total, f.now, nil, nil, nil, &f.request,
	); err != nil {
		t.Fatal(err)
	}
	got, err := f.s.GetMaterial(t.Context(), f.p, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func (f *unitsFixture) update(t *testing.T, m Material, change func(*MaterialInput)) (Material, error) {
	t.Helper()
	in := MaterialInput{
		Name: m.Name, MaterialTypeID: m.MaterialTypeID, Active: true, ExpectedVersion: m.Version,
		PackageSize: m.PackageSize, LowStockThreshold: m.LowStockThreshold, CountLabel: m.CountLabel,
	}
	change(&in)
	return f.s.UpdateMaterial(t.Context(), f.p, m.ID, in, &f.request)
}

func TestArticleInSmallerUnitIsPricedAtTheTypeRate(t *testing.T) {
	f := newUnitsFixture(t)
	cm := "cm"
	m := f.stock(t, f.article(t, "Cord cm ", &cm), "1000", "50")
	if m.Unit != "cm" {
		t.Fatalf("unit = %s", m.Unit)
	}
	var rate string
	for _, p := range m.Prices {
		if p.PricingGroupID == f.group.ID {
			rate = p.Rate
		}
	}
	if rate != "0.035" {
		t.Fatalf("article price per cm = %q, want 0.035", rate)
	}
	quote := func() PriceQuoteGroup {
		q, err := f.s.QuotePrice(t.Context(), f.p, PriceQuoteInput{MaterialID: &m.ID, Quantity: ptr("150")})
		if err != nil {
			t.Fatal(err)
		}
		return q.group(t, f.group.ID)
	}()
	if text(quote.MaterialRate) != "0.035" || text(quote.MaterialAmount) != "5.25" {
		t.Fatalf("quote: rate %s amount %s", text(quote.MaterialRate), text(quote.MaterialAmount))
	}
	// A variant rate is converted the same way.
	if _, err := f.s.CreatePricingRuleWithVariant(
		t.Context(), f.p, f.group.ID, PricingRuleMaterial, nil, &f.typ.ID, f.variant(t), nil, "5", &f.request,
	); err != nil {
		t.Fatal(err)
	}
	job := f.create(t, f.input(-3*time.Hour, time.Hour, "successful"))
	job = f.addRun(t, job, -2*time.Hour, time.Hour, nil, UsageInput{MaterialID: m.ID, Quantity: "200"})
	// 1 h runtime at 10 plus 200 cm at 0.035 (the variant rate does not apply to an article without the variant).
	if price(job.CalculatedPrice) != "27" {
		t.Fatalf("job price = %s, want 27", price(job.CalculatedPrice))
	}
	found := false
	for _, r := range job.PricingSnapshot.Rules {
		if r.Kind == PricingRuleMaterial && r.Unit == "cm" {
			found = true
			if text(r.Rate) != "0.035" {
				t.Fatalf("snapshot rate = %s", text(r.Rate))
			}
		}
	}
	if !found {
		t.Fatalf("no cm entry in snapshot: %+v", job.PricingSnapshot.Rules)
	}
}

// variant adds a variant to the type and returns its id.
func (f *unitsFixture) variant(t *testing.T) *uuid.UUID {
	t.Helper()
	v, err := f.s.CreateMaterialTypeVariant(t.Context(), f.p, f.typ.ID, "Thick", &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return &v.ID
}

func TestChangingTheArticleUnitConvertsEverythingItCounts(t *testing.T) {
	f := newUnitsFixture(t)
	m := f.stock(t, f.article(t, "Cord conv ", nil), "10", "50")
	if _, err := f.s.CreateStockArticlePricingRule(t.Context(), f.p, f.group.ID, m.ID, "8", &f.request); err != nil {
		t.Fatal(err)
	}
	job := f.create(t, f.input(-3*time.Hour, time.Hour, "successful"))
	job = f.addRun(t, job, -2*time.Hour, time.Hour, nil, UsageInput{MaterialID: m.ID, Quantity: "1.5"})
	m, err := f.s.GetMaterial(t.Context(), f.p, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	m, err = f.update(t, m, func(in *MaterialInput) {
		in.PackageSize, in.LowStockThreshold = ptr("5"), ptr("2")
	})
	if err != nil {
		t.Fatal(err)
	}
	valueBefore := m.InventoryValue
	cm := "cm"
	m, err = f.update(t, m, func(in *MaterialInput) { in.Unit = &cm })
	if err != nil {
		t.Fatal(err)
	}
	assertDecimal(t, "quantity", m.Quantity, "850")
	assertDecimal(t, "average cost", m.AverageUnitCost, "0.05")
	assertDecimal(t, "value", m.InventoryValue, valueBefore)
	if m.Unit != "cm" || text(m.PackageSize) != "500" || text(m.LowStockThreshold) != "200" {
		t.Fatalf("article after conversion: %+v", m)
	}
	var delta, usage, rate, usageUnit string
	if err = f.pool.QueryRow(
		t.Context(),
		`SELECT string_agg(quantity_delta::text, ',' ORDER BY quantity_delta) FROM inventory_transactions WHERE material_id = $1`,
		m.ID,
	).Scan(&delta); err != nil || delta != "-150.000000,1000.000000" {
		t.Fatalf("ledger = %q %v", delta, err)
	}
	if err = f.pool.QueryRow(
		t.Context(), `SELECT quantity::text, material_unit FROM machine_run_usages WHERE material_id = $1 AND active`, m.ID,
	).Scan(&usage, &usageUnit); err != nil || usage != "150.000000" || usageUnit != "cm" {
		t.Fatalf("usage = %s %s %v", usage, usageUnit, err)
	}
	if err = f.pool.QueryRow(
		t.Context(), `SELECT rate::text FROM pricing_rules WHERE kind = 'stock_article' AND material_id = $1`, m.ID,
	).Scan(&rate); err != nil || rate != "0.080000" {
		t.Fatalf("stock_article rate = %s %v", rate, err)
	}
	var audits int
	if err = f.pool.QueryRow(
		t.Context(), `SELECT count(*) FROM audit_events WHERE action = 'material.unit_converted' AND resource_id = $1`, m.ID,
	).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("audit events = %d %v", audits, err)
	}
	// The job keeps its price: the usage and the snapshot rate converted the same way.
	stored, gerr := f.s.GetJob(t.Context(), f.p, job.ID)
	if gerr != nil || price(stored.CalculatedPrice) != price(job.CalculatedPrice) {
		t.Fatalf("job price changed: %s -> %s (%v)", price(job.CalculatedPrice), price(stored.CalculatedPrice), gerr)
	}
	// Another dimension is refused, also for creation.
	g := "g"
	if _, err = f.update(t, m, func(in *MaterialInput) { in.Unit = &g }); !apperror.IsCode(err, "material_unit_mismatch") {
		t.Fatalf("cross-dimension update: %v", err)
	}
	if _, err = f.s.CreateMaterial(
		t.Context(), f.p, MaterialInput{Name: "Cord g " + f.person.String()[:8], MaterialTypeID: f.typ.ID, Unit: &g}, &f.request,
	); !apperror.IsCode(err, "material_unit_mismatch") {
		t.Fatalf("cross-dimension create: %v", err)
	}
}

func TestChangingTheTypeUnitKeepsPricesAndCrossDimensionNeedsAnUnusedType(t *testing.T) {
	f := newUnitsFixture(t)
	f.stock(t, f.article(t, "Cord type ", nil), "10", "50")
	updated, err := f.s.UpdateMaterialType(
		t.Context(), f.p, f.typ.ID, f.typ.Version, f.typ.Name, "", "mm", nil, true, &f.request,
	)
	if err != nil {
		t.Fatalf("same-dimension change while in use: %v", err)
	}
	var rate, unit string
	if err = f.pool.QueryRow(
		t.Context(), `SELECT rate::text, material_unit FROM pricing_rules WHERE material_type_id = $1 AND kind = 'material'`, f.typ.ID,
	).Scan(&rate, &unit); err != nil || rate != "0.003500" || unit != "mm" {
		t.Fatalf("rule after type change: %s %s %v", rate, unit, err)
	}
	if _, err = f.s.UpdateMaterialType(
		t.Context(), f.p, f.typ.ID, updated.Version, f.typ.Name, "", "g", nil, true, &f.request,
	); !apperror.IsCode(err, "material_type_unit_in_use") {
		t.Fatalf("cross-dimension change in use: %v", err)
	}
	unused, err := f.s.CreateMaterialType(
		t.Context(), f.p, "Unused "+f.person.String()[:8], KindPart, "piece", nil, &f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = f.pool.Exec(t.Context(), `DELETE FROM material_types WHERE id = $1`, unused.ID) })
	if _, err = f.s.UpdateMaterialType(
		t.Context(), f.p, unused.ID, unused.Version, unused.Name, "", "l", nil, true, &f.request,
	); err != nil {
		t.Fatalf("cross-dimension change of an unused type: %v", err)
	}
}

func TestCountLabelIsForPieceArticlesAndFilamentStaysInGrams(t *testing.T) {
	f := newUnitsFixture(t)
	if _, err := f.s.CreateMaterial(
		t.Context(), f.p,
		MaterialInput{Name: "Labelled " + f.person.String()[:8], MaterialTypeID: f.typ.ID, CountLabel: ptr("sheet")},
		&f.request,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("count label on a metre article: %v", err)
	}
	part, err := f.s.CreateMaterialType(t.Context(), f.p, "Sheets "+f.person.String()[:8], KindPart, "piece", nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(t.Context(), `DELETE FROM materials WHERE material_type_id = $1`, part.ID)
		_, _ = f.pool.Exec(t.Context(), `DELETE FROM material_types WHERE id = $1`, part.ID)
	})
	m, err := f.s.CreateMaterial(
		t.Context(), f.p,
		MaterialInput{Name: "Sheet " + f.person.String()[:8], MaterialTypeID: part.ID, CountLabel: ptr(" sheet ")},
		&f.request,
	)
	if err != nil || text(m.CountLabel) != "sheet" || m.Unit != "piece" {
		t.Fatalf("piece article: %+v %v", m, err)
	}
	if _, err = f.s.CreateMaterial(
		t.Context(), f.p,
		MaterialInput{Name: "Long " + f.person.String()[:8], MaterialTypeID: part.ID, CountLabel: ptr("123456789012345678901")},
		&f.request,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("overlong label: %v", err)
	}
	if _, err = f.s.CreateMaterialType(
		t.Context(), f.p, "Heavy "+f.person.String()[:8], KindFilament, "kg", nil, &f.request,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("filament type in kg: %v", err)
	}
	kg := "kg"
	if _, err = f.s.CreateMaterial(
		t.Context(), f.p, MaterialInput{Name: "Heavy PLA " + f.person.String()[:8], MaterialTypeID: f.materialType.ID, Unit: &kg}, &f.request,
	); !apperror.IsCode(err, "material_unit_mismatch") {
		t.Fatalf("filament article in kg: %v", err)
	}
}

func TestStatisticsByMonthSumInTheTypeUnit(t *testing.T) {
	f := newUnitsFixture(t)
	y := uniqueYear()
	f.now = time.Date(y, time.June, 30, 12, 0, 0, 0, time.UTC)
	cm := "cm"
	m := f.stock(t, f.article(t, "Cord stat ", &cm), "1000", "10")
	start := time.Date(y, time.June, 10, 8, 0, 0, 0, time.UTC)
	in := f.input(0, 0, JobOutcomeSuccessful)
	in.StartsAt, in.EndsAt = start, start.Add(time.Hour)
	in.Usages = []UsageInput{{MaterialID: m.ID, Quantity: "250"}}
	f.create(t, in)
	from := time.Date(y, time.June, 1, 0, 0, 0, 0, time.UTC)
	stats, err := f.s.Statistics(t.Context(), f.p, from, from.AddDate(0, 1, 0))
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range stats.MaterialByMonth {
		if row.MaterialTypeID == f.typ.ID {
			if row.Unit != "m" {
				t.Fatalf("unit = %s", row.Unit)
			}
			assertDecimal(t, "quantity in m", row.Quantity, "2.5")
			return
		}
	}
	t.Fatalf("type missing in %+v", stats.MaterialByMonth)
}
