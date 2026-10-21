package machinelogbook

import (
	"context"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

type quoteFixture struct {
	*jobFixture
	second, partial, inactive PricingGroup
	saleMaterial              Material
}

func newQuoteFixture(t *testing.T) *quoteFixture {
	t.Helper()
	f := &quoteFixture{jobFixture: newJobFixture(t)}
	ctx := t.Context()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	typeID, materialTypeID := f.machine.MachineType.ID, f.materialType.ID
	suffix := f.person.String()[:8]
	newGroup := func(name string) PricingGroup {
		group, err := f.s.CreatePricingGroup(ctx, f.p, "Quote "+name+" "+suffix, nil, false, &f.request)
		must(err)
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, _ = f.pool.Exec(cleanup, `DELETE FROM pricing_groups WHERE id = $1`, group.ID)
		})
		return group
	}
	rule := func(group PricingGroup, kind PricingRuleKind, rate string) {
		var machineType, materialType *uuid.UUID
		if kind == PricingRuleMachineRuntime {
			machineType = &typeID
		} else {
			materialType = &materialTypeID
		}
		_, err := f.s.CreatePricingRule(ctx, f.p, group.ID, kind, machineType, materialType, nil, rate, &f.request)
		must(err)
	}
	f.second = newGroup("second")
	rule(f.second, PricingRuleMachineRuntime, "1.25")
	rule(f.second, PricingRuleMaterial, "0.015")
	f.partial = newGroup("partial")
	rule(f.partial, PricingRuleMachineRuntime, "7")
	f.inactive = newGroup("inactive")
	rule(f.inactive, PricingRuleMachineRuntime, "99")
	var err error
	f.inactive, err = f.s.UpdatePricingGroup(
		ctx,
		f.p,
		f.inactive.ID,
		f.inactive.Version,
		f.inactive.Name,
		nil,
		false,
		false,
		&f.request,
	)
	must(err)
	sale := "2.5"
	f.saleMaterial, err = f.s.CreateMaterial(
		ctx,
		f.p,
		MaterialInput{Name: "Quote PLA " + suffix, MaterialTypeID: materialTypeID, SalePrice: &sale},
		&f.request,
	)
	must(err)
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = f.pool.Exec(cleanup, `DELETE FROM inventory_transactions WHERE material_id = $1`, f.saleMaterial.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM materials WHERE id = $1`, f.saleMaterial.ID)
	})
	return f
}

func (f *quoteFixture) quote(t *testing.T, in PriceQuoteInput) PriceQuote {
	t.Helper()
	quote, err := f.s.QuotePrice(t.Context(), f.p, in)
	if err != nil {
		t.Fatal(err)
	}
	return quote
}

func (q PriceQuote) group(t *testing.T, id uuid.UUID) PriceQuoteGroup {
	t.Helper()
	for _, g := range q.Groups {
		if g.PricingGroupID == id {
			return g
		}
	}
	t.Fatalf("group %s missing from quote", id)
	return PriceQuoteGroup{}
}

func text(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

func TestQuotePriceMachineOnly(t *testing.T) {
	f := newQuoteFixture(t)
	quote := f.quote(t, PriceQuoteInput{MachineID: &f.machine.ID, Hours: ptr("2.5")})
	if quote.Machine == nil || quote.Machine.ID != f.machine.ID || quote.Material != nil ||
		text(quote.Hours) != "2.5" || quote.Quantity != nil || quote.SaleAmount != nil {
		t.Fatalf("unexpected quote header: %+v", quote)
	}
	first, second := quote.group(t, f.group.ID), quote.group(t, f.second.ID)
	if text(first.MachineRate) != "10" || text(first.MachineAmount) != "25" || text(first.Total) != "25" ||
		!first.Complete || first.MaterialRate != nil || first.MaterialAmount != nil {
		t.Fatalf("first group: %+v", first)
	}
	if text(second.MachineRate) != "1.25" || text(second.MachineAmount) != "3.13" || text(second.Total) != "3.13" {
		t.Fatalf("second group: %+v", second)
	}
	for _, g := range quote.Groups {
		if g.PricingGroupID == f.inactive.ID {
			t.Fatal("inactive group is quoted")
		}
	}
}

func TestQuotePriceGroupsAreOrderedDefaultFirstThenByName(t *testing.T) {
	f := newQuoteFixture(t)
	quote := f.quote(t, PriceQuoteInput{MachineID: &f.machine.ID, Hours: ptr("1")})
	seenNonDefault := false
	for i, g := range quote.Groups {
		if g.IsDefault && seenNonDefault {
			t.Fatalf("default group at %d after a non-default one", i)
		}
		if !g.IsDefault {
			seenNonDefault = true
		}
	}
	index := map[uuid.UUID]int{}
	for i, g := range quote.Groups {
		index[g.PricingGroupID] = i
	}
	// "Quote partial ..." sorts before "Quote second ..." whatever the collation.
	if index[f.partial.ID] > index[f.second.ID] {
		t.Fatal("groups are not ordered by name")
	}
}

func TestQuotePriceArticleOnlyIncludesSaleAmount(t *testing.T) {
	f := newQuoteFixture(t)
	quote := f.quote(t, PriceQuoteInput{MaterialID: &f.saleMaterial.ID, Quantity: ptr("100")})
	if quote.Machine != nil || quote.Material == nil || text(quote.Quantity) != "100" || quote.Hours != nil ||
		text(quote.SaleAmount) != "250" || text(quote.Material.SalePrice) != "2.5" ||
		quote.Material.Unit != "g" || text(quote.Material.MaterialTypeName) != f.materialType.Name {
		t.Fatalf("unexpected quote: %+v material %+v", quote, quote.Material)
	}
	first, second, partial := quote.group(t, f.group.ID), quote.group(t, f.second.ID), quote.group(t, f.partial.ID)
	if text(first.MaterialRate) != "0.1" || text(first.MaterialAmount) != "10" || text(first.Total) != "10" ||
		first.MachineRate != nil {
		t.Fatalf("first group: %+v", first)
	}
	if text(second.MaterialAmount) != "1.5" || text(second.Total) != "1.5" || !second.Complete {
		t.Fatalf("second group: %+v", second)
	}
	if partial.MaterialRate != nil || partial.MaterialAmount != nil || partial.Total != nil || partial.Complete {
		t.Fatalf("partial group has no material rate: %+v", partial)
	}
	noSale := f.quote(t, PriceQuoteInput{MaterialID: &f.material.ID, Quantity: ptr("1")})
	if noSale.SaleAmount != nil || noSale.Material.SalePrice != nil {
		t.Fatalf("article without sale price: %+v", noSale)
	}
}

func TestQuotePriceCombinedTotalRoundsOnce(t *testing.T) {
	f := newQuoteFixture(t)
	quote := f.quote(
		t,
		PriceQuoteInput{
			MachineID:  &f.machine.ID,
			Hours:      ptr("0.14"),
			MaterialID: &f.material.ID,
			Quantity:   ptr("3"),
		},
	)
	// 0.14 h x 1.25 = 0.175 and 3 x 0.015 = 0.045: parts round to 0.18 and 0.05,
	// the total rounds the exact sum 0.22 once.
	second := quote.group(t, f.second.ID)
	if text(second.MachineAmount) != "0.18" || text(second.MaterialAmount) != "0.05" ||
		text(second.Total) != "0.22" || !second.Complete {
		t.Fatalf("second group: %+v", second)
	}
	first := quote.group(t, f.group.ID)
	if text(first.Total) != "1.7" {
		t.Fatalf("first group total: %+v", first)
	}
}

func TestQuotePriceMissingRateLeavesPartAndTotalEmpty(t *testing.T) {
	f := newQuoteFixture(t)
	quote := f.quote(
		t,
		PriceQuoteInput{
			MachineID:  &f.machine.ID,
			Hours:      ptr("2"),
			MaterialID: &f.material.ID,
			Quantity:   ptr("10"),
		},
	)
	partial := quote.group(t, f.partial.ID)
	if text(partial.MachineAmount) != "14" || partial.MaterialRate != nil || partial.MaterialAmount != nil ||
		partial.Total != nil || partial.Complete {
		t.Fatalf("partial group: %+v", partial)
	}
	bare := f.quote(t, PriceQuoteInput{MachineID: &f.bareMachine.ID, Hours: ptr("1")})
	if g := bare.group(t, f.group.ID); g.MachineRate != nil || g.Total != nil || g.Complete {
		t.Fatalf("machine type without runtime rule: %+v", g)
	}
}

func TestQuotePriceIgnoresInactiveRules(t *testing.T) {
	f := newQuoteFixture(t)
	ctx := t.Context()
	groups, err := f.s.ListPricingGroups(ctx, f.p)
	if err != nil {
		t.Fatal(err)
	}
	var r PricingRule
	for _, g := range groups {
		if g.ID == f.partial.ID {
			r = g.Rules[0]
		}
	}
	if _, err = f.s.UpdatePricingRule(
		ctx, f.p, r.ID, r.Version, r.Kind, r.MachineTypeID, r.MaterialTypeID, r.Measure, "7", false, &f.request,
	); err != nil {
		t.Fatal(err)
	}
	quote := f.quote(t, PriceQuoteInput{MachineID: &f.machine.ID, Hours: ptr("1")})
	if g := quote.group(t, f.partial.ID); g.MachineRate != nil || g.Complete {
		t.Fatalf("inactive rule priced: %+v", g)
	}
}

func TestQuotePriceValidation(t *testing.T) {
	f := newQuoteFixture(t)
	unknown := ids.New()
	tests := []struct {
		name string
		in   PriceQuoteInput
		code string
	}{
		{"nothing requested", PriceQuoteInput{}, "validation_failed"},
		{"machine without hours", PriceQuoteInput{MachineID: &f.machine.ID}, "validation_failed"},
		{"hours without machine", PriceQuoteInput{MaterialID: &f.material.ID, Quantity: ptr("1"), Hours: ptr("1")},
			"validation_failed"},
		{"article without quantity", PriceQuoteInput{MaterialID: &f.material.ID}, "validation_failed"},
		{"quantity without article", PriceQuoteInput{MachineID: &f.machine.ID, Hours: ptr("1"), Quantity: ptr("1")},
			"validation_failed"},
		{"negative hours", PriceQuoteInput{MachineID: &f.machine.ID, Hours: ptr("-1")}, "validation_failed"},
		{"negative quantity", PriceQuoteInput{MaterialID: &f.material.ID, Quantity: ptr("-0.5")}, "validation_failed"},
		{"hours not a number", PriceQuoteInput{MachineID: &f.machine.ID, Hours: ptr("abc")}, "validation_failed"},
		{"unknown machine", PriceQuoteInput{MachineID: &unknown, Hours: ptr("1")}, "not_found"},
		{"unknown article", PriceQuoteInput{MaterialID: &unknown, Quantity: ptr("1")}, "not_found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := f.s.QuotePrice(t.Context(), f.p, tt.in); !apperror.IsCode(err, tt.code) {
				t.Fatalf("want %s, got %v", tt.code, err)
			}
		})
	}
	zero := f.quote(t, PriceQuoteInput{MachineID: &f.machine.ID, Hours: ptr("0")})
	if g := zero.group(t, f.group.ID); text(g.Total) != "0" || !g.Complete {
		t.Fatalf("zero hours: %+v", g)
	}
}

func TestQuotePriceRequiresItsPermissions(t *testing.T) {
	f := newQuoteFixture(t)
	machine := PriceQuoteInput{MachineID: &f.machine.ID, Hours: ptr("1")}
	article := PriceQuoteInput{MaterialID: &f.material.ID, Quantity: ptr("1")}
	both := PriceQuoteInput{MachineID: &f.machine.ID, Hours: ptr("1"), MaterialID: &f.material.ID, Quantity: ptr("1")}
	tests := []struct {
		name        string
		permissions []authorization.Permission
		in          PriceQuoteInput
		allowed     bool
	}{
		{"no pricing.read", []authorization.Permission{authorization.MachinesRead, authorization.InventoryRead}, both, false},
		{"machine without machines.read", []authorization.Permission{authorization.PricingRead}, machine, false},
		{"article without inventory.read", []authorization.Permission{authorization.PricingRead}, article, false},
		{"both without inventory.read", []authorization.Permission{authorization.PricingRead, authorization.MachinesRead}, both, false},
		{"machine allowed", []authorization.Permission{authorization.PricingRead, authorization.MachinesRead}, machine, true},
		{"article allowed", []authorization.Permission{authorization.PricingRead, authorization.InventoryRead}, article, true},
		{"both allowed", []authorization.Permission{authorization.PricingRead, authorization.MachinesRead, authorization.InventoryRead}, both, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := restrictedPrincipal(t, f.pool, tt.permissions...)
			_, err := f.s.QuotePrice(t.Context(), p, tt.in)
			if tt.allowed && err != nil {
				t.Fatal(err)
			}
			if !tt.allowed && !apperror.IsCode(err, "permission_denied") {
				t.Fatalf("want permission_denied, got %v", err)
			}
		})
	}
}
