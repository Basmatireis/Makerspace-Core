package printerconnectors

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// errCameraStreamingAdapter rejects the camera relay for adapters that expose no camera.
var errCameraStreamingAdapter = apperror.Invalid("cameraStreaming is only available for Bambu printers")

func (s *Service) CreateAssignment(
	ctx context.Context,
	principal authorization.Principal,
	connectorID uuid.UUID,
	input AssignmentInput,
	requestID *uuid.UUID,
) (Assignment, error) {
	if !principal.Has(authorization.PrinterConnectorsManage) || !principal.Has(authorization.MachinesManage) {
		return Assignment{}, apperror.PermissionDenied
	}
	input.AdapterKind = AdapterKind(strings.TrimSpace(string(input.AdapterKind)))
	if input.AdapterKind == "" || len(input.AdapterKind) > 80 {
		return Assignment{}, apperror.Invalid("adapterKind and supported schema version are required")
	}
	if input.CameraStreaming && !isBambuLANAdapter(input.AdapterKind) {
		return Assignment{}, errCameraStreamingAdapter
	}
	var err error
	input.Settings, input.Secrets, err = validateAssignmentContract(
		input.AdapterKind,
		input.AdapterSchemaVersion,
		input.Settings,
		input.Secrets,
		true,
	)
	if err != nil {
		return Assignment{}, err
	}
	var encrypted []byte
	if len(input.Secrets) != 0 {
		if s.keyring == nil {
			return Assignment{}, apperror.Conflicting(
				"encryption_not_configured",
				"Application encryption must be configured before storing printer credentials",
			)
		}
		plain, err := json.Marshal(input.Secrets)
		if err != nil {
			return Assignment{}, apperror.Invalid("invalid printer secrets")
		}
		assignmentID := ids.New()
		encrypted, err = s.keyring.Encrypt(plain, "printer-connector-assignment:"+assignmentID.String())
		if err != nil {
			return Assignment{}, err
		}
		return s.createAssignment(ctx, principal, connectorID, assignmentID, input, encrypted, requestID)
	}
	return s.createAssignment(ctx, principal, connectorID, ids.New(), input, nil, requestID)
}

func (s *Service) ListAssignments(
	ctx context.Context,
	principal authorization.Principal,
	connectorID uuid.UUID,
) ([]Assignment, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return nil, apperror.PermissionDenied
	}
	if _, err := db.New(s.pool).GetConnector(ctx, connectorID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListConnectorAssignments(ctx, connectorID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	result := make([]Assignment, 0, len(rows))
	for _, row := range rows {
		result = append(
			result,
			Assignment{
				ID:                   row.ID,
				ConnectorID:          row.ConnectorID,
				MachineID:            row.MachineID,
				MachineName:          row.MachineName,
				AdapterKind:          AdapterKind(row.AdapterKind),
				AdapterSchemaVersion: int(row.AdapterSchemaVersion),
				Settings:             row.Settings,
				ConfigurationVersion: row.ConfigurationVersion,
				AppliedVersion:       row.AppliedConfigurationVersion,
				Enabled:              row.Enabled,
				CameraStreaming:      row.CameraStreaming,
				Camera: assignmentCamera(
					row.CameraStreaming, row.CameraHealth, row.CameraViewers, row.CameraReportedAt, now,
				),
				RuntimeState:     optional.Convert[AssignmentState](row.RuntimeState),
				RuntimeErrorCode: row.RuntimeErrorCode,
				ActivatedAt:      row.ActivatedAt,
				EndedAt:          nullableTime(row.EndedAt),
				Version:          row.Version,
				CreatedAt:        row.CreatedAt,
				UpdatedAt:        row.UpdatedAt,
			},
		)
	}
	return result, nil
}

func (s *Service) UpdateAssignment(
	ctx context.Context,
	principal authorization.Principal,
	connectorID, assignmentID uuid.UUID,
	input AssignmentUpdate,
	requestID *uuid.UUID,
) (Assignment, error) {
	if !principal.Has(authorization.PrinterConnectorsManage) || !principal.Has(authorization.MachinesManage) {
		return Assignment{}, apperror.PermissionDenied
	}
	input.AdapterKind = AdapterKind(strings.TrimSpace(string(input.AdapterKind)))
	if input.AdapterKind == "" || len(input.AdapterKind) > 80 {
		return Assignment{}, apperror.Invalid("adapterKind and supported schema version are required")
	}
	if input.CameraStreaming != nil && *input.CameraStreaming && !isBambuLANAdapter(input.AdapterKind) {
		return Assignment{}, errCameraStreamingAdapter
	}
	providedSecrets := map[string]string{}
	if input.Secrets != nil {
		providedSecrets = *input.Secrets
	}
	var contractErr error
	input.Settings, providedSecrets, contractErr = validateAssignmentContract(
		input.AdapterKind,
		input.AdapterSchemaVersion,
		input.Settings,
		providedSecrets,
		false,
	)
	if contractErr != nil {
		return Assignment{}, contractErr
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	current, err := q.GetAssignmentForUpdate(
		ctx,
		db.GetAssignmentForUpdateParams{ID: assignmentID, ConnectorID: connectorID},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	if current.EndedAt.Valid {
		return Assignment{}, apperror.Conflicting(
			"printer_connector_assignment_ended",
			"An ended assignment cannot be updated",
		)
	}
	encrypted := current.EncryptedSecrets
	if input.Secrets != nil && (!isBambuLANAdapter(input.AdapterKind) || len(providedSecrets) != 0) {
		encrypted = nil
		if len(providedSecrets) != 0 {
			if s.keyring == nil {
				return Assignment{}, apperror.Conflicting(
					"encryption_not_configured",
					"Application encryption must be configured before storing printer credentials",
				)
			}
			plain, marshalErr := json.Marshal(providedSecrets)
			if marshalErr != nil {
				return Assignment{}, apperror.Invalid("invalid printer secrets")
			}
			encrypted, err = s.keyring.Encrypt(plain, "printer-connector-assignment:"+assignmentID.String())
			if err != nil {
				return Assignment{}, err
			}
		}
	}
	cameraStreaming := current.CameraStreaming
	if input.CameraStreaming != nil {
		cameraStreaming = *input.CameraStreaming
	}
	if cameraStreaming && !input.End && !isBambuLANAdapter(input.AdapterKind) {
		// The adapter changed away from Bambu while the camera relay was on.
		return Assignment{}, errCameraStreamingAdapter
	}
	_, err = q.UpdateAssignment(
		ctx,
		db.UpdateAssignmentParams{
			AdapterKind:          string(input.AdapterKind),
			AdapterSchemaVersion: int32(input.AdapterSchemaVersion),
			Settings:             input.Settings,
			EncryptedSecrets:     encrypted,
			Enabled:              input.Enabled,
			CameraStreaming:      cameraStreaming,
			EndAssignment:        input.End,
			ID:                   assignmentID,
			ConnectorID:          connectorID,
			ExpectedVersion:      input.ExpectedVersion,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.StaleWrite
	}
	if err != nil {
		return Assignment{}, databaseError(err)
	}
	if _, err = q.BumpConnectorConfiguration(ctx, connectorID); err != nil {
		return Assignment{}, err
	}
	row, err := q.GetAssignment(ctx, db.GetAssignmentParams{ID: assignmentID, ConnectorID: connectorID})
	if err != nil {
		return Assignment{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "printer_connector.assignment_updated",
			ResourceType:   "printer_connector_assignment",
			ResourceID:     &assignmentID,
			RequestID:      requestID,
			ChangedFields:  []string{"adapterKind", "configuration", "enabled", "endedAt", "cameraStreaming"},
		},
	); err != nil {
		return Assignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	return Assignment{
		ID:                   row.ID,
		ConnectorID:          row.ConnectorID,
		MachineID:            row.MachineID,
		MachineName:          row.MachineName,
		AdapterKind:          AdapterKind(row.AdapterKind),
		AdapterSchemaVersion: int(row.AdapterSchemaVersion),
		Settings:             row.Settings,
		ConfigurationVersion: row.ConfigurationVersion,
		AppliedVersion:       row.AppliedConfigurationVersion,
		Enabled:              row.Enabled,
		CameraStreaming:      row.CameraStreaming,
		Camera: assignmentCamera(
			row.CameraStreaming, row.CameraHealth, row.CameraViewers, row.CameraReportedAt, time.Now().UTC(),
		),
		RuntimeState:     optional.Convert[AssignmentState](row.RuntimeState),
		RuntimeErrorCode: row.RuntimeErrorCode,
		ActivatedAt:      row.ActivatedAt,
		EndedAt:          nullableTime(row.EndedAt),
		Version:          row.Version,
		CreatedAt:        row.CreatedAt,
		UpdatedAt:        row.UpdatedAt,
	}, nil
}

func (s *Service) ListObservedRuns(
	ctx context.Context,
	principal authorization.Principal,
	connectorID uuid.UUID,
) ([]ObservedRun, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return nil, apperror.PermissionDenied
	}
	if _, err := db.New(s.pool).GetConnector(ctx, connectorID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListObservedRuns(ctx, connectorID)
	if err != nil {
		return nil, err
	}
	result := make([]ObservedRun, 0, len(rows))
	for _, row := range rows {
		if row.AssignmentID == nil || row.State == nil || !row.FirstObservedAt.Valid || !row.LastObservedAt.Valid {
			continue
		}
		result = append(
			result,
			ObservedRun{
				ID:              row.ID,
				AssignmentID:    *row.AssignmentID,
				MachineID:       row.MachineID,
				MachineName:     row.MachineName,
				VendorJobID:     row.VendorJobID,
				State:           RunState(*row.State),
				HistoryComplete: row.HistoryComplete,
				FirstObservedAt: row.FirstObservedAt.Time,
				LastObservedAt:  row.LastObservedAt.Time,
				Version:         row.Version,
			},
		)
	}
	return result, nil
}

func (s *Service) ListEvents(
	ctx context.Context,
	principal authorization.Principal,
	connectorID uuid.UUID,
	includeCleared bool,
) ([]ConnectorEvent, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return nil, apperror.PermissionDenied
	}
	q := db.New(s.pool)
	if _, err := q.GetConnector(ctx, connectorID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := q.ListConnectorEvents(
		ctx,
		db.ListConnectorEventsParams{ConnectorID: &connectorID, IncludeCleared: includeCleared},
	)
	if err != nil {
		return nil, err
	}
	result := make([]ConnectorEvent, 0, len(rows))
	for _, row := range rows {
		if row.MachineID == nil || row.ConnectorAssignmentID == nil {
			return nil, errors.New("connector event is missing assignment metadata")
		}
		result = append(
			result,
			ConnectorEvent{
				ID:                row.ID,
				MachineID:         *row.MachineID,
				AssignmentID:      *row.ConnectorAssignmentID,
				Kind:              printing.EventKind(row.Kind),
				OccurredAt:        row.OccurredAt,
				ReceivedAt:        row.ReceivedAt,
				ApplicationState:  printing.ApplicationState(row.ApplicationState),
				ApplicationReason: row.ApplicationReason,
				Payload:           row.Payload,
			},
		)
	}
	return result, nil
}

func (s *Service) createAssignment(
	ctx context.Context,
	principal authorization.Principal,
	connectorID, assignmentID uuid.UUID,
	input AssignmentInput,
	encrypted []byte,
	requestID *uuid.UUID,
) (Assignment, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	connector, err := q.GetConnectorForUpdate(ctx, connectorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	if Lifecycle(connector.Lifecycle) == LifecycleRevoked {
		return Assignment{}, apperror.Conflicting(
			"printer_connector_revoked",
			"A revoked connector cannot receive printers",
		)
	}
	row, err := q.CreateAssignment(
		ctx,
		db.CreateAssignmentParams{
			ID:                   assignmentID,
			ConnectorID:          connectorID,
			MachineID:            input.MachineID,
			AdapterKind:          string(input.AdapterKind),
			AdapterSchemaVersion: int32(input.AdapterSchemaVersion),
			Settings:             input.Settings,
			EncryptedSecrets:     encrypted,
			Enabled:              input.Enabled,
			CameraStreaming:      input.CameraStreaming,
		},
	)
	if err != nil {
		return Assignment{}, databaseError(err)
	}
	if _, err = q.BumpConnectorConfiguration(ctx, connectorID); err != nil {
		return Assignment{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "printer_connector.assignment_created",
			ResourceType:   "printer_connector_assignment",
			ResourceID:     &assignmentID,
			RequestID:      requestID,
			ChangedFields:  []string{"connectorId", "machineId", "adapterKind", "configuration", "cameraStreaming"},
		},
	); err != nil {
		return Assignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	return Assignment{
		ID:                   row.ID,
		ConnectorID:          row.ConnectorID,
		MachineID:            row.MachineID,
		AdapterKind:          AdapterKind(row.AdapterKind),
		AdapterSchemaVersion: int(row.AdapterSchemaVersion),
		Settings:             row.Settings,
		ConfigurationVersion: row.ConfigurationVersion,
		AppliedVersion:       row.AppliedConfigurationVersion,
		Enabled:              row.Enabled,
		CameraStreaming:      row.CameraStreaming,
		Camera:               AssignmentCamera{Health: CameraUnknown},
		ActivatedAt:          row.ActivatedAt,
		Version:              row.Version,
		CreatedAt:            row.CreatedAt,
		UpdatedAt:            row.UpdatedAt,
	}, nil
}
