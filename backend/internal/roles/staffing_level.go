package roles

// StaffingLevel says how people holding a role staff open days: as supervisors or as trainees (new supervisors in
// their first semester). A role without a staffing level does not staff. Staffing behaviour is derived from this
// property and never from role names.
type StaffingLevel string

const (
	StaffingSupervisor StaffingLevel = "supervisor"
	StaffingTrainee    StaffingLevel = "trainee"
)

// Valid reports whether the level is one of the known levels.
func (l StaffingLevel) Valid() bool { return l == StaffingSupervisor || l == StaffingTrainee }
