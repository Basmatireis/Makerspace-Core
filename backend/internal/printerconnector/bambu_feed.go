package printerconnector

import (
	"strconv"
	"time"
)

// maxBambuFeedSegments bounds the feed timeline kept per run. Run facts of the
// last 64 sessions live in the encrypted reducer state, so the timeline must
// stay small; a run that needs more segments falls back to its spool evidence.
const maxBambuFeedSegments = 24

// maxBambuFeedSlots bounds the per-slot load bookkeeping of the current run.
const maxBambuFeedSlots = 64

// bambuFeedLine is the physical supply of one consumption line over a run: the
// spools that fed it, in the order they started. A line is keyed by the slicer
// filament when the printer reports an explicit mapping (X1C ams_mapping) and
// otherwise by the physical extruder; an extruder printing several colours
// then has one line per colour.
type bambuFeedLine struct {
	SlicerFilamentID string             `json:"slicerFilamentId,omitempty"`
	Extruder         int                `json:"extruder"`
	Segments         []bambuFeedSegment `json:"segments"`
}

// bambuFeedSegment is one spool feeding a line from StartedAt until the next
// segment of the same line starts.
type bambuFeedSegment struct {
	InputUnitExternalID string `json:"inputUnitExternalId"`
	SlotExternalID      string `json:"slotExternalId"`
	TagUID              string `json:"tagUid,omitempty"`
	// SlotLoad counts how often the slot was confirmed empty and then loaded
	// again during the run. It tells two tagless spools in one slot apart.
	SlotLoad      int       `json:"slotLoad,omitempty"`
	StartedAt     time.Time `json:"startedAt"`
	StartLayer    *int      `json:"startLayer,omitempty"`
	StartProgress *float64  `json:"startProgress,omitempty"`
}

// bambuFeedTracker is reducer bookkeeping for the current run only; it is reset
// when another run becomes current.
type bambuFeedTracker struct {
	RunID string `json:"runId"`
	// SlotLoads is the SlotLoad generation of each "unit:slot".
	SlotLoads map[string]int `json:"slotLoads,omitempty"`
	// EmptyCounts counts consecutive statuses reporting a slot as empty.
	EmptyCounts map[string]uint8 `json:"emptyCounts,omitempty"`
	// Current is the line index that last fed each route key.
	Current map[string]int `json:"current,omitempty"`
}

type bambuFeedSource struct {
	slicerFilamentID string
	extruder         int
	unitID, slotID   string
	tagUID           string
	slotLoad         int
}

func (s bambuFeedSource) routeKey() string {
	if s.slicerFilamentID != "" {
		return "filament:" + s.slicerFilamentID
	}
	return "extruder:" + strconv.Itoa(s.extruder)
}

func (s bambuFeedSource) compatible(segment bambuFeedSegment) bool {
	// An unread tag is compatible with any tag: Bambu reports an all-zero UID
	// while an RFID read is pending or failed, which is not a spool change.
	return s.unitID == segment.InputUnitExternalID && s.slotID == segment.SlotExternalID &&
		s.slotLoad == segment.SlotLoad &&
		(s.tagUID == "" || segment.TagUID == "" || s.tagUID == segment.TagUID)
}

func (p *bambuProcessor) feedTracker(runID string) *bambuFeedTracker {
	if p.state.Feed == nil || p.state.Feed.RunID != runID {
		p.state.Feed = &bambuFeedTracker{RunID: runID}
	}
	if p.state.Feed.SlotLoads == nil {
		p.state.Feed.SlotLoads = map[string]int{}
	}
	if p.state.Feed.EmptyCounts == nil {
		p.state.Feed.EmptyCounts = map[string]uint8{}
	}
	if p.state.Feed.Current == nil {
		p.state.Feed.Current = map[string]int{}
	}
	return p.state.Feed
}

// recordBambuFeed extends the run's feed timeline from one active status.
//
// A new segment starts only when the physical source of the same line changes:
// the slot feeding it was confirmed empty and loaded again, its RFID tag
// changed, or the line moved on from a slot that is now empty (AMS backup
// refill). Multi-colour printing through one nozzle moves the feed between
// lines constantly; a move to a slot that is not empty is such a colour change
// and opens or resumes another line instead of splitting one.
//
// Assumptions pending real captures: an AMS reports a run-out tray as absent in
// tray_exist_bits; on X1C, ams_mapping keeps naming the original tray after a
// backup refill while tray_now names the backup tray (if the firmware rewrites
// ams_mapping instead, the mapped route moves and is recorded the same way).
// External holders have no presence bit and are never confirmed empty.
func (p *bambuProcessor) recordBambuFeed(
	runID string,
	facts *bambuRunFacts,
	lifecycle string,
	printState map[string]any,
	observedAt time.Time,
) {
	if !facts.FeedTracked {
		// A run already under way before feed tracking existed keeps its
		// recorded spool evidence; a partial timeline would misattribute it.
		if len(facts.SpoolEvidence) > 0 {
			return
		}
		facts.FeedTracked = true
	}
	tracker := p.feedTracker(runID)
	refs, _ := bambuTrayRefs(printState)
	existBits := scalarString(objectAt(printState, "ams")["tray_exist_bits"])
	empty := map[string]bool{}
	for _, ref := range refs {
		if bambuFeedSlotEmpty(ref, existBits) {
			empty[ref.unitID+":"+ref.trayID] = true
		}
	}
	tracker.observeSlotLoads(refs, empty)
	if facts.FeedOverflow {
		return
	}
	recorder := bambuFeedRecorder{
		facts:   facts,
		tracker: tracker,
		empty:   empty,
		segment: bambuFeedSegment{StartedAt: observedAt.UTC()},
		started: lifecycle != "PREPARE" && facts.LastLayer != nil && *facts.LastLayer > 0,
	}
	if recorder.started {
		layer := *facts.LastLayer
		recorder.segment.StartLayer = &layer
	}
	if facts.LastProgress != nil {
		progress := *facts.LastProgress
		recorder.segment.StartProgress = &progress
	}
	routes := bambuSpoolRoutesFor(p.adapterKind, printState)
	explicit := false
	for _, route := range routes {
		explicit = explicit || route.slicerFilamentID != ""
	}
	if !explicit {
		for _, route := range routes {
			recorder.observe(tracker.source(route.slicerFilamentID, route.extruderID, route.ref))
		}
		return
	}
	recorder.observeMappedRoutes(p.adapterKind, printState, routes, refs)
}

// observeMappedRoutes handles an explicit slicer-filament mapping. The mapping
// names the tray each filament starts from; tray_now says which tray actually
// feeds. A fed tray outside the mapping is a backup tray and is attributed only
// when exactly one filament can be its origin.
func (r *bambuFeedRecorder) observeMappedRoutes(
	adapterKind AdapterKind,
	printState map[string]any,
	routes []bambuExtruderRoute,
	refs []bambuTrayRef,
) {
	keys := map[string]bambuExtruderRoute{}
	for _, route := range routes {
		if route.slicerFilamentID == "" {
			continue
		}
		source := r.tracker.source(route.slicerFilamentID, route.extruderID, route.ref)
		keys[source.routeKey()] = route
		if len(r.linesFor(source.routeKey())) == 0 {
			r.observe(source)
		}
	}
	unitID, slotID, _, ok := bambuActiveSlotFor(adapterKind, printState)
	if !ok {
		return
	}
	var active bambuTrayRef
	for _, ref := range refs {
		if !ref.external && ref.unitID == unitID && ref.trayID == slotID {
			active = ref
		}
	}
	if active.unitID == "" {
		return
	}
	mapped := false
	for _, route := range routes {
		if route.slicerFilamentID != "" && route.ref.unitID == unitID && route.ref.trayID == slotID {
			mapped = true
			r.observe(r.tracker.source(route.slicerFilamentID, route.extruderID, active))
		}
	}
	if mapped {
		return
	}
	var alreadyFed, runOut []bambuExtruderRoute
	for key, route := range keys {
		for _, index := range r.linesFor(key) {
			line := r.facts.FeedLines[index]
			for _, segment := range line.Segments {
				if segment.InputUnitExternalID == unitID && segment.SlotExternalID == slotID {
					alreadyFed = append(alreadyFed, route)
					break
				}
			}
			last := line.Segments[len(line.Segments)-1]
			if r.empty[last.InputUnitExternalID+":"+last.SlotExternalID] {
				runOut = append(runOut, route)
			}
		}
	}
	var origin []bambuExtruderRoute
	switch {
	case len(alreadyFed) > 0:
		origin = alreadyFed
	case len(runOut) > 0:
		origin = runOut
	default:
		for _, route := range keys {
			origin = append(origin, route)
		}
	}
	if len(origin) == 1 {
		r.observe(r.tracker.source(origin[0].slicerFilamentID, origin[0].extruderID, active))
	}
}

type bambuFeedRecorder struct {
	facts   *bambuRunFacts
	tracker *bambuFeedTracker
	empty   map[string]bool
	segment bambuFeedSegment
	started bool
}

func (r *bambuFeedRecorder) linesFor(key string) []int {
	var result []int
	for index, line := range r.facts.FeedLines {
		if (bambuFeedSource{slicerFilamentID: line.SlicerFilamentID, extruder: line.Extruder}).routeKey() == key {
			result = append(result, index)
		}
	}
	return result
}

func (r *bambuFeedRecorder) observe(source bambuFeedSource) {
	key := source.routeKey()
	lines := r.linesFor(key)
	// The source still feeds, or feeds again, a line it already belongs to.
	for _, index := range lines {
		segments := r.facts.FeedLines[index].Segments
		if last := &segments[len(segments)-1]; source.compatible(*last) {
			if last.TagUID == "" && source.tagUID != "" {
				last.TagUID = source.tagUID
			}
			r.tracker.Current[key] = index
			return
		}
	}
	for _, index := range lines {
		for _, segment := range r.facts.FeedLines[index].Segments {
			if source.compatible(segment) {
				r.tracker.Current[key] = index
				return
			}
		}
	}
	target := -1
	switch {
	case source.slicerFilamentID != "" && len(lines) == 1:
		// An explicit slicer filament is one line by definition.
		target = lines[0]
	default:
		// Another spool in the same slot continues the line that slot fed.
		var sameSlot []int
		for _, index := range lines {
			segments := r.facts.FeedLines[index].Segments
			last := segments[len(segments)-1]
			if last.InputUnitExternalID == source.unitID && last.SlotExternalID == source.slotID {
				sameSlot = append(sameSlot, index)
			}
		}
		if len(sameSlot) == 1 {
			target = sameSlot[0]
		} else if current, ok := r.tracker.Current[key]; ok && current < len(r.facts.FeedLines) && len(sameSlot) == 0 {
			// The line moved on from a slot that ran empty: a backup spool.
			segments := r.facts.FeedLines[current].Segments
			last := segments[len(segments)-1]
			if r.empty[last.InputUnitExternalID+":"+last.SlotExternalID] {
				target = current
			}
		}
	}
	if r.totalSegments() >= maxBambuFeedSegments {
		r.facts.FeedOverflow = true
		return
	}
	segment := r.segment
	segment.InputUnitExternalID = source.unitID
	segment.SlotExternalID = source.slotID
	segment.TagUID = source.tagUID
	segment.SlotLoad = source.slotLoad
	if target < 0 {
		r.facts.FeedLines = append(
			r.facts.FeedLines,
			bambuFeedLine{
				SlicerFilamentID: source.slicerFilamentID,
				Extruder:         source.extruder,
				Segments:         []bambuFeedSegment{segment},
			},
		)
		r.tracker.Current[key] = len(r.facts.FeedLines) - 1
		return
	}
	line := &r.facts.FeedLines[target]
	last := &line.Segments[len(line.Segments)-1]
	if !r.started && (last.StartLayer == nil || *last.StartLayer <= 0) {
		// Nothing was printed since the previous source started, for example
		// while the printer loads filament before the first layer: replace it
		// instead of recording a segment without consumption.
		segment.StartedAt = last.StartedAt
		*last = segment
	} else {
		line.Segments = append(line.Segments, segment)
	}
	r.tracker.Current[key] = target
}

func (r *bambuFeedRecorder) totalSegments() int {
	total := 0
	for _, line := range r.facts.FeedLines {
		total += len(line.Segments)
	}
	return total
}

func (t *bambuFeedTracker) source(slicerFilamentID string, extruder int, ref bambuTrayRef) bambuFeedSource {
	return bambuFeedSource{
		slicerFilamentID: slicerFilamentID,
		extruder:         extruder,
		unitID:           ref.unitID,
		slotID:           ref.trayID,
		tagUID:           bambuTagUID(ref.tray),
		slotLoad:         t.SlotLoads[ref.unitID+":"+ref.trayID],
	}
}

// observeSlotLoads advances a slot's load generation when it was reported
// empty in two consecutive statuses and is loaded again. A single absent
// report may be a transient read and does not count.
func (t *bambuFeedTracker) observeSlotLoads(refs []bambuTrayRef, empty map[string]bool) {
	for _, ref := range refs {
		key := ref.unitID + ":" + ref.trayID
		if empty[key] {
			if _, known := t.EmptyCounts[key]; !known && len(t.EmptyCounts) >= maxBambuFeedSlots {
				continue
			}
			if t.EmptyCounts[key] < 2 {
				t.EmptyCounts[key]++
			}
			continue
		}
		if t.EmptyCounts[key] >= 2 {
			if _, known := t.SlotLoads[key]; known || len(t.SlotLoads) < maxBambuFeedSlots {
				t.SlotLoads[key]++
			}
		}
		delete(t.EmptyCounts, key)
	}
}

// bambuFeedSlotEmpty trusts only the AMS presence bitmask. Tray material
// fields may be retained for an absent spool and are blank for a loaded
// spool without RFID, so they cannot say whether a tray is empty.
func bambuFeedSlotEmpty(ref bambuTrayRef, existBits string) bool {
	if ref.external {
		return false
	}
	present, known := bambuTrayExistBit(existBits, ref.unitID, ref.trayID)
	return known && !present
}
