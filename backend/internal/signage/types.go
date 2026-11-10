package signage

import "strconv"

// MaxAspectPart is the largest width or height of a reduced aspect ratio.
const MaxAspectPart = 100

// AspectRatio is the width:height ratio of a display or scene. It is stored and returned reduced.
type AspectRatio struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Reduce divides both parts by their greatest common divisor. A ratio with a part below 1 is returned
// unchanged.
func (r AspectRatio) Reduce() AspectRatio {
	if r.Width < 1 || r.Height < 1 {
		return r
	}
	a, b := r.Width, r.Height
	for b != 0 {
		a, b = b, a%b
	}
	return AspectRatio{Width: r.Width / a, Height: r.Height / a}
}

// Valid reports whether both parts are between 1 and MaxAspectPart.
func (r AspectRatio) Valid() bool {
	return r.Width >= 1 && r.Width <= MaxAspectPart && r.Height >= 1 && r.Height <= MaxAspectPart
}

// String formats the ratio as width:height.
func (r AspectRatio) String() string {
	return strconv.Itoa(r.Width) + ":" + strconv.Itoa(r.Height)
}

// aspectRatioOf converts stored columns.
func aspectRatioOf(width, height int16) AspectRatio {
	return AspectRatio{Width: int(width), Height: int(height)}
}

// checkAspectRatio reduces a requested ratio and rejects one that is not 1–100 in both parts afterwards.
func checkAspectRatio(ratio AspectRatio) (AspectRatio, error) {
	if ratio.Width < 1 || ratio.Height < 1 {
		return ratio, validation("aspectRatio width and height must be at least 1")
	}
	reduced := ratio.Reduce()
	if !reduced.Valid() {
		return ratio, validation(
			"aspectRatio %s reduces to %s; width and height must be at most %d after reduction",
			ratio, reduced, MaxAspectPart,
		)
	}
	return reduced, nil
}

// MediaFit is how media fills its box.
type MediaFit string

const (
	MediaFitCover   MediaFit = "cover"
	MediaFitContain MediaFit = "contain"
)

// Theme is a scene's colour theme.
type Theme string

const (
	ThemeDark  Theme = "dark"
	ThemeLight Theme = "light"
)

// SceneFontFamily is the font a scene's text uses; widgets whose font family is "inherit" take it.
type SceneFontFamily string

const (
	SceneFontSans   SceneFontFamily = "sans"
	SceneFontSerif  SceneFontFamily = "serif"
	SceneFontMono   SceneFontFamily = "mono"
	SceneFontCustom SceneFontFamily = "custom"
)

// AssetKind is the media type of an uploaded asset.
type AssetKind string

const (
	AssetKindImage AssetKind = "image"
	AssetKindVideo AssetKind = "video"
	AssetKindFont  AssetKind = "font"
)

// RichTextFormat is how a text, list or announcement body is interpreted by the browser. The
// backend only validates it (and escapes announcement placeholder values for it); it never
// renders markdown or HTML.
type RichTextFormat string

const (
	FormatPlain    RichTextFormat = "plain"
	FormatMarkdown RichTextFormat = "markdown"
	FormatHTML     RichTextFormat = "html"
)

// CustomLayoutMode is how the zones of a custom layout are positioned.
type CustomLayoutMode string

const (
	LayoutModeGrid CustomLayoutMode = "grid"
	LayoutModeFree CustomLayoutMode = "free"
)

// CustomLayoutID is the scene layout id that selects a custom layout.
const CustomLayoutID = "custom"

// MultiMode is how several matches share a screen or camera widget.
type MultiMode string

const (
	MultiModeSplit     MultiMode = "split"
	MultiModeAlternate MultiMode = "alternate"
)

// ConditionKind is what makes a display rule apply.
type ConditionKind string

const (
	ConditionTimeWindow          ConditionKind = "time_window"
	ConditionMachinePrinting     ConditionKind = "machine_printing"
	ConditionAnnouncementActive  ConditionKind = "announcement_active"
	ConditionLiveDataUnavailable ConditionKind = "live_data_unavailable"
)

// MachineMatch is how many of the listed machines must be printing.
type MachineMatch string

const (
	MachineMatchAny MachineMatch = "any"
	MachineMatchAll MachineMatch = "all"
)

// Transition is how a scene list item changes to the next.
type Transition string

const (
	TransitionCut  Transition = "cut"
	TransitionFade Transition = "fade"
)

// FieldType is the input type of an announcement template field.
type FieldType string

const (
	FieldText     FieldType = "text"
	FieldLongText FieldType = "longtext"
	FieldTime     FieldType = "time"
	FieldDate     FieldType = "date"
	FieldDateTime FieldType = "datetime"
	FieldNumber   FieldType = "number"
	FieldChoice   FieldType = "choice"
	FieldMachine  FieldType = "machine"
)

// Tone is the severity of an announcement.
type Tone string

const (
	ToneInfo     Tone = "info"
	ToneWarning  Tone = "warning"
	ToneCritical Tone = "critical"
	ToneNeutral  Tone = "neutral"
)

// WidgetType is the kind of widget in a scene zone.
type WidgetType string

const (
	WidgetEmpty        WidgetType = "empty"
	WidgetImage        WidgetType = "image"
	WidgetVideo        WidgetType = "video"
	WidgetSlideshow    WidgetType = "slideshow"
	WidgetText         WidgetType = "text"
	WidgetQR           WidgetType = "qr"
	WidgetClock        WidgetType = "clock"
	WidgetCamera       WidgetType = "camera"
	WidgetStatus       WidgetType = "status"
	WidgetOpenDays     WidgetType = "open_days"
	WidgetEvents       WidgetType = "events"
	WidgetAnnouncement WidgetType = "announcement"
	WidgetAgenda       WidgetType = "agenda"
	WidgetCalendar     WidgetType = "calendar"
	WidgetTimelapse    WidgetType = "timelapse"
)

// TextSize is the type size of a text or announcement widget.
type TextSize string

const (
	TextSizeS  TextSize = "s"
	TextSizeM  TextSize = "m"
	TextSizeL  TextSize = "l"
	TextSizeXL TextSize = "xl"
)

// TextAlign is the alignment of a text widget.
type TextAlign string

const (
	TextAlignStart  TextAlign = "start"
	TextAlignCenter TextAlign = "center"
	TextAlignEnd    TextAlign = "end"
)

// ClockMode is what a clock widget shows.
type ClockMode string

const (
	ClockTime     ClockMode = "time"
	ClockDateTime ClockMode = "datetime"
	ClockDate     ClockMode = "date"
)

// CameraSource is how a camera widget picks its machine.
type CameraSource string

const (
	CameraSourceMachine CameraSource = "machine"
	CameraSourceAuto    CameraSource = "auto"
)

// TimelapseSource is which machines a timelapse widget shows clips of.
type TimelapseSource string

const (
	TimelapseSourceAll      TimelapseSource = "all"
	TimelapseSourceMachines TimelapseSource = "machines"
)

// CameraFallback is what a camera widget shows without a picture.
type CameraFallback string

const (
	CameraFallbackImage CameraFallback = "image"
	CameraFallbackText  CameraFallback = "text"
	CameraFallbackHide  CameraFallback = "hide"
)

// AnnouncementStyle is how an announcement widget looks.
type AnnouncementStyle string

const (
	AnnouncementStyleBanner AnnouncementStyle = "banner"
	AnnouncementStyleCard   AnnouncementStyle = "card"
	AnnouncementStyleFull   AnnouncementStyle = "full"
)

// WhenNone is what an announcement widget shows without announcements.
type WhenNone string

const (
	WhenNoneEmpty WhenNone = "empty"
	WhenNoneText  WhenNone = "text"
)

// WhenMany is how an announcement widget handles several announcements.
type WhenMany string

const (
	WhenManyRotate WhenMany = "rotate"
	WhenManyNewest WhenMany = "newest"
	WhenManyStack  WhenMany = "stack"
)

// DisplayKind tells a screen with a managed device from a web embed, which other websites show in an iframe.
type DisplayKind string

const (
	DisplayKindDevice   DisplayKind = "device"
	DisplayKindWebEmbed DisplayKind = "web_embed"
)

// DisplayStatus is whether a display is reachable.
type DisplayStatus string

const (
	DisplayOnline  DisplayStatus = "online"
	DisplayOffline DisplayStatus = "offline"
	DisplayRevoked DisplayStatus = "revoked"
)

// PairingStatus is where a display pairing request stands.
type PairingStatus string

const (
	PairingPending PairingStatus = "pending"
	PairingExpired PairingStatus = "expired"
	PairingPaired  PairingStatus = "paired"
)

// AnnouncementState is whether an announcement is showing yet.
type AnnouncementState string

const (
	AnnouncementScheduled AnnouncementState = "scheduled"
	AnnouncementActive    AnnouncementState = "active"
)

// LiveState is what a machine is doing, as far as a screen may show.
type LiveState string

const (
	LiveStateUnknown   LiveState = "unknown"
	LiveStateIdle      LiveState = "idle"
	LiveStatePreparing LiveState = "preparing"
	LiveStatePrinting  LiveState = "printing"
	LiveStatePaused    LiveState = "paused"
	LiveStateFinished  LiveState = "finished"
	LiveStateFailed    LiveState = "failed"
)

// ReferenceKind is the kind of entity that blocks a deletion.
type ReferenceKind string

const (
	ReferenceScene        ReferenceKind = "scene"
	ReferenceAnnouncement ReferenceKind = "announcement"
	// ReferenceRule is a rule of a display; the reference id is the display's.
	ReferenceRule ReferenceKind = "rule"
	// ReferenceDisplay is a display's default scene list; the reference id is the display's.
	ReferenceDisplay ReferenceKind = "display"
	// ReferenceGroup is a display group: one of its rules, its default scene list or a member display; the
	// reference id is the group's (for a member, the display's under kind display).
	ReferenceGroup ReferenceKind = "group"
)

// ChangeTarget is the kind of draft entity a pending change names.
type ChangeTarget string

const (
	ChangeTargetDisplay ChangeTarget = "display"
	ChangeTargetRule    ChangeTarget = "rule"
	ChangeTargetScene   ChangeTarget = "scene"
	ChangeTargetAsset   ChangeTarget = "asset"
	ChangeTargetLayout  ChangeTarget = "layout"
)

// ChangeKind is how a draft differs from the published state.
type ChangeKind string

const (
	ChangeAdded    ChangeKind = "added"
	ChangeModified ChangeKind = "modified"
	ChangeRemoved  ChangeKind = "removed"
)
