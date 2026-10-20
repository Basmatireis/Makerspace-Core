package devicebridge

// EventKind is the type of a bridge event.
type EventKind string

const (
	KindNFCScan         EventKind = "nfc_scan"
	KindNFCRemoved      EventKind = "nfc_removed"
	KindReaderState     EventKind = "reader_state"
	KindCapabilityState EventKind = "capability_state"
)

// StateSimulated is the capability state of the development simulator.
const StateSimulated = "simulated"
