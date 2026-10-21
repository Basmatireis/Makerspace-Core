package machinelogbook

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// usesOf returns the kinds named in the details of a material_in_use refusal.
func usesOf(t *testing.T, err error) map[string]int64 {
	t.Helper()
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.Code != "material_in_use" {
		t.Fatalf("want material_in_use, got %v", err)
	}
	listed, ok := appErr.Details["uses"].([]map[string]any)
	if !ok {
		t.Fatalf("uses details: %#v", appErr.Details)
	}
	kinds := map[string]int64{}
	for _, use := range listed {
		kinds[use["kind"].(string)] = use["count"].(int64)
	}
	return kinds
}

func (f *fillFixture) assertDeletable(t *testing.T, m Material, want bool) Material {
	t.Helper()
	fresh := f.refresh(t, m)
	if fresh.Deletable != want {
		t.Fatalf("deletable = %v, want %v", fresh.Deletable, want)
	}
	items, _, _, err := f.s.ListMaterials(t.Context(), f.p, fresh.Name, nil, "", "", 1, 10)
	if err != nil || len(items) != 1 || items[0].Deletable != want {
		t.Fatalf("listed deletable: %+v %v", items, err)
	}
	return fresh
}

func TestDeleteMaterialRemovesAnUnusedArticle(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	filament := f.assertDeletable(t, f.material(t, ""), true)
	if filament.Kind != KindFilament || filament.FilamentDiameterMM == nil {
		t.Fatalf("filament: %+v", filament)
	}
	consumableType, err := f.s.CreateMaterialType(
		ctx, f.p, "Delete glue "+f.suffix, "consumable", "ml", []string{"other"}, &f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = f.pool.Exec(ctx, `DELETE FROM material_types WHERE id = $1`, consumableType.ID) })
	consumable, err := f.s.CreateMaterial(
		ctx, f.p, MaterialInput{Name: f.unique("Glue"), MaterialTypeID: consumableType.ID}, &f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	consumable = f.assertDeletable(t, consumable, true)

	for _, m := range []Material{filament, consumable} {
		if err = f.s.DeleteMaterial(ctx, f.p, m.ID, m.Version+1, &f.request); !apperror.IsCode(err, "stale_write") {
			t.Fatalf("stale delete: %v", err)
		}
		if err = f.s.DeleteMaterial(ctx, f.p, m.ID, m.Version, &f.request); err != nil {
			t.Fatalf("delete %s: %v", m.Kind, err)
		}
		if _, err = f.s.GetMaterial(ctx, f.p, m.ID); !apperror.IsCode(err, "not_found") {
			t.Fatalf("deleted article: %v", err)
		}
		var rows int
		if err = f.pool.QueryRow(
			ctx,
			`SELECT (SELECT count(*) FROM materials WHERE id = $1)
			      + (SELECT count(*) FROM material_balances WHERE material_id = $1)
			      + (SELECT count(*) FROM material_filament_properties WHERE material_id = $1)`,
			m.ID,
		).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("rows left after delete: %d %v", rows, err)
		}
		if n := f.auditCount(t, "material.deleted", m.ID); n != 1 {
			t.Fatalf("audit events = %d", n)
		}
		if err = f.s.DeleteMaterial(ctx, f.p, m.ID, m.Version, &f.request); !apperror.IsCode(err, "not_found") {
			t.Fatalf("delete twice: %v", err)
		}
	}
	if err = f.s.DeleteMaterial(ctx, f.p, ids.New(), 1, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown article: %v", err)
	}
	if err = f.s.DeleteMaterial(ctx, f.p, ids.New(), 0, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("zero version: %v", err)
	}
}

func TestDeleteMaterialRefusesArticlesThatAreInUse(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	refused := func(m Material, want ...string) {
		t.Helper()
		fresh := f.assertDeletable(t, m, false)
		err := f.s.DeleteMaterial(ctx, f.p, m.ID, fresh.Version, &f.request)
		kinds := usesOf(t, err)
		for _, kind := range want {
			if kinds[kind] < 1 {
				t.Fatalf("uses %v lack %s", kinds, kind)
			}
		}
		if !strings.Contains(err.Error(), "deactivate it instead") {
			t.Fatalf("message: %v", err)
		}
		if _, getErr := f.s.GetMaterial(ctx, f.p, m.ID); getErr != nil {
			t.Fatalf("article must stay: %v", getErr)
		}
		if n := f.auditCount(t, "material.deleted", m.ID); n != 0 {
			t.Fatalf("audit events = %d", n)
		}
	}

	// A purchase leaves a ledger entry, even when the stock is consumed again.
	purchased := f.material(t, "100")
	refused(purchased, "ledger_entries")

	// A spool fill is a use of its own next to the ledger rows that created it.
	spooled := f.material(t, "")
	f.purchasedSpool(t, spooled, "single_use", "300")
	refused(spooled, "ledger_entries", "spool_fills")

	// A purchase that is booked and then adjusted away to zero stays a use.
	emptied := f.material(t, "50")
	fresh := f.refresh(t, emptied)
	if _, err := f.s.RecordConsumption(
		ctx, f.p, emptied.ID, fresh.InventoryVersion, "50", f.now, false, nil, nil, &f.request,
	); err != nil {
		t.Fatal(err)
	}
	if got := f.refresh(t, emptied).Quantity; got != "0" {
		t.Fatalf("quantity = %s", got)
	}
	refused(emptied, "ledger_entries")

	// An order item of kind inventory_item keeps the article, too.
	sold := f.material(t, "")
	order, item := ids.New(), ids.New()
	reference := "O-2099-" + digits(order)
	t.Cleanup(func() { _, _ = f.pool.Exec(ctx, `DELETE FROM orders WHERE id = $1`, order) })
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(
		ctx,
		`INSERT INTO orders (id, reference, customer_kind, fulfillment_mode) VALUES ($1, $2, 'anonymous', 'deferred')`,
		order, reference,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(
		ctx,
		`INSERT INTO order_items (id, order_id, position, kind, description, quantity, unit, unit_price, amount, source_material_id)
		 VALUES ($1, $2, 1, 'inventory_item', 'Sold article', 1, 'piece', 0, 0, $3)`,
		item, order, sold.ID,
	); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	refused(sold, "order_items")
}

func TestDeleteMaterialRefusesArticlesWithRunUsages(t *testing.T) {
	jf := newJobFixture(t)
	f := &fillFixture{
		pool:    jf.pool,
		s:       jf.s,
		p:       jf.p,
		request: jf.request,
		now:     jf.now,
		suffix:  strings.ReplaceAll(jf.person.String(), "-", "")[:12],
		typeID:  jf.materialType.ID,
	}
	m := f.material(t, "500")
	jf.create(t, func() JobInput {
		in := jf.input(-4*time.Hour, time.Hour, "successful")
		in.Usages = []UsageInput{{MaterialID: m.ID, Quantity: "10"}}
		return in
	}())
	err := f.s.DeleteMaterial(t.Context(), f.p, m.ID, f.refresh(t, m).Version, &f.request)
	if kinds := usesOf(t, err); kinds["run_usages"] < 1 || kinds["ledger_entries"] < 1 {
		t.Fatalf("uses: %v", kinds)
	}
	f.assertDeletable(t, m, false)
}

func TestDeleteMaterialAuthorization(t *testing.T) {
	f := newFillFixture(t)
	ctx := t.Context()
	m := f.material(t, "")
	reader := restrictedPrincipal(t, f.pool, authorization.InventoryRead)
	if err := f.s.DeleteMaterial(ctx, reader, m.ID, m.Version, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("reader: %v", err)
	}
	if _, err := f.s.GetMaterial(ctx, f.p, m.ID); err != nil {
		t.Fatalf("article must stay: %v", err)
	}
	manager := restrictedPrincipal(t, f.pool, authorization.InventoryManage)
	if err := f.s.DeleteMaterial(ctx, manager, m.ID, m.Version, &f.request); err != nil {
		t.Fatalf("manager: %v", err)
	}
}

// digits turns an identifier into a numeric order reference suffix.
func digits(id uuid.UUID) string {
	var b strings.Builder
	for _, c := range id.String() {
		if c >= '0' && c <= '9' {
			b.WriteRune(c)
		}
	}
	return (b.String() + "000000")[:8]
}
