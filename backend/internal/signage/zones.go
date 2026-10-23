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
	// maxZonesJSONBytes bounds the canonical widgets of one scene; rich text widgets may hold
	// several tens of thousands of characters each.
	maxZonesJSONBytes   = 1 << 20
	maxSlideshowAssets  = 50
	maxStatusMachines   = 20
	maxWidgetTemplates  = 50
	maxTextWidgetRunes  = 20000
	maxRichCSSRunes     = 20000
	maxWidgetFonts      = 10
	maxListEntries      = 20
	maxListTitleRunes   = 200
	maxListEmptyRunes   = 500
	maxEntryTemplateRun = 5000
	maxCalendarWeeks    = 6
	maxQRURLRunes       = 500
	maxCaptionRunes     = 200
	maxFallbackTextRune = 500
)

// WidgetRefs lists the entities a set of widgets points at; the service verifies they exist.
type WidgetRefs struct {
	ImageAssets []uuid.UUID
	VideoAssets []uuid.UUID
	FontAssets  []uuid.UUID
	Machines    []uuid.UUID
	Templates   []uuid.UUID
}

func (r *WidgetRefs) merge(other WidgetRefs) {
	r.ImageAssets = append(r.ImageAssets, other.ImageAssets...)
	r.VideoAssets = append(r.VideoAssets, other.VideoAssets...)
	r.FontAssets = append(r.FontAssets, other.FontAssets...)
	r.Machines = append(r.Machines, other.Machines...)
	r.Templates = append(r.Templates, other.Templates...)
}

// AllAssets returns the distinct asset ids (images, videos and fonts) referenced by any widget.
func (r WidgetRefs) AllAssets() []uuid.UUID {
	all := append(append(append([]uuid.UUID{}, r.ImageAssets...), r.VideoAssets...), r.FontAssets...)
	return distinct(all)
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
	styled
}
type mediaW struct {
	Type    WidgetType `json:"type"`
	MediaID *uuid.UUID `json:"mediaId"`
	Fit     MediaFit   `json:"fit"`
	styled
}
type slideshowW struct {
	Type     WidgetType  `json:"type"`
	MediaIDs []uuid.UUID `json:"mediaIds"`
	Seconds  int         `json:"seconds"`
	styled
}
type textW struct {
	Type  WidgetType `json:"type"`
	Text  string     `json:"text"`
	Size  TextSize   `json:"size"`
	Align TextAlign  `json:"align"`
	richFields
	styled
}
type qrW struct {
	Type    WidgetType `json:"type"`
	URL     string     `json:"url"`
	Caption string     `json:"caption"`
	styled
}
type clockW struct {
	Type WidgetType `json:"type"`
	Mode ClockMode  `json:"mode"`
	styled
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
	styled
}
type statusW struct {
	Type          WidgetType  `json:"type"`
	MachineIDs    []uuid.UUID `json:"machineIds"`
	ShowProgress  bool        `json:"showProgress"`
	ShowRemaining bool        `json:"showRemaining"`
	styled
}

// listW is the open days and events widget. Title nil keeps the previous heading, an empty
// title shows none.
type listW struct {
	Type          WidgetType `json:"type"`
	Count         int        `json:"count"`
	Title         *string    `json:"title,omitempty"`
	EmptyText     string     `json:"emptyText,omitempty"`
	EntryTemplate string     `json:"entryTemplate,omitempty"`
	// ShowCompetencies adds the planned competencies to each open day; absent keeps the previous look. Open days only.
	ShowCompetencies bool `json:"showCompetencies,omitempty"`
	richFields
	styled
}

// agendaW merges open days and events by start time.
type agendaW struct {
	Type            WidgetType `json:"type"`
	Count           int        `json:"count"`
	IncludeOpenDays bool       `json:"includeOpenDays"`
	IncludeEvents   bool       `json:"includeEvents"`
	Title           *string    `json:"title,omitempty"`
	EmptyText       string     `json:"emptyText,omitempty"`
	OpenDayTemplate string     `json:"openDayTemplate,omitempty"`
	EventTemplate   string     `json:"eventTemplate,omitempty"`
	// ShowCompetencies adds the planned competencies to open-day entries; absent keeps the previous look.
	ShowCompetencies bool `json:"showCompetencies,omitempty"`
	richFields
	styled
}

type calendarColors struct {
	Holiday string `json:"holiday"`
	Break   string `json:"break"`
	OpenDay string `json:"openDay"`
	Event   string `json:"event"`
}

type calendarW struct {
	Type            WidgetType     `json:"type"`
	View            string         `json:"view"`
	Weeks           int            `json:"weeks"`
	ShowHolidays    bool           `json:"showHolidays"`
	ShowBreaks      bool           `json:"showBreaks"`
	ShowOpenDays    bool           `json:"showOpenDays"`
	ShowEvents      bool           `json:"showEvents"`
	Colors          calendarColors `json:"colors"`
	ShowWeekNumbers bool           `json:"showWeekNumbers"`
	Title           *string        `json:"title,omitempty"`
	// ShowCompetencies adds the planned competencies to open days in the weeks view; absent keeps the previous look.
	ShowCompetencies bool `json:"showCompetencies,omitempty"`
	styled
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
	// BoxStyle is the zone box style. It is not called style like on the other widgets because
	// `style` already selects the announcement presentation.
	BoxStyle *WidgetStyle `json:"boxStyle,omitempty"`
}

func (w announcementW) styleOf() *WidgetStyle { return w.BoxStyle }

// WidgetStyle is the optional style of a widget's zone box. Absent means the previous look; inside
// the object every field is required (colours and the font asset may be null).
type WidgetStyle struct {
	TextColor         *string    `json:"textColor"`
	BackgroundColor   *string    `json:"backgroundColor"`
	BorderColor       *string    `json:"borderColor"`
	BackgroundOpacity int        `json:"backgroundOpacity"`
	Padding           int        `json:"padding"`
	Radius            int        `json:"radius"`
	BorderWidth       int        `json:"borderWidth"`
	FontScale         int        `json:"fontScale"`
	FontFamily        string     `json:"fontFamily"`
	FontAssetID       *uuid.UUID `json:"fontAssetId"`
	Align             string     `json:"align"`
	VerticalAlign     string     `json:"verticalAlign"`
}

var (
	styleKeys = []string{
		"textColor", "backgroundColor", "borderColor", "backgroundOpacity", "padding", "radius", "borderWidth",
		"fontScale", "fontFamily", "fontAssetId", "align", "verticalAlign",
	}
	styleNullableKeys = []string{"textColor", "backgroundColor", "borderColor", "fontAssetId"}
	styleFontFamilies = []string{"inherit", "sans", "serif", "mono", "custom"}
	styleAlignments   = []string{"inherit", "start", "center", "end"}
)

// UnmarshalJSON enforces what a plain struct decode cannot: no unknown fields and no missing ones.
func (s *WidgetStyle) UnmarshalJSON(data []byte) error {
	var generic map[string]json.RawMessage
	if err := json.Unmarshal(data, &generic); err != nil || generic == nil {
		return fmt.Errorf("style: must be an object")
	}
	for _, key := range styleKeys {
		raw, ok := generic[key]
		if !ok || (string(raw) == "null" && !contains(styleNullableKeys, key)) {
			return fmt.Errorf("style: %s is required", key)
		}
	}
	type plain WidgetStyle
	var decoded plain
	if err := strictDecode(data, &decoded); err != nil {
		if strings.HasPrefix(err.Error(), "json: unknown field") {
			return fmt.Errorf("style: %s", strings.TrimPrefix(err.Error(), "json: "))
		}
		return fmt.Errorf("style: malformed fields")
	}
	*s = WidgetStyle(decoded)
	return nil
}

// styled adds the optional style to a widget; nil keeps the previous look and is not serialised.
type styled struct {
	Style *WidgetStyle `json:"style,omitempty"`
}

func (s styled) styleOf() *WidgetStyle { return s.Style }

func validateStyle(zone string, style *WidgetStyle, refs *WidgetRefs) error {
	for _, color := range []*string{style.TextColor, style.BackgroundColor, style.BorderColor} {
		if color != nil && !colorPattern.MatchString(*color) {
			return zoneError(zone, "style colours must be lowercase #rrggbb or null")
		}
	}
	if style.BackgroundOpacity < 0 || style.BackgroundOpacity > 100 || style.Padding < 0 || style.Padding > 10 ||
		style.Radius < 0 || style.Radius > 10 || style.BorderWidth < 0 || style.BorderWidth > 20 ||
		style.FontScale < 25 || style.FontScale > 400 {
		return zoneError(zone, "style backgroundOpacity, padding, radius, borderWidth or fontScale is out of range")
	}
	if !contains(styleFontFamilies, style.FontFamily) {
		return zoneError(zone, "style fontFamily is invalid")
	}
	if !contains(styleAlignments, style.Align) || !contains(styleAlignments, style.VerticalAlign) {
		return zoneError(zone, "style align or verticalAlign is invalid")
	}
	if (style.FontFamily == "custom") != (style.FontAssetID != nil) {
		return zoneError(zone, "style fontAssetId is required exactly when fontFamily is custom")
	}
	if style.FontAssetID != nil {
		refs.FontAssets = append(refs.FontAssets, *style.FontAssetID)
	}
	return nil
}

// richFields are the rich text fields of text, list and agenda widgets. An absent format is plain.
type richFields struct {
	Format       RichTextFormat `json:"format,omitempty"`
	CSS          string         `json:"css,omitempty"`
	FontAssetIDs []uuid.UUID    `json:"fontAssetIds,omitempty"`
}

func validFormat(format RichTextFormat) bool {
	return inSet(format, "", FormatPlain, FormatMarkdown, FormatHTML)
}

// validate checks the rich text fields and drops duplicate or empty font lists from the canonical form.
func (r *richFields) validate(zone string, refs *WidgetRefs) error {
	if !validFormat(r.Format) {
		return zoneError(zone, "format must be plain, markdown or html")
	}
	if !multilineText(r.CSS, maxRichCSSRunes) {
		return zoneError(zone, "css must be text of at most %d characters", maxRichCSSRunes)
	}
	if len(r.FontAssetIDs) > maxWidgetFonts {
		return zoneError(zone, "a widget lists at most %d fonts", maxWidgetFonts)
	}
	r.FontAssetIDs = distinct(r.FontAssetIDs)
	if len(r.FontAssetIDs) == 0 {
		r.FontAssetIDs = nil
	}
	refs.FontAssets = append(refs.FontAssets, r.FontAssetIDs...)
	return nil
}

// multilineText accepts text for rich text fields: valid UTF-8, at most max runes and no control
// characters except newlines, carriage returns and tabs. Markup is not rejected; the browser sanitises it.
func multilineText(value string, max int) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > max {
		return false
	}
	for _, r := range value {
		if r == '\n' || r == '\r' || r == '\t' {
			continue
		}
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func validHeading(title *string) bool {
	return title == nil || plainText(*title, maxListTitleRunes, false)
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
		if !multilineText(w.Text, maxTextWidgetRunes) {
			return nil, refs, zoneError(zone, "text must be text of at most %d characters", maxTextWidgetRunes)
		}
		if !inSet(w.Size, TextSizeS, TextSizeM, TextSizeL, TextSizeXL) || !inSet(w.Align, TextAlignStart, TextAlignCenter, TextAlignEnd) {
			return nil, refs, zoneError(zone, "text size or alignment is invalid")
		}
		if err := w.validate(zone, &refs); err != nil {
			return nil, refs, err
		}
		value = &w
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
		var w listW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if w.Count < 1 || w.Count > maxListEntries {
			return nil, refs, zoneError(zone, "count must be between 1 and %d", maxListEntries)
		}
		if w.Type == WidgetEvents && w.ShowCompetencies {
			return nil, refs, zoneError(zone, "only open-day widgets show competencies")
		}
		if !validHeading(w.Title) || !multilineText(w.EmptyText, maxListEmptyRunes) ||
			!multilineText(w.EntryTemplate, maxEntryTemplateRun) {
			return nil, refs, zoneError(zone, "title, emptyText or entryTemplate is too long or not text")
		}
		if err := w.validate(zone, &refs); err != nil {
			return nil, refs, err
		}
		value = &w
	case WidgetAgenda:
		var w agendaW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if w.Count < 1 || w.Count > maxListEntries {
			return nil, refs, zoneError(zone, "count must be between 1 and %d", maxListEntries)
		}
		if !validHeading(w.Title) || !multilineText(w.EmptyText, maxListEmptyRunes) ||
			!multilineText(w.OpenDayTemplate, maxEntryTemplateRun) || !multilineText(w.EventTemplate, maxEntryTemplateRun) {
			return nil, refs, zoneError(zone, "title, emptyText or a template is too long or not text")
		}
		if err := w.validate(zone, &refs); err != nil {
			return nil, refs, err
		}
		value = &w
	case WidgetCalendar:
		var w calendarW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !inSet(w.View, "month", "weeks") || w.Weeks < 1 || w.Weeks > maxCalendarWeeks {
			return nil, refs, zoneError(zone, "calendar view must be month or weeks and weeks between 1 and %d", maxCalendarWeeks)
		}
		for _, color := range []string{w.Colors.Holiday, w.Colors.Break, w.Colors.OpenDay, w.Colors.Event} {
			if !colorPattern.MatchString(color) {
				return nil, refs, zoneError(zone, "calendar colours must be lowercase #rrggbb")
			}
		}
		if !validHeading(w.Title) {
			return nil, refs, zoneError(zone, "calendar title is limited to %d characters of single-line text", maxListTitleRunes)
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
	if holder, ok := value.(interface{ styleOf() *WidgetStyle }); ok && holder.styleOf() != nil {
		if err := validateStyle(zone, holder.styleOf(), &refs); err != nil {
			return nil, refs, err
		}
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
	if strings.HasPrefix(message, "style: ") {
		return message
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
	refs.FontAssets = distinct(refs.FontAssets)
	refs.Machines, refs.Templates = distinct(refs.Machines), distinct(refs.Templates)
	return result, refs, nil
}

func marshalZones(zones map[string]RawWidget) ([]byte, error) {
	return json.Marshal(zones)
}
