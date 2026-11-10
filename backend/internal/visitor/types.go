package visitor

// Admission is the outcome of a visitor's Lab Rules admission check.
type Admission string

const (
	AdmissionAdmitted Admission = "admitted"
	AdmissionBlocked  Admission = "blocked"
	AdmissionWarning  Admission = "warning"
)
