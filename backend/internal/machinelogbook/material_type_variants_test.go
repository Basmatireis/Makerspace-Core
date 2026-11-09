package machinelogbook

import (
	"context"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// variantFixture is a job fixture that removes the articles and types its tests add.
type variantFixture struct {
	*jobFixture
	suffix string
}

func newVariantFixture(t *testing.T) *variantFixture {
	t.Helper()
	f := &variantFixture{jobFixture: newJobFixture(t), suffix: ids.New().String()[24:]}
	// Runs before the cleanup of the job fixture, which then removes its own type and article.
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		articles := `SELECT id FROM materials WHERE id <> $1
			AND (material_type_id = $2 OR material_type_id IN (SELECT id FROM material_types WHERE name LIKE '%' || $3))`
		_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_runs WHERE machine_id = $1`, f.machine.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_jobs WHERE machine_id = $1`, f.machine.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM pricing_groups WHERE id = $1`, f.group.ID)
		_, _ = f.pool.Exec(
			cleanup,
			`DELETE FROM inventory_transactions WHERE material_id IN (`+articles+`)`,
			f.material.ID,
			f.materialType.ID,
			f.suffix,
		)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM materials WHERE id IN (`+articles+`)`, f.material.ID, f.materialType.ID, f.suffix)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM material_types WHERE name LIKE '%' || $1`, f.suffix)
	})
	return f
}

func (f *variantFixture) article(t *testing.T, in MaterialInput) Material {
	t.Helper()
	if in.MaterialTypeID == uuid.Nil {
		in.MaterialTypeID = f.materialType.ID
	}
	material, err := f.s.CreateMaterial(t.Context(), f.p, in, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return material
}

func (f *variantFixture) variant(t *testing.T, typeID uuid.UUID, name string) MaterialTypeVariant {
	t.Helper()
	variant, err := f.s.CreateMaterialTypeVariant(t.Context(), f.p, typeID, name, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return variant
}

func (f *variantFixture) typeVariants(t *testing.T, typeID uuid.UUID) []MaterialTypeVariant {
	t.Helper()
	materialType, err := f.s.GetMaterialType(t.Context(), f.p, typeID)
	if err != nil {
		t.Fatal(err)
	}
	return materialType.Variants
}

func (f *variantFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(t.Context(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestMaterialTypeVariantsAreManagedPerType(t *testing.T) {
	f := newVariantFixture(t)
	ctx := t.Context()
	typeID := f.materialType.ID

	matte := f.variant(t, typeID, "  Matte ")
	if matte.Name != "Matte" || matte.MaterialTypeID != typeID || matte.MaterialCount != 0 || matte.PricingRuleCount != 0 {
		t.Fatalf("created variant: %+v", matte)
	}
	if _, err := f.s.CreateMaterialTypeVariant(ctx, f.p, typeID, "matte", &f.request); !apperror.IsCode(
		err,
		"material_type_variant_exists",
	) {
		t.Fatalf("duplicate ignoring case: %v", err)
	}
	if _, err := f.s.CreateMaterialTypeVariant(ctx, f.p, typeID, "   ", &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("empty name: %v", err)
	}
	if _, err := f.s.CreateMaterialTypeVariant(ctx, f.p, ids.New(), "Silk", &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown type: %v", err)
	}
	part, err := f.s.CreateMaterialType(ctx, f.p, "Variant parts "+f.suffix, KindPart, "piece", nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.CreateMaterialTypeVariant(ctx, f.p, part.ID, "Small", &f.request); !apperror.IsCode(
		err,
		"material_type_variant_not_allowed",
	) {
		t.Fatalf("variant of a part type: %v", err)
	}
	f.variant(t, typeID, "silk")
	basic := f.variant(t, typeID, "Basic")
	var names []string
	for _, v := range f.typeVariants(t, typeID) {
		names = append(names, v.Name)
	}
	if len(names) != 3 || names[0] != "Basic" || names[1] != "Matte" || names[2] != "silk" {
		t.Fatalf("variants by name ignoring case: %v", names)
	}
	if len(f.typeVariants(t, part.ID)) != 0 {
		t.Fatal("a part type lists variants")
	}

	renamed, err := f.s.UpdateMaterialTypeVariant(ctx, f.p, typeID, basic.ID, " Basic+ ", &f.request)
	if err != nil || renamed.Name != "Basic+" {
		t.Fatalf("rename: %+v %v", renamed, err)
	}
	if _, err = f.s.UpdateMaterialTypeVariant(ctx, f.p, typeID, basic.ID, "MATTE", &f.request); !apperror.IsCode(
		err,
		"material_type_variant_exists",
	) {
		t.Fatalf("rename onto another variant: %v", err)
	}
	if _, err = f.s.UpdateMaterialTypeVariant(ctx, f.p, part.ID, basic.ID, "Other", &f.request); !apperror.IsCode(
		err,
		"not_found",
	) {
		t.Fatalf("variant of another type: %v", err)
	}
	if err = f.s.DeleteMaterialTypeVariant(ctx, f.p, part.ID, basic.ID, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("delete through another type: %v", err)
	}
	if err = f.s.DeleteMaterialTypeVariant(ctx, f.p, typeID, basic.ID, &f.request); err != nil {
		t.Fatal(err)
	}
	if err = f.s.DeleteMaterialTypeVariant(ctx, f.p, typeID, basic.ID, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("second delete: %v", err)
	}
	for action, want := range map[string]int{
		"material_type.variant_created": 3,
		"material_type.variant_renamed": 1,
		"material_type.variant_deleted": 1,
	} {
		if got := f.count(
			t,
			`SELECT count(*) FROM audit_events WHERE action = $1 AND resource_type = 'material_type' AND resource_id = $2
			   AND metadata->>'variantId' IS NOT NULL`,
			action,
			typeID,
		); got != want {
			t.Fatalf("%s audit rows = %d, want %d", action, got, want)
		}
	}

	// A type with variants cannot become a part category.
	consumable, err := f.s.CreateMaterialType(ctx, f.p, "Variant consumable "+f.suffix, KindConsumable, "g",
		[]uuid.UUID{f.machine.Process.ID}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	f.variant(t, consumable.ID, "Coarse")
	if _, err = f.s.UpdateMaterialType(ctx, f.p, consumable.ID, consumable.Version, consumable.Name, KindPart, "g", nil,
		true, &f.request); !apperror.IsCode(err, "material_type_in_use") {
		t.Fatalf("type with variants becomes a part category: %v", err)
	}
}

func TestMaterialTypeVariantWritesNeedArticlesManage(t *testing.T) {
	f := newVariantFixture(t)
	ctx := t.Context()
	typeID := f.materialType.ID
	existing := f.variant(t, typeID, "Kept")
	reader := restrictedPrincipal(t, f.pool, authorization.InventoryRead)
	if _, err := f.s.CreateMaterialTypeVariant(ctx, reader, typeID, "Silk", &f.request); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("create with inventory.read: %v", err)
	}
	if _, err := f.s.UpdateMaterialTypeVariant(ctx, reader, typeID, existing.ID, "Renamed", &f.request); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("rename with inventory.read: %v", err)
	}
	if err := f.s.DeleteMaterialTypeVariant(ctx, reader, typeID, existing.ID, &f.request); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("delete with inventory.read: %v", err)
	}
	if _, err := f.s.MaterialTypeVariantTx(ctx, nil, reader, typeID, "Silk", &f.request); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("find-or-create with inventory.read: %v", err)
	}
	// Reading the type still lists the variant.
	materialType, err := f.s.GetMaterialType(ctx, reader, typeID)
	if err != nil || len(materialType.Variants) != 1 || materialType.Variants[0].Name != "Kept" {
		t.Fatalf("read with inventory.read: %+v %v", materialType.Variants, err)
	}
	manager := restrictedPrincipal(t, f.pool, authorization.InventoryRead, authorization.InventoryArticlesManage)
	if _, err = f.s.CreateMaterialTypeVariant(ctx, manager, typeID, "Silk", &f.request); err != nil {
		t.Fatalf("create with inventory.articles.manage: %v", err)
	}
}

func TestArticleVariantNamesResolveToTheVariantsOfTheirType(t *testing.T) {
	f := newVariantFixture(t)
	ctx := t.Context()
	typeID, typeName := f.materialType.ID, f.materialType.Name

	red := f.article(t, MaterialInput{Variant: strPtr(" silk "), ColorName: strPtr("Red")})
	if red.Variant == nil || *red.Variant != "silk" || red.VariantID == nil || red.Name != typeName+" silk · Red" {
		t.Fatalf("first article: %+v", red)
	}
	blue := f.article(t, MaterialInput{Variant: strPtr("SILK"), ColorName: strPtr("Blue")})
	if blue.VariantID == nil || *blue.VariantID != *red.VariantID || *blue.Variant != "silk" ||
		blue.Name != typeName+" silk · Blue" {
		t.Fatalf("same name in another case: %+v", blue)
	}
	typed := f.article(t, MaterialInput{Name: "Typed silk " + f.suffix, Variant: strPtr("silk")})
	plain := f.article(t, MaterialInput{ColorName: strPtr("Green")})
	if plain.VariantID != nil || plain.Variant != nil {
		t.Fatalf("article without a variant: %+v", plain)
	}
	variants := f.typeVariants(t, typeID)
	if len(variants) != 1 || variants[0].Name != "silk" || variants[0].MaterialCount != 3 {
		t.Fatalf("variants after two spellings: %+v", variants)
	}
	listed, _, _, err := f.s.ListMaterials(ctx, f.p, "Typed silk "+f.suffix, nil, "", "", 1, 10)
	if err != nil || len(listed) != 1 || listed[0].VariantID == nil || *listed[0].VariantID != *red.VariantID {
		t.Fatalf("listed article: %+v %v", listed, err)
	}

	// A part never gets a variant.
	part, err := f.s.CreateMaterialType(ctx, f.p, "Variant parts "+f.suffix, KindPart, "piece", nil, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	insert := f.article(t, MaterialInput{Name: "Insert " + f.suffix, MaterialTypeID: part.ID, Variant: strPtr("M3")})
	if insert.Variant != nil || insert.VariantID != nil || len(f.typeVariants(t, part.ID)) != 0 {
		t.Fatalf("part article: %+v", insert)
	}

	// Renaming the variant renames generated article names and keeps typed ones.
	renamed, err := f.s.UpdateMaterialTypeVariant(ctx, f.p, typeID, *red.VariantID, "Silk Shine", &f.request)
	if err != nil || renamed.MaterialCount != 3 {
		t.Fatalf("rename: %+v %v", renamed, err)
	}
	for _, check := range []struct {
		id   uuid.UUID
		name string
	}{
		{red.ID, typeName + " Silk Shine · Red"},
		{blue.ID, typeName + " Silk Shine · Blue"},
		{typed.ID, "Typed silk " + f.suffix},
	} {
		got, getErr := f.s.GetMaterial(ctx, f.p, check.id)
		if getErr != nil || got.Name != check.name || got.Variant == nil || *got.Variant != "Silk Shine" {
			t.Fatalf("after rename: %+v %v, want name %q", got, getErr, check.name)
		}
	}
	if got, _ := f.s.GetMaterial(ctx, f.p, red.ID); got.Version <= red.Version {
		t.Fatalf("renamed article keeps version %d", got.Version)
	}

	// An article moved to another type resolves its variant name there.
	other, err := f.s.CreateMaterialType(ctx, f.p, "Variant PETG "+f.suffix, KindFilament, "g",
		[]uuid.UUID{f.machine.Process.ID}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	current, err := f.s.GetMaterial(ctx, f.p, typed.ID)
	if err != nil {
		t.Fatal(err)
	}
	moved, err := f.s.UpdateMaterial(ctx, f.p, typed.ID, MaterialInput{
		Name:            current.Name,
		MaterialTypeID:  other.ID,
		Variant:         strPtr("silk shine"),
		Active:          true,
		ExpectedVersion: current.Version,
	}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	otherVariants := f.typeVariants(t, other.ID)
	if len(otherVariants) != 1 || moved.VariantID == nil || *moved.VariantID != otherVariants[0].ID ||
		otherVariants[0].Name != "silk shine" {
		t.Fatalf("moved article: %+v variants %+v", moved, otherVariants)
	}

	// A variant used by an article, deleted ones included, stays.
	if err = f.s.DeleteMaterialTypeVariant(ctx, f.p, typeID, *red.VariantID, &f.request); !apperror.IsCode(
		err,
		"material_type_variant_in_use",
	) {
		t.Fatalf("delete a used variant: %v", err)
	}
	if _, err = f.pool.Exec(ctx, `UPDATE materials SET deleted_at = now() WHERE variant_id = $1`, red.VariantID); err != nil {
		t.Fatal(err)
	}
	if err = f.s.DeleteMaterialTypeVariant(ctx, f.p, typeID, *red.VariantID, &f.request); !apperror.IsCode(
		err,
		"material_type_variant_in_use",
	) {
		t.Fatalf("delete a variant of deleted articles: %v", err)
	}
	if got := f.count(
		t,
		`SELECT count(*) FROM audit_events WHERE action = 'material_type.variant_created' AND resource_id = $1`,
		typeID,
	); got != 1 {
		t.Fatalf("variant_created audit rows = %d, want one for the first spelling", got)
	}
}

func TestVariantPricingRulesAreUniquePerVariant(t *testing.T) {
	f := newVariantFixture(t)
	ctx := t.Context()
	typeID := f.materialType.ID
	matte := f.variant(t, typeID, "Matte")
	rule, err := f.s.CreatePricingRuleWithVariant(
		ctx, f.p, f.group.ID, PricingRuleMaterial, nil, &typeID, &matte.ID, nil, "0.2", &f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	if rule.MaterialTypeVariantID == nil || *rule.MaterialTypeVariantID != matte.ID || text(rule.MaterialTypeVariantName) != "Matte" ||
		text(rule.MaterialUnit) != "g" {
		t.Fatalf("variant rule: %+v", rule)
	}
	// The type rule of the fixture and the variant rule coexist; a second active rule of the variant does not.
	if _, err = f.s.CreatePricingRuleWithVariant(
		ctx, f.p, f.group.ID, PricingRuleMaterial, nil, &typeID, &matte.ID, nil, "0.3", &f.request,
	); !apperror.IsCode(err, "already_exists") {
		t.Fatalf("second rule of a variant: %v", err)
	}
	if _, err = f.s.CreatePricingRule(
		ctx, f.p, f.group.ID, PricingRuleMaterial, nil, &typeID, nil, "0.3", &f.request,
	); !apperror.IsCode(err, "already_exists") {
		t.Fatalf("second type rule: %v", err)
	}
	other, err := f.s.CreateMaterialType(ctx, f.p, "Variant PETG "+f.suffix, KindFilament, "g",
		[]uuid.UUID{f.machine.Process.ID}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	foreign := f.variant(t, other.ID, "Glossy")
	if _, err = f.s.CreatePricingRuleWithVariant(
		ctx, f.p, f.group.ID, PricingRuleMaterial, nil, &typeID, &foreign.ID, nil, "0.3", &f.request,
	); !apperror.IsCode(err, "material_type_variant_mismatch") {
		t.Fatalf("variant of another type: %v", err)
	}
	processID := f.machine.Process.ID
	if _, err = f.s.CreatePricingRuleWithVariant(
		ctx, f.p, f.group.ID, PricingRuleMachineRuntime, &processID, nil, &matte.ID, nil, "3", &f.request,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("variant on a runtime rule: %v", err)
	}
	unknown := ids.New()
	if _, err = f.s.CreatePricingRuleWithVariant(
		ctx, f.p, f.group.ID, PricingRuleMaterial, nil, &typeID, &unknown, nil, "0.3", &f.request,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("unknown variant: %v", err)
	}
	// The group lists the rule with the variant's name; the counts include it.
	groups, err := f.s.ListPricingGroups(ctx, f.p)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, group := range groups {
		for _, r := range group.Rules {
			if r.ID == rule.ID {
				found = text(r.MaterialTypeVariantName) == "Matte" && r.MaterialTypeVariantID != nil
			}
		}
	}
	if !found {
		t.Fatal("variant rule missing from its group")
	}
	materialType, err := f.s.GetMaterialType(ctx, f.p, typeID)
	if err != nil || materialType.PricingRuleCount != 2 || materialType.Variants[0].PricingRuleCount != 1 {
		t.Fatalf("counts: %+v %v", materialType, err)
	}
	// A variant with an active rule stays; the count follows the active rules only.
	if err = f.s.DeleteMaterialTypeVariant(ctx, f.p, typeID, matte.ID, &f.request); !apperror.IsCode(
		err,
		"material_type_variant_in_use",
	) {
		t.Fatalf("delete a variant with an active rule: %v", err)
	}
	reader := restrictedPrincipal(t, f.pool, authorization.PricingRead, authorization.InventoryArticlesManage)
	if _, err = f.s.CreatePricingRuleWithVariant(
		ctx, reader, f.group.ID, PricingRuleMaterial, nil, &typeID, &matte.ID, nil, "0.3", &f.request,
	); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("variant rule without pricing.manage: %v", err)
	}
	// Clearing the rate deactivates the rule: it no longer counts, and a new active rule of the variant is allowed.
	rule, err = f.s.UpdatePricingRuleWithVariant(
		ctx, f.p, rule.ID, rule.Version, PricingRuleMaterial, nil, &typeID, &matte.ID, nil, "0.25", false, &f.request,
	)
	if err != nil || rule.Active || rule.MaterialTypeVariantID == nil {
		t.Fatalf("deactivate variant rule: %+v %v", rule, err)
	}
	materialType, err = f.s.GetMaterialType(ctx, f.p, typeID)
	if err != nil || materialType.PricingRuleCount != 2 || materialType.Variants[0].PricingRuleCount != 0 {
		t.Fatalf("counts after clearing: %+v %v", materialType, err)
	}
	second, err := f.s.CreatePricingRuleWithVariant(
		ctx, f.p, f.group.ID, PricingRuleMaterial, nil, &typeID, &matte.ID, nil, "0.3", &f.request,
	)
	if err != nil {
		t.Fatalf("new rule next to an inactive one: %v", err)
	}
	if err = f.s.DeleteMaterialTypeVariant(ctx, f.p, typeID, matte.ID, &f.request); !apperror.IsCode(
		err,
		"material_type_variant_in_use",
	) {
		t.Fatalf("delete with a new active rule: %v", err)
	}
	if _, err = f.s.UpdatePricingRuleWithVariant(
		ctx, f.p, second.ID, second.Version, PricingRuleMaterial, nil, &typeID, &matte.ID, nil, "0.3", false, &f.request,
	); err != nil {
		t.Fatal(err)
	}
	// Only inactive rules left: the variant can go and takes them with it.
	if err = f.s.DeleteMaterialTypeVariant(ctx, f.p, typeID, matte.ID, &f.request); err != nil {
		t.Fatalf("delete a variant with inactive rules only: %v", err)
	}
	if got := f.count(t, `SELECT count(*) FROM pricing_rules WHERE id = ANY($1)`, []uuid.UUID{rule.ID, second.ID}); got != 0 {
		t.Fatalf("rules of the deleted variant left: %d", got)
	}
	if got := f.count(t, `SELECT count(*) FROM material_type_variants WHERE id = $1`, matte.ID); got != 0 {
		t.Fatalf("variant left: %d", got)
	}
	if got := f.count(
		t,
		`SELECT count(*) FROM audit_events WHERE action = 'material_type.variant_deleted' AND resource_id = $1
		   AND metadata->>'countPricingRulesRemoved' = '2'`,
		typeID,
	); got != 1 {
		t.Fatalf("variant_deleted audit rows with the removed rules = %d, want 1", got)
	}
}

func priceIn(t *testing.T, material Material, groupID uuid.UUID) MaterialPrice {
	t.Helper()
	for _, p := range material.Prices {
		if p.PricingGroupID == groupID {
			return p
		}
	}
	t.Fatalf("no price of %s in group %s: %+v", material.Name, groupID, material.Prices)
	return MaterialPrice{}
}

// pricedArticles adds a variant rate (0.2) and three stocked articles to the fixture: one of the variant, one of
// the variant with its own stock price (3), one without a variant. The fixture's type rate is 0.1.
func (f *variantFixture) pricedArticles(t *testing.T) (matte, own, plain Material) {
	t.Helper()
	ctx := t.Context()
	typeID := f.materialType.ID
	variant := f.variant(t, typeID, "Matte")
	if _, err := f.s.CreatePricingRuleWithVariant(
		ctx, f.p, f.group.ID, PricingRuleMaterial, nil, &typeID, &variant.ID, nil, "0.2", &f.request,
	); err != nil {
		t.Fatal(err)
	}
	stocked := func(in MaterialInput) Material {
		material := f.article(t, in)
		result, err := f.s.AddPurchase(
			ctx, f.p, material.ID, material.InventoryVersion, "1000", "20", f.now, nil, nil, nil, &f.request,
		)
		if err != nil {
			t.Fatal(err)
		}
		return result.Material
	}
	matte = stocked(MaterialInput{Variant: strPtr("matte"), ColorName: strPtr("Black")})
	own = stocked(MaterialInput{Variant: strPtr("Matte"), ColorName: strPtr("White")})
	plain = stocked(MaterialInput{ColorName: strPtr("Grey")})
	if _, err := f.s.CreateStockArticlePricingRule(ctx, f.p, f.group.ID, own.ID, "3", &f.request); err != nil {
		t.Fatal(err)
	}
	return matte, own, plain
}

func TestArticlePricesResolveStockArticleThenVariantThenType(t *testing.T) {
	f := newVariantFixture(t)
	ctx := t.Context()
	matte, own, plain := f.pricedArticles(t)
	for _, check := range []struct {
		material Material
		rate     string
		source   MaterialPriceSource
	}{
		{own, "3", PriceFromStockArticle},
		{matte, "0.2", PriceFromMaterialTypeVariant},
		{plain, "0.1", PriceFromMaterialType},
	} {
		material, err := f.s.GetMaterial(ctx, f.p, check.material.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got := priceIn(t, material, f.group.ID); got.Rate != check.rate || got.Source != check.source {
			t.Fatalf("%s price: %+v, want %s from %s", material.Name, got, check.rate, check.source)
		}
		// Quotes use the same order with and without a machine.
		for _, machine := range []*uuid.UUID{nil, &f.machine.ID} {
			in := PriceQuoteInput{MaterialID: &material.ID, Quantity: ptr("10")}
			if machine != nil {
				in.MachineID, in.Hours = machine, ptr("0")
			}
			quote, quoteErr := f.s.QuotePrice(ctx, f.p, in)
			if quoteErr != nil {
				t.Fatal(quoteErr)
			}
			g := quote.group(t, f.group.ID)
			if text(g.MaterialRate) != check.rate || g.MaterialPriceSource == nil || *g.MaterialPriceSource != check.source {
				t.Fatalf("%s quote (machine %v): %+v", material.Name, machine != nil, g)
			}
			if text(quote.Material.Variant) != text(material.Variant) {
				t.Fatalf("quote variant %s, want %s", text(quote.Material.Variant), text(material.Variant))
			}
		}
	}
}

func TestJobPricingUsesArticleThenVariantThenTypeRates(t *testing.T) {
	f := newVariantFixture(t)
	ctx := t.Context()
	matte, own, plain := f.pricedArticles(t)
	input := f.input(-10*time.Hour, time.Hour, "successful")
	input.Usages = []UsageInput{
		{MaterialID: plain.ID, Quantity: "10"},
		{MaterialID: matte.ID, Quantity: "10"},
		{MaterialID: own.ID, Quantity: "10"},
	}
	job := f.create(t, input)
	// 1 h at 10, 10 g at the type rate 0.1, 10 g at the variant rate 0.2, 10 g at the article's own 3.
	if price(job.CalculatedPrice) != "43" || job.PricingStatus != PricingComplete {
		t.Fatalf("job price %s (%s)", price(job.CalculatedPrice), job.PricingStatus)
	}
	kinds := map[PricingRuleKind]int{}
	for _, rule := range job.PricingSnapshot.Rules {
		kinds[rule.Kind]++
	}
	if kinds[PricingRuleStockArticle] != 1 || kinds[PricingRuleMaterial] != 2 {
		t.Fatalf("snapshot entries: %+v", job.PricingSnapshot.Rules)
	}
	// Changing usages reprices from the snapshot; each usage keeps its own level.
	run := job.Runs[0]
	result, err := f.s.ReplaceRunUsages(ctx, f.p, run.ID, run.Version, []UsageInput{
		{MaterialID: plain.ID, Quantity: "10"},
		{MaterialID: matte.ID, Quantity: "20"},
		{MaterialID: own.ID, Quantity: "10"},
	}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Job == nil {
		t.Fatal("usage change returned no job")
	}
	job = *result.Job
	if price(job.CalculatedPrice) != "45" || job.PricingSnapshot.Revision != 1 {
		t.Fatalf("after usage change: %s revision %d", price(job.CalculatedPrice), job.PricingSnapshot.Revision)
	}
	repriced := f.reprice(t, job)
	if price(repriced.CalculatedPrice) != "45" || repriced.PricingSnapshot.Revision != 2 {
		t.Fatalf("repriced: %s revision %d", price(repriced.CalculatedPrice), repriced.PricingSnapshot.Revision)
	}
	// Statistics charge every usage once, at its own level, under the article's type.
	rows, err := machinelogbookdb.New(f.pool).StatisticMaterialChargesByType(
		ctx,
		machinelogbookdb.StatisticMaterialChargesByTypeParams{FromTime: f.now.Add(-24 * time.Hour), ToTime: f.now},
	)
	if err != nil {
		t.Fatal(err)
	}
	charged := ""
	for _, row := range rows {
		if row.Key == f.materialType.ID.String() {
			charged = decimalString(row.Value)
		}
	}
	// 10 x 0.1 + 20 x 0.2 + 10 x 3.
	if charged != "35" {
		t.Fatalf("material charges of the type = %q, want 35", charged)
	}
}
