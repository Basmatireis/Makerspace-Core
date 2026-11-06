package notifyrules

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// notificationRetention is how long an in-app notification of a rule is kept, like every inbox notification.
	notificationRetention = 90 * 24 * time.Hour
	maxSummaryLength      = 200
	maxReasonLength       = 60
	signedUpWindow        = 14 * 24 * time.Hour
	// neverVisitedDays is what "days since last visit" says about somebody who never checked in.
	neverVisitedDays = 9999
)

// Delivery statuses of a firing's recipients.
const (
	statusSent             = "sent"
	statusSkippedConsent   = "skipped_consent"
	statusSkippedMuted     = "skipped_muted"
	statusSkippedCondition = "skipped_condition"
	statusThrottled        = "throttled"
	statusFallback         = "fallback"
)

// Event is what a feature reports when something a rule can react to happened. Feature code fills only what the
// trigger's catalog entry offers: Fields back the e. conditions, Placeholders the {key} texts, Recipients the dynamic
// recipient keys, Subjects the throttle subjects.
type Event struct {
	Trigger string
	// Fields hold string, float64 (or any Go number), bool and []string values keyed like the trigger's fields.
	Fields       map[string]any
	Placeholders map[string]string
	// Recipients maps the trigger's recipient keys to the people they stand for right now.
	Recipients map[string][]uuid.UUID
	// Subjects maps a throttle subject key to its value (a machine's identifier, an error code).
	Subjects map[string]string
	// ResolveToken identifies the thing the event is about; Resolve with the same token stops the firing's waiting
	// escalations and e-mail fallbacks.
	ResolveToken string
	// Link is the application path {link} stands for.
	Link       string
	OccurredAt time.Time
}

// Dispatcher turns events into notifications according to the enabled rules. Emit and Resolve run inside the caller's
// transaction; RunPending delivers what waited.
type Dispatcher struct {
	pool     *pgxpool.Pool
	location *time.Location
	now      func() time.Time
}

// NewDispatcher builds the dispatcher. Conditions on the weekday and the hour use the makerspace's time zone.
func NewDispatcher(pool *pgxpool.Pool, location *time.Location) *Dispatcher {
	if location == nil {
		location = time.UTC
	}
	return &Dispatcher{pool: pool, location: location, now: func() time.Time { return time.Now().UTC() }}
}

// WithClock replaces the wall clock; tests use it to move time.
func (d *Dispatcher) WithClock(now func() time.Time) *Dispatcher {
	d.now = now
	return d
}

// ruleRuntime is what delivery needs to know about a rule.
type ruleRuntime struct {
	ID         uuid.UUID
	Name       string
	CategoryID *uuid.UUID
	// Consent says the rule's category needs the recipient's consent at TextVersion.
	Consent     bool
	TextVersion int32
	Mandatory   bool
	Personal    bool
	// Channels are the channels the rule's first actions use; a person's preference may add the other one.
	Channels       map[Channel]bool
	PersonThrottle *time.Duration
	// Pass decides the r. conditions per person; nil means there are none.
	Pass func(person uuid.UUID) bool
}

func newRuntime(
	id uuid.UUID,
	name string,
	categoryID *uuid.UUID,
	basis *string,
	textVersion *int32,
	mandatory, personal bool,
	def Definition,
) *ruleRuntime {
	runtime := &ruleRuntime{
		ID: id, Name: name, CategoryID: categoryID, Mandatory: mandatory, Personal: personal,
		Channels: map[Channel]bool{},
	}
	if !personal && basis != nil && *basis == string(BasisConsent) {
		runtime.Consent = true
		if textVersion != nil {
			runtime.TextVersion = *textVersion
		}
	}
	for _, action := range def.Actions {
		runtime.Channels[action.Channel] = true
	}
	if def.Throttle != nil && def.Throttle.Per == ThrottlePerPerson && def.Throttle.Every.Minutes() > 0 {
		window := time.Duration(def.Throttle.Every.Minutes()) * time.Minute
		runtime.PersonThrottle = &window
	}
	return runtime
}

// Emit reacts to an event inside the caller's transaction: every enabled rule on the trigger is evaluated and, when it
// applies, delivered or scheduled. A problem with one rule (a definition that no longer parses, a failing statement)
// is contained in a savepoint, logged with the rule's identifier and skipped, so rules can never fail the mutation
// that caused the event. Only errors that leave the transaction unusable are returned.
func (d *Dispatcher) Emit(ctx context.Context, tx pgx.Tx, ev Event) error {
	trigger, known := LookupTrigger(ev.Trigger)
	if !known {
		slog.WarnContext(ctx, "notification event with an unknown trigger", "trigger", ev.Trigger)
		return nil
	}
	now := ev.OccurredAt.UTC()
	if ev.OccurredAt.IsZero() {
		now = d.now()
	}
	name := ev.Trigger
	rules, err := notifyrulesdb.New(tx).ListEnabledEventRules(ctx, &name)
	if err != nil {
		return fmt.Errorf("load notification rules: %w", err)
	}
	fired, failed := 0, 0
	for _, rule := range rules {
		savepoint, err := tx.Begin(ctx)
		if err != nil {
			return fmt.Errorf("open notification savepoint: %w", err)
		}
		ok, ruleErr := d.emitRule(ctx, notifyrulesdb.New(savepoint), rule, trigger, ev, now)
		if ruleErr != nil {
			if err = savepoint.Rollback(ctx); err != nil {
				return fmt.Errorf("roll back notification savepoint: %w", err)
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			failed++
			slog.WarnContext(ctx, "notification rule skipped", "rule_id", rule.ID, "error", ruleErr)
			continue
		}
		if err = savepoint.Commit(ctx); err != nil {
			return fmt.Errorf("release notification savepoint: %w", err)
		}
		if ok {
			fired++
		}
	}
	if failed > 0 {
		slog.WarnContext(ctx, "notification rules failed", "trigger", ev.Trigger, "rules", len(rules), "failed", failed)
	}
	return nil
}

// emitRule handles one rule and reports whether it fired.
func (d *Dispatcher) emitRule(
	ctx context.Context,
	q *notifyrulesdb.Queries,
	rule notifyrulesdb.ListEnabledEventRulesRow,
	trigger Trigger,
	ev Event,
	now time.Time,
) (bool, error) {
	def, err := ParseDefinition(rule.Definition)
	if err != nil {
		return false, errors.New("the rule's definition cannot be read")
	}
	personal := rule.OwnerAccountID != nil
	var owner *uuid.UUID
	if personal {
		if owner = rule.OwnerPersonID; owner == nil {
			return false, nil
		}
		// A personal rule is a subscription: events about one person reach only that person's own rules, and the owner
		// must still be allowed to see the trigger's data.
		if trigger.Subject == SubjectSelf && !slices.Contains(ev.Recipients["self"], *owner) {
			return false, nil
		}
		if trigger.Permission != "" {
			allowed, err := q.AccountHasPermission(ctx, notifyrulesdb.AccountHasPermissionParams{
				AccountID: *rule.OwnerAccountID, PermissionID: string(trigger.Permission),
			})
			if err != nil || !allowed {
				return false, err
			}
		}
	}
	runtime := newRuntime(
		rule.ID, rule.Name, rule.CategoryID, rule.CategoryBasis, rule.CategoryTextVersion, rule.Mandatory, personal, def,
	)

	// Resolve who each action addresses; escalation steps are resolved now too, so they reach the people of the moment.
	type staged struct {
		step   int
		delay  time.Duration
		action Action
		link   string
		people []uuid.UUID
	}
	var plan []staged
	var everyone []uuid.UUID
	add := func(step int, delay time.Duration, action Action) error {
		if action.Channel != ChannelInApp && action.Channel != ChannelEmail {
			return nil
		}
		people, err := d.resolvePeople(ctx, q, action.Recipients, ev, owner)
		if err != nil || len(people) == 0 {
			return err
		}
		filled, link := fillAction(action, ev, rule.Name)
		plan = append(plan, staged{step: step, delay: delay, action: filled, link: link, people: people})
		everyone = append(everyone, people...)
		return nil
	}
	for _, action := range def.Actions {
		if err = add(0, time.Duration(action.DelayMinutes)*time.Minute, action); err != nil {
			return false, err
		}
	}
	if def.Escalation != nil {
		for index, step := range def.Escalation.Steps {
			if err = add(index+1, time.Duration(step.After.Minutes())*time.Minute, step.Action); err != nil {
				return false, err
			}
		}
	}
	if len(plan) == 0 {
		return false, nil
	}

	evaluation, err := d.evaluate(ctx, q, def, ev.Fields, now, dedupePeople(everyone))
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
			RuleID: rule.ID, SubjectKey: throttleKey(def.Throttle.Per, ev.Subjects), Now: now, WindowStart: now.Add(-window),
		})
		if err != nil {
			return false, fmt.Errorf("claim throttle: %w", err)
		}
		if claimed == 0 {
			return false, nil
		}
	}

	firingID := ids.New()
	var token *string
	if ev.ResolveToken != "" {
		token = &ev.ResolveToken
	}
	if err = q.InsertFiring(ctx, notifyrulesdb.InsertFiringParams{
		ID: firingID, RuleID: rule.ID, RuleName: Clip(rule.Name, MaxNameLength), TriggerType: string(TriggerEvent),
		Summary: firingSummary(plan[0].action, rule.Name), ResolveToken: token, CreatedAt: now,
	}); err != nil {
		return false, fmt.Errorf("insert firing: %w", err)
	}
	if err = q.MarkRuleFired(ctx, notifyrulesdb.MarkRuleFiredParams{ID: rule.ID, FiredAt: pgtype.Timestamptz{Time: now, Valid: true}}); err != nil {
		return false, fmt.Errorf("mark rule fired: %w", err)
	}
	for _, item := range plan {
		if item.delay > 0 || item.step > 0 {
			err = d.schedule(ctx, q, firingID, item.step, now.Add(item.delay), item.action, item.people, pendingItem{
				Fields: ev.Fields, Link: item.link,
			})
		} else {
			err = d.deliver(ctx, q, runtime, deliveryInput{
				FiringID: firingID, Action: item.action, Link: item.link, People: item.people,
			}, now)
		}
		if err != nil {
			return false, err
		}
	}
	return true, nil
}

// Resolve ends the waiting part of every open firing with the token: pending escalation steps and e-mail fallbacks
// are dropped, delayed first actions still go out. Calling it for a token nothing waits on is harmless.
func (d *Dispatcher) Resolve(ctx context.Context, tx pgx.Tx, token, reason string) error {
	if token == "" {
		return nil
	}
	if reason == "" {
		reason = "resolved"
	}
	reason = Clip(reason, maxReasonLength)
	queries := notifyrulesdb.New(tx)
	resolved, err := queries.ResolveOpenFirings(ctx, notifyrulesdb.ResolveOpenFiringsParams{
		ResolvedAt: pgtype.Timestamptz{Time: d.now(), Valid: true}, Reason: &reason, Token: &token,
	})
	if err != nil {
		return fmt.Errorf("resolve notification firings: %w", err)
	}
	if len(resolved) == 0 {
		return nil
	}
	if _, err = queries.DeletePendingEscalations(ctx, uuidStrings(resolved)); err != nil {
		return fmt.Errorf("drop waiting notifications: %w", err)
	}
	return nil
}

// evaluation is the outcome of a rule's conditions for one event.
type evaluation struct {
	// eventOK is the verdict on the event itself; it is true when r. conditions decide per person instead.
	eventOK bool
	// pass decides per person; nil when the rule has no r. conditions.
	pass func(uuid.UUID) bool
}

// evaluate checks the rule's conditions against the event's fields and the present moment. Conditions on the
// recipient (r.) are evaluated once per person with that person's facts; if the rule asks for a fact that cannot be
// loaded, nobody passes, so a rule never reaches more people than it says.
func (d *Dispatcher) evaluate(
	ctx context.Context,
	q *notifyrulesdb.Queries,
	def Definition,
	fields map[string]any,
	now time.Time,
	people []uuid.UUID,
) (evaluation, error) {
	lookup := FieldLookupFor(def)
	conditions := def.Conditions.Conditions()
	values := Context{}
	for key, value := range fields {
		values[PrefixEvent+"."+key] = value
	}
	needed := map[string]bool{}
	recipientKeys := map[string]bool{}
	for _, condition := range conditions {
		prefix, key, _ := strings.Cut(condition.Field, ".")
		switch prefix {
		case PrefixNow:
			needed[key] = true
		case PrefixRecipient:
			recipientKeys[key] = true
		}
	}
	nowValues, err := d.nowContext(ctx, q, needed, now)
	if err != nil {
		return evaluation{}, err
	}
	for key, value := range nowValues {
		values[key] = value
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
		merged := make(Context, len(values)+len(recipientKeys))
		for key, value := range values {
			merged[key] = value
		}
		for key, value := range facts[person] {
			merged[key] = value
		}
		return def.Conditions.Evaluate(merged, lookup)
	}
	return evaluation{eventOK: true, pass: pass}, nil
}

var weekdayKeys = [...]string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

// nowContext holds the n. values the conditions ask for. The weekday and the hour cost nothing; the others read the
// database only when a condition needs them. Values this package cannot tell are left out, so their conditions are
// not applicable.
func (d *Dispatcher) nowContext(
	ctx context.Context,
	q *notifyrulesdb.Queries,
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
	if needed["openDayRunning"] {
		running, err := q.OpenDayRunning(ctx, now)
		if err != nil {
			return nil, fmt.Errorf("read running open day: %w", err)
		}
		values[PrefixNow+".openDayRunning"] = running
	}
	return values, nil
}

// recipientFacts loads the r. values for the people. supported is false when a condition names a fact this engine
// cannot load yet (the open-day minimum and the unpaid amount belong to the scheduled rules).
func (d *Dispatcher) recipientFacts(
	ctx context.Context,
	q *notifyrulesdb.Queries,
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
		default:
			supported = false
		}
	}
	return facts, supported, nil
}

// resolvePeople turns recipient keys into people: the event's own keys, "role:<id>" (everyone holding the role),
// "person:<id>" and "me" (the owner of a personal rule). The result has no duplicates.
func (d *Dispatcher) resolvePeople(
	ctx context.Context,
	q *notifyrulesdb.Queries,
	keys []string,
	ev Event,
	owner *uuid.UUID,
) ([]uuid.UUID, error) {
	var lists [][]uuid.UUID
	var roleIDs []uuid.UUID
	for _, key := range keys {
		kind, rest, _ := strings.Cut(key, ":")
		switch {
		case key == "me":
			if owner != nil {
				lists = append(lists, []uuid.UUID{*owner})
			}
		case kind == "role":
			if id, err := uuid.Parse(rest); err == nil {
				roleIDs = append(roleIDs, id)
			}
		case kind == "person":
			if id, err := uuid.Parse(rest); err == nil {
				lists = append(lists, []uuid.UUID{id})
			}
		case kind == "item":
			// Items belong to loops, which events do not have.
		default:
			lists = append(lists, ev.Recipients[key])
		}
	}
	if len(roleIDs) > 0 {
		holders, err := q.ListPersonIDsByRoles(ctx, uuidStrings(roleIDs))
		if err != nil {
			return nil, fmt.Errorf("resolve role holders: %w", err)
		}
		lists = append(lists, holders)
	}
	return dedupePeople(lists...), nil
}

// dedupePeople joins lists of people without duplicates, keeping the order of first appearance.
func dedupePeople(lists ...[]uuid.UUID) []uuid.UUID {
	seen := map[uuid.UUID]struct{}{}
	var people []uuid.UUID
	for _, list := range lists {
		for _, person := range list {
			if _, dup := seen[person]; dup || person == uuid.Nil {
				continue
			}
			seen[person] = struct{}{}
			people = append(people, person)
		}
	}
	return people
}

func uuidStrings(values []uuid.UUID) []string {
	texts := make([]string, len(values))
	for i, value := range values {
		texts[i] = value.String()
	}
	return texts
}

// throttleKey names what a throttle window applies to: the whole rule, or one value of the trigger's subject (one
// machine, one error code). An unknown subject falls back to the whole rule.
func throttleKey(per string, subjects map[string]string) string {
	if value, ok := subjects[per]; ok && per != ThrottlePerRule && per != ThrottlePerItem {
		return "subject:" + per + ":" + Clip(value, 150)
	}
	return ThrottlePerRule
}

// fillAction fills the placeholders of an action's texts, keeps them within the limits and resolves the link its
// notification opens. Titles stay on one line; an empty title falls back to the rule's name, an empty body to the title.
func fillAction(action Action, ev Event, ruleName string) (Action, string) {
	title, _ := Fill(action.Title, ev.Placeholders)
	title = Clip(singleLine(title), MaxTitleLength)
	if title == "" {
		title = Clip(singleLine(ruleName), MaxTitleLength)
	}
	body, _ := Fill(action.Body, ev.Placeholders)
	body = Clip(strings.TrimSpace(body), MaxBodyLength)
	if body == "" {
		body = title
	}
	action.Title, action.Body = title, body
	return action, actionLink(action, ev.Link)
}

// actionLink is the path or https address a notification opens: the button's link when the action has one, else the
// event's own link. Anything that is not an acceptable link yields none.
func actionLink(action Action, eventLink string) string {
	link := eventLink
	if action.InApp != nil && action.InApp.Button != nil && action.InApp.Button.Kind == ButtonLink &&
		action.InApp.Button.Link != "" {
		link = strings.ReplaceAll(action.InApp.Button.Link, LinkPlaceholder, eventLink)
	}
	if link == "" || strings.Contains(link, "{") || !validLink(link) {
		return ""
	}
	return link
}

func singleLine(text string) string {
	return strings.TrimSpace(strings.Join(strings.Fields(text), " "))
}

func firingSummary(action Action, ruleName string) string {
	if action.Title != "" {
		return Clip(action.Title, maxSummaryLength)
	}
	return Clip(ruleName, maxSummaryLength)
}

// pendingItem is what a waiting action remembers about its event. It holds field values and a link, never texts or
// personal data beyond identifiers.
type pendingItem struct {
	Fields         map[string]any `json:"fields,omitempty"`
	Link           string         `json:"link,omitempty"`
	Fallback       bool           `json:"fallback,omitempty"`
	NotificationID *uuid.UUID     `json:"notificationId,omitempty"`
}

// decodeFields restores the Go types of event fields after a JSON round trip: lists of strings come back as []any.
func decodeFields(fields map[string]any) map[string]any {
	decoded := make(map[string]any, len(fields))
	for key, value := range fields {
		if list, ok := value.([]any); ok {
			texts := make([]string, 0, len(list))
			for _, item := range list {
				if text, isText := item.(string); isText {
					texts = append(texts, text)
				}
			}
			value = texts
		}
		decoded[key] = value
	}
	return decoded
}

// schedule stores an action that waits: a delayed action, an e-mail fallback or an escalation step.
func (d *Dispatcher) schedule(
	ctx context.Context,
	q *notifyrulesdb.Queries,
	firingID uuid.UUID,
	step int,
	due time.Time,
	action Action,
	people []uuid.UUID,
	item pendingItem,
) error {
	actionJSON, err := json.Marshal(action)
	if err != nil {
		return fmt.Errorf("encode pending action: %w", err)
	}
	itemJSON, err := json.Marshal(item)
	if err != nil {
		return fmt.Errorf("encode pending item: %w", err)
	}
	peopleJSON, err := json.Marshal(uuidStrings(people))
	if err != nil {
		return fmt.Errorf("encode pending recipients: %w", err)
	}
	items := string(itemJSON)
	if err = q.InsertPendingAction(ctx, notifyrulesdb.InsertPendingActionParams{
		ID: ids.New(), FiringID: firingID, DueAt: due, Step: int32(step), Action: string(actionJSON), Item: &items,
		Recipients: string(peopleJSON),
	}); err != nil {
		return fmt.Errorf("store pending action: %w", err)
	}
	return nil
}
