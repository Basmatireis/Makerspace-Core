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

const bambuDisconnectGracePeriod = 5 * time.Minute

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
	DisconnectedAt    *time.Time               `json:"disconnectedAt,omitempty"`
	RunTimedOut       bool                     `json:"runTimedOut,omitempty"`
}

type bambuRunFacts struct {
	Outcome             string               `json:"outcome,omitempty"`
	LastLayer           *int                 `json:"lastLayer,omitempty"`
	LastProgress        *float64             `json:"lastProgress,omitempty"`
	HistoryComplete     bool                 `json:"historyComplete"`
	ExternalPrintID     string               `json:"externalPrintId,omitempty"`
	InputUnitExternalID string               `json:"inputUnitExternalId,omitempty"`
	SlotExternalID      string               `json:"slotExternalId,omitempty"`
	TagUID              string               `json:"tagUid,omitempty"`
	SpoolEvidence       []bambuSpoolEvidence `json:"spoolEvidence,omitempty"`
}

type bambuSpoolEvidence struct {
	SlicerFilamentID    string `json:"slicerFilamentId,omitempty"`
	Extruder            int    `json:"extruder"`
	InputUnitExternalID string `json:"inputUnitExternalId"`
	SlotExternalID      string `json:"slotExternalId"`
	TagUID              string `json:"tagUid,omitempty"`
}

type bambuProcessor struct {
	assignmentID  uuid.UUID
	adapterKind   string
	store         *Store
	state         bambuPersistedState
	loaded        bool
	firstSnapshot bool
	// errorSince is live-status bookkeeping only; it is not persisted.
	errorSince map[string]time.Time
}

func newBambuProcessor(ctx context.Context, assignmentID uuid.UUID, store *Store) (*bambuProcessor, error) {
	return newBambuProcessorFor(ctx, assignmentID, bambuH2DAdapterKind, store)
}

func newBambuProcessorFor(
	ctx context.Context,
	assignmentID uuid.UUID,
	adapterKind string,
	store *Store,
) (*bambuProcessor, error) {
	state, found, err := store.BambuStateFor(ctx, assignmentID, adapterKind)
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
	return &bambuProcessor{
		assignmentID:  assignmentID,
		adapterKind:   adapterKind,
		store:         store,
		state:         state,
		loaded:        found,
		firstSnapshot: true,
	}, nil
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
	return p.store.SaveBambuStateFor(ctx, p.assignmentID, p.adapterKind, p.state)
}

func (p *bambuProcessor) noteDisconnected(observedAt time.Time) bool {
	if p.state.DisconnectedAt != nil || p.state.RunTimedOut || !isBambuActive(p.state.Lifecycle) ||
		p.state.CurrentRunID == "" {
		return false
	}
	at := observedAt.UTC()
	p.state.DisconnectedAt = &at
	return true
}

func (p *bambuProcessor) noteConnected() bool {
	if p.state.DisconnectedAt == nil {
		return false
	}
	p.state.DisconnectedAt = nil
	return true
}

func (p *bambuProcessor) expireDisconnectedRun(observedAt time.Time) []Observation {
	if p.state.DisconnectedAt == nil || p.state.RunTimedOut || !isBambuActive(p.state.Lifecycle) {
		return nil
	}
	deadline := p.state.DisconnectedAt.UTC().Add(bambuDisconnectGracePeriod)
	if observedAt.UTC().Before(deadline) {
		return nil
	}
	runID, externalID := p.currentRun()
	if runID == nil {
		p.state.DisconnectedAt = nil
		return nil
	}
	facts := p.state.RunFacts[runID.String()]
	facts.Outcome = "unknown"
	p.state.RunFacts[runID.String()] = facts
	p.state.DisconnectedAt = nil
	p.state.RunTimedOut = true
	p.state.Lifecycle = "UNKNOWN"
	return []Observation{{
		Kind: "terminal_outcome",
		Payload: mustJSON(
			map[string]any{"outcome": "unknown", "reason": "connection_timeout", "observedAt": deadline},
		),
		RunID:           runID,
		HistoryComplete: facts.HistoryComplete,
		ExternalPrintID: externalID,
	}}
}

func (p *bambuProcessor) apply(_ context.Context, payload []byte, observedAt time.Time) ([]Observation, bool, error) {
	if p.state.RunFacts == nil {
		p.state.RunFacts = map[string]bambuRunFacts{}
	}
	if p.state.EmptySlotCounts == nil {
		p.state.EmptySlotCounts = map[string]uint8{}
	}
	if len(payload) == 0 || len(payload) > maximumReducerBytes {
		return nil, p.state.Ready, errors.New("Bambu MQTT payload exceeds reducer limit")
	}
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.UseNumber()
	var patch map[string]any
	if err := decoder.Decode(&patch); err != nil || patch == nil {
		return nil, p.state.Ready, errors.New("invalid Bambu MQTT JSON object")
	}
	merged, err := mergeBambuObject(p.state.Document, patch, 0)
	if err != nil {
		return nil, p.state.Ready, err
	}
	encoded, err := json.Marshal(merged)
	if err != nil || len(encoded) > maximumReducerBytes {
		return nil, p.state.Ready, errors.New("Bambu merged state exceeds reducer limit")
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
	suppressTimedOutSession := false
	if active {
		sessionKey := bambuSessionKey(printState)
		if sessionKey == "" {
			if !previousActive || p.state.CurrentSessionKey == "" {
				p.state.Generation++
				p.state.CurrentSessionKey = fmt.Sprintf("generation:%d", p.state.Generation)
			}
			sessionKey = p.state.CurrentSessionKey
		}
		if sessionKey != p.state.CurrentSessionKey {
			p.state.RunTimedOut = false
			p.state.DisconnectedAt = nil
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
		suppressTimedOutSession = p.state.RunTimedOut && sessionKey == p.state.CurrentSessionKey
	}
	runID, externalID := p.currentRun()
	historyComplete := !p.firstSnapshot || (p.loaded && previousActive)
	p.firstSnapshot = false

	if active && runID != nil && !suppressTimedOutSession {
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
		if unitID, trayID, tagUID, ok := bambuActiveSlotFor(p.adapterKind, printState); ok {
			facts.InputUnitExternalID = unitID
			facts.SlotExternalID = trayID
			facts.TagUID = tagUID
		}
		for _, route := range bambuSpoolRoutesFor(p.adapterKind, printState) {
			evidence := bambuSpoolEvidence{
				SlicerFilamentID:    route.slicerFilamentID,
				Extruder:            route.extruderID,
				InputUnitExternalID: route.ref.unitID,
				SlotExternalID:      route.ref.trayID, TagUID: bambuTagUID(route.ref.tray),
			}
			if !containsBambuSpoolEvidence(facts.SpoolEvidence, evidence) {
				facts.SpoolEvidence = append(facts.SpoolEvidence, evidence)
			}
		}
		p.state.RunFacts[runID.String()] = facts
		state := "printing"
		if lifecycle == "PAUSE" {
			state = "paused"
		}
		if !previousActive || lifecycle != previousLifecycle {
			observations = append(
				observations,
				Observation{
					Kind:            "operational_state",
					Payload:         bambuOperationalState(printState, state, observedAt),
					RunID:           runID,
					HistoryComplete: historyComplete,
					ExternalPrintID: externalID,
				},
			)
		}
		progressPayload := bambuProgress(printState, observedAt)
		progressKey := digestWithoutObservedAt(progressPayload)
		if progressKey != p.state.LastProgress {
			p.state.LastProgress = progressKey
			observations = append(
				observations,
				Observation{
					Kind:            "progress",
					Payload:         progressPayload,
					RunID:           runID,
					HistoryComplete: historyComplete,
					ExternalPrintID: externalID,
				},
			)
		}
	}

	if previousActive && !active && !terminal && runID != nil {
		facts := p.state.RunFacts[runID.String()]
		facts.Outcome = "unknown"
		p.state.RunFacts[runID.String()] = facts
		observations = append(
			observations,
			Observation{
				Kind:            "terminal_outcome",
				Payload:         mustJSON(map[string]any{"outcome": "unknown", "observedAt": observedAt}),
				RunID:           runID,
				HistoryComplete: historyComplete,
				ExternalPrintID: externalID,
			},
		)
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
		p.state.RunTimedOut = false
		p.state.DisconnectedAt = nil
		observations = append(
			observations,
			Observation{
				Kind:            "terminal_outcome",
				Payload:         mustJSON(map[string]any{"outcome": outcome, "observedAt": observedAt}),
				RunID:           runID,
				HistoryComplete: historyComplete,
				ExternalPrintID: externalID,
			},
		)
	}

	observations = append(
		observations,
		p.errorTransitions(printState, observedAt, runID, externalID, historyComplete)...)
	observations = append(
		observations,
		p.slotTransitions(printState, observedAt, runID, externalID, historyComplete)...)
	tray := firstScalar(printState, "tray_now")
	if ams := objectAt(printState, "ams"); tray == "" {
		tray = firstScalar(ams, "tray_now")
	}
	if active && tray != "" && tray != "255" && tray != p.state.LastTray {
		if p.state.LastTray != "" {
			observations = append(
				observations,
				Observation{
					Kind: "filament_change",
					Payload: mustJSON(
						map[string]any{
							"fromSlotExternalId": p.state.LastTray,
							"toSlotExternalId":   tray,
							"observedAt":         observedAt,
						},
					),
					RunID:           runID,
					HistoryComplete: historyComplete,
					ExternalPrintID: externalID,
				},
			)
		}
		p.state.LastTray = tray
	}
	if !suppressTimedOutSession {
		p.state.Lifecycle = lifecycle
	}
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
		return nil, errors.New("Bambu MQTT object nesting is too deep")
	}
	result := make(map[string]any, len(current)+len(patch))
	for key, value := range current {
		result[key] = value
	}
	for key, value := range patch {
		if len(key) > 200 {
			return nil, errors.New("Bambu MQTT object key is too long")
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
	value := firstScalar(state, "subtask_name")
	if value == "" {
		value = bambuArtifactPath(state)
		if slash := strings.LastIndex(value, "/"); slash >= 0 {
			value = value[slash+1:]
		}
	}
	if len(value) > 255 {
		return value[:255]
	}
	return value
}

func bambuArtifactPath(state map[string]any) string {
	// H2D commonly reports /data/Metadata/plate_N.gcode here. That is a path
	// inside the active 3MF, not a file exposed by FTPS. Prefer an explicitly
	// reported archive name. When it is absent, H2D stores the archive under
	// the exact print name plus ".gcode.3mf"; retain the complete print name
	// (including suffixes such as ".stl") and still require an exact FTPS match.
	for _, key := range []string{"file", "filename", "gcode_file"} {
		value := strings.TrimSpace(scalarString(state[key]))
		if !isBambuArchivePath(value) {
			continue
		}
		if len(value) > 255 {
			return value[:255]
		}
		return value
	}
	printName := strings.TrimSpace(scalarString(state["subtask_name"]))
	if printName == "" || printName == "." || printName == ".." || strings.ContainsAny(printName, `/\`) {
		return ""
	}
	for _, character := range printName {
		if character < 0x20 || character == 0x7f {
			return ""
		}
	}
	candidate := printName + ".gcode.3mf"
	if len(candidate) > 255 {
		return ""
	}
	return candidate
}

func isBambuArchivePath(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.HasSuffix(value, ".3mf")
}

func bambuOperationalState(state map[string]any, lifecycle string, observedAt time.Time) json.RawMessage {
	result := map[string]any{"state": lifecycle, "observedAt": observedAt}
	if fileName := bambuFileName(state); fileName != "" {
		result["fileName"] = fileName
	}
	if artifactPath := bambuArtifactPath(state); artifactPath != "" {
		result["artifactPath"] = artifactPath
	}
	return mustJSON(result)
}

// bambuTrayRef is one filament holder in the merged status document: a tray of
// an AMS unit or an external spool holder from vir_slot[]. An external holder
// is reported as a unit of its own whose external ID is also its slot ID.
type bambuTrayRef struct {
	unitID, trayID string
	tray           map[string]any
	external       bool
	unit           map[string]any
}

// Bambu uses an all-zero tag UID for holders without a readable RFID tag.
// Keep that sentinel out of authoritative spool evidence: only a real tag may
// participate in exact historical NFC matching.
func bambuTagUID(tray map[string]any) string {
	tag := strings.TrimSpace(firstScalar(tray, "tag_uid"))
	if tag == "" || isZeroIdentifier(tag) {
		return ""
	}
	return tag
}

// bambuTrayRefs lists AMS trays first and external holders last. The second
// result is whether the document contained any AMS unit or external holder.
func bambuTrayRefs(state map[string]any) ([]bambuTrayRef, bool) {
	var refs []bambuTrayRef
	ams := objectAt(state, "ams")
	units, _ := ams["ams"].([]any)
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
			refs = append(refs, bambuTrayRef{unitID: unitID, trayID: trayID, tray: tray, unit: unit})
		}
	}
	external, _ := state["vir_slot"].([]any)
	for _, raw := range external {
		tray, _ := raw.(map[string]any)
		if id := firstScalar(tray, "id", "tray_id"); id != "" {
			refs = append(refs, bambuTrayRef{unitID: id, trayID: id, tray: tray, external: true})
		}
	}
	return refs, len(units) > 0 || len(external) > 0
}

// bambuActiveSlot resolves tray_now only when it identifies exactly one tray
// in the merged status document. A bare tray number is intentionally not
// guessed across multiple AMS units because tray numbers repeat. External
// spool holders are addressed by their vir_slot ID. The tray_now value 255 is
// ambiguous: legacy status uses it for no selected tray, while H2D can identify
// external holder 255 only through per-hotend routing. It is therefore never
// resolved from tray_now alone. A bare
// tray_now of 128 or more may name a single-tray AMS HT unit by its unit ID;
// that is an assumption pending real captures.
func bambuActiveSlot(state map[string]any) (string, string, string, bool) {
	if unitID, trayID, tagUID, ok := bambuActiveExtruderSlot(state); ok {
		return unitID, trayID, tagUID, true
	}
	ams := objectAt(state, "ams")
	trayNow := firstScalar(state, "tray_now")
	if trayNow == "" {
		trayNow = firstScalar(ams, "tray_now")
	}
	if trayNow == "" || trayNow == "255" {
		return "", "", "", false
	}
	requestedUnit, requestedTray := "", trayNow
	if before, after, found := strings.Cut(trayNow, ":"); found {
		requestedUnit, requestedTray = strings.TrimSpace(before), strings.TrimSpace(after)
		if requestedUnit == "" || requestedTray == "" {
			return "", "", "", false
		}
	}
	refs, _ := bambuTrayRefs(state)
	var matches []bambuTrayRef
	for _, ref := range refs {
		if requestedUnit != "" && requestedUnit != ref.unitID {
			continue
		}
		if ref.trayID == requestedTray {
			matches = append(matches, ref)
		}
	}
	if len(matches) == 0 && requestedUnit == "" {
		if number, err := strconv.Atoi(requestedTray); err == nil && number >= 128 && number < 254 {
			for _, ref := range refs {
				if !ref.external && ref.unitID == requestedTray {
					matches = append(matches, ref)
				}
			}
			if len(matches) != 1 {
				matches = nil
			} else if trays, _ := matches[0].unit["tray"].([]any); len(trays) != 1 {
				matches = nil
			}
		}
	}
	if len(matches) != 1 {
		return "", "", "", false
	}
	return matches[0].unitID, matches[0].trayID, bambuTagUID(matches[0].tray), true
}

func bambuActiveSlotFor(adapterKind string, state map[string]any) (string, string, string, bool) {
	if adapterKind == bambuX1CAdapterKind {
		return bambuX1CActiveSlot(state)
	}
	return bambuActiveSlot(state)
}

// X1C reports tray_now as a global AMS tray index: unit*4+tray. Value 255 is
// also emitted while no tray is selected, even when vir_slot 255 retains
// descriptive material data, so it must never become run spool evidence.
func bambuX1CActiveSlot(state map[string]any) (string, string, string, bool) {
	ams := objectAt(state, "ams")
	value := firstScalar(ams, "tray_now")
	if value == "" {
		value = firstScalar(state, "tray_now")
	}
	if value == "255" {
		return "", "", "", false
	}
	index, err := strconv.Atoi(value)
	if err != nil || index < 0 || index > 15 {
		return "", "", "", false
	}
	unitID, trayID := strconv.Itoa(index/4), strconv.Itoa(index%4)
	refs, _ := bambuTrayRefs(state)
	for _, ref := range refs {
		if !ref.external && ref.unitID == unitID && ref.trayID == trayID {
			return unitID, trayID, bambuTagUID(ref.tray), true
		}
	}
	return "", "", "", false
}

type bambuExtruderRoute struct {
	slicerFilamentID string
	extruderID       int
	ref              bambuTrayRef
}

func bambuSpoolRoutesFor(adapterKind string, state map[string]any) []bambuExtruderRoute {
	if adapterKind == bambuX1CAdapterKind {
		if routes := bambuX1CMaterialRoutes(state); len(routes) > 0 {
			return routes
		}
		unitID, trayID, _, ok := bambuX1CActiveSlot(state)
		if !ok {
			return nil
		}
		refs, _ := bambuTrayRefs(state)
		for _, ref := range refs {
			if ref.unitID == unitID && ref.trayID == trayID {
				// Bambu 3MF metadata numbers the X1C's sole physical extruder as 1.
				return []bambuExtruderRoute{{extruderID: 1, ref: ref}}
			}
		}
		return nil
	}
	return bambuExtruderSlots(state)
}

// bambuX1CMaterialRoutes resolves the print's explicit slicer-filament to AMS
// mapping. Array indexes are Bambu's zero-based G-code filament numbers while
// slice_info uses one-based IDs, so index 2 maps to slicer filament "3".
// This mapping is authoritative for a run; tray_now is only the currently
// selected physical tray and may still contain a stale value during startup.
func bambuX1CMaterialRoutes(state map[string]any) []bambuExtruderRoute {
	refs, _ := bambuTrayRefs(state)
	findRef := func(unitID, trayID string) (bambuTrayRef, bool) {
		for _, ref := range refs {
			if !ref.external && ref.unitID == unitID && ref.trayID == trayID {
				return ref, true
			}
		}
		return bambuTrayRef{}, false
	}
	var routes []bambuExtruderRoute
	if mappings, ok := state["ams_mapping2"].([]any); ok {
		for index, raw := range mappings {
			entry, _ := raw.(map[string]any)
			unit, unitOK := boundedInt(entry["ams_id"], 0, 255)
			tray, trayOK := boundedInt(entry["slot_id"], 0, 255)
			if !unitOK || !trayOK || (unit == 255 && tray == 255) {
				continue
			}
			ref, found := findRef(strconv.Itoa(unit), strconv.Itoa(tray))
			if found {
				routes = append(
					routes,
					bambuExtruderRoute{slicerFilamentID: strconv.Itoa(index + 1), extruderID: 1, ref: ref},
				)
			}
		}
	}
	if len(routes) > 0 {
		return routes
	}
	// Older X1C payloads expose only a global AMS slot index. Values outside
	// 0..15 are sentinels or external-holder states and remain unresolved.
	if mappings, ok := state["ams_mapping"].([]any); ok {
		for index, raw := range mappings {
			globalSlot, valid := boundedInt(raw, 0, 15)
			if !valid {
				continue
			}
			ref, found := findRef(strconv.Itoa(globalSlot/4), strconv.Itoa(globalSlot%4))
			if found {
				routes = append(
					routes,
					bambuExtruderRoute{slicerFilamentID: strconv.Itoa(index + 1), extruderID: 1, ref: ref},
				)
			}
		}
	}
	return routes
}

// bambuExtruderSlots reads H2-family per-hotend routing. The low byte of snow
// is the tray number. AMS unit info identifies which physical extruder that
// unit feeds; the high-byte interpretation is retained only as a compatibility
// fallback for older partial reports that omit AMS info.
func bambuExtruderSlots(state map[string]any) []bambuExtruderRoute {
	extruder := objectAt(objectAt(state, "device"), "extruder")
	info, _ := extruder["info"].([]any)
	if len(info) == 0 {
		return nil
	}
	refs, _ := bambuTrayRefs(state)
	candidates := make([]bambuExtruderRoute, 0, 2)
	for _, raw := range info {
		entry, _ := raw.(map[string]any)
		extruderID, idOK := boundedInt(entry["id"], 0, 15)
		snow, snowOK := boundedInt(entry["snow"], 0, 0xffff)
		if !idOK || !snowOK || snow == 0xffff {
			continue
		}
		// When present, bit 1 says whether this hotend actually holds
		// filament. Older reports omit `info`, so absence is not failure.
		if _, present := entry["info"]; present {
			flags, ok := boundedInt(entry["info"], 0, math.MaxInt32)
			if !ok || flags&0b10 == 0 {
				continue
			}
		}
		highByte := (snow >> 8) & 0xff
		lowByte := snow & 0xff
		if lowByte == 0xff {
			continue
		}
		unitID := ""
		slotID := strconv.Itoa(lowByte)
		// H2D encodes its two external holders as unit 254/255, slot 0;
		// normalized topology represents each holder as a same-ID unit/slot.
		if (highByte == 254 || highByte == 255) && lowByte == 0 {
			unitID = strconv.Itoa(highByte)
			slotID = unitID
		}
		matches := make([]bambuTrayRef, 0, 1)
		for _, ref := range refs {
			if ref.external || ref.trayID != slotID {
				continue
			}
			if boundExtruder, ok := bambuAMSExtruder(ref.unit); ok && boundExtruder == extruderID {
				matches = append(matches, ref)
			}
		}
		if unitID != "" {
			matches = matches[:0]
			for _, ref := range refs {
				if ref.unitID == unitID && ref.trayID == slotID {
					matches = append(matches, ref)
				}
			}
		} else if len(matches) == 0 {
			// Compatibility with reports captured before AMS info is present.
			fallbackUnit := strconv.Itoa(highByte)
			for _, ref := range refs {
				if !ref.external && ref.unitID == fallbackUnit && ref.trayID == slotID {
					matches = append(matches, ref)
				}
			}
		}
		if len(matches) == 1 {
			candidates = append(candidates, bambuExtruderRoute{extruderID: extruderID, ref: matches[0]})
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].extruderID < candidates[j].extruderID })
	return candidates
}

func bambuActiveExtruderSlot(state map[string]any) (string, string, string, bool) {
	extruder := objectAt(objectAt(state, "device"), "extruder")
	activeID := -1
	if rawState, ok := boundedInt(extruder["state"], 0, math.MaxInt32); ok {
		activeID = (rawState >> 8) & 1
	}
	candidates := bambuExtruderSlots(state)
	if activeID >= 0 {
		for _, item := range candidates {
			if item.extruderID == activeID {
				return item.ref.unitID, item.ref.trayID, bambuTagUID(item.ref.tray), true
			}
		}
		// The active hotend may briefly report no tray while unloading even
		// though the inactive hotend still has filament loaded. Do not fall
		// through to that other hotend: doing so replaces the run's last
		// trustworthy AMS slot with an unrelated external holder.
		return "", "", "", false
	}
	if len(candidates) != 1 {
		return "", "", "", false
	}
	item := candidates[0]
	return item.ref.unitID, item.ref.trayID, bambuTagUID(item.ref.tray), true
}

func bambuAMSExtruder(unit map[string]any) (int, bool) {
	raw := strings.TrimSpace(firstScalar(unit, "info"))
	if raw == "" {
		return 0, false
	}
	// Bambu reports this bitfield as an eight-character hexadecimal string.
	value, err := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(raw), "0x"), 16, 32)
	if err != nil {
		return 0, false
	}
	return int((value >> 8) & 0x0f), true
}

func containsBambuSpoolEvidence(values []bambuSpoolEvidence, candidate bambuSpoolEvidence) bool {
	for _, existing := range values {
		if existing.SlicerFilamentID == candidate.SlicerFilamentID && existing.Extruder == candidate.Extruder &&
			existing.InputUnitExternalID == candidate.InputUnitExternalID &&
			existing.SlotExternalID == candidate.SlotExternalID &&
			existing.TagUID == candidate.TagUID {
			return true
		}
	}
	return false
}

func bambuProgress(state map[string]any, observedAt time.Time) json.RawMessage {
	result := map[string]any{"state": "printing", "observedAt": observedAt}
	if fileName := bambuFileName(state); fileName != "" {
		result["fileName"] = fileName
	}
	if artifactPath := bambuArtifactPath(state); artifactPath != "" {
		result["artifactPath"] = artifactPath
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

func (p *bambuProcessor) errorTransitions(
	state map[string]any,
	at time.Time,
	runID *uuid.UUID,
	externalID *string,
	historyComplete bool,
) []Observation {
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
		result = append(
			result,
			Observation{
				Kind: "printer_error",
				Payload: mustJSON(
					map[string]any{"sourceFamily": family, "code": code, "transition": transition, "observedAt": at},
				),
				RunID:           runID,
				HistoryComplete: historyComplete,
				ExternalPrintID: externalID,
			},
		)
	}
	p.state.ActiveErrors = current
	return result
}

func (p *bambuProcessor) slotTransitions(
	state map[string]any,
	at time.Time,
	runID *uuid.UUID,
	externalID *string,
	historyComplete bool,
) []Observation {
	refs, anyHolder := bambuTrayRefs(state)
	currentKeys := map[string]bool{}
	var result []Observation
	for _, ref := range refs {
		unitID, trayID, tray := ref.unitID, ref.trayID, ref.tray
		slotKey := unitID + ":" + trayID
		currentKeys[slotKey] = true
		payload := map[string]any{
			"inputUnitExternalId": unitID,
			"slotExternalId":      trayID,
			"externalSlotKey":     slotKey,
			"freshness":           "live",
		}
		tagUID := bambuTagUID(tray)
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
		result = append(
			result,
			Observation{Kind: "slot_observation", Payload: mustJSON(payload), HistoryComplete: historyComplete},
		)
	}
	for key := range p.state.LastSlots {
		if !currentKeys[key] && anyHolder {
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
