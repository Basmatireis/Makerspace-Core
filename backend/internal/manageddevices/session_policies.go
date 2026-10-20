package manageddevices

import (
	"context"
	"errors"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	manageddevicesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func policyFromRow(row manageddevicesdb.SessionPolicy) SessionPolicy {
	return SessionPolicy{ID: row.ID, Name: row.Name, IdleTimeoutSeconds: row.IdleTimeoutSeconds,
		AbsoluteLifetimeSeconds: row.AbsoluteLifetimeSeconds, PostSessionDestination: Destination(row.PostSessionDestination),
		IsDefault: row.IsDefault, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func (s *Service) ListSessionPolicies(ctx context.Context, principal authorization.Principal) ([]SessionPolicy, error) {
	if !principal.Has(authorization.ManagedDevicesRead) && !principal.Has(authorization.SessionPoliciesManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := manageddevicesdb.New(s.pool).ListSessionPolicies(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]SessionPolicy, 0, len(rows))
	for _, row := range rows {
		result = append(result, policyFromRow(row))
	}
	return result, nil
}

func validateSessionPolicy(input SessionPolicyInput) (SessionPolicyInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 120 {
		return input, apperror.InvalidField("name is required and limited to 120 characters")
	}
	if input.IdleTimeoutSeconds < 60 || input.IdleTimeoutSeconds > 2592000 || input.AbsoluteLifetimeSeconds < 300 ||
		input.AbsoluteLifetimeSeconds > 7776000 ||
		input.IdleTimeoutSeconds > input.AbsoluteLifetimeSeconds {
		return input, apperror.InvalidField("session lifetimes are invalid")
	}
	if input.PostSessionDestination != DestinationLogin && input.PostSessionDestination != DestinationVisitorTerminal {
		return input, apperror.InvalidField("postSessionDestination is invalid")
	}
	return input, nil
}

func (s *Service) CreateSessionPolicy(
	ctx context.Context,
	principal authorization.Principal,
	input SessionPolicyInput,
	requestID *uuid.UUID,
) (SessionPolicy, error) {
	if !principal.Has(authorization.SessionPoliciesManage) {
		return SessionPolicy{}, apperror.PermissionDenied
	}
	input, err := validateSessionPolicy(input)
	if err != nil {
		return SessionPolicy{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SessionPolicy{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	id := ids.New()
	if input.IsDefault {
		previous, previousErr := q.GetDefaultSessionPolicy(ctx)
		if previousErr != nil && !errors.Is(previousErr, pgx.ErrNoRows) {
			return SessionPolicy{}, previousErr
		}
		if err = q.ClearDefaultSessionPolicy(ctx, id); err != nil {
			return SessionPolicy{}, err
		}
		if previousErr == nil {
			if err = q.RevokeSessionsForPolicy(ctx, &previous.ID); err != nil {
				return SessionPolicy{}, err
			}
		}
	}
	row, err := q.CreateSessionPolicy(ctx, manageddevicesdb.CreateSessionPolicyParams{ID: id, Name: input.Name,
		IdleTimeoutSeconds: input.IdleTimeoutSeconds, AbsoluteLifetimeSeconds: input.AbsoluteLifetimeSeconds,
		PostSessionDestination: string(input.PostSessionDestination), IsDefault: input.IsDefault})
	if err != nil {
		return SessionPolicy{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "session_policy.created",
			ResourceType:   "session_policy",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return SessionPolicy{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return SessionPolicy{}, err
	}
	return policyFromRow(row), nil
}

func (s *Service) UpdateSessionPolicy(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	input SessionPolicyInput,
	requestID *uuid.UUID,
) (SessionPolicy, error) {
	if !principal.Has(authorization.SessionPoliciesManage) {
		return SessionPolicy{}, apperror.PermissionDenied
	}
	input, err := validateSessionPolicy(input)
	if err != nil {
		return SessionPolicy{}, err
	}
	if input.ExpectedVersion < 1 {
		return SessionPolicy{}, apperror.InvalidField("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SessionPolicy{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	current, err := q.GetSessionPolicy(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionPolicy{}, apperror.NotFound
	}
	if err != nil {
		return SessionPolicy{}, err
	}
	if current.Version != input.ExpectedVersion {
		return SessionPolicy{}, apperror.StaleWrite
	}
	if current.IsDefault && !input.IsDefault {
		return SessionPolicy{}, apperror.InvalidField(
			"the default policy can only be replaced by making another policy the default",
		)
	}
	if input.IsDefault {
		previous, previousErr := q.GetDefaultSessionPolicy(ctx)
		if previousErr != nil && !errors.Is(previousErr, pgx.ErrNoRows) {
			return SessionPolicy{}, previousErr
		}
		if err = q.ClearDefaultSessionPolicy(ctx, id); err != nil {
			return SessionPolicy{}, err
		}
		if previousErr == nil && previous.ID != id {
			if err = q.RevokeSessionsForPolicy(ctx, &previous.ID); err != nil {
				return SessionPolicy{}, err
			}
		}
	}
	row, err := q.UpdateSessionPolicy(ctx, manageddevicesdb.UpdateSessionPolicyParams{ID: id, Name: input.Name,
		IdleTimeoutSeconds: input.IdleTimeoutSeconds, AbsoluteLifetimeSeconds: input.AbsoluteLifetimeSeconds,
		PostSessionDestination: string(input.PostSessionDestination),
		IsDefault:              input.IsDefault,
		ExpectedVersion:        input.ExpectedVersion})
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionPolicy{}, apperror.StaleWrite
	}
	if err != nil {
		return SessionPolicy{}, databaseError(err)
	}
	if err = q.RevokeSessionsForPolicy(ctx, &id); err != nil {
		return SessionPolicy{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "session_policy.updated",
			ResourceType:   "session_policy",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields: []string{
				"name",
				"idleTimeoutSeconds",
				"absoluteLifetimeSeconds",
				"postSessionDestination",
				"isDefault",
			},
		},
	); err != nil {
		return SessionPolicy{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return SessionPolicy{}, err
	}
	return policyFromRow(row), nil
}
