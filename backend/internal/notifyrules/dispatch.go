package notifyrules

import (
	"context"
	"encoding/json"
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
	// Organizations maps recipient keys to organizations that are reached by e-mail only (an order's or a job's
	// customer that is an organization). They have no account and take part in no condition or preference.
	Organizations map[string][]uuid.UUID
	// ExcludedPeople are never notified by this event, whatever a rule's recipients say; the person who caused the
	// event themselves is left out this way.
	ExcludedPeople []uuid.UUID
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
	// holiday tells whether a date is a public holiday; the application wires the Open Days calendar in.
	holiday func(day time.Time) (bool, error)
}

// WithHolidays sets the public holiday calendar that the n.holiday condition looks at next to the academic breaks.
func (d *Dispatcher) WithHolidays(holiday func(day time.Time) (bool, error)) *Dispatcher {
	d.holiday = holiday
	return d
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
	// Stats, when set, counts the people reached.
	Stats *RunStats
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
	rules, err := newStore(tx).ListEnabledEventRules(ctx, &name)
	if err != nil {
		return fmt.Errorf("load notification rules: %w", err)
	}
	fired, failed := 0, 0
	for _, rule := range rules {
		savepoint, err := tx.Begin(ctx)
		if err != nil {
			return fmt.Errorf("open notification savepoint: %w", err)
		}
		ok, ruleErr := d.emitRule(ctx, newStore(savepoint), rule, trigger, ev, now)
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
	// What the firing put on displays and tablets ends with it.
	now := d.now()
	if err = queries.EndSignageRuleNoticesOfFirings(ctx, notifyrulesdb.EndSignageRuleNoticesOfFiringsParams{
		Now: now, FiringIds: uuidStrings(resolved),
	}); err != nil {
		return fmt.Errorf("end signage notices: %w", err)
	}
	if err = queries.ExpireKioskRuleNoticesOfFirings(ctx, notifyrulesdb.ExpireKioskRuleNoticesOfFiringsParams{
		Now: now, FiringIds: uuidStrings(resolved),
	}); err != nil {
		return fmt.Errorf("end tablet notices: %w", err)
	}
	return nil
}

// resolvePeople turns recipient keys into people: the event's own keys, "role:<id>" (everyone holding the role),
// "person:<id>" and "me" (the owner of a personal rule). The result has no duplicates.
func (d *Dispatcher) resolvePeople(
	ctx context.Context,
	q *store,
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
			// "item:<key>" stands for the people the loop's current item points to.
			lists = append(lists, ev.Recipients[key])
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

// resolveOrganizations lists the organizations the event's own recipient keys stand for.
func resolveOrganizations(keys []string, ev Event) []uuid.UUID {
	var lists [][]uuid.UUID
	for _, key := range keys {
		if organizations, ok := ev.Organizations[key]; ok {
			lists = append(lists, organizations)
		}
	}
	return dedupePeople(lists...)
}

// removePeople drops the excluded people from a list.
func removePeople(people, excluded []uuid.UUID) []uuid.UUID {
	if len(excluded) == 0 {
		return people
	}
	kept := make([]uuid.UUID, 0, len(people))
	for _, person := range people {
		if !slices.Contains(excluded, person) {
			kept = append(kept, person)
		}
	}
	return kept
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
	if value, ok := subjects[per]; ok && per != ThrottlePerRule {
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
	// Fields are the event's own values (older rows); Values the prefixed e., i. and s. values.
	Fields         map[string]any `json:"fields,omitempty"`
	Values         map[string]any `json:"values,omitempty"`
	ItemKey        string         `json:"itemKey,omitempty"`
	Collection     string         `json:"collection,omitempty"`
	Link           string         `json:"link,omitempty"`
	Organizations  []uuid.UUID    `json:"organizations,omitempty"`
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
	q *store,
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
