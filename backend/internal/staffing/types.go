package staffing

import (
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
)

// Status is where a person stands against the semester requirements.
type Status string

const (
	// StatusFulfilled means staffed plus booked open days reach the minimum (being signed up is enough).
	StatusFulfilled Status = "fulfilled"
	// StatusMissing means the minimum is not reached even with sign-ups.
	StatusMissing Status = "missing"
	// StatusReady means a trainee staffed enough open days as trainee; the Leitung promotes by hand.
	StatusReady Status = "ready"
)

// Requirements are the editable semester requirements.
type Requirements struct {
	MinOpenDaysPerSemester      int
	TraineeOpenDaysForPromotion int
	SupervisorRoleID            *uuid.UUID
	Version                     int64
	UpdatedAt                   time.Time
}

// Semester is an open-day period seen as a semester. Dates are calendar dates at UTC midnight.
type Semester struct {
	ID       uuid.UUID
	Name     string
	StartsOn time.Time
	EndsOn   time.Time
}

// Counts are a person's open days in one semester.
type Counts struct {
	// Staffed are ended open days, in any place.
	Staffed int
	// Booked are upcoming open days, in any place.
	Booked int
	// StaffedAsTrainee are the ended open days staffed in a trainee place.
	StaffedAsTrainee int
}

// Standing is the evaluated status with the number of open days still missing.
type Standing struct {
	Status  Status
	Missing int
}

// UpdateInput replaces the requirements settings.
type UpdateInput struct {
	ExpectedVersion             int64
	MinOpenDaysPerSemester      int
	TraineeOpenDaysForPromotion int
	SupervisorRoleID            *uuid.UUID
}

// Limits of the settings, mirrored by the table constraints.
const (
	MaxOpenDaysPerSemester = 20
)

// KindOf derives a person's staffing kind from the staffing levels of their roles: supervisor wins over trainee,
// nil means the person does not staff.
func KindOf(levels []roles.StaffingLevel) *roles.StaffingLevel {
	var kind *roles.StaffingLevel
	for _, level := range levels {
		switch level {
		case roles.StaffingSupervisor:
			supervisor := roles.StaffingSupervisor
			return &supervisor
		case roles.StaffingTrainee:
			trainee := roles.StaffingTrainee
			kind = &trainee
		}
	}
	return kind
}

// StatusFor evaluates counts against the requirements.
func StatusFor(kind roles.StaffingLevel, counts Counts, requirements Requirements) Standing {
	if kind == roles.StaffingTrainee && counts.StaffedAsTrainee >= requirements.TraineeOpenDaysForPromotion {
		return Standing{Status: StatusReady}
	}
	if counts.Staffed+counts.Booked >= requirements.MinOpenDaysPerSemester {
		return Standing{Status: StatusFulfilled}
	}
	return Standing{Status: StatusMissing, Missing: requirements.MinOpenDaysPerSemester - counts.Staffed - counts.Booked}
}
