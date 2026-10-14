package parser

import (
	"math"
	"strings"
	"testing"
)

func TestEstimateGCodeTracksToolsCategoriesG92AndRetractions(t *testing.T) {
	t.Parallel()

	diameter, density := 1.75, 1.24
	gcode := strings.NewReader(`
M82
G92 E0
;TYPE:External perimeter
G1 X1 E10
G1 E8
G1 E10
M620 S7A
;TYPE:Wipe tower
G1 E15
T1
M83
M620 S9A
;TYPE:Sparse infill
G1 E4
G1 E-1
G1 E1
G1 E2
`)
	estimate, err := EstimateGCode(gcode, GCodeOptions{Filaments: []GCodeFilament{
		{ID: "0", DiameterMM: &diameter, DensityGCM3: &density},
		{ID: "7", DiameterMM: &diameter, DensityGCM3: &density},
		{ID: "9", DiameterMM: &diameter, DensityGCM3: &density},
	}})
	if err != nil {
		t.Fatalf("EstimateGCode: %v", err)
	}
	if !estimate.Resolved || estimate.Quality != QualityHigh || len(estimate.Filaments) != 3 {
		t.Fatalf("estimate = %+v", estimate)
	}
	// Tool 0 starts on filament 0 for 10 mm, unretracts 2 mm without adding
	// consumption, then selects filament 7 and purges 5 mm.
	assertLengths(t, estimate.Filaments[0], 10, 10, 0, 0)
	assertLengths(t, estimate.Filaments[1], 5, 0, 5, 0)
	// Relative tool 1 extrudes 4 mm model, retracts/unretracts, then 2 mm model.
	assertLengths(t, estimate.Filaments[2], 6, 6, 0, 0)
	wantGrams := lengthToGrams(5, diameter, density)
	if estimate.Filaments[1].WeightGrams == nil || math.Abs(*estimate.Filaments[1].WeightGrams-wantGrams) > 1e-9 {
		t.Fatalf("grams = %v, want %v", estimate.Filaments[1].WeightGrams, wantGrams)
	}
}

func TestEstimateGCodeUsesConservativeProgressCheckpoint(t *testing.T) {
	t.Parallel()

	fullLength, fullWeight := 100.0, 3.0
	progress := 50.0
	gcode := strings.NewReader(`
M83
;TYPE:External perimeter
G1 E10
M73 P25
G1 E30
M73 P50
G1 E60
M73 P75
`)
	estimate, err := EstimateGCode(gcode, GCodeOptions{
		LastReliableProgress: &progress,
		Filaments:            []GCodeFilament{{ID: "0", FullLengthMM: &fullLength, FullWeightGrams: &fullWeight}},
	})
	if err != nil {
		t.Fatalf("EstimateGCode: %v", err)
	}
	if !estimate.Resolved || estimate.Quality != QualityMedium {
		t.Fatalf("estimate = %+v", estimate)
	}
	if estimate.EmbeddedProgress == nil || *estimate.EmbeddedProgress != 50 {
		t.Fatalf("progress = %v", estimate.EmbeddedProgress)
	}
	// The 50% marker follows 40 mm of actual parsed extrusion. The 60 mm
	// after it must not be included and no percent multiplication is used.
	assertLengths(t, estimate.Filaments[0], 40, 40, 0, 0)
	if estimate.Filaments[0].WeightGrams == nil || math.Abs(*estimate.Filaments[0].WeightGrams-1.2) > 1e-9 {
		t.Fatalf("grams = %v", estimate.Filaments[0].WeightGrams)
	}
}

func TestEstimateGCodeUsesLayerAndProgressTogether(t *testing.T) {
	t.Parallel()

	diameter, density := 1.75, 1.24
	layer, progress := 1, 80.0
	gcode := strings.NewReader(`
M83
; layer: 0
;TYPE:External perimeter
G1 E10
M73 P25
; layer: 1
G1 E10
M73 P50
; layer: 2
G1 E10
M73 P75
`)
	estimate, err := EstimateGCode(gcode, GCodeOptions{
		LastReliableLayer: &layer, LastReliableProgress: &progress,
		Filaments: []GCodeFilament{{ID: "0", DiameterMM: &diameter, DensityGCM3: &density}},
	})
	if err != nil {
		t.Fatalf("EstimateGCode: %v", err)
	}
	if estimate.SelectedLayer == nil || *estimate.SelectedLayer != 1 || estimate.EmbeddedProgress == nil || *estimate.EmbeddedProgress != 50 {
		t.Fatalf("selected checkpoint = %+v", estimate)
	}
	assertLengths(t, estimate.Filaments[0], 20, 20, 0, 0)
}

func TestEstimateGCodeLeavesMissingConversionUnresolved(t *testing.T) {
	t.Parallel()

	estimate, err := EstimateGCode(strings.NewReader("M83\nG1 E5\n"), GCodeOptions{})
	if err != nil {
		t.Fatalf("EstimateGCode: %v", err)
	}
	if estimate.Resolved || estimate.Quality != QualityLow || estimate.Filaments[0].WeightGrams != nil {
		t.Fatalf("estimate = %+v", estimate)
	}
}

func TestEstimateGCodeRejectsOverlongLine(t *testing.T) {
	t.Parallel()

	_, err := EstimateGCode(strings.NewReader(";"+strings.Repeat("x", 100)), GCodeOptions{MaxLineBytes: 32})
	if err == nil {
		t.Fatal("expected scanner limit error")
	}
}

func TestEstimateGCodeWithoutCompatibleCheckpointIsUnresolved(t *testing.T) {
	t.Parallel()

	progress := 10.0
	estimate, err := EstimateGCode(strings.NewReader("M83\nG1 E5\nM73 P20\n"), GCodeOptions{LastReliableProgress: &progress})
	if err != nil {
		t.Fatalf("EstimateGCode: %v", err)
	}
	if estimate.Resolved || len(estimate.Warnings) == 0 {
		t.Fatalf("estimate = %+v", estimate)
	}
}

func assertLengths(t *testing.T, item FilamentEstimate, total, model, purge, unclassified float64) {
	t.Helper()
	if item.LengthMM != total || item.ModelLengthMM != model || item.PurgeLengthMM != purge || item.UnclassifiedMM != unclassified {
		t.Fatalf("lengths for filament %q = total %v model %v purge %v unclassified %v", item.FilamentID, item.LengthMM, item.ModelLengthMM, item.PurgeLengthMM, item.UnclassifiedMM)
	}
}
