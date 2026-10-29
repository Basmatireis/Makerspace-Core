package printing

// MachineProcess is the manufacturing process of a machine type.
type MachineProcess string

// ProcessFDMPrinting is the only process that has a printer setup.
const ProcessFDMPrinting MachineProcess = "fdm_printing"

// SpoolLifecycle is whether a spool is in use.
type SpoolLifecycle string

// SpoolActive marks a spool that can be mounted.
const SpoolActive SpoolLifecycle = "active"

// PrinterModel is a supported printer model.
type PrinterModel string

const (
	ModelBambuH2D     PrinterModel = "bambu_h2d"
	ModelBambuX1C     PrinterModel = "bambu_x1c"
	ModelPrusaCoreOne PrinterModel = "prusa_core_one"
	ModelGeneric      PrinterModel = "generic"
)

// Nozzle is which nozzle of a dual-nozzle printer feeds an input unit.
type Nozzle string

const (
	NozzleLeft  Nozzle = "left"
	NozzleRight Nozzle = "right"
)

// SlotStatus is whether a spool slot can take a spool.
type SlotStatus string

const (
	SlotAvailable   SlotStatus = "available"
	SlotUnavailable SlotStatus = "unavailable"
	SlotRetired     SlotStatus = "retired"
)

// EventKind is the type of a printer connector event.
type EventKind string

const (
	EventIdentity          EventKind = "identity"
	EventConnectivity      EventKind = "connectivity"
	EventOperationalState  EventKind = "operational_state"
	EventProgress          EventKind = "progress"
	EventSlotObservation   EventKind = "slot_observation"
	EventConsumptionReport EventKind = "consumption_report"
	EventTerminalOutcome   EventKind = "terminal_outcome"
	// EventPrinterError is a printer error appearing or clearing; the connector runtime stores it.
	EventPrinterError EventKind = "printer_error"
)

// ApplicationState is what Core did with a connector event.
type ApplicationState string

const (
	ApplicationApplied        ApplicationState = "applied"
	ApplicationReviewRequired ApplicationState = "review_required"
	ApplicationRecorded       ApplicationState = "recorded"
)
