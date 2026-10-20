package streaminggateways

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateways/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// IssueEnrollment creates the one-time enrollment secret of a pending gateway.
func (s *Service) IssueEnrollment(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (EnrollmentIssue, error) {
	if err := requireManage(principal); err != nil {
		return EnrollmentIssue{}, err
	}
	secret, digest, err := security.NewOpaqueToken()
	if err != nil {
		return EnrollmentIssue{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EnrollmentIssue{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	gateway, err := q.GetGatewayForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentIssue{}, apperror.NotFound
	}
	if err != nil {
		return EnrollmentIssue{}, err
	}
	// Pending gateways are enrolled for the first time; active and disabled ones are re-enrolled
	// (new host, lost data volume). Their current credential stays valid until the secret is used.
	if Lifecycle(gateway.Lifecycle) == LifecycleRevoked {
		return EnrollmentIssue{}, apperror.Conflicting(
			"streaming_gateway_revoked",
			"A revoked gateway cannot be enrolled",
		)
	}
	if err = q.RevokeOpenGatewayEnrollments(ctx, id); err != nil {
		return EnrollmentIssue{}, err
	}
	expires := s.now().Add(enrollmentTTL).Truncate(time.Microsecond)
	enrollmentID := ids.New()
	actor := principal.AccountID
	if _, err = q.CreateGatewayEnrollment(
		ctx,
		db.CreateGatewayEnrollmentParams{
			ID:                 enrollmentID,
			GatewayID:          id,
			TokenDigest:        digest,
			ExpiresAt:          expires,
			CreatedByAccountID: &actor,
		},
	); err != nil {
		return EnrollmentIssue{}, err
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "streaming_gateway.enrollment_issued",
			ResourceType:   "streaming_gateway",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"enrollment"},
		},
	); err != nil {
		return EnrollmentIssue{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EnrollmentIssue{}, err
	}
	return EnrollmentIssue{Gateway: gatewayFrom(gateway), ID: enrollmentID, Secret: secret, ExpiresAt: expires}, nil
}

func validOpaqueToken(raw string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	return err == nil && len(decoded) == 32
}

// Enroll exchanges a gateway-generated credential for the one-time enrollment secret. Replaying the
// same exchange (same credential) is idempotent so a lost response can be retried.
func (s *Service) Enroll(
	ctx context.Context,
	enrollmentSecret string,
	credentialID uuid.UUID,
	credentialSecret, softwareVersion string,
	protocolVersion int,
) (EnrollmentResult, error) {
	if !validOpaqueToken(enrollmentSecret) || !validOpaqueToken(credentialSecret) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	softwareVersion = strings.TrimSpace(softwareVersion)
	if softwareVersion == "" || len(softwareVersion) > 80 || protocolVersion != ProtocolVersion ||
		credentialID == uuid.Nil {
		return EnrollmentResult{}, apperror.Invalid("unsupported gateway identity or protocol version")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EnrollmentResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	enrollment, err := q.GetGatewayEnrollmentByDigestForUpdate(ctx, security.DigestToken(enrollmentSecret))
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	if enrollment.RevokedAt.Valid || s.now().After(enrollment.ExpiresAt) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	fingerprintBytes := sha256.Sum256([]byte(credentialSecret))
	fingerprint := hex.EncodeToString(fingerprintBytes[:])
	if enrollment.ConsumedAt.Valid {
		if enrollment.CredentialFingerprint == nil || *enrollment.CredentialFingerprint != fingerprint ||
			enrollment.AcceptedCredentialID == nil ||
			*enrollment.AcceptedCredentialID != credentialID {
			return EnrollmentResult{}, apperror.Conflicting(
				"enrollment_replay_conflict",
				"Enrollment was already consumed with different credentials",
			)
		}
		row, getErr := q.GetGateway(ctx, enrollment.GatewayID)
		if getErr != nil {
			return EnrollmentResult{}, getErr
		}
		credential, credentialErr := q.GetGatewayCredential(
			ctx,
			db.GetGatewayCredentialParams{ID: credentialID, GatewayID: enrollment.GatewayID},
		)
		if credentialErr != nil {
			return EnrollmentResult{}, credentialErr
		}
		if err = tx.Commit(ctx); err != nil {
			return EnrollmentResult{}, err
		}
		gateway := gatewayFrom(row)
		gateway.CredentialExpiresAt = &credential.ExpiresAt
		return EnrollmentResult{Gateway: gateway, CredentialExpiresAt: credential.ExpiresAt}, nil
	}
	current, err := q.GetGatewayForUpdate(ctx, enrollment.GatewayID)
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	if Lifecycle(current.Lifecycle) == LifecycleRevoked {
		return EnrollmentResult{}, apperror.Conflicting(
			"streaming_gateway_revoked",
			"Gateway cannot be enrolled in its current state",
		)
	}
	reenroll := Lifecycle(current.Lifecycle) != LifecyclePending
	if reenroll {
		if err = q.RevokeGatewayCredentials(ctx, enrollment.GatewayID); err != nil {
			return EnrollmentResult{}, err
		}
	}
	expires := s.now().Add(credentialTTL).Truncate(time.Microsecond)
	if _, err = q.CreateGatewayCredential(
		ctx,
		db.CreateGatewayCredentialParams{
			ID:          credentialID,
			GatewayID:   enrollment.GatewayID,
			TokenDigest: security.DigestToken(credentialSecret),
			ExpiresAt:   expires,
		},
	); err != nil {
		return EnrollmentResult{}, databaseError(err)
	}
	if _, err = q.CompleteGatewayEnrollment(
		ctx,
		db.CompleteGatewayEnrollmentParams{
			CredentialFingerprint: &fingerprint,
			CredentialID:          &credentialID,
			ID:                    enrollment.ID,
		},
	); err != nil {
		return EnrollmentResult{}, err
	}
	action, changed := "streaming_gateway.enrolled", []string{"lifecycle", "credential"}
	var row db.StreamingGateway
	if reenroll {
		action, changed = "streaming_gateway.reenrolled", []string{"credential", "configuration"}
		row, err = q.ReenrollGateway(ctx, enrollment.GatewayID)
	} else {
		row, err = q.ActivateGateway(ctx, enrollment.GatewayID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, apperror.Conflicting(
			"streaming_gateway_revoked",
			"Gateway cannot be enrolled in its current state",
		)
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorType:     "system",
			Action:        action,
			ResourceType:  "streaming_gateway",
			ResourceID:    &row.ID,
			ChangedFields: changed,
			Source:        "http",
		},
	); err != nil {
		return EnrollmentResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EnrollmentResult{}, err
	}
	gateway := gatewayFrom(row)
	gateway.CredentialExpiresAt = &expires
	return EnrollmentResult{Gateway: gateway, CredentialExpiresAt: expires}, nil
}

// Authenticate resolves a runtime credential; it answers nil for anything unknown or revoked.
func (s *Service) Authenticate(ctx context.Context, raw string) (*Context, error) {
	if !validOpaqueToken(raw) {
		return nil, nil
	}
	q := db.New(s.pool)
	row, err := q.AuthenticateGateway(ctx, security.DigestToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = q.TouchGatewayCredential(ctx, row.CredentialID)
	return &Context{ID: row.ID, CredentialID: row.CredentialID, Name: row.Name, Lifecycle: Lifecycle(row.Lifecycle)}, nil
}

// Revoke ends the gateway's credentials and open enrollment immediately.
func (s *Service) Revoke(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
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
	current, err := q.GetGatewayForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.NotFound
	}
	if err != nil {
		return Gateway{}, err
	}
	if Lifecycle(current.Lifecycle) == LifecycleRevoked {
		return Gateway{}, apperror.Conflicting("streaming_gateway_revoked", "The gateway is already revoked")
	}
	row, err := q.RevokeGateway(ctx, db.RevokeGatewayParams{ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.StaleWrite
	}
	if err != nil {
		return Gateway{}, err
	}
	if err = q.RevokeGatewayCredentials(ctx, id); err != nil {
		return Gateway{}, err
	}
	if err = q.RevokeOpenGatewayEnrollments(ctx, id); err != nil {
		return Gateway{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "streaming_gateway.revoked",
			ResourceType:   "streaming_gateway",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"lifecycle", "credentials"},
		},
	); err != nil {
		return Gateway{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Gateway{}, err
	}
	return gatewayFrom(row), nil
}

// RotateCredential replaces the gateway's credential; the previous one stays valid for 24 hours.
func (s *Service) RotateCredential(
	ctx context.Context,
	gateway Context,
	credentialID uuid.UUID,
	credentialSecret string,
) (time.Time, error) {
	if gateway.Lifecycle != LifecycleActive || credentialID == uuid.Nil || !validOpaqueToken(credentialSecret) {
		return time.Time{}, apperror.Invalid("valid gateway credentials are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	existing, existingErr := q.GetGatewayCredential(
		ctx,
		db.GetGatewayCredentialParams{ID: credentialID, GatewayID: gateway.ID},
	)
	if existingErr == nil {
		if !bytes.Equal(existing.TokenDigest, security.DigestToken(credentialSecret)) || CredentialState(existing.State) == CredentialRevoked {
			return time.Time{}, apperror.Conflicting(
				"credential_rotation_conflict",
				"Credential identifier was reused with different credentials",
			)
		}
		if err = tx.Commit(ctx); err != nil {
			return time.Time{}, err
		}
		return existing.ExpiresAt, nil
	}
	if !errors.Is(existingErr, pgx.ErrNoRows) {
		return time.Time{}, existingErr
	}
	if err = q.RevokeRetiringGatewayCredentials(ctx, gateway.ID); err != nil {
		return time.Time{}, err
	}
	if err = q.BeginGatewayCredentialRotation(ctx, gateway.ID); err != nil {
		return time.Time{}, err
	}
	expires := s.now().Add(credentialTTL).Truncate(time.Microsecond)
	if _, err = q.CreateRotatedGatewayCredential(
		ctx,
		db.CreateRotatedGatewayCredentialParams{
			ID:          credentialID,
			GatewayID:   gateway.ID,
			TokenDigest: security.DigestToken(credentialSecret),
			ExpiresAt:   expires,
		},
	); err != nil {
		return time.Time{}, databaseError(err)
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorType:     "system",
			Action:        "streaming_gateway.credential_rotated",
			ResourceType:  "streaming_gateway",
			ResourceID:    &gateway.ID,
			ChangedFields: []string{"credential"},
			Source:        "http",
		},
	); err != nil {
		return time.Time{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return time.Time{}, err
	}
	return expires, nil
}
