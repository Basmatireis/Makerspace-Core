package streaminggateways

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateways/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Create(
	ctx context.Context,
	principal authorization.Principal,
	name, publicHost string,
	requestID *uuid.UUID,
) (Gateway, error) {
	if err := requireManage(principal); err != nil {
		return Gateway{}, err
	}
	name, err := normalizeName(name)
	if err != nil {
		return Gateway{}, err
	}
	if publicHost, err = NormalizePublicHost(publicHost); err != nil {
		return Gateway{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Gateway{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := ids.New()
	row, err := db.New(tx).CreateGateway(ctx, db.CreateGatewayParams{ID: id, Name: name, PublicHost: publicHost})
	if err != nil {
		return Gateway{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "streaming_gateway.created",
			ResourceType:   "streaming_gateway",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"name", "publicHost"},
		},
	); err != nil {
		return Gateway{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Gateway{}, err
	}
	return gatewayFrom(row), nil
}

func (s *Service) List(ctx context.Context, principal authorization.Principal) ([]Gateway, error) {
	if err := requireManage(principal); err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListGateways(ctx)
	if err != nil {
		return nil, err
	}
	expiries, err := db.New(s.pool).ListGatewayCredentialExpiries(ctx)
	if err != nil {
		return nil, err
	}
	expiryOf := make(map[uuid.UUID]time.Time, len(expiries))
	for _, expiry := range expiries {
		expiryOf[expiry.GatewayID] = expiry.ExpiresAt.UTC()
	}
	result := make([]Gateway, 0, len(rows))
	for _, row := range rows {
		gateway := gatewayFrom(row)
		if expires, ok := expiryOf[row.ID]; ok {
			gateway.CredentialExpiresAt = &expires
		}
		result = append(result, gateway)
	}
	return result, nil
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Gateway, error) {
	if err := requireManage(principal); err != nil {
		return Gateway{}, err
	}
	row, err := db.New(s.pool).GetGateway(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.NotFound
	}
	if err != nil {
		return Gateway{}, err
	}
	return withCredentialExpiry(ctx, db.New(s.pool), gatewayFrom(row))
}

// Update renames a gateway, changes its public host and enables or disables it.
func (s *Service) Update(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	name, publicHost string,
	enabled bool,
	expected int64,
	requestID *uuid.UUID,
) (Gateway, error) {
	if err := requireManage(principal); err != nil {
		return Gateway{}, err
	}
	name, err := normalizeName(name)
	if err != nil {
		return Gateway{}, err
	}
	if publicHost, err = NormalizePublicHost(publicHost); err != nil {
		return Gateway{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Gateway{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	current, err := q.GetGatewayForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.NotFound
	}
	if err != nil {
		return Gateway{}, err
	}
	if current.Lifecycle == "revoked" {
		return Gateway{}, apperror.Conflicting("streaming_gateway_revoked", "A revoked gateway cannot be updated")
	}
	lifecycle := current.Lifecycle
	var disabledAt *time.Time
	switch {
	case lifecycle == "pending":
		if !enabled {
			return Gateway{}, apperror.Invalid("A pending gateway cannot be disabled before enrollment")
		}
	case enabled:
		lifecycle = "active"
	default:
		lifecycle = "disabled"
		now := s.now()
		disabledAt = &now
	}
	row, err := q.UpdateGateway(
		ctx,
		db.UpdateGatewayParams{
			Name:            name,
			PublicHost:      publicHost,
			Lifecycle:       lifecycle,
			DisabledAt:      timestamptz(disabledAt),
			ID:              id,
			ExpectedVersion: expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.StaleWrite
	}
	if err != nil {
		return Gateway{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "streaming_gateway.updated",
			ResourceType:   "streaming_gateway",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"name", "publicHost", "lifecycle"},
		},
	); err != nil {
		return Gateway{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Gateway{}, err
	}
	return withCredentialExpiry(ctx, db.New(s.pool), gatewayFrom(row))
}

// Delete removes a gateway with its credentials, enrollments and camera assignments.
func (s *Service) Delete(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := requireManage(principal); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.GetGatewayForUpdate(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	affected, err := q.DeleteGateway(ctx, db.DeleteGatewayParams{ID: id, ExpectedVersion: expected})
	if err != nil {
		return databaseError(err)
	}
	if affected == 0 {
		return apperror.StaleWrite
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "streaming_gateway.deleted",
			ResourceType:   "streaming_gateway",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"gateway", "credentials", "cameras"},
		},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
