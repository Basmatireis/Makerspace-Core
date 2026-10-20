package events

import (
	"time"

	"github.com/google/uuid"
)

// EventStatus is where an event stands in its lifecycle.
type EventStatus string

const (
	EventStatusDraft     EventStatus = "draft"
	EventStatusPlanning  EventStatus = "planning"
	EventStatusConfirmed EventStatus = "confirmed"
	EventStatusCompleted EventStatus = "completed"
	EventStatusCancelled EventStatus = "cancelled"
	EventStatusArchived  EventStatus = "archived"
)

// SessionStatus is whether an event session takes place.
type SessionStatus string

const (
	SessionStatusScheduled SessionStatus = "scheduled"
	SessionStatusCancelled SessionStatus = "cancelled"
)

// TaskStatus is how far an event task has progressed.
type TaskStatus string

const (
	TaskStatusOpen       TaskStatus = "open"
	TaskStatusInProgress TaskStatus = "in_progress"
	TaskStatusBlocked    TaskStatus = "blocked"
	TaskStatusDone       TaskStatus = "done"
	TaskStatusCancelled  TaskStatus = "cancelled"
)

// TaskPriority is how urgent an event task is.
type TaskPriority string

const (
	TaskPriorityLow    TaskPriority = "low"
	TaskPriorityNormal TaskPriority = "normal"
	TaskPriorityHigh   TaskPriority = "high"
	TaskPriorityUrgent TaskPriority = "urgent"
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
	ID                  uuid.UUID
	Name                string
	InternalDescription *string
	Location            *string
	OwnerPersonID       *uuid.UUID
	Status              EventStatus
	PublicTitle         *string
	PublicDescription   *string
	PublicLocation      *string
	PublicID            string
	IsPublic            bool
	PublicSignupEnabled bool
	HasBanner           bool
	ClosedAt            *time.Time
	Version             int64
	CreatedAt           time.Time
	UpdatedAt           time.Time
	RangeStartsAt       *time.Time
	RangeEndsAt         *time.Time
	TaskTotal           int64
	TaskCompleted       int64
	FilledCount         int64
	RequiredCount       int64
	NextDeadline        *time.Time
	NextScheduleAt      *time.Time
	OwnerName           *string
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
	Priority             TaskPriority
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
	Priority         TaskPriority
	AssigneePersonID *uuid.UUID
	DueAt            *time.Time
	SortOrder        int
	ExpectedVersion  int64
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
