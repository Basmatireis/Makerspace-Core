package printerconnector

// AdapterKind is the printer adapter a connector assignment runs.
type AdapterKind string

const (
	AdapterSimulator AdapterKind = "simulator"
	AdapterBambuH2D  AdapterKind = "bambu_h2d"
	AdapterBambuX1C  AdapterKind = "bambu_x1c"
)

// ObservationKind is the type of a printer connector event.
type ObservationKind string

const (
	ObservationConnectivity      ObservationKind = "connectivity"
	ObservationOperationalState  ObservationKind = "operational_state"
	ObservationProgress          ObservationKind = "progress"
	ObservationSlot              ObservationKind = "slot_observation"
	ObservationConsumptionReport ObservationKind = "consumption_report"
	ObservationTerminalOutcome   ObservationKind = "terminal_outcome"
	ObservationPrinterError      ObservationKind = "printer_error"
)

// HealthState is the health the connector reports to Core.
type HealthState string

const (
	HealthConnected HealthState = "connected"
	HealthDegraded  HealthState = "degraded"
)

// ConnectivityState is the reachability of a printer in a connectivity observation.
type ConnectivityState string

const (
	ConnectivityOnline   ConnectivityState = "online"
	ConnectivityOffline  ConnectivityState = "offline"
	ConnectivityDegraded ConnectivityState = "degraded"
)

// ReceiptStatus is how Core answered one delivered event.
type ReceiptStatus string

const (
	ReceiptAccepted  ReceiptStatus = "accepted"
	ReceiptDuplicate ReceiptStatus = "duplicate"
	ReceiptRejected  ReceiptStatus = "rejected"
	ReceiptRetry     ReceiptStatus = "retry"
)

// PrinterState is the operational state of a printer in live status and
// operational-state observations.
type PrinterState string

const (
	PrinterIdle      PrinterState = "idle"
	PrinterPreparing PrinterState = "preparing"
	PrinterPrinting  PrinterState = "printing"
	PrinterPaused    PrinterState = "paused"
	PrinterFinished  PrinterState = "finished"
	PrinterFailed    PrinterState = "failed"
	PrinterUnknown   PrinterState = "unknown"
)

// PrintOutcome is how a print ended.
type PrintOutcome string

const (
	OutcomeCompleted PrintOutcome = "completed"
	OutcomeFailed    PrintOutcome = "failed"
	OutcomeUnknown   PrintOutcome = "unknown"
)

// UnitKind is the kind of a filament input unit.
type UnitKind string

const (
	UnitAMS      UnitKind = "ams"
	UnitAMSHT    UnitKind = "ams_ht"
	UnitExternal UnitKind = "external"
	UnitUnknown  UnitKind = "unknown"
)

// SimulatorScenario is the behaviour of the simulator adapter.
type SimulatorScenario string

const (
	ScenarioIdle            SimulatorScenario = "idle"
	ScenarioSuccessfulPrint SimulatorScenario = "successful_print"
	ScenarioFailedPrint     SimulatorScenario = "failed_print"
)

// ErrorTransition is whether a printer error appeared or cleared.
type ErrorTransition string

const (
	ErrorAppeared ErrorTransition = "appeared"
	ErrorCleared  ErrorTransition = "cleared"
)

// CameraHealthState is the health of one camera stream reported in the heartbeat.
type CameraHealthState string

const (
	CameraLive        CameraHealthState = "live"
	CameraIdle        CameraHealthState = "idle"
	CameraUnavailable CameraHealthState = "unavailable"
)
