package scim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	scimdb "github.com/Basmatireis/Makerspace-Core/backend/internal/scim/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User"

type Connector struct {
	ID                             uuid.UUID
	Name                           string
	OIDCProviderID                 *uuid.UUID
	Enabled                        bool
	TokenExpiresAt, TokenRevokedAt *time.Time
	Version                        int64
	CreatedAt, UpdatedAt           time.Time
}

type TokenIssue struct {
	Connector   Connector
	BearerToken string
}

type ConnectorContext struct {
	ID             uuid.UUID
	Name           string
	OIDCProviderID *uuid.UUID
	Issuer         *string
}

type MultiValue struct {
	Value   string `json:"value"`
	Type    string `json:"type,omitempty"`
	Primary bool   `json:"primary,omitempty"`
}

type UserInput struct {
	UserName     string       `json:"userName"`
	ExternalID   *string      `json:"externalId,omitempty"`
	Active       bool         `json:"active"`
	GivenName    string       `json:"givenName"`
	FamilyName   string       `json:"familyName"`
	Emails       []MultiValue `json:"emails,omitempty"`
	PhoneNumbers []MultiValue `json:"phoneNumbers,omitempty"`
}

type User struct {
	ID                   uuid.UUID
	Input                UserInput
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type Page struct {
	Items      []User
	Total      int64
	StartIndex int
}

type Conflict struct {
	Code       string
	ResourceID *uuid.UUID
	Message    string
}

type ReconciliationReport struct {
	CanReconcile                          bool
	ProvisionalAccountID, TargetAccountID uuid.UUID
	Conflicts                             []Conflict
	Completed                             bool
}

type ProtocolError struct {
	Status   int
	SCIMType string
	Detail   string
}

func (e *ProtocolError) Error() string { return e.Detail }

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

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
		result = append(result, connectorFrom(row.ID, row.Name, row.OidcProviderID, row.Enabled, row.TokenExpiresAt, row.TokenRevokedAt, row.Version, row.CreatedAt, row.UpdatedAt))
	}
	return result, nil
}

func (s *Service) CreateConnector(ctx context.Context, principal authorization.Principal, name string, providerID *uuid.UUID, enabled bool, expiresAt time.Time, requestID *uuid.UUID) (TokenIssue, error) {
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
	id := uuid.Must(uuid.NewV7())
	if _, err := queries.CreateConnector(ctx, scimdb.CreateConnectorParams{ID: id, Name: name, OidcProviderID: providerID, Enabled: enabled}); err != nil {
		return TokenIssue{}, databaseError(err)
	}
	actor := principal.AccountID
	if _, err := queries.CreateConnectorToken(ctx, scimdb.CreateConnectorTokenParams{ID: uuid.Must(uuid.NewV7()), ConnectorID: id, TokenDigest: digest, ExpiresAt: expiresAt.UTC(), CreatedByAccountID: &actor}); err != nil {
		return TokenIssue{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "scim.connector_created", ResourceType: "scim_connector", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "oidcProvider", "enabled", "token"}}); err != nil {
		return TokenIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TokenIssue{}, err
	}
	connector, err := s.getConnector(ctx, id)
	return TokenIssue{Connector: connector, BearerToken: raw}, err
}

func (s *Service) UpdateConnector(ctx context.Context, principal authorization.Principal, id uuid.UUID, name string, providerID *uuid.UUID, enabled bool, expectedVersion int64, requestID *uuid.UUID) (Connector, error) {
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
			return Connector{}, apperror.New(409, "scim_connector_in_use", "The OIDC binding cannot change while SCIM users exist")
		}
	}
	row, err := queries.UpdateConnector(ctx, scimdb.UpdateConnectorParams{Name: name, OidcProviderID: providerID, Enabled: enabled, ID: id, ExpectedVersion: expectedVersion})
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.StaleWrite
	}
	if err != nil {
		return Connector{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "scim.connector_updated", ResourceType: "scim_connector", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "oidcProvider", "enabled"}}); err != nil {
		return Connector{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return s.getConnector(ctx, row.ID)
}

func (s *Service) RotateToken(ctx context.Context, principal authorization.Principal, id uuid.UUID, expiresAt time.Time, expectedVersion int64, requestID *uuid.UUID) (TokenIssue, error) {
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
	if _, err := queries.BumpConnectorVersion(ctx, scimdb.BumpConnectorVersionParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return TokenIssue{}, apperror.StaleWrite
	} else if err != nil {
		return TokenIssue{}, err
	}
	if err := queries.RevokeActiveConnectorTokens(ctx, id); err != nil {
		return TokenIssue{}, err
	}
	actor := principal.AccountID
	if _, err := queries.CreateConnectorToken(ctx, scimdb.CreateConnectorTokenParams{ID: uuid.Must(uuid.NewV7()), ConnectorID: id, TokenDigest: digest, ExpiresAt: expiresAt.UTC(), CreatedByAccountID: &actor}); err != nil {
		return TokenIssue{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "scim.token_rotated", ResourceType: "scim_connector", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"token"}}); err != nil {
		return TokenIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TokenIssue{}, err
	}
	connector, err := s.getConnector(ctx, id)
	return TokenIssue{Connector: connector, BearerToken: raw}, err
}

func (s *Service) RevokeToken(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) (Connector, error) {
	if !principal.Has(authorization.SCIMManage) {
		return Connector{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := scimdb.New(tx)
	if _, err := queries.BumpConnectorVersion(ctx, scimdb.BumpConnectorVersionParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.StaleWrite
	} else if err != nil {
		return Connector{}, err
	}
	if err := queries.RevokeActiveConnectorTokens(ctx, id); err != nil {
		return Connector{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "scim.token_revoked", ResourceType: "scim_connector", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"token"}}); err != nil {
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

func (s *Service) CreateUser(ctx context.Context, connector ConnectorContext, input UserInput, requestID *uuid.UUID) (User, error) {
	input, email, phone, err := normalizeUser(input, connector.OIDCProviderID != nil)
	if err != nil {
		return User{}, err
	}
	encoded, _ := json.Marshal(input)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := scimdb.New(tx)
	personID, accountID, userID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err := queries.CreateProvisionedPerson(ctx, scimdb.CreateProvisionedPersonParams{ID: personID, FirstName: input.GivenName, LastName: input.FamilyName, Email: email, Phone: phone}); err != nil {
		return User{}, protocolDatabaseError(err)
	}
	status := "disabled"
	if input.Active {
		status = "enabled"
	}
	if _, err := queries.CreateProvisionedAccount(ctx, scimdb.CreateProvisionedAccountParams{ID: accountID, PersonID: personID, Status: status}); err != nil {
		return User{}, protocolDatabaseError(err)
	}
	if connector.OIDCProviderID != nil {
		if connector.Issuer == nil || input.ExternalID == nil {
			return User{}, &ProtocolError{Status: 400, SCIMType: "invalidValue", Detail: "externalId is required for an OIDC-bound connector"}
		}
		if _, err := queries.CreateBoundOIDCIdentity(ctx, scimdb.CreateBoundOIDCIdentityParams{ID: uuid.Must(uuid.NewV7()), AccountID: accountID, ProviderID: connector.OIDCProviderID, Issuer: connector.Issuer, Subject: input.ExternalID}); err != nil {
			return User{}, protocolDatabaseError(err)
		}
		if !input.Active {
			ids, err := queries.DisableConnectorOIDCIdentity(ctx, scimdb.DisableConnectorOIDCIdentityParams{AccountID: accountID, ProviderID: connector.OIDCProviderID})
			if err != nil {
				return User{}, err
			}
			if len(ids) == 0 {
				return User{}, apperror.Conflict
			}
		}
	}
	row, err := queries.CreateSCIMUser(ctx, scimdb.CreateSCIMUserParams{ID: userID, ConnectorID: connector.ID, PersonID: personID, AccountID: accountID, ExternalID: input.ExternalID, UserName: input.UserName, ProvisioningData: string(encoded)})
	if err != nil {
		return User{}, protocolDatabaseError(err)
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "scim.user_created", ResourceType: "scim_user", ResourceID: &userID, RequestID: requestID, ChangedFields: []string{"person", "account", "provisioningData", "externalIdentity"}}); err != nil {
		return User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, err
	}
	return User{ID: row.ID, Input: input, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func (s *Service) GetUser(ctx context.Context, connector ConnectorContext, id uuid.UUID) (User, error) {
	row, err := scimdb.New(s.pool).GetSCIMUser(ctx, scimdb.GetSCIMUserParams{ConnectorID: connector.ID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, &ProtocolError{Status: 404, Detail: "User not found"}
	}
	if err != nil {
		return User{}, err
	}
	return userFromJSON(row.ID, row.ProvisioningData, row.Version, row.CreatedAt, row.UpdatedAt)
}

func (s *Service) ListUsers(ctx context.Context, connector ConnectorContext, filter string, startIndex, count int) (Page, error) {
	attribute, value, err := parseFilter(filter)
	if err != nil {
		return Page{}, err
	}
	if startIndex < 1 {
		startIndex = 1
	}
	if count < 0 || count > 100 {
		return Page{}, &ProtocolError{Status: 400, SCIMType: "invalidValue", Detail: "count must be between 0 and 100"}
	}
	queries := scimdb.New(s.pool)
	total, err := queries.CountSCIMUsers(ctx, scimdb.CountSCIMUsersParams{ConnectorID: connector.ID, FilterAttribute: attribute, FilterValue: value})
	if err != nil {
		return Page{}, err
	}
	rows, err := queries.ListSCIMUsers(ctx, scimdb.ListSCIMUsersParams{ConnectorID: connector.ID, FilterAttribute: attribute, FilterValue: value, PageOffset: int32(startIndex - 1), PageLimit: int32(count)})
	if err != nil {
		return Page{}, err
	}
	items := make([]User, 0, len(rows))
	for _, row := range rows {
		user, err := userFromJSON(row.ID, row.ProvisioningData, row.Version, row.CreatedAt, row.UpdatedAt)
		if err != nil {
			return Page{}, err
		}
		items = append(items, user)
	}
	return Page{Items: items, Total: total, StartIndex: startIndex}, nil
}

func (s *Service) ReplaceUser(ctx context.Context, connector ConnectorContext, id uuid.UUID, input UserInput, requestID *uuid.UUID) (User, error) {
	input, email, phone, err := normalizeUser(input, connector.OIDCProviderID != nil)
	if err != nil {
		return User{}, err
	}
	encoded, _ := json.Marshal(input)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := scimdb.New(tx)
	current, err := lockProvisionedUser(ctx, tx, connector.ID, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, &ProtocolError{Status: 404, Detail: "User not found"}
	}
	if err != nil {
		return User{}, err
	}
	if current.ProvisioningSource == "scim" && !current.FirstAuthenticatedAt.Valid {
		if err := queries.UpdateProvisionedPerson(ctx, scimdb.UpdateProvisionedPersonParams{FirstName: input.GivenName, LastName: input.FamilyName, Email: email, Phone: phone, ID: current.PersonID}); err != nil {
			return User{}, err
		}
	}
	if connector.OIDCProviderID != nil {
		if err := queries.UpdateBoundOIDCSubject(ctx, scimdb.UpdateBoundOIDCSubjectParams{Subject: input.ExternalID, AccountID: current.AccountID, ProviderID: connector.OIDCProviderID}); err != nil {
			return User{}, protocolDatabaseError(err)
		}
	}
	if err := s.applyActiveState(ctx, tx, connector, current.AccountID, input.Active); err != nil {
		return User{}, err
	}
	row, err := queries.UpdateSCIMMapping(ctx, scimdb.UpdateSCIMMappingParams{ExternalID: input.ExternalID, UserName: input.UserName, ProvisioningData: string(encoded), ConnectorID: connector.ID, ID: id})
	if err != nil {
		return User{}, protocolDatabaseError(err)
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "scim.user_updated", ResourceType: "scim_user", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"provisioningData", "active", "externalIdentity"}}); err != nil {
		return User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, err
	}
	return User{ID: row.ID, Input: input, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func (s *Service) DeleteUser(ctx context.Context, connector ConnectorContext, id uuid.UUID, requestID *uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := scimdb.New(tx)
	current, err := lockProvisionedUser(ctx, tx, connector.ID, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return &ProtocolError{Status: 404, Detail: "User not found"}
	}
	if err != nil {
		return err
	}
	if err := s.applyActiveState(ctx, tx, connector, current.AccountID, false); err != nil {
		return err
	}
	if err := queries.DeleteSCIMUser(ctx, scimdb.DeleteSCIMUserParams{ConnectorID: connector.ID, ID: id}); err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "scim.user_deprovisioned", ResourceType: "scim_user", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"mapping", "externalIdentity", "sessions", "status"}}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func lockProvisionedUser(ctx context.Context, tx pgx.Tx, connectorID, id uuid.UUID) (scimdb.GetSCIMUserRow, error) {
	queries := scimdb.New(tx)
	input := scimdb.GetSCIMUserParams{ConnectorID: connectorID, ID: id}
	current, err := queries.GetSCIMUser(ctx, input)
	if err != nil {
		return current, err
	}
	// Match Person deletion's person -> master invariant -> account lock order.
	if err := queries.LockProvisionedPerson(ctx, current.PersonID); err != nil {
		return current, err
	}
	if err := accounts.LockProvisionedAccount(ctx, tx, current.AccountID); err != nil {
		return current, err
	}
	locked, err := queries.GetSCIMUser(ctx, input)
	if err != nil {
		return locked, err
	}
	if locked.AccountID != current.AccountID {
		return locked, &ProtocolError{Status: 409, Detail: "User was reconciled concurrently; retry the request"}
	}
	return locked, nil
}

func (s *Service) applyActiveState(ctx context.Context, tx pgx.Tx, connector ConnectorContext, accountID uuid.UUID, active bool) error {
	queries := scimdb.New(tx)
	if active {
		if connector.OIDCProviderID != nil {
			if err := queries.ReenableConnectorOIDCIdentity(ctx, scimdb.ReenableConnectorOIDCIdentityParams{AccountID: accountID, ProviderID: connector.OIDCProviderID}); err != nil {
				return err
			}
		}
		return queries.EnableSCIMAccountUnlessAdminDisabled(ctx, accountID)
	}
	if connector.OIDCProviderID != nil {
		ids, err := queries.DisableConnectorOIDCIdentity(ctx, scimdb.DisableConnectorOIDCIdentityParams{AccountID: accountID, ProviderID: connector.OIDCProviderID})
		if err != nil {
			return err
		}
		for _, id := range ids {
			if err := queries.RevokeSessionsForIdentity(ctx, id); err != nil {
				return err
			}
		}
	}
	independent, err := queries.CountIndependentUsableIdentities(ctx, scimdb.CountIndependentUsableIdentitiesParams{AccountID: accountID, ExcludedProviderID: connector.OIDCProviderID})
	if err != nil {
		return err
	}
	if independent == 0 {
		if err := accounts.ProtectProvisionedAccountDeactivation(ctx, tx, accountID); err != nil {
			if apperror.IsCode(err, "last_master_required") {
				return &ProtocolError{Status: 409, Detail: "At least one enabled master account must remain"}
			}
			return err
		}
		if err := queries.SetProvisionedAccountStatus(ctx, scimdb.SetProvisionedAccountStatusParams{Status: "disabled", ID: accountID}); err != nil {
			return err
		}
		return queries.RevokeSessionsForAccount(ctx, scimdb.RevokeSessionsForAccountParams{AccountID: accountID, Reason: stringPointer("scim_deprovisioned")})
	}
	return nil
}

func (s *Service) PreflightReconciliation(ctx context.Context, principal authorization.Principal, provisionalID, targetID uuid.UUID) (ReconciliationReport, error) {
	if !principal.Has(authorization.SCIMManage) {
		return ReconciliationReport{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReconciliationReport{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return analyzeReconciliation(ctx, tx, provisionalID, targetID)
}

func (s *Service) Reconcile(ctx context.Context, principal authorization.Principal, provisionalID, targetID uuid.UUID, requestID *uuid.UUID) (ReconciliationReport, error) {
	if !principal.Has(authorization.SCIMManage) {
		return ReconciliationReport{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReconciliationReport{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := scimdb.New(tx)
	report, err := analyzeReconciliation(ctx, tx, provisionalID, targetID)
	if err != nil || !report.CanReconcile {
		return report, err
	}
	source, err := queries.GetReconciliationAccount(ctx, provisionalID)
	if err != nil {
		return report, err
	}
	target, err := queries.GetReconciliationAccount(ctx, targetID)
	if err != nil {
		return report, err
	}
	if err := queries.DeduplicateOpenDayAssignments(ctx, scimdb.DeduplicateOpenDayAssignmentsParams{SourcePersonID: source.PersonID, TargetPersonID: target.PersonID}); err != nil {
		return report, err
	}
	if err := queries.MoveOpenDayAssignments(ctx, scimdb.MoveOpenDayAssignmentsParams{TargetPersonID: target.PersonID, SourcePersonID: source.PersonID}); err != nil {
		return report, err
	}
	if err := queries.DeduplicatePendingLabRuleRequests(ctx, scimdb.DeduplicatePendingLabRuleRequestsParams{SourcePersonID: source.PersonID, TargetPersonID: target.PersonID}); err != nil {
		return report, err
	}
	if err := queries.MoveLabRuleRequests(ctx, scimdb.MoveLabRuleRequestsParams{TargetPersonID: target.PersonID, SourcePersonID: source.PersonID}); err != nil {
		return report, err
	}
	if err := queries.TransferProfileImage(ctx, scimdb.TransferProfileImageParams{TargetPersonID: target.PersonID, SourcePersonID: source.PersonID}); err != nil {
		return report, err
	}
	if err := queries.TransferExternalIdentities(ctx, scimdb.TransferExternalIdentitiesParams{TargetAccountID: targetID, SourceAccountID: provisionalID}); err != nil {
		return report, err
	}
	if err := queries.TransferAccountRoles(ctx, scimdb.TransferAccountRolesParams{TargetAccountID: targetID, SourceAccountID: provisionalID}); err != nil {
		return report, err
	}
	if err := accounts.ProtectProvisionedAccountDeactivation(ctx, tx, provisionalID); err != nil {
		if apperror.IsCode(err, "last_master_required") {
			report.CanReconcile = false
			report.Conflicts = append(report.Conflicts, Conflict{Code: "last_master", Message: "Reconciliation must retain an enabled master Account."})
			return report, nil
		}
		return report, err
	}
	if err := queries.TransferSCIMMappings(ctx, scimdb.TransferSCIMMappingsParams{TargetAccountID: targetID, TargetPersonID: target.PersonID, SourceAccountID: provisionalID}); err != nil {
		return report, err
	}
	if err := queries.RevokeProvisionalSessions(ctx, provisionalID); err != nil {
		return report, err
	}
	if err := queries.DeleteReconciledAccount(ctx, provisionalID); err != nil {
		return report, err
	}
	if err := queries.DeleteReconciledPerson(ctx, source.PersonID); err != nil {
		return report, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "scim.account_reconciled", ResourceType: "account", ResourceID: &targetID, RequestID: requestID, ChangedFields: []string{"externalIdentities", "roles", "scimMapping", "domainRelations"}}); err != nil {
		return report, err
	}
	if err := tx.Commit(ctx); err != nil {
		return report, err
	}
	report.Completed = true
	return report, nil
}

func analyzeReconciliation(ctx context.Context, tx pgx.Tx, provisionalID, targetID uuid.UUID) (ReconciliationReport, error) {
	report := ReconciliationReport{ProvisionalAccountID: provisionalID, TargetAccountID: targetID, Conflicts: []Conflict{}}
	if provisionalID == targetID {
		return report, apperror.Validation
	}
	queries := scimdb.New(tx)
	// Match Person deletion's person -> master invariant -> account lock order.
	if err := queries.LockReconciliationPeople(ctx, scimdb.LockReconciliationPeopleParams{SourceAccountID: provisionalID, TargetAccountID: targetID}); err != nil {
		return report, err
	}
	for _, id := range []uuid.UUID{provisionalID, targetID} {
		if err := accounts.LockProvisionedAccount(ctx, tx, id); errors.Is(err, pgx.ErrNoRows) {
			return report, apperror.NotFound
		} else if err != nil {
			return report, err
		}
	}
	source, err := queries.GetReconciliationAccount(ctx, provisionalID)
	if errors.Is(err, pgx.ErrNoRows) {
		return report, apperror.NotFound
	}
	if err != nil {
		return report, err
	}
	target, err := queries.GetReconciliationAccount(ctx, targetID)
	if errors.Is(err, pgx.ErrNoRows) {
		return report, apperror.NotFound
	}
	if err != nil {
		return report, err
	}
	if source.ProvisioningSource != "scim" {
		report.Conflicts = append(report.Conflicts, Conflict{Code: "source_not_provisional", Message: "The source Account was not provisioned by SCIM."})
	}
	mappings, err := queries.CountSCIMMappingsForAccount(ctx, provisionalID)
	if err != nil {
		return report, err
	}
	if mappings == 0 {
		report.Conflicts = append(report.Conflicts, Conflict{Code: "source_mapping_missing", Message: "The source Account has no SCIM mapping."})
	}
	locals, err := queries.CountLocalIdentitiesForAccount(ctx, provisionalID)
	if err != nil {
		return report, err
	}
	if locals > 0 {
		report.Conflicts = append(report.Conflicts, Conflict{Code: "source_local_authentication", Message: "The provisional Account has local password or PIN methods that cannot be transferred safely."})
	}
	if source.ProfileImageFileID != nil && target.ProfileImageFileID != nil && *source.ProfileImageFileID != *target.ProfileImageFileID {
		report.Conflicts = append(report.Conflicts, Conflict{Code: "profile_image_conflict", ResourceID: source.ProfileImageFileID, Message: "Both People have different profile images."})
	}
	connectorConflicts, err := queries.ListSCIMMappingConnectorConflicts(ctx, scimdb.ListSCIMMappingConnectorConflictsParams{SourceAccountID: provisionalID, TargetAccountID: targetID})
	if err != nil {
		return report, err
	}
	for _, id := range connectorConflicts {
		id := id
		report.Conflicts = append(report.Conflicts, Conflict{Code: "connector_mapping_conflict", ResourceID: &id, Message: "Both Accounts have a mapping for the same SCIM connector."})
	}
	openDays, err := queries.ListOpenDayReconciliationConflicts(ctx, scimdb.ListOpenDayReconciliationConflictsParams{SourcePersonID: source.PersonID, TargetPersonID: target.PersonID})
	if err != nil {
		return report, err
	}
	for _, id := range openDays {
		id := id
		report.Conflicts = append(report.Conflicts, Conflict{Code: "open_day_assignment_conflict", ResourceID: &id, Message: "The People hold different positions on the same Open Day."})
	}
	labRules, err := queries.ListPendingLabRuleConflicts(ctx, scimdb.ListPendingLabRuleConflictsParams{SourcePersonID: source.PersonID, TargetPersonID: target.PersonID})
	if err != nil {
		return report, err
	}
	for _, id := range labRules {
		id := id
		report.Conflicts = append(report.Conflicts, Conflict{Code: "lab_rules_request_conflict", ResourceID: &id, Message: "The People have pending requests for different Lab Rules versions."})
	}
	report.CanReconcile = len(report.Conflicts) == 0
	return report, nil
}

func normalizeUser(input UserInput, requireExternalID bool) (UserInput, *string, *string, error) {
	input.UserName = strings.TrimSpace(input.UserName)
	input.GivenName = strings.TrimSpace(input.GivenName)
	input.FamilyName = strings.TrimSpace(input.FamilyName)
	if input.ExternalID != nil {
		trimmed := strings.TrimSpace(*input.ExternalID)
		input.ExternalID = &trimmed
	}
	if input.UserName == "" || len(input.UserName) > 255 || input.GivenName == "" || len(input.GivenName) > 100 || input.FamilyName == "" || len(input.FamilyName) > 100 || (requireExternalID && (input.ExternalID == nil || *input.ExternalID == "")) {
		return UserInput{}, nil, nil, &ProtocolError{Status: 400, SCIMType: "invalidValue", Detail: "userName, name, and the connector-required externalId must be valid"}
	}
	emailValue := primaryValue(input.Emails)
	phoneValue := primaryValue(input.PhoneNumbers)
	var email, phone *string
	if emailValue != "" {
		parsed, err := mail.ParseAddress(emailValue)
		if err != nil || parsed.Address != emailValue {
			return UserInput{}, nil, nil, &ProtocolError{Status: 400, SCIMType: "invalidValue", Detail: "The primary email is invalid"}
		}
		email = &emailValue
	}
	if phoneValue != "" {
		if len(phoneValue) > 64 {
			return UserInput{}, nil, nil, &ProtocolError{Status: 400, SCIMType: "invalidValue", Detail: "The primary phone number is invalid"}
		}
		phone = &phoneValue
	}
	if email == nil && phone == nil {
		return UserInput{}, nil, nil, &ProtocolError{Status: 400, SCIMType: "invalidValue", Detail: "A primary email or phone number is required"}
	}
	return input, email, phone, nil
}

func primaryValue(values []MultiValue) string {
	for _, value := range values {
		if value.Primary && strings.TrimSpace(value.Value) != "" {
			return strings.TrimSpace(value.Value)
		}
	}
	for _, value := range values {
		if strings.TrimSpace(value.Value) != "" {
			return strings.TrimSpace(value.Value)
		}
	}
	return ""
}

var filterPattern = regexp.MustCompile(`(?i)^\s*(userName|externalId)\s+eq\s+"([^"]*)"\s*$`)

func parseFilter(filter string) (string, string, error) {
	if strings.TrimSpace(filter) == "" {
		return "", "", nil
	}
	matches := filterPattern.FindStringSubmatch(filter)
	if len(matches) != 3 {
		return "", "", &ProtocolError{Status: 400, SCIMType: "invalidFilter", Detail: "Only userName eq and externalId eq filters are supported"}
	}
	attribute := matches[1]
	if strings.EqualFold(attribute, "username") {
		attribute = "userName"
	} else {
		attribute = "externalId"
	}
	return attribute, matches[2], nil
}

func userFromJSON(id uuid.UUID, data []byte, version int64, createdAt, updatedAt time.Time) (User, error) {
	var input UserInput
	if err := json.Unmarshal(data, &input); err != nil {
		return User{}, fmt.Errorf("decode SCIM provisioning metadata: %w", err)
	}
	return User{ID: id, Input: input, Version: version, CreatedAt: createdAt, UpdatedAt: updatedAt}, nil
}

func (s *Service) getConnector(ctx context.Context, id uuid.UUID) (Connector, error) {
	row, err := scimdb.New(s.pool).GetConnector(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.NotFound
	}
	if err != nil {
		return Connector{}, err
	}
	return connectorFrom(row.ID, row.Name, row.OidcProviderID, row.Enabled, row.TokenExpiresAt, row.TokenRevokedAt, row.Version, row.CreatedAt, row.UpdatedAt), nil
}

func connectorFrom(id uuid.UUID, name string, providerID *uuid.UUID, enabled bool, tokenExpires time.Time, tokenRevoked pgtype.Timestamptz, version int64, createdAt, updatedAt time.Time) Connector {
	var expires, revoked *time.Time
	if !tokenExpires.Equal(time.Unix(0, 0).UTC()) {
		value := tokenExpires.UTC()
		expires = &value
	}
	if tokenRevoked.Valid {
		value := tokenRevoked.Time.UTC()
		revoked = &value
	}
	return Connector{ID: id, Name: name, OIDCProviderID: providerID, Enabled: enabled, TokenExpiresAt: expires, TokenRevokedAt: revoked, Version: version, CreatedAt: createdAt, UpdatedAt: updatedAt}
}

func databaseError(err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" {
		return apperror.Conflict
	}
	if errors.As(err, &postgresError) && postgresError.Code == "23503" {
		return apperror.Validation
	}
	return err
}

func protocolDatabaseError(err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" {
		return &ProtocolError{Status: 409, SCIMType: "uniqueness", Detail: "A connector-scoped identifier or external identity is already in use"}
	}
	if errors.As(err, &postgresError) && (postgresError.Code == "23503" || postgresError.Code == "23514") {
		return &ProtocolError{Status: 400, SCIMType: "invalidValue", Detail: "The supplied User data is invalid"}
	}
	return err
}

func sameUUID(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func stringPointer(value string) *string { return &value }

func UserSchema() string { return userSchema }
