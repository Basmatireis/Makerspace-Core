package roles

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
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
	SystemKey            *authorization.SystemKey
	PermissionGrants     []authorization.PermissionGrant
	ProfileImageRequired bool
	LaborordnungMode     laborordnung.Mode
	StaffingLevel        *StaffingLevel
	// MinOpenDaysPerSemester overrides the general open-day minimum for people holding the role; nil uses the
	// general minimum. Only set together with a staffing level.
	MinOpenDaysPerSemester *int
	Version                int64
	CreatedAt              time.Time
	UpdatedAt              time.Time
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

func (s *Service) Create(
	ctx context.Context,
	principal authorization.Principal,
	name string,
	description *string,
	grants []authorization.PermissionGrant,
	requestID *uuid.UUID,
) (Role, error) {
	return s.CreateWithBehaviors(ctx, principal, name, description, grants, false, laborordnung.ModeNotRequired, nil, nil, requestID)
}

func (s *Service) CreateWithBehaviors(
	ctx context.Context,
	principal authorization.Principal,
	name string,
	description *string,
	grants []authorization.PermissionGrant,
	profileImageRequired bool,
	laborordnungMode laborordnung.Mode,
	staffingLevel *StaffingLevel,
	minOpenDays *int,
	requestID *uuid.UUID,
) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	var result Role
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.CreateWithBehaviorsTx(
			ctx,
			tx,
			principal,
			name,
			description,
			grants,
			profileImageRequired,
			laborordnungMode,
			staffingLevel,
			minOpenDays,
			requestID,
		)
		return err
	})
	return result, err
}

// CreateWithBehaviorsTx is CreateWithBehaviors inside the caller's transaction; the configuration import uses it.
func (s *Service) CreateWithBehaviorsTx(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	name string,
	description *string,
	grants []authorization.PermissionGrant,
	profileImageRequired bool,
	laborordnungMode laborordnung.Mode,
	staffingLevel *StaffingLevel,
	minOpenDays *int,
	requestID *uuid.UUID,
) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	name = strings.TrimSpace(name)
	description = optional.Trimmed(description)
	if name == "" || len([]rune(name)) > 100 || strings.EqualFold(name, string(authorization.SystemKeyMaster)) {
		return Role{}, apperror.InvalidField("role name is invalid or reserved")
	}
	if description != nil && len([]rune(*description)) > 500 {
		return Role{}, apperror.InvalidField("description is too long")
	}
	if !laborordnungMode.Valid() {
		return Role{}, apperror.InvalidField("Lab Rules mode is invalid")
	}
	if staffingLevel != nil && !staffingLevel.Valid() {
		return Role{}, apperror.InvalidField("staffing level is invalid")
	}
	if err := validateMinOpenDays(staffingLevel, minOpenDays); err != nil {
		return Role{}, err
	}
	grants, err := validateGrants(principal, grants)
	if err != nil {
		return Role{}, err
	}
	q := rolesdb.New(tx)
	id := ids.New()
	row, err := q.CreateRole(
		ctx,
		rolesdb.CreateRoleParams{
			ID:                     id,
			Name:                   name,
			Description:            description,
			ProfileImageRequired:   profileImageRequired,
			LaborordnungMode:       string(laborordnungMode),
			StaffingLevel:          optional.Convert[string](staffingLevel),
			MinOpenDaysPerSemester: minOpenDaysParam(minOpenDays),
		},
	)
	if err != nil {
		return Role{}, databaseError(err)
	}
	if err = insertGrants(ctx, q, id, grants); err != nil {
		return Role{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "role.created",
			ResourceType:   "role",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields: []string{"name", "description", "permissionGrants", "profileImageRequired", "staffingLevel",
				"minOpenDaysPerSemester"},
		},
	); err != nil {
		return Role{}, err
	}
	result, err := fromRow(ctx, q, row)
	if err != nil {
		return Role{}, err
	}
	return result, nil
}

func (s *Service) ReplacePermissions(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	grants []authorization.PermissionGrant,
	requestID *uuid.UUID,
) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Role{}, apperror.InvalidField("expectedVersion must be positive")
	}
	var result Role
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.ReplacePermissionsTx(ctx, tx, principal, id, expectedVersion, grants, requestID)
		return err
	})
	return result, err
}

// ReplacePermissionsTx is ReplacePermissions inside the caller's transaction; the configuration import uses it.
func (s *Service) ReplacePermissionsTx(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	grants []authorization.PermissionGrant,
	requestID *uuid.UUID,
) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Role{}, apperror.InvalidField("expectedVersion must be positive")
	}
	grants, err := validateGrants(principal, grants)
	if err != nil {
		return Role{}, err
	}
	q := rolesdb.New(tx)
	current, err := q.GetRoleForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apperror.NotFound
	}
	if err != nil {
		return Role{}, err
	}
	if current.SystemKey != nil {
		return Role{}, apperror.New(
			http.StatusConflict,
			"system_role_protected",
			"The master role permissions cannot be edited",
		)
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
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "role.permissions_replaced",
			ResourceType:   "role",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"permissionGrants"},
		},
	); err != nil {
		return Role{}, err
	}
	result, err := fromRow(ctx, q, row)
	if err != nil {
		return Role{}, err
	}
	return result, nil
}

func insertGrants(
	ctx context.Context,
	q *rolesdb.Queries,
	roleID uuid.UUID,
	grants []authorization.PermissionGrant,
) error {
	for _, g := range grants {
		grantID := ids.New()
		if err := q.AddRolePermission(
			ctx,
			rolesdb.AddRolePermissionParams{
				ID:               grantID,
				RoleID:           roleID,
				PermissionID:     string(g.PermissionID),
				Scope:            string(g.Scope),
				MinimumAssurance: string(g.MinimumAssurance),
			},
		); err != nil {
			return err
		}
		for _, typeID := range g.DeviceTypeIDs {
			if err := q.AddRolePermissionDeviceType(
				ctx,
				rolesdb.AddRolePermissionDeviceTypeParams{GrantID: grantID, DeviceTypeID: typeID},
			); err != nil {
				return databaseError(err)
			}
		}
	}
	return nil
}

func validateGrants(
	principal authorization.Principal,
	grants []authorization.PermissionGrant,
) ([]authorization.PermissionGrant, error) {
	seen := map[string]struct{}{}
	result := append([]authorization.PermissionGrant(nil), grants...)
	for i, g := range result {
		if !authorization.Known(g.PermissionID) {
			return nil, apperror.InvalidField("unknown permission: " + string(g.PermissionID))
		}
		if g.MinimumAssurance == "" {
			g.MinimumAssurance = authorization.AssuranceLow
		}
		key := string(g.PermissionID) + "\x00" + string(g.Scope) + "\x00" + string(g.MinimumAssurance)
		if _, ok := seen[key]; ok {
			return nil, apperror.InvalidField("duplicate permission grant")
		}
		seen[key] = struct{}{}
		types := map[uuid.UUID]struct{}{}
		for _, id := range g.DeviceTypeIDs {
			if _, ok := types[id]; ok {
				return nil, apperror.InvalidField("deviceTypeIds must be unique")
			}
			types[id] = struct{}{}
		}
		if g.Scope == authorization.GrantSelectedDeviceTypes && len(g.DeviceTypeIDs) == 0 {
			return nil, apperror.InvalidField("selected device types cannot be empty")
		}
		if g.Scope != authorization.GrantSelectedDeviceTypes && len(g.DeviceTypeIDs) != 0 {
			return nil, apperror.InvalidField("deviceTypeIds are only valid for selected device types")
		}
		if g.Scope != authorization.GrantEverywhere && g.Scope != authorization.GrantAnyManagedDevice &&
			g.Scope != authorization.GrantSelectedDeviceTypes {
			return nil, apperror.InvalidField("permission scope is invalid")
		}
		sort.Slice(
			g.DeviceTypeIDs,
			func(a, b int) bool { return g.DeviceTypeIDs[a].String() < g.DeviceTypeIDs[b].String() },
		)
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

func (s *Service) EvaluatePermissions(
	ctx context.Context,
	principal authorization.Principal,
	evaluation authorization.EvaluationContext,
) ([]EffectivePermissionEvaluation, error) {
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
		if role.SystemKey != nil && *role.SystemKey == authorization.SystemKeyMaster {
			permissions = authorization.Registry()
		}
		result = append(result, EffectivePermissionEvaluation{
			RoleID: role.ID, RoleVersion: role.Version, PermissionIDs: permissions,
		})
	}
	return result, nil
}

func (s *Service) Update(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	name *string,
	descriptionSet bool,
	description *string,
	requestID *uuid.UUID,
) (Role, error) {
	return s.UpdateWithBehaviors(
		ctx,
		principal,
		id,
		expectedVersion,
		name,
		descriptionSet,
		description,
		nil,
		nil,
		false,
		nil,
		false,
		nil,
		requestID,
	)
}

func (s *Service) UpdateWithBehaviors(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	name *string,
	descriptionSet bool,
	description *string,
	profileImageRequired *bool,
	laborordnungMode *laborordnung.Mode,
	staffingLevelSet bool,
	staffingLevel *StaffingLevel,
	minOpenDaysSet bool,
	minOpenDays *int,
	requestID *uuid.UUID,
) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 ||
		(name == nil && !descriptionSet && profileImageRequired == nil && laborordnungMode == nil && !staffingLevelSet &&
			!minOpenDaysSet) {
		return Role{}, apperror.InvalidField("at least one field and a positive expectedVersion are required")
	}
	var result Role
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdateWithBehaviorsTx(
			ctx,
			tx,
			principal,
			id,
			expectedVersion,
			name,
			descriptionSet,
			description,
			profileImageRequired,
			laborordnungMode,
			staffingLevelSet,
			staffingLevel,
			minOpenDaysSet,
			minOpenDays,
			requestID,
		)
		return err
	})
	return result, err
}

// UpdateWithBehaviorsTx is UpdateWithBehaviors inside the caller's transaction; the configuration import uses it.
func (s *Service) UpdateWithBehaviorsTx(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	name *string,
	descriptionSet bool,
	description *string,
	profileImageRequired *bool,
	laborordnungMode *laborordnung.Mode,
	staffingLevelSet bool,
	staffingLevel *StaffingLevel,
	minOpenDaysSet bool,
	minOpenDays *int,
	requestID *uuid.UUID,
) (Role, error) {
	if !principal.Has(authorization.RolesManage) {
		return Role{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 ||
		(name == nil && !descriptionSet && profileImageRequired == nil && laborordnungMode == nil && !staffingLevelSet &&
			!minOpenDaysSet) {
		return Role{}, apperror.InvalidField("at least one field and a positive expectedVersion are required")
	}
	queries := rolesdb.New(tx)
	current, err := queries.GetRoleForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apperror.NotFound
	}
	if err != nil {
		return Role{}, err
	}
	if current.SystemKey != nil {
		return Role{}, apperror.New(http.StatusConflict, "system_role_protected", "The master role cannot be edited")
	}
	if err := ensureExistingSubset(ctx, queries, principal, current.ID); err != nil {
		return Role{}, err
	}
	newName, newDescription := current.Name, current.Description
	newProfileImageRequired := current.ProfileImageRequired
	newLaborordnungMode := laborordnung.Mode(current.LaborordnungMode)
	newStaffingLevel := optional.Convert[StaffingLevel](current.StaffingLevel)
	newMinOpenDays := minOpenDaysFromRow(current.MinOpenDaysPerSemester)
	changed := make([]string, 0, 5)
	if name != nil {
		newName = strings.TrimSpace(*name)
		changed = append(changed, "name")
	}
	if descriptionSet {
		newDescription = optional.Trimmed(description)
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
	if staffingLevelSet {
		newStaffingLevel = staffingLevel
		changed = append(changed, "staffingLevel")
	}
	if minOpenDaysSet {
		newMinOpenDays = minOpenDays
		changed = append(changed, "minOpenDaysPerSemester")
	} else if staffingLevelSet && newStaffingLevel == nil && newMinOpenDays != nil {
		// A role that stops staffing has no open-day minimum to override.
		newMinOpenDays = nil
		changed = append(changed, "minOpenDaysPerSemester")
	}
	if newStaffingLevel != nil && !newStaffingLevel.Valid() {
		return Role{}, apperror.InvalidField("staffing level is invalid")
	}
	if err := validateMinOpenDays(newStaffingLevel, newMinOpenDays); err != nil {
		return Role{}, err
	}
	if !newLaborordnungMode.Valid() {
		return Role{}, apperror.InvalidField("Lab Rules mode is invalid")
	}
	if newName == "" || len([]rune(newName)) > 100 || strings.EqualFold(newName, string(authorization.SystemKeyMaster)) {
		return Role{}, apperror.InvalidField("role name is invalid or reserved")
	}
	if newDescription != nil && len([]rune(*newDescription)) > 500 {
		return Role{}, apperror.InvalidField("description is too long")
	}
	row, err := queries.UpdateRole(
		ctx,
		rolesdb.UpdateRoleParams{
			ID:                     id,
			ExpectedVersion:        expectedVersion,
			Name:                   newName,
			Description:            newDescription,
			ProfileImageRequired:   newProfileImageRequired,
			LaborordnungMode:       string(newLaborordnungMode),
			StaffingLevel:          optional.Convert[string](newStaffingLevel),
			MinOpenDaysPerSemester: minOpenDaysParam(newMinOpenDays),
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apperror.StaleWrite
	}
	if err != nil {
		return Role{}, databaseError(err)
	}
	if staffingLevelSet && (newStaffingLevel == nil || *newStaffingLevel != StaffingSupervisor) {
		if err := queries.ClearSupervisorRoleRequirement(ctx, &id); err != nil {
			return Role{}, err
		}
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "role.updated",
			ResourceType:   "role",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  changed,
		},
	); err != nil {
		return Role{}, err
	}
	result, err := fromRow(ctx, queries, row)
	if err != nil {
		return Role{}, err
	}
	return result, nil
}

func (s *Service) Delete(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.RolesManage) {
		return apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return apperror.InvalidField("expectedVersion must be positive")
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		return s.DeleteTx(ctx, tx, principal, id, expectedVersion, requestID)
	})
}

// DeleteTx is Delete inside the caller's transaction; the configuration import uses it.
func (s *Service) DeleteTx(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.RolesManage) {
		return apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return apperror.InvalidField("expectedVersion must be positive")
	}
	queries := rolesdb.New(tx)
	current, err := queries.GetRoleForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.SystemKey != nil {
		return apperror.New(http.StatusConflict, "system_role_protected", "The master role cannot be deleted")
	}
	if err := ensureExistingSubset(ctx, queries, principal, current.ID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "role.deleted",
			ResourceType:   "role",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return err
	}
	if _, err := queries.DeleteRole(ctx, rolesdb.DeleteRoleParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	return nil
}

func fromRow(ctx context.Context, queries *rolesdb.Queries, row rolesdb.Role) (Role, error) {
	grants := make([]authorization.PermissionGrant, 0)
	if row.SystemKey != nil && authorization.SystemKey(*row.SystemKey) == authorization.SystemKeyMaster {
		for _, permission := range authorization.Registry() {
			grants = append(
				grants,
				authorization.PermissionGrant{
					PermissionID:     permission,
					Scope:            authorization.GrantEverywhere,
					MinimumAssurance: authorization.AssuranceLow,
				},
			)
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
				grant = authorization.PermissionGrant{
					ID:               value.ID,
					PermissionID:     permission,
					Scope:            authorization.GrantScope(value.Scope),
					MinimumAssurance: authorization.Assurance(value.MinimumAssurance),
				}
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
	return Role{
		ID:                     row.ID,
		Name:                   row.Name,
		Description:            row.Description,
		SystemKey:              optional.Convert[authorization.SystemKey](row.SystemKey),
		PermissionGrants:       grants,
		ProfileImageRequired:   row.ProfileImageRequired,
		LaborordnungMode:       laborordnung.Mode(row.LaborordnungMode),
		StaffingLevel:          optional.Convert[StaffingLevel](row.StaffingLevel),
		MinOpenDaysPerSemester: minOpenDaysFromRow(row.MinOpenDaysPerSemester),
		Version:                row.Version,
		CreatedAt:              row.CreatedAt,
		UpdatedAt:              row.UpdatedAt,
	}, nil
}

func ensureExistingSubset(
	ctx context.Context,
	queries *rolesdb.Queries,
	principal authorization.Principal,
	roleID uuid.UUID,
) error {
	permissions, err := queries.GetRolePermissionGrants(ctx, roleID)
	if err != nil {
		return err
	}
	seen := map[uuid.UUID]authorization.PermissionGrant{}
	for _, value := range permissions {
		permission := authorization.Permission(value.PermissionID)
		if !authorization.Known(permission) {
			slog.WarnContext(
				ctx,
				"unknown stored permission blocked role management",
				"role_id",
				roleID,
				"permission_id",
				value.PermissionID,
			)
			if !principal.Master {
				return apperror.PermissionDenied
			}
			continue
		}
		grant, exists := seen[value.ID]
		if !exists {
			grant = authorization.PermissionGrant{
				ID:               value.ID,
				PermissionID:     permission,
				Scope:            authorization.GrantScope(value.Scope),
				MinimumAssurance: authorization.Assurance(value.MinimumAssurance),
			}
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

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23503") {
		return apperror.Conflict
	}
	return err
}

func invalidRequest(reason string) *apperror.Error {
	err := apperror.New(http.StatusBadRequest, "invalid_request", "Request is invalid")
	err.Details["reason"] = reason
	return err
}

// MaxMinOpenDaysPerSemester mirrors the table constraint on roles.min_open_days_per_semester.
const MaxMinOpenDaysPerSemester = 20

// validateMinOpenDays checks a role's open-day minimum override: within 0..20 and only for roles that staff.
func validateMinOpenDays(level *StaffingLevel, minOpenDays *int) error {
	if minOpenDays == nil {
		return nil
	}
	if *minOpenDays < 0 || *minOpenDays > MaxMinOpenDaysPerSemester {
		return apperror.InvalidField("minOpenDaysPerSemester must be between 0 and 20")
	}
	if level == nil {
		return apperror.InvalidField("minOpenDaysPerSemester requires a staffing level")
	}
	return nil
}

func minOpenDaysParam(value *int) *int32 {
	if value == nil {
		return nil
	}
	converted := int32(*value) //nolint:gosec // validated to 0..20 above
	return &converted
}

func minOpenDaysFromRow(value *int32) *int {
	if value == nil {
		return nil
	}
	converted := int(*value)
	return &converted
}
