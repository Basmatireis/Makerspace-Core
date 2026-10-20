package printerconnectors

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
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) IssueEnrollment(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (EnrollmentIssue, error) {
	if !principal.Has(authorization.PrinterConnectorsCredentialsManage) {
		return EnrollmentIssue{}, apperror.PermissionDenied
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
	connector, err := q.GetConnectorForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentIssue{}, apperror.NotFound
	}
	if err != nil {
		return EnrollmentIssue{}, err
	}
	// Pending connectors are enrolled for the first time; active and disabled ones are re-enrolled
	// (new host, lost data volume). Their current credential stays valid until the secret is used.
	if connector.Lifecycle == "revoked" {
		return EnrollmentIssue{}, apperror.Conflicting(
			"printer_connector_revoked",
			"A revoked connector cannot be enrolled",
		)
	}
	if err = q.RevokeOpenEnrollments(ctx, id); err != nil {
		return EnrollmentIssue{}, err
	}
	expires := time.Now().UTC().Add(enrollmentTTL).Truncate(time.Microsecond)
	enrollmentID := ids.New()
	actor := principal.AccountID
	if _, err = q.CreateEnrollment(
		ctx,
		db.CreateEnrollmentParams{
			ID:                 enrollmentID,
			ConnectorID:        id,
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
			Action:         "printer_connector.enrollment_issued",
			ResourceType:   "printer_connector",
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
	return EnrollmentIssue{
		Connector: connectorFrom(connector),
		ID:        enrollmentID,
		Secret:    secret,
		ExpiresAt: expires,
	}, nil
}

func validOpaqueToken(raw string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	return err == nil && len(decoded) == 32
}

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
	if softwareVersion == "" || len(softwareVersion) > 80 || protocolVersion != 1 {
		return EnrollmentResult{}, apperror.Invalid("unsupported connector identity or protocol version")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EnrollmentResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	enrollment, err := q.GetEnrollmentByDigestForUpdate(ctx, security.DigestToken(enrollmentSecret))
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	if enrollment.RevokedAt.Valid || time.Now().UTC().After(enrollment.ExpiresAt) {
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
		row, getErr := q.GetConnector(ctx, enrollment.ConnectorID)
		if getErr != nil {
			return EnrollmentResult{}, getErr
		}
		credential, credentialErr := q.GetConnectorCredential(
			ctx,
			db.GetConnectorCredentialParams{ID: credentialID, ConnectorID: enrollment.ConnectorID},
		)
		if credentialErr != nil {
			return EnrollmentResult{}, credentialErr
		}
		if err = tx.Commit(ctx); err != nil {
			return EnrollmentResult{}, err
		}
		return EnrollmentResult{Connector: connectorFrom(row), CredentialExpiresAt: credential.ExpiresAt}, nil
	}
	current, err := q.GetConnectorForUpdate(ctx, enrollment.ConnectorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	if current.Lifecycle == "revoked" {
		return EnrollmentResult{}, apperror.Conflicting(
			"printer_connector_revoked",
			"Connector cannot be enrolled in its current state",
		)
	}
	reenroll := current.Lifecycle != "pending"
	if reenroll {
		if err = q.RevokeConnectorCredentials(ctx, enrollment.ConnectorID); err != nil {
			return EnrollmentResult{}, err
		}
	}
	expires := time.Now().UTC().Add(credentialTTL).Truncate(time.Microsecond)
	if _, err = q.CreateCredential(
		ctx,
		db.CreateCredentialParams{
			ID:          credentialID,
			ConnectorID: enrollment.ConnectorID,
			TokenDigest: security.DigestToken(credentialSecret),
			ExpiresAt:   expires,
		},
	); err != nil {
		return EnrollmentResult{}, databaseError(err)
	}
	if _, err = q.CompleteEnrollment(
		ctx,
		db.CompleteEnrollmentParams{
			CredentialFingerprint: &fingerprint,
			CredentialID:          &credentialID,
			ID:                    enrollment.ID,
		},
	); err != nil {
		return EnrollmentResult{}, err
	}
	action, changed := "printer_connector.enrolled", []string{"lifecycle", "credential"}
	var row db.PrinterConnector
	if reenroll {
		action, changed = "printer_connector.reenrolled", []string{"credential", "configuration"}
		row, err = q.ReenrollConnector(ctx, enrollment.ConnectorID)
	} else {
		row, err = q.ActivateConnector(ctx, enrollment.ConnectorID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, apperror.Conflicting(
			"printer_connector_revoked",
			"Connector cannot be enrolled in its current state",
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
			ResourceType:  "printer_connector",
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
	return EnrollmentResult{Connector: connectorFrom(row), CredentialExpiresAt: expires}, nil
}

func (s *Service) Authenticate(ctx context.Context, raw string) (*Context, error) {
	if !validOpaqueToken(raw) {
		return nil, nil
	}
	q := db.New(s.pool)
	row, err := q.AuthenticateConnector(ctx, security.DigestToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = q.TouchCredential(ctx, row.CredentialID)
	return &Context{ID: row.ID, CredentialID: row.CredentialID, Name: row.Name, Lifecycle: row.Lifecycle}, nil
}

func (s *Service) Revoke(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsCredentialsManage) {
		return Connector{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	row, err := q.RevokeConnector(ctx, db.RevokeConnectorParams{ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.StaleWrite
	}
	if err != nil {
		return Connector{}, err
	}
	if err = q.RevokeConnectorCredentials(ctx, id); err != nil {
		return Connector{}, err
	}
	if err = q.RevokeOpenEnrollments(ctx, id); err != nil {
		return Connector{}, err
	}
	if err = q.EndConnectorAssignments(ctx, id); err != nil {
		return Connector{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "printer_connector.revoked",
			ResourceType:   "printer_connector",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"lifecycle", "credentials", "assignments"},
		},
	); err != nil {
		return Connector{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return connectorFrom(row), nil
}

func (s *Service) RotateCredential(
	ctx context.Context,
	connector Context,
	credentialID uuid.UUID,
	credentialSecret string,
) (time.Time, error) {
	if connector.Lifecycle != "active" || credentialID == uuid.Nil || !validOpaqueToken(credentialSecret) {
		return time.Time{}, apperror.Invalid("valid connector credentials are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	existing, existingErr := q.GetConnectorCredential(
		ctx,
		db.GetConnectorCredentialParams{ID: credentialID, ConnectorID: connector.ID},
	)
	if existingErr == nil {
		if !bytes.Equal(existing.TokenDigest, security.DigestToken(credentialSecret)) || existing.State == "revoked" {
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
	if err = q.RevokeRetiringCredentials(ctx, connector.ID); err != nil {
		return time.Time{}, err
	}
	if err = q.BeginCredentialRotation(ctx, connector.ID); err != nil {
		return time.Time{}, err
	}
	expires := time.Now().UTC().Add(credentialTTL).Truncate(time.Microsecond)
	if _, err = q.CreateRotatedCredential(
		ctx,
		db.CreateRotatedCredentialParams{
			ID:          credentialID,
			ConnectorID: connector.ID,
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
			Action:        "printer_connector.credential_rotated",
			ResourceType:  "printer_connector",
			ResourceID:    &connector.ID,
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
