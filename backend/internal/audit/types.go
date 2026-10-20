package audit

// ActorType is who performed an audited action.
type ActorType string

const (
	ActorUser    ActorType = "user"
	ActorSystem  ActorType = "system"
	ActorUnknown ActorType = "unknown"
)

// Valid reports whether t is a known actor type.
func (t ActorType) Valid() bool { return t == ActorUser || t == ActorSystem || t == ActorUnknown }

// Source is the entry point through which an audited action happened.
type Source string

const (
	SourceHTTP     Source = "http"
	SourceAdminCLI Source = "admin_cli"
	SourceSystem   Source = "system"
)
