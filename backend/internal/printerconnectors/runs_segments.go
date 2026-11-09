package printerconnectors

import (
	"context"
	"math"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// maxReportedSegments bounds the spool segments Core accepts for one
// consumption line; the connector keeps at most 24 per run.
const maxReportedSegments = 24

// reportedSegment is one spool that fed a consumption line during a print,
// resolved to a spool at the time the feed moved to it.
type reportedSegment struct {
	inputUnit, slot *string
	startedAt       time.Time
	startLayer      *int32
	quantity        *decimal.Decimal
	split           *string
	spoolID         *uuid.UUID
	// customerAssignmentID is the customer filament mount the segment was fed from instead of a spool.
	customerAssignmentID *uuid.UUID
}

// reportedSegments reads the segments of a line fed by two or more spools and
// resolves each one's spool at its start, with the rules of
// resolveReportedSpool. segmented is false for a line without segments. A
// malformed list counts as segmented without segments: the line names no
// slot, so it stays unresolved for staff instead of being booked on a guess.
// A segment whose quantity is missing or malformed keeps no quantity and is
// left unbooked.
func reportedSegments(
	ctx context.Context,
	q *db.Queries,
	machineID uuid.UUID,
	item map[string]any,
) ([]reportedSegment, bool, error) {
	raw, exists := item["segments"]
	if !exists || raw == nil {
		return nil, false, nil
	}
	list, ok := raw.([]any)
	if !ok || len(list) < 2 || len(list) > maxReportedSegments {
		return nil, true, nil
	}
	segments := make([]reportedSegment, 0, len(list))
	var previous time.Time
	for _, entry := range list {
		values, ok := entry.(map[string]any)
		if !ok {
			return nil, true, nil
		}
		text, _ := payloadString(values, "startedAt")
		startedAt, err := time.Parse(time.RFC3339Nano, text)
		if err != nil || startedAt.UTC().Before(previous) {
			return nil, true, nil //nolint:nilerr // a malformed segment list leaves the line unresolved
		}
		startedAt = startedAt.UTC()
		previous = startedAt
		segment := reportedSegment{
			inputUnit: boundedPayloadString(values, "inputUnitExternalId", 200),
			slot:      boundedPayloadString(values, "slotExternalId", 200),
			startedAt: startedAt,
		}
		if layer, ok := values["startLayer"].(float64); ok && layer >= 0 && layer == math.Trunc(layer) &&
			layer <= math.MaxInt32 {
			converted := int32(layer)
			segment.startLayer = &converted
		}
		if quantity, valid := optionalReportedDecimal(values, "estimatedQuantityGrams"); valid && quantity != nil {
			segment.quantity = quantity
			if split, _ := payloadString(values, "split"); split == "gcode_layer" || split == "progress" {
				segment.split = &split
			}
		}
		source, err := resolveReportedSpool(ctx, q, machineID, values, startedAt)
		if err != nil {
			return nil, true, err
		}
		segment.spoolID, segment.customerAssignmentID = source.spoolID, source.customerAssignmentID
		segments = append(segments, segment)
	}
	return segments, true, nil
}

func insertReportedSegments(ctx context.Context, q *db.Queries, itemID uuid.UUID, segments []reportedSegment) error {
	for index, segment := range segments {
		if err := q.InsertReportedUsageSegment(
			ctx,
			db.InsertReportedUsageSegmentParams{
				ID:                   ids.New(),
				ItemID:               itemID,
				SegmentIndex:         int32(index),
				InputUnitExternalID:  segment.inputUnit,
				SlotExternalID:       segment.slot,
				StartedAt:            segment.startedAt,
				StartLayer:           segment.startLayer,
				EstimatedQuantityG:   pgNumericOptional(segment.quantity),
				Split:                segment.split,
				SpoolID:              segment.spoolID,
				CustomerAssignmentID: segment.customerAssignmentID,
			},
		); err != nil {
			return err
		}
	}
	return nil
}
