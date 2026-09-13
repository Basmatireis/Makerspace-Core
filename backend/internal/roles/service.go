package roles

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	rolesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/roles/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Role struct {
	ID            uuid.UUID
	Name          string
	Description   *string
	SystemKey     *string
	PermissionIDs []string
	Version       int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type Page struct {
	Items      []Role
	NextCursor *string
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) List(ctx context.Context, principal authorization.Principal, limit int, cursor string) (Page, error) {
	if !principal.Has(authorization.RolesRead) {
		return Page{}, apperror.PermissionDenied
	}
	if limit < 1 || limit > 100 {
		return Page{}, invalidRequest("limit must be between 1 and 100")
	}
	if len(cursor) > 500 {
		return Page{}, invalidRequest("cursor is invalid")
	}
	rows, err := rolesdb.New(s.pool).ListRoles(ctx)
	if err != nil {
		return Page{}, err
	}
	start := 0
	if cursor != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil {
			return Page{}, invalidRequest("cursor is invalid")
		}
		id, err := uuid.Parse(string(decoded))
		if err != nil {
			return Page{}, invalidRequest("cursor is invalid")
		}
		found := false
		for index, row := range rows {
			if row.ID == id {
				start, found = index+1, true
				break
			}
		}
		if !found {
			return Page{}, invalidRequest("cursor is invalid")
		}
	}
	end := start + limit
	if end > len(rows) {
		end = len(rows)
	}
	items := make([]Role, 0, end-start)
	queries := rolesdb.New(s.pool)
	for _, row := range rows[start:end] {
		role, err := fromRow(ctx, queries, row)
		if err != nil {
			return Page{}, err
		}
		items = append(items, role)
	}
	var next *string
	if end < len(rows) && end > start {
		encoded := base64.RawURLEncoding.EncodeToString([]byte(rows[end-1].ID.String()))
		next = &encoded
	}
	return Page{Items: items, NextCursor: next}, nil
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Role, error) {
	if !principal.Has(authorization.RolesRead) {
		return Role{}, apperror.PermissionDenied
	}
	queries := rolesdb.New(s.pool)
	row, err := queries.GetRole(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apperror.NotFound
	}
	if err != nil {
		return Role{}, err
	}
	return fromRow(ctx, queries, row)
}

func (s *Service) Create(ctx context.Context, principal authorization.Principal, name string, description *string, permissionIDs []string, requestID *uuid.UUID) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 100 || strings.EqualFold(name, "master") {
		return Role{}, validation("role name is invalid or reserved")
	}
	description = cleanOptional(description)
	if description != nil && len([]rune(*description)) > 500 {
		return Role{}, validation("description is too long")
	}
	permissions, err := validatePermissions(principal, permissionIDs)
	if err != nil {
		return Role{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Role{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := rolesdb.New(tx)
	id := uuid.Must(uuid.NewV7())
	row, err := queries.CreateRole(ctx, rolesdb.CreateRoleParams{ID: id, Name: name, Description: cleanOptional(description)})
	if err != nil {
		return Role{}, databaseError(err)
	}
	for _, permission := range permissions {
		if err := queries.AddRolePermission(ctx, rolesdb.AddRolePermissionParams{RoleID: id, PermissionID: permission}); err != nil {
			return Role{}, err
		}
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "role.created", ResourceType: "role", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "description", "permissionIds"}}); err != nil {
		return Role{}, err
	}
	result, err := fromRow(ctx, queries, row)
	if err != nil {
		return Role{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Role{}, err
	}
	return result, nil
}

func (s *Service) Update(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, name *string, descriptionSet bool, description *string, requestID *uuid.UUID) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 || (name == nil && !descriptionSet) {
		return Role{}, validation("at least one field and a positive expectedVersion are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Role{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := rolesdb.New(tx)
	current, err := queries.GetRoleForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apperror.NotFound
	}
	if err != nil {
		return Role{}, err
	}
	if current.SystemKey != nil {
		return Role{}, apperror.New(409, "system_role_protected", "The master role cannot be edited")
	}
	if err := ensureExistingSubset(ctx, queries, principal, current.ID); err != nil {
		return Role{}, err
	}
	newName, newDescription := current.Name, current.Description
	changed := make([]string, 0, 2)
	if name != nil {
		newName = strings.TrimSpace(*name)
		changed = append(changed, "name")
	}
	if descriptionSet {
		newDescription = cleanOptional(description)
		changed = append(changed, "description")
	}
	if newName == "" || len([]rune(newName)) > 100 || strings.EqualFold(newName, "master") {
		return Role{}, validation("role name is invalid or reserved")
	}
	if newDescription != nil && len([]rune(*newDescription)) > 500 {
		return Role{}, validation("description is too long")
	}
	row, err := queries.UpdateRole(ctx, rolesdb.UpdateRoleParams{ID: id, ExpectedVersion: expectedVersion, Name: newName, Description: newDescription})
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apperror.StaleWrite
	}
	if err != nil {
		return Role{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "role.updated", ResourceType: "role", ResourceID: &id, RequestID: requestID, ChangedFields: changed}); err != nil {
		return Role{}, err
	}
	result, err := fromRow(ctx, queries, row)
	if err != nil {
		return Role{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Role{}, err
	}
	return result, nil
}

func (s *Service) ReplacePermissions(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, permissionIDs []string, requestID *uuid.UUID) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Role{}, validation("expectedVersion must be positive")
	}
	permissions, err := validatePermissions(principal, permissionIDs)
	if err != nil {
		return Role{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Role{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := rolesdb.New(tx)
	current, err := queries.GetRoleForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apperror.NotFound
	}
	if err != nil {
		return Role{}, err
	}
	if current.SystemKey != nil {
		return Role{}, apperror.New(409, "system_role_protected", "The master role permissions cannot be edited")
	}
	if err := ensureExistingSubset(ctx, queries, principal, current.ID); err != nil {
		return Role{}, err
	}
	if current.Version != expectedVersion {
		return Role{}, apperror.StaleWrite
	}
	if err := queries.DeleteRolePermissions(ctx, id); err != nil {
		return Role{}, err
	}
	for _, permission := range permissions {
		if err := queries.AddRolePermission(ctx, rolesdb.AddRolePermissionParams{RoleID: id, PermissionID: permission}); err != nil {
			return Role{}, err
		}
	}
	row, err := queries.BumpRoleVersion(ctx, rolesdb.BumpRoleVersionParams{ID: id, ExpectedVersion: expectedVersion})
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apperror.StaleWrite
	}
	if err != nil {
		return Role{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "role.permissions_replaced", ResourceType: "role", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"permissionIds"}}); err != nil {
		return Role{}, err
	}
	result, err := fromRow(ctx, queries, row)
	if err != nil {
		return Role{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Role{}, err
	}
	return result, nil
}

func (s *Service) Delete(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) error {
	if !principal.Has(authorization.RolesManage) {
		return apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := rolesdb.New(tx)
	current, err := queries.GetRoleForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.SystemKey != nil {
		return apperror.New(409, "system_role_protected", "The master role cannot be deleted")
	}
	if err := ensureExistingSubset(ctx, queries, principal, current.ID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "role.deleted", ResourceType: "role", ResourceID: &id, RequestID: requestID}); err != nil {
		return err
	}
	if _, err := queries.DeleteRole(ctx, rolesdb.DeleteRoleParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	return tx.Commit(ctx)
}

func fromRow(ctx context.Context, queries *rolesdb.Queries, row rolesdb.Role) (Role, error) {
	permissions := make([]string, 0)
	if row.SystemKey != nil && *row.SystemKey == "master" {
		for _, permission := range authorization.Registry() {
			permissions = append(permissions, string(permission))
		}
	} else {
		var err error
		stored, err := queries.GetRolePermissions(ctx, row.ID)
		if err != nil {
			return Role{}, err
		}
		for _, value := range stored {
			permission := authorization.Permission(value)
			if !authorization.Known(permission) {
				slog.WarnContext(ctx, "ignored unknown stored permission", "role_id", row.ID, "permission_id", value)
				continue
			}
			permissions = append(permissions, value)
		}
	}
	return Role{ID: row.ID, Name: row.Name, Description: row.Description, SystemKey: row.SystemKey, PermissionIDs: permissions, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func ensureExistingSubset(ctx context.Context, queries *rolesdb.Queries, principal authorization.Principal, roleID uuid.UUID) error {
	permissions, err := queries.GetRolePermissions(ctx, roleID)
	if err != nil {
		return err
	}
	for _, value := range permissions {
		permission := authorization.Permission(value)
		if !authorization.Known(permission) {
			slog.WarnContext(ctx, "unknown stored permission blocked role management", "role_id", roleID, "permission_id", value)
			if !principal.Master {
				return apperror.PermissionDenied
			}
			continue
		}
		if !principal.Master && !principal.Has(permission) {
			return apperror.PermissionDenied
		}
	}
	return nil
}

func validatePermissions(principal authorization.Principal, values []string) ([]string, error) {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		permission := authorization.Permission(value)
		if !authorization.Known(permission) {
			return nil, validation("unknown permission: " + value)
		}
		if !principal.Master && !principal.Has(permission) {
			return nil, apperror.PermissionDenied
		}
		if _, duplicate := seen[value]; duplicate {
			return nil, validation("permissionIds must be unique")
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func cleanOptional(value *string) *string {
	if value == nil {
		return nil
	}
	clean := strings.TrimSpace(*value)
	if clean == "" {
		return nil
	}
	return &clean
}

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23503") {
		return apperror.Conflict
	}
	return err
}

func validation(reason string) *apperror.Error {
	err := apperror.New(422, "validation_failed", "Request validation failed")
	err.Details["reason"] = reason
	return err
}

func invalidRequest(reason string) *apperror.Error {
	err := apperror.New(400, "invalid_request", "Request is invalid")
	err.Details["reason"] = reason
	return err
}
