package printing

import (
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
)

func TestSetupRejectsNozzleNumbersOutOfRange(t *testing.T) {
	service := NewService(nil)
	master := authorization.Principal{Master: true}
	tooMany := h2dSetup()
	tooMany.NozzleCount = optional.Of(9)
	zeroUnit := h2dSetup()
	zeroUnit.InputUnits[0].NozzleIndex = optional.Of(0)
	bigSlot := h2dSetup()
	bigSlot.InputUnits[0].Slots[0].NozzleIndex = optional.Of(9)
	for name, input := range map[string]SetupInput{"count": tooMany, "unit": zeroUnit, "slot": bigSlot} {
		if _, err := service.SaveSetup(t.Context(), master, ids.New(), input, nil); !apperror.IsCode(err, "validation_failed") {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestSetupStoresNozzlesAndKeepsThemWhenOmitted(t *testing.T) {
	f := newSetupFixture(t)
	input := h2dSetup()
	input.NozzleCount = optional.Of(2)
	input.InputUnits[1].NozzleIndex = optional.Of(2)
	created := f.mustSave(0, input)
	if created.NozzleCount != 2 {
		t.Fatalf("nozzle count = %d", created.NozzleCount)
	}
	units := activeUnits(created)
	if units[0].NozzleIndex != 1 || units[1].NozzleIndex != 2 {
		t.Fatalf("unit nozzles = %d, %d", units[0].NozzleIndex, units[1].NozzleIndex)
	}
	// A new slot takes its unit's nozzle.
	if slots := slotsOf(created, units[1].ID); len(slots) != 1 || slots[0].NozzleIndex != 2 {
		t.Fatalf("slots of the second unit = %+v", slots)
	}
	// Saving again without nozzle fields keeps everything.
	again := h2dSetup()
	again.InputUnits[0].ID, again.InputUnits[1].ID = &units[0].ID, &units[1].ID
	first, second := slotsOf(created, units[0].ID), slotsOf(created, units[1].ID)
	again.InputUnits[0].Slots[0].ID, again.InputUnits[0].Slots[1].ID = &first[0].ID, &first[1].ID
	again.InputUnits[1].Slots[0].ID = &second[0].ID
	kept := f.mustSave(created.Version, again)
	if kept.NozzleCount != 2 || activeUnits(kept)[1].NozzleIndex != 2 || slotsOf(kept, units[1].ID)[0].NozzleIndex != 2 {
		t.Fatalf("kept = %+v", kept)
	}
	// One nozzle less leaves the second unit pointing past the printer's nozzles.
	fewer := again
	fewer.NozzleCount = optional.Of(1)
	if _, err := f.save(kept.Version, fewer); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("index above count: %v", err)
	}
}
