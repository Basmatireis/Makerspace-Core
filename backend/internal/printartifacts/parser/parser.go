// Package parser validates and extracts normalized metadata from Bambu 3MF
// archives. It deliberately has no storage or database dependencies so the
// connector and Core can use the same parsing rules.
package parser

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	ParserVersion = "bambu-3mf-v1"

	StatusParsed  Status = "parsed"
	StatusPartial Status = "partial"

	PreviewRolePlate     PreviewRole = "plate"
	PreviewRoleThumbnail PreviewRole = "thumbnail"
	PreviewRolePreview   PreviewRole = "preview"
)

// Limits are security boundaries applied before metadata is trusted.
type Limits struct {
	MaxCompressedSize int64
	MaxEntries        int
	MaxExpandedSize   uint64
	MaxEntrySize      uint64
	MaxPreviewSize    int64
	MaxPreviewPixels  uint64
	MaxMetadataSize   int64
}

func DefaultLimits() Limits {
	return Limits{
		MaxCompressedSize: 512 << 20,
		MaxEntries:        4096,
		MaxExpandedSize:   2 << 30,
		MaxEntrySize:      1 << 30,
		MaxPreviewSize:    32 << 20,
		MaxPreviewPixels:  64_000_000,
		MaxMetadataSize:   16 << 20,
	}
}

type Status string
type PreviewRole string

type Result struct {
	ParserVersion string     `json:"parserVersion"`
	Status        Status     `json:"status"`
	Metadata      Metadata   `json:"metadata"`
	Filaments     []Filament `json:"filaments"`
	// FilamentSequence is the first-use order reported by Bambu's
	// filament_sequence.json. It is connector routing evidence, not a source
	// of consumption quantities.
	FilamentSequence []string    `json:"filamentSequence,omitempty"`
	Previews         []Preview   `json:"previews"`
	GCode            []GCodeFile `json:"gcode"`
	Warnings         []string    `json:"warnings,omitempty"`
}

// Metadata contains only fields for which the archive supplied evidence.
// Pointer fields distinguish a genuine zero from an unknown value.
type Metadata struct {
	JobName                  string   `json:"jobName,omitempty"`
	SlicerName               string   `json:"slicerName,omitempty"`
	SlicerVersion            string   `json:"slicerVersion,omitempty"`
	PrinterProfile           string   `json:"printerProfile,omitempty"`
	BuildPlate               string   `json:"buildPlate,omitempty"`
	ModelNames               []string `json:"modelNames,omitempty"`
	PlateNumbers             []int    `json:"plateNumbers,omitempty"`
	EstimatedDurationSeconds *float64 `json:"estimatedDurationSeconds,omitempty"`
	LayerCount               *int     `json:"layerCount,omitempty"`
	FilamentChanges          *int     `json:"filamentChanges,omitempty"`
	PurgeWeightGrams         *float64 `json:"purgeWeightGrams,omitempty"`
}

type Filament struct {
	ID             string   `json:"id"`
	Type           string   `json:"type,omitempty"`
	Color          string   `json:"color,omitempty"`
	LengthMM       *float64 `json:"lengthMm,omitempty"`
	WeightGrams    *float64 `json:"weightGrams,omitempty"`
	DensityGCM3    *float64 `json:"densityGcm3,omitempty"`
	DiameterMM     *float64 `json:"diameterMm,omitempty"`
	Extruders      []int    `json:"extruders,omitempty"`
	NozzleDiameter *float64 `json:"nozzleDiameterMm,omitempty"`
}

type Preview struct {
	ArchivePath string      `json:"archivePath"`
	Role        PreviewRole `json:"role"`
	PlateNumber *int        `json:"plateNumber,omitempty"`
	Width       int         `json:"width"`
	Height      int         `json:"height"`
	MIMEType    string      `json:"mimeType"`
	Size        int64       `json:"size"`
	SHA256      string      `json:"sha256"`
	Primary     bool        `json:"primary"`
	Bytes       []byte      `json:"-"`
}

type GCodeFile struct {
	ArchivePath string        `json:"archivePath"`
	PlateNumber *int          `json:"plateNumber,omitempty"`
	Estimate    GCodeEstimate `json:"estimate"`
}

// ValidationError has a stable Code suitable for diagnostics without
// exposing archive data in logs.
type ValidationError struct {
	Code   string
	Path   string
	Reason string
}

func (e *ValidationError) Error() string {
	if e.Path == "" {
		return fmt.Sprintf("3mf validation %s: %s", e.Code, e.Reason)
	}
	return fmt.Sprintf("3mf validation %s for %q: %s", e.Code, e.Path, e.Reason)
}

// OpenValidated checks path safety, declared sizes, encryption, entry types,
// decompression limits, and every entry's CRC before returning the archive.
func OpenValidated(r io.ReaderAt, compressedSize int64, limits Limits) (*zip.Reader, error) {
	limits = withLimitDefaults(limits)
	if compressedSize < 0 || compressedSize > limits.MaxCompressedSize {
		return nil, &ValidationError{Code: "compressed_size", Reason: "compressed archive exceeds the configured limit"}
	}
	zr, err := zip.NewReader(r, compressedSize)
	if err != nil {
		return nil, &ValidationError{Code: "invalid_zip", Reason: err.Error()}
	}
	if len(zr.File) > limits.MaxEntries {
		return nil, &ValidationError{Code: "entry_count", Reason: "archive contains too many entries"}
	}
	var declaredTotal uint64
	for _, f := range zr.File {
		if err := validateArchivePath(f.Name); err != nil {
			return nil, err
		}
		if f.Flags&0x1 != 0 {
			return nil, &ValidationError{
				Code:   "encrypted_entry",
				Path:   f.Name,
				Reason: "encrypted entries are not accepted",
			}
		}
		mode := f.Mode()
		if !mode.IsRegular() && !mode.IsDir() {
			return nil, &ValidationError{
				Code:   "unsafe_entry_type",
				Path:   f.Name,
				Reason: "links and special files are not accepted",
			}
		}
		if f.UncompressedSize64 > limits.MaxEntrySize {
			return nil, &ValidationError{
				Code:   "entry_size",
				Path:   f.Name,
				Reason: "expanded entry exceeds the configured limit",
			}
		}
		if ^uint64(0)-declaredTotal < f.UncompressedSize64 {
			return nil, &ValidationError{Code: "expanded_size", Reason: "expanded archive size overflow"}
		}
		declaredTotal += f.UncompressedSize64
		if declaredTotal > limits.MaxExpandedSize {
			return nil, &ValidationError{Code: "expanded_size", Reason: "expanded archive exceeds the configured limit"}
		}
	}

	var actualTotal uint64
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, &ValidationError{Code: "entry_open", Path: f.Name, Reason: err.Error()}
		}
		n, copyErr := io.Copy(io.Discard, io.LimitReader(rc, int64(limits.MaxEntrySize)+1))
		closeErr := rc.Close()
		if copyErr != nil {
			return nil, &ValidationError{Code: "entry_crc", Path: f.Name, Reason: copyErr.Error()}
		}
		if closeErr != nil {
			return nil, &ValidationError{Code: "entry_crc", Path: f.Name, Reason: closeErr.Error()}
		}
		if n < 0 || uint64(n) > limits.MaxEntrySize {
			return nil, &ValidationError{
				Code:   "entry_size",
				Path:   f.Name,
				Reason: "expanded entry exceeds the configured limit",
			}
		}
		actualTotal += uint64(n)
		if actualTotal > limits.MaxExpandedSize {
			return nil, &ValidationError{Code: "expanded_size", Reason: "expanded archive exceeds the configured limit"}
		}
		if uint64(n) != f.UncompressedSize64 {
			return nil, &ValidationError{
				Code:   "entry_size_mismatch",
				Path:   f.Name,
				Reason: "expanded size does not match the ZIP directory",
			}
		}
	}
	return zr, nil
}

func withLimitDefaults(l Limits) Limits {
	d := DefaultLimits()
	if l.MaxCompressedSize <= 0 {
		l.MaxCompressedSize = d.MaxCompressedSize
	}
	if l.MaxEntries <= 0 {
		l.MaxEntries = d.MaxEntries
	}
	if l.MaxExpandedSize == 0 {
		l.MaxExpandedSize = d.MaxExpandedSize
	}
	if l.MaxEntrySize == 0 {
		l.MaxEntrySize = d.MaxEntrySize
	}
	if l.MaxPreviewSize <= 0 {
		l.MaxPreviewSize = d.MaxPreviewSize
	}
	if l.MaxPreviewPixels == 0 {
		l.MaxPreviewPixels = d.MaxPreviewPixels
	}
	if l.MaxMetadataSize <= 0 {
		l.MaxMetadataSize = d.MaxMetadataSize
	}
	return l
}

var windowsVolumePattern = regexp.MustCompile(`^[A-Za-z]:`)

func validateArchivePath(name string) error {
	if name == "" || strings.ContainsRune(name, '\x00') {
		return &ValidationError{Code: "unsafe_path", Path: name, Reason: "entry path is empty or contains NUL"}
	}
	normalized := strings.ReplaceAll(name, "\\", "/")
	if strings.HasPrefix(normalized, "/") || windowsVolumePattern.MatchString(normalized) {
		return &ValidationError{Code: "unsafe_path", Path: name, Reason: "absolute paths are not accepted"}
	}
	cleaned := path.Clean(normalized)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return &ValidationError{Code: "unsafe_path", Path: name, Reason: "parent traversal is not accepted"}
	}
	return nil
}

// Parse validates an archive, extracts bounded normalized metadata and
// previews, and computes full-file G-code extrusion totals when present.
func Parse(r io.ReaderAt, compressedSize int64, limits Limits) (Result, error) {
	limits = withLimitDefaults(limits)
	zr, err := OpenValidated(r, compressedSize, limits)
	if err != nil {
		return Result{}, err
	}
	result := Result{ParserVersion: ParserVersion, Status: StatusParsed}
	collector := newMetadataCollector()
	metadataDocuments := 0

	files := append([]*zip.File(nil), zr.File...)
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	for _, f := range files {
		if f.FileInfo().IsDir() {
			continue
		}
		lower := strings.ToLower(f.Name)
		switch {
		case isMetadataDocument(lower):
			metadataDocuments++
			data, readErr := readBoundedZipFile(f, limits.MaxMetadataSize)
			if readErr != nil {
				result.addWarning("metadata entry could not be read: " + f.Name)
				continue
			}
			trimmed := bytes.TrimSpace(data)
			var parseErr error
			if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
				parseErr = collector.addJSON(data)
				if parseErr == nil && path.Base(lower) == "filament_sequence.json" {
					parseErr = collector.addFilamentSequenceJSON(data)
				}
			} else {
				parseErr = collector.addXML(data)
			}
			if parseErr != nil {
				result.addWarning("metadata document could not be parsed: " + f.Name)
			}
		}
	}
	if metadataDocuments == 0 {
		result.addWarning("no supported Bambu metadata document was found")
	}
	result.Metadata, result.Filaments = collector.finish()
	result.FilamentSequence = append(result.FilamentSequence, collector.filamentSequence...)
	if metadataDocuments > 0 && !hasRecognizedMetadata(result.Metadata, result.Filaments, collector.previewReferences) {
		result.addWarning("Bambu metadata contained no recognized fields")
	}

	for _, f := range files {
		if f.FileInfo().IsDir() {
			continue
		}
		lower := strings.ToLower(f.Name)
		if isPreviewCandidate(lower) {
			preview, previewErr := parsePreview(f, limits)
			if previewErr != nil {
				result.addWarning("preview was rejected: " + f.Name)
				continue
			}
			result.Previews = append(result.Previews, preview)
		}
	}
	result.Previews = deduplicatePreviews(result.Previews)
	selectPrimaryPreview(result.Previews, collector.previewReferences)

	filamentOptions := make([]GCodeFilament, 0, len(result.Filaments))
	for _, filament := range result.Filaments {
		filamentOptions = append(filamentOptions, GCodeFilament{
			ID: filament.ID, DiameterMM: filament.DiameterMM, DensityGCM3: filament.DensityGCM3,
			FullLengthMM: filament.LengthMM, FullWeightGrams: filament.WeightGrams,
		})
	}
	var physicalExtruder *int
	if strings.Contains(strings.ToLower(result.Metadata.PrinterProfile), "x1 carbon") {
		value := 1
		physicalExtruder = &value
	}
	for _, f := range files {
		if f.FileInfo().IsDir() || !strings.HasSuffix(strings.ToLower(f.Name), ".gcode") {
			continue
		}
		rc, openErr := f.Open()
		if openErr != nil {
			result.addWarning("G-code entry could not be opened: " + f.Name)
			continue
		}
		estimate, estimateErr := EstimateGCode(
			rc,
			GCodeOptions{Filaments: filamentOptions, PhysicalExtruder: physicalExtruder},
		)
		_ = rc.Close()
		if estimateErr != nil {
			result.addWarning("G-code entry could not be estimated: " + f.Name)
			continue
		}
		result.GCode = append(
			result.GCode,
			GCodeFile{ArchivePath: f.Name, PlateNumber: plateNumberFromPath(f.Name), Estimate: estimate},
		)
	}
	if len(result.Warnings) > 0 {
		result.Status = StatusPartial
	}
	return result, nil
}

// EstimateArchiveGCode applies a printer checkpoint to every G-code entry in
// a validated archive. Callers use this for interrupted prints; it deliberately
// does not scale a complete-file estimate by an observed percentage.
func EstimateArchiveGCode(
	r io.ReaderAt,
	compressedSize int64,
	limits Limits,
	options GCodeOptions,
) ([]GCodeFile, error) {
	zr, err := OpenValidated(r, compressedSize, limits)
	if err != nil {
		return nil, err
	}
	files := append([]*zip.File(nil), zr.File...)
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	result := make([]GCodeFile, 0)
	for _, file := range files {
		if file.FileInfo().IsDir() || !strings.HasSuffix(strings.ToLower(file.Name), ".gcode") {
			continue
		}
		stream, openErr := file.Open()
		if openErr != nil {
			return nil, fmt.Errorf("open G-code entry %q: %w", file.Name, openErr)
		}
		estimate, estimateErr := EstimateGCode(stream, options)
		closeErr := stream.Close()
		if estimateErr != nil {
			return nil, fmt.Errorf("estimate G-code entry %q: %w", file.Name, estimateErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close G-code entry %q: %w", file.Name, closeErr)
		}
		result = append(
			result,
			GCodeFile{ArchivePath: file.Name, PlateNumber: plateNumberFromPath(file.Name), Estimate: estimate},
		)
	}
	return result, nil
}

func (r *Result) addWarning(warning string) {
	if len(r.Warnings) >= 128 {
		return
	}
	r.Warnings = append(r.Warnings, warning)
}

func isMetadataDocument(name string) bool {
	return strings.HasPrefix(name, "metadata/") &&
		(strings.HasSuffix(name, ".xml") || strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".config"))
}

func readBoundedZipFile(f *zip.File, limit int64) ([]byte, error) {
	if f.UncompressedSize64 > uint64(limit) {
		return nil, errors.New("entry exceeds read limit")
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("entry exceeds read limit")
	}
	return data, nil
}

func isPreviewCandidate(name string) bool {
	ext := strings.ToLower(path.Ext(name))
	if ext != ".png" && ext != ".jpg" && ext != ".jpeg" {
		return false
	}
	base := strings.ToLower(path.Base(name))
	return strings.Contains(base, "plate") || strings.Contains(base, "thumbnail") || strings.Contains(base, "preview")
}

func parsePreview(f *zip.File, limits Limits) (Preview, error) {
	data, err := readBoundedZipFile(f, limits.MaxPreviewSize)
	if err != nil {
		return Preview{}, err
	}
	mimeType := http.DetectContentType(data)
	if mimeType != "image/png" && mimeType != "image/jpeg" {
		return Preview{}, errors.New("unsupported image format")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return Preview{}, err
	}
	if (format == "png" && mimeType != "image/png") || (format == "jpeg" && mimeType != "image/jpeg") {
		return Preview{}, errors.New("image signature and decoder disagree")
	}
	if config.Width <= 0 || config.Height <= 0 || uint64(config.Width) > limits.MaxPreviewPixels/uint64(config.Height) {
		return Preview{}, errors.New("image dimensions exceed limit")
	}
	if _, decodedFormat, decodeErr := image.Decode(bytes.NewReader(data)); decodeErr != nil || decodedFormat != format {
		if decodeErr != nil {
			return Preview{}, decodeErr
		}
		return Preview{}, errors.New("image could not be decoded consistently")
	}
	hash := sha256.Sum256(data)
	role := PreviewRolePreview
	lower := strings.ToLower(path.Base(f.Name))
	if strings.Contains(lower, "plate") {
		role = PreviewRolePlate
	} else if strings.Contains(lower, "thumbnail") {
		role = PreviewRoleThumbnail
	}
	return Preview{
		ArchivePath: f.Name,
		Role:        role,
		PlateNumber: plateNumberFromPath(f.Name),
		Width:       config.Width,
		Height:      config.Height,
		MIMEType:    mimeType,
		Size:        int64(len(data)),
		SHA256:      hex.EncodeToString(hash[:]),
		Bytes:       data,
	}, nil
}

func deduplicatePreviews(previews []Preview) []Preview {
	seen := make(map[string]struct{}, len(previews))
	result := make([]Preview, 0, len(previews))
	for _, preview := range previews {
		if _, exists := seen[preview.SHA256]; exists {
			continue
		}
		seen[preview.SHA256] = struct{}{}
		result = append(result, preview)
	}
	return result
}

func selectPrimaryPreview(previews []Preview, references []string) {
	if len(previews) == 0 {
		return
	}
	refSet := make(map[string]struct{}, len(references)*2)
	for _, ref := range references {
		cleaned := strings.ToLower(path.Clean(strings.ReplaceAll(ref, "\\", "/")))
		refSet[cleaned] = struct{}{}
		refSet[path.Base(cleaned)] = struct{}{}
	}
	for i := range previews {
		candidate := strings.ToLower(path.Clean(previews[i].ArchivePath))
		if _, ok := refSet[candidate]; ok {
			previews[i].Primary = true
			return
		}
		if _, ok := refSet[path.Base(candidate)]; ok {
			previews[i].Primary = true
			return
		}
	}
	best := -1
	for i := range previews {
		if best < 0 {
			best = i
			continue
		}
		bestIsPlate := previews[best].Role == PreviewRolePlate
		currentIsPlate := previews[i].Role == PreviewRolePlate
		bestPixels := int64(previews[best].Width) * int64(previews[best].Height)
		currentPixels := int64(previews[i].Width) * int64(previews[i].Height)
		if (currentIsPlate && !bestIsPlate) ||
			(currentIsPlate == bestIsPlate && (currentPixels > bestPixels || (currentPixels == bestPixels && previews[i].ArchivePath < previews[best].ArchivePath))) {
			best = i
		}
	}
	previews[best].Primary = true
}

var platePattern = regexp.MustCompile(`(?i)(?:plate[_ -]?|plate/)(\d+)`)

func plateNumberFromPath(name string) *int {
	match := platePattern.FindStringSubmatch(name)
	if len(match) != 2 {
		return nil
	}
	number, err := strconv.Atoi(match[1])
	if err != nil {
		return nil
	}
	return &number
}

type metadataCollector struct {
	values            map[string][]string
	filaments         map[string]*Filament
	nozzleExtruders   map[int]int
	filamentSequence  []string
	modelNames        map[string]struct{}
	plateNumbers      map[int]struct{}
	previewReferences []string
}

func newMetadataCollector() *metadataCollector {
	return &metadataCollector{
		values: make(map[string][]string), filaments: make(map[string]*Filament),
		nozzleExtruders: make(map[int]int),
		modelNames:      make(map[string]struct{}), plateNumbers: make(map[int]struct{}),
	}
}

func (c *metadataCollector) addFilamentSequenceJSON(data []byte) error {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	var walk func(any)
	walk = func(current any) {
		switch typed := current.(type) {
		case map[string]any:
			keys := make([]string, 0, len(typed))
			for key := range typed {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				child := typed[key]
				if normalizeKey(key) == "sequence" {
					if sequence, ok := child.([]any); ok {
						for _, raw := range sequence {
							id := strings.TrimSpace(fmt.Sprint(raw))
							if id != "" && !containsString(c.filamentSequence, id) {
								c.filamentSequence = append(c.filamentSequence, id)
							}
						}
					}
				}
				walk(child)
			}
		case []any:
			for _, child := range typed {
				walk(child)
			}
		}
	}
	walk(value)
	return nil
}

func normalizeKey(key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	key = strings.NewReplacer("-", "_", " ", "_", ".", "_").Replace(key)
	for strings.Contains(key, "__") {
		key = strings.ReplaceAll(key, "__", "_")
	}
	return strings.Trim(key, "_")
}

func (c *metadataCollector) addValue(key, value string) {
	key, value = normalizeKey(key), strings.TrimSpace(value)
	if key == "" || value == "" {
		return
	}
	c.values[key] = append(c.values[key], value)
	if looksLikePreviewReference(value) {
		c.previewReferences = append(c.previewReferences, value)
	}
}

func looksLikePreviewReference(value string) bool {
	lower := strings.ToLower(value)
	ext := path.Ext(lower)
	return (ext == ".png" || ext == ".jpg" || ext == ".jpeg") &&
		(strings.Contains(lower, "plate") || strings.Contains(lower, "thumbnail") || strings.Contains(lower, "preview"))
}

func (c *metadataCollector) addJSON(data []byte) error {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	c.walkJSON("", value)
	return nil
}

func (c *metadataCollector) walkJSON(key string, value any) {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for childKey := range typed {
			keys = append(keys, childKey)
		}
		sort.Strings(keys)
		for _, childKey := range keys {
			c.walkJSON(childKey, typed[childKey])
		}
	case []any:
		for i, item := range typed {
			if isScalar(item) {
				c.addValue(key+"_"+strconv.Itoa(i), fmt.Sprint(item))
				c.addValue(key, fmt.Sprint(item))
			} else {
				c.walkJSON(key+"_"+strconv.Itoa(i), item)
			}
		}
	case string:
		c.addValue(key, typed)
	case float64, bool, json.Number:
		c.addValue(key, fmt.Sprint(typed))
	}
}

func isScalar(value any) bool {
	switch value.(type) {
	case string, float64, bool, json.Number:
		return true
	default:
		return false
	}
}

func (c *metadataCollector) addXML(data []byte) error {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var textKey string
	depth := 0
	objectDepth := -1
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			depth++
			attrs := make(map[string]string, len(typed.Attr))
			for _, attr := range typed.Attr {
				attrs[normalizeKey(attr.Name.Local)] = strings.TrimSpace(attr.Value)
			}
			name := normalizeKey(typed.Name.Local)
			key := firstNonEmpty(attrs["key"], attrs["name"], attrs["type"])
			value := firstNonEmpty(attrs["value"], attrs["val"])
			if key != "" && value != "" {
				c.addValue(key, value)
				if objectDepth >= 0 && normalizeKey(key) == "name" {
					c.modelNames[value] = struct{}{}
				}
			}
			if name == "filament" {
				c.addFilamentAttrs(attrs)
			}
			if name == "nozzle" {
				if id, idOK := parseInt(attrs["id"]); idOK {
					if extruder, extruderOK := parseInt(attrs["extruder_id"]); extruderOK {
						c.nozzleExtruders[id] = extruder
					}
				}
			}
			if name == "object" || name == "model" {
				objectDepth = depth
				if modelName := firstNonEmpty(attrs["name"], attrs["title"]); modelName != "" {
					c.modelNames[modelName] = struct{}{}
				}
			}
			if name == "plate" {
				if number, ok := parseInt(firstNonEmpty(attrs["id"], attrs["index"], attrs["plate_number"])); ok {
					c.plateNumbers[number] = struct{}{}
				}
			}
			textKey = key
		case xml.CharData:
			if textKey != "" {
				c.addValue(textKey, string(typed))
			}
		case xml.EndElement:
			if depth == objectDepth {
				objectDepth = -1
			}
			depth--
			textKey = ""
		}
	}
}

func (c *metadataCollector) addFilamentAttrs(attrs map[string]string) {
	id := firstNonEmpty(attrs["id"], attrs["filament_id"], attrs["tray_id"])
	if id == "" {
		return
	}
	filament := c.ensureFilament(id)
	filament.Type = firstNonEmpty(filament.Type, attrs["type"], attrs["filament_type"])
	filament.Color = firstNonEmpty(filament.Color, attrs["color"], attrs["colour"], attrs["filament_color"])
	setFloat(&filament.LengthMM, firstNonEmpty(attrs["used_mm"], attrs["length_mm"], attrs["filament_used_mm"]))
	if filament.LengthMM == nil {
		if meters, ok := parseFloat(firstNonEmpty(attrs["used_m"], attrs["length_m"])); ok {
			mm := meters * 1000
			filament.LengthMM = &mm
		}
	}
	setFloat(&filament.WeightGrams, firstNonEmpty(attrs["used_g"], attrs["weight_g"], attrs["filament_used_g"]))
	setFloat(&filament.DensityGCM3, firstNonEmpty(attrs["density"], attrs["density_g_cm3"]))
	setFloat(&filament.DiameterMM, firstNonEmpty(attrs["diameter"], attrs["diameter_mm"]))
	setFloat(&filament.NozzleDiameter, firstNonEmpty(attrs["nozzle_diameter"], attrs["nozzle_diameter_mm"]))
	if extruder, ok := parseInt(firstNonEmpty(attrs["extruder"], attrs["tool"])); ok {
		filament.Extruders = appendUniqueInt(filament.Extruders, extruder)
	}
}

func (c *metadataCollector) ensureFilament(id string) *Filament {
	id = strings.TrimSpace(id)
	if c.filaments[id] == nil {
		c.filaments[id] = &Filament{ID: id}
	}
	return c.filaments[id]
}

func (c *metadataCollector) finish() (Metadata, []Filament) {
	metadata := Metadata{
		JobName:       firstValue(c.values, "job_name", "project_name", "print_name", "title"),
		SlicerName:    firstValue(c.values, "slicer_name", "slicer"),
		SlicerVersion: firstValue(c.values, "slicer_version", "version"),
		PrinterProfile: firstValue(
			c.values,
			"printer_profile",
			"printer_settings_id",
			"print_settings_id",
			"printer_model",
		),
		BuildPlate: firstValue(c.values, "build_plate", "plate_type", "bed_type", "curr_bed_type"),
	}
	setFloat(
		&metadata.EstimatedDurationSeconds,
		firstValue(c.values, "estimated_duration_seconds", "estimated_print_time", "print_time", "duration"),
	)
	setInt(&metadata.LayerCount, firstValue(c.values, "total_layer_count", "layer_count"))
	setInt(&metadata.FilamentChanges, firstValue(c.values, "filament_changes", "filament_change_count"))
	setFloat(&metadata.PurgeWeightGrams, firstValue(c.values, "purge_weight_g", "flush_weight_g", "purge_weight_grams"))

	// Project settings commonly encode filament properties as parallel arrays.
	// Preserve explicit IDs rather than assuming they are contiguous indexes.
	indexIDs := make(map[int]string)
	for key, values := range c.values {
		base, index, ok := indexedKey(key)
		if ok && (base == "filament_id" || base == "filament_ids") && len(values) > 0 {
			indexIDs[index] = values[0]
		}
	}
	// Bambu slice_info uses one-based filament IDs, while filament_maps is a
	// parallel array of one-based logical nozzle IDs. H2D then records the
	// physical extruder for each logical nozzle in <nozzle extruder_id="...">.
	// Keep explicit per-filament attributes authoritative and use this mapping
	// only when no direct extruder was supplied.
	filamentMaps := splitIntegerList(firstValue(c.values, "filament_maps", "filament_map"))
	for id, filament := range c.filaments {
		if len(filament.Extruders) != 0 || len(filamentMaps) == 0 {
			continue
		}
		filamentID, ok := parseInt(id)
		if !ok {
			continue
		}
		index := filamentID - 1
		if filamentID == 0 {
			index = 0
		}
		if index < 0 || index >= len(filamentMaps) || filamentMaps[index] <= 0 {
			continue
		}
		logicalNozzle := filamentMaps[index] - 1
		physicalExtruder := logicalNozzle
		if mapped, exists := c.nozzleExtruders[logicalNozzle]; exists {
			physicalExtruder = mapped
		}
		filament.Extruders = appendUniqueInt(filament.Extruders, physicalExtruder)
	}
	for key, values := range c.values {
		base, index, ok := indexedKey(key)
		if !ok || !isFilamentIndexedBase(base) {
			continue
		}
		id := strconv.Itoa(index)
		if explicitID := indexIDs[index]; explicitID != "" {
			id = explicitID
		}
		filament := c.ensureFilament(id)
		value := values[0]
		switch base {
		case "filament_id", "filament_ids":
			// The explicit ID was applied above and is itself useful metadata.
		case "filament_type":
			filament.Type = firstNonEmpty(filament.Type, value)
		case "filament_colour", "filament_color":
			filament.Color = firstNonEmpty(filament.Color, value)
		case "filament_diameter":
			setFloatIfNil(&filament.DiameterMM, value)
		case "filament_density":
			setFloatIfNil(&filament.DensityGCM3, value)
		case "filament_used_mm", "filament_length_mm":
			setFloatIfNil(&filament.LengthMM, value)
		case "filament_used_g", "filament_weight_g":
			setFloatIfNil(&filament.WeightGrams, value)
		case "filament_extruder", "filament_tool", "extruder", "tool":
			if extruder, ok := parseInt(value); ok {
				filament.Extruders = appendUniqueInt(filament.Extruders, extruder)
			}
		case "nozzle_diameter", "filament_nozzle_diameter":
			setFloatIfNil(&filament.NozzleDiameter, value)
		}
	}
	for _, key := range []string{"plate_number", "plate_index", "plate_id"} {
		for _, value := range c.values[key] {
			if number, ok := parseInt(value); ok {
				c.plateNumbers[number] = struct{}{}
			}
		}
	}
	for _, key := range []string{"model_name", "object_name"} {
		for _, value := range c.values[key] {
			if value != "" {
				c.modelNames[value] = struct{}{}
			}
		}
	}
	for name := range c.modelNames {
		metadata.ModelNames = append(metadata.ModelNames, name)
	}
	sort.Strings(metadata.ModelNames)
	for number := range c.plateNumbers {
		metadata.PlateNumbers = append(metadata.PlateNumbers, number)
	}
	sort.Ints(metadata.PlateNumbers)
	filaments := make([]Filament, 0, len(c.filaments))
	for _, filament := range c.filaments {
		sort.Ints(filament.Extruders)
		filaments = append(filaments, *filament)
	}
	sort.Slice(filaments, func(i, j int) bool { return numericStringLess(filaments[i].ID, filaments[j].ID) })
	return metadata, filaments
}

func isFilamentIndexedBase(base string) bool {
	switch base {
	case "filament_id", "filament_ids", "filament_type", "filament_colour", "filament_color",
		"filament_diameter", "filament_density", "filament_used_mm", "filament_length_mm",
		"filament_used_g", "filament_weight_g", "filament_extruder", "filament_tool", "extruder",
		"tool", "nozzle_diameter", "filament_nozzle_diameter":
		return true
	default:
		return false
	}
}

func hasRecognizedMetadata(metadata Metadata, filaments []Filament, previewReferences []string) bool {
	return metadata.JobName != "" || metadata.SlicerName != "" || metadata.SlicerVersion != "" ||
		metadata.PrinterProfile != "" || metadata.BuildPlate != "" || len(metadata.ModelNames) > 0 ||
		len(metadata.PlateNumbers) > 0 || metadata.EstimatedDurationSeconds != nil || metadata.LayerCount != nil ||
		metadata.FilamentChanges != nil || metadata.PurgeWeightGrams != nil || len(filaments) > 0 || len(previewReferences) > 0
}

func firstValue(values map[string][]string, keys ...string) string {
	for _, key := range keys {
		if candidates := values[key]; len(candidates) > 0 {
			return candidates[0]
		}
	}
	return ""
}

func indexedKey(key string) (string, int, bool) {
	index := strings.LastIndexByte(key, '_')
	if index < 0 {
		return "", 0, false
	}
	n, err := strconv.Atoi(key[index+1:])
	return key[:index], n, err == nil
}

func numericStringLess(a, b string) bool {
	ai, aErr := strconv.Atoi(a)
	bi, bErr := strconv.Atoi(b)
	if aErr == nil && bErr == nil {
		return ai < bi
	}
	return a < b
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func parseFloat(value string) (float64, bool) {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	return parsed, err == nil
}

func parseInt(value string) (int, bool) {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	return parsed, err == nil
}

func setFloat(target **float64, value string) {
	if parsed, ok := parseFloat(value); ok {
		*target = &parsed
	}
}

func setFloatIfNil(target **float64, value string) {
	if *target == nil {
		setFloat(target, value)
	}
}

func setInt(target **int, value string) {
	if parsed, ok := parseInt(value); ok {
		*target = &parsed
	}
}

func appendUniqueInt(values []int, value int) []int {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func containsString(values []string, value string) bool {
	for _, existing := range values {
		if existing == value {
			return true
		}
	}
	return false
}

func splitIntegerList(value string) []int {
	fields := strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\t' || r == '\r' || r == '\n'
	})
	result := make([]int, 0, len(fields))
	for _, field := range fields {
		parsed, err := strconv.Atoi(field)
		if err != nil {
			return nil
		}
		result = append(result, parsed)
	}
	return result
}
