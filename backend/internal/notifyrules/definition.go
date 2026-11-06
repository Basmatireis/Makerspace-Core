package notifyrules

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/google/uuid"
)

// Limits of a rule definition. They are enforced by Validate and mirrored in the OpenAPI schema where it can express
// them.
const (
	MaxNameLength        = 120
	MaxDescriptionLength = 500
	MaxActions           = 10
	MaxEscalationSteps   = 5
	MaxConditions        = 30
	MaxRecipients        = 20
	MaxTitleLength       = 120
	MaxBodyLength        = 2000
	MaxLinkLength        = 500
	MaxButtonLabelLength = 40
	MaxTargets           = 20
	MaxListValues        = 50
	MaxTextValueLength   = 200
	MaxDelayMinutes      = 7 * 24 * 60
	MaxEscalationMinutes = 30 * 24 * 60
	MaxFallbackMinutes   = 1440
	MaxDurationMinutes   = 1440
)

// TriggerType says what makes a rule fire.
type TriggerType string

const (
	// TriggerEvent fires when a feature emits the named event.
	TriggerEvent TriggerType = "event"
	// TriggerSchedule fires at the times of its schedule.
	TriggerSchedule TriggerType = "schedule"
	// TriggerManual fires only when someone presses "Run now".
	TriggerManual TriggerType = "manual"
)

// Repeat is how often a schedule fires.
type Repeat string

const (
	RepeatDaily         Repeat = "daily"
	RepeatWeekdays      Repeat = "weekdays"
	RepeatWeekly        Repeat = "weekly"
	RepeatMonthly       Repeat = "monthly"
	RepeatBeforeOpenDay Repeat = "before_open_day"
	RepeatAfterOpenDay  Repeat = "after_open_day"
)

// Mode combines the items of a condition set or a loop's way of looking at its items.
type Mode string

const (
	ModeAll     Mode = "all"
	ModeAny     Mode = "any"
	ModeEach    Mode = "each"
	ModeSummary Mode = "summary"
)

// Op is a condition operator. Which ones apply depends on the field type.
type Op string

const (
	OpIs          Op = "is"
	OpNot         Op = "not"
	OpAny         Op = "any"
	OpNone        Op = "none"
	OpGte         Op = "gte"
	OpLte         Op = "lte"
	OpGt          Op = "gt"
	OpLt          Op = "lt"
	OpEq          Op = "eq"
	OpBetween     Op = "between"
	OpContains    Op = "contains"
	OpNotContains Op = "notcontains"
	OpStarts      Op = "starts"
	OpEmpty       Op = "empty"
	OpNotEmpty    Op = "notempty"
	OpYes         Op = "yes"
	OpNo          Op = "no"
	OpIncludes    Op = "includes"
	OpExcludes    Op = "excludes"
)

// Channel is where an action delivers.
type Channel string

const (
	ChannelInApp   Channel = "in_app"
	ChannelEmail   Channel = "email"
	ChannelSignage Channel = "signage"
	ChannelTablet  Channel = "tablet"
)

// Appearance is how an in-app notification shows up.
type Appearance string

const (
	AppearanceBell   Appearance = "bell"
	AppearanceToast  Appearance = "toast"
	AppearanceBanner Appearance = "banner"
	AppearanceDialog Appearance = "dialog"
)

// Level is the severity an in-app notification is styled with.
type Level string

const (
	LevelInfo    Level = "info"
	LevelSuccess Level = "success"
	LevelWarning Level = "warning"
	LevelError   Level = "error"
)

// ButtonKind is what the button of an in-app notification does.
type ButtonKind string

const (
	ButtonNone        ButtonKind = "none"
	ButtonOK          ButtonKind = "ok"
	ButtonAcknowledge ButtonKind = "acknowledge"
	ButtonLink        ButtonKind = "link"
)

// Tone is how urgent a signage notice looks.
type Tone string

const (
	ToneInfo     Tone = "info"
	ToneWarning  Tone = "warning"
	ToneCritical Tone = "critical"
)

// TabletMode says whom a tablet notice addresses.
type TabletMode string

const (
	TabletBanner        TabletMode = "banner"
	TabletPersonCheckIn TabletMode = "person_checkin"
	TabletNextCheckIn   TabletMode = "next_checkin"
	TabletEveryoneToday TabletMode = "everyone_today"
)

// Unit is a unit of time in escalation delays and throttles.
type Unit string

const (
	UnitMinutes Unit = "minutes"
	UnitHours   Unit = "hours"
	UnitDays    Unit = "days"
)

// Definition is the stored body of a rule (format version 1). It never carries identifiers of people other than the
// explicitly chosen "person:<uuid>" recipients and "role:<uuid>" roles.
type Definition struct {
	Trigger    TriggerDef   `json:"trigger"`
	Loop       *Loop        `json:"loop"`
	Conditions ConditionSet `json:"conditions"`
	Actions    []Action     `json:"actions"`
	Escalation *Escalation  `json:"escalation"`
	Throttle   *Throttle    `json:"throttle"`
}

// TriggerDef says what makes the rule fire.
type TriggerDef struct {
	Type     TriggerType `json:"type"`
	Event    string      `json:"event,omitempty"`
	Schedule *Schedule   `json:"schedule,omitempty"`
}

// Schedule is the timetable of a schedule rule, in the makerspace's time zone.
type Schedule struct {
	Repeat     Repeat   `json:"repeat"`
	Weekdays   []string `json:"weekdays,omitempty"`
	Time       string   `json:"time,omitempty"`
	DayOfMonth int      `json:"dayOfMonth,omitempty"`
	Hours      *int     `json:"hours,omitempty"`
}

// Loop makes a rule look at every item of a collection instead of at one event.
type Loop struct {
	Collection string       `json:"collection"`
	Mode       Mode         `json:"mode"`
	Filter     ConditionSet `json:"filter"`
}

// ConditionSet combines conditions with "all" or "any". An empty set is true.
type ConditionSet struct {
	Mode  Mode            `json:"mode"`
	Items []ConditionItem `json:"items"`
}

// ConditionItem is a condition or one group of conditions (a set nested exactly one level deep).
type ConditionItem struct {
	Condition *Condition
	Group     *ConditionGroup
}

// ConditionGroup is the nested set of a ConditionItem.
type ConditionGroup struct {
	Mode  Mode        `json:"mode"`
	Items []Condition `json:"items"`
}

// Condition compares one field of the rule's context with a value, a second value or another field (ref).
type Condition struct {
	Field  string   `json:"field"`
	Op     Op       `json:"op"`
	Value  any      `json:"value,omitempty"`
	Value2 *float64 `json:"value2,omitempty"`
	Ref    string   `json:"ref,omitempty"`
}

// Action is one delivery of the rule.
type Action struct {
	Channel      Channel        `json:"channel"`
	DelayMinutes int            `json:"delayMinutes"`
	Recipients   []string       `json:"recipients"`
	Title        string         `json:"title"`
	Body         string         `json:"body"`
	InApp        *InAppOptions  `json:"inApp,omitempty"`
	Signage      *SignageTarget `json:"signage,omitempty"`
	Tablet       *TabletTarget  `json:"tablet,omitempty"`
}

// InAppOptions shape an in-app notification.
type InAppOptions struct {
	Appearance           Appearance `json:"appearance"`
	Level                Level      `json:"level"`
	ToastSeconds         int        `json:"toastSeconds"`
	Button               *Button    `json:"button,omitempty"`
	OnlyButtonCloses     bool       `json:"onlyButtonCloses"`
	AllowLater           bool       `json:"allowLater"`
	OnlineOnly           bool       `json:"onlineOnly"`
	EmailFallbackMinutes *int       `json:"emailFallbackMinutes,omitempty"`
}

// Button is the button of an in-app notification.
type Button struct {
	Kind  ButtonKind `json:"kind"`
	Label string     `json:"label,omitempty"`
	Link  string     `json:"link,omitempty"`
}

// SignageTarget addresses signage displays.
type SignageTarget struct {
	DisplayIDs      []uuid.UUID `json:"displayIds"`
	DurationMinutes int         `json:"durationMinutes"`
	Tone            Tone        `json:"tone"`
}

// TabletTarget addresses lab tablets.
type TabletTarget struct {
	DeviceIDs []uuid.UUID `json:"deviceIds"`
	Mode      TabletMode  `json:"mode"`
	MustTap   bool        `json:"mustTap"`
}

// Duration is an amount of time as people enter it.
type Duration struct {
	Value int  `json:"value"`
	Unit  Unit `json:"unit"`
}

// Minutes returns the duration in minutes; an unknown unit counts as zero.
func (d Duration) Minutes() int {
	switch d.Unit {
	case UnitMinutes:
		return d.Value
	case UnitHours:
		return d.Value * 60
	case UnitDays:
		return d.Value * 24 * 60
	}
	return 0
}

// Escalation repeats the notification to more people when nobody reacts, until the stop condition resolves it.
type Escalation struct {
	StopWhen string           `json:"stopWhen"`
	Steps    []EscalationStep `json:"steps"`
}

// EscalationStep is one more action, due after the given time.
type EscalationStep struct {
	After  Duration `json:"after"`
	Action Action   `json:"action"`
}

// Throttle keeps a rule from firing again for the same subject within a time.
type Throttle struct {
	Per   string   `json:"per"`
	Every Duration `json:"every"`
}

// Throttle subjects every rule offers besides the trigger's own.
const (
	ThrottlePerRule   = "rule"
	ThrottlePerPerson = "person"
	ThrottlePerItem   = "item"
)

// UnmarshalJSON reads a condition or a {"group": …} item and rejects anything else.
func (i *ConditionItem) UnmarshalJSON(data []byte) error {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return err
	}
	if raw, isGroup := probe["group"]; isGroup {
		if len(probe) != 1 {
			return errors.New("a group item holds nothing but the group")
		}
		var group ConditionGroup
		if err := decodeStrict(raw, &group); err != nil {
			return err
		}
		*i = ConditionItem{Group: &group}
		return nil
	}
	var condition Condition
	if err := decodeStrict(data, &condition); err != nil {
		return err
	}
	*i = ConditionItem{Condition: &condition}
	return nil
}

// MarshalJSON writes the condition or the group.
func (i ConditionItem) MarshalJSON() ([]byte, error) {
	if i.Group != nil {
		return json.Marshal(struct {
			Group *ConditionGroup `json:"group"`
		}{i.Group})
	}
	if i.Condition == nil {
		return nil, errors.New("empty condition item")
	}
	return json.Marshal(i.Condition)
}

// ParseDefinition reads a stored or submitted definition. Unknown properties, trailing data and wrongly typed values
// are errors, so a definition always has exactly the shape this package validates.
func ParseDefinition(data []byte) (Definition, error) {
	var definition Definition
	if err := decodeStrict(data, &definition); err != nil {
		return Definition{}, fmt.Errorf("parse rule definition: %w", err)
	}
	return definition, nil
}

// Marshal returns the canonical stored JSON of the definition. Slices that must not be null are never nil after
// Validate; Marshal does not repair them.
func (d Definition) Marshal() ([]byte, error) {
	return json.Marshal(d)
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("unexpected data after the JSON value")
	}
	return nil
}

// Conditions returns every condition of the set, groups flattened.
func (s ConditionSet) Conditions() []Condition {
	var all []Condition
	for _, item := range s.Items {
		switch {
		case item.Group != nil:
			all = append(all, item.Group.Items...)
		case item.Condition != nil:
			all = append(all, *item.Condition)
		}
	}
	return all
}

// Count returns how many conditions the set holds, groups included.
func (s ConditionSet) Count() int {
	return len(s.Conditions())
}

// AllActions returns the actions of the rule's first stage followed by the escalation steps' actions.
func (d Definition) AllActions() []Action {
	all := append([]Action(nil), d.Actions...)
	if d.Escalation != nil {
		for _, step := range d.Escalation.Steps {
			all = append(all, step.Action)
		}
	}
	return all
}
