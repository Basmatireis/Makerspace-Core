package notifyrules

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// Env is what validation needs besides the definition itself.
type Env struct {
	// Personal validates a subscription: a rule that only ever reaches its owner.
	Personal bool
	// CanSee says whether the author may use catalog entries that need the permission. A nil function sees everything.
	CanSee  func(authorization.Permission) bool
	Lookups Lookups
}

func (e Env) canSee(permission authorization.Permission) bool {
	return permission == "" || e.CanSee == nil || e.CanSee(permission)
}

type validator struct {
	env      Env
	warnings []string
	options  map[OptionSource]map[string]struct{}
	trigger  Trigger
	hasTrig  bool
	coll     Collection
	loop     *Loop
	// event holds the fields of the e. context, with the placeholders and recipients the trigger offers.
	event        []Field
	placeholders map[string]bool
	recipients   map[string]bool
	resolutions  map[string]bool
	subjects     map[string]bool
}

func fail(path, message string) error {
	return apperror.InvalidField(path + ": " + message)
}

// Validate checks a definition strictly and normalizes it in place: defaults are filled in and slices that must not
// be null become empty. It returns the placeholders no source fills as warnings. The error is a 422 whose reason
// starts with the path of the offending property.
func (d *Definition) Validate(env Env) ([]string, error) {
	v := &validator{env: env, options: map[OptionSource]map[string]struct{}{}}
	if err := v.definition(d); err != nil {
		return nil, err
	}
	return v.warnings, nil
}

func (v *validator) definition(d *Definition) error {
	if err := v.triggerDef(&d.Trigger); err != nil {
		return err
	}
	if err := v.loopDef(d.Loop); err != nil {
		return err
	}
	conditionFields, err := v.conditionScope()
	if err != nil {
		return err
	}
	if err := v.conditionSet("conditions", &d.Conditions, conditionFields); err != nil {
		return err
	}
	if len(d.Actions) < 1 || len(d.Actions) > MaxActions {
		return fail("actions", fmt.Sprintf("a rule needs between 1 and %d actions", MaxActions))
	}
	if d.Actions == nil {
		d.Actions = []Action{}
	}
	for i := range d.Actions {
		if err := v.action(fmt.Sprintf("actions[%d]", i), &d.Actions[i], true); err != nil {
			return err
		}
	}
	if err := v.escalation(d); err != nil {
		return err
	}
	return v.throttle(d)
}

func (v *validator) triggerDef(t *TriggerDef) error {
	switch t.Type {
	case TriggerEvent:
		if t.Schedule != nil {
			return fail("trigger.schedule", "an event trigger has no schedule")
		}
		trigger, ok := LookupTrigger(t.Event)
		if !ok || !v.env.canSee(trigger.Permission) {
			return fail("trigger.event", "unknown or unavailable event")
		}
		v.trigger, v.hasTrig = trigger, true
		v.event = v.visibleFields(trigger.Fields)
		v.recipients = keySet(trigger.Recipients)
		v.resolutions = keySet(append(GenericResolutions(), trigger.Resolutions...))
		v.subjects = keySet(trigger.ThrottleSubjects)
		v.placeholders = map[string]bool{}
		for _, p := range trigger.Placeholders {
			v.placeholders[p.Key] = true
		}
	case TriggerSchedule:
		if t.Event != "" {
			return fail("trigger.event", "a schedule trigger has no event")
		}
		if err := v.schedule(t.Schedule); err != nil {
			return err
		}
		v.resolutions = keySet(GenericResolutions())
		v.recipients, v.subjects, v.placeholders = map[string]bool{}, map[string]bool{}, map[string]bool{}
		if t.Schedule.Repeat == RepeatBeforeOpenDay || t.Schedule.Repeat == RepeatAfterOpenDay {
			v.event = OpenDayFields(v.env.Personal)
			v.recipients = keySet(OpenDayRecipients())
			for _, p := range OpenDayPlaceholders() {
				v.placeholders[p.Key] = true
			}
		}
	case TriggerManual:
		if v.env.Personal {
			return fail("trigger.type", "a personal rule fires on an event or a schedule")
		}
		if t.Event != "" || t.Schedule != nil {
			return fail("trigger", "a manual trigger has neither event nor schedule")
		}
		v.resolutions = keySet(GenericResolutions())
		v.recipients, v.subjects, v.placeholders = map[string]bool{}, map[string]bool{}, map[string]bool{}
	default:
		return fail("trigger.type", "must be event, schedule or manual")
	}
	return nil
}

func keySet[T interface{ ~struct{ Key, Label string } }](choices []T) map[string]bool {
	set := make(map[string]bool, len(choices))
	for _, choice := range choices {
		set[struct{ Key, Label string }(choice).Key] = true
	}
	return set
}

func (v *validator) visibleFields(fields []Field) []Field {
	visible := make([]Field, 0, len(fields))
	for _, field := range fields {
		if v.env.canSee(field.Permission) {
			visible = append(visible, field)
		}
	}
	return visible
}

func (v *validator) schedule(s *Schedule) error {
	if s == nil {
		return fail("trigger.schedule", "a schedule trigger needs a schedule")
	}
	if s.Time != "" {
		if _, err := time.Parse("15:04", s.Time); err != nil || len(s.Time) != 5 {
			return fail("trigger.schedule.time", "must be a time like 09:00")
		}
	}
	needTime := func() error {
		if s.Time == "" {
			return fail("trigger.schedule.time", "is required")
		}
		return nil
	}
	forbid := func(weekdays, day, hours bool) error {
		switch {
		case weekdays && len(s.Weekdays) > 0:
			return fail("trigger.schedule.weekdays", "does not apply to this repeat")
		case day && s.DayOfMonth != 0:
			return fail("trigger.schedule.dayOfMonth", "does not apply to this repeat")
		case hours && s.Hours != nil:
			return fail("trigger.schedule.hours", "does not apply to this repeat")
		}
		return nil
	}
	switch s.Repeat {
	case RepeatDaily, RepeatWeekdays:
		if err := needTime(); err != nil {
			return err
		}
		return forbid(true, true, true)
	case RepeatWeekly:
		if err := needTime(); err != nil {
			return err
		}
		if len(s.Weekdays) == 0 || len(s.Weekdays) > 7 {
			return fail("trigger.schedule.weekdays", "choose between 1 and 7 weekdays")
		}
		seen := map[string]bool{}
		for _, day := range s.Weekdays {
			if !slices.Contains(weekdays, day) || seen[day] {
				return fail("trigger.schedule.weekdays", "must list each of mon, tue, wed, thu, fri, sat, sun at most once")
			}
			seen[day] = true
		}
		return forbid(false, true, true)
	case RepeatMonthly:
		if err := needTime(); err != nil {
			return err
		}
		if s.DayOfMonth < 1 || s.DayOfMonth > 28 {
			return fail("trigger.schedule.dayOfMonth", "must be between 1 and 28")
		}
		return forbid(true, false, true)
	case RepeatBeforeOpenDay, RepeatAfterOpenDay:
		if s.Hours == nil || *s.Hours < 0 || *s.Hours > 72 {
			return fail("trigger.schedule.hours", "must be between 0 and 72")
		}
		if s.Time != "" {
			return fail("trigger.schedule.time", "does not apply to this repeat")
		}
		return forbid(true, true, false)
	}
	return fail("trigger.schedule.repeat", "unknown repeat")
}

func (v *validator) loopDef(l *Loop) error {
	v.loop = l
	if l == nil {
		return nil
	}
	collection, ok := LookupCollection(l.Collection)
	if !ok || !v.env.canSee(collection.Permission) {
		return fail("loop.collection", "unknown or unavailable collection")
	}
	if l.Mode != ModeEach && l.Mode != ModeSummary {
		return fail("loop.mode", "must be each or summary")
	}
	collection.Fields = v.visibleFields(collection.Fields)
	v.coll = collection
	return v.conditionSet("loop.filter", &l.Filter, v.prefixed(PrefixItem, collection.Fields))
}

func (v *validator) prefixed(prefix string, fields []Field) map[string]Field {
	table := make(map[string]Field, len(fields))
	for _, field := range fields {
		table[prefix+"."+field.Key] = field
	}
	return table
}

// conditionScope is every field the rule's conditions may use.
func (v *validator) conditionScope() (map[string]Field, error) {
	scope := v.prefixed(PrefixEvent, v.event)
	if v.loop != nil {
		if v.loop.Mode == ModeEach {
			maps2(scope, v.prefixed(PrefixItem, v.coll.Fields))
		} else {
			maps2(scope, v.prefixed(PrefixSummary, SummaryFields(v.coll)))
		}
	}
	maps2(scope, v.prefixed(PrefixRecipient, RecipientFields()))
	maps2(scope, v.prefixed(PrefixNow, NowFields()))
	return scope, nil
}

func maps2(into, from map[string]Field) {
	for key, field := range from {
		into[key] = field
	}
}

func (v *validator) conditionSet(path string, set *ConditionSet, scope map[string]Field) error {
	if set.Mode != ModeAll && set.Mode != ModeAny {
		return fail(path+".mode", "must be all or any")
	}
	if set.Items == nil {
		set.Items = []ConditionItem{}
	}
	if set.Count() > MaxConditions {
		return fail(path+".items", fmt.Sprintf("at most %d conditions", MaxConditions))
	}
	for i := range set.Items {
		item := &set.Items[i]
		itemPath := fmt.Sprintf("%s.items[%d]", path, i)
		switch {
		case item.Group != nil && item.Condition != nil, item.Group == nil && item.Condition == nil:
			return fail(itemPath, "must be a condition or a group")
		case item.Group != nil:
			group := item.Group
			if group.Mode != ModeAll && group.Mode != ModeAny {
				return fail(itemPath+".group.mode", "must be all or any")
			}
			if len(group.Items) == 0 {
				return fail(itemPath+".group.items", "a group needs at least one condition")
			}
			for j := range group.Items {
				if err := v.condition(fmt.Sprintf("%s.group.items[%d]", itemPath, j), &group.Items[j], scope); err != nil {
					return err
				}
			}
		default:
			if err := v.condition(itemPath, item.Condition, scope); err != nil {
				return err
			}
		}
	}
	return nil
}

var opsByType = map[FieldType][]Op{
	FieldEnum:    {OpIs, OpNot, OpAny, OpNone},
	FieldOrdered: {OpGte, OpLte, OpIs, OpNot},
	FieldNumber:  {OpGt, OpGte, OpLt, OpLte, OpEq, OpBetween},
	FieldText:    {OpContains, OpNotContains, OpEq, OpStarts, OpEmpty, OpNotEmpty},
	FieldBool:    {OpYes, OpNo},
	FieldList:    {OpIncludes, OpExcludes},
}

func (v *validator) optionValues(field Field) (map[string]struct{}, error) {
	if field.OptionsFrom == "" {
		set := make(map[string]struct{}, len(field.Options))
		for _, option := range field.Options {
			set[option.Value] = struct{}{}
		}
		return set, nil
	}
	if set, ok := v.options[field.OptionsFrom]; ok {
		return set, nil
	}
	if v.env.Lookups == nil {
		return nil, fmt.Errorf("no lookups to resolve %s options", field.OptionsFrom)
	}
	set, err := v.env.Lookups.OptionValues(field.OptionsFrom)
	if err != nil {
		return nil, err
	}
	v.options[field.OptionsFrom] = set
	return set, nil
}

func (v *validator) condition(path string, c *Condition, scope map[string]Field) error {
	field, ok := scope[c.Field]
	if !ok {
		return fail(path+".field", "unknown or unavailable field")
	}
	if !slices.Contains(opsByType[field.Type], c.Op) {
		return fail(path+".op", "this operator does not apply to the field")
	}
	if c.Ref != "" {
		return v.reference(path, c, field, scope)
	}
	switch c.Op {
	case OpEmpty, OpNotEmpty, OpYes, OpNo:
		if c.Value != nil || c.Value2 != nil {
			return fail(path+".value", "this operator takes no value")
		}
		return nil
	case OpBetween:
		low, ok := number(c.Value)
		if !ok || c.Value2 == nil || !finite(*c.Value2) || *c.Value2 < low {
			return fail(path+".value", "between needs two numbers, the first not above the second")
		}
		c.Value = low
		return nil
	}
	if c.Value2 != nil {
		return fail(path+".value2", "only between takes a second value")
	}
	options, err := v.optionValues(field)
	if err != nil {
		return err
	}
	switch field.Type {
	case FieldNumber:
		n, ok := number(c.Value)
		if !ok {
			return fail(path+".value", "must be a number")
		}
		c.Value = n
	case FieldText:
		text, ok := c.Value.(string)
		if !ok || strings.TrimSpace(text) == "" || utf8.RuneCountInString(text) > MaxTextValueLength {
			return fail(path+".value", fmt.Sprintf("must be text of 1 to %d characters", MaxTextValueLength))
		}
	case FieldEnum, FieldOrdered, FieldList:
		if c.Op == OpAny || c.Op == OpNone {
			values, ok := stringList(c.Value)
			if !ok || len(values) == 0 || len(values) > MaxListValues {
				return fail(path+".value", "must list between 1 and 50 values")
			}
			for _, value := range values {
				if _, known := options[value]; !known {
					return fail(path+".value", "contains an unknown value")
				}
			}
			c.Value = values
			return nil
		}
		text, ok := c.Value.(string)
		if !ok {
			return fail(path+".value", "must be one of the field's values")
		}
		if _, known := options[text]; !known {
			return fail(path+".value", "must be one of the field's values")
		}
	}
	return nil
}

// reference validates a comparison with another field: both numbers, from the same context, and not between.
func (v *validator) reference(path string, c *Condition, field Field, scope map[string]Field) error {
	other, ok := scope[c.Ref]
	prefix, _, _ := strings.Cut(c.Field, ".")
	otherPrefix, _, _ := strings.Cut(c.Ref, ".")
	switch {
	case !ok:
		return fail(path+".ref", "unknown or unavailable field")
	case field.Type != FieldNumber || other.Type != FieldNumber:
		return fail(path+".ref", "only numbers can be compared with another field")
	case prefix != otherPrefix:
		return fail(path+".ref", "must come from the same part of the rule")
	case c.Op == OpBetween:
		return fail(path+".op", "between cannot compare with another field")
	case c.Value != nil || c.Value2 != nil:
		return fail(path+".value", "a comparison with another field has no value")
	case c.Ref == c.Field:
		return fail(path+".ref", "cannot be the field itself")
	}
	return nil
}

func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) && math.Abs(n) <= 1e12 }

func number(value any) (float64, bool) {
	var n float64
	switch typed := value.(type) {
	case float64:
		n = typed
	case float32:
		n = float64(typed)
	case int:
		n = float64(typed)
	case int64:
		n = float64(typed)
	default:
		return 0, false
	}
	return n, finite(n)
}

func stringList(value any) ([]string, bool) {
	switch typed := value.(type) {
	case []string:
		return typed, true
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, false
			}
			result = append(result, text)
		}
		return result, true
	}
	return nil, false
}

// action validates and normalizes one action. delayAllowed is false inside escalation steps, whose "after" is the delay.
func (v *validator) action(path string, a *Action, delayAllowed bool) error {
	if a.Recipients == nil {
		a.Recipients = []string{}
	}
	switch a.Channel {
	case ChannelInApp, ChannelEmail:
	case ChannelSignage, ChannelTablet:
		if v.env.Personal {
			return fail(path+".channel", "a personal rule notifies in the app or by e-mail")
		}
	default:
		return fail(path+".channel", "must be in_app, email, signage or tablet")
	}
	if a.DelayMinutes < 0 || a.DelayMinutes > MaxDelayMinutes || (!delayAllowed && a.DelayMinutes != 0) {
		return fail(path+".delayMinutes", "out of range")
	}
	title := strings.TrimSpace(a.Title)
	if n := utf8.RuneCountInString(title); n < 1 || n > MaxTitleLength || strings.ContainsFunc(title, unicode.IsControl) {
		return fail(path+".title", fmt.Sprintf("must be one line of 1 to %d characters", MaxTitleLength))
	}
	body := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(a.Body, "\r\n", "\n"), "\r", "\n"))
	if utf8.RuneCountInString(body) > MaxBodyLength ||
		strings.ContainsFunc(body, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\t' }) {
		return fail(path+".body", fmt.Sprintf("must be plain text of at most %d characters", MaxBodyLength))
	}
	a.Title, a.Body = title, body
	for _, key := range append(PlaceholderKeys(title), PlaceholderKeys(body)...) {
		if !v.knownPlaceholder(key) {
			v.warnings = append(v.warnings, fmt.Sprintf("%s: {%s} has no value and stays visible", path, key))
		}
	}
	if err := v.recipientList(path, a); err != nil {
		return err
	}
	return v.channelOptions(path, a)
}

func (v *validator) knownPlaceholder(key string) bool {
	if v.placeholders[key] || key == "link" {
		return true
	}
	if v.loop == nil {
		return false
	}
	if v.loop.Mode == ModeEach {
		prefix, field, found := strings.Cut(key, ".")
		_, known := v.coll.Field(field)
		return found && prefix == v.coll.PlaceholderPrefix && known
	}
	if key == "count" || key == "list" {
		return true
	}
	for _, field := range SummaryFields(v.coll) {
		if field.Key == key {
			return true
		}
	}
	return false
}

func (v *validator) recipientList(path string, a *Action) error {
	path += ".recipients"
	if a.Channel == ChannelSignage || a.Channel == ChannelTablet {
		if len(a.Recipients) > 0 {
			return fail(path, "signage and tablet notices address displays and tablets, not people")
		}
		return nil
	}
	if v.env.Personal {
		if len(a.Recipients) != 1 || a.Recipients[0] != "me" {
			return fail(path, `a personal rule notifies exactly "me"`)
		}
		return nil
	}
	if len(a.Recipients) < 1 || len(a.Recipients) > MaxRecipients {
		return fail(path, fmt.Sprintf("choose between 1 and %d recipients", MaxRecipients))
	}
	var roleIDs, personIDs []uuid.UUID
	seen := map[string]bool{}
	for _, recipient := range a.Recipients {
		if seen[recipient] {
			return fail(path, "lists a recipient twice")
		}
		seen[recipient] = true
		kind, rest, _ := strings.Cut(recipient, ":")
		switch {
		case kind == "role" || kind == "person":
			id, err := uuid.Parse(rest)
			if err != nil || id.Version() != 7 {
				return fail(path, "a role or person recipient needs a valid identifier")
			}
			if kind == "role" {
				roleIDs = append(roleIDs, id)
			} else {
				personIDs = append(personIDs, id)
			}
		case kind == "item" && rest != "":
			if v.loop == nil || v.loop.Mode != ModeEach || !v.coll.hasRecipient(rest) {
				return fail(path, "unknown recipient "+recipient)
			}
		case v.recipients[recipient]:
		default:
			return fail(path, "unknown recipient "+recipient)
		}
	}
	return v.existing(path, IDRoles, roleIDs, "role", IDPeople, personIDs, "person")
}

func (v *validator) existing(path string, kindA IDKind, a []uuid.UUID, nameA string, kindB IDKind, b []uuid.UUID, nameB string) error {
	for _, check := range []struct {
		kind IDKind
		ids  []uuid.UUID
		name string
	}{{kindA, a, nameA}, {kindB, b, nameB}} {
		if len(check.ids) == 0 {
			continue
		}
		if v.env.Lookups == nil {
			return fmt.Errorf("no lookups to resolve %s identifiers", check.kind)
		}
		found, err := v.env.Lookups.ExistingIDs(check.kind, check.ids)
		if err != nil {
			return err
		}
		for _, id := range check.ids {
			if _, ok := found[id]; !ok {
				return fail(path, "the "+check.name+" does not exist")
			}
		}
	}
	return nil
}

func (v *validator) channelOptions(path string, a *Action) error {
	if a.Channel != ChannelInApp && a.InApp != nil {
		return fail(path+".inApp", "only in-app actions have in-app options")
	}
	if a.Channel != ChannelSignage && a.Signage != nil {
		return fail(path+".signage", "only signage actions have signage options")
	}
	if a.Channel != ChannelTablet && a.Tablet != nil {
		return fail(path+".tablet", "only tablet actions have tablet options")
	}
	switch a.Channel {
	case ChannelInApp:
		return v.inApp(path+".inApp", a)
	case ChannelSignage:
		s := a.Signage
		if s == nil || len(s.DisplayIDs) < 1 || len(s.DisplayIDs) > MaxTargets {
			return fail(path+".signage.displayIds", fmt.Sprintf("choose between 1 and %d displays", MaxTargets))
		}
		if s.DurationMinutes < 1 || s.DurationMinutes > MaxDurationMinutes {
			return fail(path+".signage.durationMinutes", "must be between 1 and 1440")
		}
		if s.Tone != ToneInfo && s.Tone != ToneWarning && s.Tone != ToneCritical {
			return fail(path+".signage.tone", "must be info, warning or critical")
		}
		return v.existing(path+".signage.displayIds", IDDisplays, s.DisplayIDs, "display", IDDevices, nil, "")
	case ChannelTablet:
		t := a.Tablet
		if t == nil || len(t.DeviceIDs) < 1 || len(t.DeviceIDs) > MaxTargets {
			return fail(path+".tablet.deviceIds", fmt.Sprintf("choose between 1 and %d tablets", MaxTargets))
		}
		switch t.Mode {
		case TabletBanner, TabletPersonCheckIn, TabletNextCheckIn, TabletEveryoneToday:
		default:
			return fail(path+".tablet.mode", "unknown mode")
		}
		return v.existing(path+".tablet.deviceIds", IDDevices, t.DeviceIDs, "tablet", IDDisplays, nil, "")
	}
	return nil
}

func (v *validator) inApp(path string, a *Action) error {
	if a.InApp == nil {
		a.InApp = &InAppOptions{Appearance: AppearanceToast, Level: LevelInfo, ToastSeconds: 10}
	}
	o := a.InApp
	switch o.Appearance {
	case AppearanceBell, AppearanceToast, AppearanceBanner, AppearanceDialog:
	default:
		return fail(path+".appearance", "must be bell, toast, banner or dialog")
	}
	switch o.Level {
	case LevelInfo, LevelSuccess, LevelWarning, LevelError:
	default:
		return fail(path+".level", "must be info, success, warning or error")
	}
	if o.Appearance == AppearanceToast {
		if !slices.Contains([]int{0, 5, 10, 30}, o.ToastSeconds) {
			return fail(path+".toastSeconds", "must be 0, 5, 10 or 30")
		}
	} else if o.ToastSeconds != 0 {
		return fail(path+".toastSeconds", "only a toast disappears by itself")
	}
	if o.Button == nil {
		o.Button = &Button{Kind: ButtonNone}
	}
	switch o.Button.Kind {
	case ButtonNone:
		if o.Button.Label != "" || o.Button.Link != "" {
			return fail(path+".button", "no button has no label or link")
		}
	case ButtonOK, ButtonAcknowledge, ButtonLink:
		if utf8.RuneCountInString(o.Button.Label) > MaxButtonLabelLength || strings.ContainsFunc(o.Button.Label, unicode.IsControl) {
			return fail(path+".button.label", fmt.Sprintf("at most %d characters", MaxButtonLabelLength))
		}
		if o.Button.Kind == ButtonLink {
			if strings.TrimSpace(o.Button.Label) == "" || !validLink(o.Button.Link) {
				return fail(path+".button", `a link button needs a label and "{link}", a path or an https address`)
			}
		} else if o.Button.Link != "" {
			return fail(path+".button.link", "only a link button has a link")
		}
	default:
		return fail(path+".button.kind", "must be none, ok, acknowledge or link")
	}
	blocking := o.Appearance == AppearanceBanner || o.Appearance == AppearanceDialog
	if (o.OnlyButtonCloses || o.AllowLater) && !blocking {
		return fail(path, "only a banner or dialog can wait for a button or be postponed")
	}
	if o.OnlyButtonCloses && o.Button.Kind == ButtonNone {
		return fail(path+".onlyButtonCloses", "needs a button")
	}
	if o.EmailFallbackMinutes != nil && (*o.EmailFallbackMinutes < 1 || *o.EmailFallbackMinutes > MaxFallbackMinutes) {
		return fail(path+".emailFallbackMinutes", "must be between 1 and 1440")
	}
	return nil
}

func (v *validator) escalation(d *Definition) error {
	e := d.Escalation
	if e == nil {
		return nil
	}
	if v.env.Personal {
		return fail("escalation", "a personal rule has no escalation")
	}
	stop := v.resolutions[e.StopWhen]
	if v.loop != nil && v.loop.Mode == ModeEach && e.StopWhen == ResolutionItemNoLongerMatches {
		stop = true
	}
	if !stop {
		return fail("escalation.stopWhen", "unknown resolution")
	}
	if len(e.Steps) < 1 || len(e.Steps) > MaxEscalationSteps {
		return fail("escalation.steps", fmt.Sprintf("choose between 1 and %d steps", MaxEscalationSteps))
	}
	previous := 0
	for i := range e.Steps {
		path := fmt.Sprintf("escalation.steps[%d]", i)
		minutes := e.Steps[i].After.Minutes()
		if e.Steps[i].After.Value < 1 || minutes < 1 || minutes > MaxEscalationMinutes || minutes <= previous {
			return fail(path+".after", "must be positive, at most 30 days and later than the step before")
		}
		previous = minutes
		if err := v.action(path+".action", &e.Steps[i].Action, false); err != nil {
			return err
		}
	}
	return nil
}

func (v *validator) throttle(d *Definition) error {
	t := d.Throttle
	if t == nil {
		return nil
	}
	allowed := t.Per == ThrottlePerRule || t.Per == ThrottlePerPerson || v.subjects[t.Per] ||
		(t.Per == ThrottlePerItem && v.loop != nil && v.loop.Mode == ModeEach)
	if !allowed {
		return fail("throttle.per", "unknown subject")
	}
	if minutes := t.Every.Minutes(); t.Every.Value < 1 || minutes < 1 || minutes > MaxEscalationMinutes {
		return fail("throttle.every", "must be positive and at most 30 days")
	}
	return nil
}
