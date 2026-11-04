package laborordnung

// Mode is how strictly a role requires acknowledging the current Lab Rules.
type Mode string

const (
	ModeNotRequired Mode = "not_required"
	ModeWarning     Mode = "warning"
	ModeBlocking    Mode = "blocking"
)

// Valid reports whether m is a known mode.
func (m Mode) Valid() bool {
	return m == ModeNotRequired || m == ModeWarning || m == ModeBlocking
}

// VersionStatus is the publication state of a Lab Rules version.
type VersionStatus string

const (
	VersionDraft     VersionStatus = "draft"
	VersionPublished VersionStatus = "published"
)

// State is where a person stands against the current Lab Rules.
type State string

const (
	StateNotRequired        State = "not_required"
	StateNoPublishedVersion State = "no_published_version"
	StateCurrent            State = "current"
	StateOutdated           State = "outdated"
)

// ConfirmationMethod is how a person confirmed a Lab Rules version.
type ConfirmationMethod string

const (
	// MethodPaper marks signed paper a supervisor checked before people confirmed themselves; only history has it.
	MethodPaper      ConfirmationMethod = "paper"
	MethodApp        ConfirmationMethod = "app"
	MethodKiosk      ConfirmationMethod = "kiosk"
	MethodEnrollment ConfirmationMethod = "enrollment"
)

// Valid reports whether m is a known method.
func (m ConfirmationMethod) Valid() bool {
	return m == MethodPaper || m == MethodApp || m == MethodKiosk || m == MethodEnrollment
}
