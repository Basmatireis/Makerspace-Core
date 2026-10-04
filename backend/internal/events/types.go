package events

import (
	"time"

	"github.com/google/uuid"
)

type Event struct {
	ID                  uuid.UUID
	Name                string
	InternalDescription *string
	Location            *string
	OwnerPersonID       *uuid.UUID
	Status              string
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
	Status               string
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type SessionInput struct {
	Name, Location, Description *string
	StartsAt, EndsAt            time.Time
	IsPublic                    bool
	Status                      string
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
	Status, Priority     string
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
	Status, Priority string
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
	Status                        string
	LinkedSessionStatus           *string
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
	Status                        string
	ExpectedVersion               int64
}

type Requirement struct {
	ID, EventID, ShiftID uuid.UUID
	Name                 string
	Description          *string
	RequiredCount        int
	FilledCount          int
	EligibilityMode      string
	EligibleRoleIDs      []uuid.UUID
	Availability         string
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type RequirementInput struct {
	Name            string
	Description     *string
	RequiredCount   int
	EligibilityMode string
	EligibleRoleIDs []uuid.UUID
	ExpectedVersion int64
}

type Assignment struct {
	ID, EventID, ShiftID, RequirementID uuid.UUID
	PublicID                            string
	PersonID                            *uuid.UUID
	FirstName, LastName                 *string
	Email, Phone                        *string
	Source, Status                      string
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
	Status              string
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
	Visibility           string
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
