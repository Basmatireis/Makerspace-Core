package runrecordings

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RequestCommand asks the connector that recorded a run to re-fetch its 3MF or to
// recompute its consumption. It returns the open command of the same kind instead
// of creating a second one (created is then false). Requests are limited to
// CommandsPerRunWindow per run and CommandRateWindow.
func (s *Service) RequestCommand(
	ctx context.Context,
	p authorization.Principal,
	runID uuid.UUID,
	kind CommandKind,
	requestID *uuid.UUID,
) (Command, bool, error) {
	if !p.Has(authorization.MachineJobsEdit) {
		return Command{}, false, apperror.PermissionDenied
	}
	if kind != CommandRefetchArtifact && kind != CommandRecomputeConsumption {
		return Command{}, false, apperror.Invalid("unsupported command")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Command{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	target, err := q.GetRunCommandTargetForUpdate(ctx, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Command{}, false, apperror.NotFound
	}
	if err != nil {
		return Command{}, false, err
	}
	if err = commandAllowed(target, kind); err != nil {
		return Command{}, false, err
	}
	open, err := q.GetOpenRunCommand(ctx, db.GetOpenRunCommandParams{RunID: runID, Kind: string(kind)})
	if err == nil {
		return commandFrom(open), false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Command{}, false, err
	}
	now := s.now()
	if !target.CommandsPolledAt.Valid || now.Sub(target.CommandsPolledAt.Time) > CommandPollFreshness {
		return Command{}, false, apperror.Conflicting(
			"connector_commands_unavailable",
			"The run's printer connector does not receive commands; update or start it",
		)
	}
	recent, err := q.CountRunCommandsSince(ctx, db.CountRunCommandsSinceParams{RunID: runID, Since: now.Add(-CommandRateWindow)})
	if err != nil {
		return Command{}, false, err
	}
	if recent.Recent >= CommandsPerRunWindow {
		retryAfter := max(recent.Oldest.Add(CommandRateWindow).Sub(now), time.Second)
		return Command{}, false, apperror.RateLimited(
			"run_command_rate_limited",
			"Too many commands for this run; try again later",
			retryAfter,
		)
	}
	row, err := q.InsertRunCommand(ctx, db.InsertRunCommandParams{
		ID:           ids.New(),
		RunID:        runID,
		ConnectorID:  target.ConnectorID,
		AssignmentID: target.AssignmentID,
		Kind:         string(kind),
	})
	if err != nil {
		return Command{}, false, err
	}
	actor := p.AccountID
	action := "machine_run.artifact_refetch_requested"
	if kind == CommandRecomputeConsumption {
		action = "machine_run.consumption_recompute_requested"
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         action,
		ResourceType:   "machine_run",
		ResourceID:     &runID,
		RequestID:      requestID,
		Metadata:       map[string]any{"commandId": row.ID.String()},
	}); err != nil {
		return Command{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Command{}, false, err
	}
	return commandFrom(row), true, nil
}

func commandAllowed(target db.GetRunCommandTargetForUpdateRow, kind CommandKind) error {
	if target.Source != "recorded" {
		return apperror.Conflicting("run_not_recorded", "Only runs recorded by a printer connector have connector commands")
	}
	if target.State != nil && *target.State == "running" {
		return apperror.Conflicting("run_running", "Wait until the run has ended")
	}
	if target.AssignmentActive == nil || !*target.AssignmentActive || target.ConnectorID == nil ||
		target.ConnectorLifecycle == nil || printerconnectors.Lifecycle(*target.ConnectorLifecycle) != printerconnectors.LifecycleActive {
		return apperror.Conflicting(
			"run_connector_unavailable",
			"The printer connector that recorded the run is no longer assigned or active",
		)
	}
	if kind == CommandRecomputeConsumption && target.ArtifactID == nil {
		return apperror.Conflicting("run_artifact_missing", "The run has no 3MF to recompute from; re-fetch it first")
	}
	return nil
}

// ConnectorCommands lists the connector's open commands and records that it polls.
func (s *Service) ConnectorCommands(ctx context.Context, connector printerconnectors.Context) ([]Command, error) {
	if connector.Lifecycle != printerconnectors.LifecycleActive {
		return nil, apperror.New(http.StatusForbidden, "printer_connector_inactive", "Connector is not active")
	}
	q := db.New(s.pool)
	if err := q.MarkConnectorCommandsPolled(ctx, connector.ID); err != nil {
		return nil, err
	}
	rows, err := q.ListOpenConnectorCommands(ctx, &connector.ID)
	if err != nil {
		return nil, err
	}
	result := make([]Command, 0, len(rows))
	for _, row := range rows {
		result = append(result, commandFrom(row))
	}
	return result, nil
}

// ReportCommandStatus applies a connector's status for one of its commands.
func (s *Service) ReportCommandStatus(
	ctx context.Context,
	connector printerconnectors.Context,
	commandID uuid.UUID,
	state CommandState,
	reasonCode *string,
) error {
	if connector.Lifecycle != printerconnectors.LifecycleActive {
		return apperror.New(http.StatusForbidden, "printer_connector_inactive", "Connector is not active")
	}
	if state != CommandRunning && state != CommandSucceeded && state != CommandFailed {
		return apperror.Invalid("unsupported command state")
	}
	if reasonCode != nil && !reasonPattern.MatchString(*reasonCode) {
		return apperror.Invalid("invalid reason code")
	}
	if state != CommandFailed {
		reasonCode = nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	row, err := q.GetConnectorCommandForUpdate(ctx, db.GetConnectorCommandForUpdateParams{ID: commandID, ConnectorID: &connector.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	current := CommandState(row.State)
	if current == state {
		return nil
	}
	if current == CommandSucceeded || current == CommandFailed || (current == CommandRunning && state == CommandRunning) {
		return apperror.Conflicting("command_finished", "The command has already finished")
	}
	if _, err = q.SetRunCommandState(ctx, db.SetRunCommandStateParams{ID: commandID, State: string(state), ReasonCode: reasonCode}); err != nil {
		return fmt.Errorf("set run command state: %w", err)
	}
	return tx.Commit(ctx)
}

func commandFrom(row db.MachineRunCommand) Command {
	command := Command{
		ID:           row.ID,
		RunID:        row.RunID,
		AssignmentID: row.AssignmentID,
		Kind:         CommandKind(row.Kind),
		State:        CommandState(row.State),
		ReasonCode:   row.ReasonCode,
		RequestedAt:  row.RequestedAt.UTC(),
	}
	if row.StartedAt.Valid {
		value := row.StartedAt.Time.UTC()
		command.StartedAt = &value
	}
	if row.FinishedAt.Valid {
		value := row.FinishedAt.Time.UTC()
		command.FinishedAt = &value
	}
	return command
}

// RequestRecomputeAfterArtifact queues a consumption recompute for a run whose 3MF staff just attached,
// inside the caller's transaction (which holds the run's lock and commits the attachment). A running run needs
// none: the connector uses the file when the run ends. Anything that keeps the connector from taking the
// command (removed, too old, rate limited) is not an error; the outcome says so and the consumption stays
// as it was.
func (s *Service) RequestRecomputeAfterArtifact(
	ctx context.Context,
	tx pgx.Tx,
	actor uuid.UUID,
	runID uuid.UUID,
	requestID *uuid.UUID,
) (RecomputeOutcome, error) {
	q := db.New(tx)
	target, err := q.GetRunCommandTargetForUpdate(ctx, runID)
	if err != nil {
		return "", err
	}
	if target.State != nil && *target.State == "running" {
		return RecomputeNotNeeded, nil
	}
	if commandAllowed(target, CommandRecomputeConsumption) != nil {
		return RecomputeUnavailable, nil //nolint:nilerr // a run that takes no commands is an outcome, not a failure
	}
	if _, err = q.GetOpenRunCommand(ctx, db.GetOpenRunCommandParams{
		RunID: runID,
		Kind:  string(CommandRecomputeConsumption),
	}); err == nil {
		return RecomputeAlreadyRequested, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	now := s.now()
	if !target.CommandsPolledAt.Valid || now.Sub(target.CommandsPolledAt.Time) > CommandPollFreshness {
		return RecomputeUnavailable, nil
	}
	recent, err := q.CountRunCommandsSince(ctx, db.CountRunCommandsSinceParams{RunID: runID, Since: now.Add(-CommandRateWindow)})
	if err != nil {
		return "", err
	}
	if recent.Recent >= CommandsPerRunWindow {
		return RecomputeUnavailable, nil
	}
	row, err := q.InsertRunCommand(ctx, db.InsertRunCommandParams{
		ID:           ids.New(),
		RunID:        runID,
		ConnectorID:  target.ConnectorID,
		AssignmentID: target.AssignmentID,
		Kind:         string(CommandRecomputeConsumption),
	})
	if err != nil {
		return "", err
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "machine_run.consumption_recompute_requested",
		ResourceType:   "machine_run",
		ResourceID:     &runID,
		RequestID:      requestID,
		Metadata:       map[string]any{"commandId": row.ID.String()},
	}); err != nil {
		return "", err
	}
	return RecomputeRequested, nil
}
