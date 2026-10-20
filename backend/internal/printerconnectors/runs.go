package printerconnectors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// maxReportedGrams keeps reported usage inside numeric(20, 6).
var maxReportedGrams = decimal.NewFromInt(1_000_000_000_000)

func bambuAutoDetectSpools(settings json.RawMessage) bool {
	var value struct {
		AutoDetectSpools bool `json:"autoDetectSpools"`
	}
	return json.Unmarshal(settings, &value) == nil && value.AutoDetectSpools
}

// reconcileBambuSlotObservation applies only positive, exact RFID evidence or
// a connector-confirmed empty tray. Manual assignments are authoritative and
// are never displaced or automatically unmounted. A connector assignment may
// be moved or closed because that history was established by the same class of
// machine evidence.
func reconcileBambuSlotObservation(
	ctx context.Context,
	tx pgx.Tx,
	connectorID, assignmentID, machineID, eventID uuid.UUID,
	payload json.RawMessage,
	observedAt time.Time,
) error {
	var value struct {
		InputUnitExternalID string `json:"inputUnitExternalId"`
		SlotExternalID      string `json:"slotExternalId"`
		TagUID              string `json:"tagUid"`
		Empty               bool   `json:"empty"`
	}
	if json.Unmarshal(payload, &value) != nil {
		return nil //nolint:nilerr // a malformed connector payload is ignored
	}
	value.InputUnitExternalID = strings.TrimSpace(value.InputUnitExternalID)
	value.SlotExternalID = strings.TrimSpace(value.SlotExternalID)
	value.TagUID = strings.TrimSpace(value.TagUID)
	if value.InputUnitExternalID == "" || value.SlotExternalID == "" || utf8.RuneCountInString(value.TagUID) > 255 ||
		(value.Empty && value.TagUID != "") {
		return nil
	}

	q := db.New(tx)
	slotID, err := q.LockAvailableSlotByExternalIDs(ctx, db.LockAvailableSlotByExternalIDsParams{
		MachineID:           machineID,
		InputUnitExternalID: value.InputUnitExternalID,
		SlotExternalID:      value.SlotExternalID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if value.Empty {
		mount, err := q.LockOpenMountForSlot(ctx, slotID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && mount.Source != "connector_reconciled") {
			return nil
		}
		if err != nil {
			return err
		}
		unmountedAt := observedAt.UTC()
		if unmountedAt.IsZero() {
			unmountedAt = time.Now().UTC()
		}
		if !unmountedAt.After(mount.MountedAt) {
			unmountedAt = mount.MountedAt.Add(time.Microsecond)
		}
		if err = q.CloseOpenMount(ctx, db.CloseOpenMountParams{UnmountedAt: unmountedAt, ID: mount.ID}); err != nil {
			return err
		}
		return audit.Write(
			ctx,
			tx,
			audit.Event{
				ActorType:     "system",
				Source:        "system",
				Action:        "printer_slot.spool_auto_unmounted",
				ResourceType:  "printer_slot",
				ResourceID:    &slotID,
				ChangedFields: []string{"assignment", "spoolId"},
				Metadata: map[string]any{
					"connectorId":  connectorID.String(),
					"assignmentId": assignmentID.String(),
					"eventId":      eventID.String(),
				},
			},
		)
	}
	if value.TagUID == "" {
		return nil
	}

	spoolID, err := q.LockActiveSpoolByNFCTag(ctx, value.TagUID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	remaining, err := q.GetOpenFillRemainingQuantity(ctx, spoolID)
	if err != nil {
		return err
	}
	if !remaining.Valid || !decimal.NewFromBigInt(remaining.Int, remaining.Exp).IsPositive() {
		return nil
	}

	readMount := func(mount db.LockOpenMountForSlotRow, err error) (*db.LockOpenMountForSlotRow, error) {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return &mount, err
	}
	slotMount, err := readMount(q.LockOpenMountForSlot(ctx, slotID))
	if err != nil {
		return err
	}
	if slotMount != nil && slotMount.SpoolID == spoolID {
		return nil
	}
	spoolRow, err := q.LockOpenMountForSpool(ctx, spoolID)
	spoolMount, err := readMount(db.LockOpenMountForSlotRow(spoolRow), err)
	if err != nil {
		return err
	}
	if (slotMount != nil && slotMount.Source != "connector_reconciled") ||
		(spoolMount != nil && spoolMount.Source != "connector_reconciled") {
		return nil
	}

	mountedAt := observedAt.UTC()
	if mountedAt.IsZero() {
		mountedAt = time.Now().UTC()
	}
	// Delayed telemetry must not create an assignment that overlaps the
	// histories it replaces. Advance the new mount just past any newer open
	// connector-derived mount before closing those histories.
	for _, mount := range []*db.LockOpenMountForSlotRow{slotMount, spoolMount} {
		if mount != nil && !mountedAt.After(mount.MountedAt) {
			mountedAt = mount.MountedAt.Add(time.Microsecond)
		}
	}
	closeMount := func(mount *db.LockOpenMountForSlotRow) error {
		if mount == nil {
			return nil
		}
		return q.CloseOpenMount(ctx, db.CloseOpenMountParams{UnmountedAt: mountedAt, ID: mount.ID})
	}
	if err = closeMount(slotMount); err != nil {
		return err
	}
	if spoolMount != nil && (slotMount == nil || spoolMount.ID != slotMount.ID) {
		if err = closeMount(spoolMount); err != nil {
			return err
		}
	}
	if err = q.CreateReconciledMount(ctx, db.CreateReconciledMountParams{
		ID:            ids.New(),
		SlotID:        slotID,
		SpoolID:       spoolID,
		MountedAt:     mountedAt,
		SourceEventID: eventID,
	}); err != nil {
		return err
	}
	return audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorType:     "system",
			Source:        "system",
			Action:        "printer_slot.spool_auto_mounted",
			ResourceType:  "printer_slot",
			ResourceID:    &slotID,
			ChangedFields: []string{"assignment", "spoolId"},
			Metadata: map[string]any{
				"connectorId":  connectorID.String(),
				"assignmentId": assignmentID.String(),
				"eventId":      eventID.String(),
			},
		},
	)
}

func formatRunDisplayID(sequence int64, observedAt time.Time) string {
	return fmt.Sprintf("R-%04d-%06d", observedAt.UTC().Year(), sequence)
}

// errRunDeleted reports an observation of a run that staff deleted.
var errRunDeleted = errors.New("run deleted")

// recordObservedRun creates the recorded run on its first observation, which
// is the only moment a run display ID is allocated, or applies the next
// observation to the existing run. A run that belongs to another assignment or
// machine is reported as pgx.ErrNoRows.
func recordObservedRun(
	ctx context.Context,
	q *db.Queries,
	id, assignmentID, machineID uuid.UUID,
	vendorJobID *string,
	state RunState,
	historyComplete bool,
	observedAt time.Time,
) (db.MachineRun, error) {
	observedAt = observedAt.UTC()
	existing, err := q.GetObservedRunForUpdate(ctx, id)
	if err == nil && existing.DeletedAt.Valid {
		return existing, errRunDeleted
	}
	if errors.Is(err, pgx.ErrNoRows) {
		sequence, seqErr := q.NextPrintSequence(ctx)
		if seqErr != nil {
			return db.MachineRun{}, seqErr
		}
		row, insertErr := q.InsertObservedRun(
			ctx,
			db.InsertObservedRunParams{
				ID:              id,
				DisplayID:       formatRunDisplayID(sequence, observedAt),
				AssignmentID:    &assignmentID,
				MachineID:       machineID,
				VendorJobID:     vendorJobID,
				State:           optional.Of(string(state)),
				HistoryComplete: historyComplete,
				ObservedAt:      pgTimestamp(&observedAt),
			},
		)
		if !errors.Is(insertErr, pgx.ErrNoRows) {
			return row, insertErr
		}
		// A concurrent transaction created the run first; update it instead.
	} else if err != nil {
		return db.MachineRun{}, err
	}
	return q.UpdateObservedRun(
		ctx,
		db.UpdateObservedRunParams{
			ID:              id,
			AssignmentID:    &assignmentID,
			MachineID:       machineID,
			VendorJobID:     vendorJobID,
			State:           string(state),
			HistoryComplete: historyComplete,
			ObservedAt:      observedAt,
		},
	)
}

func timePtr(value time.Time) *time.Time {
	value = value.UTC()
	return &value
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

// applyPrintFacts copies what a newly inserted event tells about the run
// onto its recorded run. Duplicate events never reach it, so replays cannot
// change the print. run is the state after the observation was recorded.
func applyPrintFacts(
	ctx context.Context,
	q *db.Queries,
	run db.MachineRun,
	eventID uuid.UUID,
	kind printing.EventKind,
	payload json.RawMessage,
	occurredAt time.Time,
	reportRevision *int64,
) error {
	var values map[string]any
	if json.Unmarshal(payload, &values) != nil || values == nil {
		return nil //nolint:nilerr // a malformed connector payload is ignored
	}
	at := occurredAt.UTC()
	if kind == printing.EventConsumptionReport {
		return applyReportedUsage(ctx, q, run, eventID, values, at, reportRevision)
	}
	started, ended := timePointer(run.StartedAt), timePointer(run.EndedAt)
	newest := !run.LastObservedAt.Valid || !at.Before(run.LastObservedAt.Time)
	var fileName *string
	var percent *int16
	var estimatedEnd *time.Time
	switch kind {
	case printing.EventOperationalState:
		if state, _ := payloadString(values, "state"); state == "printing" && started == nil {
			started = &at
		}
		fileName = payloadFileName(values)
	case printing.EventProgress:
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
	case printing.EventTerminalOutcome:
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
	return q.UpdateObservedRunFacts(
		ctx,
		db.UpdateObservedRunFactsParams{
			ID:              run.ID,
			StartedAt:       pgTimestamp(started),
			EndedAt:         pgTimestamp(ended),
			FileName:        fileName,
			ProgressPercent: percent,
			EstimatedEndAt:  pgTimestamp(estimatedEnd),
		},
	)
}

func applyReportedUsage(
	ctx context.Context,
	q *db.Queries,
	run db.MachineRun,
	eventID uuid.UUID,
	values map[string]any,
	at time.Time,
	reportRevision *int64,
) error {
	if reportRevision == nil {
		return nil
	}
	if rawItems, ok := values["items"].([]any); ok {
		return applyReportedUsageItems(ctx, q, run, eventID, rawItems, at, *reportRevision)
	}
	grams, _ := payloadString(values, "quantityGrams")
	quantity, err := decimal.NewFromString(strings.TrimSpace(grams))
	if err != nil {
		return nil //nolint:nilerr // an unparseable reported quantity is ignored
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
	if err = q.InsertReportedUsageItem(
		ctx,
		db.InsertReportedUsageItemParams{
			ID:                   ids.New(),
			RunID:                run.ID,
			SourcePrinterEventID: eventID,
			ReportRevision:       *reportRevision,
			LineNumber:           0,
			EstimatedQuantityG:   pgNumeric(quantity),
			SpoolID:              spoolID,
			Method:               "legacy_report",
			CalculationVersion:   "legacy-v1",
			Quality:              "low",
		},
	); err != nil {
		return err
	}
	_, err = q.SetObservedRunReport(
		ctx,
		db.SetObservedRunReportParams{
			ID:             run.ID,
			QuantityG:      pgtype.Numeric{Int: quantity.Coefficient(), Exp: quantity.Exponent(), Valid: true},
			QuantityBasis:  &basis,
			SpoolID:        spoolID,
			EventID:        &eventID,
			ReportRevision: *reportRevision,
		},
	)
	return err
}

func applyReportedUsageItems(
	ctx context.Context,
	q *db.Queries,
	run db.MachineRun,
	eventID uuid.UUID,
	rawItems []any,
	at time.Time,
	revision int64,
) error {
	if len(rawItems) == 0 || len(rawItems) > 100 {
		return nil
	}
	valid := 0
	var onlyQuantity decimal.Decimal
	var onlySpool *uuid.UUID
	for index, raw := range rawItems {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		method, _ := payloadString(item, "method")
		calculationVersion, _ := payloadString(item, "calculationVersion")
		quality, _ := payloadString(item, "quality")
		if strings.TrimSpace(method) == "" || utf8.RuneCountInString(method) > 80 ||
			strings.TrimSpace(calculationVersion) == "" ||
			utf8.RuneCountInString(calculationVersion) > 80 ||
			(quality != "high" && quality != "medium" && quality != "low" && quality != "unresolved") {
			continue
		}
		estimated, estimatedOK := optionalReportedDecimal(item, "estimatedQuantityGrams")
		planned, plannedOK := optionalReportedDecimal(item, "plannedQuantityGrams")
		length, lengthOK := optionalReportedDecimal(item, "plannedLengthMillimeters")
		if !estimatedOK || !plannedOK || !lengthOK {
			continue
		}
		spoolID, err := resolveReportedSpool(ctx, q, run.MachineID, item, at)
		if err != nil {
			return err
		}
		materialID := optionalUUID(item, "materialId")
		var extruder *int32
		if value, ok := item["extruder"].(float64); ok && value >= 0 && value == math.Trunc(value) &&
			value <= math.MaxInt32 {
			converted := int32(value)
			extruder = &converted
		}
		slicerID := boundedPayloadString(item, "slicerFilamentId", 120)
		inputUnit := boundedPayloadString(item, "inputUnitExternalId", 200)
		slot := boundedPayloadString(item, "slotExternalId", 200)
		if err = q.InsertReportedUsageItem(
			ctx,
			db.InsertReportedUsageItemParams{
				ID:                   ids.New(),
				RunID:                run.ID,
				SourcePrinterEventID: eventID,
				ReportRevision:       revision,
				LineNumber:           int32(index),
				SlicerFilamentID:     slicerID,
				Extruder:             extruder,
				InputUnitExternalID:  inputUnit,
				SlotExternalID:       slot,
				PlannedQuantityG:     pgNumericOptional(planned),
				PlannedLengthMm:      pgNumericOptional(length),
				EstimatedQuantityG:   pgNumericOptional(estimated),
				MaterialID:           materialID,
				SpoolID:              spoolID,
				Method:               method,
				CalculationVersion:   calculationVersion,
				Quality:              quality,
			},
		); err != nil {
			return err
		}
		valid++
		if estimated != nil {
			onlyQuantity = *estimated
		}
		onlySpool = spoolID
	}
	if valid == 1 && onlyQuantity.IsPositive() {
		basis := "estimated"
		_, err := q.SetObservedRunReport(
			ctx,
			db.SetObservedRunReportParams{
				ID:             run.ID,
				QuantityG:      pgNumeric(onlyQuantity),
				QuantityBasis:  &basis,
				SpoolID:        onlySpool,
				EventID:        &eventID,
				ReportRevision: revision,
			},
		)
		return err
	}
	return nil
}

func optionalReportedDecimal(values map[string]any, key string) (*decimal.Decimal, bool) {
	value, exists := values[key]
	if !exists || value == nil {
		return nil, true
	}
	text, ok := value.(string)
	if !ok {
		return nil, false
	}
	parsed, err := decimal.NewFromString(strings.TrimSpace(text))
	if err != nil || parsed.IsNegative() || !parsed.LessThan(maxReportedGrams) {
		return nil, false
	}
	parsed = parsed.Round(6)
	return &parsed, true
}

func optionalUUID(values map[string]any, key string) *uuid.UUID {
	text, ok := payloadString(values, key)
	if !ok {
		return nil
	}
	value, err := uuid.Parse(text)
	if err != nil || value.Version() != 7 {
		return nil
	}
	return &value
}

func boundedPayloadString(values map[string]any, key string, max int) *string {
	value, ok := payloadString(values, key)
	value = strings.TrimSpace(value)
	if !ok || value == "" || utf8.RuneCountInString(value) > max {
		return nil
	}
	return &value
}

func pgNumeric(value decimal.Decimal) pgtype.Numeric {
	return pgtype.Numeric{Int: value.Coefficient(), Exp: value.Exponent(), Valid: true}
}

func pgNumericOptional(value *decimal.Decimal) pgtype.Numeric {
	if value == nil {
		return pgtype.Numeric{}
	}
	return pgNumeric(*value)
}

// resolveReportedSpool uses only authoritative historical slot assignments and
// exact historical NFC identifiers. A disagreement or ambiguity is unresolved.
func resolveReportedSpool(
	ctx context.Context,
	q *db.Queries,
	machineID uuid.UUID,
	values map[string]any,
	at time.Time,
) (*uuid.UUID, error) {
	var slotSpool, tagSpool *uuid.UUID
	unit, unitOK := payloadString(values, "inputUnitExternalId")
	slot, slotOK := payloadString(values, "slotExternalId")
	if unitOK && slotOK && unit != "" && slot != "" && utf8.RuneCountInString(unit) <= 200 &&
		utf8.RuneCountInString(slot) <= 200 {
		ids, err := q.ListSlotSpoolsAt(
			ctx,
			db.ListSlotSpoolsAtParams{MachineID: machineID, SlotExternalID: &slot, InputUnitExternalID: &unit, At: at},
		)
		if err != nil {
			return nil, err
		}
		if len(ids) == 1 {
			slotSpool = &ids[0]
		}
	}
	if tag, ok := payloadString(values, "tagUid"); ok && tag != "" && utf8.RuneCountInString(tag) <= 255 {
		ids, err := q.ListNFCSpoolsAt(ctx, db.ListNFCSpoolsAtParams{TagUid: tag, At: at})
		if err != nil {
			return nil, err
		}
		if len(ids) == 1 {
			tagSpool = &ids[0]
		}
	}
	if slotSpool != nil && tagSpool != nil && *slotSpool != *tagSpool {
		return nil, nil
	}
	if slotSpool != nil {
		return slotSpool, nil
	}
	return tagSpool, nil
}
