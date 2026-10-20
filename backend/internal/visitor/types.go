package visitor

// AuthMethod is a sign-in method a visitor may enroll.
type AuthMethod string

const (
	MethodPassword AuthMethod = "password"
	MethodPIN      AuthMethod = "pin"
)

// Admission is the outcome of a visitor's Lab Rules admission check.
type Admission string

const (
	AdmissionAdmitted Admission = "admitted"
	AdmissionBlocked  Admission = "blocked"
	AdmissionWarning  Admission = "warning"
)
