package devicebridge

import "time"

const (
	ProtocolVersion = 1
	BridgeVersion   = "1.0.0"
)

type Capability struct {
	ID        string `json:"id"`
	Available bool   `json:"available"`
	State     string `json:"state"`
	Detail    string `json:"detail,omitempty"`
}

type DeviceInfo struct {
	ProtocolVersion int          `json:"protocolVersion"`
	BridgeVersion   string       `json:"bridgeVersion"`
	Platform        string       `json:"platform"`
	Capabilities    []Capability `json:"capabilities"`
	LatestSequence  uint64       `json:"latestSequence"`
	CoreConnected   bool         `json:"coreConnected"`
	DeviceName      string       `json:"deviceName,omitempty"`
}

type ReaderMetadata struct {
	ID       string `json:"id"`
	Name     string `json:"name,omitempty"`
	Protocol string `json:"protocol,omitempty"`
	ATR      string `json:"atr,omitempty"`
}

type NFCMetadata struct {
	UID       string `json:"uid"`
	UIDFormat string `json:"uidFormat"`
}

type Event struct {
	ProtocolVersion int             `json:"protocolVersion"`
	Sequence        uint64          `json:"sequence"`
	Kind            string          `json:"kind"`
	OccurredAt      time.Time       `json:"occurredAt"`
	Source          string          `json:"source"`
	Reader          *ReaderMetadata `json:"reader,omitempty"`
	NFC             *NFCMetadata    `json:"nfc,omitempty"`
	Duplicate       bool            `json:"duplicate,omitempty"`
	State           string          `json:"state,omitempty"`
	ErrorCode       string          `json:"errorCode,omitempty"`
}

type EventPage struct {
	Events       []Event `json:"events"`
	NextSequence uint64  `json:"nextSequence"`
}

type RawEvent struct {
	Kind, Source, UID, ReaderID, ReaderName, Protocol, ATR, State, ErrorCode string
}
