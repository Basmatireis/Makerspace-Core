package signage

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// RawWidget is the canonical JSON of one block's widget as stored in signage_scenes.blocks.
type RawWidget = json.RawMessage

const (
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
	maxTimelapseCount   = 20
	maxTimelapseAgeDays = 365
	minTimelapseSeconds = 5
	maxTimelapseSeconds = 600
	maxImageDim         = 90
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
}

// imageW darkens the picture by Dim percent.
type imageW struct {
	Type    WidgetType `json:"type"`
	MediaID *uuid.UUID `json:"mediaId"`
	Fit     MediaFit   `json:"fit"`
	Dim     int        `json:"dim"`
}
type videoW struct {
	Type    WidgetType `json:"type"`
	MediaID *uuid.UUID `json:"mediaId"`
	Fit     MediaFit   `json:"fit"`
}
type slideshowW struct {
	Type     WidgetType  `json:"type"`
	MediaIDs []uuid.UUID `json:"mediaIds"`
	Seconds  int         `json:"seconds"`
}

// textW takes its size and alignment from the block style; Fit shrinks the text until it fits the block.
type textW struct {
	Type WidgetType `json:"type"`
	Text string     `json:"text"`
	richFields
	Fit bool `json:"fit"`
}
type qrW struct {
	Type    WidgetType `json:"type"`
	URL     string     `json:"url"`
	Caption string     `json:"caption"`
	// DarkColor and LightColor replace the black modules and the white quiet zone; absent keeps them.
	DarkColor  string `json:"darkColor,omitempty"`
	LightColor string `json:"lightColor,omitempty"`
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
	ShowLive        bool           `json:"showLive"`
	ShowName        bool           `json:"showName"`
	// LiveColor (the live dot) and ProgressColor (the progress bar) are optional; absent keeps the defaults.
	LiveColor     string `json:"liveColor,omitempty"`
	ProgressColor string `json:"progressColor,omitempty"`
}
type statusW struct {
	Type          WidgetType  `json:"type"`
	MachineIDs    []uuid.UUID `json:"machineIds"`
	ShowProgress  bool        `json:"showProgress"`
	ShowRemaining bool        `json:"showRemaining"`
	// State badge and progress bar colours; absent keeps the defaults.
	BusyColor     string `json:"busyColor,omitempty"`
	IdleColor     string `json:"idleColor,omitempty"`
	UnknownColor  string `json:"unknownColor,omitempty"`
	ProgressColor string `json:"progressColor,omitempty"`
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
	listColors
	richFields
}

// listColors colour the date column and the competencies of the list widgets; absent keeps the text colour.
type listColors struct {
	AccentColor     string `json:"accentColor,omitempty"`
	CompetencyColor string `json:"competencyColor,omitempty"`
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
	listColors
	richFields
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
	// ShowCompetencies adds the planned competencies to open days; absent keeps the previous look.
	ShowCompetencies bool `json:"showCompetencies,omitempty"`
	// HideLegend leaves out the colour legend; absent shows it as before.
	HideLegend bool `json:"hideLegend,omitempty"`
}

// timelapseW is the slideshow of recent finished prints' timelapse videos.
type timelapseW struct {
	Type        WidgetType      `json:"type"`
	Source      TimelapseSource `json:"source"`
	MachineIDs  []uuid.UUID     `json:"machineIds"`
	Count       int             `json:"count"`
	MaxAgeDays  int             `json:"maxAgeDays"`
	MaxSeconds  int             `json:"maxSeconds"`
	Transition  Transition      `json:"transition"`
	ShowCaption bool            `json:"showCaption"`
	Fit         MediaFit        `json:"fit"`
	// CaptionColor is the caption's text colour; absent keeps white.
	CaptionColor string `json:"captionColor,omitempty"`
}

// announcementW takes its title size from the block style's text size.
type announcementW struct {
	Type          WidgetType        `json:"type"`
	TemplateIDs   []uuid.UUID       `json:"templateIds"`
	Style         AnnouncementStyle `json:"style"`
	WhenNone      WhenNone          `json:"whenNone"`
	FallbackText  string            `json:"fallbackText"`
	WhenMany      WhenMany          `json:"whenMany"`
	RotateSeconds int               `json:"rotateSeconds"`
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
func (r *richFields) validate(block string, refs *WidgetRefs) error {
	if !validFormat(r.Format) {
		return blockError(block, "format must be plain, markdown or html")
	}
	if !multilineText(r.CSS, maxRichCSSRunes) {
		return blockError(block, "css must be text of at most %d characters", maxRichCSSRunes)
	}
	if len(r.FontAssetIDs) > maxWidgetFonts {
		return blockError(block, "a widget lists at most %d fonts", maxWidgetFonts)
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

func blockError(block, format string, args ...any) error {
	return apperror.New(
		http.StatusUnprocessableEntity,
		"validation_failed",
		fmt.Sprintf("block %q: %s", block, fmt.Sprintf(format, args...)),
	)
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

// ValidateWidget strictly decodes the widget of one block and returns its canonical JSON and references.
func ValidateWidget(block string, raw json.RawMessage) (RawWidget, WidgetRefs, error) {
	var head widgetType
	var generic map[string]json.RawMessage
	if err := json.Unmarshal(raw, &generic); err != nil || generic == nil {
		return nil, WidgetRefs{}, blockError(block, "widget must be an object")
	}
	if err := json.Unmarshal(generic["type"], &head.Type); err != nil {
		return nil, WidgetRefs{}, blockError(block, "widget type is required")
	}
	var refs WidgetRefs
	var value any
	decode := func(target any) error {
		if err := strictDecode(raw, target); err != nil {
			return blockError(block, "invalid %s widget: %s", head.Type, decodeMessage(err))
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
	case WidgetImage:
		var w imageW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !inSet(w.Fit, MediaFitContain, MediaFitCover) || w.Dim < 0 || w.Dim > maxImageDim {
			return nil, refs, blockError(block, "fit must be contain or cover and dim between 0 and %d", maxImageDim)
		}
		if w.MediaID != nil {
			refs.ImageAssets = append(refs.ImageAssets, *w.MediaID)
		}
	case WidgetVideo:
		var w videoW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !inSet(w.Fit, MediaFitContain, MediaFitCover) {
			return nil, refs, blockError(block, "fit must be contain or cover")
		}
		if w.MediaID != nil {
			refs.VideoAssets = append(refs.VideoAssets, *w.MediaID)
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
			return nil, refs, blockError(block, "a slideshow holds at most %d images", maxSlideshowAssets)
		}
		if w.Seconds < 3 || w.Seconds > 3600 {
			return nil, refs, blockError(block, "slideshow seconds must be between 3 and 3600")
		}
		refs.ImageAssets = append(refs.ImageAssets, w.MediaIDs...)
		value = &w
	case WidgetText:
		var w textW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !multilineText(w.Text, maxTextWidgetRunes) {
			return nil, refs, blockError(block, "text must be text of at most %d characters", maxTextWidgetRunes)
		}
		if err := w.validate(block, &refs); err != nil {
			return nil, refs, err
		}
		value = &w
	case WidgetQR:
		var w qrW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if err := validateHTTPSURL(w.URL); err != nil {
			return nil, refs, blockError(block, "%s", err.Error())
		}
		if !plainText(w.Caption, maxCaptionRunes, false) {
			return nil, refs, blockError(
				block,
				"QR caption must be single-line plain text of at most %d characters",
				maxCaptionRunes,
			)
		}
		if !optionalColors(w.DarkColor, w.LightColor) {
			return nil, refs, blockError(block, "QR colours must be lowercase #rrggbb or transparent")
		}
	case WidgetClock:
		var w clockW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !inSet(w.Mode, ClockTime, ClockDateTime, ClockDate) {
			return nil, refs, blockError(block, "clock mode must be time, datetime or date")
		}
	case WidgetCamera:
		var w cameraW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !inSet(w.Source, CameraSourceMachine, CameraSourceAuto) || !inSet(w.Multi, MultiModeSplit, MultiModeAlternate) ||
			!inSet(w.Fallback, CameraFallbackImage, CameraFallbackText, CameraFallbackHide) {
			return nil, refs, blockError(block, "camera source, multi mode or fallback is invalid")
		}
		if !optionalColors(w.LiveColor, w.ProgressColor) {
			return nil, refs, blockError(block, "camera colours must be lowercase #rrggbb or transparent")
		}
		if w.Source == CameraSourceMachine && w.MachineID == nil {
			return nil, refs, blockError(block, "a camera bound to a machine needs machineId")
		}
		if w.MachineIDs == nil {
			w.MachineIDs = []uuid.UUID{}
		}
		if len(w.MachineIDs) > maxStatusMachines {
			return nil, refs, blockError(block, "a camera widget lists at most %d machines", maxStatusMachines)
		}
		if len(distinct(w.MachineIDs)) != len(w.MachineIDs) {
			return nil, refs, blockError(block, "camera machines must be distinct")
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
			return nil, refs, blockError(block, "a status widget lists at most %d machines", maxStatusMachines)
		}
		if !optionalColors(w.BusyColor, w.IdleColor, w.UnknownColor, w.ProgressColor) {
			return nil, refs, blockError(block, "status colours must be lowercase #rrggbb or transparent")
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
			return nil, refs, blockError(block, "count must be between 1 and %d", maxListEntries)
		}
		if w.Type == WidgetEvents && w.ShowCompetencies {
			return nil, refs, blockError(block, "only open-day widgets show competencies")
		}
		if !w.listColors.valid() {
			return nil, refs, blockError(block, "list colours must be lowercase #rrggbb or transparent")
		}
		if !validHeading(w.Title) || !multilineText(w.EmptyText, maxListEmptyRunes) ||
			!multilineText(w.EntryTemplate, maxEntryTemplateRun) {
			return nil, refs, blockError(block, "title, emptyText or entryTemplate is too long or not text")
		}
		if err := w.validate(block, &refs); err != nil {
			return nil, refs, err
		}
		value = &w
	case WidgetAgenda:
		var w agendaW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if w.Count < 1 || w.Count > maxListEntries {
			return nil, refs, blockError(block, "count must be between 1 and %d", maxListEntries)
		}
		if !validHeading(w.Title) || !multilineText(w.EmptyText, maxListEmptyRunes) ||
			!multilineText(w.OpenDayTemplate, maxEntryTemplateRun) || !multilineText(w.EventTemplate, maxEntryTemplateRun) {
			return nil, refs, blockError(block, "title, emptyText or a template is too long or not text")
		}
		if !w.listColors.valid() {
			return nil, refs, blockError(block, "list colours must be lowercase #rrggbb or transparent")
		}
		if err := w.validate(block, &refs); err != nil {
			return nil, refs, err
		}
		value = &w
	case WidgetCalendar:
		var w calendarW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !inSet(w.View, "month", "weeks") || w.Weeks < 1 || w.Weeks > maxCalendarWeeks {
			return nil, refs, blockError(block, "calendar view must be month or weeks and weeks between 1 and %d", maxCalendarWeeks)
		}
		for _, color := range []string{w.Colors.Holiday, w.Colors.Break, w.Colors.OpenDay, w.Colors.Event} {
			if !colorPattern.MatchString(color) {
				return nil, refs, blockError(block, "calendar colours must be lowercase #rrggbb")
			}
		}
		if !validHeading(w.Title) {
			return nil, refs, blockError(block, "calendar title is limited to %d characters of single-line text", maxListTitleRunes)
		}
	case WidgetTimelapse:
		var w timelapseW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if !inSet(w.Source, TimelapseSourceAll, TimelapseSourceMachines) {
			return nil, refs, blockError(block, "timelapse source must be all or machines")
		}
		if w.MachineIDs == nil {
			w.MachineIDs = []uuid.UUID{}
		}
		switch {
		case w.Source == TimelapseSourceAll && len(w.MachineIDs) > 0:
			return nil, refs, blockError(block, "a timelapse widget showing all machines lists no machines")
		case w.Source == TimelapseSourceMachines && len(w.MachineIDs) == 0:
			return nil, refs, blockError(block, "a timelapse widget for chosen machines needs machineIds")
		case len(w.MachineIDs) > maxStatusMachines:
			return nil, refs, blockError(block, "a timelapse widget lists at most %d machines", maxStatusMachines)
		case len(distinct(w.MachineIDs)) != len(w.MachineIDs):
			return nil, refs, blockError(block, "timelapse machines must be distinct")
		}
		if w.Count < 1 || w.Count > maxTimelapseCount {
			return nil, refs, blockError(block, "count must be between 1 and %d", maxTimelapseCount)
		}
		if w.MaxAgeDays < 0 || w.MaxAgeDays > maxTimelapseAgeDays {
			return nil, refs, blockError(block, "maxAgeDays must be between 0 and %d", maxTimelapseAgeDays)
		}
		if w.MaxSeconds < minTimelapseSeconds || w.MaxSeconds > maxTimelapseSeconds {
			return nil, refs, blockError(block, "maxSeconds must be between %d and %d", minTimelapseSeconds, maxTimelapseSeconds)
		}
		if !inSet(w.Transition, TransitionCut, TransitionFade) || !inSet(w.Fit, MediaFitContain, MediaFitCover) {
			return nil, refs, blockError(block, "transition must be cut or fade and fit contain or cover")
		}
		if !optionalColors(w.CaptionColor) {
			return nil, refs, blockError(block, "timelapse caption colour must be lowercase #rrggbb or transparent")
		}
		// Only checked to exist: the clips never add machines to the live machine list.
		refs.Machines = append(refs.Machines, w.MachineIDs...)
		value = &w
	case WidgetAnnouncement:
		var w announcementW
		if err := decode(&w); err != nil {
			return nil, refs, err
		}
		if w.TemplateIDs == nil {
			w.TemplateIDs = []uuid.UUID{}
		}
		if len(w.TemplateIDs) > maxWidgetTemplates {
			return nil, refs, blockError(block, "an announcement widget filters at most %d templates", maxWidgetTemplates)
		}
		w.TemplateIDs = distinct(w.TemplateIDs)
		if !inSet(w.Style, AnnouncementStyleBanner, AnnouncementStyleCard, AnnouncementStyleFull) ||
			!inSet(w.WhenNone, WhenNoneEmpty, WhenNoneText) ||
			!inSet(w.WhenMany, WhenManyRotate, WhenManyNewest, WhenManyStack) {
			return nil, refs, blockError(block, "announcement style, whenNone or whenMany is invalid")
		}
		if !plainText(w.FallbackText, maxFallbackTextRune, true) {
			return nil, refs, blockError(
				block,
				"fallback text must be plain text of at most %d characters",
				maxFallbackTextRune,
			)
		}
		if w.RotateSeconds < 3 || w.RotateSeconds > 300 {
			return nil, refs, blockError(block, "rotateSeconds must be between 3 and 300")
		}
		refs.Templates = append(refs.Templates, w.TemplateIDs...)
		value = &w
	default:
		return nil, refs, blockError(block, "unknown widget type")
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

// optionalColors reports whether every colour is absent, lowercase #rrggbb or "transparent".
func optionalColors(colors ...string) bool {
	for _, color := range colors {
		if color != "" && color != "transparent" && !colorPattern.MatchString(color) {
			return false
		}
	}
	return true
}

func (c listColors) valid() bool { return optionalColors(c.AccentColor, c.CompetencyColor) }
