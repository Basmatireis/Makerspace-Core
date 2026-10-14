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

func (s *Store) ExtendArtifactTransferExpiry(ctx context.Context, assignmentID, runID uuid.UUID, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_transfers SET expires_at=? WHERE assignment_id=? AND run_id=? AND state='pending' AND expires_at<?`, expiresAt.UTC().Format(time.RFC3339Nano), assignmentID.String(), runID.String(), expiresAt.UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Store) PendingArtifactConsumptions(ctx context.Context, assignmentID uuid.UUID, limit int) ([]ArtifactTransfer, error) {
	if limit < 1 || limit > maxArtifactTransfers {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, `SELECT t.id,t.assignment_id,t.run_id,t.configuration_version,t.remote_path,t.file_name,t.staged_path,t.size_bytes,t.sha256,t.attempt_count,t.expires_at
		FROM artifact_transfers t
		WHERE t.assignment_id=? AND t.state='pending' AND NOT EXISTS (
			SELECT 1 FROM artifact_consumption_reports c WHERE c.assignment_id=t.assignment_id AND c.run_id=t.run_id AND c.artifact_sha256=t.sha256
		) ORDER BY t.created_at LIMIT ?`, assignmentID.String(), limit)
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
func (s *Store) EnqueueArtifactConsumption(ctx context.Context, transfer ArtifactTransfer, facts bambuRunFacts, payload json.RawMessage) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM artifact_consumption_reports WHERE assignment_id=? AND run_id=? AND artifact_sha256=?`, transfer.AssignmentID.String(), transfer.RunID.String(), transfer.SHA256).Scan(&exists)
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
	err = tx.QueryRowContext(ctx, `SELECT next_sequence FROM assignment_sequences WHERE assignment_id=?`, transfer.AssignmentID.String()).Scan(&sequence)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.ExecContext(ctx, `INSERT INTO assignment_sequences(assignment_id,next_sequence) VALUES(?,2)`, transfer.AssignmentID.String())
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
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM artifact_upload_receipts WHERE transfer_id=?`, transfer.ID.String()).Scan(&receiptExists)
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
	state, found, err := a.store.BambuState(ctx, a.assignmentID)
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
		payload, buildErr := buildBambuConsumptionPayload(transfer, facts)
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
		return marshalUnresolvedConsumption("gcode_checkpoint", parser.CalculationVersion, "no reliable printer checkpoint was observed")
	}
	filaments := make([]parser.GCodeFilament, 0, len(parsed.Filaments))
	for _, filament := range parsed.Filaments {
		filaments = append(filaments, parser.GCodeFilament{ID: filament.ID, DiameterMM: filament.DiameterMM, DensityGCM3: filament.DensityGCM3, FullLengthMM: filament.LengthMM, FullWeightGrams: filament.WeightGrams})
	}
	options := parser.GCodeOptions{Filaments: filaments}
	if facts.LastLayer != nil {
		options.LastReliableLayer = facts.LastLayer
	} else {
		options.LastReliableProgress = facts.LastProgress
	}
	estimates, err := parser.EstimateArchiveGCode(file, transfer.SizeBytes, parser.DefaultLimits(), options)
	if err != nil {
		return nil, err
	}
	if len(estimates) != 1 {
		return marshalUnresolvedConsumption("gcode_checkpoint", parser.CalculationVersion, "archive does not identify exactly one printable G-code stream")
	}
	return marshalGCodeConsumption(parsed, estimates[0].Estimate, facts)
}

func marshalSlicerConsumption(parsed parser.Result, facts bambuRunFacts) (json.RawMessage, error) {
	items := make([]map[string]any, 0, len(parsed.Filaments))
	for _, filament := range parsed.Filaments {
		item := baseConsumptionItem(filament, "slicer_complete", parser.ParserVersion)
		if filament.WeightGrams != nil && *filament.WeightGrams >= 0 {
			item["estimatedQuantityGrams"] = decimalString(*filament.WeightGrams)
			item["quality"] = "high"
		} else {
			item["quality"] = "unresolved"
		}
		items = append(items, item)
	}
	if len(items) == 0 {
		return marshalUnresolvedConsumption("slicer_complete", parser.ParserVersion, "artifact has no defensible per-filament quantity")
	}
	applySingleFilamentEvidence(items, facts)
	return json.Marshal(map[string]any{"items": items})
}

func marshalGCodeConsumption(parsed parser.Result, estimate parser.GCodeEstimate, facts bambuRunFacts) (json.RawMessage, error) {
	byID := make(map[string]parser.Filament, len(parsed.Filaments))
	for _, filament := range parsed.Filaments {
		byID[filament.ID] = filament
	}
	items := make([]map[string]any, 0, len(estimate.Filaments))
	for _, estimated := range estimate.Filaments {
		item := baseConsumptionItem(byID[estimated.FilamentID], estimate.Method, estimate.CalculationVersion)
		item["slicerFilamentId"] = estimated.FilamentID
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
		if len(estimated.Extruders) == 1 {
			item["extruder"] = estimated.Extruders[0]
		}
		items = append(items, item)
	}
	if len(items) == 0 {
		return marshalUnresolvedConsumption(estimate.Method, estimate.CalculationVersion, "no defensible G-code checkpoint quantity")
	}
	applySingleFilamentEvidence(items, facts)
	return json.Marshal(map[string]any{"items": items})
}

// The last unambiguous active tray is sufficient evidence only for a
// single-filament report. Applying it to every line of a multi-material job
// would incorrectly charge all materials to the final tray used.
func applySingleFilamentEvidence(items []map[string]any, facts bambuRunFacts) {
	if len(items) != 1 || facts.InputUnitExternalID == "" || facts.SlotExternalID == "" {
		return
	}
	items[0]["inputUnitExternalId"] = facts.InputUnitExternalID
	items[0]["slotExternalId"] = facts.SlotExternalID
	if facts.TagUID != "" {
		items[0]["tagUid"] = facts.TagUID
	}
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
	return json.Marshal(map[string]any{"items": []map[string]any{{"slicerFilamentId": "unresolved", "method": method, "calculationVersion": version, "quality": "unresolved", "reason": reason}}})
}

func decimalString(value float64) string {
	return strconv.FormatFloat(value, 'f', 6, 64)
}
