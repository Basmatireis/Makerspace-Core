package parser

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const CalculationVersion = "gcode-extrusion-v3"

type EstimateQuality string
type ExtrusionCategory string

const (
	QualityHigh   EstimateQuality = "high"
	QualityMedium EstimateQuality = "medium"
	QualityLow    EstimateQuality = "low"

	CategoryModel        ExtrusionCategory = "model"
	CategoryPurgeLoading ExtrusionCategory = "purge_loading"
	CategoryUnclassified ExtrusionCategory = "unclassified"
)

type GCodeFilament struct {
	ID              string
	DiameterMM      *float64
	DensityGCM3     *float64
	FullLengthMM    *float64
	FullWeightGrams *float64
}

type GCodeOptions struct {
	Filaments            []GCodeFilament
	LastReliableLayer    *int
	LastReliableProgress *float64
	// PhysicalExtruder fixes all extrusion to one nozzle. X1-family G-code
	// still emits T0/T2 material commands even though it has one extruder.
	PhysicalExtruder *int
	MaxLineBytes     int
}

type GCodeEstimate struct {
	Method             string             `json:"method"`
	CalculationVersion string             `json:"calculationVersion"`
	Quality            EstimateQuality    `json:"quality"`
	Resolved           bool               `json:"resolved"`
	SelectedLayer      *int               `json:"selectedLayer,omitempty"`
	EmbeddedProgress   *float64           `json:"embeddedProgress,omitempty"`
	Filaments          []FilamentEstimate `json:"filaments"`
	Warnings           []string           `json:"warnings,omitempty"`
}

type FilamentEstimate struct {
	FilamentID       string   `json:"filamentId"`
	Extruders        []int    `json:"extruders,omitempty"`
	LengthMM         float64  `json:"lengthMm"`
	WeightGrams      *float64 `json:"weightGrams,omitempty"`
	ModelLengthMM    float64  `json:"modelLengthMm"`
	PurgeLengthMM    float64  `json:"purgeLengthMm"`
	UnclassifiedMM   float64  `json:"unclassifiedLengthMm"`
	ConversionMethod string   `json:"conversionMethod,omitempty"`
}

type extrusionTotals struct {
	byFilament map[string]*filamentTotals
	layer      *int
	progress   *float64
}

type filamentTotals struct {
	extruders    map[int]struct{}
	model        float64
	purge        float64
	unclassified float64
}

type extruderState struct {
	position       float64
	positionKnown  bool
	retractionDebt float64
	filamentID     string
}

var (
	wordPattern          = regexp.MustCompile(`(?i)([A-Z])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))`)
	bambuFilamentRegex   = regexp.MustCompile(`(?i)^M62[01]\s+S(\d+)`)
	bambuLayerCountRegex = regexp.MustCompile(`(?i)^;\s*layer\s+num/total_layer_count\s*:\s*(\d+)\s*/\s*\d+\s*$`)
	layerNumberRegex     = regexp.MustCompile(`(?i)^;\s*layer(?:\s+num)?\s*[:=]\s*(\d+)\s*$`)
	layerChangeRegex     = regexp.MustCompile(`(?i)^;\s*(?:change_layer|layer_change)\s*(?:[:=]\s*(\d+))?\s*$`)
	progressCommentRegex = regexp.MustCompile(`(?i)^;.*(?:progress|percent)[^0-9]*(\d+(?:\.\d+)?)\s*%?`)
	toolCommandRegex     = regexp.MustCompile(`^T\d+(?:\s|$)`)
)

// EstimateGCode parses extrusion without executing G-code. When a reliable
// layer/progress boundary is supplied it selects the latest observed
// checkpoint at or before both boundaries; it never scales full-file weight
// by MQTT percentage.
func EstimateGCode(r io.Reader, options GCodeOptions) (GCodeEstimate, error) {
	maxLine := options.MaxLineBytes
	if maxLine <= 0 {
		maxLine = 1 << 20
	}
	state := gcodeState{
		absoluteExtrusion: true,
		extruders:         make(map[int]*extruderState),
		totals:            extrusionTotals{byFilament: make(map[string]*filamentTotals)},
		category:          CategoryUnclassified,
	}
	if options.PhysicalExtruder != nil {
		state.activeExtruder = *options.PhysicalExtruder
		state.fixedExtruder = true
	}
	state.ensureExtruder(state.activeExtruder)
	var checkpoints []extrusionTotals
	scanner := bufio.NewScanner(r)
	initialBuffer := 64 << 10
	if maxLine < initialBuffer {
		initialBuffer = maxLine
	}
	scanner.Buffer(make([]byte, initialBuffer), maxLine)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if state.handleMarker(line) {
			checkpoints = append(checkpoints, cloneTotals(state.totals))
		}
		state.handleCommand(line)
	}
	if err := scanner.Err(); err != nil {
		return GCodeEstimate{}, fmt.Errorf("scan G-code: %w", err)
	}
	if options.LastReliableLayer == nil && options.LastReliableProgress == nil {
		checkpoints = append(checkpoints, cloneTotals(state.totals))
	}
	selected, ok := selectCheckpoint(checkpoints, options)
	if !ok {
		return GCodeEstimate{
			Method: "gcode_checkpoint", CalculationVersion: CalculationVersion,
			Quality: QualityLow, Resolved: false,
			Warnings: []string{"no G-code checkpoint was consistent with the supplied printer progress"},
		}, nil
	}
	return buildEstimate(selected, options.Filaments), nil
}

type gcodeState struct {
	absoluteExtrusion bool
	activeExtruder    int
	extruders         map[int]*extruderState
	totals            extrusionTotals
	category          ExtrusionCategory
	fixedExtruder     bool
}

func (s *gcodeState) ensureExtruder(tool int) *extruderState {
	state := s.extruders[tool]
	if state == nil {
		state = &extruderState{filamentID: strconv.Itoa(tool)}
		s.extruders[tool] = state
	}
	return state
}

func (s *gcodeState) handleMarker(line string) bool {
	lower := strings.ToLower(line)
	checkpoint := false
	if match := bambuLayerCountRegex.FindStringSubmatch(line); len(match) == 2 {
		if layer, err := strconv.Atoi(match[1]); err == nil && layer > 0 {
			// H2D reports the same one-based layer number through MQTT once
			// printing begins (zero is preparation). Selecting the archive marker
			// with that number gives the conservative start-of-layer checkpoint.
			s.totals.layer = intPointer(layer)
			checkpoint = true
		}
	} else if match := layerNumberRegex.FindStringSubmatch(line); len(match) == 2 {
		if layer, err := strconv.Atoi(match[1]); err == nil {
			s.totals.layer = intPointer(layer)
			checkpoint = true
		}
	} else if match := layerChangeRegex.FindStringSubmatch(line); len(match) > 0 {
		if len(match) > 1 && match[1] != "" {
			if layer, err := strconv.Atoi(match[1]); err == nil {
				s.totals.layer = intPointer(layer)
			}
		} else if s.totals.layer == nil {
			s.totals.layer = intPointer(0)
		} else {
			s.totals.layer = intPointer(*s.totals.layer + 1)
		}
		checkpoint = true
	}
	if strings.HasPrefix(strings.ToUpper(line), "M73 ") {
		if progress, ok := commandWord(line, 'P'); ok && progress >= 0 && progress <= 100 {
			s.totals.progress = floatPointer(progress)
			checkpoint = true
		}
	} else if match := progressCommentRegex.FindStringSubmatch(line); len(match) == 2 {
		if progress, err := strconv.ParseFloat(match[1], 64); err == nil && progress >= 0 && progress <= 100 {
			s.totals.progress = floatPointer(progress)
			checkpoint = true
		}
	}
	if strings.HasPrefix(lower, ";") {
		switch {
		case containsAny(lower, "wipe tower", "purge", "flush", "filament load", "filament unload", "nozzle cleaning"):
			s.category = CategoryPurgeLoading
		case containsAny(lower, "external perimeter", "perimeter", "infill", "solid infill", "top surface", "bottom surface", "support", "bridge", "skirt", "brim", "wall", "sparse infill", "internal solid"):
			s.category = CategoryModel
		case strings.Contains(lower, "custom") || strings.Contains(lower, "unknown"):
			s.category = CategoryUnclassified
		}
	}
	return checkpoint
}

func (s *gcodeState) handleCommand(line string) {
	command := strings.TrimSpace(strings.SplitN(line, ";", 2)[0])
	if command == "" {
		return
	}
	upper := strings.ToUpper(command)
	switch {
	case upper == "M82" || strings.HasPrefix(upper, "M82 "):
		s.absoluteExtrusion = true
		return
	case upper == "M83" || strings.HasPrefix(upper, "M83 "):
		s.absoluteExtrusion = false
		return
	case strings.HasPrefix(upper, "G92"):
		if value, ok := commandWord(command, 'E'); ok {
			tool := s.ensureExtruder(s.activeExtruder)
			tool.position = value
			tool.positionKnown = true
		}
		return
	case toolCommandRegex.MatchString(upper):
		end := 1
		for end < len(upper) && upper[end] >= '0' && upper[end] <= '9' {
			end++
		}
		if tool, err := strconv.Atoi(upper[1:end]); err == nil {
			// Bambu uses T255 for unload and T1000/T1100 as X1-family
			// calibration/nozzle-space commands. They are not physical extruder
			// selections and must not create phantom consumption lines.
			if tool >= 255 || s.fixedExtruder {
				return
			}
			s.activeExtruder = tool
			s.ensureExtruder(tool)
		}
		return
	case bambuFilamentRegex.MatchString(upper):
		match := bambuFilamentRegex.FindStringSubmatch(upper)
		tool := s.ensureExtruder(s.activeExtruder)
		tool.filamentID = match[1]
		return
	case strings.HasPrefix(upper, "G0 ") || strings.HasPrefix(upper, "G1 ") || upper == "G0" || upper == "G1":
		value, ok := commandWord(command, 'E')
		if !ok {
			return
		}
		tool := s.ensureExtruder(s.activeExtruder)
		delta := value
		if s.absoluteExtrusion {
			if !tool.positionKnown {
				tool.position, tool.positionKnown = value, true
				return
			}
			delta = value - tool.position
			tool.position = value
		} else if tool.positionKnown {
			tool.position += value
		}
		if delta < 0 {
			tool.retractionDebt += -delta
			return
		}
		if delta <= 0 {
			return
		}
		if tool.retractionDebt > 0 {
			repaid := math.Min(delta, tool.retractionDebt)
			tool.retractionDebt -= repaid
			delta -= repaid
		}
		if delta <= 0 {
			return
		}
		filamentID := tool.filamentID
		if filamentID == "" {
			filamentID = strconv.Itoa(s.activeExtruder)
		}
		totals := s.totals.byFilament[filamentID]
		if totals == nil {
			totals = &filamentTotals{extruders: make(map[int]struct{})}
			s.totals.byFilament[filamentID] = totals
		}
		totals.extruders[s.activeExtruder] = struct{}{}
		switch s.category {
		case CategoryModel:
			totals.model += delta
		case CategoryPurgeLoading:
			totals.purge += delta
		default:
			totals.unclassified += delta
		}
	}
}

func commandWord(line string, desired byte) (float64, bool) {
	for _, match := range wordPattern.FindAllStringSubmatch(line, -1) {
		if len(match) == 3 && strings.EqualFold(match[1], string(desired)) {
			value, err := strconv.ParseFloat(match[2], 64)
			return value, err == nil
		}
	}
	return 0, false
}

func cloneTotals(source extrusionTotals) extrusionTotals {
	clone := extrusionTotals{byFilament: make(map[string]*filamentTotals, len(source.byFilament))}
	if source.layer != nil {
		clone.layer = intPointer(*source.layer)
	}
	if source.progress != nil {
		clone.progress = floatPointer(*source.progress)
	}
	for id, totals := range source.byFilament {
		copyTotals := &filamentTotals{
			extruders: make(map[int]struct{}, len(totals.extruders)),
			model:     totals.model, purge: totals.purge, unclassified: totals.unclassified,
		}
		for extruder := range totals.extruders {
			copyTotals.extruders[extruder] = struct{}{}
		}
		clone.byFilament[id] = copyTotals
	}
	return clone
}

func selectCheckpoint(checkpoints []extrusionTotals, options GCodeOptions) (extrusionTotals, bool) {
	for i := len(checkpoints) - 1; i >= 0; i-- {
		checkpoint := checkpoints[i]
		if options.LastReliableLayer != nil {
			if checkpoint.layer == nil || *checkpoint.layer > *options.LastReliableLayer {
				continue
			}
		}
		if options.LastReliableProgress != nil {
			if checkpoint.progress == nil || *checkpoint.progress > *options.LastReliableProgress {
				continue
			}
		}
		return checkpoint, true
	}
	return extrusionTotals{}, false
}

func buildEstimate(totals extrusionTotals, filamentConfig []GCodeFilament) GCodeEstimate {
	configs := make(map[string]GCodeFilament, len(filamentConfig))
	for _, config := range filamentConfig {
		configs[config.ID] = config
	}
	result := GCodeEstimate{
		Method: "gcode_checkpoint", CalculationVersion: CalculationVersion,
		Quality: QualityHigh, Resolved: true, SelectedLayer: totals.layer, EmbeddedProgress: totals.progress,
	}
	ids := make([]string, 0, len(totals.byFilament))
	for id := range totals.byFilament {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return numericStringLess(ids[i], ids[j]) })
	for _, id := range ids {
		total := totals.byFilament[id]
		item := FilamentEstimate{
			FilamentID: id, ModelLengthMM: total.model, PurgeLengthMM: total.purge,
			UnclassifiedMM: total.unclassified,
		}
		item.LengthMM = item.ModelLengthMM + item.PurgeLengthMM + item.UnclassifiedMM
		for extruder := range total.extruders {
			item.Extruders = append(item.Extruders, extruder)
		}
		sort.Ints(item.Extruders)
		config, exists := configs[id]
		if exists && config.DiameterMM != nil && config.DensityGCM3 != nil && *config.DiameterMM > 0 &&
			*config.DensityGCM3 > 0 {
			grams := lengthToGrams(item.LengthMM, *config.DiameterMM, *config.DensityGCM3)
			item.WeightGrams = &grams
			item.ConversionMethod = "density_diameter"
		} else if exists && config.FullLengthMM != nil && config.FullWeightGrams != nil && *config.FullLengthMM > 0 && *config.FullWeightGrams >= 0 {
			grams := item.LengthMM * *config.FullWeightGrams / *config.FullLengthMM
			item.WeightGrams = &grams
			item.ConversionMethod = "slicer_normalized"
			if result.Quality == QualityHigh {
				result.Quality = QualityMedium
			}
		} else {
			result.Resolved = false
			result.Quality = QualityLow
			result.Warnings = append(result.Warnings, "filament "+id+" has no defensible gram conversion")
		}
		result.Filaments = append(result.Filaments, item)
	}
	if len(result.Filaments) == 0 {
		result.Resolved = false
		result.Quality = QualityLow
		result.Warnings = append(result.Warnings, "no positive extrusion was observed")
	}
	return result
}

func lengthToGrams(lengthMM, diameterMM, densityGCM3 float64) float64 {
	radius := diameterMM / 2
	volumeMM3 := math.Pi * radius * radius * lengthMM
	return volumeMM3 / 1000 * densityGCM3
}

func containsAny(value string, candidates ...string) bool {
	for _, candidate := range candidates {
		if strings.Contains(value, candidate) {
			return true
		}
	}
	return false
}

func intPointer(value int) *int           { return &value }
func floatPointer(value float64) *float64 { return &value }
