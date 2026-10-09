package devicebridge

import (
	"fmt"
	"strings"
)

const simulatorReaderID = "simulator-reader"

func Simulate(broker *Broker, action, uid string) ([]Event, error) {
	raw := RawEvent{Source: "simulator", ReaderID: simulatorReaderID, ReaderName: "Development NFC simulator"}
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "scan":
		raw.Kind, raw.UID = "nfc_scan", uid
		event, err := broker.Publish(raw)
		return eventSlice(event, err)
	case "duplicate":
		raw.Kind, raw.UID = "nfc_scan", uid
		first, err := broker.Publish(raw)
		if err != nil {
			return nil, err
		}
		second, err := broker.Publish(raw)
		if err != nil {
			return nil, err
		}
		return []Event{first, second}, nil
	case "remove":
		raw.Kind = "nfc_removed"
	case "disconnect":
		raw.Kind, raw.State = "reader_state", "disconnected"
	case "reconnect":
		raw.Kind, raw.State = "reader_state", "connected"
	case "unsupported":
		raw.Kind, raw.State, raw.ErrorCode = "capability_state", "unavailable", "unsupported_capability"
	default:
		return nil, fmt.Errorf("action must be scan, duplicate, remove, disconnect, reconnect, or unsupported")
	}
	event, err := broker.Publish(raw)
	return eventSlice(event, err)
}

func eventSlice(event Event, err error) ([]Event, error) {
	if err != nil {
		return nil, err
	}
	return []Event{event}, nil
}
