package authorization

// AccountStatus is whether an account may sign in.
type AccountStatus string

const (
	AccountEnabled  AccountStatus = "enabled"
	AccountDisabled AccountStatus = "disabled"
)

// SystemKey identifies a built-in system role. Master is the only one.
type SystemKey string

const SystemKeyMaster SystemKey = "master"
