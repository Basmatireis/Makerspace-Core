package printerconnector

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/parser"
	"github.com/google/uuid"
)

const bambuConsumptionRevision int64 = 1

func (s *Store) ExtendArtifactTransferExpiry(
	ctx context.Context,
	assignmentID, runID uuid.UUID,
	expiresAt time.Time,
) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_transfers SET expires_at=? WHERE assignment_id=? AND run_id=? AND state='pending' AND expires_at<?`,
		expiresAt.UTC().Format(time.RFC3339Nano),
		assignmentID.String(),
		runID.String(),
		expiresAt.UTC().Format(time.RFC3339Nano),
	)
	return err
}

func (s *Store) PendingArtifactConsumptions(
	ctx context.Context,
	assignmentID uuid.UUID,
	limit int,
) ([]ArtifactTransfer, error) {
	if limit < 1 || limit > maxArtifactTransfers {
		limit = 20
	}
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT t.id,t.assignment_id,t.run_id,t.configuration_version,t.remote_path,t.file_name,t.staged_path,t.size_bytes,t.sha256,t.attempt_count,t.expires_at
		FROM artifact_transfers t
		WHERE t.assignment_id=? AND t.state='pending' AND NOT EXISTS (
			SELECT 1 FROM artifact_consumption_reports c WHERE c.assignment_id=t.assignment_id AND c.run_id=t.run_id AND c.artifact_sha256=t.sha256
		) ORDER BY t.created_at LIMIT ?`,
		assignmentID.String(),
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanArtifactTransfers(rows)
}

func scanArtifactTransfers(rows *sql.Rows) ([]ArtifactTransfer, error) {
	var result []ArtifactTransfer
	for rows.Next() {
		var item ArtifactTransfer
		var id, assignmentID, runID, expires string
		if err := rows.Scan(&id, &assignmentID, &runID, &item.ConfigurationVersion, &item.RemotePath, &item.FileName, &item.StagedPath, &item.SizeBytes, &item.SHA256, &item.AttemptCount, &expires); err != nil {
			return nil, err
		}
		var err error
		if item.ID, err = uuid.Parse(id); err != nil {
			return nil, err
		}
		if item.AssignmentID, err = uuid.Parse(assignmentID); err != nil {
			return nil, err
		}
		if item.RunID, err = uuid.Parse(runID); err != nil {
			return nil, err
		}
		if item.ExpiresAt, err = time.Parse(time.RFC3339Nano, expires); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// EnqueueArtifactConsumption atomically records the immutable calculation
// revision and queues its normalized report. The marker remains after delivery
// so connector restarts cannot report the same calculation twice.
func (s *Store) EnqueueArtifactConsumption(
	ctx context.Context,
	transfer ArtifactTransfer,
	facts bambuRunFacts,
	payload json.RawMessage,
) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM artifact_consumption_reports WHERE assignment_id=? AND run_id=? AND artifact_sha256=?`, transfer.AssignmentID.String(), transfer.RunID.String(), transfer.SHA256).
		Scan(&exists)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var queued int64
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM outbox`).Scan(&queued); err != nil {
		return err
	}
	if queued >= maxOutboxEvents {
		return errors.New("connector event queue is full; consumption report remains pending")
	}
	sequence := int64(1)
	err = tx.QueryRowContext(ctx, `SELECT next_sequence FROM assignment_sequences WHERE assignment_id=?`, transfer.AssignmentID.String()).
		Scan(&sequence)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.ExecContext(
			ctx,
			`INSERT INTO assignment_sequences(assignment_id,next_sequence) VALUES(?,2)`,
			transfer.AssignmentID.String(),
		)
	} else if err == nil {
		_, err = tx.ExecContext(ctx, `UPDATE assignment_sequences SET next_sequence=? WHERE assignment_id=?`, sequence+1, transfer.AssignmentID.String())
	}
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var external any
	if facts.ExternalPrintID != "" {
		external = facts.ExternalPrintID
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO outbox(event_id,assignment_id,configuration_version,sequence,occurred_at,kind,run_id,history_complete,external_print_id,report_revision,payload,next_attempt_at,created_at) VALUES(?,?,?,?,?,'consumption_report',?,?,?,?,?,?,?)`, uuid.Must(uuid.NewV7()).String(), transfer.AssignmentID.String(), transfer.ConfigurationVersion, sequence, now, transfer.RunID.String(), facts.HistoryComplete, external, bambuConsumptionRevision, []byte(payload), now, now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO artifact_consumption_reports(assignment_id,run_id,artifact_sha256,report_revision,created_at) VALUES(?,?,?,?,?)`, transfer.AssignmentID.String(), transfer.RunID.String(), transfer.SHA256, bambuConsumptionRevision, now); err != nil {
		return err
	}
	removeStaged := false
	var receiptExists int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM artifact_upload_receipts WHERE transfer_id=?`, transfer.ID.String()).
		Scan(&receiptExists)
	if err == nil {
		if _, err = tx.ExecContext(ctx, `DELETE FROM artifact_transfers WHERE id=?`, transfer.ID.String()); err != nil {
			return err
		}
		removeStaged = true
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if removeStaged {
		if err = os.Remove(transfer.StagedPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (a *bambuH2DAdapter) processArtifactConsumptions(ctx context.Context) error {
	state, found, err := a.store.BambuStateFor(ctx, a.assignmentID, a.adapterKind())
	if err != nil || !found {
		return err
	}
	transfers, err := a.store.PendingArtifactConsumptions(ctx, a.assignmentID, 20)
	if err != nil {
		return err
	}
	for _, transfer := range transfers {
		facts, ok := state.RunFacts[transfer.RunID.String()]
		if !ok || facts.Outcome == "" {
			continue
		}
		payload, buildErr := buildBambuConsumptionPayloadFor(a.adapterKind(), transfer, facts)
		if buildErr != nil {
			return buildErr
		}
		if err = a.store.EnqueueArtifactConsumption(ctx, transfer, facts, payload); err != nil {
			return err
		}
	}
	return nil
}

func buildBambuConsumptionPayload(transfer ArtifactTransfer, facts bambuRunFacts) (json.RawMessage, error) {
	return buildBambuConsumptionPayloadFor(bambuH2DAdapterKind, transfer, facts)
}

func buildBambuConsumptionPayloadFor(
	adapterKind string,
	transfer ArtifactTransfer,
	facts bambuRunFacts,
) (json.RawMessage, error) {
	file, err := os.Open(transfer.StagedPath)
	if err != nil {
		return nil, fmt.Errorf("open staged artifact for consumption: %w", err)
	}
	defer file.Close()
	parsed, err := parser.Parse(file, transfer.SizeBytes, parser.DefaultLimits())
	if err != nil {
		return nil, fmt.Errorf("parse staged artifact for consumption: %w", err)
	}
	if facts.Outcome == "completed" {
		return marshalSlicerConsumption(parsed, facts)
	}
	if facts.LastLayer == nil && facts.LastProgress == nil {
		return marshalUnresolvedConsumption(
			"gcode_checkpoint",
			parser.CalculationVersion,
			"no reliable printer checkpoint was observed",
		)
	}
	filaments := make([]parser.GCodeFilament, 0, len(parsed.Filaments))
	for _, filament := range parsed.Filaments {
		filaments = append(
			filaments,
			parser.GCodeFilament{
				ID:              filament.ID,
				DiameterMM:      filament.DiameterMM,
				DensityGCM3:     filament.DensityGCM3,
				FullLengthMM:    filament.LengthMM,
				FullWeightGrams: filament.WeightGrams,
			},
		)
	}
	options := parser.GCodeOptions{Filaments: filaments}
	if adapterKind == bambuX1CAdapterKind {
		physicalExtruder := 1
		options.PhysicalExtruder = &physicalExtruder
	}
	if facts.LastLayer != nil {
		options.LastReliableLayer = facts.LastLayer
	}
	if facts.LastProgress != nil {
		options.LastReliableProgress = facts.LastProgress
	}
	estimates, err := parser.EstimateArchiveGCode(file, transfer.SizeBytes, parser.DefaultLimits(), options)
	if err != nil {
		return nil, err
	}
	if len(estimates) != 1 {
		return marshalUnresolvedConsumption(
			"gcode_checkpoint",
			parser.CalculationVersion,
			"archive does not identify exactly one printable G-code stream",
		)
	}
	return marshalGCodeConsumption(parsed, estimates[0].Estimate, facts)
}

func marshalSlicerConsumption(parsed parser.Result, facts bambuRunFacts) (json.RawMessage, error) {
	items := make([]map[string]any, 0, len(parsed.Filaments))
	for _, filament := range parsed.Filaments {
		// Bambu project settings include every configured filament preset, even
		// when a preset is not used by the sliced plate. Only slice-info entries
		// with an actual positive weight are consumption lines. Treating the
		// unused definitions as unresolved materials makes a one-material print
		// look multi-material and prevents its exact mounted-spool evidence from
		// being applied.
		if filament.WeightGrams == nil || *filament.WeightGrams <= 0 {
			continue
		}
		item := baseConsumptionItem(filament, "slicer_complete", parser.ParserVersion)
		item["estimatedQuantityGrams"] = decimalString(*filament.WeightGrams)
		item["quality"] = "high"
		items = append(items, item)
	}
	if len(items) == 0 {
		return marshalUnresolvedConsumption(
			"slicer_complete",
			parser.ParserVersion,
			"artifact has no defensible per-filament quantity",
		)
	}
	applyFilamentEvidence(items, parsed, facts)
	return json.Marshal(map[string]any{"items": items})
}

func marshalGCodeConsumption(
	parsed parser.Result,
	estimate parser.GCodeEstimate,
	facts bambuRunFacts,
) (json.RawMessage, error) {
	items := make([]map[string]any, 0, len(estimate.Filaments))
	for _, estimated := range estimate.Filaments {
		filament := parsedFilamentForGCode(parsed.Filaments, estimated.FilamentID)
		item := baseConsumptionItem(filament, estimate.Method, estimate.CalculationVersion)
		if filament.ID == "" {
			item["slicerFilamentId"] = estimated.FilamentID
		}
		item["quality"] = string(estimate.Quality)
		if estimated.WeightGrams != nil {
			item["estimatedQuantityGrams"] = decimalString(*estimated.WeightGrams)
			if estimated.LengthMM > 0 {
				gramsPerMM := *estimated.WeightGrams / estimated.LengthMM
				item["modelQuantityGrams"] = decimalString(estimated.ModelLengthMM * gramsPerMM)
				item["purgeQuantityGrams"] = decimalString(estimated.PurgeLengthMM * gramsPerMM)
				item["unclassifiedQuantityGrams"] = decimalString(estimated.UnclassifiedMM * gramsPerMM)
			}
		} else {
			item["quality"] = "unresolved"
		}
		if _, mapped := item["extruder"]; !mapped && len(estimated.Extruders) == 1 {
			item["extruder"] = estimated.Extruders[0]
		}
		items = append(items, item)
	}
	if len(items) == 0 {
		return marshalUnresolvedConsumption(
			estimate.Method,
			estimate.CalculationVersion,
			"no defensible G-code checkpoint quantity",
		)
	}
	applyFilamentEvidence(items, parsed, facts)
	return json.Marshal(map[string]any{"items": items})
}

// applyFilamentEvidence associates each consumption line only when the 3MF
// route and observed H2D tray history make the mapping deterministic. This
// supports materials split across two nozzles as well as ordered AMS changes
// through one nozzle. Ambiguous lines intentionally remain unresolved.
func applyFilamentEvidence(items []map[string]any, parsed parser.Result, facts bambuRunFacts) {
	if len(items) == 1 && len(facts.SpoolEvidence) == 0 {
		applyLegacySpoolEvidence(items[0], facts)
		return
	}
	type indexedEvidence struct {
		index int
		value bambuSpoolEvidence
	}
	usedEvidence := make(map[int]bool, len(facts.SpoolEvidence))
	hasExplicitFilamentRoutes := false
	evidenceByFilament := map[string][]indexedEvidence{}
	for index, evidence := range facts.SpoolEvidence {
		if evidence.SlicerFilamentID == "" || evidence.InputUnitExternalID == "" || evidence.SlotExternalID == "" {
			continue
		}
		hasExplicitFilamentRoutes = true
		evidenceByFilament[evidence.SlicerFilamentID] = append(
			evidenceByFilament[evidence.SlicerFilamentID],
			indexedEvidence{index: index, value: evidence},
		)
	}
	for _, item := range items {
		filamentID, _ := item["slicerFilamentId"].(string)
		if routes := evidenceByFilament[filamentID]; filamentID != "" && len(routes) == 1 {
			applySpoolEvidence(item, routes[0].value)
			usedEvidence[routes[0].index] = true
		}
	}

	itemsByExtruder := map[int][]map[string]any{}
	for _, item := range items {
		if _, matched := item["slotExternalId"]; matched {
			continue
		}
		extruder, ok := anyInt(item["extruder"])
		if !ok {
			continue
		}
		itemsByExtruder[extruder] = append(itemsByExtruder[extruder], item)
	}
	evidenceByExtruder := map[int][]indexedEvidence{}
	for index, evidence := range facts.SpoolEvidence {
		if usedEvidence[index] || evidence.SlicerFilamentID != "" || evidence.InputUnitExternalID == "" ||
			evidence.SlotExternalID == "" {
			continue
		}
		evidenceByExtruder[evidence.Extruder] = append(
			evidenceByExtruder[evidence.Extruder],
			indexedEvidence{index: index, value: evidence},
		)
	}
	for extruder, routedItems := range itemsByExtruder {
		routes := evidenceByExtruder[extruder]
		if len(routedItems) == 1 && len(routes) == 1 {
			applySpoolEvidence(routedItems[0], routes[0].value)
			usedEvidence[routes[0].index] = true
			continue
		}
		if !facts.HistoryComplete || len(routedItems) < 2 || len(routes) != len(routedItems) {
			continue
		}
		ordered := orderConsumptionItems(routedItems, parsed.FilamentSequence)
		if len(ordered) != len(routes) {
			continue
		}
		for index := range ordered {
			applySpoolEvidence(ordered[index], routes[index].value)
			usedEvidence[routes[index].index] = true
		}
	}
	// Some Bambu 3MFs and MQTT status documents use different numeric
	// namespaces for the same physical extruders. H2D, for example, has been
	// observed to encode the two slicer extruders as 1/2 while MQTT identifies
	// their spool routes as 0/1. Do not guess a general offset or side mapping:
	// when every other line is already matched and exactly one valid material
	// and one observed route remain, the final association follows uniquely by
	// elimination. Incomplete histories and larger ambiguous sets stay
	// unresolved for staff correction.
	if facts.HistoryComplete {
		var unmatchedItems []map[string]any
		for _, item := range items {
			if _, matched := item["slotExternalId"]; !matched {
				unmatchedItems = append(unmatchedItems, item)
			}
		}
		var unusedEvidence []bambuSpoolEvidence
		for index, evidence := range facts.SpoolEvidence {
			if usedEvidence[index] || evidence.SlicerFilamentID != "" || evidence.InputUnitExternalID == "" ||
				evidence.SlotExternalID == "" {
				continue
			}
			unusedEvidence = append(unusedEvidence, evidence)
		}
		if len(unmatchedItems) == 1 && len(unusedEvidence) == 1 {
			applySpoolEvidence(unmatchedItems[0], unusedEvidence[0])
		}
	}
	// Preserve compatibility for a single-material run whose current firmware
	// did not expose per-extruder routes.
	if len(items) == 1 && !hasExplicitFilamentRoutes {
		if _, applied := items[0]["slotExternalId"]; !applied {
			applyLegacySpoolEvidence(items[0], facts)
		}
	}
}

func orderConsumptionItems(items []map[string]any, sequence []string) []map[string]any {
	byID := make(map[string]map[string]any, len(items))
	for _, item := range items {
		id, _ := item["slicerFilamentId"].(string)
		if id == "" || byID[id] != nil {
			return nil
		}
		byID[id] = item
	}
	ordered := make([]map[string]any, 0, len(items))
	for _, id := range sequence {
		if item := byID[id]; item != nil {
			ordered = append(ordered, item)
			delete(byID, id)
		}
	}
	if len(byID) != 0 {
		return nil
	}
	return ordered
}

func applyLegacySpoolEvidence(item map[string]any, facts bambuRunFacts) {
	if facts.InputUnitExternalID == "" || facts.SlotExternalID == "" {
		return
	}
	applySpoolEvidence(
		item,
		bambuSpoolEvidence{
			InputUnitExternalID: facts.InputUnitExternalID,
			SlotExternalID:      facts.SlotExternalID,
			TagUID:              facts.TagUID,
		},
	)
}

func applySpoolEvidence(item map[string]any, evidence bambuSpoolEvidence) {
	item["inputUnitExternalId"] = evidence.InputUnitExternalID
	item["slotExternalId"] = evidence.SlotExternalID
	if evidence.TagUID != "" {
		item["tagUid"] = evidence.TagUID
	}
}

func anyInt(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int32:
		return int(typed), true
	case int64:
		return int(typed), true
	case float64:
		return int(typed), typed == float64(int(typed))
	default:
		return 0, false
	}
}

func parsedFilamentForGCode(filaments []parser.Filament, id string) parser.Filament {
	var exact parser.Filament
	for _, filament := range filaments {
		if filament.ID == id {
			exact = filament
			if filament.WeightGrams != nil && *filament.WeightGrams > 0 {
				return filament
			}
		}
	}
	// Bambu G-code M620 uses zero-based filament numbers while slice_info uses
	// one-based IDs. Prefer the adjacent positive-quantity slice record.
	number, err := strconv.Atoi(id)
	if err == nil {
		oneBased := strconv.Itoa(number + 1)
		for _, filament := range filaments {
			if filament.ID == oneBased && filament.WeightGrams != nil && *filament.WeightGrams > 0 {
				return filament
			}
		}
	}
	return exact
}

func baseConsumptionItem(filament parser.Filament, method, version string) map[string]any {
	item := map[string]any{"method": method, "calculationVersion": version}
	if filament.ID != "" {
		item["slicerFilamentId"] = filament.ID
	}
	if filament.WeightGrams != nil {
		item["plannedQuantityGrams"] = decimalString(*filament.WeightGrams)
	}
	if filament.LengthMM != nil {
		item["plannedLengthMillimeters"] = decimalString(*filament.LengthMM)
	}
	if len(filament.Extruders) == 1 {
		item["extruder"] = filament.Extruders[0]
	}
	return item
}

func marshalUnresolvedConsumption(method, version, reason string) (json.RawMessage, error) {
	return json.Marshal(
		map[string]any{
			"items": []map[string]any{
				{
					"slicerFilamentId":   "unresolved",
					"method":             method,
					"calculationVersion": version,
					"quality":            "unresolved",
					"reason":             reason,
				},
			},
		},
	)
}

func decimalString(value float64) string {
	return strconv.FormatFloat(value, 'f', 6, 64)
}
