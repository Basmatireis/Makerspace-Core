package printerconnectors

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Configuration(ctx context.Context, connector Context) (Configuration, error) {
	if connector.Lifecycle != "active" && connector.Lifecycle != "disabled" {
		return Configuration{}, apperror.New(
			http.StatusForbidden,
			"printer_connector_inactive",
			"Connector is not active",
		)
	}
	q := db.New(s.pool)
	row, err := q.GetConnector(ctx, connector.ID)
	if err != nil {
		return Configuration{}, err
	}
	if connector.Lifecycle == "disabled" {
		return Configuration{
			Revision:        row.ConfigurationRevision,
			ProtocolVersion: 1,
			Assignments:     []RuntimeAssignment{},
		}, nil
	}
	assignments, err := q.ListActiveAssignments(ctx, connector.ID)
	if err != nil {
		return Configuration{}, err
	}
	result := Configuration{
		Revision:        row.ConfigurationRevision,
		ProtocolVersion: 1,
		Assignments:     make([]RuntimeAssignment, 0, len(assignments)),
	}
	for _, a := range assignments {
		secrets := map[string]string{}
		if len(a.EncryptedSecrets) != 0 {
			if s.keyring == nil {
				return Configuration{}, apperror.Conflicting(
					"encryption_not_configured",
					"Printer credentials cannot be decrypted",
				)
			}
			plain, decryptErr := s.keyring.Decrypt(a.EncryptedSecrets, "printer-connector-assignment:"+a.ID.String())
			if decryptErr != nil {
				return Configuration{}, decryptErr
			}
			if json.Unmarshal(plain, &secrets) != nil {
				return Configuration{}, errors.New("decode printer credentials")
			}
		}
		result.Assignments = append(
			result.Assignments,
			RuntimeAssignment{
				ID:                   a.ID,
				MachineID:            a.MachineID,
				MachineName:          a.MachineName,
				AdapterKind:          a.AdapterKind,
				AdapterSchemaVersion: int(a.AdapterSchemaVersion),
				ConfigurationVersion: a.ConfigurationVersion,
				Settings:             a.Settings,
				Secrets:              secrets,
				Enabled:              a.Enabled && a.PrinterEnabled,
			},
		)
	}
	return result, nil
}

func (s *Service) Heartbeat(ctx context.Context, connector Context, input Heartbeat) (Connector, error) {
	if connector.Lifecycle != "active" {
		return Connector{}, apperror.New(http.StatusForbidden, "printer_connector_inactive", "Connector is not active")
	}
	input.SoftwareVersion = strings.TrimSpace(input.SoftwareVersion)
	input.HealthState = strings.TrimSpace(input.HealthState)
	if input.SoftwareVersion == "" || len(input.SoftwareVersion) > 80 || input.ProtocolVersion != 1 ||
		(input.HealthState != "connected" && input.HealthState != "degraded") ||
		input.AppliedConfigurationRevision < 0 ||
		input.PendingEventCount < 0 ||
		input.QuarantinedEventCount < 0 {
		return Connector{}, apperror.Invalid("invalid heartbeat")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	for _, h := range input.Assignments {
		if h.AppliedConfigurationVersion < 0 ||
			(h.State != "connecting" && h.State != "connected" && h.State != "disconnected" && h.State != "degraded" && h.State != "disabled") {
			return Connector{}, apperror.Invalid("invalid assignment health")
		}
		if err = q.UpdateAssignmentRuntime(
			ctx,
			db.UpdateAssignmentRuntimeParams{
				AppliedConfigurationVersion: h.AppliedConfigurationVersion,
				RuntimeState:                &h.State,
				RuntimeErrorCode:            h.ErrorCode,
				ID:                          h.AssignmentID,
				ConnectorID:                 connector.ID,
			},
		); err != nil {
			return Connector{}, err
		}
	}
	row, err := q.RecordHeartbeat(
		ctx,
		db.RecordHeartbeatParams{
			SoftwareVersion:              &input.SoftwareVersion,
			ProtocolVersion:              int32Pointer(input.ProtocolVersion),
			AppliedConfigurationRevision: input.AppliedConfigurationRevision,
			HealthState:                  &input.HealthState,
			HealthSummary:                input.HealthSummary,
			PendingEventCount:            input.PendingEventCount,
			QuarantinedEventCount:        input.QuarantinedEventCount,
			ID:                           connector.ID,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.New(http.StatusForbidden, "printer_connector_inactive", "Connector is not active")
	}
	if err != nil {
		return Connector{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return connectorFrom(row), nil
}

func int32Pointer(value int) *int32 { v := int32(value); return &v }

func (s *Service) IngestEvents(ctx context.Context, connector Context, inputs []EventInput) ([]EventReceipt, error) {
	if connector.Lifecycle != "active" {
		return nil, apperror.New(http.StatusForbidden, "printer_connector_inactive", "Connector is not active")
	}
	if len(inputs) == 0 || len(inputs) > 20 {
		return nil, apperror.Invalid("events must contain between 1 and 20 items")
	}
	seen := map[uuid.UUID]struct{}{}
	receipts := make([]EventReceipt, 0, len(inputs))
	for _, input := range inputs {
		if _, duplicate := seen[input.EventID]; duplicate {
			reason := "duplicate_event_in_batch"
			receipts = append(receipts, EventReceipt{EventID: input.EventID, Status: "rejected", ReasonCode: &reason})
			continue
		}
		seen[input.EventID] = struct{}{}
		receipt := s.ingestOne(ctx, connector, input)
		receipts = append(receipts, receipt)
	}
	return receipts, nil
}

func (s *Service) ingestOne(ctx context.Context, connector Context, input EventInput) EventReceipt {
	rejected := func(code string) EventReceipt {
		return EventReceipt{EventID: input.EventID, Status: "rejected", ReasonCode: &code}
	}
	if input.EventID == uuid.Nil || input.AssignmentID == uuid.Nil || input.ConfigurationVersion < 1 ||
		input.Sequence < 1 ||
		input.OccurredAt.IsZero() ||
		input.OccurredAt.After(time.Now().UTC().Add(5*time.Minute)) ||
		len(input.Payload) > 32768 {
		return rejected("invalid_event")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		code := "temporarily_unavailable"
		return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
	}
	defer func() { _ = tx.Rollback(ctx) }()
	a, err := db.New(tx).
		GetAssignmentForIngress(
			ctx,
			db.GetAssignmentForIngressParams{ID: input.AssignmentID, ConnectorID: connector.ID},
		)
	if errors.Is(err, pgx.ErrNoRows) {
		return rejected("assignment_not_found")
	}
	if err != nil {
		code := "temporarily_unavailable"
		return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
	}
	applicationState, reason := "applied", (*string)(nil)
	if a.EndedAt.Valid || a.ConnectorLifecycle != "active" || !a.Enabled {
		applicationState = "review_required"
		v := "stale_assignment"
		reason = &v
	} else if input.ConfigurationVersion != a.ConfigurationVersion {
		applicationState = "review_required"
		v := "configuration_version_mismatch"
		reason = &v
	}
	var run db.MachineRun
	runDeleted := false
	if input.RunID != nil {
		state, stateErr := recordedRunState(input.Kind, input.Payload)
		if stateErr != nil {
			return rejected("invalid_event")
		}
		// Lock the run's job before the run, the order of every job operation.
		// An unknown run is created below and needs no lock.
		if _, _, lockErr := machinelogbook.LockRunChain(ctx, tx, *input.RunID); lockErr != nil &&
			!apperror.IsCode(lockErr, "not_found") {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
		var runErr error
		run, runErr = recordObservedRun(
			ctx,
			db.New(tx),
			*input.RunID,
			a.ID,
			a.MachineID,
			input.ExternalPrintID,
			state,
			input.HistoryComplete,
			input.OccurredAt,
		)
		if errors.Is(runErr, pgx.ErrNoRows) {
			return rejected("observed_run_conflict")
		}
		if errors.Is(runErr, errRunDeleted) {
			// Staff deleted the run. The event is stored for idempotency but
			// never resurrects or changes the run.
			runDeleted = true
			applicationState = "recorded"
			v := "run_deleted"
			reason = &v
			runErr = nil
		}
		if runErr != nil {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
		if !runDeleted && !run.HistoryComplete && applicationState == "applied" {
			applicationState = "review_required"
			v := "incomplete_run_history"
			reason = &v
		}
	}
	event, inserted, err := s.printing.IngestConnectorEvent(
		ctx,
		tx,
		printing.ConnectorEventInput{
			EventID:              input.EventID,
			ConnectorID:          connector.ID,
			AssignmentID:         a.ID,
			MachineID:            a.MachineID,
			RunID:                input.RunID,
			ConfigurationVersion: input.ConfigurationVersion,
			Sequence:             input.Sequence,
			Kind:                 printing.EventKind(input.Kind),
			OccurredAt:           input.OccurredAt,
			ExternalPrintID:      input.ExternalPrintID,
			Payload:              input.Payload,
			ReportRevision:       input.ReportRevision,
			ApplicationState:     printing.ApplicationState(applicationState),
			ApplicationReason:    reason,
		},
	)
	if err != nil {
		if apperror.IsCode(err, "printer_event_mismatch") || apperror.IsCode(err, "printer_event_sequence_conflict") ||
			apperror.IsCode(err, "validation_failed") {
			return rejected(apperrorCode(err))
		}
		code := "temporarily_unavailable"
		return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
	}
	if inserted && input.RunID != nil && !runDeleted {
		if err = applyPrintFacts(
			ctx,
			db.New(tx),
			run,
			event.ID,
			input.Kind,
			input.Payload,
			input.OccurredAt,
			input.ReportRevision,
		); err != nil {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
		// The recorded run's outcome, material usage and job price follow the
		// event in the same transaction.
		if err = s.logbook.ApplyRecordedRunEvent(
			ctx,
			tx,
			machinelogbook.RecordedRunEvent{RunID: run.ID, ConnectorID: connector.ID, Kind: input.Kind},
		); err != nil {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
	}
	if inserted && input.Kind == "printer_error" {
		if err = applyPrinterError(
			ctx,
			db.New(tx),
			a.MachineID,
			a.ID,
			input.RunID,
			input.Payload,
			input.OccurredAt,
		); err != nil {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
	}
	if inserted && input.Kind == "slot_observation" && applicationState == "applied" &&
		isBambuLANAdapter(a.AdapterKind) &&
		bambuAutoDetectSpools(a.Settings) {
		if err = reconcileBambuSlotObservation(
			ctx,
			tx,
			connector.ID,
			a.ID,
			a.MachineID,
			event.ID,
			input.Payload,
			input.OccurredAt,
		); err != nil {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		code := "temporarily_unavailable"
		return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
	}
	status := "accepted"
	if !inserted {
		status = "duplicate"
	}
	id := event.ID
	return EventReceipt{EventID: input.EventID, CoreEventID: &id, Status: status}
}

func isBambuLANAdapter(kind string) bool {
	return kind == "bambu_h2d" || kind == "bambu_x1c"
}

func applyPrinterError(
	ctx context.Context,
	q *db.Queries,
	machineID, assignmentID uuid.UUID,
	runID *uuid.UUID,
	payload json.RawMessage,
	observedAt time.Time,
) error {
	var value struct {
		Transition   string `json:"transition"`
		SourceFamily string `json:"sourceFamily"`
		Code         string `json:"code"`
	}
	if json.Unmarshal(payload, &value) != nil {
		return nil //nolint:nilerr // a malformed connector payload is ignored
	}
	value.Transition = strings.TrimSpace(value.Transition)
	value.SourceFamily = strings.TrimSpace(value.SourceFamily)
	value.Code = strings.TrimSpace(value.Code)
	if (value.Transition != "appeared" && value.Transition != "cleared") || value.SourceFamily == "" ||
		len(value.SourceFamily) > 80 ||
		value.Code == "" ||
		len(value.Code) > 120 {
		return nil
	}
	if value.Transition == "cleared" {
		return q.ResolvePrinterErrorOccurrence(
			ctx,
			db.ResolvePrinterErrorOccurrenceParams{
				AssignmentID: &assignmentID,
				SourceFamily: value.SourceFamily,
				OriginalCode: value.Code,
				ObservedAt:   observedAt.UTC(),
			},
		)
	}
	return q.UpsertPrinterErrorOccurrence(
		ctx,
		db.UpsertPrinterErrorOccurrenceParams{
			ID:           ids.New(),
			MachineID:    machineID,
			AssignmentID: &assignmentID,
			RunID:        runID,
			SourceFamily: value.SourceFamily,
			OriginalCode: value.Code,
			ObservedAt:   observedAt.UTC(),
			Context:      json.RawMessage(`{}`),
		},
	)
}

func recordedRunState(kind string, payload json.RawMessage) (string, error) {
	switch kind {
	case "progress":
		return "running", nil
	case "terminal_outcome":
		var value struct {
			Outcome string `json:"outcome"`
		}
		if json.Unmarshal(payload, &value) != nil {
			return "", errors.New("invalid terminal outcome")
		}
		switch value.Outcome {
		case "completed":
			return "finished", nil
		case "failed", "cancelled", "unknown":
			return value.Outcome, nil
		default:
			return "", errors.New("invalid terminal outcome")
		}
	case "operational_state":
		var value struct {
			State string `json:"state"`
		}
		if json.Unmarshal(payload, &value) == nil && value.State == "printing" {
			return "running", nil
		}
	}
	return "running", nil
}

func apperrorCode(err error) string {
	for _, code := range []string{"printer_event_mismatch", "printer_event_sequence_conflict", "validation_failed"} {
		if apperror.IsCode(err, code) {
			return code
		}
	}
	return "invalid_event"
}

func databaseError(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), "unique") || strings.Contains(err.Error(), "duplicate") {
		return apperror.Conflicting("printer_connector_conflict", "Connector identity or assignment already exists")
	}
	if strings.Contains(err.Error(), "foreign key") {
		return apperror.NotFound
	}
	return err
}
