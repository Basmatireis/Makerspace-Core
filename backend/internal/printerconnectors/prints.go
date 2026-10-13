package printerconnectors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// maxReportedGrams keeps reported usage inside numeric(20, 6).
var maxReportedGrams = decimal.NewFromInt(1_000_000_000_000)

func formatPrintDisplayID(sequence int64, observedAt time.Time) string {
	return fmt.Sprintf("PR-%04d-%06d", observedAt.UTC().Year(), sequence)
}

// recordObservedRun creates the observed run on its first observation, which
// is the only moment a print display ID is allocated, or applies the next
// observation to the existing run. A run that belongs to another assignment or
// machine is reported as pgx.ErrNoRows.
func recordObservedRun(ctx context.Context, q *db.Queries, id, assignmentID, machineID uuid.UUID, vendorJobID *string, state string, historyComplete bool, observedAt time.Time) (db.PrinterObservedRun, error) {
	observedAt = observedAt.UTC()
	_, err := q.GetObservedRunForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		sequence, seqErr := q.NextPrintSequence(ctx)
		if seqErr != nil {
			return db.PrinterObservedRun{}, seqErr
		}
		row, insertErr := q.InsertObservedRun(ctx, db.InsertObservedRunParams{ID: id, DisplayID: formatPrintDisplayID(sequence, observedAt), AssignmentID: assignmentID, MachineID: machineID, VendorJobID: vendorJobID, State: state, HistoryComplete: historyComplete, ObservedAt: observedAt})
		if !errors.Is(insertErr, pgx.ErrNoRows) {
			return row, insertErr
		}
		// A concurrent transaction created the run first; update it instead.
	} else if err != nil {
		return db.PrinterObservedRun{}, err
	}
	return q.UpdateObservedRun(ctx, db.UpdateObservedRunParams{ID: id, AssignmentID: assignmentID, MachineID: machineID, VendorJobID: vendorJobID, State: state, HistoryComplete: historyComplete, ObservedAt: observedAt})
}

func timePointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time.UTC()
	return &v
}

func pgTimestamp(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func payloadString(payload map[string]any, key string) (string, bool) {
	value, ok := payload[key].(string)
	return value, ok
}

func payloadFileName(payload map[string]any) *string {
	value, ok := payloadString(payload, "fileName")
	if !ok {
		return nil
	}
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > 255 {
		return nil
	}
	return &value
}

func payloadPercent(payload map[string]any) *int16 {
	value, ok := payload["percent"].(float64)
	if !ok || math.IsNaN(value) || value < 0 || value > 100 {
		return nil
	}
	percent := int16(math.Round(value))
	return &percent
}

func payloadRemainingSeconds(payload map[string]any) *time.Duration {
	value, ok := payload["remainingSeconds"].(float64)
	if !ok || math.IsNaN(value) || value < 0 || value != math.Trunc(value) || value > 10*365*24*3600 {
		return nil
	}
	duration := time.Duration(value) * time.Second
	return &duration
}

// applyPrintFacts copies what a newly inserted event tells about the print
// onto its observed run. Duplicate events never reach it, so replays cannot
// change the print. run is the state after the observation was recorded.
func applyPrintFacts(ctx context.Context, q *db.Queries, run db.PrinterObservedRun, eventID uuid.UUID, kind string, payload json.RawMessage, occurredAt time.Time, reportRevision *int64) error {
	var values map[string]any
	if json.Unmarshal(payload, &values) != nil || values == nil {
		return nil
	}
	at := occurredAt.UTC()
	if kind == "consumption_report" {
		return applyReportedUsage(ctx, q, run, eventID, values, at, reportRevision)
	}
	started, ended := timePointer(run.StartedAt), timePointer(run.EndedAt)
	newest := !at.Before(run.LastObservedAt)
	var fileName *string
	var percent *int16
	var estimatedEnd *time.Time
	switch kind {
	case "operational_state":
		if state, _ := payloadString(values, "state"); state == "printing" && started == nil {
			started = &at
		}
		fileName = payloadFileName(values)
	case "progress":
		if started == nil {
			started = &at
		}
		fileName = payloadFileName(values)
		if newest {
			percent = payloadPercent(values)
			if remaining := payloadRemainingSeconds(values); remaining != nil {
				end := at.Add(*remaining)
				estimatedEnd = &end
			}
		}
	case "terminal_outcome":
		if ended == nil {
			ended = &at
		}
		if outcome, _ := payloadString(values, "outcome"); outcome == "completed" {
			hundred := int16(100)
			percent = &hundred
		}
	default:
		return nil
	}
	if started != nil && ended != nil && ended.Before(*started) {
		clamped := *started
		ended = &clamped
	}
	return q.UpdateObservedRunFacts(ctx, db.UpdateObservedRunFactsParams{ID: run.ID, StartedAt: pgTimestamp(started), EndedAt: pgTimestamp(ended), FileName: fileName, ProgressPercent: percent, EstimatedEndAt: pgTimestamp(estimatedEnd)})
}

func applyReportedUsage(ctx context.Context, q *db.Queries, run db.PrinterObservedRun, eventID uuid.UUID, values map[string]any, at time.Time, reportRevision *int64) error {
	if reportRevision == nil {
		return nil
	}
	grams, _ := payloadString(values, "quantityGrams")
	quantity, err := decimal.NewFromString(strings.TrimSpace(grams))
	if err != nil {
		return nil
	}
	quantity = quantity.Round(6)
	basis, _ := payloadString(values, "quantityBasis")
	if !quantity.IsPositive() || !quantity.LessThan(maxReportedGrams) || (basis != "estimated" && basis != "actual") {
		return nil
	}
	spoolID, err := resolveReportedSpool(ctx, q, run.MachineID, values, at)
	if err != nil {
		return err
	}
	_, err = q.SetObservedRunReport(ctx, db.SetObservedRunReportParams{ID: run.ID, QuantityG: pgtype.Numeric{Int: quantity.Coefficient(), Exp: quantity.Exponent(), Valid: true}, QuantityBasis: &basis, SpoolID: spoolID, EventID: &eventID, ReportRevision: *reportRevision})
	return err
}

// resolveReportedSpool maps a consumption report to the spool that fed it: the
// spool open in the reported slot at the time of the report, otherwise the
// machine's only mounted spool. Anything ambiguous stays unresolved so staff
// choose the spool themselves.
func resolveReportedSpool(ctx context.Context, q *db.Queries, machineID uuid.UUID, values map[string]any, at time.Time) (*uuid.UUID, error) {
	if slot, ok := payloadString(values, "slotExternalId"); ok && slot != "" && utf8.RuneCountInString(slot) <= 200 {
		ids, err := q.ListSlotSpoolsAt(ctx, db.ListSlotSpoolsAtParams{MachineID: machineID, SlotExternalID: &slot, At: at})
		if err != nil {
			return nil, err
		}
		if len(ids) == 1 {
			return &ids[0], nil
		}
	}
	ids, err := q.ListOpenMachineSpools(ctx, machineID)
	if err != nil {
		return nil, err
	}
	if len(ids) == 1 {
		return &ids[0], nil
	}
	return nil, nil
}
