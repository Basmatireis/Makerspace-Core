package signage

// Orientation is how a screen or scene is turned.
type Orientation string

const (
	OrientationPortrait  Orientation = "portrait"
	OrientationLandscape Orientation = "landscape"
)

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

// TargetKind is what a display rule shows.
type TargetKind string

const (
	TargetKindScene    TargetKind = "scene"
	TargetKindPlaylist TargetKind = "playlist"
)

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

// Transition is how a playlist item changes to the next.
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
)

// CameraSource is how a camera widget picks its machine.
type CameraSource string

const (
	CameraSourceMachine CameraSource = "machine"
	CameraSourceAuto    CameraSource = "auto"
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
	ReferenceScene          ReferenceKind = "scene"
	ReferencePlaylist       ReferenceKind = "playlist"
	ReferenceAnnouncement   ReferenceKind = "announcement"
	ReferenceDisplayDefault ReferenceKind = "display_default"
	ReferenceDisplayRule    ReferenceKind = "display_rule"
)

// ChangeTarget is the kind of draft entity a pending change names.
type ChangeTarget string

const (
	ChangeTargetDisplay  ChangeTarget = "display"
	ChangeTargetRule     ChangeTarget = "rule"
	ChangeTargetScene    ChangeTarget = "scene"
	ChangeTargetPlaylist ChangeTarget = "playlist"
	ChangeTargetAsset    ChangeTarget = "asset"
	ChangeTargetLayout   ChangeTarget = "layout"
)

// ChangeKind is how a draft differs from the published state.
type ChangeKind string

const (
	ChangeAdded    ChangeKind = "added"
	ChangeModified ChangeKind = "modified"
	ChangeRemoved  ChangeKind = "removed"
)
