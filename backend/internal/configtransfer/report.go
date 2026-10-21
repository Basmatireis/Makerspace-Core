package configtransfer

import (
	"sort"
	"time"
)

// Action is what an import does, or would do, with one entry.
type Action string

const (
	ActionCreate     Action = "create"
	ActionUpdate     Action = "update"
	ActionDelete     Action = "delete"
	ActionDeactivate Action = "deactivate"
	// ActionKeep marks an entry missing from the file that stays because it is in use or cannot be deleted.
	ActionKeep Action = "keep"
	// ActionSkip marks an entry that is unchanged or, in insert mode, already exists.
	ActionSkip Action = "skip"
	// ActionConflict marks an entry the import cannot apply; an import with conflicts is not applied.
	ActionConflict Action = "conflict"
)

// Item is one entry of a section report.
type Item struct {
	Name   string
	Action Action
	Reason string
	Code   string
}

// Counts sums the items of a section by action.
type Counts struct {
	Create, Update, Delete, Deactivate, Keep, Skip, Conflict int
}

// SectionReport is the outcome of one section.
type SectionReport struct {
	Key    SectionKey
	Counts Counts
	Items  []Item
}

// Report is the outcome of a preview or an applied import.
type Report struct {
	Mode        Mode
	Fingerprint string
	Applied     bool
	AppVersion  string
	ExportedAt  time.Time
	Sections    []SectionReport
	Warnings    []string
}

// Conflicts is the number of conflicting entries over all sections.
func (r Report) Conflicts() int {
	total := 0
	for _, section := range r.Sections {
		total += section.Counts.Conflict
	}
	return total
}

func (s *SectionReport) add(item Item) {
	s.Items = append(s.Items, item)
	switch item.Action {
	case ActionCreate:
		s.Counts.Create++
	case ActionUpdate:
		s.Counts.Update++
	case ActionDelete:
		s.Counts.Delete++
	case ActionDeactivate:
		s.Counts.Deactivate++
	case ActionKeep:
		s.Counts.Keep++
	case ActionSkip:
		s.Counts.Skip++
	case ActionConflict:
		s.Counts.Conflict++
	}
}

func sortStrings(values []string) { sort.Strings(values) }

// Reasons shown with skipped and kept entries.
const (
	reasonUnchanged = "Unchanged."
	reasonExists    = "Already exists; insert mode leaves it untouched."
	reasonSingleton = "These settings always exist; insert mode leaves them untouched."
)
