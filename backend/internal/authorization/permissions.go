package authorization

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	authorizationdb "github.com/Basmatireis/Makerspace-Core/backend/internal/authorization/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
)

type Permission string

const (
	OrdersRead                     Permission = Permission(openapi.OrdersRead)
	OrdersWrite                    Permission = Permission(openapi.OrdersWrite)
	OrdersFinalize                 Permission = Permission(openapi.OrdersFinalize)
	OrdersReverse                  Permission = Permission(openapi.OrdersReverse)
	PaymentsRead                   Permission = Permission(openapi.PaymentsRead)
	PaymentsRecord                 Permission = Permission(openapi.PaymentsRecord)
	PaymentsReverse                Permission = Permission(openapi.PaymentsReverse)
	ExternalInvoiceRequestsRead    Permission = Permission(openapi.ExternalInvoiceRequestsRead)
	ExternalInvoiceRequestsManage  Permission = Permission(openapi.ExternalInvoiceRequestsManage)
	ExternalInvoiceRequestsApprove Permission = Permission(openapi.ExternalInvoiceRequestsApprove)
	CashMovementsRead              Permission = Permission(openapi.CashMovementsRead)
	CashMovementsRecord            Permission = Permission(openapi.CashMovementsRecord)

	PeopleReadSelf                     Permission = Permission(openapi.PeopleReadSelf)
	PeopleReadAll                      Permission = Permission(openapi.PeopleReadAll)
	PeopleCreate                       Permission = Permission(openapi.PeopleCreate)
	PeopleUpdateSelf                   Permission = Permission(openapi.PeopleUpdateSelf)
	PeopleUpdateAll                    Permission = Permission(openapi.PeopleUpdateAll)
	PeopleDelete                       Permission = Permission(openapi.PeopleDelete)
	PeopleMerge                        Permission = Permission(openapi.PeopleMerge)
	PeopleReadMatriculation            Permission = Permission(openapi.PeopleReadMatriculation)
	PeopleUpdateMatriculation          Permission = Permission(openapi.PeopleUpdateMatriculation)
	PeopleProfileImageUpdateSelf       Permission = Permission(openapi.PeopleProfileImageUpdateSelf)
	PeopleProfileImageUpdateAll        Permission = Permission(openapi.PeopleProfileImageUpdateAll)
	PeopleProfileImageRemoveSelf       Permission = Permission(openapi.PeopleProfileImageRemoveSelf)
	PeopleProfileImageRemoveAll        Permission = Permission(openapi.PeopleProfileImageRemoveAll)
	AccountsRead                       Permission = Permission(openapi.AccountsRead)
	AccountsCreate                     Permission = Permission(openapi.AccountsCreate)
	AccountsDelete                     Permission = Permission(openapi.AccountsDelete)
	AccountsEnable                     Permission = Permission(openapi.AccountsEnable)
	AccountsDisable                    Permission = Permission(openapi.AccountsDisable)
	AccountsLoginEmailUpdate           Permission = Permission(openapi.AccountsLoginEmailUpdate)
	AccountsPasswordSet                Permission = Permission(openapi.AccountsPasswordSet)
	AccountsPasswordReset              Permission = Permission(openapi.AccountsPasswordReset)
	AccountsPasswordEnrollSelf         Permission = Permission(openapi.AccountsPasswordEnrollSelf)
	AccountsPasswordEnrollAll          Permission = Permission(openapi.AccountsPasswordEnrollAll)
	AccountsPasswordRemoveSelf         Permission = Permission(openapi.AccountsPasswordRemoveSelf)
	AccountsPasswordRemoveAll          Permission = Permission(openapi.AccountsPasswordRemoveAll)
	AccountsPINEnrollSelf              Permission = Permission(openapi.AccountsPinEnrollSelf)
	AccountsPINEnrollAll               Permission = Permission(openapi.AccountsPinEnrollAll)
	AccountsPINRemoveSelf              Permission = Permission(openapi.AccountsPinRemoveSelf)
	AccountsPINRemoveAll               Permission = Permission(openapi.AccountsPinRemoveAll)
	AccountsPINReset                   Permission = Permission(openapi.AccountsPinReset)
	AccountsMFAReset                   Permission = Permission(openapi.AccountsMfaReset)
	PeopleRolesAssign                  Permission = Permission(openapi.PeopleRolesAssign)
	RolesRead                          Permission = Permission(openapi.RolesRead)
	RolesManage                        Permission = Permission(openapi.RolesManage)
	AuditRead                          Permission = Permission(openapi.AuditRead)
	OpenDaysRead                       Permission = Permission(openapi.OpenDaysRead)
	OpenDaysReadAssignments            Permission = Permission(openapi.OpenDaysReadAssignments)
	OpenDaysSignup                     Permission = Permission(openapi.OpenDaysSignup)
	OpenDaysAssign                     Permission = Permission(openapi.OpenDaysAssign)
	OpenDaysManage                     Permission = Permission(openapi.OpenDaysManage)
	EventsRead                         Permission = Permission(openapi.EventsRead)
	EventsManage                       Permission = Permission(openapi.EventsManage)
	EventsStaffingManage               Permission = Permission(openapi.EventsStaffingManage)
	EventsAssign                       Permission = Permission(openapi.EventsAssign)
	EventsSignup                       Permission = Permission(openapi.EventsSignup)
	EventsReadAssignments              Permission = Permission(openapi.EventsReadAssignments)
	ManagedDevicesRead                 Permission = Permission(openapi.ManagedDevicesRead)
	ManagedDevicesManage               Permission = Permission(openapi.ManagedDevicesManage)
	SessionPoliciesManage              Permission = Permission(openapi.SessionPoliciesManage)
	AttendanceRead                     Permission = Permission(openapi.AttendanceRead)
	AttendanceAssist                   Permission = Permission(openapi.AttendanceAssist)
	AttendanceCorrect                  Permission = Permission(openapi.AttendanceCorrect)
	AttendanceStatisticsRead           Permission = Permission(openapi.AttendanceStatisticsRead)
	SurveysRead                        Permission = Permission(openapi.SurveysRead)
	SurveysManage                      Permission = Permission(openapi.SurveysManage)
	LaborordnungRead                   Permission = Permission(openapi.LaborordnungRead)
	LaborordnungManage                 Permission = Permission(openapi.LaborordnungManage)
	LaborordnungRequestsRead           Permission = Permission(openapi.LaborordnungRequestsRead)
	LaborordnungConfirm                Permission = Permission(openapi.LaborordnungConfirm)
	VisitorEnrollmentManage            Permission = Permission(openapi.VisitorEnrollmentManage)
	SupervisorDashboardRead            Permission = Permission(openapi.SupervisorDashboardRead)
	OIDCLinkSelf                       Permission = Permission(openapi.IdentitiesOidcLinkSelf)
	OIDCLinkAll                        Permission = Permission(openapi.IdentitiesOidcLinkAll)
	OIDCUnlinkSelf                     Permission = Permission(openapi.IdentitiesOidcUnlinkSelf)
	OIDCUnlinkAll                      Permission = Permission(openapi.IdentitiesOidcUnlinkAll)
	OIDCManage                         Permission = Permission(openapi.OidcManage)
	SCIMManage                         Permission = Permission(openapi.ScimManage)
	MailManage                         Permission = Permission(openapi.MailManage)
	BrandingManage                     Permission = Permission(openapi.BrandingManage)
	InvoicingSettingsManage            Permission = Permission(openapi.InvoicingSettingsManage)
	MachinesRead                       Permission = Permission(openapi.MachinesRead)
	MachinesManage                     Permission = Permission(openapi.MachinesManage)
	TrainingsManage                    Permission = Permission(openapi.TrainingsManage)
	TrainingRecordsReadSelf            Permission = Permission(openapi.TrainingRecordsReadSelf)
	TrainingRecordsReadAll             Permission = Permission(openapi.TrainingRecordsReadAll)
	TrainingRecordsUpdate              Permission = Permission(openapi.TrainingRecordsUpdate)
	TrainingRecordsUpdateSelf          Permission = Permission(openapi.TrainingRecordsUpdateSelf)
	MachineJobsRead                    Permission = Permission(openapi.MachineJobsRead)
	MachineJobsCreate                  Permission = Permission(openapi.MachineJobsCreate)
	MachineJobsEdit                    Permission = Permission(openapi.MachineJobsEdit)
	MachineJobsOverridePrice           Permission = Permission(openapi.MachineJobsOverridePrice)
	MachineJobsDelete                  Permission = Permission(openapi.MachineJobsDelete)
	InventoryRead                      Permission = Permission(openapi.InventoryRead)
	InventoryManage                    Permission = Permission(openapi.InventoryManage)
	FilamentSpoolsManage               Permission = Permission(openapi.FilamentSpoolsManage)
	PrinterSlotsAssign                 Permission = Permission(openapi.PrinterSlotsAssign)
	PrinterConnectorsRead              Permission = Permission(openapi.PrinterConnectorsRead)
	PrinterConnectorsManage            Permission = Permission(openapi.PrinterConnectorsManage)
	PrinterConnectorsCredentialsManage Permission = Permission(openapi.PrinterConnectorsCredentialsManage)
	PrintArtifactsRead                 Permission = Permission(openapi.PrintArtifactsRead)
	OrganizationsRead                  Permission = Permission(openapi.OrganizationsRead)
	OrganizationsManage                Permission = Permission(openapi.OrganizationsManage)
	PricingRead                        Permission = Permission(openapi.PricingRead)
	PricingManage                      Permission = Permission(openapi.PricingManage)
	StatisticsRead                     Permission = Permission(openapi.StatisticsRead)
	SignageRead                        Permission = Permission(openapi.SignageRead)
	SignageManage                      Permission = Permission(openapi.SignageManage)
	SignageContentManage               Permission = Permission(openapi.SignageContentManage)
	SignagePublish                     Permission = Permission(openapi.SignagePublish)
	SignageOverride                    Permission = Permission(openapi.SignageOverride)
	LocalServicesManage                Permission = Permission(openapi.LocalServicesManage)
	ConfigurationExport                Permission = Permission(openapi.ConfigurationExport)
	ConfigurationImport                Permission = Permission(openapi.ConfigurationImport)
	NotificationsSend                  Permission = Permission(openapi.NotificationsSend)
	PrivacyRead                        Permission = Permission(openapi.PrivacyRead)
	PrivacySettingsManage              Permission = Permission(openapi.PrivacySettingsManage)
	PrivacyPoliciesManage              Permission = Permission(openapi.PrivacyPoliciesManage)
	PrivacyRetentionExecute            Permission = Permission(openapi.PrivacyRetentionExecute)
)

type Definition struct {
	ID          Permission
	Description string
}

var registry = []Permission{
	OrdersRead,
	OrdersWrite,
	OrdersFinalize,
	OrdersReverse,
	PaymentsRead,
	PaymentsRecord,
	PaymentsReverse,
	ExternalInvoiceRequestsRead,
	ExternalInvoiceRequestsManage,
	ExternalInvoiceRequestsApprove,
	CashMovementsRead,
	CashMovementsRecord,
	PeopleReadSelf, PeopleReadAll, PeopleCreate, PeopleUpdateSelf, PeopleUpdateAll,
	PeopleDelete, PeopleMerge, PeopleReadMatriculation, PeopleUpdateMatriculation,
	PeopleProfileImageUpdateSelf,
	PeopleProfileImageUpdateAll,
	PeopleProfileImageRemoveSelf,
	PeopleProfileImageRemoveAll,
	AccountsRead, AccountsCreate, AccountsDelete, AccountsEnable, AccountsDisable,
	AccountsLoginEmailUpdate, AccountsPasswordSet, AccountsPasswordReset,
	AccountsPasswordEnrollSelf, AccountsPasswordEnrollAll, AccountsPasswordRemoveSelf, AccountsPasswordRemoveAll,
	AccountsPINEnrollSelf, AccountsPINEnrollAll, AccountsPINRemoveSelf, AccountsPINRemoveAll, AccountsPINReset,
	AccountsMFAReset,
	PeopleRolesAssign,
	RolesRead, RolesManage, AuditRead,
	OpenDaysRead, OpenDaysReadAssignments, OpenDaysSignup, OpenDaysAssign, OpenDaysManage,
	EventsRead, EventsManage, EventsStaffingManage, EventsAssign, EventsSignup, EventsReadAssignments,
	ManagedDevicesRead, ManagedDevicesManage, SessionPoliciesManage,
	AttendanceRead, AttendanceAssist, AttendanceCorrect, AttendanceStatisticsRead,
	SurveysRead, SurveysManage,
	LaborordnungRead, LaborordnungManage, LaborordnungRequestsRead, LaborordnungConfirm,
	VisitorEnrollmentManage, SupervisorDashboardRead,
	OIDCLinkSelf, OIDCLinkAll, OIDCUnlinkSelf, OIDCUnlinkAll, OIDCManage, SCIMManage, MailManage, BrandingManage, InvoicingSettingsManage,
	MachinesRead, MachinesManage,
	TrainingsManage, TrainingRecordsReadSelf, TrainingRecordsReadAll, TrainingRecordsUpdate,
	TrainingRecordsUpdateSelf,
	MachineJobsRead, MachineJobsCreate, MachineJobsEdit, MachineJobsOverridePrice, MachineJobsDelete,
	InventoryRead, InventoryManage, FilamentSpoolsManage, PrinterSlotsAssign,
	PrinterConnectorsRead, PrinterConnectorsManage, PrinterConnectorsCredentialsManage, PrintArtifactsRead,
	OrganizationsRead, OrganizationsManage, PricingRead, PricingManage, StatisticsRead,
	SignageRead, SignageManage, SignageContentManage, SignagePublish, SignageOverride, LocalServicesManage,
	ConfigurationExport, ConfigurationImport, NotificationsSend,
	PrivacyRead, PrivacySettingsManage, PrivacyPoliciesManage, PrivacyRetentionExecute,
}

var known = func() map[Permission]struct{} {
	result := make(map[Permission]struct{}, len(registry))
	for _, permission := range registry {
		result[permission] = struct{}{}
	}
	return result
}()

var descriptions = map[Permission]string{ //nolint:gosec // human-readable permission descriptions, not credentials
	OrdersRead:                     "Read internal orders and their charge snapshots.",
	OrdersWrite:                    "Create and edit draft orders.",
	OrdersFinalize:                 "Finalize internal charges.",
	OrdersReverse:                  "Reverse charges and commit replacements.",
	PaymentsRead:                   "Read payments and reconciliation activity.",
	PaymentsRecord:                 "Record receipts and carry them to authorized replacements.",
	PaymentsReverse:                "Record full refunds and payment corrections.",
	ExternalInvoiceRequestsRead:    "Read external invoicing snapshots and evidence.",
	ExternalInvoiceRequestsManage:  "Prepare and manage external invoicing requests.",
	ExternalInvoiceRequestsApprove: "Approve external invoice requests: edit, return for correction, forward to wiRef, or cancel while they await approval.",
	CashMovementsRead:              "Read cash withdrawals and deposits.",
	CashMovementsRecord:            "Record cash withdrawals and deposits.",

	PeopleReadSelf:                     "Read the person record linked to the current account.",
	PeopleReadAll:                      "Read every person record.",
	PeopleCreate:                       "Create person records.",
	PeopleUpdateSelf:                   "Update the person record linked to the current account.",
	PeopleUpdateAll:                    "Update every person record.",
	PeopleDelete:                       "Permanently delete person records.",
	PeopleMerge:                        "Merge duplicate people into one, permanently deleting the duplicates.",
	PeopleReadMatriculation:            "Read matriculation numbers on otherwise-readable people.",
	PeopleUpdateMatriculation:          "Set or clear matriculation numbers on otherwise-writable people.",
	PeopleProfileImageUpdateSelf:       "Upload or replace the current Person's profile image.",
	PeopleProfileImageUpdateAll:        "Upload or replace any Person's profile image.",
	PeopleProfileImageRemoveSelf:       "Remove the current Person's profile image.",
	PeopleProfileImageRemoveAll:        "Remove any Person's profile image.",
	AccountsRead:                       "Read account status and authentication identities.",
	AccountsCreate:                     "Create an active account for a person.",
	AccountsDelete:                     "Permanently delete accounts and authentication data.",
	AccountsEnable:                     "Activate accounts independently of their authentication methods.",
	AccountsDisable:                    "Disable accounts and revoke their sessions.",
	AccountsLoginEmailUpdate:           "Change an account login email and revoke sessions.",
	AccountsPasswordSet:                "Administratively set an account password.",
	AccountsPasswordReset:              "Issue one-time account password reset links.",
	AccountsPasswordEnrollSelf:         "Enroll a password method for the current account.",
	AccountsPasswordEnrollAll:          "Invite or enroll password methods for any account.",
	AccountsPasswordRemoveSelf:         "Remove the current account's password method.",
	AccountsPasswordRemoveAll:          "Remove another account's password method and revoke its sessions.",
	AccountsPINEnrollSelf:              "Enroll or replace the current account's PIN method.",
	AccountsPINEnrollAll:               "Configure or issue PIN enrollment for any account.",
	AccountsPINRemoveSelf:              "Remove the current account's PIN method.",
	AccountsPINRemoveAll:               "Remove another account's PIN method and revoke its sessions.",
	AccountsPINReset:                   "Replace or issue a one-time PIN setup challenge for another account.",
	AccountsMFAReset:                   "Remove every second factor of another account (a master account's only by a master).",
	PeopleRolesAssign:                  "Assign or remove permitted roles on people.",
	RolesRead:                          "Read roles and the application permission registry.",
	RolesManage:                        "Create, update, and delete permitted configurable roles.",
	AuditRead:                          "Read privacy-minimized audit events.",
	OpenDaysRead:                       "Read visible Open Day periods and staffing summaries.",
	OpenDaysReadAssignments:            "Read the identities assigned to Open Days.",
	OpenDaysSignup:                     "Sign up for and leave eligible Open Day assignments.",
	OpenDaysAssign:                     "Assign and remove eligible people on Open Days.",
	OpenDaysManage:                     "Manage Open Day periods, schedules, calendar context, and lifecycle.",
	EventsRead:                         "Read confirmed and past Events with their programme, planning data, files, and staffing counts; drafts need an organizer permission.",
	EventsManage:                       "Create and manage Events including drafts, lifecycle, publication, schedules, planning, and files.",
	EventsStaffingManage:               "Manage Event shifts, staffing requirements, eligibility, and staffing identities; see drafts.",
	EventsAssign:                       "Create, move, cancel, link, and conflict-override Event assignments; see drafts.",
	EventsSignup:                       "Join and leave open places in confirmed Events for yourself.",
	EventsReadAssignments:              "Read the names (not contact details) of the helpers in each Event shift.",
	ManagedDevicesRead:                 "Read managed devices and device types.",
	ManagedDevicesManage:               "Create, edit, revoke, rotate, and delete managed devices and device types.",
	SessionPoliciesManage:              "Create and change reusable server-enforced session policies.",
	AttendanceRead:                     "Read identified visit and current-presence records.",
	AttendanceAssist:                   "Check people in or out through a supervised attendance flow.",
	AttendanceCorrect:                  "Correct or void attendance records.",
	AttendanceStatisticsRead:           "Read attendance statistics and visitor-hour reports.",
	SurveysRead:                        "Read survey definitions and summarized responses.",
	SurveysManage:                      "Build, publish, close, and trigger surveys.",
	LaborordnungRead:                   "Read Lab Rules versions and exact PDFs.",
	LaborordnungManage:                 "Upload and publish immutable Lab Rules versions.",
	LaborordnungRequestsRead:           "Read the physical-document confirmation queue.",
	LaborordnungConfirm:                "Confirm physical Lab Rules evidence.",
	VisitorEnrollmentManage:            "Configure controlled visitor-kiosk enrollment.",
	SupervisorDashboardRead:            "Read the privacy-minimized supervisor dashboard.",
	OIDCLinkSelf:                       "Link an OIDC identity to the current Account after recent password or OIDC reauthentication.",
	OIDCLinkAll:                        "Reserved for a future administrative ownership-proof flow; no operation currently supports this permission.",
	OIDCUnlinkSelf:                     "Unlink an OIDC identity from the current Account.",
	OIDCUnlinkAll:                      "Unlink an OIDC identity from another Account.",
	OIDCManage:                         "Manage OIDC providers and trusted ACR mappings.",
	SCIMManage:                         "Manage SCIM connectors and one-time bearer tokens.",
	MailManage:                         "Configure transactional SMTP delivery and sender identity.",
	BrandingManage:                     "Manage public organization identity, branding, and legal notices.",
	InvoicingSettingsManage:            "Configure the delivery of approved invoice requests to wiRef: recipient, mail and PDF templates.",
	MachinesRead:                       "Read machine types, machines, and their operational metrics.",
	MachinesManage:                     "Create and update machine types and machines.",
	TrainingsManage:                    "Create, update and deactivate trainings and the competency categories they feed.",
	TrainingRecordsReadSelf:            "Read the training records of the person linked to the current account.",
	TrainingRecordsReadAll:             "Read every person's training records, including internal notes.",
	TrainingRecordsUpdate:              "Set another person's training status and read every person's records.",
	TrainingRecordsUpdateSelf:          "Set the own training status and read the own records including internal notes.",
	MachineJobsRead:                    "Read machine jobs and their pricing and usage details.",
	MachineJobsCreate:                  "Create manual jobs and ingest automatically detected jobs.",
	MachineJobsEdit:                    "Correct confirmed machine-job facts and material usage.",
	MachineJobsOverridePrice:           "Set and clear final machine-job price overrides.",
	MachineJobsDelete:                  "Delete machine jobs and runs, optionally restoring their consumed material.",
	InventoryRead:                      "Read materials, balances, valuation, and inventory history.",
	InventoryManage:                    "Create materials and record purchases, consumption, corrections, and disposal.",
	FilamentSpoolsManage:               "Manage physical filament spool records and identifiers.",
	PrinterSlotsAssign:                 "Mount, unmount, and move filament spools in printer slots.",
	PrinterConnectorsRead:              "Read printer connector identity, status, assignments, and diagnostics.",
	PrinterConnectorsManage:            "Create and configure printer connectors and printer assignments.",
	PrinterConnectorsCredentialsManage: "Issue enrollment credentials and revoke printer connector access.",
	PrintArtifactsRead:                 "Read protected print artifact metadata, previews, and original archived files.",
	OrganizationsRead:                  "Read organizations usable as billing parties.",
	OrganizationsManage:                "Create and update organizations.",
	PricingRead:                        "Read pricing groups, rules, and billing-party defaults.",
	PricingManage:                      "Create and update pricing groups, rules, and billing-party defaults.",
	StatisticsRead:                     "Read machine-logbook operational and financial statistics.",
	SignageRead:                        "Read digital signage displays, health, content, media, rules, and announcements.",
	SignageManage:                      "Pair, rename, revoke, and delete signage displays; edit their rules, default playlist, and settings.",
	SignageContentManage:               "Create, edit, and delete signage scenes, playlists, media assets, and announcement templates.",
	SignagePublish:                     "Publish a signage display so its player receives the current content.",
	SignageOverride:                    "Start, edit, and stop signage announcements.",
	LocalServicesManage:                "Manage local streaming gateways and camera assignments and issue their enrollment secrets.",
	ConfigurationExport:                "Download configuration sections as a file; each section also needs its own read permission.",
	ConfigurationImport:                "Preview and import configuration files; each section also needs its own read and manage permissions.",
	NotificationsSend:                  "Send in-app messages to roles and see sent messages.",
	PrivacyRead:                        "Read the privacy registry: data categories, their owners, status and the privacy settings.",
	PrivacySettingsManage:              "Change the installation's privacy settings (controller, contact, automatic retention runs).",
	PrivacyPoliciesManage:              "Create, approve, activate and retire retention policies and place or release holds.",
	PrivacyRetentionExecute:            "Start retention dry runs and executions.",
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

// Bounds of a grant's fresh-sign-in window.
const (
	MinReauthWithinMinutes = 1
	MaxReauthWithinMinutes = 1440
)

type PermissionGrant struct {
	ID               uuid.UUID
	PermissionID     Permission
	Scope            GrantScope
	DeviceTypeIDs    []uuid.UUID
	MinimumAssurance Assurance
	// ReauthWithinMinutes, when set, requires that the session's last (re)authentication at MinimumAssurance is at
	// most this many minutes old. A shorter window is stricter.
	ReauthWithinMinutes *int
}

// ReauthenticationRequirement is what a fresh sign-in must prove for a withheld permission.
type ReauthenticationRequirement struct {
	Assurance     Assurance
	WithinMinutes int
}

// PendingPermission is a permission that a grant (or the master policy) would allow after a fresh sign-in.
type PendingPermission struct {
	Permission  Permission
	Requirement ReauthenticationRequirement
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
	Assurance       Assurance
	AuthenticatedAt time.Time
	// AuthenticatedAssurance is the assurance proven at AuthenticatedAt; empty means Assurance.
	AuthenticatedAssurance Assurance
	// Master is the effective master bypass: the account holds the master role and the session has strong_mfa
	// assurance. A master session below strong_mfa only gets what its other roles grant.
	Master bool
	// HoldsMasterRole reports the role assignment regardless of the session's assurance.
	HoldsMasterRole bool
	permissions     map[Permission]struct{}
	grants          map[Permission][]PermissionGrant
	pending         map[Permission]ReauthenticationRequirement
	denials         *reauthenticationDenials
	Device          *ManagedDevice
}

// reauthenticationDenials records, for one request, the permission checks that failed only because a fresh sign-in
// is missing. Principal values are copied freely; they share this pointer, so the HTTP layer can turn the
// resulting permission_denied into reauthentication_required.
type reauthenticationDenials struct {
	mu          sync.Mutex
	permissions []Permission
	easiest     *ReauthenticationRequirement
}

func (d *reauthenticationDenials) record(permission Permission, requirement ReauthenticationRequirement) {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.permissions = append(d.permissions, permission)
	if d.easiest == nil || easierRequirement(requirement, *d.easiest) {
		value := requirement
		d.easiest = &value
	}
}

// easierRequirement prefers the lower assurance, then the longer window.
func easierRequirement(candidate, current ReauthenticationRequirement) bool {
	if assuranceRank(candidate.Assurance) != assuranceRank(current.Assurance) {
		return assuranceRank(candidate.Assurance) < assuranceRank(current.Assurance)
	}
	return candidate.WithinMinutes > current.WithinMinutes
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

// Has reports whether the permission is effective. A permission withheld only for a missing fresh sign-in is
// recorded so the denial can be reported as reauthentication_required.
func (p Principal) Has(permission Permission) bool {
	if !Known(permission) {
		return false
	}
	if _, ok := p.permissions[permission]; ok {
		return true
	}
	if requirement, pending := p.pending[permission]; pending {
		p.denials.record(permission, requirement)
		return false
	}
	return p.Master
}

func (p Principal) PermissionIDs() []string {
	set := make(map[Permission]struct{}, len(p.permissions))
	for permission := range p.permissions {
		set[permission] = struct{}{}
	}
	if p.Master {
		for _, permission := range registry {
			if _, pending := p.pending[permission]; !pending {
				set[permission] = struct{}{}
			}
		}
	}
	result := make([]string, 0, len(set))
	for permission := range set {
		result = append(result, string(permission))
	}
	sort.Strings(result)
	return result
}

// PendingPermissions lists the permissions withheld until a fresh sign-in, sorted by permission.
func (p Principal) PendingPermissions() []PendingPermission {
	result := make([]PendingPermission, 0, len(p.pending))
	for permission, requirement := range p.pending {
		result = append(result, PendingPermission{Permission: permission, Requirement: requirement})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Permission < result[j].Permission })
	return result
}

// ReauthenticationDenial returns the easiest fresh sign-in that would have allowed a permission check of this
// request that failed, if any failed for that reason.
func (p Principal) ReauthenticationDenial() (ReauthenticationRequirement, bool) {
	if p.denials == nil {
		return ReauthenticationRequirement{}, false
	}
	p.denials.mu.Lock()
	defer p.denials.mu.Unlock()
	if p.denials.easiest == nil {
		return ReauthenticationRequirement{}, false
	}
	return *p.denials.easiest, true
}

func (p Principal) CanReadPerson(personID uuid.UUID) bool {
	return p.Has(PeopleReadAll) || (p.PersonID == personID && p.Has(PeopleReadSelf))
}

func (p Principal) CanUpdatePerson(personID uuid.UUID) bool {
	return p.Has(PeopleUpdateAll) || (p.PersonID == personID && p.Has(PeopleUpdateSelf))
}

// ProofAssurance is the assurance proven by the session's last (re)authentication.
func (p Principal) ProofAssurance() Assurance {
	if validAssurance(p.AuthenticatedAssurance) {
		return p.AuthenticatedAssurance
	}
	return p.Assurance
}

// HasFreshAssurance reports whether the session currently has at least minimum assurance and its last
// (re)authentication proved at least minimum within maximumAge.
func (p Principal) HasFreshAssurance(minimum Assurance, maximumAge time.Duration, now time.Time) bool {
	return assuranceRank(p.Assurance) >= assuranceRank(minimum) &&
		freshProof(p.ProofAssurance(), p.AuthenticatedAt, minimum, maximumAge, now)
}

func freshProof(proof Assurance, authenticatedAt time.Time, minimum Assurance, maximumAge time.Duration, now time.Time) bool {
	if !validAssurance(minimum) || assuranceRank(proof) < assuranceRank(minimum) || authenticatedAt.IsZero() {
		return false
	}
	age := now.UTC().Sub(authenticatedAt.UTC())
	return age >= 0 && age <= maximumAge
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
	principal.HoldsMasterRole = false
	if !validAssurance(principal.Assurance) {
		principal.Assurance = AssuranceNormal
	}
	if principal.denials == nil {
		principal.denials = &reauthenticationDenials{}
	}
	principal.permissions = make(map[Permission]struct{})
	principal.grants = make(map[Permission][]PermissionGrant)
	principal.pending = make(map[Permission]ReauthenticationRequirement)
	byID := make(map[uuid.UUID]PermissionGrant)
	order := make([]uuid.UUID, 0)
	for _, row := range rows {
		if row.SystemKey != nil && SystemKey(*row.SystemKey) == SystemKeyMaster {
			principal.HoldsMasterRole = true
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
			grant = PermissionGrant{
				ID:               *row.GrantID,
				PermissionID:     permission,
				Scope:            rowScope,
				MinimumAssurance: minimum,
			}
			if row.ReauthWithinMinutes != nil {
				window := int(*row.ReauthWithinMinutes)
				grant.ReauthWithinMinutes = &window
			}
			order = append(order, *row.GrantID)
		}
		if row.DeviceTypeID != nil {
			grant.DeviceTypeIDs = appendUniqueUUID(grant.DeviceTypeIDs, *row.DeviceTypeID)
		}
		byID[*row.GrantID] = grant
	}
	now := time.Now()
	for _, id := range order {
		grant := byID[id]
		principal.grants[grant.PermissionID] = append(principal.grants[grant.PermissionID], grant)
		if !principal.grantApplies(grant) {
			continue
		}
		if principal.fresh(grant.MinimumAssurance, grant.ReauthWithinMinutes, now) {
			principal.permissions[grant.PermissionID] = struct{}{}
			continue
		}
		principal.addPending(grant.PermissionID, ReauthenticationRequirement{
			Assurance: grant.MinimumAssurance, WithinMinutes: *grant.ReauthWithinMinutes,
		})
	}
	// The master role's universal permissions need a multi-factor session; below that, the account only has what
	// its other roles grant.
	if principal.HoldsMasterRole && assuranceRank(principal.Assurance) >= assuranceRank(AssuranceStrongMFA) {
		principal.Master = true
		policy, err := queries.ListMasterReauthenticationPermissions(ctx)
		if err != nil {
			return Principal{}, err
		}
		windows := make(map[Permission]int, len(policy))
		for _, entry := range policy {
			windows[Permission(entry.PermissionID)] = int(entry.WithinMinutes)
		}
		for _, permission := range registry {
			window, restricted := windows[permission]
			if restricted && !principal.fresh(AssuranceStrongMFA, &window, now) {
				principal.addPending(permission, ReauthenticationRequirement{
					Assurance: AssuranceStrongMFA, WithinMinutes: window,
				})
				continue
			}
			principal.permissions[permission] = struct{}{}
		}
	}
	for permission := range principal.permissions {
		delete(principal.pending, permission)
	}
	return principal, nil
}

func (p Principal) addPending(permission Permission, requirement ReauthenticationRequirement) {
	if current, exists := p.pending[permission]; !exists || easierRequirement(requirement, current) {
		p.pending[permission] = requirement
	}
}

func (p Principal) fresh(minimum Assurance, withinMinutes *int, now time.Time) bool {
	if withinMinutes == nil {
		return true
	}
	return freshProof(p.ProofAssurance(), p.AuthenticatedAt, minimum, time.Duration(*withinMinutes)*time.Minute, now)
}

// grantApplies evaluates scope and assurance of a grant for this principal, without its fresh-sign-in window.
func (p Principal) grantApplies(grant PermissionGrant) bool {
	var deviceTypeID *uuid.UUID
	if p.Device != nil {
		deviceTypeID = &p.Device.DeviceTypeID
	}
	return GrantEffective(grant, EvaluationContext{Assurance: p.Assurance, DeviceTypeID: deviceTypeID})
}

// EffectivePermissions resolves a configured grant set for a hypothetical
// request context. It intentionally shares GrantEffective with live Principal
// authorization so administrative previews cannot drift from enforcement. A grant that requires a fresh sign-in is
// listed as if that sign-in had just happened.
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

// GrantEffective reports whether one grant applies in the supplied context, apart from its fresh-sign-in window.
// Invalid grant data and invalid assurance values fail closed.
func GrantEffective(grant PermissionGrant, evaluation EvaluationContext) bool {
	if !Known(grant.PermissionID) || !validGrantScope(grant.Scope) ||
		!validAssurance(grant.MinimumAssurance) || !validAssurance(evaluation.Assurance) ||
		!ValidReauthWindow(grant.ReauthWithinMinutes) {
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

// ReauthWindowFromDB converts a stored fresh-sign-in window.
func ReauthWindowFromDB(value *int32) *int {
	if value == nil {
		return nil
	}
	window := int(*value)
	return &window
}

// ValidReauthWindow accepts no window or one within the allowed bounds.
func ValidReauthWindow(window *int) bool {
	return window == nil || (*window >= MinReauthWithinMinutes && *window <= MaxReauthWithinMinutes)
}

func (p Principal) DelegablePermissionGrants() []PermissionGrant {
	if p.Master {
		result := make([]PermissionGrant, 0, len(registry))
		for _, v := range Registry() {
			result = append(
				result,
				PermissionGrant{PermissionID: v, Scope: GrantEverywhere, MinimumAssurance: AssuranceLow},
			)
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
	if !validAssurance(grant.MinimumAssurance) || !ValidReauthWindow(grant.ReauthWithinMinutes) {
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

// grantCoveredBy treats the fresh-sign-in window as part of the assurance envelope: a delegated grant may not drop
// or lengthen the window of the grant it is derived from.
func grantCoveredBy(envelope, requested PermissionGrant, selectedType uuid.UUID) bool {
	if !validGrantScope(envelope.Scope) || !validAssurance(envelope.MinimumAssurance) ||
		assuranceRank(envelope.MinimumAssurance) > assuranceRank(requested.MinimumAssurance) {
		return false
	}
	if envelope.ReauthWithinMinutes != nil &&
		(requested.ReauthWithinMinutes == nil || *requested.ReauthWithinMinutes > *envelope.ReauthWithinMinutes) {
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

// AtLeast reports whether value is at least minimum in the assurance order.
func AtLeast(value, minimum Assurance) bool {
	return validAssurance(value) && validAssurance(minimum) && assuranceRank(value) >= assuranceRank(minimum)
}

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
