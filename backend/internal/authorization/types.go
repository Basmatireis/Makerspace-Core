package authorization

// AccountStatus is whether an account may sign in.
type AccountStatus string

const (
	AccountEnabled  AccountStatus = "enabled"
	AccountDisabled AccountStatus = "disabled"
)

// SystemKey identifies a built-in system role: master, or one of the membership roles every person holds exactly
// one of.
type SystemKey string

const (
	SystemKeyMaster     SystemKey = "master"
	SystemKeySupervisor SystemKey = "supervisor"
	SystemKeyTrainee    SystemKey = "trainee"
	SystemKeyVisitor    SystemKey = "visitor"
)

// IsMembership reports whether the key names a membership role.
func (k SystemKey) IsMembership() bool {
	return k == SystemKeySupervisor || k == SystemKeyTrainee || k == SystemKeyVisitor
}
