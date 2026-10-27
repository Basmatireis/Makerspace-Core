package machinelogbook

import (
	"regexp"
	"time"
)

// ConsumptionState says whether a recorded run's material consumption is booked.
type ConsumptionState string

const (
	ConsumptionRecorded ConsumptionState = "recorded"
	ConsumptionPartial  ConsumptionState = "partial"
	ConsumptionMissing  ConsumptionState = "missing"
	ConsumptionPending  ConsumptionState = "pending"
)

// ConsumptionReason is the stable, machine-readable reason why a recorded run's
// consumption is partial, missing or pending.
type ConsumptionReason string

const (
	ReasonArtifactNotFoundOnPrinter  ConsumptionReason = "artifact_not_found_on_printer"
	ReasonArtifactRetrievalFailed    ConsumptionReason = "artifact_retrieval_failed"
	ReasonArtifactUploadFailed       ConsumptionReason = "artifact_upload_failed"
	ReasonArtifactRejected           ConsumptionReason = "artifact_rejected"
	ReasonNoSlicerWeightsInArtifact  ConsumptionReason = "no_slicer_weights_in_artifact"
	ReasonGCodeEstimateUnavailable   ConsumptionReason = "gcode_estimate_unavailable"
	ReasonCancelledBeforeFirstLayer  ConsumptionReason = "cancelled_before_first_layer"
	ReasonOutcomeUnknown             ConsumptionReason = "outcome_unknown"
	ReasonSlotWithoutSpoolAssignment ConsumptionReason = "slot_without_spool_assignment"
	ReasonNoSpoolMapping             ConsumptionReason = "no_spool_mapping"
	ReasonConnectorOfflineDuringRun  ConsumptionReason = "connector_offline_during_run"
	ReasonInventoryNotBooked         ConsumptionReason = "inventory_not_booked"
	ReasonConsumptionPending         ConsumptionReason = "consumption_pending"
	ReasonRunInProgress              ConsumptionReason = "run_in_progress"
	ReasonConsumptionNotReported     ConsumptionReason = "consumption_not_reported"
)

var consumptionReasons = map[ConsumptionReason]bool{
	ReasonArtifactNotFoundOnPrinter: true, ReasonArtifactRetrievalFailed: true, ReasonArtifactUploadFailed: true,
	ReasonArtifactRejected: true, ReasonNoSlicerWeightsInArtifact: true, ReasonGCodeEstimateUnavailable: true,
	ReasonCancelledBeforeFirstLayer: true, ReasonOutcomeUnknown: true, ReasonSlotWithoutSpoolAssignment: true,
	ReasonNoSpoolMapping: true, ReasonConnectorOfflineDuringRun: true, ReasonInventoryNotBooked: true,
	ReasonConsumptionPending: true, ReasonRunInProgress: true, ReasonConsumptionNotReported: true,
}

// ConsumptionPendingGrace is how long after a recorded run ended Core waits for
// the connector's consumption report before it calls the consumption missing
// when the connector gave no reason.
const ConsumptionPendingGrace = 30 * time.Minute

// ConsumptionStatus explains a recorded run's consumption.
type ConsumptionStatus struct {
	State  ConsumptionState
	Reason *ConsumptionReason
	Detail *string
}

// ConsumptionFacts is everything DeriveConsumptionStatus looks at.
type ConsumptionFacts struct {
	Recorded    bool
	State       RunState
	EndedAt     *time.Time
	HasArtifact bool
	// Items are the latest reported lines; Legacy is a single-line report of older connectors.
	Items  []RunReportedUsageItem
	Legacy *RunReportedUsage
	// MachineUsages and StaffUsages count the run's active usages by origin.
	MachineUsages, StaffUsages int
	// Connector* is the connector's latest consumption report section, if any.
	ConnectorState, ConnectorReason, ConnectorDetail *string
	// TerminalReason is the reason of the last terminal outcome event (connection_timeout, superseded).
	TerminalReason string
	// AssignmentRemoved is true when the connector or assignment was deleted.
	AssignmentRemoved bool
}

var reasonCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)

// DeriveConsumptionStatus returns nil for manual runs. The rules, first match wins:
//
//  1. a running run is pending (run_in_progress);
//  2. usage entered by staff with nothing booked from the machine is recorded;
//  3. reported lines: a line is booked when it has a quantity, a quality other than unresolved and a spool.
//     All booked is recorded, none booked missing, otherwise partial; the reason is the first unbooked
//     line's (unresolved quality: no_slicer_weights_in_artifact for slicer reports, otherwise the
//     connector's reason or gcode_estimate_unavailable; no spool: slot_without_spool_assignment when the
//     slot is known, else no_spool_mapping). Bookable lines without machine usage are inventory_not_booked;
//  4. a legacy single-line report is recorded when booked, else missing;
//  5. without a report, the connector's report decides (pending or its unavailable reason);
//  6. otherwise Core's own facts: a printer connection timeout or a removed connector is
//     connector_offline_during_run, a run that ended less than ConsumptionPendingGrace ago is pending,
//     an unknown outcome is outcome_unknown and anything else consumption_not_reported.
func DeriveConsumptionStatus(f ConsumptionFacts, now time.Time) *ConsumptionStatus {
	if !f.Recorded {
		return nil
	}
	if f.State == RunStateRunning {
		return consumptionStatus(ConsumptionPending, ReasonRunInProgress, nil)
	}
	if f.StaffUsages > 0 && f.MachineUsages == 0 {
		return &ConsumptionStatus{State: ConsumptionRecorded}
	}
	if len(f.Items) > 0 {
		return itemizedConsumptionStatus(f)
	}
	if f.Legacy != nil {
		if f.MachineUsages > 0 {
			return &ConsumptionStatus{State: ConsumptionRecorded}
		}
		if f.Legacy.SpoolID == nil {
			return consumptionStatus(ConsumptionMissing, ReasonNoSpoolMapping, nil)
		}
		return consumptionStatus(ConsumptionMissing, ReasonInventoryNotBooked, nil)
	}
	if f.ConnectorState != nil {
		switch *f.ConnectorState {
		case "pending", "reported":
			reason := ReasonConsumptionPending
			if f.ConnectorReason != nil && consumptionReasons[ConsumptionReason(*f.ConnectorReason)] {
				reason = ConsumptionReason(*f.ConnectorReason)
			}
			return consumptionStatus(ConsumptionPending, reason, f.ConnectorDetail)
		case "unavailable":
			if f.ConnectorReason != nil && consumptionReasons[ConsumptionReason(*f.ConnectorReason)] {
				return consumptionStatus(ConsumptionMissing, ConsumptionReason(*f.ConnectorReason), f.ConnectorDetail)
			}
			detail := f.ConnectorReason
			if detail == nil || !reasonCodePattern.MatchString(*detail) {
				detail = f.ConnectorDetail
			}
			return consumptionStatus(ConsumptionMissing, ReasonConsumptionNotReported, detail)
		}
	}
	switch {
	case f.TerminalReason == "connection_timeout":
		return consumptionStatus(ConsumptionMissing, ReasonConnectorOfflineDuringRun, stringPointer("printer_connection_lost"))
	case f.AssignmentRemoved && f.State == RunStateUnknown:
		return consumptionStatus(ConsumptionMissing, ReasonConnectorOfflineDuringRun, stringPointer("connector_removed"))
	case f.EndedAt == nil || now.Sub(*f.EndedAt) < ConsumptionPendingGrace:
		return consumptionStatus(ConsumptionPending, ReasonConsumptionPending, nil)
	case f.State == RunStateUnknown:
		return consumptionStatus(ConsumptionMissing, ReasonOutcomeUnknown, nil)
	case !f.HasArtifact:
		return consumptionStatus(ConsumptionMissing, ReasonConsumptionNotReported, stringPointer("artifact_missing"))
	default:
		return consumptionStatus(ConsumptionMissing, ReasonConsumptionNotReported, nil)
	}
}

func itemizedConsumptionStatus(f ConsumptionFacts) *ConsumptionStatus {
	bookable := 0
	var firstReason *ConsumptionReason
	for _, item := range f.Items {
		reason, ok := unbookedLineReason(item, f)
		if ok {
			bookable++
			continue
		}
		if firstReason == nil {
			firstReason = &reason
		}
	}
	switch {
	case firstReason == nil && f.MachineUsages > 0:
		return &ConsumptionStatus{State: ConsumptionRecorded}
	case firstReason == nil:
		return consumptionStatus(ConsumptionMissing, ReasonInventoryNotBooked, nil)
	case bookable == 0:
		return consumptionStatus(ConsumptionMissing, *firstReason, connectorDetailFor(*firstReason, f))
	case f.MachineUsages == 0:
		return consumptionStatus(ConsumptionPartial, ReasonInventoryNotBooked, nil)
	default:
		return consumptionStatus(ConsumptionPartial, *firstReason, connectorDetailFor(*firstReason, f))
	}
}

// unbookedLineReason reports ok when the line can be booked, otherwise why not.
func unbookedLineReason(item RunReportedUsageItem, f ConsumptionFacts) (ConsumptionReason, bool) {
	if item.Quality == string(EstimateQualityUnresolved) || item.EstimatedQuantityGrams == nil {
		if item.Method == "slicer_complete" {
			return ReasonNoSlicerWeightsInArtifact, false
		}
		if f.ConnectorReason != nil {
			switch ConsumptionReason(*f.ConnectorReason) {
			case ReasonCancelledBeforeFirstLayer, ReasonGCodeEstimateUnavailable, ReasonNoSlicerWeightsInArtifact:
				return ConsumptionReason(*f.ConnectorReason), false
			}
		}
		return ReasonGCodeEstimateUnavailable, false
	}
	if item.SpoolID == nil {
		if item.SlotExternalID != nil && *item.SlotExternalID != "" {
			return ReasonSlotWithoutSpoolAssignment, false
		}
		return ReasonNoSpoolMapping, false
	}
	return "", true
}

func connectorDetailFor(reason ConsumptionReason, f ConsumptionFacts) *string {
	if f.ConnectorReason != nil && ConsumptionReason(*f.ConnectorReason) == reason {
		return f.ConnectorDetail
	}
	return nil
}

func consumptionStatus(state ConsumptionState, reason ConsumptionReason, detail *string) *ConsumptionStatus {
	return &ConsumptionStatus{State: state, Reason: &reason, Detail: detail}
}
