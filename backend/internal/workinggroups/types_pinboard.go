package workinggroups

import (
	"time"

	"github.com/google/uuid"
)

// Usage is the usability status of a machine or a place, set by the group that looks after it.
type Usage string

const (
	UsageOK          Usage = "ok"
	UsageLimited     Usage = "limited"
	UsageMaintenance Usage = "maintenance"
	UsageOutOfOrder  Usage = "out_of_order"
)

func validUsage(value Usage) bool {
	switch value {
	case UsageOK, UsageLimited, UsageMaintenance, UsageOutOfOrder:
		return true
	}
	return false
}

// ItemState is the current status of a machine or a place. Note and Until are only ever set while Usage is not ok;
// ChangedAt and ChangedBy are empty until somebody set a status (and ChangedBy again when that person was deleted).
type ItemState struct {
	Usage     Usage
	Note      *string
	Until     *time.Time
	ChangedAt *time.Time
	ChangedBy *Person
}

// StatusInput is a new status. Note and Until are ignored for ok.
type StatusInput struct {
	Usage Usage
	Note  *string
	Until *time.Time
}

// StatusItem is a machine or a place with its status and the number of the last 90 days on which it was not ok.
type StatusItem struct {
	Kind            string
	ID              uuid.UUID
	Name            string
	GroupID         uuid.UUID
	GroupName       string
	State           ItemState
	DaysNotOkLast90 int
}

// Note is a pinboard note. GroupID is nil for a makerspace note; Author is nil once the author was deleted.
type Note struct {
	ID        uuid.UUID
	GroupID   *uuid.UUID
	GroupName string
	Public    bool
	Text      string
	CreatedAt time.Time
	Author    *Person
	CanDelete bool
}

// CreateNoteInput pins a note; a nil GroupID makes it a makerspace note.
type CreateNoteInput struct {
	GroupID *uuid.UUID
	Public  bool
	Text    string
}
