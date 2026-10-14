package printerconnector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

type bambuPersistedState struct {
	Document          map[string]any           `json:"document"`
	Ready             bool                     `json:"ready"`
	Lifecycle         string                   `json:"lifecycle,omitempty"`
	CurrentSessionKey string                   `json:"currentSessionKey,omitempty"`
	CurrentRunID      string                   `json:"currentRunId,omitempty"`
	Sessions          map[string]string        `json:"sessions,omitempty"`
	Generation        uint64                   `json:"generation"`
	LastProgress      string                   `json:"lastProgress,omitempty"`
	LastSlots         map[string]string        `json:"lastSlots,omitempty"`
	EmptySlotCounts   map[string]uint8         `json:"emptySlotCounts,omitempty"`
	ActiveErrors      map[string]bool          `json:"activeErrors,omitempty"`
	LastTray          string                   `json:"lastTray,omitempty"`
	RunFacts          map[string]bambuRunFacts `json:"runFacts,omitempty"`
	AutoDetectSpools  bool                     `json:"autoDetectSpools"`
}

type bambuRunFacts struct {
	Outcome             string   `json:"outcome,omitempty"`
	LastLayer           *int     `json:"lastLayer,omitempty"`
	LastProgress        *float64 `json:"lastProgress,omitempty"`
	HistoryComplete     bool     `json:"historyComplete"`
	ExternalPrintID     string   `json:"externalPrintId,omitempty"`
	InputUnitExternalID string   `json:"inputUnitExternalId,omitempty"`
	SlotExternalID      string   `json:"slotExternalId,omitempty"`
	TagUID              string   `json:"tagUid,omitempty"`
}

type bambuProcessor struct {
	assignmentID  uuid.UUID
	store         *Store
	state         bambuPersistedState
	loaded        bool
	firstSnapshot bool
}

func newBambuProcessor(ctx context.Context, assignmentID uuid.UUID, store *Store) (*bambuProcessor, error) {
	state, found, err := store.BambuState(ctx, assignmentID)
	if err != nil {
		return nil, err
	}
	if !found {
		state = bambuPersistedState{}
	}
	if state.Document == nil {
		state.Document = map[string]any{}
	}
	if state.Sessions == nil {
		state.Sessions = map[string]string{}
	}
	if state.LastSlots == nil {
		state.LastSlots = map[string]string{}
	}
	if state.EmptySlotCounts == nil {
		state.EmptySlotCounts = map[string]uint8{}
	}
	if state.ActiveErrors == nil {
		state.ActiveErrors = map[string]bool{}
	}
	if state.RunFacts == nil {
		state.RunFacts = map[string]bambuRunFacts{}
	}
	return &bambuProcessor{assignmentID: assignmentID, store: store, state: state, loaded: found, firstSnapshot: true}, nil
}

func (p *bambuProcessor) ready() bool { return p.state.Ready }

func (p *bambuProcessor) configureAutoDetectSpools(enabled bool) {
	// Enabling reconciliation must replay the current stable slot identities
	// once, even when the connector already observed them before the option was
	// enabled. Subsequent identical MQTT reports remain suppressed normally.
	if enabled && !p.state.AutoDetectSpools {
		p.state.LastSlots = map[string]string{}
		p.state.EmptySlotCounts = map[string]uint8{}
	}
	p.state.AutoDetectSpools = enabled
}

func (p *bambuProcessor) persist(ctx context.Context) error {
	return p.store.SaveBambuState(ctx, p.assignmentID, p.state)
}

func (p *bambuProcessor) apply(_ context.Context, payload []byte, observedAt time.Time) ([]Observation, bool, error) {
	if p.state.RunFacts == nil {
		p.state.RunFacts = map[string]bambuRunFacts{}
	}
	if p.state.EmptySlotCounts == nil {
		p.state.EmptySlotCounts = map[string]uint8{}
	}
	if len(payload) == 0 || len(payload) > maximumReducerBytes {
		return nil, p.state.Ready, errors.New("bambu_h2d MQTT payload exceeds reducer limit")
	}
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.UseNumber()
	var patch map[string]any
	if err := decoder.Decode(&patch); err != nil || patch == nil {
		return nil, p.state.Ready, errors.New("invalid bambu_h2d MQTT JSON object")
	}
	merged, err := mergeBambuObject(p.state.Document, patch, 0)
	if err != nil {
		return nil, p.state.Ready, err
	}
	encoded, err := json.Marshal(merged)
	if err != nil || len(encoded) > maximumReducerBytes {
		return nil, p.state.Ready, errors.New("bambu_h2d merged state exceeds reducer limit")
	}
	p.state.Document = merged
	printState := objectAt(merged, "print")
	if printState == nil {
		printState = merged
	}
	lifecycle := strings.ToUpper(strings.TrimSpace(stringAt(printState, "gcode_state")))
	if lifecycle == "" {
		return nil, p.state.Ready, nil
	}
	wasReady := p.state.Ready
	p.state.Ready = true
	previousLifecycle := p.state.Lifecycle
	previousActive := isBambuActive(previousLifecycle)
	active := isBambuActive(lifecycle)
	terminal := lifecycle == "FINISH" || lifecycle == "FAILED"
	// A terminal status retained by the printer at first startup is history, not
	// a new run. Persist it so the next active transition is detected correctly.
	if !wasReady && terminal && p.state.CurrentRunID == "" {
		p.state.Lifecycle = lifecycle
		p.firstSnapshot = false
		return nil, true, nil
	}

	var observations []Observation
	if active {
		sessionKey := bambuSessionKey(printState)
		if sessionKey == "" {
			if !previousActive || p.state.CurrentSessionKey == "" {
				p.state.Generation++
				p.state.CurrentSessionKey = fmt.Sprintf("generation:%d", p.state.Generation)
			}
			sessionKey = p.state.CurrentSessionKey
		}
		if sessionKey != p.state.CurrentSessionKey || p.state.CurrentRunID == "" {
			p.state.CurrentSessionKey = sessionKey
			p.state.CurrentRunID = p.state.Sessions[sessionKey]
			if p.state.CurrentRunID == "" {
				p.state.CurrentRunID = uuid.Must(uuid.NewV7()).String()
				if len(p.state.Sessions) >= 64 {
					p.state.Sessions = map[string]string{}
					p.state.RunFacts = map[string]bambuRunFacts{}
				}
				p.state.Sessions[sessionKey] = p.state.CurrentRunID
			}
			p.state.LastProgress = ""
		}
	}
	runID, externalID := p.currentRun()
	historyComplete := !p.firstSnapshot || (p.loaded && previousActive)
	p.firstSnapshot = false

	if active && runID != nil {
		facts := p.state.RunFacts[runID.String()]
		facts.HistoryComplete = historyComplete
		if externalID != nil {
			facts.ExternalPrintID = *externalID
		}
		if layer, ok := boundedInt(printState["layer_num"], 0, math.MaxInt32); ok {
			facts.LastLayer = &layer
		}
		if progress, ok := boundedInt(printState["mc_percent"], 0, 100); ok {
			value := float64(progress)
			facts.LastProgress = &value
		}
		if unitID, trayID, tagUID, ok := bambuActiveSlot(printState); ok {
			facts.InputUnitExternalID = unitID
			facts.SlotExternalID = trayID
			facts.TagUID = tagUID
		}
		p.state.RunFacts[runID.String()] = facts
		state := "printing"
		if lifecycle == "PAUSE" {
			state = "paused"
		}
		if !previousActive || lifecycle != previousLifecycle {
			observations = append(observations, Observation{Kind: "operational_state", Payload: mustJSON(map[string]any{"state": state, "fileName": bambuFileName(printState), "observedAt": observedAt}), RunID: runID, HistoryComplete: historyComplete, ExternalPrintID: externalID})
		}
		progressPayload := bambuProgress(printState, observedAt)
		progressKey := digestWithoutObservedAt(progressPayload)
		if progressKey != p.state.LastProgress {
			p.state.LastProgress = progressKey
			observations = append(observations, Observation{Kind: "progress", Payload: progressPayload, RunID: runID, HistoryComplete: historyComplete, ExternalPrintID: externalID})
		}
	}

	if previousActive && !active && !terminal && runID != nil {
		facts := p.state.RunFacts[runID.String()]
		facts.Outcome = "unknown"
		p.state.RunFacts[runID.String()] = facts
		observations = append(observations, Observation{Kind: "terminal_outcome", Payload: mustJSON(map[string]any{"outcome": "unknown", "observedAt": observedAt}), RunID: runID, HistoryComplete: historyComplete, ExternalPrintID: externalID})
	}
	if terminal && runID != nil && (previousLifecycle != lifecycle || previousActive) {
		outcome := "completed"
		if lifecycle == "FAILED" {
			outcome = "failed"
		}
		facts := p.state.RunFacts[runID.String()]
		facts.Outcome = outcome
		facts.HistoryComplete = historyComplete
		if externalID != nil {
			facts.ExternalPrintID = *externalID
		}
		p.state.RunFacts[runID.String()] = facts
		observations = append(observations, Observation{Kind: "terminal_outcome", Payload: mustJSON(map[string]any{"outcome": outcome, "observedAt": observedAt}), RunID: runID, HistoryComplete: historyComplete, ExternalPrintID: externalID})
	}

	observations = append(observations, p.errorTransitions(printState, observedAt, runID, externalID, historyComplete)...)
	observations = append(observations, p.slotTransitions(printState, observedAt, runID, externalID, historyComplete)...)
	tray := firstScalar(printState, "tray_now")
	if ams := objectAt(printState, "ams"); tray == "" {
		tray = firstScalar(ams, "tray_now")
	}
	if active && tray != "" && tray != p.state.LastTray {
		if p.state.LastTray != "" {
			observations = append(observations, Observation{Kind: "filament_change", Payload: mustJSON(map[string]any{"fromSlotExternalId": p.state.LastTray, "toSlotExternalId": tray, "observedAt": observedAt}), RunID: runID, HistoryComplete: historyComplete, ExternalPrintID: externalID})
		}
		p.state.LastTray = tray
	}
	p.state.Lifecycle = lifecycle
	return observations, true, nil
}

func (p *bambuProcessor) currentRun() (*uuid.UUID, *string) {
	parsed, err := uuid.Parse(p.state.CurrentRunID)
	if err != nil {
		return nil, nil
	}
	external := p.state.CurrentSessionKey
	return &parsed, &external
}

func mergeBambuObject(current, patch map[string]any, depth int) (map[string]any, error) {
	if depth > 32 {
		return nil, errors.New("bambu_h2d MQTT object nesting is too deep")
	}
	result := make(map[string]any, len(current)+len(patch))
	for key, value := range current {
		result[key] = value
	}
	for key, value := range patch {
		if len(key) > 200 {
			return nil, errors.New("bambu_h2d MQTT object key is too long")
		}
		if value == nil {
			delete(result, key)
			continue
		}
		patchObject, patchOK := value.(map[string]any)
		currentObject, currentOK := result[key].(map[string]any)
		if patchOK && currentOK {
			merged, err := mergeBambuObject(currentObject, patchObject, depth+1)
			if err != nil {
				return nil, err
			}
			result[key] = merged
			continue
		}
		result[key] = value // Arrays and scalars replace as a unit.
	}
	return result, nil
}

func isBambuActive(value string) bool {
	switch value {
	case "PREPARE", "RUNNING", "PAUSE":
		return true
	default:
		return false
	}
}

func bambuSessionKey(state map[string]any) string {
	// local_task_id is intentionally not trusted in V1 until reviewed real
	// fixtures demonstrate that it remains stable for the complete H2D job.
	keys := []string{"lan_task_id", "task_id", "job_id", "subtask_id"}
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		if value := scalarString(state[key]); value != "" && value != "0" {
			parts = append(parts, key+"="+value)
		}
	}
	if len(parts) > 0 {
		return "tuple:" + strings.Join(parts, ",")
	}
	return ""
}

func bambuFileName(state map[string]any) string {
	value := firstScalar(state, "gcode_file", "file", "filename")
	if len(value) > 255 {
		return value[:255]
	}
	return value
}

// bambuActiveSlot resolves tray_now only when it identifies exactly one AMS
// tray in the merged status document. A bare tray number is intentionally not
// guessed across multiple AMS units because tray numbers repeat.
func bambuActiveSlot(state map[string]any) (string, string, string, bool) {
	ams := objectAt(state, "ams")
	trayNow := firstScalar(state, "tray_now")
	if trayNow == "" {
		trayNow = firstScalar(ams, "tray_now")
	}
	if trayNow == "" {
		return "", "", "", false
	}
	requestedUnit, requestedTray := "", trayNow
	if before, after, found := strings.Cut(trayNow, ":"); found {
		requestedUnit, requestedTray = strings.TrimSpace(before), strings.TrimSpace(after)
		if requestedUnit == "" || requestedTray == "" {
			return "", "", "", false
		}
	}
	units, _ := ams["ams"].([]any)
	type match struct{ unit, tray, tag string }
	var matches []match
	for _, rawUnit := range units {
		unit, _ := rawUnit.(map[string]any)
		unitID := firstScalar(unit, "id", "ams_id")
		if unitID == "" || (requestedUnit != "" && requestedUnit != unitID) {
			continue
		}
		trays, _ := unit["tray"].([]any)
		for _, rawTray := range trays {
			tray, _ := rawTray.(map[string]any)
			trayID := firstScalar(tray, "id", "tray_id")
			if trayID == requestedTray {
				matches = append(matches, match{unit: unitID, tray: trayID, tag: firstScalar(tray, "tag_uid")})
			}
		}
	}
	if len(matches) != 1 {
		return "", "", "", false
	}
	return matches[0].unit, matches[0].tray, matches[0].tag, true
}

func bambuProgress(state map[string]any, observedAt time.Time) json.RawMessage {
	result := map[string]any{"state": "printing", "observedAt": observedAt}
	if fileName := bambuFileName(state); fileName != "" {
		result["fileName"] = fileName
	}
	if percent, ok := boundedInt(state["mc_percent"], 0, 100); ok {
		result["percent"] = percent
	}
	if minutes, ok := boundedInt(state["mc_remaining_time"], 0, 10*365*24*60); ok {
		result["remainingSeconds"] = minutes * 60
	}
	if layer, ok := boundedInt(state["layer_num"], 0, math.MaxInt32); ok {
		result["layer"] = layer
	}
	if layers, ok := boundedInt(state["total_layer_num"], 0, math.MaxInt32); ok {
		result["totalLayers"] = layers
	}
	return mustJSON(result)
}

func (p *bambuProcessor) errorTransitions(state map[string]any, at time.Time, runID *uuid.UUID, externalID *string, historyComplete bool) []Observation {
	current := map[string]bool{}
	if code := scalarString(state["print_error"]); code != "" && code != "0" {
		current["print:"+code] = true
	}
	if hms, ok := state["hms"].([]any); ok {
		for _, raw := range hms {
			entry, _ := raw.(map[string]any)
			if code := firstScalar(entry, "code", "attr"); code != "" && code != "0" {
				current["hms:"+code] = true
			}
		}
	}
	keys := make([]string, 0, len(current)+len(p.state.ActiveErrors))
	for key := range current {
		keys = append(keys, key)
	}
	for key := range p.state.ActiveErrors {
		if !current[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	seen := map[string]bool{}
	result := make([]Observation, 0, len(keys))
	for _, key := range keys {
		if seen[key] {
			continue
		}
		seen[key] = true
		wasActive, isActive := p.state.ActiveErrors[key], current[key]
		if wasActive == isActive {
			continue
		}
		family, code, _ := strings.Cut(key, ":")
		transition := "cleared"
		if isActive {
			transition = "appeared"
		}
		result = append(result, Observation{Kind: "printer_error", Payload: mustJSON(map[string]any{"sourceFamily": family, "code": code, "transition": transition, "observedAt": at}), RunID: runID, HistoryComplete: historyComplete, ExternalPrintID: externalID})
	}
	p.state.ActiveErrors = current
	return result
}

func (p *bambuProcessor) slotTransitions(state map[string]any, at time.Time, runID *uuid.UUID, externalID *string, historyComplete bool) []Observation {
	ams := objectAt(state, "ams")
	units, _ := ams["ams"].([]any)
	currentKeys := map[string]bool{}
	var result []Observation
	for _, rawUnit := range units {
		unit, _ := rawUnit.(map[string]any)
		unitID := firstScalar(unit, "id", "ams_id")
		trays, _ := unit["tray"].([]any)
		for _, rawTray := range trays {
			tray, _ := rawTray.(map[string]any)
			trayID := firstScalar(tray, "id", "tray_id")
			if unitID == "" || trayID == "" {
				continue
			}
			slotKey := unitID + ":" + trayID
			currentKeys[slotKey] = true
			payload := map[string]any{
				"inputUnitExternalId": unitID,
				"slotExternalId":      trayID,
				"externalSlotKey":     slotKey,
				"freshness":           "live",
			}
			tagUID := firstScalar(tray, "tag_uid")
			if tagUID == "" {
				if p.state.EmptySlotCounts[slotKey] < 2 {
					p.state.EmptySlotCounts[slotKey]++
				}
				if p.state.EmptySlotCounts[slotKey] < 2 {
					// A transient RFID read failure must not unmount a spool. Wait
					// for the printer to report the same tag absence again.
					continue
				}
				payload["empty"] = true
			} else {
				delete(p.state.EmptySlotCounts, slotKey)
				payload["tagUid"] = tagUID
			}
			copyScalar(payload, tray, "trayUuid", "tray_uuid")
			copyScalar(payload, tray, "trayType", "tray_type")
			copyScalar(payload, tray, "productName", "tray_sub_brands")
			copyScalar(payload, tray, "color", "tray_color")
			copyScalar(payload, tray, "weightGrams", "tray_weight")
			// Remaining percentage, nozzle temperatures, active-tray state and the
			// print stage change continuously. They are useful live telemetry but
			// are not changes to the physical material mounted in a slot. Including
			// them in this transition payload used to emit one run event per slot on
			// almost every MQTT report.
			hash := digestJSON(mustJSON(payload))
			if p.state.LastSlots[slotKey] == hash {
				continue
			}
			p.state.LastSlots[slotKey] = hash
			payload["observedAt"] = at
			// Slot observations belong to the assignment/topology. Filament changes
			// are emitted separately with the run, so AMS inventory telemetry must
			// not flood an individual run's lifecycle timeline.
			result = append(result, Observation{Kind: "slot_observation", Payload: mustJSON(payload), HistoryComplete: historyComplete})
		}
	}
	for key := range p.state.LastSlots {
		if !currentKeys[key] && len(units) > 0 {
			delete(p.state.LastSlots, key)
			delete(p.state.EmptySlotCounts, key)
		}
	}
	return result
}

func objectAt(value map[string]any, key string) map[string]any {
	object, _ := value[key].(map[string]any)
	return object
}

func stringAt(value map[string]any, key string) string { return scalarString(value[key]) }

func scalarString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case bool:
		return strconv.FormatBool(typed)
	default:
		return ""
	}
}

func firstScalar(value map[string]any, keys ...string) string {
	for _, key := range keys {
		if result := scalarString(value[key]); result != "" {
			return result
		}
	}
	return ""
}

func boundedInt(value any, low, high int) (int, bool) {
	text := scalarString(value)
	parsed, err := strconv.Atoi(text)
	return parsed, err == nil && parsed >= low && parsed <= high
}

func copyScalar(target, source map[string]any, targetKey, sourceKey string) {
	if value := scalarString(source[sourceKey]); value != "" {
		target[targetKey] = value
	}
}

func digestJSON(value json.RawMessage) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func digestWithoutObservedAt(value json.RawMessage) string {
	var object map[string]any
	if json.Unmarshal(value, &object) == nil {
		delete(object, "observedAt")
		value = mustJSON(object)
	}
	return digestJSON(value)
}
