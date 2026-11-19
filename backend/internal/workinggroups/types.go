package workinggroups

import (
	"time"

	"github.com/google/uuid"
)

// Person is a member or lead as shown to other members: a name, nothing else.
type Person struct {
	ID          uuid.UUID
	DisplayName string
}

// Summary is a working group as listed. IsMember and IsLead describe the caller.
type Summary struct {
	ID           uuid.UUID
	Name         string
	Description  string
	Lead         *Person
	MemberCount  int64
	MachineCount int64
	IsMember     bool
	IsLead       bool
	// OpenTicketCount counts the new and planned tickets. OpenTodoCount counts the to-dos not done and is only set
	// for people inside the group.
	OpenTicketCount int64
	OpenTodoCount   *int64
}

// Member is one member of a group.
type Member struct {
	PersonID    uuid.UUID
	DisplayName string
	IsLead      bool
	JoinedAt    time.Time
}

// Machine is a machine a group looks after.
type Machine struct {
	ID   uuid.UUID
	Name string
	ItemState
}

// Place is a free-text place a group looks after.
type Place struct {
	ID   uuid.UUID
	Name string
	ItemState
}

// Group is a working group with everything the caller may see. ChatURL is only filled for members of the group and
// holders of working_groups.manage.
type Group struct {
	Summary
	Version   int64
	ChatURL   *string
	Members   []Member
	Machines  []Machine
	Places    []Place
	Columns   []Column
	CanEdit   bool
	CanManage bool
}

// PersonOption is a candidate for the member and lead pickers: id and name only.
type PersonOption struct {
	ID          uuid.UUID
	DisplayName string
}

// MachineOption is a machine that can be assigned; GroupID and GroupName name the group it already belongs to.
type MachineOption struct {
	ID        uuid.UUID
	Name      string
	GroupID   *uuid.UUID
	GroupName *string
}

// CreateInput creates a group; the lead becomes its first member.
type CreateInput struct {
	Name         string
	Description  string
	LeadPersonID uuid.UUID
}

// OptionalText distinguishes an omitted field (Set false) from an explicit null (Set true, Value nil).
type OptionalText struct {
	Set   bool
	Value *string
}

// UpdateInput changes the fields that are set. ExpectedVersion is the version the caller saw.
type UpdateInput struct {
	ExpectedVersion int64
	Name            *string
	Description     *string
	ChatURL         OptionalText
}
