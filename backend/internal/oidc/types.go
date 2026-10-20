package oidc

// FlowKind is the purpose of an OIDC authorization flow.
type FlowKind string

const (
	FlowLogin          FlowKind = "login"
	FlowLink           FlowKind = "link"
	FlowReauthenticate FlowKind = "reauthenticate"
)
