package events

import (
	"time"

	"github.com/google/uuid"
)

// EventStatus is where an event stands in its lifecycle. Drafts are visible to organizers only; completed and
// cancelled events are closed.
type EventStatus string

const (
	EventStatusDraft     EventStatus = "draft"
	EventStatusConfirmed EventStatus = "confirmed"
	EventStatusCompleted EventStatus = "completed"
	EventStatusCancelled EventStatus = "cancelled"
)

// Closed reports whether the event is completed or cancelled: details, programme and helpers are read-only then.
func (s EventStatus) Closed() bool {
	return s == EventStatusCompleted || s == EventStatusCancelled
}

// SessionStatus is whether an event session takes place.
type SessionStatus string

const (
	SessionStatusScheduled SessionStatus = "scheduled"
	SessionStatusCancelled SessionStatus = "cancelled"
)

// TaskStatus is whether an event task is still to do.
type TaskStatus string

const (
	TaskStatusOpen TaskStatus = "open"
	TaskStatusDone TaskStatus = "done"
)

// ShiftStatus is whether a staffing shift accepts signups.
type ShiftStatus string

const (
	ShiftStatusDraft     ShiftStatus = "draft"
	ShiftStatusOpen      ShiftStatus = "open"
	ShiftStatusClosed    ShiftStatus = "closed"
	ShiftStatusCancelled ShiftStatus = "cancelled"
)

// EligibilityMode is who may fill a staffing requirement.
type EligibilityMode string

const (
	EligibilityAnyone EligibilityMode = "anyone"
	EligibilityRoles  EligibilityMode = "roles"
)

// RequirementAvailability is whether the public can still sign up for a requirement.
type RequirementAvailability string

const (
	AvailabilityAvailable         RequirementAvailability = "available"
	AvailabilityFull              RequirementAvailability = "full"
	AvailabilityAuthenticatedOnly RequirementAvailability = "authenticated_only"
	AvailabilityNotOpen           RequirementAvailability = "not_open"
)

// ReadinessCode names a requirement for confirming, publishing or opening helper signup that is not met yet.
type ReadinessCode string

const (
	ReadinessEventClosed          ReadinessCode = "event_closed"
	ReadinessEventNotConfirmed    ReadinessCode = "event_not_confirmed"
	ReadinessOwnerMissing         ReadinessCode = "owner_missing"
	ReadinessProgrammeMissing     ReadinessCode = "programme_missing"
	ReadinessPublicTitleMissing   ReadinessCode = "public_title_missing"
	ReadinessPublicContentMissing ReadinessCode = "public_content_missing"
	ReadinessPublicPageOff        ReadinessCode = "public_page_off"
	ReadinessSignupDisabled       ReadinessCode = "signup_disabled"
	ReadinessNoPublicOpenShift    ReadinessCode = "no_public_open_shift"
)

// PublicPageState is whether the public event page is reachable.
type PublicPageState string

const (
	PublicPageOff  PublicPageState = "off"
	PublicPageLive PublicPageState = "live"
)

// HelperSignupState is whether the public accepts helper signups right now.
type HelperSignupState string

const (
	HelperSignupOff     HelperSignupState = "off"
	HelperSignupOpen    HelperSignupState = "open"
	HelperSignupOpensAt HelperSignupState = "opens_at"
	HelperSignupClosed  HelperSignupState = "closed"
)

// GoLive is the derived readiness of an event for the public page and helper signup.
type GoLive struct {
	PublicPageState   PublicPageState
	PublicPageUnmet   []ReadinessCode
	HelperSignupState HelperSignupState
	HelperSignupOpens *time.Time
	HelperSignupUnmet []ReadinessCode
	ShiftsAccepting   int
	ShiftsTotal       int
	ShiftsNotPublic   int
	ConfirmUnmet      []ReadinessCode
}

// AssignmentStatus is whether a signup still counts.
type AssignmentStatus string

const (
	AssignmentStatusActive    AssignmentStatus = "active"
	AssignmentStatusCancelled AssignmentStatus = "cancelled"
)

// AssignmentSource is how a signup came about.
type AssignmentSource string

const (
	SourcePublicSignup          AssignmentSource = "public_signup"
	SourceStaffEntry            AssignmentSource = "staff_entry"
	SourceAuthenticatedSelf     AssignmentSource = "authenticated_self"
	SourceAuthenticatedOnBehalf AssignmentSource = "authenticated_on_behalf"
)

// SignupFor is whom an authenticated public signup is for.
type SignupFor string

const (
	SignupForSelf  SignupFor = "self"
	SignupForOther SignupFor = "other"
)

// FileVisibility is who may download an event file.
type FileVisibility string

const (
	FileVisibilityInternal FileVisibility = "internal"
	FileVisibilityPublic   FileVisibility = "public"
)

type Event struct {
	ID                   uuid.UUID
	Name                 string
	InternalDescription  *string
	Location             *string
	OwnerPersonID        *uuid.UUID
	Status               EventStatus
	PublicTitle          *string
	PublicDescription    *string
	PublicLocation       *string
	PublicID             string
	IsPublic             bool
	PublicSignupEnabled  bool
	HasBanner            bool
	ClosedAt             *time.Time
	Version              int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
	RangeStartsAt        *time.Time
	RangeEndsAt          *time.Time
	TaskTotal            int64
	TaskCompleted        int64
	TasksOverdue         int64
	FilledCount          int64
	RequiredCount        int64
	HasAssignmentHistory bool
	OpenPlaces           int64
	GoLive               GoLive
	// MyShifts are the requesting person's own active assignments.
	MyShifts       []MyAssignment
	NextDeadline   *time.Time
	NextScheduleAt *time.Time
	OwnerName      *string
}

type EventInput struct {
	Name                string
	InternalDescription *string
	Location            *string
	OwnerPersonID       *uuid.UUID
	PublicTitle         *string
	PublicDescription   *string
	PublicLocation      *string
	PublicSignupEnabled bool
	ExpectedVersion     int64
}

type Session struct {
	ID, EventID          uuid.UUID
	Name, Location       *string
	Description          *string
	StartsAt, EndsAt     time.Time
	IsPublic             bool
	Status               SessionStatus
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type SessionInput struct {
	Name, Location, Description *string
	StartsAt, EndsAt            time.Time
	IsPublic                    bool
	Status                      SessionStatus
	ExpectedVersion             int64
}

type TaskList struct {
	ID, EventID          uuid.UUID
	Name                 string
	Description          *string
	SortOrder            int
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type TaskListInput struct {
	Name            string
	Description     *string
	SortOrder       int
	ExpectedVersion int64
}

type Task struct {
	ID, EventID          uuid.UUID
	TaskListID           *uuid.UUID
	Title                string
	Description          *string
	Status               TaskStatus
	Important            bool
	AssigneePersonID     *uuid.UUID
	DueAt, CompletedAt   *time.Time
	CompletedByAccount   *uuid.UUID
	SortOrder            int
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type TaskInput struct {
	TaskListID       *uuid.UUID
	Title            string
	Description      *string
	Status           TaskStatus
	Important        bool
	AssigneePersonID *uuid.UUID
	DueAt            *time.Time
	SortOrder        int
	ExpectedVersion  int64
}

// TaskFilter narrows a task list. A zero filter excludes done tasks; callers that want them set IncludeDone.
type TaskFilter struct {
	Mine, Overdue, IncludeDone bool
}

type Shift struct {
	ID, EventID                   uuid.UUID
	SessionID                     *uuid.UUID
	Name                          string
	Description                   *string
	StartsAt, EndsAt              time.Time
	SignupOpensAt, SignupClosesAt *time.Time
	IsPublic                      bool
	Status                        ShiftStatus
	LinkedSessionStatus           *SessionStatus
	Version                       int64
	CreatedAt, UpdatedAt          time.Time
}

type ShiftInput struct {
	SessionID                     *uuid.UUID
	Name                          string
	Description                   *string
	StartsAt, EndsAt              time.Time
	SignupOpensAt, SignupClosesAt *time.Time
	IsPublic                      bool
	Status                        ShiftStatus
	ExpectedVersion               int64
}

type Requirement struct {
	ID, EventID, ShiftID uuid.UUID
	Name                 string
	Description          *string
	RequiredCount        int
	FilledCount          int
	EligibilityMode      EligibilityMode
	EligibleRoleIDs      []uuid.UUID
	Availability         RequirementAvailability
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type RequirementInput struct {
	Name            string
	Description     *string
	RequiredCount   int
	EligibilityMode EligibilityMode
	EligibleRoleIDs []uuid.UUID
	ExpectedVersion int64
}

type Assignment struct {
	ID, EventID, ShiftID, RequirementID uuid.UUID
	PublicID                            string
	PersonID                            *uuid.UUID
	FirstName, LastName                 *string
	Email, Phone                        *string
	Source                              AssignmentSource
	Status                              AssignmentStatus
	ConflictOverriddenByAccountID       *uuid.UUID
	CancelledAt, PersonalDataErasedAt   *time.Time
	Version                             int64
	CreatedAt, UpdatedAt                time.Time
}

type AssignmentInput struct {
	ShiftID, RequirementID uuid.UUID
	PersonID               *uuid.UUID
	FirstName, LastName    string
	Email, Phone           *string
	OverrideConflict       bool
}

type AssignmentUpdateInput struct {
	FirstName, LastName string
	Email, Phone        *string
	FirstNameSet        bool
	LastNameSet         bool
	EmailSet            bool
	PhoneSet            bool
	ShiftID             *uuid.UUID
	RequirementID       *uuid.UUID
	ExpectedVersion     int64
	OverrideConflict    bool
}

type SignupResult struct {
	Assignment    Assignment
	ManagementURL *string
}

type PublicEvent struct {
	PublicID            string
	Title               string
	Description         *string
	Location            *string
	Status              EventStatus
	TimeZone            string
	PublicSignupEnabled bool
	HasBanner           bool
	Sessions            []Session
	Shifts              []PublicShift
	Files               []EventFile
}

type PublicShift struct {
	Shift
	Requirements []Requirement
}

type EventFile struct {
	ID, EventID, FileID  uuid.UUID
	Description          *string
	Visibility           FileVisibility
	IsBanner             bool
	OriginalFilename     string
	ContentType          string
	SizeBytes            int64
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type Role struct {
	ID   uuid.UUID
	Name string
}
type PersonOption struct {
	ID                  uuid.UUID
	FirstName, LastName string
	Email, Phone        *string
}

// ListScope selects which events a list shows; see ListEvents.
type ListScope string

const (
	ListScopeUpcoming ListScope = "upcoming"
	ListScopeDrafts   ListScope = "drafts"
	ListScopePast     ListScope = "past"
)

// List paging limits shared with the HTTP layer.
const (
	DefaultListPageSize = 25
	MaxListPageSize     = 100
	maxSearchLength     = 200
)

// ListQuery filters and pages the event list.
type ListQuery struct {
	Scope         ListScope
	Search        string
	OwnerPersonID *uuid.UUID
	Page          int
	PageSize      int
}

// EventPage is one page of events and the number of matching events.
type EventPage struct {
	Items          []Event
	Page, PageSize int
	Total          int64
}

// LeaveBlock says why a helper cannot leave an own assignment.
type LeaveBlock string

const (
	LeaveBlockEventClosed LeaveBlock = "event_closed"
	LeaveBlockShiftEnded  LeaveBlock = "shift_ended"
)

// MyAssignment is one of the requesting person's own active assignments.
type MyAssignment struct {
	AssignmentID, ShiftID, RequirementID uuid.UUID
	ShiftName, RequirementName           string
	StartsAt, EndsAt                     time.Time
	ShiftStatus                          ShiftStatus
	Version                              int64
	// LeaveBlocked is empty when the person may leave.
	LeaveBlocked LeaveBlock
}

// JoinReason says why the requesting person cannot join a position.
type JoinReason string

const (
	JoinReasonNoPermission  JoinReason = "no_permission"
	JoinReasonClosed        JoinReason = "closed"
	JoinReasonNotOpen       JoinReason = "not_open"
	JoinReasonOpensAt       JoinReason = "opens_at"
	JoinReasonAlreadyJoined JoinReason = "already_joined"
	JoinReasonFull          JoinReason = "full"
	JoinReasonRolesOnly     JoinReason = "roles_only"
)

// ParticipationHelper is a co-helper as members see them: a name only.
type ParticipationHelper struct {
	// DisplayName is nil when the personal data was erased.
	DisplayName *string
	IsMe        bool
}

// ParticipationPosition is a position as the participant view shows it.
type ParticipationPosition struct {
	ID                         uuid.UUID
	Name                       string
	Description                *string
	RequiredCount, FilledCount int
	MyAssignmentID             *uuid.UUID
	Joinable                   bool
	// Reason is empty when Joinable.
	Reason    JoinReason
	OpensAt   *time.Time
	RoleNames []string
	// Helpers is nil without permission to see names.
	Helpers []ParticipationHelper
}

// ParticipationShift is a shift of the participant view with its positions.
type ParticipationShift struct {
	Shift
	Positions []ParticipationPosition
}

// Participation is the helper view of one event.
type Participation struct {
	EventID       uuid.UUID
	Status        EventStatus
	CanSignup     bool
	CanSeeNames   bool
	MyAssignments []MyAssignment
	Sessions      []Session
	Shifts        []ParticipationShift
}
