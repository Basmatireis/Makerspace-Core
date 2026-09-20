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
	PeopleReadSelf               Permission = Permission(openapi.PeopleReadSelf)
	PeopleReadAll                Permission = Permission(openapi.PeopleReadAll)
	PeopleCreate                 Permission = Permission(openapi.PeopleCreate)
	PeopleUpdateSelf             Permission = Permission(openapi.PeopleUpdateSelf)
	PeopleUpdateAll              Permission = Permission(openapi.PeopleUpdateAll)
	PeopleDelete                 Permission = Permission(openapi.PeopleDelete)
	PeopleReadMatriculation      Permission = Permission(openapi.PeopleReadMatriculation)
	PeopleUpdateMatriculation    Permission = Permission(openapi.PeopleUpdateMatriculation)
	PeopleProfileImageUpdateSelf Permission = Permission(openapi.PeopleProfileImageUpdateSelf)
	PeopleProfileImageUpdateAll  Permission = Permission(openapi.PeopleProfileImageUpdateAll)
	PeopleProfileImageRemoveSelf Permission = Permission(openapi.PeopleProfileImageRemoveSelf)
	PeopleProfileImageRemoveAll  Permission = Permission(openapi.PeopleProfileImageRemoveAll)
	AccountsRead                 Permission = Permission(openapi.AccountsRead)
	AccountsCreate               Permission = Permission(openapi.AccountsCreate)
	AccountsDelete               Permission = Permission(openapi.AccountsDelete)
	AccountsEnable               Permission = Permission(openapi.AccountsEnable)
	AccountsDisable              Permission = Permission(openapi.AccountsDisable)
	AccountsLoginEmailUpdate     Permission = Permission(openapi.AccountsLoginEmailUpdate)
	AccountsPasswordSet          Permission = Permission(openapi.AccountsPasswordSet)
	AccountsPasswordReset        Permission = Permission(openapi.AccountsPasswordReset)
	AccountsPasswordEnrollSelf   Permission = Permission(openapi.AccountsPasswordEnrollSelf)
	AccountsPasswordEnrollAll    Permission = Permission(openapi.AccountsPasswordEnrollAll)
	AccountsPasswordRemoveSelf   Permission = Permission(openapi.AccountsPasswordRemoveSelf)
	AccountsPasswordRemoveAll    Permission = Permission(openapi.AccountsPasswordRemoveAll)
	AccountsPINEnrollSelf        Permission = Permission(openapi.AccountsPinEnrollSelf)
	AccountsPINEnrollAll         Permission = Permission(openapi.AccountsPinEnrollAll)
	AccountsPINRemoveSelf        Permission = Permission(openapi.AccountsPinRemoveSelf)
	AccountsPINRemoveAll         Permission = Permission(openapi.AccountsPinRemoveAll)
	AccountsPINReset             Permission = Permission(openapi.AccountsPinReset)
	AccountsRolesAssign          Permission = Permission(openapi.AccountsRolesAssign)
	RolesRead                    Permission = Permission(openapi.RolesRead)
	RolesManage                  Permission = Permission(openapi.RolesManage)
	AuditRead                    Permission = Permission(openapi.AuditRead)
	OpenDaysRead                 Permission = Permission(openapi.OpenDaysRead)
	OpenDaysReadAssignments      Permission = Permission(openapi.OpenDaysReadAssignments)
	OpenDaysSignup               Permission = Permission(openapi.OpenDaysSignup)
	OpenDaysAssign               Permission = Permission(openapi.OpenDaysAssign)
	OpenDaysManage               Permission = Permission(openapi.OpenDaysManage)
	ManagedDevicesRead           Permission = Permission(openapi.ManagedDevicesRead)
	ManagedDevicesManage         Permission = Permission(openapi.ManagedDevicesManage)
	LaborordnungRead             Permission = Permission(openapi.LaborordnungRead)
	LaborordnungManage           Permission = Permission(openapi.LaborordnungManage)
	LaborordnungRequestsRead     Permission = Permission(openapi.LaborordnungRequestsRead)
	LaborordnungConfirm          Permission = Permission(openapi.LaborordnungConfirm)
	VisitorEnrollmentManage      Permission = Permission(openapi.VisitorEnrollmentManage)
	SupervisorDashboardRead      Permission = Permission(openapi.SupervisorDashboardRead)
	OIDCLinkSelf                 Permission = Permission(openapi.IdentitiesOidcLinkSelf)
	OIDCLinkAll                  Permission = Permission(openapi.IdentitiesOidcLinkAll)
	OIDCUnlinkSelf               Permission = Permission(openapi.IdentitiesOidcUnlinkSelf)
	OIDCUnlinkAll                Permission = Permission(openapi.IdentitiesOidcUnlinkAll)
	OIDCManage                   Permission = Permission(openapi.OidcManage)
	SCIMManage                   Permission = Permission(openapi.ScimManage)
	MailManage                   Permission = Permission(openapi.MailManage)
)

type Definition struct {
	ID          Permission
	Description string
}

var registry = []Permission{
	PeopleReadSelf, PeopleReadAll, PeopleCreate, PeopleUpdateSelf, PeopleUpdateAll,
	PeopleDelete, PeopleReadMatriculation, PeopleUpdateMatriculation,
	PeopleProfileImageUpdateSelf, PeopleProfileImageUpdateAll, PeopleProfileImageRemoveSelf, PeopleProfileImageRemoveAll,
	AccountsRead, AccountsCreate, AccountsDelete, AccountsEnable, AccountsDisable,
	AccountsLoginEmailUpdate, AccountsPasswordSet, AccountsPasswordReset,
	AccountsPasswordEnrollSelf, AccountsPasswordEnrollAll, AccountsPasswordRemoveSelf, AccountsPasswordRemoveAll,
	AccountsPINEnrollSelf, AccountsPINEnrollAll, AccountsPINRemoveSelf, AccountsPINRemoveAll, AccountsPINReset,
	AccountsRolesAssign,
	RolesRead, RolesManage, AuditRead,
	OpenDaysRead, OpenDaysReadAssignments, OpenDaysSignup, OpenDaysAssign, OpenDaysManage,
	ManagedDevicesRead, ManagedDevicesManage,
	LaborordnungRead, LaborordnungManage, LaborordnungRequestsRead, LaborordnungConfirm,
	VisitorEnrollmentManage, SupervisorDashboardRead,
	OIDCLinkSelf, OIDCLinkAll, OIDCUnlinkSelf, OIDCUnlinkAll, OIDCManage, SCIMManage, MailManage,
}

var known = func() map[Permission]struct{} {
	result := make(map[Permission]struct{}, len(registry))
	for _, permission := range registry {
		result[permission] = struct{}{}
	}
	return result
}()

var descriptions = map[Permission]string{
	PeopleReadSelf:               "Read the person record linked to the current account.",
	PeopleReadAll:                "Read every person record.",
	PeopleCreate:                 "Create person records.",
	PeopleUpdateSelf:             "Update the person record linked to the current account.",
	PeopleUpdateAll:              "Update every person record.",
	PeopleDelete:                 "Permanently delete person records.",
	PeopleReadMatriculation:      "Read matriculation numbers on otherwise-readable people.",
	PeopleUpdateMatriculation:    "Set or clear matriculation numbers on otherwise-writable people.",
	PeopleProfileImageUpdateSelf: "Upload or replace the current Person's profile image.",
	PeopleProfileImageUpdateAll:  "Upload or replace any Person's profile image.",
	PeopleProfileImageRemoveSelf: "Remove the current Person's profile image.",
	PeopleProfileImageRemoveAll:  "Remove any Person's profile image.",
	AccountsRead:                 "Read account status, login email, and role assignments.",
	AccountsCreate:               "Create a disabled account for a person.",
	AccountsDelete:               "Permanently delete accounts and authentication data.",
	AccountsEnable:               "Enable accounts with active credentials.",
	AccountsDisable:              "Disable accounts and revoke their sessions.",
	AccountsLoginEmailUpdate:     "Change an account login email and revoke sessions.",
	AccountsPasswordSet:          "Administratively set an account password.",
	AccountsPasswordReset:        "Issue one-time account password reset links.",
	AccountsPasswordEnrollSelf:   "Enroll a password method for the current account.",
	AccountsPasswordEnrollAll:    "Invite or enroll password methods for any account.",
	AccountsPasswordRemoveSelf:   "Remove the current account's password method when another usable method remains.",
	AccountsPasswordRemoveAll:    "Remove another account's password method subject to account safety invariants.",
	AccountsPINEnrollSelf:        "Enroll or replace the current account's PIN method.",
	AccountsPINEnrollAll:         "Issue PIN enrollment for any account.",
	AccountsPINRemoveSelf:        "Remove the current account's PIN method when another usable method remains.",
	AccountsPINRemoveAll:         "Remove another account's PIN method subject to account safety invariants.",
	AccountsPINReset:             "Issue a one-time PIN setup challenge for another account.",
	AccountsRolesAssign:          "Assign or remove permitted roles on accounts.",
	RolesRead:                    "Read roles and the application permission registry.",
	RolesManage:                  "Create, update, and delete permitted configurable roles.",
	AuditRead:                    "Read privacy-minimized audit events.",
	OpenDaysRead:                 "Read visible Open Day periods and staffing summaries.",
	OpenDaysReadAssignments:      "Read the identities assigned to Open Days.",
	OpenDaysSignup:               "Sign up for and leave eligible Open Day assignments.",
	OpenDaysAssign:               "Assign and remove eligible people on Open Days.",
	OpenDaysManage:               "Manage Open Day periods, schedules, calendar context, and lifecycle.",
	ManagedDevicesRead:           "Read managed devices and device types.",
	ManagedDevicesManage:         "Create, edit, revoke, rotate, and delete managed devices and device types.",
	LaborordnungRead:             "Read Lab Rules versions and exact PDFs.",
	LaborordnungManage:           "Upload and publish immutable Lab Rules versions.",
	LaborordnungRequestsRead:     "Read the physical-document confirmation queue.",
	LaborordnungConfirm:          "Confirm physical Lab Rules evidence.",
	VisitorEnrollmentManage:      "Configure controlled visitor-terminal enrollment.",
	SupervisorDashboardRead:      "Read the privacy-minimized supervisor dashboard.",
	OIDCLinkSelf:                 "Link an OIDC identity to the current Account after fresh password reauthentication.",
	OIDCLinkAll:                  "Link an OIDC identity to another Account after fresh reauthentication.",
	OIDCUnlinkSelf:               "Unlink an OIDC identity from the current Account without stranding it.",
	OIDCUnlinkAll:                "Unlink an OIDC identity from another Account without stranding it.",
	OIDCManage:                   "Manage OIDC providers and trusted ACR mappings.",
	SCIMManage:                   "Manage SCIM connectors and one-time bearer tokens.",
	MailManage:                   "Configure transactional SMTP delivery and sender identity.",
}

type GrantScope string

const (
	GrantEverywhere          GrantScope = "global"
	GrantAnyManagedDevice    GrantScope = "managed_device"
	GrantSelectedDeviceTypes GrantScope = "device_type"
)

type Assurance string

const (
	AssuranceLow       Assurance = "low"
	AssuranceNormal    Assurance = "normal"
	AssuranceStrong    Assurance = "strong"
	AssuranceStrongMFA Assurance = "strong_mfa"
)

type PermissionGrant struct {
	ID               uuid.UUID
	PermissionID     Permission
	Scope            GrantScope
	DeviceTypeIDs    []uuid.UUID
	MinimumAssurance Assurance
}

// EvaluationContext is the request context relevant to conditional permission
// grants. A nil DeviceTypeID represents an unmanaged device.
type EvaluationContext struct {
	Assurance    Assurance
	DeviceTypeID *uuid.UUID
}

type ManagedDevice struct {
	ID             uuid.UUID
	Name           string
	DeviceTypeID   uuid.UUID
	DeviceTypeName string
	ExpiresAt      *time.Time
}

type Principal struct {
	SessionID       uuid.UUID
	AccountID       uuid.UUID
	PersonID        uuid.UUID
	FirstName       string
	LastName        string
	LoginEmail      string
	Assurance       Assurance
	AuthenticatedAt time.Time
	Master          bool
	permissions     map[Permission]struct{}
	grants          map[Permission][]PermissionGrant
	Device          *ManagedDevice
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

func (p Principal) HasFreshAssurance(minimum Assurance, maximumAge time.Duration, now time.Time) bool {
	return assuranceRank(p.Assurance) >= assuranceRank(minimum) && !p.AuthenticatedAt.IsZero() &&
		now.UTC().Sub(p.AuthenticatedAt.UTC()) >= 0 && now.UTC().Sub(p.AuthenticatedAt.UTC()) <= maximumAge
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
	if !validAssurance(principal.Assurance) {
		principal.Assurance = AssuranceNormal
	}
	principal.permissions = make(map[Permission]struct{})
	principal.grants = make(map[Permission][]PermissionGrant)
	byID := make(map[uuid.UUID]PermissionGrant)
	order := make([]uuid.UUID, 0)
	for _, row := range rows {
		if row.SystemKey != nil && *row.SystemKey == "master" {
			principal.Master = true
		}
		if row.PermissionID == nil || row.GrantID == nil {
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
		grant, exists := byID[*row.GrantID]
		if !exists {
			minimum := AssuranceLow
			if row.MinimumAssurance != nil {
				minimum = Assurance(*row.MinimumAssurance)
			}
			if !validAssurance(minimum) {
				continue
			}
			grant = PermissionGrant{ID: *row.GrantID, PermissionID: permission, Scope: rowScope, MinimumAssurance: minimum}
			order = append(order, *row.GrantID)
		}
		if row.DeviceTypeID != nil {
			grant.DeviceTypeIDs = appendUniqueUUID(grant.DeviceTypeIDs, *row.DeviceTypeID)
		}
		byID[*row.GrantID] = grant
	}
	for _, id := range order {
		grant := byID[id]
		principal.grants[grant.PermissionID] = append(principal.grants[grant.PermissionID], grant)
		if principal.grantEffective(grant) {
			permission := grant.PermissionID
			principal.permissions[permission] = struct{}{}
		}
	}
	return principal, nil
}

func (p Principal) grantEffective(grant PermissionGrant) bool {
	if p.Master {
		return true
	}
	var deviceTypeID *uuid.UUID
	if p.Device != nil {
		deviceTypeID = &p.Device.DeviceTypeID
	}
	return GrantEffective(grant, EvaluationContext{Assurance: p.Assurance, DeviceTypeID: deviceTypeID})
}

// EffectivePermissions resolves a configured grant set for a hypothetical
// request context. It intentionally shares GrantEffective with live Principal
// authorization so administrative previews cannot drift from enforcement.
func EffectivePermissions(grants []PermissionGrant, evaluation EvaluationContext) []Permission {
	effective := make(map[Permission]struct{})
	for _, grant := range grants {
		if Known(grant.PermissionID) && GrantEffective(grant, evaluation) {
			effective[grant.PermissionID] = struct{}{}
		}
	}
	result := make([]Permission, 0, len(effective))
	for permission := range effective {
		result = append(result, permission)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

// GrantEffective reports whether one grant applies in the supplied context.
// Invalid grant data and invalid assurance values fail closed.
func GrantEffective(grant PermissionGrant, evaluation EvaluationContext) bool {
	if !Known(grant.PermissionID) || !validGrantScope(grant.Scope) ||
		!validAssurance(grant.MinimumAssurance) || !validAssurance(evaluation.Assurance) {
		return false
	}
	if assuranceRank(evaluation.Assurance) < assuranceRank(grant.MinimumAssurance) {
		return false
	}
	if grant.Scope == GrantEverywhere {
		return true
	}
	if evaluation.DeviceTypeID == nil {
		return false
	}
	if grant.Scope == GrantAnyManagedDevice {
		return true
	}
	if grant.Scope != GrantSelectedDeviceTypes || len(grant.DeviceTypeIDs) == 0 {
		return false
	}
	for _, id := range grant.DeviceTypeIDs {
		if id == *evaluation.DeviceTypeID {
			return true
		}
	}
	return false
}

func (p Principal) DelegablePermissionGrants() []PermissionGrant {
	if p.Master {
		result := make([]PermissionGrant, 0, len(registry))
		for _, v := range Registry() {
			result = append(result, PermissionGrant{PermissionID: v, Scope: GrantEverywhere, MinimumAssurance: AssuranceLow})
		}
		return result
	}
	result := make([]PermissionGrant, 0)
	for _, grants := range p.grants {
		result = append(result, grants...)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].PermissionID != result[j].PermissionID {
			return result[i].PermissionID < result[j].PermissionID
		}
		return result[i].ID.String() < result[j].ID.String()
	})
	return result
}

func (p Principal) CanDelegate(grant PermissionGrant) bool {
	if !validGrantScope(grant.Scope) || (grant.Scope == GrantSelectedDeviceTypes && len(grant.DeviceTypeIDs) == 0) {
		return false
	}
	if !validAssurance(grant.MinimumAssurance) {
		return false
	}
	if p.Master {
		return true
	}
	envelopes := p.grants[grant.PermissionID]
	if grant.Scope != GrantSelectedDeviceTypes {
		for _, envelope := range envelopes {
			if grantCoveredBy(envelope, grant, uuid.Nil) {
				return true
			}
		}
		return false
	}
	for _, deviceTypeID := range grant.DeviceTypeIDs {
		covered := false
		for _, envelope := range envelopes {
			if grantCoveredBy(envelope, grant, deviceTypeID) {
				covered = true
				break
			}
		}
		if !covered {
			return false
		}
	}
	return true
}

func grantCoveredBy(envelope, requested PermissionGrant, selectedType uuid.UUID) bool {
	if !validGrantScope(envelope.Scope) || !validAssurance(envelope.MinimumAssurance) || assuranceRank(envelope.MinimumAssurance) > assuranceRank(requested.MinimumAssurance) {
		return false
	}
	switch requested.Scope {
	case GrantEverywhere:
		return envelope.Scope == GrantEverywhere
	case GrantAnyManagedDevice:
		return envelope.Scope == GrantEverywhere || envelope.Scope == GrantAnyManagedDevice
	case GrantSelectedDeviceTypes:
		if envelope.Scope == GrantEverywhere || envelope.Scope == GrantAnyManagedDevice {
			return true
		}
		for _, id := range envelope.DeviceTypeIDs {
			if id == selectedType {
				return true
			}
		}
	}
	return false
}

func validAssurance(value Assurance) bool { return assuranceRank(value) >= 0 }

func ValidAssurance(value Assurance) bool { return validAssurance(value) }

func assuranceRank(value Assurance) int {
	switch value {
	case AssuranceLow:
		return 0
	case AssuranceNormal:
		return 1
	case AssuranceStrong:
		return 2
	case AssuranceStrongMFA:
		return 3
	default:
		return -1
	}
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
