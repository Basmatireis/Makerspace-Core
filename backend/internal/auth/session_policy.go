package auth

import (
	"context"
	"time"

	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

type managedDeviceContextKey struct{}

// WithManagedDeviceContext binds authentication work to the already verified
// managed-device identity. The raw bearer credential never enters auth.
func WithManagedDeviceContext(ctx context.Context, deviceID *uuid.UUID) context.Context {
	return context.WithValue(ctx, managedDeviceContextKey{}, deviceID)
}

func managedDeviceFromContext(ctx context.Context) *uuid.UUID {
	value, _ := ctx.Value(managedDeviceContextKey{}).(*uuid.UUID)
	return value
}

type effectiveSessionPolicy struct {
	ID                     *uuid.UUID
	Version                int64
	IdleTimeout            time.Duration
	AbsoluteLifetime       time.Duration
	PostSessionDestination string
	ManagedDeviceID        *uuid.UUID
}

func (s *Service) effectiveSessionPolicy(ctx context.Context, queries *authdb.Queries) (effectiveSessionPolicy, error) {
	deviceID := managedDeviceFromContext(ctx)
	row, err := queries.GetEffectiveSessionPolicy(ctx, deviceID)
	if err != nil {
		return effectiveSessionPolicy{}, err
	}
	if row.IdleTimeoutSeconds < 60 || row.AbsoluteLifetimeSeconds < row.IdleTimeoutSeconds {
		return effectiveSessionPolicy{}, apperror.New(500, "session_policy_invalid", "Session policy is invalid")
	}
	id := row.ID
	return effectiveSessionPolicy{ID: &id, Version: row.Version,
		IdleTimeout:            time.Duration(row.IdleTimeoutSeconds) * time.Second,
		AbsoluteLifetime:       time.Duration(row.AbsoluteLifetimeSeconds) * time.Second,
		PostSessionDestination: row.PostSessionDestination, ManagedDeviceID: deviceID}, nil
}

func (s *Service) sessionDeadlines(ctx context.Context, queries *authdb.Queries, now time.Time) (effectiveSessionPolicy, time.Time, time.Time, error) {
	policy, err := s.effectiveSessionPolicy(ctx, queries)
	if err != nil {
		return policy, time.Time{}, time.Time{}, err
	}
	absolute := now.Add(policy.AbsoluteLifetime)
	idle := now.Add(policy.IdleTimeout)
	if idle.After(absolute) {
		idle = absolute
	}
	return policy, idle, absolute, nil
}
