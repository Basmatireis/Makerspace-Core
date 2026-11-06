package inbox

import (
	"time"

	"github.com/google/uuid"
)

// Kind says what produced a notification. The database restricts the column to the same list.
type Kind string

const (
	KindMessage           Kind = "message"
	KindLabRulesPublished Kind = "lab_rules_published"
	KindOpenDayPeriodOpen Kind = "open_day_period_open"
	KindOpenDayPlaceFreed Kind = "open_day_place_freed"
	// The open-day change kinds tell a person that something about their own staffing changed.
	KindOpenDayTimeslotChanged   Kind = "open_day_timeslot_changed"
	KindOpenDayTimeslotRemoved   Kind = "open_day_timeslot_removed"
	KindOpenDayCancelled         Kind = "open_day_cancelled"
	KindOpenDayAssignedByOther   Kind = "open_day_assigned_by_other"
	KindOpenDayUnassignedByOther Kind = "open_day_unassigned_by_other"
	KindRunFinished              Kind = "run_finished"
	KindPrinterError             Kind = "printer_error"
	KindFilamentChange           Kind = "filament_change"
	// KindRule marks the notifications the notification rules write.
	KindRule Kind = "rule"
)

// LabRulesConfirmLink is the page that shows the current Lab Rules and asks for the confirmation; Lab Rules
// notifications and their e-mails link to it.
const LabRulesConfirmLink = "/lab-rules/confirm"

const (
	// Retention is how long a notification is kept; expired ones are hard-deleted.
	Retention = 90 * 24 * time.Hour
	// MaxTitleLength and MaxBodyLength are in characters; MaxLinkLength in bytes.
	MaxTitleLength = 120
	MaxBodyLength  = 2000
	MaxLinkLength  = 500
	// MaxMessageRoles bounds the roles of one manual message.
	MaxMessageRoles = 100

	defaultPageSize = 25
	maxPageSize     = 100
)

// Level is the severity a notification is styled with.
type Level string

// Appearance is how a notification shows up on screen.
type Appearance string

const (
	AppearanceBell   Appearance = "bell"
	AppearanceToast  Appearance = "toast"
	AppearanceBanner Appearance = "banner"
	AppearanceDialog Appearance = "dialog"
)

const (
	// PostponeFor is how long "Remind me later" hides a banner or dialog.
	PostponeFor = time.Hour
	// OnlineWindow is how recently an account must have polled with a visible tab to count as online.
	OnlineWindow = 2 * time.Minute
	// toastFreshness is how old a toast may be and still pop up; older ones only wait in the bell list.
	toastFreshness = time.Hour
	maxFresh       = 20
	maxPinned      = 10
)

// Notification is one account's copy of a notification.
type Notification struct {
	ID        uuid.UUID
	Kind      Kind
	Level     Level
	Title     string
	Body      string
	Link      *string
	CreatedAt time.Time
	ReadAt    *time.Time
}

// Page is one page of an account's notifications.
type Page struct {
	Items       []Notification
	Page        int
	PageSize    int
	Total       int64
	UnreadCount int64
}

// MessageInput is a manual message to the holders of roles.
type MessageInput struct {
	Title   string
	Body    string
	Link    *string
	RoleIDs []uuid.UUID
}

// MessageUpdate is the new content of a sent message; its recipients and roles stay.
type MessageUpdate struct {
	Title string
	Body  string
	Link  *string
}

// MessageRole names a role a message was sent to.
type MessageRole struct {
	ID   uuid.UUID
	Name string
}

// SentMessage is a manual message as the sender sees it. The counts only cover recipients who have
// not dismissed the message.
type SentMessage struct {
	ID             uuid.UUID
	Title          string
	Body           string
	Link           *string
	Roles          []MessageRole
	SenderName     *string
	RecipientCount int64
	ReadCount      int64
	CreatedAt      time.Time
	ExpiresAt      time.Time
}

// SentPage is one page of sent messages.
type SentPage struct {
	Items    []SentMessage
	Page     int
	PageSize int
	Total    int64
}

// AlertButton is the button of a notification that shows itself on screen.
type AlertButton struct {
	Kind  string
	Label *string
	Link  *string
}

// Alert is a notification that shows itself on screen as a toast, a banner or a dialog.
type Alert struct {
	ID               uuid.UUID
	Appearance       Appearance
	Level            Level
	Title            string
	Body             string
	Link             *string
	Button           AlertButton
	ToastSeconds     *int
	OnlyButtonCloses bool
	AllowLater       bool
	CreatedAt        time.Time
}

// Poll is the answer to the periodic poll of the signed-in account's screen.
type Poll struct {
	UnreadCount int64
	// Fresh are the notifications that were not shown to the account yet.
	Fresh []Alert
	// Pinned are the banners and dialogs that stay until the account closes, acknowledges or postpones them.
	Pinned []Alert
}
