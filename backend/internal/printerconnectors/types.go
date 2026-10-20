package printerconnectors

import "github.com/Basmatireis/Makerspace-Core/backend/internal/printing"

// Lifecycle is the lifecycle state of a printer connector.
type Lifecycle string

const (
	LifecyclePending  Lifecycle = "pending"
	LifecycleActive   Lifecycle = "active"
	LifecycleDisabled Lifecycle = "disabled"
	LifecycleRevoked  Lifecycle = "revoked"
)

// HealthState is the overall health a connector reports in its heartbeat.
type HealthState string

const (
	HealthConnected HealthState = "connected"
	HealthDegraded  HealthState = "degraded"
)

// AssignmentState is the runtime state a connector reports for one assignment.
type AssignmentState string

const (
	AssignmentConnecting    AssignmentState = "connecting"
	AssignmentConnected     AssignmentState = "connected"
	AssignmentDisconnected  AssignmentState = "disconnected"
	AssignmentDegraded      AssignmentState = "degraded"
	AssignmentStateDisabled AssignmentState = "disabled"
)

// AdapterKind is the printer adapter a connector runs for an assignment.
type AdapterKind string

const (
	AdapterBambuH2D AdapterKind = "bambu_h2d"
	AdapterBambuX1C AdapterKind = "bambu_x1c"
)

// EventPrinterError is the connector event kind for printer error transitions.
const EventPrinterError printing.EventKind = "printer_error"

// RunState is the state of an observed print run.
type RunState string

const (
	RunRunning   RunState = "running"
	RunFinished  RunState = "finished"
	RunFailed    RunState = "failed"
	RunCancelled RunState = "cancelled"
	RunUnknown   RunState = "unknown"
)

// ReceiptStatus is how Core answered one ingested connector event.
type ReceiptStatus string

const (
	ReceiptAccepted  ReceiptStatus = "accepted"
	ReceiptDuplicate ReceiptStatus = "duplicate"
	ReceiptRejected  ReceiptStatus = "rejected"
	ReceiptRetry     ReceiptStatus = "retry"
)

// CredentialState is the state of a connector credential.
type CredentialState string

// CredentialRevoked marks a credential that no longer authenticates.
const CredentialRevoked CredentialState = "revoked"

func (s AssignmentState) valid() bool {
	switch s {
	case AssignmentConnecting, AssignmentConnected, AssignmentDisconnected, AssignmentDegraded, AssignmentStateDisabled:
		return true
	}
	return false
}
