package signage

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// RawWidget is the canonical JSON of one widget as stored in signage_scenes.zones.
type RawWidget = json.RawMessage

var emptyWidget = RawWidget(`{"type":"empty"}`)

const (
	maxZonesJSONBytes   = 96 << 10
	maxSlideshowAssets  = 50
	maxStatusMachines   = 20
	maxWidgetTemplates  = 50
	maxTextWidgetRunes  = 1000
	maxQRURLRunes       = 500
	maxCaptionRunes     = 200
	maxFallbackTextRune = 500
)

// WidgetRefs lists the entities a set of widgets points at; the service verifies they exist.
type WidgetRefs struct {
	ImageAssets []uuid.UUID
	VideoAssets []uuid.UUID
	Machines    []uuid.UUID
	Templates   []uuid.UUID
}

func (r *WidgetRefs) merge(other WidgetRefs) {
	r.ImageAssets = append(r.ImageAssets, other.ImageAssets...)
	r.VideoAssets = append(r.VideoAssets, other.VideoAssets...)
	r.Machines = append(r.Machines, other.Machines...)
	r.Templates = append(r.Templates, other.Templates...)
}

// AllAssets returns the distinct asset ids referenced by any widget.
func (r WidgetRefs) AllAssets() []uuid.UUID {
	return distinct(append(append([]uuid.UUID{}, r.ImageAssets...), r.VideoAssets...))
}

func distinct(ids []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(ids))
	result := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; !ok {
			seen[id] = struct{}{}
			result = append(result, id)
		}
	}
	return result
}

type widgetType struct {
	Type WidgetType `json:"type"`
}

type emptyW struct {
	Type WidgetType `json:"type"`
}
type mediaW struct {
	Type    WidgetType `json:"type"`
	MediaID *uuid.UUID `json:"mediaId"`
	Fit     MediaFit   `json:"fit"`
}
type slideshowW struct {
	Type     WidgetType  `json:"type"`
	MediaIDs []uuid.UUID `json:"mediaIds"`
	Seconds  int         `json:"seconds"`
}
type textW struct {
	Type  WidgetType `json:"type"`
	Text  string     `json:"text"`
	Size  TextSize   `json:"size"`
	Align TextAlign  `json:"align"`
}
type qrW struct {
	Type    WidgetType `json:"type"`
	URL     string     `json:"url"`
	Caption string     `json:"caption"`
}
type clockW struct {
	Type WidgetType `json:"type"`
	Mode ClockMode  `json:"mode"`
}
type cameraW struct {
	Type            WidgetType     `json:"type"`
	Source          CameraSource   `json:"source"`
	MachineID       *uuid.UUID     `json:"machineId"`
	Multi           MultiMode      `json:"multi"`
	ShowProgress    bool           `json:"showProgress"`
	ShowRemaining   bool           `json:"showRemaining"`
	Fallback        CameraFallback `json:"fallback"`
	FallbackMediaID *uuid.UUID     `json:"fallbackMediaId"`
	MachineIDs      []uuid.UUID    `json:"machineIds"`
}
type statusW struct {
	Type          WidgetType  `json:"type"`
	MachineIDs    []uuid.UUID `json:"machineIds"`
	ShowProgress  bool        `json:"showProgress"`
	ShowRemaining bool        `json:"showRemaining"`
}
type countW struct {
	Type  WidgetType `json:"type"`
	Count int        `json:"count"`
}
type announcementW struct {
	Type          WidgetType        `json:"type"`
	TemplateIDs   []uuid.UUID       `json:"templateIds"`
	Style         AnnouncementStyle `json:"style"`
	Size          TextSize          `json:"size"`
	WhenNone      WhenNone          `json:"whenNone"`
	FallbackText  string            `json:"fallbackText"`
	WhenMany      WhenMany          `json:"whenMany"`
	RotateSeconds int               `json:"rotateSeconds"`
}

func zoneError(zone, format string, args ...any) error {
	return apperror.New(http.StatusUnprocessableEntity, "validation_failed", fmt.Sprintf("zone %q: %s", zone, fmt.Sprintf(format, args...)))
}

func inSet[T comparable](value T, allowed ...T) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

// plainText accepts text for text nodes: valid UTF-8, no control characters (newlines only when
// multiline), at most max runes. HTML is never interpreted by renderers, so markup is not rejected.
func plainText(value string, max int, multiline bool) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > max {
		return false
	}
	for _, r := range value {
		if r == '\n' && multiline {
			continue
		}
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func strictDecode(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("unexpected trailing data")
	}
	return nil
}

// ValidateWidget strictly decodes one widget and returns its canonical JSON and references.
func ValidateWidget(zone string, raw json.RawMessage) (RawWidget, WidgetRefs, error) {
	var head widgetType
	var generic map[string]json.RawMessage
	if err := json.Unmarshal(raw, &generic); err != nil || generic == nil {
		return nil, WidgetRefs{}, zoneError(zone, "widget must be an object")
	}
	if err := json.Unmarshal(generic["type"], &head.Type); err != nil {
		return nil, WidgetRefs{}, zoneError(zone, "widget type is required")
	}
	var refs WidgetRefs
	var value any
	decode := func(target any) error {
		if err := strictDecode(raw, target); err != nil {
			return zoneError(zone, "invalid %s widget: %s", head.Type, decodeMessage(err))
		}
		value = target
		return nil
	}
	switch head.Type {
	case WidgetEmpty:
		var w emptyW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
	case WidgetImage, WidgetVideo:
		var w mediaW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !inSet(w.Fit, MediaFitContain, MediaFitCover) {
			return nil, refs, zoneError(zone, "fit must be contain or cover")
		}
		if w.MediaID != nil {
			if head.Type == WidgetImage {
				refs.ImageAssets = append(refs.ImageAssets, *w.MediaID)
			} else {
				refs.VideoAssets = append(refs.VideoAssets, *w.MediaID)
			}
		}
	case WidgetSlideshow:
		var w slideshowW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if w.MediaIDs == nil {
			w.MediaIDs = []uuid.UUID{}
		}
		if len(w.MediaIDs) > maxSlideshowAssets {
			return nil, refs, zoneError(zone, "a slideshow holds at most %d images", maxSlideshowAssets)
		}
		if w.Seconds < 3 || w.Seconds > 3600 {
			return nil, refs, zoneError(zone, "slideshow seconds must be between 3 and 3600")
		}
		refs.ImageAssets = append(refs.ImageAssets, w.MediaIDs...)
		value = &w
	case WidgetText:
		var w textW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !plainText(w.Text, maxTextWidgetRunes, true) {
			return nil, refs, zoneError(zone, "text must be plain text of at most %d characters", maxTextWidgetRunes)
		}
		if !inSet(w.Size, TextSizeS, TextSizeM, TextSizeL, TextSizeXL) || !inSet(w.Align, TextAlignStart, TextAlignCenter, TextAlignEnd) {
			return nil, refs, zoneError(zone, "text size or alignment is invalid")
		}
	case WidgetQR:
		var w qrW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if err := validateHTTPSURL(w.URL); err != nil {
			return nil, refs, zoneError(zone, "%s", err.Error())
		}
		if !plainText(w.Caption, maxCaptionRunes, false) {
			return nil, refs, zoneError(
				zone,
				"QR caption must be single-line plain text of at most %d characters",
				maxCaptionRunes,
			)
		}
	case WidgetClock:
		var w clockW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !inSet(w.Mode, ClockTime, ClockDateTime) {
			return nil, refs, zoneError(zone, "clock mode must be time or datetime")
		}
	case WidgetCamera:
		var w cameraW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !inSet(w.Source, CameraSourceMachine, CameraSourceAuto) || !inSet(w.Multi, MultiModeSplit, MultiModeAlternate) ||
			!inSet(w.Fallback, CameraFallbackImage, CameraFallbackText, CameraFallbackHide) {
			return nil, refs, zoneError(zone, "camera source, multi mode or fallback is invalid")
		}
		if w.Source == CameraSourceMachine && w.MachineID == nil {
			return nil, refs, zoneError(zone, "a camera bound to a machine needs machineId")
		}
		if w.MachineIDs == nil {
			w.MachineIDs = []uuid.UUID{}
		}
		if len(w.MachineIDs) > maxStatusMachines {
			return nil, refs, zoneError(zone, "a camera widget lists at most %d machines", maxStatusMachines)
		}
		if len(distinct(w.MachineIDs)) != len(w.MachineIDs) {
			return nil, refs, zoneError(zone, "camera machines must be distinct")
		}
		if w.Source == CameraSourceAuto {
			w.MachineID = nil
			refs.Machines = append(refs.Machines, w.MachineIDs...)
		} else {
			w.MachineIDs = []uuid.UUID{}
		}
		if w.MachineID != nil {
			refs.Machines = append(refs.Machines, *w.MachineID)
		}
		if w.Fallback != CameraFallbackImage {
			w.FallbackMediaID = nil
		}
		if w.FallbackMediaID != nil {
			refs.ImageAssets = append(refs.ImageAssets, *w.FallbackMediaID)
		}
		value = &w
	case WidgetStatus:
		var w statusW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if w.MachineIDs == nil {
			w.MachineIDs = []uuid.UUID{}
		}
		if len(w.MachineIDs) > maxStatusMachines {
			return nil, refs, zoneError(zone, "a status widget lists at most %d machines", maxStatusMachines)
		}
		w.MachineIDs = distinct(w.MachineIDs)
		refs.Machines = append(refs.Machines, w.MachineIDs...)
		value = &w
	case WidgetOpenDays, WidgetEvents:
		var w countW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if w.Count < 1 || w.Count > 10 {
			return nil, refs, zoneError(zone, "count must be between 1 and 10")
		}
	case WidgetAnnouncement:
		var w announcementW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if w.TemplateIDs == nil {
			w.TemplateIDs = []uuid.UUID{}
		}
		if len(w.TemplateIDs) > maxWidgetTemplates {
			return nil, refs, zoneError(zone, "an announcement widget filters at most %d templates", maxWidgetTemplates)
		}
		w.TemplateIDs = distinct(w.TemplateIDs)
		if !inSet(w.Style, AnnouncementStyleBanner, AnnouncementStyleCard, AnnouncementStyleFull) ||
			!inSet(w.Size, TextSizeS, TextSizeM, TextSizeL, TextSizeXL) ||
			!inSet(w.WhenNone, WhenNoneEmpty, WhenNoneText) ||
			!inSet(w.WhenMany, WhenManyRotate, WhenManyNewest, WhenManyStack) {
			return nil, refs, zoneError(zone, "announcement style, size, whenNone or whenMany is invalid")
		}
		if !plainText(w.FallbackText, maxFallbackTextRune, true) {
			return nil, refs, zoneError(
				zone,
				"fallback text must be plain text of at most %d characters",
				maxFallbackTextRune,
			)
		}
		if w.RotateSeconds < 3 || w.RotateSeconds > 300 {
			return nil, refs, zoneError(zone, "rotateSeconds must be between 3 and 300")
		}
		refs.Templates = append(refs.Templates, w.TemplateIDs...)
		value = &w
	default:
		return nil, refs, zoneError(zone, "unknown widget type")
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return nil, refs, err
	}
	return canonical, refs, nil
}

func decodeMessage(err error) string {
	message := err.Error()
	if strings.HasPrefix(message, "json: unknown field") {
		return strings.TrimPrefix(message, "json: ")
	}
	return "malformed fields"
}

func validateHTTPSURL(raw string) error {
	if raw == "" || utf8.RuneCountInString(raw) > maxQRURLRunes || !plainText(raw, maxQRURLRunes, false) {
		return fmt.Errorf("QR code URL is required and limited to %d characters", maxQRURLRunes)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return fmt.Errorf("QR code URL must be an https:// URL without credentials")
	}
	return nil
}

// ParseZones validates a scene's zone map against its layout. Zone ids outside the layout are
// rejected; layout zones that are missing become empty widgets. The result holds canonical JSON.
func ParseZones(layout Layout, raw map[string]json.RawMessage) (map[string]RawWidget, WidgetRefs, error) {
	known := make(map[string]struct{}, len(layout.Zones))
	for _, zone := range layout.Zones {
		known[zone.ID] = struct{}{}
	}
	keys := make([]string, 0, len(raw))
	for key := range raw {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if _, ok := known[key]; !ok {
			return nil, WidgetRefs{}, apperror.New(
				http.StatusUnprocessableEntity,
				"validation_failed",
				fmt.Sprintf("zone %q does not belong to layout %q", key, layout.ID),
			)
		}
	}
	result := make(map[string]RawWidget, len(layout.Zones))
	var refs WidgetRefs
	total := 0
	for _, zone := range layout.Zones {
		widgetRaw, ok := raw[zone.ID]
		if !ok {
			result[zone.ID] = emptyWidget
			continue
		}
		canonical, widgetRefs, err := ValidateWidget(zone.ID, widgetRaw)
		if err != nil {
			return nil, WidgetRefs{}, err
		}
		total += len(canonical)
		result[zone.ID] = canonical
		refs.merge(widgetRefs)
	}
	if total > maxZonesJSONBytes {
		return nil, WidgetRefs{}, apperror.New(http.StatusUnprocessableEntity, "validation_failed", "scene zones are too large")
	}
	refs.ImageAssets, refs.VideoAssets = distinct(refs.ImageAssets), distinct(refs.VideoAssets)
	refs.Machines, refs.Templates = distinct(refs.Machines), distinct(refs.Templates)
	return result, refs, nil
}

func marshalZones(zones map[string]RawWidget) ([]byte, error) {
	return json.Marshal(zones)
}
