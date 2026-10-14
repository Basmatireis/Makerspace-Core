package printerconnectors

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// maximumLiveStatusBytes bounds a compact snapshot well below the 64 KiB
// database cap, because jsonb text adds whitespace after separators.
const maximumLiveStatusBytes = 32 << 10

type LiveStatusReport struct {
	AssignmentID         uuid.UUID
	ProtocolVersion      int
	ConfigurationVersion int64
	ObservedAt           time.Time
	Snapshot             json.RawMessage
}

type LiveStatus struct {
	MachineID, AssignmentID uuid.UUID
	ReceivedAt, ObservedAt  time.Time
	Snapshot                json.RawMessage
}

// ReportLiveStatus stores the newest normalized snapshot of one assignment.
// Live status is telemetry: it replaces the previous row, is never audited and
// an older snapshot never overwrites a newer one.
func (s *Service) ReportLiveStatus(ctx context.Context, connector Context, input LiveStatusReport) error {
	if connector.Lifecycle != "active" {
		return apperror.New(403, "printer_connector_inactive", "Connector is not active")
	}
	now := time.Now().UTC()
	if input.AssignmentID == uuid.Nil || input.ProtocolVersion != 1 || input.ConfigurationVersion < 1 || input.ObservedAt.IsZero() || input.ObservedAt.After(now.Add(5*time.Minute)) {
		return validation("invalid live status report")
	}
	if len(input.Snapshot) == 0 || len(input.Snapshot) > maximumLiveStatusBytes {
		return validation("live status snapshot is empty or too large")
	}
	var object map[string]any
	if json.Unmarshal(input.Snapshot, &object) != nil || object == nil {
		return validation("live status snapshot must be a JSON object")
	}
	q := db.New(s.pool)
	assignment, err := q.GetAssignmentForLiveStatus(ctx, db.GetAssignmentForLiveStatusParams{ID: input.AssignmentID, ConnectorID: connector.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if assignment.EndedAt.Valid {
		return apperror.NotFound
	}
	if assignment.ConnectorLifecycle != "active" {
		return apperror.New(403, "printer_connector_inactive", "Connector is not active")
	}
	if !assignment.Enabled || assignment.ConfigurationVersion != input.ConfigurationVersion {
		return conflict("configuration_version_mismatch", "The assignment configuration changed; discard this snapshot")
	}
	return q.UpsertPrinterLiveStatus(ctx, db.UpsertPrinterLiveStatusParams{AssignmentID: assignment.ID, MachineID: assignment.MachineID, ObservedAt: input.ObservedAt.UTC(), ReceivedAt: now, ConfigurationVersion: input.ConfigurationVersion, Snapshot: input.Snapshot})
}

// LiveStatus returns the latest snapshot of the machine's active assignment.
func (s *Service) LiveStatus(ctx context.Context, principal authorization.Principal, machineID uuid.UUID) (LiveStatus, error) {
	if !principal.Has(authorization.MachinesRead) {
		return LiveStatus{}, apperror.PermissionDenied
	}
	row, err := db.New(s.pool).GetActivePrinterLiveStatus(ctx, machineID)
	if errors.Is(err, pgx.ErrNoRows) {
		return LiveStatus{}, apperror.NotFound
	}
	if err != nil {
		return LiveStatus{}, err
	}
	return LiveStatus{MachineID: row.MachineID, AssignmentID: row.AssignmentID, ReceivedAt: row.ReceivedAt, ObservedAt: row.ObservedAt, Snapshot: row.Snapshot}, nil
}
