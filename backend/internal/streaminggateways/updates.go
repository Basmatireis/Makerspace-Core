package streaminggateways

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/localupdater"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateways/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// UpdateState is the latest update request of a gateway and how far its updater got.
type UpdateState struct {
	RequestID     uuid.UUID
	TargetVersion string
	RequestedAt   time.Time
	Status        localupdater.RequestState
	Reason        *string
	StatusAt      time.Time
}

func updateStateFrom(row db.StreamingGateway) *UpdateState {
	if row.UpdateRequestID == nil || row.UpdateTargetVersion == nil || row.UpdateStatus == nil {
		return nil
	}
	return &UpdateState{
		RequestID:     *row.UpdateRequestID,
		TargetVersion: *row.UpdateTargetVersion,
		RequestedAt:   row.UpdateRequestedAt.Time.UTC(),
		Status:        localupdater.RequestState(*row.UpdateStatus),
		Reason:        row.UpdateStatusReason,
		StatusAt:      row.UpdateStatusAt.Time.UTC(),
	}
}

// RequestUpdate asks the gateway's updater to install coreVersion, Core's own release. target is the
// version the caller saw; it must still be Core's version. The gateway picks the request up with its
// next configuration poll.
func (s *Service) RequestUpdate(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	target, coreVersion string,
	requestID *uuid.UUID,
) (Gateway, error) {
	if err := requireManage(principal); err != nil {
		return Gateway{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Gateway{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	row, err := q.GetGatewayForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.NotFound
	}
	if err != nil {
		return Gateway{}, err
	}
	current := localupdater.Current{
		Active:           Lifecycle(row.Lifecycle) == LifecycleActive,
		UpdaterAvailable: row.UpdaterAvailable,
		RunningVersion:   row.SoftwareVersion,
	}
	if state := updateStateFrom(row); state != nil {
		current.State, current.StatusAt = &state.Status, state.StatusAt
	}
	if err = localupdater.CheckRequest(coreVersion, target, current, s.now()); err != nil {
		return Gateway{}, err
	}
	updateID := ids.New()
	row, err = q.RequestGatewayUpdate(
		ctx,
		db.RequestGatewayUpdateParams{RequestID: &updateID, TargetVersion: &target, ID: id},
	)
	if err != nil {
		return Gateway{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "streaming_gateway.update_requested",
			ResourceType:   "streaming_gateway",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"update"},
		},
	); err != nil {
		return Gateway{}, err
	}
	result, err := withCredentialExpiry(ctx, q, gatewayFrom(row))
	if err != nil {
		return Gateway{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Gateway{}, err
	}
	return result, nil
}

// recordUpdaterReport stores whether the gateway has an updater and settles its open update request
// from the updater's result.
func recordUpdaterReport(
	ctx context.Context,
	q *db.Queries,
	row db.StreamingGateway,
	report *localupdater.Report,
) (db.StreamingGateway, error) {
	available := report != nil && report.Available
	if available != row.UpdaterAvailable {
		if err := q.SetGatewayUpdaterAvailable(
			ctx,
			db.SetGatewayUpdaterAvailableParams{Available: available, ID: row.ID},
		); err != nil {
			return row, err
		}
		row.UpdaterAvailable = available
	}
	state := updateStateFrom(row)
	if state == nil {
		return row, nil
	}
	running := ""
	if row.SoftwareVersion != nil {
		running = *row.SoftwareVersion
	}
	next, reason, changed := localupdater.Settle(state.Status, state.RequestID, state.TargetVersion, running, report)
	if !changed {
		return row, nil
	}
	status := string(next)
	updated, err := q.SetGatewayUpdateStatus(
		ctx,
		db.SetGatewayUpdateStatusParams{Status: &status, Reason: reason, ID: row.ID, RequestID: &state.RequestID},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return row, nil
	}
	return updated, err
}

// updateOffer is the update request the gateway hands to its updater, while one is open.
func updateOffer(row db.StreamingGateway) *localupdater.Request {
	state := updateStateFrom(row)
	if state == nil || !state.Status.Open() {
		return nil
	}
	return &localupdater.Request{RequestID: state.RequestID, Version: state.TargetVersion}
}
