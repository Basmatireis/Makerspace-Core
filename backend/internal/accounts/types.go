package accounts

// IdentityKind is the kind of an authentication identity of an account.
type IdentityKind string

const (
	IdentityPassword IdentityKind = "password"
	IdentityPIN      IdentityKind = "pin"
	IdentityOIDC     IdentityKind = "oidc"
)

// PasswordStatus is the state of an account's password credential.
type PasswordStatus string

const (
	PasswordNotSet        PasswordStatus = "not_set"
	PasswordActive        PasswordStatus = "active"
	PasswordResetRequired PasswordStatus = "reset_required"
)

// ProvisioningSource is how an account came into existence.
type ProvisioningSource string

const (
	SourceLocal      ProvisioningSource = "local"
	SourceInvitation ProvisioningSource = "invitation"
	SourceOIDCJIT    ProvisioningSource = "oidc_jit"
	SourceSCIM       ProvisioningSource = "scim"
	SourceVisitor    ProvisioningSource = "visitor"
)
