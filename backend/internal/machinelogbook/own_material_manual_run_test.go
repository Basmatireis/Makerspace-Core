package machinelogbook

import (
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func TestOwnMaterialMayNameATypeAndALabelAndIsNeverCharged(t *testing.T) {
	f := newJobFixture(t)
	label := "Prusament Galaxy Black"
	input := f.input(-2*time.Hour, time.Hour, JobOutcomeSuccessful)
	input.Usages = []UsageInput{
		{Ownership: OwnershipExternal, MaterialTypeID: &f.materialType.ID, Label: &label, Quantity: "40", QuantityBasis: QuantityBasisEstimated},
		{Ownership: OwnershipExternal, Quantity: "5"},
	}
	job := f.create(t, input)
	usages := job.Runs[0].Usages
	if len(usages) != 2 {
		t.Fatalf("usages = %+v", usages)
	}
	var typed, bare MachineJobUsage
	for _, u := range usages {
		if u.Label != nil {
			typed = u
		} else {
			bare = u
		}
	}
	if typed.Label == nil || *typed.Label != label || typed.MaterialName != label || typed.MaterialTypeID == nil ||
		*typed.MaterialTypeID != f.materialType.ID || typed.MaterialTypeName != f.materialType.Name || typed.MaterialID != nil {
		t.Fatalf("typed own material = %+v", typed)
	}
	if bare.MaterialName != "Own material" || bare.MaterialTypeName != "External" || bare.MaterialTypeID != nil || bare.Unit != "g" {
		t.Fatalf("bare own material = %+v", bare)
	}
	// Manual runs record measured material whatever the request says.
	if typed.QuantityBasis != QuantityBasisActual {
		t.Fatalf("manual run basis = %s", typed.QuantityBasis)
	}
	// Runtime is 1 h at 10 EUR; own material adds nothing although its type has a material rate.
	if price(job.EffectivePrice) != "10" {
		t.Fatalf("price = %s", price(job.EffectivePrice))
	}
	unknown := ids.New()
	bad := f.input(-2*time.Hour, time.Hour, JobOutcomeSuccessful)
	bad.Usages = []UsageInput{{Ownership: OwnershipExternal, MaterialTypeID: &unknown, Quantity: "1"}}
	if _, err := f.s.CreateManualJob(t.Context(), f.p, bad, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("unknown type: %v", err)
	}
	bad.Usages = []UsageInput{{Ownership: OwnershipMakerspace, MaterialID: f.material.ID, Label: &label, Quantity: "1"}}
	if _, err := f.s.CreateManualJob(t.Context(), f.p, bad, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("label on makerspace material: %v", err)
	}
	tooLong := strings.Repeat("x", MaxUsageLabelLength+1)
	bad.Usages = []UsageInput{{Ownership: OwnershipExternal, Label: &tooLong, Quantity: "1"}}
	if _, err := f.s.CreateManualJob(t.Context(), f.p, bad, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("label too long: %v", err)
	}
}

func TestManualRunStartsNowByDefaultAndNeverInTheFuture(t *testing.T) {
	f := newJobFixture(t)
	input := f.input(0, time.Hour, JobOutcomeUnknown)
	input.StartsAt = time.Time{}
	job := f.create(t, input)
	if job.StartedAt == nil || !job.StartedAt.Equal(f.now.Truncate(time.Second)) {
		t.Fatalf("started = %v, want %v", job.StartedAt, f.now)
	}
	future := f.input(2*time.Hour, time.Hour, JobOutcomeUnknown)
	if _, err := f.s.CreateManualJob(t.Context(), f.p, future, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("future start: %v", err)
	}
	_, err := f.s.AddManualRun(t.Context(), f.p, job.ID, job.Version, ManualRunInput{
		StartsAt: f.now.Add(time.Hour),
		EndsAt:   f.now.Add(2 * time.Hour),
	}, &f.request)
	if !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("future run: %v", err)
	}
}
