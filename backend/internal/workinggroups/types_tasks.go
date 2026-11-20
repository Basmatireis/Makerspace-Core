package workinggroups

import (
	"time"

	"github.com/google/uuid"
)

// TicketKind says what a ticket is about.
type TicketKind string

const (
	KindProblem  TicketKind = "problem"
	KindRequest  TicketKind = "request"
	KindQuestion TicketKind = "question"
)

// TicketStatus is the state of a ticket: new tickets are the group's inbox, planned ones sit in a column.
type TicketStatus string

const (
	StatusNew      TicketStatus = "new"
	StatusPlanned  TicketStatus = "planned"
	StatusDone     TicketStatus = "done"
	StatusDeclined TicketStatus = "declined"
)

// Column is a custom column of a group's board, between the fixed Inbox and Done.
type Column struct {
	ID   uuid.UUID
	Name string
}

// ColumnInput is one entry of the replaced column list: an ID renames and reorders an existing column, no ID
// creates a new one.
type ColumnInput struct {
	ID   *uuid.UUID
	Name string
}

// Ticket is a ticket as listed. Author and Assignee are nil for a deleted person (a former member).
type Ticket struct {
	ID            uuid.UUID
	GroupID       uuid.UUID
	GroupName     string
	MachineID     *uuid.UUID
	MachineName   *string
	Kind          TicketKind
	Subject       string
	Body          string
	BlocksUse     bool
	Status        TicketStatus
	Author        *Person
	Assignee      *Person
	DueOn         *time.Time
	ColumnID      *uuid.UUID
	FollowerCount int64
	IsFollowing   bool
	IsMine        bool
	CommentCount  int64
	// LatestComments are the newest comments the caller may see (at most three, newest first); set by the list only.
	LatestComments []Comment
	Inside         bool
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
	ClosedAt       *time.Time
	// Link is the purchase or project the ticket is linked to; nil without a link and when the caller may not see it.
	Link *TaskLink
}

// Comment is a comment on a ticket or a to-do. Author is nil for a deleted person.
type Comment struct {
	ID        uuid.UUID
	Author    *Person
	Text      string
	Internal  bool
	CreatedAt time.Time
}

// TicketDetail is a ticket with the people who have the same problem and the comments the caller may see.
type TicketDetail struct {
	Ticket    Ticket
	Followers []Person
	Comments  []Comment
}

// TicketFilter narrows the ticket list; zero values mean no filter.
type TicketFilter struct {
	GroupID *uuid.UUID
	Status  *TicketStatus
}

// CreateTicketInput is a new ticket.
type CreateTicketInput struct {
	GroupID   uuid.UUID
	MachineID *uuid.UUID
	Kind      TicketKind
	Subject   string
	Body      string
	BlocksUse bool
}

// PlanTicketInput moves a new ticket into a column of its group.
type PlanTicketInput struct {
	AssigneePersonID *uuid.UUID
	DueOn            *time.Time
	ColumnID         uuid.UUID
}

// OptionalID distinguishes an omitted field (Set false) from an explicit null (Set true, Value nil).
type OptionalID struct {
	Set   bool
	Value *uuid.UUID
}

// OptionalDate distinguishes an omitted field from an explicit null.
type OptionalDate struct {
	Set   bool
	Value *time.Time
}

// OptionalInt distinguishes an omitted field from an explicit null.
type OptionalInt struct {
	Set   bool
	Value *int
}

// UpdateTicketInput changes the fields that are set on a planned ticket.
type UpdateTicketInput struct {
	ExpectedVersion int64
	Assignee        OptionalID
	DueOn           OptionalDate
	ColumnID        *uuid.UUID
}

// CloseTicketInput closes a ticket as done or declined, with an optional answer that becomes a public comment.
type CloseTicketInput struct {
	Outcome TicketStatus
	Answer  string
}

// CommentInput is a new comment.
type CommentInput struct {
	Text     string
	Internal bool
}

// Todo is a task of a group; it is only ever shown to people inside the group.
type Todo struct {
	ID              uuid.UUID
	GroupID         uuid.UUID
	GroupName       string
	Title           string
	Assignee        *Person
	CreatedBy       *Person
	DueOn           time.Time
	ColumnID        uuid.UUID
	RepeatEveryDays *int
	Done            bool
	DoneAt          *time.Time
	IsMine          bool
	CommentCount    int64
	// LatestComments are the newest comments (at most three, newest first); set by the list only.
	LatestComments []Comment
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
	// Link is the purchase or project the to-do is linked to; nil without a link and when the caller may not see it.
	Link *TaskLink
}

// TodoDetail is a to-do with its comments. NextTodoID names the to-do that marking a repeating one as done created.
type TodoDetail struct {
	Todo       Todo
	Comments   []Comment
	NextTodoID *uuid.UUID
}

// CreateTodoInput is a new to-do; without a column it goes to the group's first column.
type CreateTodoInput struct {
	GroupID          uuid.UUID
	Title            string
	AssigneePersonID *uuid.UUID
	DueOn            time.Time
	ColumnID         *uuid.UUID
	RepeatEveryDays  *int
}

// UpdateTodoInput changes the fields that are set.
type UpdateTodoInput struct {
	ExpectedVersion int64
	Title           *string
	Assignee        OptionalID
	DueOn           *time.Time
	ColumnID        *uuid.UUID
	RepeatEveryDays OptionalInt
}
