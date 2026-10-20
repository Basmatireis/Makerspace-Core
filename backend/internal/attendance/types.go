package attendance

// VisitStatus is the lifecycle state of a visit.
type VisitStatus string

const (
	VisitCheckedIn  VisitStatus = "checked_in"
	VisitCheckedOut VisitStatus = "checked_out"
	VisitVoided     VisitStatus = "voided"
)

// AdmissionDecision records whether a check-in satisfied the Lab Rules requirement.
type AdmissionDecision string

const (
	AdmissionAdmitted AdmissionDecision = "admitted"
	AdmissionWarning  AdmissionDecision = "warning"
)
