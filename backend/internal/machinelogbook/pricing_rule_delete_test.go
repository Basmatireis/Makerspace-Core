package machinelogbook

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func (f *variantFixture) groupRules(t *testing.T) []PricingRule {
	t.Helper()
	groups, err := f.s.ListPricingGroups(t.Context(), f.p)
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range groups {
		if g.ID == f.group.ID {
			return g.Rules
		}
	}
	t.Fatal("fixture group missing")
	return nil
}

func TestDeletePricingRuleChecksPermissionVersionAndExistence(t *testing.T) {
	f := newVariantFixture(t)
	ctx := t.Context()
	typeID := f.materialType.ID
	rule, err := f.s.CreatePricingRule(ctx, f.p, f.group.ID, PricingRuleMaterial, nil, &typeID, nil, "0.3", &f.request)
	if err == nil {
		t.Fatal("expected the fixture type rule to exist already")
	}
	rules := f.groupRules(t)
	rule = rules[0]
	reader := restrictedPrincipal(t, f.pool, authorization.PricingRead)
	if err = f.s.DeletePricingRule(ctx, reader, rule.ID, rule.Version, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("delete with pricing.read: %v", err)
	}
	if err = f.s.DeletePricingRule(ctx, f.p, rule.ID, rule.Version+1, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale delete: %v", err)
	}
	if err = f.s.DeletePricingRule(ctx, f.p, ids.New(), 1, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown rule: %v", err)
	}
	if len(f.groupRules(t)) != len(rules) {
		t.Fatal("a refused delete removed a rule")
	}
	if err = f.s.DeletePricingRule(ctx, f.p, rule.ID, rule.Version, &f.request); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.groupRules(t) {
		if r.ID == rule.ID {
			t.Fatal("deleted rule still listed")
		}
	}
	if n := f.count(
		t, `SELECT count(*) FROM audit_events WHERE action = 'pricing_rule.deleted' AND resource_id = $1`, rule.ID,
	); n != 1 {
		t.Fatalf("audit rows: %d", n)
	}
	if err = f.s.DeletePricingRule(ctx, f.p, rule.ID, rule.Version, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("second delete: %v", err)
	}
}

func TestDeletedPricingRuleKeepsItsSnapshotRate(t *testing.T) {
	f := newVariantFixture(t)
	ctx := t.Context()
	input := f.input(-3*time.Hour, time.Hour, "successful")
	input.Usages = []UsageInput{{MaterialID: f.material.ID, Quantity: "10"}}
	job := f.create(t, input)
	if price(job.CalculatedPrice) != "11" {
		t.Fatalf("created price %s", price(job.CalculatedPrice))
	}
	var runtime *PricingRule
	rules := f.groupRules(t)
	for i := range rules {
		if rules[i].Kind == PricingRuleMachineRuntime {
			runtime = &rules[i]
		}
	}
	if runtime == nil {
		t.Fatal("no runtime rule")
	}
	sourced := false
	for _, e := range job.PricingSnapshot.Rules {
		sourced = sourced || (e.SourceRuleID != nil && *e.SourceRuleID == runtime.ID)
	}
	if !sourced {
		t.Fatalf("snapshot does not point at the rule: %+v", job.PricingSnapshot.Rules)
	}
	if err := f.s.DeletePricingRule(ctx, f.p, runtime.ID, runtime.Version, &f.request); err != nil {
		t.Fatal(err)
	}
	after, err := f.s.GetJob(ctx, f.p, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if price(after.CalculatedPrice) != "11" || after.PricingStatus != PricingComplete {
		t.Fatalf("price after delete %s (%s)", price(after.CalculatedPrice), after.PricingStatus)
	}
	found := false
	for _, e := range after.PricingSnapshot.Rules {
		if e.Kind == PricingRuleMachineRuntime {
			found = true
			if e.SourceRuleID != nil || e.Rate == nil || *e.Rate != "10" {
				t.Fatalf("snapshot entry after delete: %+v", e)
			}
		}
	}
	if !found {
		t.Fatal("snapshot lost its runtime entry")
	}
	// A recalculation from the snapshot (usage change) still charges the copied rate.
	run := after.Runs[0]
	result, err := f.s.ReplaceRunUsages(ctx, f.p, run.ID, run.Version, []UsageInput{
		{MaterialID: f.material.ID, Quantity: "20"},
	}, &f.request)
	if err != nil || result.Job == nil {
		t.Fatalf("usage change: %v", err)
	}
	if price(result.Job.CalculatedPrice) != "12" {
		t.Fatalf("recalculated price %s, want 12", price(result.Job.CalculatedPrice))
	}
}

func TestMaterialTypeDeletionTakesVariantsAndRulesButNotMaterials(t *testing.T) {
	f := newVariantFixture(t)
	ctx := t.Context()
	other, err := f.s.CreateMaterialType(ctx, f.p, "Doomed "+f.suffix, KindFilament, "g",
		[]uuid.UUID{f.machine.Process.ID}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	matte := f.variant(t, other.ID, "Matte")
	if _, err = f.s.CreatePricingRuleWithVariant(
		ctx, f.p, f.group.ID, PricingRuleMaterial, nil, &other.ID, nil, nil, "0.1", &f.request,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.CreatePricingRuleWithVariant(
		ctx, f.p, f.group.ID, PricingRuleMaterial, nil, &other.ID, &matte.ID, nil, "0.2", &f.request,
	); err != nil {
		t.Fatal(err)
	}
	if err = f.s.DeleteMaterialType(ctx, f.p, other.ID, other.Version, &f.request); err != nil {
		t.Fatalf("delete type with rules and variants: %v", err)
	}
	if n := f.count(t, `SELECT count(*) FROM pricing_rules WHERE material_type_id = $1`, other.ID); n != 0 {
		t.Fatalf("rules left: %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM material_type_variants WHERE material_type_id = $1`, other.ID); n != 0 {
		t.Fatalf("variants left: %d", n)
	}
	var rulesRemoved, variantsRemoved string
	if err = f.pool.QueryRow(
		ctx,
		`SELECT metadata->>'countPricingRulesRemoved', metadata->>'countVariantsRemoved'
		 FROM audit_events WHERE action = 'material_type.deleted' AND resource_id = $1`,
		other.ID,
	).Scan(&rulesRemoved, &variantsRemoved); err != nil || rulesRemoved != "2" || variantsRemoved != "1" {
		t.Fatalf("audit counts %q %q: %v", rulesRemoved, variantsRemoved, err)
	}

	// A deleted article still blocks its type.
	kept, err := f.s.CreateMaterialType(ctx, f.p, "Kept "+f.suffix, KindFilament, "g",
		[]uuid.UUID{f.machine.Process.ID}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	article := f.article(t, MaterialInput{Name: "Gone " + f.suffix, MaterialTypeID: kept.ID})
	if _, err = f.pool.Exec(ctx, `UPDATE materials SET deleted_at = now() WHERE id = $1`, article.ID); err != nil {
		t.Fatal(err)
	}
	if err = f.s.DeleteMaterialType(ctx, f.p, kept.ID, kept.Version, &f.request); !apperror.IsCode(err, "material_type_in_use") {
		t.Fatalf("type with a deleted article: %v", err)
	}
}
