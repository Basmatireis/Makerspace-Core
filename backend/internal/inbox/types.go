package inbox

import (
	"time"

	"github.com/google/uuid"
)

// Kind says what produced a notification. The database restricts the column to the same list.
type Kind string

const (
	KindMessage                       Kind = "message"
	KindLabRulesConfirmationRequested Kind = "lab_rules_confirmation_requested"
	KindOpenDayPeriodOpen             Kind = "open_day_period_open"
	KindOpenDayPlaceFreed             Kind = "open_day_place_freed"
	KindRunFinished                   Kind = "run_finished"
	KindPrinterError                  Kind = "printer_error"
	KindFilamentChange                Kind = "filament_change"
)

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

// Notification is one account's copy of a notification.
type Notification struct {
	ID        uuid.UUID
	Kind      Kind
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
