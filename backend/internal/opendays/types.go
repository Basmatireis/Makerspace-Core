package opendays

// PeriodStatus is where an Open Day period stands in its lifecycle.
type PeriodStatus string

const (
	PeriodDraft     PeriodStatus = "draft"
	PeriodStaffing  PeriodStatus = "staffing"
	PeriodPublished PeriodStatus = "published"
	PeriodArchived  PeriodStatus = "archived"
)

// DayStatus is whether an Open Day takes place.
type DayStatus string

const (
	DayScheduled DayStatus = "scheduled"
	DayCancelled DayStatus = "cancelled"
)

// RequirementKind is the staffing role an Open Day requirement asks for.
type RequirementKind string

const (
	RequirementSupervisor RequirementKind = "supervisor"
	RequirementTrainee    RequirementKind = "trainee"
)

// EntrySource is where a calendar entry comes from.
type EntrySource string

const (
	EntrySourceHolidayLibrary EntrySource = "holidayLibrary"
	EntrySourceManual         EntrySource = "manual"
)

// EntryCategory is what kind of day a calendar entry marks.
type EntryCategory string

const (
	EntryPublicHoliday EntryCategory = "publicHoliday"
	EntryAcademicBreak EntryCategory = "academicBreak"
)

// Disposition is what a recurrence preview would do with one date.
type Disposition string

const (
	DispositionCreate        Disposition = "create"
	DispositionPublicHoliday Disposition = "publicHoliday"
	DispositionAcademicBreak Disposition = "academicBreak"
	// DispositionForced is a public holiday or academic break date that gets an open day on purpose.
	DispositionForced   Disposition = "forced"
	DispositionConflict Disposition = "conflict"
)

const (
	// MaxTimeslotsPerDay bounds the timeslots of one open day and of a series template.
	MaxTimeslotsPerDay = 24
	// MaxRequiredCount bounds the places of one kind in one timeslot.
	MaxRequiredCount = 100
	// MaxForcedDates bounds the holiday and break dates a series forces.
	MaxForcedDates = 100
	// MaxRestrictionRoles bounds the extra roles a place may name.
	MaxRestrictionRoles = 50
)
