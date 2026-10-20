package scim

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	scimdb "github.com/Basmatireis/Makerspace-Core/backend/internal/scim/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func (s *Service) ListConnectors(ctx context.Context, principal authorization.Principal) ([]Connector, error) {
	if !principal.Has(authorization.SCIMManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := scimdb.New(s.pool).ListConnectors(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Connector, 0, len(rows))
	for _, row := range rows {
		result = append(
			result,
			connectorFrom(
				row.ID,
				row.Name,
				row.OidcProviderID,
				row.Enabled,
				row.TokenExpiresAt,
				row.TokenRevokedAt,
				row.Version,
				row.CreatedAt,
				row.UpdatedAt,
			),
		)
	}
	return result, nil
}

func (s *Service) CreateConnector(
	ctx context.Context,
	principal authorization.Principal,
	name string,
	providerID *uuid.UUID,
	enabled bool,
	expiresAt time.Time,
	requestID *uuid.UUID,
) (TokenIssue, error) {
	if !principal.Has(authorization.SCIMManage) {
		return TokenIssue{}, apperror.PermissionDenied
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 100 || !expiresAt.After(time.Now().UTC()) {
		return TokenIssue{}, apperror.Validation
	}
	raw, digest, err := security.NewOpaqueToken()
	if err != nil {
		return TokenIssue{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TokenIssue{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := scimdb.New(tx)
	id := ids.New()
	if _, err := queries.CreateConnector(
		ctx,
		scimdb.CreateConnectorParams{ID: id, Name: name, OidcProviderID: providerID, Enabled: enabled},
	); err != nil {
		return TokenIssue{}, databaseError(err)
	}
	actor := principal.AccountID
	if _, err := queries.CreateConnectorToken(
		ctx,
		scimdb.CreateConnectorTokenParams{
			ID:                 ids.New(),
			ConnectorID:        id,
			TokenDigest:        digest,
			ExpiresAt:          expiresAt.UTC(),
			CreatedByAccountID: &actor,
		},
	); err != nil {
		return TokenIssue{}, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "scim.connector_created",
			ResourceType:   "scim_connector",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"name", "oidcProvider", "enabled", "token"},
		},
	); err != nil {
		return TokenIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TokenIssue{}, err
	}
	connector, err := s.getConnector(ctx, id)
	return TokenIssue{Connector: connector, BearerToken: raw}, err
}

func (s *Service) UpdateConnector(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	name string,
	providerID *uuid.UUID,
	enabled bool,
	expectedVersion int64,
	requestID *uuid.UUID,
) (Connector, error) {
	if !principal.Has(authorization.SCIMManage) {
		return Connector{}, apperror.PermissionDenied
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 100 || expectedVersion < 1 {
		return Connector{}, apperror.Validation
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := scimdb.New(tx)
	current, err := queries.GetConnector(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.NotFound
	}
	if err != nil {
		return Connector{}, err
	}
	if current.Version != expectedVersion {
		return Connector{}, apperror.StaleWrite
	}
	if !sameUUID(current.OidcProviderID, providerID) {
		count, err := queries.CountConnectorUsers(ctx, id)
		if err != nil {
			return Connector{}, err
		}
		if count > 0 {
			return Connector{}, apperror.New(
				409,
				"scim_connector_in_use",
				"The OIDC binding cannot change while SCIM users exist",
			)
		}
	}
	row, err := queries.UpdateConnector(
		ctx,
		scimdb.UpdateConnectorParams{
			Name:            name,
			OidcProviderID:  providerID,
			Enabled:         enabled,
			ID:              id,
			ExpectedVersion: expectedVersion,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.StaleWrite
	}
	if err != nil {
		return Connector{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "scim.connector_updated",
			ResourceType:   "scim_connector",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"name", "oidcProvider", "enabled"},
		},
	); err != nil {
		return Connector{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return s.getConnector(ctx, row.ID)
}

func (s *Service) RotateToken(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expiresAt time.Time,
	expectedVersion int64,
	requestID *uuid.UUID,
) (TokenIssue, error) {
	if !principal.Has(authorization.SCIMManage) {
		return TokenIssue{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 || !expiresAt.After(time.Now().UTC()) {
		return TokenIssue{}, apperror.Validation
	}
	raw, digest, err := security.NewOpaqueToken()
	if err != nil {
		return TokenIssue{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TokenIssue{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := scimdb.New(tx)
	if _, err := queries.BumpConnectorVersion(
		ctx,
		scimdb.BumpConnectorVersionParams{ID: id, ExpectedVersion: expectedVersion},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return TokenIssue{}, apperror.StaleWrite
	} else if err != nil {
		return TokenIssue{}, err
	}
	if err := queries.RevokeActiveConnectorTokens(ctx, id); err != nil {
		return TokenIssue{}, err
	}
	actor := principal.AccountID
	if _, err := queries.CreateConnectorToken(
		ctx,
		scimdb.CreateConnectorTokenParams{
			ID:                 ids.New(),
			ConnectorID:        id,
			TokenDigest:        digest,
			ExpiresAt:          expiresAt.UTC(),
			CreatedByAccountID: &actor,
		},
	); err != nil {
		return TokenIssue{}, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "scim.token_rotated",
			ResourceType:   "scim_connector",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"token"},
		},
	); err != nil {
		return TokenIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TokenIssue{}, err
	}
	connector, err := s.getConnector(ctx, id)
	return TokenIssue{Connector: connector, BearerToken: raw}, err
}

func (s *Service) RevokeToken(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) (Connector, error) {
	if !principal.Has(authorization.SCIMManage) {
		return Connector{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := scimdb.New(tx)
	if _, err := queries.BumpConnectorVersion(
		ctx,
		scimdb.BumpConnectorVersionParams{ID: id, ExpectedVersion: expectedVersion},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return Connector{}, apperror.StaleWrite
	} else if err != nil {
		return Connector{}, err
	}
	if err := queries.RevokeActiveConnectorTokens(ctx, id); err != nil {
		return Connector{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "scim.token_revoked",
			ResourceType:   "scim_connector",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"token"},
		},
	); err != nil {
		return Connector{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return s.getConnector(ctx, id)
}

func (s *Service) Authenticate(ctx context.Context, raw string) (ConnectorContext, error) {
	if raw == "" {
		return ConnectorContext{}, &ProtocolError{Status: 401, Detail: "A valid SCIM bearer token is required"}
	}
	queries := scimdb.New(s.pool)
	row, err := queries.AuthenticateConnector(ctx, security.DigestToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return ConnectorContext{}, &ProtocolError{Status: 401, Detail: "A valid SCIM bearer token is required"}
	}
	if err != nil {
		return ConnectorContext{}, err
	}
	_ = queries.TouchConnectorToken(ctx, security.DigestToken(raw))
	return ConnectorContext{ID: row.ID, Name: row.Name, OIDCProviderID: row.OidcProviderID, Issuer: row.Issuer}, nil
}

func (s *Service) getConnector(ctx context.Context, id uuid.UUID) (Connector, error) {
	row, err := scimdb.New(s.pool).GetConnector(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.NotFound
	}
	if err != nil {
		return Connector{}, err
	}
	return connectorFrom(
		row.ID,
		row.Name,
		row.OidcProviderID,
		row.Enabled,
		row.TokenExpiresAt,
		row.TokenRevokedAt,
		row.Version,
		row.CreatedAt,
		row.UpdatedAt,
	), nil
}

func connectorFrom(
	id uuid.UUID,
	name string,
	providerID *uuid.UUID,
	enabled bool,
	tokenExpires time.Time,
	tokenRevoked pgtype.Timestamptz,
	version int64,
	createdAt, updatedAt time.Time,
) Connector {
	var expires, revoked *time.Time
	if !tokenExpires.Equal(time.Unix(0, 0).UTC()) {
		value := tokenExpires.UTC()
		expires = &value
	}
	if tokenRevoked.Valid {
		value := tokenRevoked.Time.UTC()
		revoked = &value
	}
	return Connector{
		ID:             id,
		Name:           name,
		OIDCProviderID: providerID,
		Enabled:        enabled,
		TokenExpiresAt: expires,
		TokenRevokedAt: revoked,
		Version:        version,
		CreatedAt:      createdAt,
		UpdatedAt:      updatedAt,
	}
}
