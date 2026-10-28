// Package privacy is the core's privacy registry: every module declares the
// categories of personal data it stores, with the triggers and actions its
// retention supports and whether the data is linked to a person or an
// account. Definitions live in application code (internal/privacycatalog and
// later plugin manifests); the installation's retention policies and data
// subject requests refer to them by category id.
//
// Privacy is a core module: it can never be disabled, and a category stays
// registered after its owning module was disabled or its plugin removed, so
// retention and data-subject requests still reach that data.
package privacy

import (
	"fmt"
	"regexp"
	"time"
)

// CategoryID identifies a data category, for example "events.external_signups".
type CategoryID string

// Trigger names the event that starts a retention period.
type Trigger string

// Action names what retention does once a period has elapsed.
type Action string

// Subject says whether rows of the category are linked to a person or an account.
type Subject string

const (
	TriggerCreatedAt       Trigger = "created_at"
	TriggerCompletedAt     Trigger = "completed_at"
	TriggerCancelledAt     Trigger = "cancelled_at"
	TriggerExpiredAt       Trigger = "expired_at"
	TriggerAccountClosedAt Trigger = "account_closed_at"
	TriggerLastUsedAt      Trigger = "last_used_at"
	TriggerLegalPeriodEnd  Trigger = "legal_period_end"
	TriggerEndedAt         Trigger = "ended_at"

	ActionDelete           Action = "delete"
	ActionAnonymize        Action = "anonymize"
	ActionUnlink           Action = "unlink"
	ActionRedact           Action = "redact"
	ActionRetainWithReview Action = "retain_with_review"

	SubjectNone    Subject = "none"
	SubjectPerson  Subject = "person"
	SubjectAccount Subject = "account"
)

// LegacyDefault describes how the installation handled the category before
// the privacy registry existed, so Phase 4 can seed a policy proposal and the
// transition can be checked against the old behaviour.
type LegacyDefault struct {
	Trigger Trigger
	Period  time.Duration
	Action  Action
	// Source names where the period came from: an environment variable, a database setting,
	// a code constant or "lazy" for sweeps that ran on reads.
	Source string
	// ZeroDisables says that the source treats 0 as a deliberate opt-out.
	ZeroDisables bool
	// Automatic says that the routine ran inside the API process on its own
	// (a maintenance loop or a lazy sweep) rather than from `admin cleanup`.
	// The retention engine keeps running such categories automatically with
	// their legacy period until a policy takes over, so switching the
	// registry on changes nothing.
	Automatic bool
}

// ModuleID names the built-in feature area that owns a category, for example
// "identity" or "orders". The owner is informational: it tells the operator
// where the data lives and which code answers for it.
type ModuleID string

var moduleIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// Definition declares one category of personal data.
type Definition struct {
	ID          CategoryID
	Owner       ModuleID
	Name        string
	Description string
	// Fields lists the columns that hold the data as table.column, so the
	// inventory test can prove every known personal-data column has an owner.
	Fields   []string
	Triggers []Trigger
	Actions  []Action
	Subject  Subject
	Legacy   *LegacyDefault
	// RetentionNote explains limits, for example why a category can only be redacted.
	RetentionNote string
}

var (
	idPattern    = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`)
	fieldPattern = regexp.MustCompile(`^[a-z_][a-z0-9_]*\.([a-z_][a-z0-9_]*|\*)$`)
)

var validTriggers = map[Trigger]bool{
	TriggerCreatedAt: true, TriggerCompletedAt: true, TriggerCancelledAt: true, TriggerExpiredAt: true,
	TriggerAccountClosedAt: true, TriggerLastUsedAt: true, TriggerLegalPeriodEnd: true, TriggerEndedAt: true,
}

var validActions = map[Action]bool{
	ActionDelete: true, ActionAnonymize: true, ActionUnlink: true, ActionRedact: true, ActionRetainWithReview: true,
}

// Validate checks a definition's shape.
func (d Definition) Validate() error {
	if !idPattern.MatchString(string(d.ID)) {
		return fmt.Errorf("category id %q is invalid", d.ID)
	}
	if d.Name == "" || d.Description == "" {
		return fmt.Errorf("category %q needs a name and a description", d.ID)
	}
	if !moduleIDPattern.MatchString(string(d.Owner)) {
		return fmt.Errorf("category %q has invalid owner %q", d.ID, d.Owner)
	}
	if len(d.Fields) == 0 {
		return fmt.Errorf("category %q lists no fields", d.ID)
	}
	for _, field := range d.Fields {
		if !fieldPattern.MatchString(field) {
			return fmt.Errorf("category %q: field %q must be table.column", d.ID, field)
		}
	}
	if len(d.Triggers) == 0 || len(d.Actions) == 0 {
		return fmt.Errorf("category %q needs at least one trigger and one action", d.ID)
	}
	for _, trigger := range d.Triggers {
		if !validTriggers[trigger] {
			return fmt.Errorf("category %q: unknown trigger %q", d.ID, trigger)
		}
	}
	for _, action := range d.Actions {
		if !validActions[action] {
			return fmt.Errorf("category %q: unknown action %q", d.ID, action)
		}
	}
	switch d.Subject {
	case SubjectNone, SubjectPerson, SubjectAccount:
	default:
		return fmt.Errorf("category %q: unknown subject %q", d.ID, d.Subject)
	}
	if d.Legacy != nil {
		if !validTriggers[d.Legacy.Trigger] || !validActions[d.Legacy.Action] || d.Legacy.Source == "" {
			return fmt.Errorf("category %q: legacy default is incomplete", d.ID)
		}
		if !d.supports(d.Legacy.Trigger, d.Legacy.Action) {
			return fmt.Errorf("category %q: legacy default uses an unsupported trigger or action", d.ID)
		}
	}
	return nil
}

func (d Definition) supports(trigger Trigger, action Action) bool {
	hasTrigger, hasAction := false, false
	for _, candidate := range d.Triggers {
		hasTrigger = hasTrigger || candidate == trigger
	}
	for _, candidate := range d.Actions {
		hasAction = hasAction || candidate == action
	}
	return hasTrigger && hasAction
}

// Supports reports whether a policy may combine the trigger and action for this category.
func (d Definition) Supports(trigger Trigger, action Action) bool { return d.supports(trigger, action) }

// Catalog is the validated set of declared categories.
type Catalog struct {
	byID  map[CategoryID]Definition
	order []CategoryID
}

// NewCatalog validates the definitions.
func NewCatalog(definitions ...Definition) (*Catalog, error) {
	catalog := &Catalog{byID: map[CategoryID]Definition{}}
	fields := map[string]CategoryID{}
	for _, definition := range definitions {
		if err := definition.Validate(); err != nil {
			return nil, err
		}
		if _, duplicate := catalog.byID[definition.ID]; duplicate {
			return nil, fmt.Errorf("category %q is declared twice", definition.ID)
		}
		for _, field := range definition.Fields {
			if owner, taken := fields[field]; taken {
				return nil, fmt.Errorf("field %q is claimed by both %q and %q", field, owner, definition.ID)
			}
			fields[field] = definition.ID
		}
		definition.Fields = append([]string(nil), definition.Fields...)
		definition.Triggers = append([]Trigger(nil), definition.Triggers...)
		definition.Actions = append([]Action(nil), definition.Actions...)
		catalog.byID[definition.ID] = definition
		catalog.order = append(catalog.order, definition.ID)
	}
	return catalog, nil
}

// Definitions returns the categories in declaration order.
func (c *Catalog) Definitions() []Definition {
	result := make([]Definition, 0, len(c.order))
	for _, id := range c.order {
		result = append(result, c.byID[id])
	}
	return result
}

// Lookup returns a category.
func (c *Catalog) Lookup(id CategoryID) (Definition, bool) {
	definition, ok := c.byID[id]
	return definition, ok
}

// IDs returns the category identifiers in declaration order.
func (c *Catalog) IDs() []CategoryID { return append([]CategoryID(nil), c.order...) }

// Covers reports whether a table.column is claimed by a category, either
// exactly or through a table-wide "table.*" field.
func (c *Catalog) Covers(field string) (CategoryID, bool) {
	for _, id := range c.order {
		for _, candidate := range c.byID[id].Fields {
			if candidate == field {
				return id, true
			}
			if len(candidate) > 2 && candidate[len(candidate)-2:] == ".*" &&
				len(field) > len(candidate)-1 && field[:len(candidate)-1] == candidate[:len(candidate)-1] {
				return id, true
			}
		}
	}
	return "", false
}
