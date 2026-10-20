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

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	scimdb "github.com/Basmatireis/Makerspace-Core/backend/internal/scim/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) CreateUser(
	ctx context.Context,
	connector ConnectorContext,
	input UserInput,
	requestID *uuid.UUID,
) (User, error) {
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
	personID, accountID, userID := ids.New(), ids.New(), ids.New()
	if _, err := queries.CreateProvisionedPerson(
		ctx,
		scimdb.CreateProvisionedPersonParams{
			ID:        personID,
			FirstName: input.GivenName,
			LastName:  input.FamilyName,
			Email:     email,
			Phone:     phone,
		},
	); err != nil {
		return User{}, protocolDatabaseError(err)
	}
	status := "disabled"
	if input.Active {
		status = "enabled"
	}
	if _, err := queries.CreateProvisionedAccount(
		ctx,
		scimdb.CreateProvisionedAccountParams{ID: accountID, PersonID: personID, Status: status},
	); err != nil {
		return User{}, protocolDatabaseError(err)
	}
	if connector.OIDCProviderID != nil {
		if connector.Issuer == nil || input.ExternalID == nil {
			return User{}, &ProtocolError{
				Status:   400,
				SCIMType: "invalidValue",
				Detail:   "externalId is required for an OIDC-bound connector",
			}
		}
		if _, err := queries.CreateBoundOIDCIdentity(
			ctx,
			scimdb.CreateBoundOIDCIdentityParams{
				ID:         ids.New(),
				AccountID:  accountID,
				ProviderID: connector.OIDCProviderID,
				Issuer:     connector.Issuer,
				Subject:    input.ExternalID,
			},
		); err != nil {
			return User{}, protocolDatabaseError(err)
		}
		if !input.Active {
			ids, err := queries.DisableConnectorOIDCIdentity(
				ctx,
				scimdb.DisableConnectorOIDCIdentityParams{AccountID: accountID, ProviderID: connector.OIDCProviderID},
			)
			if err != nil {
				return User{}, err
			}
			if len(ids) == 0 {
				return User{}, apperror.Conflict
			}
		}
	}
	row, err := queries.CreateSCIMUser(
		ctx,
		scimdb.CreateSCIMUserParams{
			ID:               userID,
			ConnectorID:      connector.ID,
			PersonID:         personID,
			AccountID:        accountID,
			ExternalID:       input.ExternalID,
			UserName:         input.UserName,
			ProvisioningData: string(encoded),
		},
	)
	if err != nil {
		return User{}, protocolDatabaseError(err)
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			Action:        "scim.user_created",
			ResourceType:  "scim_user",
			ResourceID:    &userID,
			RequestID:     requestID,
			ChangedFields: []string{"person", "account", "provisioningData", "externalIdentity"},
		},
	); err != nil {
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

func (s *Service) ListUsers(
	ctx context.Context,
	connector ConnectorContext,
	filter string,
	startIndex, count int,
) (Page, error) {
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
	total, err := queries.CountSCIMUsers(
		ctx,
		scimdb.CountSCIMUsersParams{ConnectorID: connector.ID, FilterAttribute: attribute, FilterValue: value},
	)
	if err != nil {
		return Page{}, err
	}
	rows, err := queries.ListSCIMUsers(
		ctx,
		scimdb.ListSCIMUsersParams{
			ConnectorID:     connector.ID,
			FilterAttribute: attribute,
			FilterValue:     value,
			PageOffset:      int32(startIndex - 1),
			PageLimit:       int32(count),
		},
	)
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

func (s *Service) ReplaceUser(
	ctx context.Context,
	connector ConnectorContext,
	id uuid.UUID,
	input UserInput,
	requestID *uuid.UUID,
) (User, error) {
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
	if connector.OIDCProviderID != nil &&
		(current.ExternalID == nil || input.ExternalID == nil || *current.ExternalID != *input.ExternalID) {
		return User{}, &ProtocolError{
			Status:   409,
			SCIMType: "mutability",
			Detail:   "externalId is the immutable subject of the linked OIDC identity",
		}
	}
	if current.ProvisioningSource == "scim" && !current.FirstAuthenticatedAt.Valid {
		if err := queries.UpdateProvisionedPerson(
			ctx,
			scimdb.UpdateProvisionedPersonParams{
				FirstName: input.GivenName,
				LastName:  input.FamilyName,
				Email:     email,
				Phone:     phone,
				ID:        current.PersonID,
			},
		); err != nil {
			return User{}, err
		}
	}
	if err := s.applyActiveState(ctx, tx, connector, current.AccountID, input.Active); err != nil {
		return User{}, err
	}
	row, err := queries.UpdateSCIMMapping(
		ctx,
		scimdb.UpdateSCIMMappingParams{
			ExternalID:       input.ExternalID,
			UserName:         input.UserName,
			ProvisioningData: string(encoded),
			ConnectorID:      connector.ID,
			ID:               id,
		},
	)
	if err != nil {
		return User{}, protocolDatabaseError(err)
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			Action:        "scim.user_updated",
			ResourceType:  "scim_user",
			ResourceID:    &id,
			RequestID:     requestID,
			ChangedFields: []string{"provisioningData", "active", "externalIdentity"},
		},
	); err != nil {
		return User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, err
	}
	return User{ID: row.ID, Input: input, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func (s *Service) DeleteUser(
	ctx context.Context,
	connector ConnectorContext,
	id uuid.UUID,
	requestID *uuid.UUID,
) error {
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
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			Action:        "scim.user_deprovisioned",
			ResourceType:  "scim_user",
			ResourceID:    &id,
			RequestID:     requestID,
			ChangedFields: []string{"mapping", "externalIdentity", "sessions", "status"},
		},
	); err != nil {
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

func (s *Service) applyActiveState(
	ctx context.Context,
	tx pgx.Tx,
	connector ConnectorContext,
	accountID uuid.UUID,
	active bool,
) error {
	queries := scimdb.New(tx)
	if active {
		if connector.OIDCProviderID != nil {
			if err := queries.ReenableConnectorOIDCIdentity(
				ctx,
				scimdb.ReenableConnectorOIDCIdentityParams{AccountID: accountID, ProviderID: connector.OIDCProviderID},
			); err != nil {
				return err
			}
		}
		return queries.EnableSCIMAccountUnlessAdminDisabled(ctx, accountID)
	}
	if connector.OIDCProviderID != nil {
		ids, err := queries.DisableConnectorOIDCIdentity(
			ctx,
			scimdb.DisableConnectorOIDCIdentityParams{AccountID: accountID, ProviderID: connector.OIDCProviderID},
		)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if err := queries.RevokeSessionsForIdentity(ctx, id); err != nil {
				return err
			}
		}
	}
	independent, err := queries.CountIndependentUsableIdentities(
		ctx,
		scimdb.CountIndependentUsableIdentitiesParams{
			AccountID:          accountID,
			ExcludedProviderID: connector.OIDCProviderID,
		},
	)
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
		if err := queries.SetProvisionedAccountStatus(
			ctx,
			scimdb.SetProvisionedAccountStatusParams{Status: "disabled", ID: accountID},
		); err != nil {
			return err
		}
		return queries.RevokeSessionsForAccount(
			ctx,
			scimdb.RevokeSessionsForAccountParams{AccountID: accountID, Reason: stringPointer("scim_deprovisioned")},
		)
	}
	return nil
}

func normalizeUser(input UserInput, requireExternalID bool) (UserInput, *string, *string, error) {
	input.UserName = strings.TrimSpace(input.UserName)
	input.GivenName = strings.TrimSpace(input.GivenName)
	input.FamilyName = strings.TrimSpace(input.FamilyName)
	if input.ExternalID != nil {
		trimmed := strings.TrimSpace(*input.ExternalID)
		input.ExternalID = &trimmed
	}
	if input.UserName == "" || len(input.UserName) > 255 || input.GivenName == "" || len(input.GivenName) > 100 ||
		input.FamilyName == "" ||
		len(input.FamilyName) > 100 ||
		(requireExternalID && (input.ExternalID == nil || *input.ExternalID == "")) {
		return UserInput{}, nil, nil, &ProtocolError{
			Status:   400,
			SCIMType: "invalidValue",
			Detail:   "userName, name, and the connector-required externalId must be valid",
		}
	}
	emailValue := primaryValue(input.Emails)
	phoneValue := primaryValue(input.PhoneNumbers)
	var email, phone *string
	if emailValue != "" {
		parsed, err := mail.ParseAddress(emailValue)
		if err != nil || parsed.Address != emailValue {
			return UserInput{}, nil, nil, &ProtocolError{
				Status:   400,
				SCIMType: "invalidValue",
				Detail:   "The primary email is invalid",
			}
		}
		email = &emailValue
	}
	if phoneValue != "" {
		if len(phoneValue) > 64 {
			return UserInput{}, nil, nil, &ProtocolError{
				Status:   400,
				SCIMType: "invalidValue",
				Detail:   "The primary phone number is invalid",
			}
		}
		phone = &phoneValue
	}
	if email == nil && phone == nil {
		return UserInput{}, nil, nil, &ProtocolError{
			Status:   400,
			SCIMType: "invalidValue",
			Detail:   "A primary email or phone number is required",
		}
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
		return "", "", &ProtocolError{
			Status:   400,
			SCIMType: "invalidFilter",
			Detail:   "Only userName eq and externalId eq filters are supported",
		}
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
