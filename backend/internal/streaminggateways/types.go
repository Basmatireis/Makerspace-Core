package streaminggateways

// Lifecycle is the lifecycle state of a streaming gateway.
type Lifecycle string

const (
	LifecyclePending  Lifecycle = "pending"
	LifecycleActive   Lifecycle = "active"
	LifecycleDisabled Lifecycle = "disabled"
	LifecycleRevoked  Lifecycle = "revoked"
)

// HealthState is the overall health a gateway reports in its heartbeat.
type HealthState string

const (
	HealthConnected HealthState = "connected"
	HealthDegraded  HealthState = "degraded"
)

// CameraStatus is the health of one camera stream.
type CameraStatus string

const (
	CameraLive        CameraStatus = "live"
	CameraIdle        CameraStatus = "idle"
	CameraUnavailable CameraStatus = "unavailable"
	CameraUnknown     CameraStatus = "unknown"
)

// TicketKeyState is the lifecycle state of a stream ticket signing key.
type TicketKeyState string

const (
	TicketKeyActive  TicketKeyState = "active"
	TicketKeyPending TicketKeyState = "pending"
	TicketKeyRetired TicketKeyState = "retired"
)

// CredentialState is the state of a gateway credential.
type CredentialState string

// CredentialRevoked marks a credential that no longer authenticates.
const CredentialRevoked CredentialState = "revoked"
