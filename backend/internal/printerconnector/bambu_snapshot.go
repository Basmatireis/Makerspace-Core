package printerconnector

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// bambuExtruderSide maps an H2D extruder ID to the side of the print head.
// ASSUMPTION, to be verified on a real printer: extruder 0 is the right
// nozzle and extruder 1 the left one. This is the only place that knows it.
func bambuExtruderSide(extruderID int) *string {
	var side string
	switch extruderID {
	case 0:
		side = "right"
	case 1:
		side = "left"
	default:
		return nil
	}
	return &side
}

func bambuLiveState(gcodeState string) PrinterState {
	switch strings.ToUpper(strings.TrimSpace(gcodeState)) {
	case "IDLE":
		return PrinterIdle
	case "PREPARE":
		return PrinterPreparing
	case "RUNNING":
		return PrinterPrinting
	case "PAUSE":
		return PrinterPaused
	case "FINISH":
		return PrinterFinished
	case "FAILED":
		return PrinterFailed
	default:
		return PrinterUnknown
	}
}

func boundedText(value string, limit int) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if len(value) > limit {
		runes := []rune(value)
		for len(string(runes)) > limit {
			runes = runes[:len(runes)-1]
		}
		value = string(runes)
	}
	return &value
}

func boundedFloat(value any, low, high float64) *float64 {
	text := scalarString(value)
	if text == "" {
		return nil
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < low || parsed > high {
		return nil
	}
	return &parsed
}

func boundedIntPointer(value any, low, high int) *int {
	if parsed, ok := boundedInt(value, low, high); ok {
		return &parsed
	}
	return nil
}

// bambuColorHex returns RRGGBB from Bambu's RRGGBBAA (or RRGGBB) tray color.
func bambuColorHex(value string) *string {
	value = strings.TrimSpace(value)
	if len(value) != 6 && len(value) != 8 {
		return nil
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return nil
		}
	}
	result := strings.ToUpper(value[:6])
	return &result
}

func isZeroIdentifier(value string) bool {
	return strings.Trim(value, "0") == ""
}

// bambuTrayExistBit reports whether tray_exist_bits marks a tray as present.
// Bit index is unit index * 4 + tray index, where AMS HT unit 128 is unit
// index 4. The result is unknown when the document has no usable bitmask.
func bambuTrayExistBit(bits string, unitID, trayID string) (present, known bool) {
	if bits == "" {
		return false, false
	}
	mask, err := strconv.ParseUint(bits, 16, 64)
	unit, unitErr := strconv.Atoi(unitID)
	tray, trayErr := strconv.Atoi(trayID)
	if err != nil || unitErr != nil || trayErr != nil || tray < 0 || tray > 3 {
		return false, false
	}
	if unit >= 128 {
		unit = unit - 128 + 4
	}
	if unit < 0 || unit > 11 {
		return false, false
	}
	return mask&(1<<uint(unit*4+tray)) != 0, true
}

func bambuLiveTray(ref bambuTrayRef, existBits string) liveTray {
	tray := ref.tray
	materialType := boundedText(stringAt(tray, "tray_type"), 40)
	rfid := false
	if tag := firstScalar(tray, "tag_uid"); tag != "" && !isZeroIdentifier(tag) {
		rfid = true
	}
	empty := materialType == nil && !rfid
	if !ref.external {
		if present, known := bambuTrayExistBit(existBits, ref.unitID, ref.trayID); known && !present &&
			materialType == nil {
			empty = true
		} else if known && present {
			empty = false
		}
	}
	result := liveTray{
		ExternalID:   ref.trayID,
		MaterialType: materialType,
		SubBrand:     boundedText(stringAt(tray, "tray_sub_brands"), 80),
		RFID:         rfid,
		Empty:        empty,
	}
	if !empty {
		result.ColorHex = bambuColorHex(stringAt(tray, "tray_color"))
		// remain is a percentage; -1 and 0 mean the printer does not know.
		if remain, ok := boundedInt(tray["remain"], 1, 100); ok {
			result.RemainPercent = &remain
		}
	}
	return result
}

func bambuUnitKind(unitID string) UnitKind {
	number, err := strconv.Atoi(unitID)
	switch {
	case err != nil:
		return UnitUnknown
	case number >= 128:
		return UnitAMSHT
	default:
		return UnitAMS
	}
}

func bambuLiveUnits(printState map[string]any) []liveUnit {
	existBits := scalarString(objectAt(printState, "ams")["tray_exist_bits"])
	units := []liveUnit{}
	index := map[string]int{}
	refs, _ := bambuTrayRefs(printState)
	// Units without trays are still listed.
	if ams := objectAt(printState, "ams"); ams != nil {
		list, _ := ams["ams"].([]any)
		for _, raw := range list {
			unit, _ := raw.(map[string]any)
			unitID := firstScalar(unit, "id", "ams_id")
			if unitID == "" {
				continue
			}
			if _, seen := index[unitID]; seen {
				continue
			}
			kind := bambuUnitKind(unitID)
			label := "AMS " + unitID
			if kind == UnitAMSHT {
				label = "AMS HT " + unitID
			}
			index[unitID] = len(units)
			units = append(
				units,
				liveUnit{
					ExternalID:      unitID,
					Kind:            kind,
					Label:           label,
					HumidityPercent: boundedIntPointer(unit["humidity_raw"], 0, 100),
					TemperatureC:    boundedFloat(unit["temp"], -50, 200),
					Trays:           []liveTray{},
				},
			)
		}
	}
	for _, ref := range refs {
		position, seen := index[ref.unitID]
		if !seen {
			if !ref.external {
				continue
			}
			index[ref.unitID] = len(units)
			position = len(units)
			units = append(
				units,
				liveUnit{
					ExternalID: ref.unitID,
					Kind:       UnitExternal,
					Label:      "External spool " + ref.unitID,
					Trays:      []liveTray{},
				},
			)
		}
		if len(units[position].Trays) < 8 {
			units[position].Trays = append(units[position].Trays, bambuLiveTray(ref, existBits))
		}
	}
	if len(units) > 32 {
		units = units[:32]
	}
	return units
}

func bambuLiveTemperatures(printState map[string]any) liveTemperatures {
	device := objectAt(printState, "device")
	result := liveTemperatures{Extruders: []liveExtruderTemperature{}}
	if info, _ := objectAt(device, "extruder")["info"].([]any); info != nil {
		for _, raw := range info {
			entry, _ := raw.(map[string]any)
			id, ok := boundedInt(entry["id"], 0, 15)
			if !ok || len(result.Extruders) >= 8 {
				continue
			}
			result.Extruders = append(
				result.Extruders,
				liveExtruderTemperature{
					ExtruderID: id,
					Side:       bambuExtruderSide(id),
					CurrentC:   boundedFloat(entry["temp"], -50, 1000),
					TargetC:    boundedFloat(entry["htar"], 0, 1000),
				},
			)
		}
	}
	sort.Slice(
		result.Extruders,
		func(i, j int) bool { return result.Extruders[i].ExtruderID < result.Extruders[j].ExtruderID },
	)
	result.BedC = boundedFloat(printState["bed_temper"], -50, 500)
	result.BedTargetC = boundedFloat(printState["bed_target_temper"], 0, 500)
	result.ChamberC = boundedFloat(objectAt(objectAt(device, "ctc"), "info")["temp"], -50, 500)
	return result
}

func bambuLiveTemperaturesFor(adapterKind AdapterKind, printState map[string]any) liveTemperatures {
	result := bambuLiveTemperatures(printState)
	if adapterKind != AdapterBambuX1C {
		return result
	}
	if len(result.Extruders) == 0 {
		result.Extruders = append(result.Extruders, liveExtruderTemperature{
			ExtruderID: 1,
			CurrentC:   boundedFloat(printState["nozzle_temper"], -50, 1000),
			TargetC:    boundedFloat(printState["nozzle_target_temper"], 0, 1000),
		})
	}
	if result.ChamberC == nil {
		result.ChamberC = boundedFloat(printState["chamber_temper"], -50, 500)
	}
	return result
}

func bambuLiveNozzles(printState map[string]any) []liveNozzle {
	result := []liveNozzle{}
	info, _ := objectAt(objectAt(printState, "device"), "nozzle")["info"].([]any)
	for _, raw := range info {
		entry, _ := raw.(map[string]any)
		id, ok := boundedInt(entry["id"], 0, 15)
		if !ok || len(result) >= 8 {
			continue
		}
		result = append(
			result,
			liveNozzle{
				ExtruderID: id,
				Side:       bambuExtruderSide(id),
				DiameterMm: boundedFloat(entry["diameter"], 0.05, 5),
				Type:       boundedText(stringAt(entry, "type"), 40),
			},
		)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ExtruderID < result[j].ExtruderID })
	return result
}

func bambuLiveNozzlesFor(adapterKind AdapterKind, printState map[string]any) []liveNozzle {
	result := bambuLiveNozzles(printState)
	if adapterKind == AdapterBambuX1C && len(result) == 0 {
		diameter := boundedFloat(printState["nozzle_diameter"], 0.05, 5)
		nozzleType := boundedText(stringAt(printState, "nozzle_type"), 40)
		if diameter != nil || nozzleType != nil {
			result = append(result, liveNozzle{ExtruderID: 1, DiameterMm: diameter, Type: nozzleType})
		}
	}
	return result
}

func bambuLiveJob(printState map[string]any, state PrinterState) *liveJob {
	if state == PrinterIdle || state == PrinterUnknown {
		return nil
	}
	name := stringAt(printState, "subtask_name")
	if name == "" {
		name = bambuFileName(printState)
		if slash := strings.LastIndex(name, "/"); slash >= 0 {
			name = name[slash+1:]
		}
	}
	job := &liveJob{
		FileName:         boundedText(name, 255),
		ProgressPercent:  boundedIntPointer(printState["mc_percent"], 0, 100),
		Layer:            boundedIntPointer(printState["layer_num"], 0, math.MaxInt32),
		TotalLayers:      boundedIntPointer(printState["total_layer_num"], 0, math.MaxInt32),
		RemainingMinutes: boundedIntPointer(printState["mc_remaining_time"], 0, 10*365*24*60),
	}
	if job.FileName == nil && job.ProgressPercent == nil && job.Layer == nil && job.TotalLayers == nil &&
		job.RemainingMinutes == nil {
		return nil
	}
	return job
}

// bambuWifiSignal parses values such as "-39dBm".
func bambuWifiSignal(value any) *int {
	text := strings.TrimSpace(strings.TrimSuffix(strings.ToLower(scalarString(value)), "dbm"))
	parsed, err := strconv.Atoi(text)
	if err != nil || parsed < -150 || parsed > 0 {
		return nil
	}
	return &parsed
}

// bambuLiveErrors lists the currently active print error and HMS codes in a
// stable order. since holds when each code was first seen by this process.
func bambuLiveErrors(printState map[string]any, since map[string]time.Time, now time.Time) []liveError {
	active := map[string]liveError{}
	add := func(family, code string) {
		if code == "" || code == "0" || len(code) > 120 {
			return
		}
		key := family + ":" + code
		first, known := since[key]
		if !known {
			first = now
			since[key] = first
		}
		observed := first
		active[key] = liveError{SourceFamily: family, Code: code, ObservedAt: &observed}
	}
	add("print", scalarString(printState["print_error"]))
	if hms, ok := printState["hms"].([]any); ok {
		for _, raw := range hms {
			entry, _ := raw.(map[string]any)
			add("hms", firstScalar(entry, "code", "attr"))
		}
	}
	for key := range since {
		if _, still := active[key]; !still {
			delete(since, key)
		}
	}
	keys := make([]string, 0, len(active))
	for key := range active {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]liveError, 0, len(keys))
	for _, key := range keys {
		if len(result) >= 64 {
			break
		}
		result = append(result, active[key])
	}
	return result
}

// buildBambuLiveSnapshot normalizes the merged H2D status document. It never
// copies addresses, serial numbers, camera or network fields.
func buildBambuLiveSnapshot(document map[string]any, errorSince map[string]time.Time, now time.Time) liveSnapshot {
	return buildBambuLiveSnapshotFor(AdapterBambuH2D, document, errorSince, now)
}

func buildBambuLiveSnapshotFor(
	adapterKind AdapterKind,
	document map[string]any,
	errorSince map[string]time.Time,
	now time.Time,
) liveSnapshot {
	printState := objectAt(document, "print")
	if printState == nil {
		printState = document
	}
	state := bambuLiveState(stringAt(printState, "gcode_state"))
	snapshot := newLiveSnapshot(state)
	snapshot.Job = bambuLiveJob(printState, state)
	snapshot.Temperatures = bambuLiveTemperaturesFor(adapterKind, printState)
	snapshot.Nozzles = bambuLiveNozzlesFor(adapterKind, printState)
	snapshot.Units = bambuLiveUnits(printState)
	snapshot.Errors = bambuLiveErrors(printState, errorSince, now)
	snapshot.WifiSignalDbm = bambuWifiSignal(printState["wifi_signal"])
	// tray_now is 255 while nothing is selected, which is also the ID of an
	// external holder, so the active tray is only reported for an active job.
	if state == PrinterPreparing || state == PrinterPrinting || state == PrinterPaused {
		if unit, tray, _, ok := bambuActiveSlotFor(adapterKind, printState); ok {
			snapshot.ActiveTray = &liveActiveTray{UnitExternalID: unit, TrayExternalID: tray}
		}
	}
	return snapshot
}

func (p *bambuProcessor) liveSnapshot(now time.Time) json.RawMessage {
	if p.errorSince == nil {
		p.errorSince = map[string]time.Time{}
	}
	return mustJSON(buildBambuLiveSnapshotFor(p.adapterKind, p.state.Document, p.errorSince, now))
}
