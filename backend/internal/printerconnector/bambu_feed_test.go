package printerconnector

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/parser"
)

// x1cFeedDocument is an X1C print mapping slicer filament 1 to AMS 0 tray 0
// and filament 2 to tray 2; tray 1 holds a spare spool of the first material.
const x1cFeedDocument = `{"print":{"gcode_state":"RUNNING","task_id":"77","layer_num":1,"mc_percent":1,` +
	`"ams_mapping2":[{"ams_id":0,"slot_id":0},{"ams_id":0,"slot_id":2}],` +
	`"ams":{"tray_now":"0","tray_exist_bits":"7","ams":[{"id":"0","tray":[` +
	`{"id":"0","tag_uid":"AAAA","tray_type":"PLA"},{"id":"1","tag_uid":"BBBB","tray_type":"PLA"},` +
	`{"id":"2","tag_uid":"CCCC","tray_type":"PETG"}]}]}}}`

// x1cSingleFeedDocument maps only slicer filament 1, to AMS 0 tray 0.
const x1cSingleFeedDocument = `{"print":{"gcode_state":"RUNNING","task_id":"78","layer_num":1,"mc_percent":1,` +
	`"ams_mapping2":[{"ams_id":0,"slot_id":0}],` +
	`"ams":{"tray_now":"0","tray_exist_bits":"3","ams":[{"id":"0","tray":[` +
	`{"id":"0","tag_uid":"AAAA","tray_type":"PLA"},{"id":"1","tag_uid":"BBBB","tray_type":"PLA"}]}]}}}`

// x1cUnmappedFeedDocument has no slicer mapping, so routes are keyed by the
// single extruder; tray 0 holds a third-party spool without RFID.
const x1cUnmappedFeedDocument = `{"print":{"gcode_state":"RUNNING","task_id":"79","layer_num":1,"mc_percent":1,` +
	`"ams":{"tray_now":"0","tray_exist_bits":"3","ams":[{"id":"0","tray":[` +
	`{"id":"0","tag_uid":"0000000000000000","tray_type":"PLA"},{"id":"1","tag_uid":"BBBB","tray_type":"PLA"}]}]}}}`

// h2dFeedDocument binds AMS 0 to extruder 0 and AMS HT 128 to extruder 1.
const h2dFeedDocument = `{"print":{"gcode_state":"RUNNING","task_id":"88","layer_num":1,"mc_percent":1,` +
	`"device":{"extruder":{"state":0,"info":[{"id":0,"snow":0,"info":2},{"id":1,"snow":32768,"info":2}]}},` +
	`"ams":{"tray_now":"255","tray_exist_bits":"10003","ams":[` +
	`{"id":"0","info":"10001003","tray":[{"id":"0","tag_uid":"LEFTA","tray_type":"PLA"},` +
	`{"id":"1","tag_uid":"LEFTB","tray_type":"PLA"}]},` +
	`{"id":"128","info":"51002104","tray":[{"id":"0","tag_uid":"RIGHT","tray_type":"PETG"}]}]}}}`

func TestBambuFeedTimeline(t *testing.T) {
	t.Parallel()
	type segment struct {
		slot  string
		tag   string
		load  int
		layer int // 0 means no start layer
	}
	type line struct {
		filament string
		extruder int
		segments []segment
	}
	tests := []struct {
		name        string
		adapterKind AdapterKind
		statuses    []string
		want        []line
	}{
		{
			name:        "multi-colour single nozzle with explicit mapping",
			adapterKind: AdapterBambuX1C,
			statuses: []string{
				x1cFeedDocument,
				`{"print":{"layer_num":3,"ams":{"tray_now":"2"}}}`,
				`{"print":{"layer_num":4,"ams":{"tray_now":"0"}}}`,
				`{"print":{"layer_num":5,"ams":{"tray_now":"2"}}}`,
			},
			want: []line{
				{filament: "1", extruder: 1, segments: []segment{{slot: "0", tag: "AAAA"}}},
				{filament: "2", extruder: 1, segments: []segment{{slot: "2", tag: "CCCC"}}},
			},
		},
		{
			name:        "multi-colour single nozzle without mapping",
			adapterKind: AdapterBambuX1C,
			statuses: []string{
				x1cUnmappedFeedDocument,
				`{"print":{"layer_num":3,"ams":{"tray_now":"1"}}}`,
				`{"print":{"layer_num":4,"ams":{"tray_now":"0"}}}`,
				`{"print":{"layer_num":5,"ams":{"tray_now":"1"}}}`,
			},
			want: []line{
				{extruder: 1, segments: []segment{{slot: "0"}}},
				{extruder: 1, segments: []segment{{slot: "1", tag: "BBBB", layer: 3}}},
			},
		},
		{
			name:        "same-slot refill with a new tag",
			adapterKind: AdapterBambuX1C,
			statuses: []string{
				x1cSingleFeedDocument,
				`{"print":{"layer_num":40,"gcode_state":"PAUSE","ams":{"tray_now":"0","ams":[{"id":"0","tray":[` +
					`{"id":"0","tag_uid":"DDDD","tray_type":"PLA"},{"id":"1","tag_uid":"BBBB","tray_type":"PLA"}]}]}}}`,
				`{"print":{"layer_num":41,"gcode_state":"RUNNING"}}`,
			},
			want: []line{
				{filament: "1", extruder: 1, segments: []segment{{slot: "0", tag: "AAAA"}, {slot: "0", tag: "DDDD", layer: 40}}},
			},
		},
		{
			name:        "same-slot tagless refill after the slot was empty",
			adapterKind: AdapterBambuX1C,
			statuses: []string{
				x1cUnmappedFeedDocument,
				`{"print":{"layer_num":50,"gcode_state":"PAUSE","ams":{"tray_exist_bits":"2"}}}`,
				`{"print":{"layer_num":50,"ams":{"tray_exist_bits":"2"}}}`,
				`{"print":{"layer_num":50,"ams":{"tray_exist_bits":"3"}}}`,
				`{"print":{"layer_num":51,"gcode_state":"RUNNING"}}`,
			},
			want: []line{
				{extruder: 1, segments: []segment{{slot: "0"}, {slot: "0", load: 1, layer: 50}}},
			},
		},
		{
			name:        "single empty report is not a refill",
			adapterKind: AdapterBambuX1C,
			statuses: []string{
				x1cUnmappedFeedDocument,
				`{"print":{"layer_num":50,"ams":{"tray_exist_bits":"2"}}}`,
				`{"print":{"layer_num":51,"ams":{"tray_exist_bits":"3"}}}`,
			},
			want: []line{{extruder: 1, segments: []segment{{slot: "0"}}}},
		},
		{
			name:        "AMS backup refill from another slot keeps the slicer filament",
			adapterKind: AdapterBambuX1C,
			statuses: []string{
				x1cSingleFeedDocument,
				`{"print":{"layer_num":30,"ams":{"tray_now":"1","tray_exist_bits":"2"}}}`,
				`{"print":{"layer_num":31}}`,
			},
			want: []line{
				{filament: "1", extruder: 1, segments: []segment{{slot: "0", tag: "AAAA"}, {slot: "1", tag: "BBBB", layer: 30}}},
			},
		},
		{
			name:        "AMS backup refill without mapping follows the empty slot",
			adapterKind: AdapterBambuX1C,
			statuses: []string{
				x1cUnmappedFeedDocument,
				`{"print":{"layer_num":30,"ams":{"tray_now":"1","tray_exist_bits":"2"}}}`,
			},
			want: []line{
				{extruder: 1, segments: []segment{{slot: "0"}, {slot: "1", tag: "BBBB", layer: 30}}},
			},
		},
		{
			name:        "H2D two extruders with a backup refill on one",
			adapterKind: AdapterBambuH2D,
			statuses: []string{
				h2dFeedDocument,
				`{"print":{"layer_num":25,"ams":{"tray_exist_bits":"10002"},` +
					`"device":{"extruder":{"info":[{"id":0,"snow":1,"info":2},{"id":1,"snow":32768,"info":2}]}}}}`,
			},
			want: []line{
				{extruder: 0, segments: []segment{{slot: "0", tag: "LEFTA"}, {slot: "1", tag: "LEFTB", layer: 25}}},
				{extruder: 1, segments: []segment{{slot: "0", tag: "RIGHT"}}},
			},
		},
		{
			name:        "H2D colour changes on one extruder are separate lines",
			adapterKind: AdapterBambuH2D,
			statuses: []string{
				h2dFeedDocument,
				`{"print":{"layer_num":2,"device":{"extruder":{"info":[{"id":0,"snow":1,"info":2},{"id":1,"snow":32768,"info":2}]}}}}`,
				`{"print":{"layer_num":3,"device":{"extruder":{"info":[{"id":0,"snow":0,"info":2},{"id":1,"snow":32768,"info":2}]}}}}`,
				`{"print":{"layer_num":4,"device":{"extruder":{"info":[{"id":0,"snow":1,"info":2},{"id":1,"snow":32768,"info":2}]}}}}`,
			},
			want: []line{
				{extruder: 0, segments: []segment{{slot: "0", tag: "LEFTA"}}},
				{extruder: 1, segments: []segment{{slot: "0", tag: "RIGHT"}}},
				{extruder: 0, segments: []segment{{slot: "1", tag: "LEFTB", layer: 2}}},
			},
		},
		{
			name:        "loading before the first layer replaces the previous source",
			adapterKind: AdapterBambuX1C,
			statuses: []string{
				`{"print":{"gcode_state":"PREPARE","task_id":"80","layer_num":0,` +
					`"ams":{"tray_now":"0","tray_exist_bits":"3","ams":[{"id":"0","tray":[` +
					`{"id":"0","tag_uid":"0000000000000000","tray_type":"PLA"},{"id":"1","tag_uid":"BBBB","tray_type":"PLA"}]}]}}}`,
				`{"print":{"ams":{"tray_now":"1","tray_exist_bits":"2"}}}`,
				`{"print":{"gcode_state":"RUNNING","layer_num":1}}`,
			},
			want: []line{{extruder: 1, segments: []segment{{slot: "1", tag: "BBBB"}}}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			processor := newFeedTestProcessor(test.adapterKind)
			at := time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC)
			for index, status := range test.statuses {
				applyFeedStatus(t, processor, status, at.Add(time.Duration(index)*time.Minute))
			}
			facts := processor.state.RunFacts[processor.state.CurrentRunID]
			if !facts.FeedTracked || facts.FeedOverflow {
				t.Fatalf("feed tracked=%v overflow=%v", facts.FeedTracked, facts.FeedOverflow)
			}
			if len(facts.FeedLines) != len(test.want) {
				t.Fatalf("feed lines = %+v", facts.FeedLines)
			}
			for index, want := range test.want {
				got := facts.FeedLines[index]
				if got.SlicerFilamentID != want.filament || got.Extruder != want.extruder ||
					len(got.Segments) != len(want.segments) {
					t.Fatalf("line %d = %+v, want %+v", index, got, want)
				}
				for segmentIndex, wantSegment := range want.segments {
					gotSegment := got.Segments[segmentIndex]
					layer := 0
					if gotSegment.StartLayer != nil {
						layer = *gotSegment.StartLayer
					}
					if gotSegment.SlotExternalID != wantSegment.slot || gotSegment.TagUID != wantSegment.tag ||
						gotSegment.SlotLoad != wantSegment.load || (segmentIndex > 0 && layer != wantSegment.layer) {
						t.Fatalf("line %d segment %d = %+v, want %+v", index, segmentIndex, gotSegment, wantSegment)
					}
				}
			}
		})
	}
}

func TestBambuFeedWithoutSpoolChangeKeepsConsumptionOutput(t *testing.T) {
	t.Parallel()
	grams1, grams2 := 2.5, 4.0
	tests := []struct {
		name        string
		adapterKind AdapterKind
		statuses    []string
		parsed      parser.Result
	}{
		{
			name:        "explicit mapping",
			adapterKind: AdapterBambuX1C,
			statuses: []string{
				x1cFeedDocument,
				`{"print":{"layer_num":3,"ams":{"tray_now":"2"}}}`,
				`{"print":{"layer_num":4,"ams":{"tray_now":"0"}}}`,
			},
			parsed: parser.Result{Filaments: []parser.Filament{
				{ID: "1", WeightGrams: &grams1, Extruders: []int{1}},
				{ID: "2", WeightGrams: &grams2, Extruders: []int{1}},
			}},
		},
		{
			name:        "ordered colour changes on one H2D extruder",
			adapterKind: AdapterBambuH2D,
			statuses: []string{
				h2dFeedDocument,
				`{"print":{"layer_num":2,"device":{"extruder":{"info":[{"id":0,"snow":1,"info":2},{"id":1,"snow":32768,"info":2}]}}}}`,
				`{"print":{"layer_num":3,"device":{"extruder":{"info":[{"id":0,"snow":0,"info":2},{"id":1,"snow":32768,"info":2}]}}}}`,
			},
			parsed: parser.Result{
				Filaments: []parser.Filament{
					{ID: "1", WeightGrams: &grams1, Extruders: []int{0}},
					{ID: "2", WeightGrams: &grams2, Extruders: []int{0}},
				},
				FilamentSequence: []string{"1", "2"},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			processor := newFeedTestProcessor(test.adapterKind)
			at := time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC)
			for index, status := range test.statuses {
				applyFeedStatus(t, processor, status, at.Add(time.Duration(index)*time.Minute))
			}
			facts := processor.state.RunFacts[processor.state.CurrentRunID]
			facts.Outcome = OutcomeCompleted
			withFeed, err := marshalSlicerConsumption(test.parsed, nil, facts)
			if err != nil {
				t.Fatal(err)
			}
			legacy := facts
			legacy.FeedTracked, legacy.FeedLines = false, nil
			withoutFeed, err := marshalSlicerConsumption(test.parsed, nil, legacy)
			if err != nil {
				t.Fatal(err)
			}
			if string(withFeed) != string(withoutFeed) || bytes.Contains(withFeed, []byte("segments")) ||
				bytes.Count(withFeed, []byte("slotExternalId")) != 2 {
				t.Fatalf("feed timeline changed the report:\nwith    %s\nwithout %s", withFeed, withoutFeed)
			}
		})
	}
}

func TestBambuFeedRefillReportsSegmentsInsteadOfOneSpool(t *testing.T) {
	t.Parallel()
	processor := newFeedTestProcessor(AdapterBambuX1C)
	at := time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC)
	applyFeedStatus(t, processor, x1cSingleFeedDocument, at)
	applyFeedStatus(t, processor, `{"print":{"layer_num":10,"mc_percent":25}}`, at.Add(time.Minute))
	applyFeedStatus(
		t,
		processor,
		`{"print":{"layer_num":30,"mc_percent":60,"ams":{"tray_now":"1","tray_exist_bits":"2"}}}`,
		at.Add(2*time.Minute),
	)
	facts := processor.state.RunFacts[processor.state.CurrentRunID]
	facts.Outcome = OutcomeCompleted
	grams := 10.0
	payload, err := marshalSlicerConsumption(
		parser.Result{Filaments: []parser.Filament{{ID: "1", WeightGrams: &grams, Extruders: []int{1}}}},
		nil,
		facts,
	)
	if err != nil {
		t.Fatal(err)
	}
	item := singleReportItem(t, payload)
	if _, set := item["slotExternalId"]; set {
		t.Fatalf("a line fed by two spools must not name one spool: %s", payload)
	}
	segments := reportSegments(t, item)
	if len(segments) != 2 || segments[0]["slotExternalId"] != "0" || segments[0]["tagUid"] != "AAAA" ||
		segments[1]["slotExternalId"] != "1" || segments[1]["tagUid"] != "BBBB" ||
		segments[1]["startLayer"] != float64(30) || segments[1]["startedAt"] != "2026-11-04T09:02:00Z" ||
		segments[0]["estimatedQuantityGrams"] != "6.000000" || segments[1]["estimatedQuantityGrams"] != "4.000000" ||
		segments[0]["split"] != "progress" {
		t.Fatalf("segments = %s", payload)
	}
}

func TestBambuFeedSplitsCompletedPrintByGCodeLayers(t *testing.T) {
	t.Parallel()
	transfer := stageFeedArchive(t)
	two, four := 2, 4
	facts := bambuRunFacts{
		Outcome:         OutcomeCompleted,
		HistoryComplete: true,
		FeedTracked:     true,
		FeedLines: []bambuFeedLine{{Extruder: 1, Segments: []bambuFeedSegment{
			{InputUnitExternalID: "0", SlotExternalID: "0", TagUID: "FIRST"},
			{InputUnitExternalID: "0", SlotExternalID: "0", TagUID: "SECOND", StartLayer: &two},
			{InputUnitExternalID: "0", SlotExternalID: "3", StartLayer: &four},
		}}},
	}
	payload, err := buildBambuConsumptionPayloadFor(AdapterBambuX1C, transfer, facts)
	if err != nil {
		t.Fatal(err)
	}
	item := singleReportItem(t, payload)
	segments := reportSegments(t, item)
	// G-code extrudes 10 mm per layer over four layers: a quarter before
	// layer 2, half in layers 2-3, a quarter from layer 4.
	if item["estimatedQuantityGrams"] != "3.333333" || len(segments) != 3 ||
		segments[0]["estimatedQuantityGrams"] != "0.833333" ||
		segments[1]["estimatedQuantityGrams"] != "1.666667" ||
		segments[2]["estimatedQuantityGrams"] != "0.833333" ||
		segments[0]["split"] != "gcode_layer" || segments[2]["tagUid"] != nil {
		t.Fatalf("completed split = %s", payload)
	}
	assertSegmentsSum(t, item, segments)
}

func TestBambuFeedSplitsInterruptedPrintByGCodeLayers(t *testing.T) {
	t.Parallel()
	transfer := stageFeedArchive(t)
	two, four := 2, 4
	facts := bambuRunFacts{
		Outcome:         OutcomeFailed,
		LastLayer:       &four,
		HistoryComplete: true,
		FeedTracked:     true,
		FeedLines: []bambuFeedLine{{Extruder: 1, Segments: []bambuFeedSegment{
			{InputUnitExternalID: "0", SlotExternalID: "0", TagUID: "FIRST"},
			{InputUnitExternalID: "0", SlotExternalID: "1", TagUID: "SECOND", StartLayer: &two},
		}}},
	}
	payload, err := buildBambuConsumptionPayloadFor(AdapterBambuX1C, transfer, facts)
	if err != nil {
		t.Fatal(err)
	}
	item := singleReportItem(t, payload)
	segments := reportSegments(t, item)
	total, _ := parseMicrograms(item["estimatedQuantityGrams"])
	first, _ := parseMicrograms(segments[0]["estimatedQuantityGrams"])
	// The failed run stopped at the start of layer 4 (30 mm); the second spool
	// started at layer 2 (10 mm).
	if item["method"] != "gcode_checkpoint" || total == 0 || first != (total+1)/3 ||
		segments[1]["split"] != "gcode_layer" {
		t.Fatalf("interrupted split = %s", payload)
	}
	assertSegmentsSum(t, item, segments)
}

func TestBambuFeedSegmentsWithoutLayerOrProgressStayUnsplit(t *testing.T) {
	t.Parallel()
	grams := 5.0
	payload, err := marshalSlicerConsumption(
		parser.Result{Filaments: []parser.Filament{{ID: "1", WeightGrams: &grams}}},
		nil,
		bambuRunFacts{
			Outcome:         OutcomeCompleted,
			HistoryComplete: true,
			FeedTracked:     true,
			FeedLines: []bambuFeedLine{{Extruder: 1, Segments: []bambuFeedSegment{
				{InputUnitExternalID: "0", SlotExternalID: "0"},
				{InputUnitExternalID: "0", SlotExternalID: "1"},
			}}},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	item := singleReportItem(t, payload)
	segments := reportSegments(t, item)
	if _, set := item["slotExternalId"]; set || item["estimatedQuantityGrams"] != "5.000000" || len(segments) != 2 ||
		segments[0]["estimatedQuantityGrams"] != nil || segments[1]["split"] != nil {
		t.Fatalf("unsplittable segments = %s", payload)
	}
}

func TestBambuStateWithoutFeedTimelineStillReportsSpoolEvidence(t *testing.T) {
	t.Parallel()
	// Persisted by a connector version without feed tracking.
	stored := `{"document":{},"ready":true,"currentRunId":"0190f5e2-0000-7000-8000-000000000001",` +
		`"sessions":{"tuple:task_id=5":"0190f5e2-0000-7000-8000-000000000001"},"generation":0,` +
		`"runFacts":{"0190f5e2-0000-7000-8000-000000000001":{"historyComplete":true,"lastLayer":12,` +
		`"spoolEvidence":[{"slicerFilamentId":"1","extruder":1,"inputUnitExternalId":"0","slotExternalId":"0","tagUid":"OLD"}]}},` +
		`"autoDetectSpools":false}`
	var state bambuPersistedState
	if err := json.Unmarshal([]byte(stored), &state); err != nil {
		t.Fatal(err)
	}
	facts := state.RunFacts["0190f5e2-0000-7000-8000-000000000001"]
	if facts.FeedTracked || len(facts.FeedLines) != 0 || state.Feed != nil {
		t.Fatalf("old state decoded with a feed timeline: %+v", facts)
	}
	processor := newFeedTestProcessor(AdapterBambuX1C)
	processor.state = state
	processor.state.LastSlots = map[string]string{}
	processor.state.EmptySlotCounts = map[string]uint8{}
	processor.state.ActiveErrors = map[string]bool{}
	processor.state.Lifecycle = "RUNNING"
	processor.state.CurrentSessionKey = "tuple:task_id=5"
	processor.loaded = true
	applyFeedStatus(
		t,
		processor,
		`{"print":{"gcode_state":"RUNNING","task_id":"5","layer_num":13,"ams_mapping2":[{"ams_id":0,"slot_id":0}],`+
			`"ams":{"tray_now":"1","tray_exist_bits":"2","ams":[{"id":"0","tray":[{"id":"0","tag_uid":"OLD"},{"id":"1","tag_uid":"NEW"}]}]}}}`,
		time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC),
	)
	facts = processor.state.RunFacts["0190f5e2-0000-7000-8000-000000000001"]
	if facts.FeedTracked || len(facts.FeedLines) != 0 {
		t.Fatalf("a run started before feed tracking must keep its spool evidence only: %+v", facts.FeedLines)
	}
	facts.Outcome = OutcomeCompleted
	grams := 1.5
	payload, err := marshalSlicerConsumption(
		parser.Result{Filaments: []parser.Filament{{ID: "1", WeightGrams: &grams}}},
		nil,
		facts,
	)
	if err != nil {
		t.Fatal(err)
	}
	item := singleReportItem(t, payload)
	if item["slotExternalId"] != "0" || item["tagUid"] != "OLD" || item["segments"] != nil {
		t.Fatalf("legacy report = %s", payload)
	}
}

func TestDistributeMicrogramsAddsUpAndStaysNonNegative(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		total      int64
		cumulative []float64
		reference  float64
		want       []int64
	}{
		{name: "proportional", total: 1_000_000, cumulative: []float64{25}, reference: 100, want: []int64{250_000, 750_000}},
		{name: "rounding remainder goes last", total: 10, cumulative: []float64{1, 2}, reference: 3, want: []int64{3, 3, 4}},
		{name: "decreasing measure is clamped", total: 100, cumulative: []float64{60, 40}, reference: 100, want: []int64{60, 0, 40}},
		{name: "measure beyond reference is capped", total: 100, cumulative: []float64{150}, reference: 100, want: []int64{100, 0}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := distributeMicrograms(test.total, test.cumulative, test.reference)
			sum := int64(0)
			for _, value := range got {
				sum += value
			}
			if len(got) != len(test.want) || sum != test.total {
				t.Fatalf("got %v, want %v", got, test.want)
			}
			for index := range got {
				if got[index] != test.want[index] {
					t.Fatalf("got %v, want %v", got, test.want)
				}
			}
		})
	}
}

func newFeedTestProcessor(adapterKind AdapterKind) *bambuProcessor {
	return &bambuProcessor{adapterKind: adapterKind, state: bambuPersistedState{
		Document:        map[string]any{},
		Sessions:        map[string]string{},
		LastSlots:       map[string]string{},
		EmptySlotCounts: map[string]uint8{},
		ActiveErrors:    map[string]bool{},
		RunFacts:        map[string]bambuRunFacts{},
	}, firstSnapshot: true}
}

func applyFeedStatus(t *testing.T, processor *bambuProcessor, status string, at time.Time) {
	t.Helper()
	if _, _, err := processor.apply(context.Background(), []byte(status), at); err != nil {
		t.Fatal(err)
	}
}

// stageFeedArchive writes a 3MF whose single filament 0 extrudes 10 mm in
// each of four layers.
func stageFeedArchive(t *testing.T) ArtifactTransfer {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entries := map[string]string{
		"Metadata/slice_info.config": `<?xml version="1.0"?><config><plate id="1"/>` +
			`<filament id="0" type="PLA" used_mm="40" used_g="3.333333" density="1.24" diameter="1.75"/></config>`,
		"Metadata/plate_1.gcode": "M82\nG92 E0\nM620 S0A\n" +
			"; layer num/total_layer_count: 1/4\n;TYPE:Outer wall\nG1 E10\n" +
			"; layer num/total_layer_count: 2/4\nG1 E20\n" +
			"; layer num/total_layer_count: 3/4\nG1 E30\n" +
			"; layer num/total_layer_count: 4/4\nG1 E40\n",
	}
	for name, content := range entries {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	path := t.TempDir() + "/feed.3mf"
	if err := os.WriteFile(path, buffer.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return ArtifactTransfer{StagedPath: path, SizeBytes: int64(buffer.Len())}
}

func singleReportItem(t *testing.T, payload json.RawMessage) map[string]any {
	t.Helper()
	var report struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(payload, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Items) != 1 {
		t.Fatalf("report items = %s", payload)
	}
	return report.Items[0]
}

func reportSegments(t *testing.T, item map[string]any) []map[string]any {
	t.Helper()
	raw, _ := item["segments"].([]any)
	segments := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		segment, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("segment = %#v", entry)
		}
		segments = append(segments, segment)
	}
	return segments
}

func assertSegmentsSum(t *testing.T, item map[string]any, segments []map[string]any) {
	t.Helper()
	total, ok := parseMicrograms(item["estimatedQuantityGrams"])
	if !ok {
		t.Fatalf("item quantity = %v", item["estimatedQuantityGrams"])
	}
	sum := int64(0)
	for _, segment := range segments {
		value, valid := parseMicrograms(segment["estimatedQuantityGrams"])
		if !valid {
			t.Fatalf("segment quantity = %v", segment["estimatedQuantityGrams"])
		}
		sum += value
	}
	if sum != total {
		t.Fatalf("segments sum to %d µg, item reports %d µg", sum, total)
	}
}
