package printerconnector

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/parser"
)

// maxBambuSplitSamples bounds how often one consumption calculation re-reads
// the archive's G-code to find the extrusion at a segment boundary.
const maxBambuSplitSamples = 8

const (
	bambuSplitGCodeLayer = "gcode_layer"
	bambuSplitProgress   = "progress"
)

// bambuLayerSampler returns the cumulative G-code extrusion length (mm) per
// consumption line: up to the start of the layer, or for the whole file when
// layer is nil. Keys are the slicerFilamentId values of the payload items. A
// nil sampler or false result means no defensible G-code value exists.
type bambuLayerSampler func(layer *int) (map[string]float64, bool)

// usesFeedLines says whether the feed timeline describes the whole run. Older
// persisted runs and runs that outgrew the bound keep their spool evidence.
func (f bambuRunFacts) usesFeedLines() bool {
	return f.FeedTracked && !f.FeedOverflow && len(f.FeedLines) > 0
}

// hasSpoolChange says whether some feed line was fed by more than one spool.
func (f bambuRunFacts) hasSpoolChange() bool {
	if !f.usesFeedLines() {
		return false
	}
	for _, line := range f.FeedLines {
		if len(line.Segments) > 1 {
			return true
		}
	}
	return false
}

// bambuMatchingFacts gives the spool matcher the first spool of each feed line
// as evidence. In a run without spool changes these are the same routes the
// spool evidence lists; after a change, the replacement spool belongs to its
// line instead of looking like one more material.
func bambuMatchingFacts(facts bambuRunFacts) bambuRunFacts {
	if !facts.usesFeedLines() {
		return facts
	}
	evidence := make([]bambuSpoolEvidence, 0, len(facts.FeedLines))
	for _, line := range facts.FeedLines {
		if len(line.Segments) == 0 {
			continue
		}
		head := line.Segments[0]
		candidate := bambuSpoolEvidence{
			SlicerFilamentID:    line.SlicerFilamentID,
			Extruder:            line.Extruder,
			InputUnitExternalID: head.InputUnitExternalID,
			SlotExternalID:      head.SlotExternalID,
			TagUID:              head.TagUID,
			TrayUUID:            head.TrayUUID,
		}
		if !containsBambuSpoolEvidence(evidence, candidate) {
			evidence = append(evidence, candidate)
		}
	}
	facts.SpoolEvidence = evidence
	return facts
}

// applyFeedSegments replaces the single spool of an item that was fed by
// several spools with its segments. Without a top-level slot, Core versions
// that do not read segments leave the line for staff instead of booking the
// whole quantity on one spool.
func applyFeedSegments(
	items []map[string]any,
	facts bambuRunFacts,
	sample bambuLayerSampler,
	reference map[string]float64,
	endProgress *float64,
) {
	if !facts.hasSpoolChange() {
		return
	}
	samples := map[int]map[string]float64{}
	layerLengths := func(layer int) (map[string]float64, bool) {
		if lengths, ok := samples[layer]; ok {
			return lengths, lengths != nil
		}
		if sample == nil || len(samples) >= maxBambuSplitSamples {
			return nil, false
		}
		lengths, ok := sample(&layer)
		if !ok {
			lengths = nil
		}
		samples[layer] = lengths
		return lengths, ok
	}
	for _, item := range items {
		line, ok := feedLineForItem(item, facts.FeedLines)
		if !ok || len(line.Segments) < 2 {
			continue
		}
		delete(item, "inputUnitExternalId")
		delete(item, "slotExternalId")
		delete(item, "tagUid")
		delete(item, "trayUuid")
		slicerID, _ := item["slicerFilamentId"].(string)
		var quantities []int64
		method := ""
		if total, valid := parseMicrograms(item["estimatedQuantityGrams"]); valid {
			lengthAt := func(layer int) (float64, bool) {
				lengths, found := layerLengths(layer)
				return lengths[slicerID], found
			}
			quantities, method = splitFeedLine(line.Segments, total, reference[slicerID], endProgress, lengthAt)
		}
		segments := make([]map[string]any, 0, len(line.Segments))
		for index, segment := range line.Segments {
			entry := map[string]any{
				"inputUnitExternalId": segment.InputUnitExternalID,
				"slotExternalId":      segment.SlotExternalID,
				"startedAt":           segment.StartedAt.UTC().Format(time.RFC3339),
			}
			if segment.TagUID != "" {
				entry["tagUid"] = segment.TagUID
			}
			if segment.TrayUUID != "" {
				entry["trayUuid"] = segment.TrayUUID
			}
			if segment.StartLayer != nil {
				entry["startLayer"] = *segment.StartLayer
			}
			if quantities != nil {
				entry["estimatedQuantityGrams"] = formatMicrograms(quantities[index])
				entry["split"] = method
			}
			segments = append(segments, entry)
		}
		item["segments"] = segments
	}
}

// feedLineForItem finds the feed line of a consumption item: by its explicit
// slicer filament, or by the one extruder line that contains the spool the
// matcher assigned.
func feedLineForItem(item map[string]any, lines []bambuFeedLine) (bambuFeedLine, bool) {
	if id, _ := item["slicerFilamentId"].(string); id != "" {
		for _, line := range lines {
			if line.SlicerFilamentID == id {
				return line, true
			}
		}
	}
	unitID, _ := item["inputUnitExternalId"].(string)
	slotID, _ := item["slotExternalId"].(string)
	tagUID, _ := item["tagUid"].(string)
	trayUUID, _ := item["trayUuid"].(string)
	itemTag := bambuSpoolTag{TagUID: tagUID, TrayUUID: trayUUID}
	if slotID == "" {
		return bambuFeedLine{}, false
	}
	match := -1
	for index, line := range lines {
		if line.SlicerFilamentID != "" {
			continue
		}
		for _, segment := range line.Segments {
			if segment.InputUnitExternalID == unitID && segment.SlotExternalID == slotID &&
				itemTag.sameSpool(bambuSpoolTag{TagUID: segment.TagUID, TrayUUID: segment.TrayUUID}) {
				if match >= 0 && match != index {
					return bambuFeedLine{}, false
				}
				match = index
				break
			}
		}
	}
	if match < 0 {
		return bambuFeedLine{}, false
	}
	return lines[match], true
}

// splitFeedLine divides an item's quantity (in micrograms) between its
// segments. The preferred split is the G-code extrusion before each segment's
// first layer, relative to the extrusion the quantity covers. Without usable
// layers it falls back to printer progress, a time-based estimate. The parts
// always add up to the total exactly; nil means no defensible split exists.
func splitFeedLine(
	segments []bambuFeedSegment,
	total int64,
	referenceLength float64,
	endProgress *float64,
	lengthAt func(layer int) (float64, bool),
) ([]int64, string) {
	boundaries := segments[1:]
	if referenceLength > 0 {
		cumulative := make([]float64, 0, len(boundaries))
		for _, segment := range boundaries {
			if segment.StartLayer == nil {
				break
			}
			length, ok := lengthAt(*segment.StartLayer)
			if !ok {
				break
			}
			cumulative = append(cumulative, length)
		}
		if len(cumulative) == len(boundaries) {
			return distributeMicrograms(total, cumulative, referenceLength), bambuSplitGCodeLayer
		}
	}
	if endProgress != nil && *endProgress > 0 {
		cumulative := make([]float64, 0, len(boundaries))
		for _, segment := range boundaries {
			if segment.StartProgress == nil {
				return nil, ""
			}
			cumulative = append(cumulative, *segment.StartProgress)
		}
		return distributeMicrograms(total, cumulative, *endProgress), bambuSplitProgress
	}
	return nil, ""
}

// distributeMicrograms assigns total in proportion to the increments of a
// cumulative measure. Values are clamped to be non-decreasing and at most the
// reference, so no part is negative; the last part takes the remainder.
func distributeMicrograms(total int64, cumulative []float64, reference float64) []int64 {
	result := make([]int64, 0, len(cumulative)+1)
	previous, assigned := 0.0, int64(0)
	for _, value := range cumulative {
		value = math.Min(math.Max(value, previous), reference)
		share := int64(math.Round((value - previous) / reference * float64(total)))
		share = min(max(share, 0), total-assigned)
		result = append(result, share)
		assigned += share
		previous = value
	}
	return append(result, total-assigned)
}

// gcodeLengthsBySlicerID keys an estimate's extrusion lengths the way the
// payload items are keyed (see marshalGCodeConsumption).
func gcodeLengthsBySlicerID(parsed parser.Result, estimate parser.GCodeEstimate) map[string]float64 {
	result := make(map[string]float64, len(estimate.Filaments))
	for _, filament := range estimate.Filaments {
		id := parsedFilamentForGCode(parsed.Filaments, filament.FilamentID).ID
		if id == "" {
			id = filament.FilamentID
		}
		result[id] += filament.LengthMM
	}
	return result
}

// parseMicrograms reads a non-negative decimalString value exactly, so the
// segments add up to the item's reported quantity to the last digit.
func parseMicrograms(value any) (int64, bool) {
	text, _ := value.(string)
	whole, fraction, _ := strings.Cut(text, ".")
	if whole == "" || len(fraction) > 6 || strings.HasPrefix(whole, "-") {
		return 0, false
	}
	fraction += strings.Repeat("0", 6-len(fraction))
	wholePart, err := strconv.ParseInt(whole, 10, 64)
	if err != nil || wholePart > math.MaxInt64/1_000_000-1 {
		return 0, false
	}
	fractionPart, err := strconv.ParseInt(fraction, 10, 64)
	if err != nil || fractionPart < 0 {
		return 0, false
	}
	return wholePart*1_000_000 + fractionPart, true
}

func formatMicrograms(value int64) string {
	return fmt.Sprintf("%d.%06d", value/1_000_000, value%1_000_000)
}
