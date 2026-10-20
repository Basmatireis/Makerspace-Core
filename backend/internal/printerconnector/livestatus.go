package printerconnector

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Live status is telemetry: only the newest normalized snapshot per assignment
// is kept in memory and delivered. It is never queued, persisted or retried
// as history, so an outage cannot build a backlog.
const (
	liveStatusMinimumInterval = 5 * time.Second
	liveStatusKeepAlive       = 60 * time.Second
)

// LiveStatusSink is optionally implemented by sinks that accept live status
// snapshots. Adapters report the complete current state after every change;
// the call never blocks and only the latest snapshot survives.
type LiveStatusSink interface {
	ReportLiveStatus(snapshot json.RawMessage)
}

// The snapshot types mirror PrinterLiveStatusSnapshot in api/openapi.yaml.
// Every key is always present, with null where the adapter does not know.
type liveSnapshot struct {
	State           string           `json:"state"`
	Job             *liveJob         `json:"job"`
	Temperatures    liveTemperatures `json:"temperatures"`
	Nozzles         []liveNozzle     `json:"nozzles"`
	Units           []liveUnit       `json:"units"`
	ActiveTray      *liveActiveTray  `json:"activeTray"`
	Errors          []liveError      `json:"errors"`
	FirmwareVersion *string          `json:"firmwareVersion"`
	WifiSignalDbm   *int             `json:"wifiSignalDbm"`
}

type liveJob struct {
	FileName         *string `json:"fileName"`
	ProgressPercent  *int    `json:"progressPercent"`
	Layer            *int    `json:"layer"`
	TotalLayers      *int    `json:"totalLayers"`
	RemainingMinutes *int    `json:"remainingMinutes"`
}

type liveExtruderTemperature struct {
	ExtruderID int      `json:"extruderId"`
	Side       *string  `json:"side"`
	CurrentC   *float64 `json:"currentC"`
	TargetC    *float64 `json:"targetC"`
}

type liveTemperatures struct {
	Extruders  []liveExtruderTemperature `json:"extruders"`
	BedC       *float64                  `json:"bedC"`
	BedTargetC *float64                  `json:"bedTargetC"`
	ChamberC   *float64                  `json:"chamberC"`
}

type liveNozzle struct {
	ExtruderID int      `json:"extruderId"`
	Side       *string  `json:"side"`
	DiameterMm *float64 `json:"diameterMm"`
	Type       *string  `json:"type"`
}

type liveTray struct {
	ExternalID    string  `json:"externalId"`
	MaterialType  *string `json:"materialType"`
	SubBrand      *string `json:"subBrand"`
	ColorHex      *string `json:"colorHex"`
	RemainPercent *int    `json:"remainPercent"`
	RFID          bool    `json:"rfid"`
	Empty         bool    `json:"empty"`
}

type liveUnit struct {
	ExternalID      string     `json:"externalId"`
	Kind            string     `json:"kind"`
	Label           string     `json:"label"`
	HumidityPercent *int       `json:"humidityPercent"`
	TemperatureC    *float64   `json:"temperatureC"`
	Trays           []liveTray `json:"trays"`
}

type liveActiveTray struct {
	UnitExternalID string `json:"unitExternalId"`
	TrayExternalID string `json:"trayExternalId"`
}

type liveError struct {
	SourceFamily string     `json:"sourceFamily"`
	Code         string     `json:"code"`
	ObservedAt   *time.Time `json:"observedAt"`
}

func newLiveSnapshot(state string) liveSnapshot {
	return liveSnapshot{
		State:        state,
		Temperatures: liveTemperatures{Extruders: []liveExtruderTemperature{}},
		Nozzles:      []liveNozzle{},
		Units:        []liveUnit{},
		Errors:       []liveError{},
	}
}

type liveEntry struct {
	configurationVersion int64
	snapshot             json.RawMessage
	digest               string
	changed              bool
	lastAttempt          time.Time
	lastSuccess          time.Time
}

// liveDue is one snapshot that should be delivered now.
type liveDue struct {
	AssignmentID         uuid.UUID
	ConfigurationVersion int64
	Snapshot             json.RawMessage
}

// liveStatusHub keeps the newest snapshot per assignment and decides when it
// is due: at most every liveStatusMinimumInterval after a change, and at least
// every liveStatusKeepAlive while the assignment is connected.
type liveStatusHub struct {
	mu      sync.Mutex
	entries map[uuid.UUID]*liveEntry
	now     func() time.Time
}

func newLiveStatusHub() *liveStatusHub {
	return &liveStatusHub{entries: map[uuid.UUID]*liveEntry{}, now: func() time.Time { return time.Now().UTC() }}
}

func (h *liveStatusHub) Report(assignmentID uuid.UUID, configurationVersion int64, snapshot json.RawMessage) {
	digest := digestJSON(snapshot)
	h.mu.Lock()
	defer h.mu.Unlock()
	entry := h.entries[assignmentID]
	if entry == nil || entry.configurationVersion != configurationVersion {
		entry = &liveEntry{configurationVersion: configurationVersion}
		h.entries[assignmentID] = entry
	}
	if entry.digest != digest {
		entry.changed = true
	}
	entry.digest = digest
	entry.snapshot = append(json.RawMessage(nil), snapshot...)
}

func (h *liveStatusHub) Due(connected func(uuid.UUID) bool) []liveDue {
	now := h.now()
	h.mu.Lock()
	defer h.mu.Unlock()
	var due []liveDue
	for id, entry := range h.entries {
		if now.Sub(entry.lastAttempt) < liveStatusMinimumInterval {
			continue
		}
		if entry.changed || (connected(id) && now.Sub(entry.lastSuccess) >= liveStatusKeepAlive) {
			due = append(
				due,
				liveDue{AssignmentID: id, ConfigurationVersion: entry.configurationVersion, Snapshot: entry.snapshot},
			)
			// Claim the slot before the request so a slow Core is not hammered.
			entry.lastAttempt = now
		}
	}
	return due
}

// Delivered records a successful delivery of the snapshot with the given digest.
func (h *liveStatusHub) Delivered(assignmentID uuid.UUID, snapshot json.RawMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if entry := h.entries[assignmentID]; entry != nil {
		entry.lastSuccess = h.now()
		if entry.digest == digestJSON(snapshot) {
			entry.changed = false
		}
	}
}

// Drop forgets an assignment, for example after Core refused its configuration version.
func (h *liveStatusHub) Drop(assignmentID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.entries, assignmentID)
}

func (h *liveStatusHub) Reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.entries = map[uuid.UUID]*liveEntry{}
}
