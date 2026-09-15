package authorization

import (
	"context"
	"log/slog"
	"sort"
	"time"

	authorizationdb "github.com/Basmatireis/Makerspace-Core/backend/internal/authorization/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
)

type Permission string

const (
	PeopleReadSelf            Permission = Permission(openapi.PeopleReadSelf)
	PeopleReadAll             Permission = Permission(openapi.PeopleReadAll)
	PeopleCreate              Permission = Permission(openapi.PeopleCreate)
	PeopleUpdateSelf          Permission = Permission(openapi.PeopleUpdateSelf)
	PeopleUpdateAll           Permission = Permission(openapi.PeopleUpdateAll)
	PeopleDelete              Permission = Permission(openapi.PeopleDelete)
	PeopleReadMatriculation   Permission = Permission(openapi.PeopleReadMatriculation)
	PeopleUpdateMatriculation Permission = Permission(openapi.PeopleUpdateMatriculation)
	AccountsRead              Permission = Permission(openapi.AccountsRead)
	AccountsCreate            Permission = Permission(openapi.AccountsCreate)
	AccountsDelete            Permission = Permission(openapi.AccountsDelete)
	AccountsEnable            Permission = Permission(openapi.AccountsEnable)
	AccountsDisable           Permission = Permission(openapi.AccountsDisable)
	AccountsLoginEmailUpdate  Permission = Permission(openapi.AccountsLoginEmailUpdate)
	AccountsPasswordSet       Permission = Permission(openapi.AccountsPasswordSet)
	AccountsPasswordReset     Permission = Permission(openapi.AccountsPasswordReset)
	AccountsRolesAssign       Permission = Permission(openapi.AccountsRolesAssign)
	RolesRead                 Permission = Permission(openapi.RolesRead)
	RolesManage               Permission = Permission(openapi.RolesManage)
	AuditRead                 Permission = Permission(openapi.AuditRead)
	OpenDaysRead              Permission = Permission(openapi.OpenDaysRead)
	OpenDaysReadAssignments   Permission = Permission(openapi.OpenDaysReadAssignments)
	OpenDaysSignup            Permission = Permission(openapi.OpenDaysSignup)
	OpenDaysAssign            Permission = Permission(openapi.OpenDaysAssign)
	OpenDaysManage            Permission = Permission(openapi.OpenDaysManage)
	ManagedDevicesRead        Permission = Permission(openapi.ManagedDevicesRead)
	ManagedDevicesManage      Permission = Permission(openapi.ManagedDevicesManage)
)

type Definition struct {
	ID          Permission
	Description string
}

var registry = []Permission{
	PeopleReadSelf, PeopleReadAll, PeopleCreate, PeopleUpdateSelf, PeopleUpdateAll,
	PeopleDelete, PeopleReadMatriculation, PeopleUpdateMatriculation,
	AccountsRead, AccountsCreate, AccountsDelete, AccountsEnable, AccountsDisable,
	AccountsLoginEmailUpdate, AccountsPasswordSet, AccountsPasswordReset, AccountsRolesAssign,
	RolesRead, RolesManage, AuditRead,
	OpenDaysRead, OpenDaysReadAssignments, OpenDaysSignup, OpenDaysAssign, OpenDaysManage,
	ManagedDevicesRead, ManagedDevicesManage,
}

var known = func() map[Permission]struct{} {
	result := make(map[Permission]struct{}, len(registry))
	for _, permission := range registry {
		result[permission] = struct{}{}
	}
	return result
}()

var descriptions = map[Permission]string{
	PeopleReadSelf:            "Read the person record linked to the current account.",
	PeopleReadAll:             "Read every person record.",
	PeopleCreate:              "Create person records.",
	PeopleUpdateSelf:          "Update the person record linked to the current account.",
	PeopleUpdateAll:           "Update every person record.",
	PeopleDelete:              "Permanently delete person records.",
	PeopleReadMatriculation:   "Read matriculation numbers on otherwise-readable people.",
	PeopleUpdateMatriculation: "Set or clear matriculation numbers on otherwise-writable people.",
	AccountsRead:              "Read account status, login email, and role assignments.",
	AccountsCreate:            "Create a disabled account for a person.",
	AccountsDelete:            "Permanently delete accounts and authentication data.",
	AccountsEnable:            "Enable accounts with active credentials.",
	AccountsDisable:           "Disable accounts and revoke their sessions.",
	AccountsLoginEmailUpdate:  "Change an account login email and revoke sessions.",
	AccountsPasswordSet:       "Administratively set an account password.",
	AccountsPasswordReset:     "Issue one-time account password reset links.",
	AccountsRolesAssign:       "Assign or remove permitted roles on accounts.",
	RolesRead:                 "Read roles and the application permission registry.",
	RolesManage:               "Create, update, and delete permitted configurable roles.",
	AuditRead:                 "Read privacy-minimized audit events.",
	OpenDaysRead:              "Read visible Open Day periods and staffing summaries.",
	OpenDaysReadAssignments:   "Read the identities assigned to Open Days.",
	OpenDaysSignup:            "Sign up for and leave eligible Open Day assignments.",
	OpenDaysAssign:            "Assign and remove eligible people on Open Days.",
	OpenDaysManage:            "Manage Open Day periods, schedules, calendar context, and lifecycle.",
	ManagedDevicesRead:        "Read managed devices and device types.",
	ManagedDevicesManage:      "Create, edit, revoke, rotate, and delete managed devices and device types.",
}

type GrantScope string

const (
	GrantEverywhere          GrantScope = "global"
	GrantAnyManagedDevice    GrantScope = "managed_device"
	GrantSelectedDeviceTypes GrantScope = "device_type"
)

type PermissionGrant struct {
	PermissionID  Permission
	Scope         GrantScope
	DeviceTypeIDs []uuid.UUID
}
type ManagedDevice struct {
	ID             uuid.UUID
	Name           string
	DeviceTypeID   uuid.UUID
	DeviceTypeName string
	ExpiresAt      *time.Time
}

type Principal struct {
	SessionID   uuid.UUID
	AccountID   uuid.UUID
	PersonID    uuid.UUID
	FirstName   string
	LastName    string
	LoginEmail  string
	Master      bool
	permissions map[Permission]struct{}
	grants      map[Permission]PermissionGrant
	Device      *ManagedDevice
}

func Registry() []Permission {
	result := append([]Permission(nil), registry...)
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func Known(permission Permission) bool {
	_, ok := known[permission]
	return ok
}

func Definitions() []Definition {
	permissions := Registry()
	result := make([]Definition, 0, len(permissions))
	for _, permission := range permissions {
		result = append(result, Definition{ID: permission, Description: descriptions[permission]})
	}
	return result
}

func (p Principal) Has(permission Permission) bool {
	if !Known(permission) {
		return false
	}
	if p.Master {
		return true
	}
	_, ok := p.permissions[permission]
	return ok
}

func (p Principal) PermissionIDs() []string {
	permissions := append([]Permission(nil), registry...)
	if !p.Master {
		permissions = make([]Permission, 0, len(p.permissions))
		for permission := range p.permissions {
			permissions = append(permissions, permission)
		}
	}
	result := make([]string, 0, len(permissions))
	for _, permission := range permissions {
		result = append(result, string(permission))
	}
	sort.Strings(result)
	return result
}

func (p Principal) CanReadPerson(personID uuid.UUID) bool {
	return p.Has(PeopleReadAll) || (p.PersonID == personID && p.Has(PeopleReadSelf))
}

func (p Principal) CanUpdatePerson(personID uuid.UUID) bool {
	return p.Has(PeopleUpdateAll) || (p.PersonID == personID && p.Has(PeopleUpdateSelf))
}

// LoadPermissionsFrom rebuilds a principal from current database state while
// keeping authorization persistence owned by this feature.
func LoadPermissionsFrom(ctx context.Context, db authorizationdb.DBTX, principal Principal) (Principal, error) {
	return LoadPermissions(ctx, authorizationdb.New(db), principal)
}

func LoadPermissions(ctx context.Context, queries authorizationdb.Querier, principal Principal) (Principal, error) {
	rows, err := queries.GetPrincipalRolePermissions(ctx, principal.AccountID)
	if err != nil {
		return Principal{}, err
	}
	// Always rebuild authorization state from PostgreSQL. In particular, callers
	// must not be able to retain master privileges by reusing a Principal value
	// after its master assignment has been removed.
	principal.Master = false
	principal.permissions = make(map[Permission]struct{})
	principal.grants = make(map[Permission]PermissionGrant)
	for _, row := range rows {
		if row.SystemKey != nil && *row.SystemKey == "master" {
			principal.Master = true
		}
		if row.PermissionID == nil {
			continue
		}
		permission := Permission(*row.PermissionID)
		if !Known(permission) {
			slog.WarnContext(ctx, "ignored unknown stored permission",
				"account_id", principal.AccountID,
				"role_id", row.RoleID,
				"permission_id", *row.PermissionID,
			)
			continue
		}
		rowScope := GrantEverywhere
		if row.Scope != nil {
			rowScope = GrantScope(*row.Scope)
		}
		if !validGrantScope(rowScope) {
			slog.WarnContext(ctx, "ignored stored permission with invalid scope",
				"account_id", principal.AccountID,
				"role_id", row.RoleID,
				"permission_id", *row.PermissionID,
			)
			continue
		}
		grant := principal.grants[permission]
		if grant.PermissionID == "" {
			grant = PermissionGrant{PermissionID: permission, Scope: rowScope}
		}
		if grant.Scope == GrantEverywhere || rowScope == GrantEverywhere {
			grant.Scope = GrantEverywhere
			grant.DeviceTypeIDs = nil
		} else if grant.Scope == GrantAnyManagedDevice || rowScope == GrantAnyManagedDevice {
			grant.Scope = GrantAnyManagedDevice
			grant.DeviceTypeIDs = nil
		} else if row.DeviceTypeID != nil {
			grant.DeviceTypeIDs = appendUniqueUUID(grant.DeviceTypeIDs, *row.DeviceTypeID)
		}
		principal.grants[permission] = grant
	}
	for permission, grant := range principal.grants {
		if principal.grantEffective(grant) {
			principal.permissions[permission] = struct{}{}
		}
	}
	return principal, nil
}

func (p Principal) grantEffective(grant PermissionGrant) bool {
	if p.Master || grant.Scope == GrantEverywhere {
		return true
	}
	if p.Device == nil {
		return false
	}
	if grant.Scope == GrantAnyManagedDevice {
		return true
	}
	if grant.Scope != GrantSelectedDeviceTypes || len(grant.DeviceTypeIDs) == 0 {
		return false
	}
	for _, id := range grant.DeviceTypeIDs {
		if id == p.Device.DeviceTypeID {
			return true
		}
	}
	return false
}

func (p Principal) DelegablePermissionGrants() []PermissionGrant {
	if p.Master {
		result := make([]PermissionGrant, 0, len(registry))
		for _, v := range Registry() {
			result = append(result, PermissionGrant{PermissionID: v, Scope: GrantEverywhere})
		}
		return result
	}
	result := make([]PermissionGrant, 0, len(p.grants))
	for _, grant := range p.grants {
		result = append(result, grant)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].PermissionID < result[j].PermissionID })
	return result
}

func (p Principal) CanDelegate(grant PermissionGrant) bool {
	if p.Master {
		return true
	}
	if !validGrantScope(grant.Scope) || (grant.Scope == GrantSelectedDeviceTypes && len(grant.DeviceTypeIDs) == 0) {
		return false
	}
	envelope, ok := p.grants[grant.PermissionID]
	if !ok || !validGrantScope(envelope.Scope) || (envelope.Scope == GrantSelectedDeviceTypes && len(envelope.DeviceTypeIDs) == 0) {
		return false
	}
	if envelope.Scope == GrantEverywhere {
		return true
	}
	if grant.Scope == GrantEverywhere {
		return false
	}
	if envelope.Scope == GrantAnyManagedDevice {
		return true
	}
	if grant.Scope == GrantAnyManagedDevice {
		return false
	}
	have := map[uuid.UUID]struct{}{}
	for _, id := range envelope.DeviceTypeIDs {
		have[id] = struct{}{}
	}
	for _, id := range grant.DeviceTypeIDs {
		if _, ok := have[id]; !ok {
			return false
		}
	}
	return true
}

func validGrantScope(scope GrantScope) bool {
	return scope == GrantEverywhere || scope == GrantAnyManagedDevice || scope == GrantSelectedDeviceTypes
}

func appendUniqueUUID(values []uuid.UUID, candidate uuid.UUID) []uuid.UUID {
	for _, value := range values {
		if value == candidate {
			return values
		}
	}
	return append(values, candidate)
}
