package staffing

import (
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
)

// Status is where a person stands against the semester rules.
type Status string

const (
	// StatusFulfilled means staffed plus booked open days reach the minimum (being signed up is enough).
	StatusFulfilled Status = "fulfilled"
	// StatusMissing means the minimum is not reached even with sign-ups.
	StatusMissing Status = "missing"
	// StatusReady means a trainee staffed enough open days as trainee; the Leitung changes the membership by hand.
	StatusReady Status = "ready"
	// StatusExcused means the person is excused for the semester and has no minimum in it.
	StatusExcused Status = "excused"
	// StatusNoMinimum means the person's minimum is zero without an excusal.
	StatusNoMinimum Status = "no_minimum"
)

// CountBy says what counts toward the minimum: every staffed timeslot or every open day with at least one staffed
// timeslot. While every open day has a single timeslot both count the same.
type CountBy string

const (
	CountByTimeslot CountBy = "timeslot"
	CountByOpenDay  CountBy = "open_day"
)

// Valid reports whether the value is known.
func (c CountBy) Valid() bool { return c == CountByTimeslot || c == CountByOpenDay }

// DefaultDeadline is the sign-up deadline of a period that sets none.
type DefaultDeadline string

const (
	DeadlinePeriodEnd         DefaultDeadline = "period_end"
	DeadlineTwoWeeksBeforeEnd DefaultDeadline = "two_weeks_before_end"
)

// Valid reports whether the value is known.
func (d DefaultDeadline) Valid() bool {
	return d == DeadlinePeriodEnd || d == DeadlineTwoWeeksBeforeEnd
}

// Exception lowers the minimum of the people holding an extra role.
type Exception struct {
	RoleID   uuid.UUID
	RoleName string
	Minimum  int
}

// Rules are the editable staffing rules.
type Rules struct {
	SupervisorMinimum int
	TraineeMinimum    int
	TraineeReadyAfter int
	WarningWindowDays int
	CountBy           CountBy
	DefaultDeadline   DefaultDeadline
	Exceptions        []Exception
	Version           int64
	UpdatedAt         time.Time
}

// WarningWindow is how far ahead open places are worth pointing people at.
func (r Rules) WarningWindow() time.Duration {
	return time.Duration(r.WarningWindowDays) * 24 * time.Hour
}

// MembershipMinimum is the minimum of a membership before exceptions and excusals.
func (r Rules) MembershipMinimum(membership roles.Membership) int {
	switch membership {
	case roles.MembershipSupervisor:
		return r.SupervisorMinimum
	case roles.MembershipTrainee:
		return r.TraineeMinimum
	default:
		return 0
	}
}

// SignUpBy is the date people must have signed up by: the period's own deadline, else the default deadline.
func (r Rules) SignUpBy(endsOn time.Time, deadline *time.Time) time.Time {
	if deadline != nil {
		return *deadline
	}
	if r.DefaultDeadline == DeadlineTwoWeeksBeforeEnd {
		return endsOn.AddDate(0, 0, -14)
	}
	return endsOn
}

// ExceptionInput is one exception of a rules update.
type ExceptionInput struct {
	RoleID  uuid.UUID
	Minimum int
}

// UpdateInput replaces the rules and their exceptions.
type UpdateInput struct {
	ExpectedVersion   int64
	SupervisorMinimum int
	TraineeMinimum    int
	TraineeReadyAfter int
	WarningWindowDays int
	CountBy           CountBy
	DefaultDeadline   DefaultDeadline
	Exceptions        []ExceptionInput
}

// Limits of the rules, mirrored by the table constraints.
const (
	MaxMinimum           = 20
	MaxWarningWindowDays = 60
	MaxExceptions        = 200
	MaxExcusalReason     = 500
)

// Semester is an open-day period seen as a semester. Dates are calendar dates at UTC midnight.
type Semester struct {
	ID       uuid.UUID
	Name     string
	Status   string
	StartsOn time.Time
	EndsOn   time.Time
	// SignUpBy is the date people must have signed up for their minimum: the period's sign-up deadline, else the
	// default deadline of the rules.
	SignUpBy time.Time
}

// Counts are a person's open days in one semester.
type Counts struct {
	// Staffed are ended timeslots or open days (as the rules count), in any place.
	Staffed int
	// Booked are upcoming timeslots or open days, in any place.
	Booked int
	// StaffedAsTrainee are the ended timeslots or open days staffed in a trainee place.
	StaffedAsTrainee int
}

// Standing is the evaluated status with the number of open days still missing.
type Standing struct {
	Status  Status
	Missing int
}

// MinimumSource says where a person's minimum comes from.
type MinimumSource string

const (
	SourceMembership MinimumSource = "membership"
	SourceException  MinimumSource = "exception"
	SourceExcused    MinimumSource = "excused"
)

// Minimum is a person's resolved minimum with its source; ExceptionRole names the extra role of an exception.
type Minimum struct {
	Value         int
	Source        MinimumSource
	ExceptionRole *string
}

// Excusal frees a person from the minimum of one period. Its reason is visible with supervisor_dashboard.read only.
type Excusal struct {
	PeriodID  uuid.UUID
	PersonID  uuid.UUID
	Reason    string
	CreatedAt time.Time
}

// KindOf is the staffing kind of a membership; nil means the person does not staff (visitors).
func KindOf(membership roles.Membership) *roles.Membership {
	if !membership.Staffs() {
		return nil
	}
	return &membership
}

// ResolveMinimum is the minimum of one person: the membership minimum, or the lowest exception among their extra
// roles when it is lower; an excusal for the semester makes it zero. Every place that evaluates the minimum goes
// through this function.
func ResolveMinimum(
	membership roles.Membership,
	rules Rules,
	exceptions []Exception,
	excused bool,
) Minimum {
	if excused {
		return Minimum{Value: 0, Source: SourceExcused}
	}
	result := Minimum{Value: rules.MembershipMinimum(membership), Source: SourceMembership}
	for _, exception := range exceptions {
		if exception.Minimum < result.Value {
			name := exception.RoleName
			result = Minimum{Value: exception.Minimum, Source: SourceException, ExceptionRole: &name}
		}
	}
	return result
}

// StatusFor evaluates counts against the person's resolved minimum and the trainee threshold of the rules.
func StatusFor(membership roles.Membership, counts Counts, rules Rules, minimum Minimum) Standing {
	switch {
	case membership == roles.MembershipTrainee && counts.StaffedAsTrainee >= rules.TraineeReadyAfter:
		return Standing{Status: StatusReady}
	case minimum.Source == SourceExcused:
		return Standing{Status: StatusExcused}
	case minimum.Value == 0:
		return Standing{Status: StatusNoMinimum}
	case counts.Staffed+counts.Booked >= minimum.Value:
		return Standing{Status: StatusFulfilled}
	default:
		return Standing{Status: StatusMissing, Missing: minimum.Value - counts.Staffed - counts.Booked}
	}
}

// Minimums resolves the minimum per person for one semester.
type Minimums struct {
	rules      Rules
	exceptions map[uuid.UUID][]Exception
	excusals   map[uuid.UUID]Excusal
}

// For returns the resolved minimum of the person.
func (m Minimums) For(personID uuid.UUID, membership roles.Membership) Minimum {
	_, excused := m.excusals[personID]
	return ResolveMinimum(membership, m.rules, m.exceptions[personID], excused)
}

// Excusal returns the person's excusal for the semester, if any.
func (m Minimums) Excusal(personID uuid.UUID) *Excusal {
	excusal, ok := m.excusals[personID]
	if !ok {
		return nil
	}
	return &excusal
}
