package authorization

// AccountStatus is whether an account may sign in.
type AccountStatus string

const (
	AccountEnabled  AccountStatus = "enabled"
	AccountDisabled AccountStatus = "disabled"
)
