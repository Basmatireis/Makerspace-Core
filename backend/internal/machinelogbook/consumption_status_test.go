package machinelogbook

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDeriveConsumptionStatusExplainsEveryRecordedRun(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	longAgo := now.Add(-2 * time.Hour)
	recent := now.Add(-5 * time.Minute)
	spool := uuid.New()
	grams := "12.5"
	slot := "2"
	text := func(value string) *string { return &value }
	booked := RunReportedUsageItem{Method: "slicer_complete", Quality: "high", EstimatedQuantityGrams: &grams, SpoolID: &spool}
	unmappedSlot := RunReportedUsageItem{Method: "slicer_complete", Quality: "high", EstimatedQuantityGrams: &grams, SlotExternalID: &slot}
	unmapped := RunReportedUsageItem{Method: "gcode_checkpoint", Quality: "medium", EstimatedQuantityGrams: &grams}
	noWeights := RunReportedUsageItem{Method: "slicer_complete", Quality: "unresolved"}
	noCheckpoint := RunReportedUsageItem{Method: "gcode_checkpoint", Quality: "unresolved"}
	other, zero := uuid.New(), "0"
	segmented := func(segments ...RunReportedUsageSegment) RunReportedUsageItem {
		return RunReportedUsageItem{Method: "gcode_checkpoint", Quality: "medium", EstimatedQuantityGrams: &grams, Segments: segments}
	}
	bookedSegment := RunReportedUsageSegment{Index: 0, EstimatedQuantityGrams: &grams, SpoolID: &spool}
	refilledSegment := RunReportedUsageSegment{Index: 1, EstimatedQuantityGrams: &grams, SpoolID: &other}
	strayedSegment := RunReportedUsageSegment{Index: 1, EstimatedQuantityGrams: &grams, SlotExternalID: &slot}
	emptySegment := RunReportedUsageSegment{Index: 1, EstimatedQuantityGrams: &zero}
	unsplitSegment := RunReportedUsageSegment{Index: 0, SpoolID: &spool}
	ended := func(f ConsumptionFacts) ConsumptionFacts {
		f.Recorded = true
		if f.State == "" {
			f.State = RunStateFinished
		}
		if f.EndedAt == nil {
			f.EndedAt = &longAgo
		}
		return f
	}
	cases := []struct {
		name   string
		facts  ConsumptionFacts
		state  ConsumptionState
		reason ConsumptionReason
		detail string
	}{
		{"running", ConsumptionFacts{Recorded: true, State: RunStateRunning}, ConsumptionPending, ReasonRunInProgress, ""},
		{"running on internal storage", ConsumptionFacts{Recorded: true, State: RunStateRunning, ConnectorState: stringPointer("pending"),
			ConnectorReason: stringPointer("artifact_on_internal_storage"), ConnectorDetail: stringPointer("/data/Metadata/plate_1.gcode")},
			ConsumptionPending, ReasonArtifactOnInternalStorage, "/data/Metadata/plate_1.gcode"},
		{"stored 3MF disproves internal storage", ConsumptionFacts{Recorded: true, State: RunStateRunning, HasArtifact: true,
			ConnectorState: stringPointer("pending"), ConnectorReason: stringPointer("artifact_on_internal_storage")},
			ConsumptionPending, ReasonRunInProgress, ""},
		{"ended with stored 3MF ignores internal storage", ended(ConsumptionFacts{HasArtifact: true,
			ConnectorState: stringPointer("unavailable"), ConnectorReason: stringPointer("artifact_on_internal_storage")}),
			ConsumptionMissing, ReasonConsumptionNotReported, ""},
		{"ended, uploaded 3MF replaces internal storage by the recompute report", ended(ConsumptionFacts{HasArtifact: true,
			Items: []RunReportedUsageItem{booked}, MachineUsages: 1,
			ConnectorState: stringPointer("reported"), ConnectorReason: stringPointer("artifact_on_internal_storage")}),
			ConsumptionRecorded, "", ""},
		{"ended, uploaded 3MF while the connector still said internal storage while pending", ended(ConsumptionFacts{HasArtifact: true,
			ConnectorState: stringPointer("pending"), ConnectorReason: stringPointer("artifact_on_internal_storage")}),
			ConsumptionMissing, ReasonConsumptionNotReported, ""},
		{"running with another connector reason", ConsumptionFacts{Recorded: true, State: RunStateRunning, ConnectorState: stringPointer("pending"),
			ConnectorReason: stringPointer("artifact_retrieval_failed")}, ConsumptionPending, ReasonRunInProgress, ""},
		{"all lines booked", ended(ConsumptionFacts{Items: []RunReportedUsageItem{booked}, MachineUsages: 1}), ConsumptionRecorded, "", ""},
		{"staff usage wins", ended(ConsumptionFacts{StaffUsages: 1, Items: []RunReportedUsageItem{noWeights}}), ConsumptionRecorded, "", ""},
		{"partial", ended(ConsumptionFacts{Items: []RunReportedUsageItem{booked, unmappedSlot}, MachineUsages: 1}),
			ConsumptionPartial, ReasonSlotWithoutSpoolAssignment, ""},
		{"no slot known", ended(ConsumptionFacts{Items: []RunReportedUsageItem{unmapped}}), ConsumptionMissing, ReasonNoSpoolMapping, ""},
		{"every segment booked", ended(ConsumptionFacts{Items: []RunReportedUsageItem{segmented(bookedSegment, refilledSegment)},
			MachineUsages: 2}), ConsumptionRecorded, "", ""},
		{"segment without spool", ended(ConsumptionFacts{Items: []RunReportedUsageItem{segmented(bookedSegment, strayedSegment)},
			MachineUsages: 1}), ConsumptionPartial, ReasonSegmentWithoutSpool, ""},
		{"segment that fed nothing needs no spool", ended(ConsumptionFacts{
			Items: []RunReportedUsageItem{segmented(bookedSegment, emptySegment)}, MachineUsages: 1}), ConsumptionRecorded, "", ""},
		{"segment without quantity", ended(ConsumptionFacts{Items: []RunReportedUsageItem{segmented(unsplitSegment, refilledSegment)},
			MachineUsages: 1}), ConsumptionPartial, ReasonSegmentQuantityUnavailable, ""},
		{"segments without any quantity", ended(ConsumptionFacts{
			Items: []RunReportedUsageItem{segmented(unsplitSegment, RunReportedUsageSegment{Index: 1, SpoolID: &other})}}),
			ConsumptionMissing, ReasonSegmentQuantityUnavailable, ""},
		{"segmented line without estimate keeps the line's reason", ended(ConsumptionFacts{Items: []RunReportedUsageItem{
			{Method: "gcode_checkpoint", Quality: "unresolved", Segments: []RunReportedUsageSegment{unsplitSegment}}}}),
			ConsumptionMissing, ReasonGCodeEstimateUnavailable, ""},
		{"slicer without weights", ended(ConsumptionFacts{Items: []RunReportedUsageItem{noWeights}}),
			ConsumptionMissing, ReasonNoSlicerWeightsInArtifact, ""},
		{"gcode without checkpoint", ended(ConsumptionFacts{Items: []RunReportedUsageItem{noCheckpoint}}),
			ConsumptionMissing, ReasonGCodeEstimateUnavailable, ""},
		{"cancelled before first layer", ended(ConsumptionFacts{
			State:           RunStateFailed,
			Items:           []RunReportedUsageItem{noCheckpoint},
			ConnectorState:  text("reported"),
			ConnectorReason: text("cancelled_before_first_layer"),
		}), ConsumptionMissing, ReasonCancelledBeforeFirstLayer, ""},
		{"bookable but not booked", ended(ConsumptionFacts{Items: []RunReportedUsageItem{booked}}),
			ConsumptionMissing, ReasonInventoryNotBooked, ""},
		{"connector still retrying", ended(ConsumptionFacts{
			ConnectorState:  text("pending"),
			ConnectorReason: text("artifact_retrieval_failed"),
			ConnectorDetail: text("ftps_listing_failed"),
		}), ConsumptionPending, ReasonArtifactRetrievalFailed, "ftps_listing_failed"},
		{"connector gave up", ended(ConsumptionFacts{
			ConnectorState:  text("unavailable"),
			ConnectorReason: text("artifact_not_found_on_printer"),
			ConnectorDetail: text("no_archive_reported"),
		}), ConsumptionMissing, ReasonArtifactNotFoundOnPrinter, "no_archive_reported"},
		{"unknown connector reason", ended(ConsumptionFacts{
			ConnectorState:  text("unavailable"),
			ConnectorReason: text("brand_new_reason"),
		}), ConsumptionMissing, ReasonConsumptionNotReported, "brand_new_reason"},
		{"printer connection lost", ended(ConsumptionFacts{State: RunStateUnknown, TerminalReason: "connection_timeout"}),
			ConsumptionMissing, ReasonConnectorOfflineDuringRun, "printer_connection_lost"},
		{"connector removed", ended(ConsumptionFacts{State: RunStateUnknown, AssignmentRemoved: true}),
			ConsumptionMissing, ReasonConnectorOfflineDuringRun, "connector_removed"},
		{"just ended", ended(ConsumptionFacts{EndedAt: &recent}), ConsumptionPending, ReasonConsumptionPending, ""},
		{"outcome unknown", ended(ConsumptionFacts{State: RunStateUnknown}), ConsumptionMissing, ReasonOutcomeUnknown, ""},
		{"older connector without artifact", ended(ConsumptionFacts{}), ConsumptionMissing, ReasonConsumptionNotReported, "artifact_missing"},
		{"older connector with artifact", ended(ConsumptionFacts{HasArtifact: true}), ConsumptionMissing, ReasonConsumptionNotReported, ""},
	}
	for _, tc := range cases {
		status := DeriveConsumptionStatus(tc.facts, now)
		if status == nil || status.State != tc.state {
			t.Fatalf("%s: status = %+v, want state %s", tc.name, status, tc.state)
		}
		reason := ConsumptionReason("")
		if status.Reason != nil {
			reason = *status.Reason
		}
		detail := ""
		if status.Detail != nil {
			detail = *status.Detail
		}
		if reason != tc.reason || detail != tc.detail {
			t.Fatalf("%s: reason=%q detail=%q, want %q %q", tc.name, reason, detail, tc.reason, tc.detail)
		}
	}
	if DeriveConsumptionStatus(ConsumptionFacts{Recorded: false}, now) != nil {
		t.Fatal("manual runs must not have a consumption status")
	}
}
