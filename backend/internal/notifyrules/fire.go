package notifyrules

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

var weekdayKeys = [...]string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

// ruleInfo is the part of a rule row that evaluation and delivery need, whichever query loaded it.
type ruleInfo struct {
	ID                  uuid.UUID
	Name                string
	OwnerAccountID      *uuid.UUID
	OwnerPersonID       *uuid.UUID
	CategoryID          *uuid.UUID
	CategoryBasis       *string
	CategoryTextVersion *int32
	Mandatory           bool
	Definition          []byte
	UpdatedAt           time.Time
	NextRunAt           *time.Time
}

func (r ruleInfo) personal() bool { return r.OwnerAccountID != nil }

func infoFromRunRow(row notifyrulesdb.GetRuleForRunRow) ruleInfo {
	return ruleInfo{
		ID: row.ID, Name: row.Name, OwnerAccountID: row.OwnerAccountID, OwnerPersonID: row.OwnerPersonID,
		CategoryID: row.CategoryID, CategoryBasis: row.CategoryBasis, CategoryTextVersion: row.CategoryTextVersion,
		Mandatory: row.Mandatory, Definition: row.Definition, UpdatedAt: row.UpdatedAt, NextRunAt: timePointer(row.NextRunAt),
	}
}

func infoFromClaimRow(row notifyrulesdb.ClaimDueScheduleRuleRow) ruleInfo {
	return ruleInfo{
		ID: row.ID, Name: row.Name, OwnerAccountID: row.OwnerAccountID, OwnerPersonID: row.OwnerPersonID,
		CategoryID: row.CategoryID, CategoryBasis: row.CategoryBasis, CategoryTextVersion: row.CategoryTextVersion,
		Mandatory: row.Mandatory, Definition: row.Definition, UpdatedAt: row.UpdatedAt, NextRunAt: timePointer(row.NextRunAt),
	}
}

// occurrence is one thing a rule reacts to: an event, one item of a loop, the summary of a loop, or a plain run of
// a schedule.
type occurrence struct {
	Trigger TriggerType
	Event   Event
	// Values hold the e., i. and s. values the conditions look at (n. values are added when they are needed).
	Values     Context
	ItemKey    string
	Collection string
}

// RunStats counts what a run of a rule did.
type RunStats struct {
	// Sent counts the people reached per channel.
	Sent map[Channel]int
	// Examined is the number of items looked at, Fired the number of notifications the rule produced.
	Examined int
	Fired    int
}

type fireOptions struct {
	// Test sends the first-step actions to this person only and marks the firing as a test.
	Test  *uuid.UUID
	Stats *RunStats
}

func eventValues(fields map[string]any) Context {
	values := make(Context, len(fields))
	for key, value := range fields {
		values[PrefixEvent+"."+key] = value
	}
	return values
}

func mergeContext(parts ...Context) Context {
	size := 0
	for _, part := range parts {
		size += len(part)
	}
	merged := make(Context, size)
	for _, part := range parts {
		for key, value := range part {
			merged[key] = value
		}
	}
	return merged
}

// emitRule handles one rule for an event and reports whether it fired.
func (d *Dispatcher) emitRule(
	ctx context.Context,
	q *store,
	rule notifyrulesdb.ListEnabledEventRulesRow,
	trigger Trigger,
	ev Event,
	now time.Time,
) (bool, error) {
	info := ruleInfo{
		ID: rule.ID, Name: rule.Name, OwnerAccountID: rule.OwnerAccountID, OwnerPersonID: rule.OwnerPersonID,
		CategoryID: rule.CategoryID, CategoryBasis: rule.CategoryBasis, CategoryTextVersion: rule.CategoryTextVersion,
		Mandatory: rule.Mandatory, Definition: rule.Definition,
	}
	def, err := ParseDefinition(info.Definition)
	if err != nil {
		return false, fmt.Errorf("the rule's definition cannot be read")
	}
	// A rule limited to some machines ignores the events of every other machine before anything else is looked at.
	if !def.Trigger.MatchesMachine(ev.Fields) {
		return false, nil
	}
	if info.personal() {
		owner := info.OwnerPersonID
		if owner == nil {
			return false, nil
		}
		// A personal rule is a subscription: events about one person reach only that person's own rules, and the owner
		// must still be allowed to see the trigger's data.
		if trigger.Subject == SubjectSelf && !slices.Contains(ev.Recipients["self"], *owner) {
			return false, nil
		}
		if trigger.Permission != "" {
			allowed, err := q.AccountHasPermission(ctx, notifyrulesdb.AccountHasPermissionParams{
				AccountID: *info.OwnerAccountID, PermissionID: string(trigger.Permission),
			})
			if err != nil || !allowed {
				return false, err
			}
		}
	}
	base, err := d.baseValues(ctx, q, def, eventValues(ev.Fields), now)
	if err != nil {
		return false, err
	}
	exp, err := d.expand(ctx, q, def, ev, base, now, TriggerEvent)
	if err != nil {
		return false, err
	}
	fired := false
	for _, occ := range exp.Occurrences {
		ok, err := d.fireOccurrence(ctx, q, info, def, occ, now, fireOptions{})
		if err != nil {
			return false, err
		}
		fired = fired || ok
	}
	return fired, nil
}

// expansion is what a rule's loop turns one run into.
type expansion struct {
	// Base holds the values every occurrence shares (the event's and the present moment's).
	Base        Context
	Occurrences []occurrence
	// Items are all items of the loop's collection, Selected those that pass its filter.
	Items    []Item
	Selected []Item
	Summary  Context
}

// expand turns a run into the occurrences the rule fires for: one without a loop, one per selected item in each
// mode, one for all selected items in summary mode.
func (d *Dispatcher) expand(
	ctx context.Context,
	q *store,
	def Definition,
	ev Event,
	base Context,
	now time.Time,
	trigger TriggerType,
) (expansion, error) {
	if def.Loop == nil {
		return expansion{Base: base, Occurrences: []occurrence{{Trigger: trigger, Event: ev, Values: base}}}, nil
	}
	collection, ok := LookupCollection(def.Loop.Collection)
	if !ok {
		return expansion{}, fmt.Errorf("unknown collection %q", def.Loop.Collection)
	}
	items, err := d.loadCollection(ctx, q, collection, now)
	if err != nil {
		return expansion{}, err
	}
	lookup := FieldLookupFor(def)
	exp := expansion{Base: base, Items: items}
	for _, item := range items {
		if def.Loop.Filter.Evaluate(mergeContext(base, ItemContext(item.Fields)), lookup) {
			exp.Selected = append(exp.Selected, item)
		}
	}
	if def.Loop.Mode == ModeSummary {
		fields := make([]map[string]any, len(exp.Selected))
		for i, item := range exp.Selected {
			fields[i] = item.Fields
		}
		exp.Summary = SummaryContext(collection, fields)
		summaryEvent := ev
		summaryEvent.Placeholders = mergeTexts(ev.Placeholders, summaryPlaceholders(collection, exp.Selected, exp.Summary))
		exp.Occurrences = []occurrence{{
			Trigger: trigger, Event: summaryEvent, Values: mergeContext(base, exp.Summary), Collection: collection.Key,
		}}
		return exp, nil
	}
	for _, item := range exp.Selected {
		itemEvent := ev
		itemEvent.Placeholders = mergeTexts(ev.Placeholders, item.placeholders(collection))
		itemEvent.Recipients = map[string][]uuid.UUID{}
		for key, people := range ev.Recipients {
			itemEvent.Recipients[key] = people
		}
		for key, people := range item.Recipients {
			itemEvent.Recipients["item:"+key] = people
		}
		itemEvent.Organizations = map[string][]uuid.UUID{}
		for key, organizations := range ev.Organizations {
			itemEvent.Organizations[key] = organizations
		}
		for key, organizations := range item.Organizations {
			itemEvent.Organizations["item:"+key] = organizations
		}
		itemEvent.Subjects = map[string]string{ThrottlePerItem: item.Key}
		for key, value := range ev.Subjects {
			itemEvent.Subjects[key] = value
		}
		if itemEvent.Link == "" {
			itemEvent.Link = item.Link
		}
		if ev.ResolveToken != "" {
			itemEvent.ResolveToken = ev.ResolveToken + ":" + item.Key
		}
		exp.Occurrences = append(exp.Occurrences, occurrence{
			Trigger: trigger, Event: itemEvent, Values: mergeContext(base, ItemContext(item.Fields)), ItemKey: item.Key,
			Collection: collection.Key,
		})
	}
	return exp, nil
}

func mergeTexts(parts ...map[string]string) map[string]string {
	merged := map[string]string{}
	for _, part := range parts {
		for key, value := range part {
			merged[key] = value
		}
	}
	return merged
}

// summaryPlaceholders are {count}, {list} and the {sum.x} and {max.x} values of a summary.
func summaryPlaceholders(c Collection, selected []Item, summary Context) map[string]string {
	texts := map[string]string{"count": trimNumber(float64(len(selected)))}
	const shown = 15
	lines := make([]string, 0, shown+1)
	for i, item := range selected {
		if i == shown {
			lines = append(lines, fmt.Sprintf("… and %d more", len(selected)-shown))
			break
		}
		lines = append(lines, "- "+item.Name)
	}
	texts["list"] = strings.Join(lines, "\n")
	for _, field := range SummaryFields(c) {
		if value, ok := summary[PrefixSummary+"."+field.Key]; ok && field.Key != "count" {
			texts[field.Key] = formatValue(field, value)
		}
	}
	return texts
}

type stagedAction struct {
	step   int
	delay  time.Duration
	action Action
	link   string
	people []uuid.UUID
	orgs   []uuid.UUID
}

// buildPlan resolves who each action of the occurrence addresses and fills its texts. Escalation steps are resolved
// now too, so they reach the people of the moment.
func (d *Dispatcher) buildPlan(
	ctx context.Context,
	q *store,
	def Definition,
	occ occurrence,
	ruleName string,
	owner *uuid.UUID,
) ([]stagedAction, []uuid.UUID, error) {
	var plan []stagedAction
	var everyone []uuid.UUID
	add := func(step int, delay time.Duration, action Action) error {
		if action.Channel == ChannelSignage || action.Channel == ChannelTablet {
			return addNotice(&plan, step, delay, action, occ.Event, ruleName)
		}
		if action.Channel != ChannelInApp && action.Channel != ChannelEmail {
			return nil
		}
		people, err := d.resolvePeople(ctx, q, action.Recipients, occ.Event, owner)
		if err != nil {
			return err
		}
		people = removePeople(people, occ.Event.ExcludedPeople)
		var orgs []uuid.UUID
		if action.Channel == ChannelEmail {
			orgs = resolveOrganizations(action.Recipients, occ.Event)
		}
		if len(people) == 0 && len(orgs) == 0 {
			return nil
		}
		filled, link := fillAction(action, occ.Event, ruleName)
		plan = append(plan, stagedAction{step: step, delay: delay, action: filled, link: link, people: people, orgs: orgs})
		everyone = append(everyone, people...)
		return nil
	}
	for _, action := range def.Actions {
		if err := add(0, time.Duration(action.DelayMinutes)*time.Minute, action); err != nil {
			return nil, nil, err
		}
	}
	if def.Escalation != nil {
		for index, step := range def.Escalation.Steps {
			if err := add(index+1, time.Duration(step.After.Minutes())*time.Minute, step.Action); err != nil {
				return nil, nil, err
			}
		}
	}
	return plan, dedupePeople(everyone), nil
}

// addNotice stages a signage or tablet action. Signage notices and the tablet modes for whoever is at the tablet
// address no person; the person modes address the person the event is about (its "self" recipient) and are left out
// when the event has none.
func addNotice(plan *[]stagedAction, step int, delay time.Duration, action Action, ev Event, ruleName string) error {
	var people []uuid.UUID
	if action.Channel == ChannelTablet && action.Tablet != nil &&
		(action.Tablet.Mode == TabletPersonCheckIn || action.Tablet.Mode == TabletNextCheckIn) {
		if people = dedupePeople(ev.Recipients["self"]); len(people) == 0 {
			return nil
		}
	}
	filled, link := fillAction(action, ev, ruleName)
	*plan = append(*plan, stagedAction{step: step, delay: delay, action: filled, link: link, people: people})
	return nil
}

// fireOccurrence evaluates the rule's conditions for the occurrence and, when they hold, delivers or schedules its
// actions. It reports whether the rule fired.
func (d *Dispatcher) fireOccurrence(
	ctx context.Context,
	q *store,
	rule ruleInfo,
	def Definition,
	occ occurrence,
	now time.Time,
	opts fireOptions,
) (bool, error) {
	runtime := newRuntime(
		rule.ID, rule.Name, rule.CategoryID, rule.CategoryBasis, rule.CategoryTextVersion, rule.Mandatory,
		rule.personal() || opts.Test != nil, def,
	)
	runtime.Stats = opts.Stats
	var plan []stagedAction
	if opts.Test != nil {
		for _, action := range def.Actions {
			if action.Channel != ChannelInApp && action.Channel != ChannelEmail {
				continue
			}
			filled, link := fillAction(action, occ.Event, rule.Name)
			plan = append(plan, stagedAction{action: filled, link: link, people: []uuid.UUID{*opts.Test}})
		}
	} else {
		var everyone []uuid.UUID
		var err error
		if plan, everyone, err = d.buildPlan(ctx, q, def, occ, rule.Name, rule.OwnerPersonID); err != nil {
			return false, err
		}
		if len(plan) == 0 {
			return false, nil
		}
		evaluation, err := d.evaluate(ctx, q, def, occ.Values, now, everyone)
		if err != nil {
			return false, err
		}
		if !evaluation.eventOK {
			return false, nil
		}
		runtime.Pass = evaluation.pass
		if runtime.Pass != nil && !slices.ContainsFunc(everyone, runtime.Pass) {
			return false, nil
		}
		if def.Throttle != nil && def.Throttle.Per != ThrottlePerPerson && def.Throttle.Every.Minutes() > 0 {
			window := time.Duration(def.Throttle.Every.Minutes()) * time.Minute
			claimed, err := q.ClaimThrottle(ctx, notifyrulesdb.ClaimThrottleParams{
				RuleID: rule.ID, SubjectKey: throttleKey(def.Throttle.Per, occ.Event.Subjects), Now: now,
				WindowStart: now.Add(-window),
			})
			if err != nil {
				return false, fmt.Errorf("claim throttle: %w", err)
			}
			if claimed == 0 {
				return false, nil
			}
		}
	}
	if len(plan) == 0 {
		return false, nil
	}
	firingID := ids.New()
	var token *string
	if occ.Event.ResolveToken != "" {
		token = &occ.Event.ResolveToken
	}
	if err := q.InsertFiring(ctx, notifyrulesdb.InsertFiringParams{
		ID: firingID, RuleID: rule.ID, RuleName: Clip(rule.Name, MaxNameLength), TriggerType: string(occ.Trigger),
		Summary: firingSummary(plan[0].action, rule.Name), ResolveToken: token, Test: opts.Test != nil, CreatedAt: now,
	}); err != nil {
		return false, fmt.Errorf("insert firing: %w", err)
	}
	if opts.Test == nil {
		if err := q.MarkRuleFired(ctx, notifyrulesdb.MarkRuleFiredParams{
			ID: rule.ID, FiredAt: pgtype.Timestamptz{Time: now, Valid: true},
		}); err != nil {
			return false, fmt.Errorf("mark rule fired: %w", err)
		}
	}
	for _, item := range plan {
		var err error
		if opts.Test == nil && (item.delay > 0 || item.step > 0) {
			err = d.schedule(ctx, q, firingID, item.step, now.Add(item.delay), item.action, item.people, pendingItem{
				Values: storedValues(occ.Values), Link: item.link, Organizations: item.orgs, ItemKey: occ.ItemKey,
				Collection: occ.Collection,
			})
		} else {
			err = d.deliver(ctx, q, runtime, deliveryInput{
				FiringID: firingID, Action: item.action, Link: item.link, People: item.people, Organizations: item.orgs,
			}, now)
		}
		if err != nil {
			return false, err
		}
	}
	if opts.Stats != nil {
		opts.Stats.Fired++
	}
	return true, nil
}

// storedValues keeps the e., i. and s. values a waiting action re-evaluates; the n. values are read afresh.
func storedValues(values Context) map[string]any {
	kept := map[string]any{}
	for key, value := range values {
		if !strings.HasPrefix(key, PrefixNow+".") {
			kept[key] = value
		}
	}
	return kept
}

// evaluation is the outcome of a rule's conditions for one occurrence.
type evaluation struct {
	// eventOK is the verdict on the occurrence itself; it is true when r. conditions decide per person instead.
	eventOK bool
	// pass decides per person; nil when the rule has no r. conditions.
	pass func(uuid.UUID) bool
}

// conditionKeys collects the n. and r. keys the rule's conditions (and, for n., its loop filter) ask for.
func conditionKeys(def Definition) (now, recipient map[string]bool) {
	now, recipient = map[string]bool{}, map[string]bool{}
	note := func(field string, recipients bool) {
		prefix, key, _ := strings.Cut(field, ".")
		switch {
		case prefix == PrefixNow:
			now[key] = true
		case prefix == PrefixRecipient && recipients:
			recipient[key] = true
		}
	}
	for _, condition := range def.Conditions.Conditions() {
		note(condition.Field, true)
		note(condition.Ref, true)
	}
	if def.Loop != nil {
		for _, condition := range def.Loop.Filter.Conditions() {
			note(condition.Field, false)
			note(condition.Ref, false)
		}
	}
	return now, recipient
}

// baseValues adds the n. values the rule's conditions ask for to the given values.
func (d *Dispatcher) baseValues(
	ctx context.Context,
	q *store,
	def Definition,
	values Context,
	now time.Time,
) (Context, error) {
	needed, _ := conditionKeys(def)
	nowValues, err := d.nowContext(ctx, q, needed, now)
	if err != nil {
		return nil, err
	}
	return mergeContext(values, nowValues), nil
}

// evaluate checks the rule's conditions against the occurrence's values. Conditions on the recipient (r.) are
// evaluated once per person with that person's facts; if the rule asks for a fact that cannot be loaded, nobody
// passes, so a rule never reaches more people than it says.
func (d *Dispatcher) evaluate(
	ctx context.Context,
	q *store,
	def Definition,
	values Context,
	now time.Time,
	people []uuid.UUID,
) (evaluation, error) {
	lookup := FieldLookupFor(def)
	needed, recipientKeys := conditionKeys(def)
	if len(needed) > 0 {
		var err error
		if values, err = d.withNow(ctx, q, values, needed, now); err != nil {
			return evaluation{}, err
		}
	}
	if len(recipientKeys) == 0 {
		return evaluation{eventOK: def.Conditions.Evaluate(values, lookup)}, nil
	}
	facts, supported, err := d.recipientFacts(ctx, q, recipientKeys, people, now)
	if err != nil {
		return evaluation{}, err
	}
	pass := func(person uuid.UUID) bool {
		if !supported {
			return false
		}
		return def.Conditions.Evaluate(mergeContext(values, facts[person]), lookup)
	}
	return evaluation{eventOK: true, pass: pass}, nil
}

// withNow adds the n. values that are not part of the values yet.
func (d *Dispatcher) withNow(
	ctx context.Context,
	q *store,
	values Context,
	needed map[string]bool,
	now time.Time,
) (Context, error) {
	missing := map[string]bool{}
	for key := range needed {
		if _, ok := values[PrefixNow+"."+key]; !ok {
			missing[key] = true
		}
	}
	if len(missing) == 0 {
		return values, nil
	}
	nowValues, err := d.nowContext(ctx, q, missing, now)
	if err != nil {
		return nil, err
	}
	return mergeContext(values, nowValues), nil
}

// nowContext holds the n. values the conditions ask for. The weekday and the hour cost nothing; the others read the
// database only when a condition needs them. Values this package cannot tell are left out, so their conditions are
// not applicable.
func (d *Dispatcher) nowContext(
	ctx context.Context,
	q *store,
	needed map[string]bool,
	now time.Time,
) (Context, error) {
	local := now.In(d.location)
	values := Context{
		PrefixNow + ".weekday": weekdayKeys[local.Weekday()],
		PrefixNow + ".hour":    float64(local.Hour()),
	}
	if needed["present"] {
		count, err := q.CountCheckedInPeople(ctx)
		if err != nil {
			return nil, fmt.Errorf("count people present: %w", err)
		}
		values[PrefixNow+".present"] = float64(count)
	}
	if needed["supervisorsOnline"] {
		count, err := q.CountSupervisorsOnline(ctx, now.Add(-onlineWindow))
		if err != nil {
			return nil, fmt.Errorf("count supervisors online: %w", err)
		}
		values[PrefixNow+".supervisorsOnline"] = float64(count)
	}
	if needed["openDayRunning"] {
		running, err := q.OpenDayRunning(ctx, now)
		if err != nil {
			return nil, fmt.Errorf("read running open day: %w", err)
		}
		values[PrefixNow+".openDayRunning"] = running
	}
	if needed["holiday"] {
		day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
		onBreak, err := q.OnAcademicBreak(ctx, pgtype.Date{Time: day, Valid: true})
		if err != nil {
			return nil, fmt.Errorf("read academic breaks: %w", err)
		}
		if !onBreak && d.holiday != nil {
			if onBreak, err = d.holiday(day); err != nil {
				return nil, fmt.Errorf("read public holidays: %w", err)
			}
		}
		values[PrefixNow+".holiday"] = onBreak
	}
	return values, nil
}

// recipientFacts loads the r. values for the people. supported is false when a condition names a fact this engine
// cannot load.
func (d *Dispatcher) recipientFacts(
	ctx context.Context,
	q *store,
	keys map[string]bool,
	people []uuid.UUID,
	now time.Time,
) (map[uuid.UUID]Context, bool, error) {
	facts := make(map[uuid.UUID]Context, len(people))
	for _, person := range people {
		facts[person] = Context{}
	}
	set := func(person uuid.UUID, key string, value any) {
		if values, ok := facts[person]; ok {
			values[PrefixRecipient+"."+key] = value
		}
	}
	personIDs := uuidStrings(people)
	supported := true
	var staffed map[uuid.UUID]staffingFact
	for key := range keys {
		switch key {
		case "systemRole":
			rows, err := q.ListMembershipsOfPeople(ctx, personIDs)
			if err != nil {
				return nil, false, fmt.Errorf("load memberships: %w", err)
			}
			for _, person := range people {
				set(person, key, "")
			}
			for _, row := range rows {
				set(row.PersonID, key, row.Membership)
			}
		case "roles":
			rows, err := q.ListRoleIDsOfPeople(ctx, personIDs)
			if err != nil {
				return nil, false, fmt.Errorf("load roles: %w", err)
			}
			held := map[uuid.UUID][]string{}
			for _, row := range rows {
				held[row.PersonID] = append(held[row.PersonID], row.RoleID.String())
			}
			for _, person := range people {
				set(person, key, append([]string{}, held[person]...))
			}
		case "checkedIn":
			present, err := q.ListCheckedInPeople(ctx, personIDs)
			if err != nil {
				return nil, false, fmt.Errorf("load check-ins: %w", err)
			}
			for _, person := range people {
				set(person, key, slices.Contains(present, person))
			}
		case "appOpen":
			open, err := q.ListAppOpenPeople(ctx, notifyrulesdb.ListAppOpenPeopleParams{PersonIds: personIDs, Since: now.Add(-onlineWindow)})
			if err != nil {
				return nil, false, fmt.Errorf("load app presence: %w", err)
			}
			for _, person := range people {
				set(person, key, slices.Contains(open, person))
			}
		case "lastVisit":
			rows, err := q.ListLastVisits(ctx, personIDs)
			if err != nil {
				return nil, false, fmt.Errorf("load last visits: %w", err)
			}
			days := map[uuid.UUID]float64{}
			for _, row := range rows {
				days[row.PersonID] = float64(int(now.Sub(row.LastVisit).Hours() / 24))
			}
			for _, person := range people {
				value, visited := days[person]
				if !visited {
					value = neverVisitedDays
				}
				set(person, key, value)
			}
		case "signedUpNext14":
			signed, err := q.ListPeopleSignedUpBetween(ctx, notifyrulesdb.ListPeopleSignedUpBetweenParams{
				FromTime: now, ToTime: now.Add(signedUpWindow), PersonIds: personIDs,
			})
			if err != nil {
				return nil, false, fmt.Errorf("load open day sign-ups: %w", err)
			}
			for _, person := range people {
				set(person, key, slices.Contains(signed, person))
			}
		case "openDays", "minimum", "belowMinimum":
			if staffed == nil {
				var err error
				if staffed, err = d.staffingFacts(ctx, q, people, now); err != nil {
					return nil, false, err
				}
			}
			for _, person := range people {
				fact := staffed[person]
				switch key {
				case "openDays":
					set(person, key, float64(fact.Done))
				case "minimum":
					set(person, key, float64(fact.Minimum))
				default:
					set(person, key, fact.Below)
				}
			}
		case "unpaid":
			unpaid, err := d.unpaidFacts(ctx, q, people, now)
			if err != nil {
				return nil, false, err
			}
			for _, person := range people {
				set(person, key, unpaid[person].Amount)
			}
		default:
			supported = false
		}
	}
	return facts, supported, nil
}
