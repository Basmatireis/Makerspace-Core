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
	ID                   uuid.UUID
	Name                 string
	Description          *string
	SystemKey            *string
	PermissionGrants     []authorization.PermissionGrant
	ProfileImageRequired bool
	LaborordnungMode     string
	SupervisorDashboard  bool
	Version              int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type Page struct {
	Items      []Role
	NextCursor *string
}

type EffectivePermissionEvaluation struct {
	RoleID        uuid.UUID
	RoleVersion   int64
	PermissionIDs []authorization.Permission
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Create(ctx context.Context, principal authorization.Principal, name string, description *string, grants []authorization.PermissionGrant, requestID *uuid.UUID) (Role, error) {
	return s.CreateWithBehaviors(ctx, principal, name, description, grants, false, "not_required", false, requestID)
}

func (s *Service) CreateWithBehaviors(ctx context.Context, principal authorization.Principal, name string, description *string, grants []authorization.PermissionGrant, profileImageRequired bool, laborordnungMode string, supervisorDashboard bool, requestID *uuid.UUID) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	name = strings.TrimSpace(name)
	description = cleanOptional(description)
	if name == "" || len([]rune(name)) > 100 || strings.EqualFold(name, "master") {
		return Role{}, validation("role name is invalid or reserved")
	}
	if description != nil && len([]rune(*description)) > 500 {
		return Role{}, validation("description is too long")
	}
	if laborordnungMode != "not_required" && laborordnungMode != "warning" && laborordnungMode != "blocking" {
		return Role{}, validation("Lab Rules mode is invalid")
	}
	grants, err := validateGrants(principal, grants)
	if err != nil {
		return Role{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Role{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := rolesdb.New(tx)
	id := uuid.Must(uuid.NewV7())
	row, err := q.CreateRole(ctx, rolesdb.CreateRoleParams{ID: id, Name: name, Description: description, ProfileImageRequired: profileImageRequired, LaborordnungMode: laborordnungMode, SupervisorDashboard: supervisorDashboard})
	if err != nil {
		return Role{}, databaseError(err)
	}
	if err = insertGrants(ctx, q, id, grants); err != nil {
		return Role{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "role.created", ResourceType: "role", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "description", "permissionGrants", "profileImageRequired"}}); err != nil {
		return Role{}, err
	}
	result, err := fromRow(ctx, q, row)
	if err != nil {
		return Role{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Role{}, err
	}
	return result, nil
}

func (s *Service) ReplacePermissions(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, grants []authorization.PermissionGrant, requestID *uuid.UUID) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Role{}, validation("expectedVersion must be positive")
	}
	grants, err := validateGrants(principal, grants)
	if err != nil {
		return Role{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Role{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := rolesdb.New(tx)
	current, err := q.GetRoleForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apperror.NotFound
	}
	if err != nil {
		return Role{}, err
	}
	if current.SystemKey != nil {
		return Role{}, apperror.New(409, "system_role_protected", "The master role permissions cannot be edited")
	}
	if err = ensureExistingSubset(ctx, q, principal, id); err != nil {
		return Role{}, err
	}
	if current.Version != expectedVersion {
		return Role{}, apperror.StaleWrite
	}
	if err = q.DeleteRolePermissions(ctx, id); err != nil {
		return Role{}, err
	}
	if err = insertGrants(ctx, q, id, grants); err != nil {
		return Role{}, err
	}
	row, err := q.BumpRoleVersion(ctx, rolesdb.BumpRoleVersionParams{ID: id, ExpectedVersion: expectedVersion})
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apperror.StaleWrite
	}
	if err != nil {
		return Role{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "role.permissions_replaced", ResourceType: "role", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"permissionGrants"}}); err != nil {
		return Role{}, err
	}
	result, err := fromRow(ctx, q, row)
	if err != nil {
		return Role{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Role{}, err
	}
	return result, nil
}

func insertGrants(ctx context.Context, q *rolesdb.Queries, roleID uuid.UUID, grants []authorization.PermissionGrant) error {
	for _, g := range grants {
		grantID := uuid.Must(uuid.NewV7())
		if err := q.AddRolePermission(ctx, rolesdb.AddRolePermissionParams{ID: grantID, RoleID: roleID, PermissionID: string(g.PermissionID), Scope: string(g.Scope), MinimumAssurance: string(g.MinimumAssurance)}); err != nil {
			return err
		}
		for _, typeID := range g.DeviceTypeIDs {
			if err := q.AddRolePermissionDeviceType(ctx, rolesdb.AddRolePermissionDeviceTypeParams{GrantID: grantID, DeviceTypeID: typeID}); err != nil {
				return databaseError(err)
			}
		}
	}
	return nil
}
func validateGrants(principal authorization.Principal, grants []authorization.PermissionGrant) ([]authorization.PermissionGrant, error) {
	seen := map[string]struct{}{}
	result := append([]authorization.PermissionGrant(nil), grants...)
	for i, g := range result {
		if !authorization.Known(g.PermissionID) {
			return nil, validation("unknown permission: " + string(g.PermissionID))
		}
		if g.MinimumAssurance == "" {
			g.MinimumAssurance = authorization.AssuranceLow
		}
		key := string(g.PermissionID) + "\x00" + string(g.Scope) + "\x00" + string(g.MinimumAssurance)
		if _, ok := seen[key]; ok {
			return nil, validation("duplicate permission grant")
		}
		seen[key] = struct{}{}
		types := map[uuid.UUID]struct{}{}
		for _, id := range g.DeviceTypeIDs {
			if _, ok := types[id]; ok {
				return nil, validation("deviceTypeIds must be unique")
			}
			types[id] = struct{}{}
		}
		if g.Scope == authorization.GrantSelectedDeviceTypes && len(g.DeviceTypeIDs) == 0 {
			return nil, validation("selected device types cannot be empty")
		}
		if g.Scope != authorization.GrantSelectedDeviceTypes && len(g.DeviceTypeIDs) != 0 {
			return nil, validation("deviceTypeIds are only valid for selected device types")
		}
		if g.Scope != authorization.GrantEverywhere && g.Scope != authorization.GrantAnyManagedDevice && g.Scope != authorization.GrantSelectedDeviceTypes {
			return nil, validation("permission scope is invalid")
		}
		sort.Slice(g.DeviceTypeIDs, func(a, b int) bool { return g.DeviceTypeIDs[a].String() < g.DeviceTypeIDs[b].String() })
		result[i] = g
		if !principal.CanDelegate(g) {
			return nil, apperror.PermissionDenied
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].PermissionID < result[j].PermissionID })
	return result, nil
}

func (s *Service) List(ctx context.Context, principal authorization.Principal, limit int, cursor string) (Page, error) {
	if !principal.Has(authorization.RolesRead) && !principal.Has(authorization.VisitorEnrollmentManage) {
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

func (s *Service) EvaluatePermissions(ctx context.Context, principal authorization.Principal, evaluation authorization.EvaluationContext) ([]EffectivePermissionEvaluation, error) {
	if !principal.Has(authorization.RolesRead) {
		return nil, apperror.PermissionDenied
	}
	if !authorization.ValidAssurance(evaluation.Assurance) {
		return nil, invalidRequest("authenticationAssurance is invalid")
	}
	queries := rolesdb.New(s.pool)
	rows, err := queries.ListRoles(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]EffectivePermissionEvaluation, 0, len(rows))
	for _, row := range rows {
		role, err := fromRow(ctx, queries, row)
		if err != nil {
			return nil, err
		}
		permissions := authorization.EffectivePermissions(role.PermissionGrants, evaluation)
		if role.SystemKey != nil && *role.SystemKey == "master" {
			permissions = authorization.Registry()
		}
		result = append(result, EffectivePermissionEvaluation{
			RoleID: role.ID, RoleVersion: role.Version, PermissionIDs: permissions,
		})
	}
	return result, nil
}

func (s *Service) Update(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, name *string, descriptionSet bool, description *string, requestID *uuid.UUID) (Role, error) {
	return s.UpdateWithBehaviors(ctx, principal, id, expectedVersion, name, descriptionSet, description, nil, nil, nil, requestID)
}

func (s *Service) UpdateWithBehaviors(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, name *string, descriptionSet bool, description *string, profileImageRequired *bool, laborordnungMode *string, supervisorDashboard *bool, requestID *uuid.UUID) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 || (name == nil && !descriptionSet && profileImageRequired == nil && laborordnungMode == nil && supervisorDashboard == nil) {
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
	newProfileImageRequired := current.ProfileImageRequired
	newLaborordnungMode := current.LaborordnungMode
	newSupervisorDashboard := current.SupervisorDashboard
	changed := make([]string, 0, 5)
	if name != nil {
		newName = strings.TrimSpace(*name)
		changed = append(changed, "name")
	}
	if descriptionSet {
		newDescription = cleanOptional(description)
		changed = append(changed, "description")
	}
	if profileImageRequired != nil {
		newProfileImageRequired = *profileImageRequired
		changed = append(changed, "profileImageRequired")
	}
	if laborordnungMode != nil {
		newLaborordnungMode = *laborordnungMode
		changed = append(changed, "laborordnungMode")
	}
	if supervisorDashboard != nil {
		newSupervisorDashboard = *supervisorDashboard
		changed = append(changed, "supervisorDashboard")
	}
	if newLaborordnungMode != "not_required" && newLaborordnungMode != "warning" && newLaborordnungMode != "blocking" {
		return Role{}, validation("Lab Rules mode is invalid")
	}
	if newName == "" || len([]rune(newName)) > 100 || strings.EqualFold(newName, "master") {
		return Role{}, validation("role name is invalid or reserved")
	}
	if newDescription != nil && len([]rune(*newDescription)) > 500 {
		return Role{}, validation("description is too long")
	}
	row, err := queries.UpdateRole(ctx, rolesdb.UpdateRoleParams{ID: id, ExpectedVersion: expectedVersion, Name: newName, Description: newDescription, ProfileImageRequired: newProfileImageRequired, LaborordnungMode: newLaborordnungMode, SupervisorDashboard: newSupervisorDashboard})
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
	grants := make([]authorization.PermissionGrant, 0)
	if row.SystemKey != nil && *row.SystemKey == "master" {
		for _, permission := range authorization.Registry() {
			grants = append(grants, authorization.PermissionGrant{PermissionID: permission, Scope: authorization.GrantEverywhere, MinimumAssurance: authorization.AssuranceLow})
		}
	} else {
		stored, err := queries.GetRolePermissionGrants(ctx, row.ID)
		if err != nil {
			return Role{}, err
		}
		byID := map[uuid.UUID]authorization.PermissionGrant{}
		order := make([]uuid.UUID, 0)
		for _, value := range stored {
			permission := authorization.Permission(value.PermissionID)
			if !authorization.Known(permission) {
				slog.WarnContext(ctx, "ignored unknown stored permission", "role_id", row.ID, "permission_id", value)
				continue
			}
			grant, exists := byID[value.ID]
			if !exists {
				grant = authorization.PermissionGrant{ID: value.ID, PermissionID: permission, Scope: authorization.GrantScope(value.Scope), MinimumAssurance: authorization.Assurance(value.MinimumAssurance)}
				order = append(order, value.ID)
			}
			if value.DeviceTypeID != nil {
				grant.DeviceTypeIDs = append(grant.DeviceTypeIDs, *value.DeviceTypeID)
			}
			byID[value.ID] = grant
		}
		grants = make([]authorization.PermissionGrant, 0, len(byID))
		for _, id := range order {
			grants = append(grants, byID[id])
		}
	}
	sort.Slice(grants, func(i, j int) bool { return grants[i].PermissionID < grants[j].PermissionID })
	return Role{ID: row.ID, Name: row.Name, Description: row.Description, SystemKey: row.SystemKey, PermissionGrants: grants, ProfileImageRequired: row.ProfileImageRequired, LaborordnungMode: row.LaborordnungMode, SupervisorDashboard: row.SupervisorDashboard, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func ensureExistingSubset(ctx context.Context, queries *rolesdb.Queries, principal authorization.Principal, roleID uuid.UUID) error {
	permissions, err := queries.GetRolePermissionGrants(ctx, roleID)
	if err != nil {
		return err
	}
	seen := map[uuid.UUID]authorization.PermissionGrant{}
	for _, value := range permissions {
		permission := authorization.Permission(value.PermissionID)
		if !authorization.Known(permission) {
			slog.WarnContext(ctx, "unknown stored permission blocked role management", "role_id", roleID, "permission_id", value.PermissionID)
			if !principal.Master {
				return apperror.PermissionDenied
			}
			continue
		}
		grant, exists := seen[value.ID]
		if !exists {
			grant = authorization.PermissionGrant{ID: value.ID, PermissionID: permission, Scope: authorization.GrantScope(value.Scope), MinimumAssurance: authorization.Assurance(value.MinimumAssurance)}
		}
		if value.DeviceTypeID != nil {
			grant.DeviceTypeIDs = append(grant.DeviceTypeIDs, *value.DeviceTypeID)
		}
		seen[value.ID] = grant
	}
	for _, grant := range seen {
		if !principal.Master && !principal.CanDelegate(grant) {
			return apperror.PermissionDenied
		}
	}
	return nil
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
