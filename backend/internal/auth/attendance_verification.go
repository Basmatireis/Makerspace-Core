package auth

import (
	"context"
	"crypto/sha256"
	"errors"
	"time"

	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// VerifiedIdentity is deliberately short-lived in memory and never represents
// an application session. Attendance consumes it in the same request.
type VerifiedIdentity struct {
	AccountID uuid.UUID
	PersonID  uuid.UUID
	Method    string
	Assurance authorization.Assurance
}

func (s *Service) VerifyPasswordForAttendance(ctx context.Context, email, password, sourceKey string) (VerifiedIdentity, error) {
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	key := sha256.Sum256([]byte("attendance\x00" + sourceKey + "\x00" + normalized))
	if !s.limiter.Allow(string(key[:]), time.Now()) {
		return VerifiedIdentity{}, apperror.New(429, "login_rate_limited", "Too many attempts; try again later")
	}
	q := authdb.New(s.pool)
	row, err := q.GetLoginByEmail(ctx, normalized)
	hash := s.dummyHash
	if err == nil {
		hash = row.PasswordHash
	}
	valid := security.VerifyPassword(hash, password)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return VerifiedIdentity{}, err
	}
	if normalizeErr != nil || errors.Is(err, pgx.ErrNoRows) || !valid || row.Status != "enabled" || row.ResetRequired {
		return VerifiedIdentity{}, apperror.InvalidCredentials
	}
	s.limiter.Success(string(key[:]))
	return VerifiedIdentity{AccountID: row.AccountID, PersonID: row.PersonID, Method: "password", Assurance: authorization.AssuranceNormal}, nil
}

func (s *Service) VerifyPINForAttendance(ctx context.Context, loginName, pin, sourceKey string) (VerifiedIdentity, error) {
	_, normalized, normalizeErr := normalizeLoginName(loginName)
	loginDigest := s.pinThrottleDigest("attendance_login_name", normalized)
	sourceDigest := s.pinThrottleDigest("attendance_source", sourceKey)
	q := authdb.New(s.pool)
	blocked, err := q.PINThrottleBlocked(ctx, authdb.PINThrottleBlockedParams{Dimension: "login_name", KeyDigest: loginDigest})
	if err != nil {
		return VerifiedIdentity{}, err
	}
	sourceBlocked, err := q.PINThrottleBlocked(ctx, authdb.PINThrottleBlockedParams{Dimension: "source", KeyDigest: sourceDigest})
	if err != nil {
		return VerifiedIdentity{}, err
	}
	if blocked || sourceBlocked {
		return VerifiedIdentity{}, apperror.New(429, "login_rate_limited", "Too many attempts; try again later")
	}
	row, queryErr := q.FindPINLogin(ctx, normalized)
	hash := s.dummyPINHash
	if queryErr == nil {
		hash = row.PinHash
	}
	valid := security.VerifyPIN(s.config.PINPepper, hash, pin)
	if queryErr != nil && !errors.Is(queryErr, pgx.ErrNoRows) {
		return VerifiedIdentity{}, queryErr
	}
	if normalizeErr != nil || errors.Is(queryErr, pgx.ErrNoRows) || !valid || row.Status != "enabled" {
		_ = q.RecordPINFailure(ctx, authdb.RecordPINFailureParams{Dimension: "login_name", KeyDigest: loginDigest})
		_ = q.RecordPINFailure(ctx, authdb.RecordPINFailureParams{Dimension: "source", KeyDigest: sourceDigest})
		return VerifiedIdentity{}, apperror.InvalidCredentials
	}
	_ = q.ClearPINThrottle(ctx, authdb.ClearPINThrottleParams{Dimension: "login_name", KeyDigest: loginDigest})
	return VerifiedIdentity{AccountID: row.AccountID, PersonID: row.PersonID, Method: "pin", Assurance: authorization.AssuranceLow}, nil
}
