package notifyrules

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgtype"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	maxDryRunItems      = 20
	maxDryRunRecipients = 20
	maxPreviewNames     = 5
	estimateDays        = 30
	defaultActivityPage = 25
	maxActivityPage     = 100
)

var errNoDispatcher = errors.New("the notification engine is not available")

// RunResult says what running or testing a rule did.
type RunResult struct {
	SentInApp int
	SentEmail int
	// Examined is the number of items the rule's loop looked at, Fired the number of notifications it produced.
	Examined int
	Fired    int
}

func resultOf(stats *RunStats) RunResult {
	return RunResult{
		SentInApp: stats.Sent[ChannelInApp], SentEmail: stats.Sent[ChannelEmail], Examined: stats.Examined,
		Fired: stats.Fired,
	}
}

// nextOpenDay is the next scheduled open day, which a manual run of a rule before or after open days acts on.
func (d *Dispatcher) nextOpenDay(ctx context.Context, q *store, now time.Time) (*Item, error) {
	days, err := d.openDayItems(ctx, q, nil, now, now.Add(365*24*time.Hour), now)
	if err != nil {
		return nil, err
	}
	for _, day := range days {
		if cancelled, _ := day.Fields["cancelled"].(bool); !cancelled {
			return &day, nil
		}
	}
	return nil, nil
}

// RunRule runs a central schedule or manual rule now. Needs notification_rules.manage. Rules before or after open
// days act on the next open day.
func (s *Service) RunRule(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (RunResult, error) {
	if !p.Has(authorization.NotificationRulesManage) {
		return RunResult{}, apperror.PermissionDenied
	}
	if s.dispatcher == nil {
		return RunResult{}, errNoDispatcher
	}
	stats := &RunStats{Sent: map[Channel]int{}}
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := newStore(tx)
		row, err := q.GetRuleForRun(ctx, id)
		if err != nil {
			return noRows(err)
		}
		rule := infoFromRunRow(row)
		if rule.personal() {
			return apperror.NotFound
		}
		if row.TriggerType != string(TriggerSchedule) && row.TriggerType != string(TriggerManual) {
			return apperror.Conflicting("rule_not_runnable", "Only schedule and manual rules can be run.")
		}
		if !row.Enabled {
			return apperror.Conflicting("rule_disabled", "Turn the rule on before running it.")
		}
		def, err := ParseDefinition(rule.Definition)
		if err != nil {
			return apperror.Conflicting("rule_unreadable", "The rule's definition cannot be read.")
		}
		now := s.dispatcher.now()
		var day *Item
		if def.Trigger.Schedule != nil && IsOpenDayRepeat(def.Trigger.Schedule.Repeat) {
			if day, err = s.dispatcher.nextOpenDay(ctx, q, now); err != nil || day == nil {
				return err
			}
		}
		trigger := TriggerSchedule
		if def.Trigger.Type == TriggerManual {
			trigger = TriggerManual
		}
		if err = s.dispatcher.fireRun(ctx, q, rule, def, trigger, day, now, fireOptions{Stats: stats}); err != nil {
			return err
		}
		return audit.Write(ctx, tx, auditEvent(p, "notification_rule.run", "notification_rule", id, requestID, []string{}))
	})
	if err != nil {
		return RunResult{}, err
	}
	return resultOf(stats), nil
}

// sampleRun expands the rule with the data of the moment and the trigger's example texts, which is what a test and a
// preview show.
func (d *Dispatcher) sampleRun(
	ctx context.Context,
	q *store,
	rule ruleInfo,
	def Definition,
	now time.Time,
) (expansion, error) {
	ev := Event{Placeholders: map[string]string{}, Recipients: map[string][]uuid.UUID{}, OccurredAt: now}
	switch def.Trigger.Type {
	case TriggerEvent:
		if trigger, ok := LookupTrigger(def.Trigger.Event); ok {
			for _, placeholder := range trigger.Placeholders {
				ev.Placeholders[placeholder.Key] = placeholder.Example
			}
		}
	case TriggerSchedule:
		if def.Trigger.Schedule != nil && IsOpenDayRepeat(def.Trigger.Schedule.Repeat) {
			day, err := d.nextOpenDay(ctx, q, now)
			if err != nil {
				return expansion{}, err
			}
			ev = d.openDayEvent(rule, day, now)
			for _, placeholder := range OpenDayPlaceholders() {
				if _, ok := ev.Placeholders[placeholder.Key]; !ok {
					ev.Placeholders[placeholder.Key] = placeholder.Example
				}
			}
		}
	}
	base, err := d.baseValues(ctx, q, def, eventValues(ev.Fields), now)
	if err != nil {
		return expansion{}, err
	}
	return d.expand(ctx, q, def, ev, base, now, def.Trigger.Type)
}

// TestRule sends the first-step actions of a rule to the caller only, marked as a test. A central rule needs
// notification_rules.manage; a personal subscription must be the caller's own.
func (s *Service) TestRule(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (RunResult, error) {
	return s.testRule(ctx, p, id, requestID, false)
}

// TestSubscription is TestRule for the caller's own personal subscription: a central rule or another account's rule
// answers not found, and no permission is needed.
func (s *Service) TestSubscription(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (RunResult, error) {
	return s.testRule(ctx, p, id, requestID, true)
}

func (s *Service) testRule(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID, ownOnly bool) (RunResult, error) {
	if s.dispatcher == nil {
		return RunResult{}, errNoDispatcher
	}
	stats := &RunStats{Sent: map[Channel]int{}}
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := newStore(tx)
		row, err := q.GetRuleForRun(ctx, id)
		if err != nil {
			return noRows(err)
		}
		rule := infoFromRunRow(row)
		if rule.personal() {
			if *rule.OwnerAccountID != p.AccountID {
				return apperror.NotFound
			}
		} else if ownOnly {
			return apperror.NotFound
		} else if !p.Has(authorization.NotificationRulesManage) {
			return apperror.PermissionDenied
		}
		def, err := ParseDefinition(rule.Definition)
		if err != nil {
			return apperror.Conflicting("rule_unreadable", "The rule's definition cannot be read.")
		}
		now := s.dispatcher.now()
		exp, err := s.dispatcher.sampleRun(ctx, q, rule, def, now)
		if err != nil {
			return err
		}
		stats.Examined = len(exp.Items)
		if len(exp.Occurrences) == 0 {
			return apperror.Conflicting("nothing_to_test", "No item matches the rule's filter right now, so there is nothing to send.")
		}
		person := p.PersonID
		if _, err = s.dispatcher.fireOccurrence(ctx, q, rule, def, exp.Occurrences[0], now, fireOptions{Test: &person, Stats: stats}); err != nil {
			return err
		}
		return audit.Write(ctx, tx, auditEvent(p, "notification_rule.tested", "notification_rule", id, requestID, []string{}))
	})
	if err != nil {
		return RunResult{}, err
	}
	return resultOf(stats), nil
}

// DryRunItem is one item of the rule's loop with its values and whether it matches.
type DryRunItem struct {
	Name    string
	Values  map[string]string
	Matched bool
}

// DryRunSummary is the summary a summary-mode loop would report.
type DryRunSummary struct {
	Values map[string]string
	Pass   bool
}

// DryRunRecipient is a person a rule with conditions on the recipient would address.
type DryRunRecipient struct {
	Name   string
	Passed bool
}

// DryRunPreview is the first-step action of the rule as it would read.
type DryRunPreview struct {
	Channel        Channel
	Recipients     []string
	RecipientCount int
	Title          string
	Body           string
}

// DryRunResult is what a rule would do right now, without doing it.
type DryRunResult struct {
	Estimate30   *int64
	EstimateNote string
	Items        []DryRunItem
	TotalItems   int
	MatchedItems int
	Summary      *DryRunSummary
	Recipients   []DryRunRecipient
	Previews     []DryRunPreview
}

func displayFields(fields []Field, show func(Field) string) map[string]string {
	values := make(map[string]string, len(fields))
	for _, field := range fields {
		values[field.Key] = show(field)
	}
	return values
}

// DryRun evaluates a rule draft against the data of the moment: which items match, how many notifications it would
// have caused in the last or next 30 days, whom it would address and how its texts read. Nothing is written. A
// central draft needs notification_rules.manage; a personal one only the checks of a subscription.
func (s *Service) DryRun(ctx context.Context, p authorization.Principal, input RuleInput, personal bool) (DryRunResult, error) {
	if !personal && !p.Has(authorization.NotificationRulesManage) {
		return DryRunResult{}, apperror.PermissionDenied
	}
	if s.dispatcher == nil {
		return DryRunResult{}, errNoDispatcher
	}
	queries := newStore(s.pool)
	if _, _, err := s.validateRule(ctx, queries.Queries, p, personal, &input, nil); err != nil {
		return DryRunResult{}, err
	}
	d := s.dispatcher
	def := input.Definition
	now := d.now()
	rule := ruleInfo{Name: input.Name}
	if personal {
		person := p.PersonID
		account := p.AccountID
		rule.OwnerPersonID, rule.OwnerAccountID = &person, &account
	}
	exp, err := d.sampleRun(ctx, queries, rule, def, now)
	if err != nil {
		return DryRunResult{}, err
	}
	lookup := FieldLookupFor(def)
	holds := func(values Context) bool { return def.Conditions.Evaluate(values, lookup) }
	var result DryRunResult
	matches := 0
	var sample *occurrence
	switch {
	case def.Loop == nil:
		if len(exp.Occurrences) > 0 {
			sample = &exp.Occurrences[0]
			if holds(exp.Base) {
				matches = 1
			}
		}
	case def.Loop.Mode == ModeSummary:
		collection, _ := LookupCollection(def.Loop.Collection)
		result.TotalItems, result.MatchedItems = len(exp.Items), len(exp.Selected)
		occ := exp.Occurrences[0]
		sample = &occ
		pass := holds(occ.Values)
		if pass {
			matches = 1
		}
		summary := DryRunSummary{Pass: pass, Values: map[string]string{}}
		for _, field := range SummaryFields(collection) {
			summary.Values[field.Key] = formatValue(field, occ.Values[PrefixSummary+"."+field.Key])
		}
		result.Summary = &summary
		result.Items = d.dryRunItems(collection, exp, func(Item, bool) bool { return pass })
	default:
		collection, _ := LookupCollection(def.Loop.Collection)
		result.TotalItems = len(exp.Items)
		passed := map[string]bool{}
		for index, item := range exp.Selected {
			if holds(exp.Occurrences[index].Values) {
				passed[item.Key] = true
				matches++
				if sample == nil || !holds(sample.Values) {
					sample = &exp.Occurrences[index]
				}
			}
		}
		if sample == nil && len(exp.Occurrences) > 0 {
			sample = &exp.Occurrences[0]
		}
		result.MatchedItems = matches
		result.Items = d.dryRunItems(collection, exp, func(item Item, _ bool) bool { return passed[item.Key] })
	}
	result.Estimate30, result.EstimateNote = s.estimate(ctx, queries, def, int64(matches), now)
	if sample != nil {
		if err = d.dryRunPeople(ctx, queries, &result, def, rule, *sample, now); err != nil {
			return DryRunResult{}, err
		}
	}
	return result, nil
}

// dryRunItems lists up to maxDryRunItems items, those that match first.
func (d *Dispatcher) dryRunItems(collection Collection, exp expansion, matched func(Item, bool) bool) []DryRunItem {
	var shown []DryRunItem
	for _, wantMatched := range []bool{true, false} {
		for _, item := range exp.Items {
			if len(shown) >= maxDryRunItems {
				return shown
			}
			isMatch := matched(item, false)
			if isMatch != wantMatched {
				continue
			}
			shown = append(shown, DryRunItem{
				Name: item.Name, Matched: isMatch,
				Values: displayFields(collection.Fields, func(field Field) string { return item.display(field) }),
			})
		}
	}
	return shown
}

// dryRunPeople fills the previews of the first-step actions and the recipient checks.
func (d *Dispatcher) dryRunPeople(
	ctx context.Context,
	q *store,
	result *DryRunResult,
	def Definition,
	rule ruleInfo,
	occ occurrence,
	now time.Time,
) error {
	var everyone []uuid.UUID
	type resolved struct {
		action Action
		people []uuid.UUID
	}
	var actions []resolved
	for _, action := range def.Actions {
		if action.Channel != ChannelInApp && action.Channel != ChannelEmail {
			continue
		}
		people, err := d.resolvePeople(ctx, q, action.Recipients, occ.Event, rule.OwnerPersonID)
		if err != nil {
			return err
		}
		people = removePeople(people, occ.Event.ExcludedPeople)
		if people, err = d.permittedRecipients(ctx, q, def, occ.Event, people); err != nil {
			return err
		}
		filled, _ := fillAction(action, occ.Event, rule.Name)
		actions = append(actions, resolved{action: filled, people: people})
		everyone = append(everyone, people...)
	}
	everyone = dedupePeople(everyone)
	names, err := d.personNames(ctx, q, everyone)
	if err != nil {
		return err
	}
	for _, item := range actions {
		preview := DryRunPreview{
			Channel: item.action.Channel, Title: item.action.Title, Body: item.action.Body,
			RecipientCount: len(item.people), Recipients: []string{},
		}
		for _, person := range item.people {
			if len(preview.Recipients) < maxPreviewNames {
				preview.Recipients = append(preview.Recipients, names[person])
			}
		}
		result.Previews = append(result.Previews, preview)
	}
	if _, recipientKeys := conditionKeys(def); len(recipientKeys) > 0 && len(everyone) > 0 {
		evaluation, err := d.evaluate(ctx, q, def, occ.Values, now, everyone)
		if err != nil {
			return err
		}
		for _, person := range everyone {
			if len(result.Recipients) >= maxDryRunRecipients {
				break
			}
			result.Recipients = append(result.Recipients, DryRunRecipient{
				Name: names[person], Passed: evaluation.eventOK && (evaluation.pass == nil || evaluation.pass(person)),
			})
		}
	}
	return nil
}

func (d *Dispatcher) personNames(ctx context.Context, q *store, people []uuid.UUID) (map[uuid.UUID]string, error) {
	rows, err := q.ListPeopleNames(ctx, uuidStrings(people))
	if err != nil {
		return nil, err
	}
	names := make(map[uuid.UUID]string, len(rows))
	for _, row := range rows {
		names[row.ID] = personName(row.FirstName, row.LastName)
	}
	return names, nil
}

// estimate says how many notifications the rule causes in 30 days: the runs of the next 30 days of a schedule times
// the matches now, or the real occurrences of the last 30 days of an event times the matches now. Triggers whose
// occurrences nothing records answer nil with the reason.
func (s *Service) estimate(ctx context.Context, q *store, def Definition, matches int64, now time.Time) (*int64, string) {
	count := func(value int64) (*int64, string) { return &value, "" }
	switch def.Trigger.Type {
	case TriggerManual:
		return nil, "A manual rule runs when somebody runs it."
	case TriggerSchedule:
		if def.Trigger.Schedule == nil {
			return nil, "The schedule is incomplete."
		}
		var runs int64
		if IsOpenDayRepeat(def.Trigger.Schedule.Repeat) {
			total, err := q.CountScheduledOpenDaysBetween(ctx, notifyrulesdbRange(now, now.AddDate(0, 0, estimateDays)))
			if err != nil {
				return nil, "The open days could not be counted."
			}
			runs = total
		} else {
			runs = int64(RunsBetween(*def.Trigger.Schedule, now, now.AddDate(0, 0, estimateDays), s.location))
		}
		return count(runs * matches)
	}
	since := now.AddDate(0, 0, -estimateDays)
	var occurrences int64
	var err error
	switch def.Trigger.Event {
	case "printer_error":
		occurrences, err = q.CountPrinterErrorsSince(ctx, since)
	case "run_finished":
		occurrences, err = q.CountFinishedJobRunsSince(ctx, pgtypeTime(since))
	case "timelapse_ready":
		occurrences, err = q.CountJobRunTimelapsesSince(ctx, since)
	case "lab_rules_published":
		occurrences, err = q.CountLabRulesPublishedSince(ctx, pgtypeTime(since))
	case "check_in":
		occurrences, err = q.CountVisitsSince(ctx, since)
	case "check_out":
		occurrences, err = q.CountCheckOutsSince(ctx, since)
	case "account_created":
		occurrences, err = q.CountAccountsCreatedSince(ctx, since)
	case "training_recorded":
		occurrences, err = q.CountTrainingRecordsSince(ctx, since)
	case "order_created":
		occurrences, err = q.CountFinalizedOrdersSince(ctx, since)
	case "payment_recorded":
		occurrences, err = q.CountReceiptPaymentsSince(ctx, since)
	case "cash_count_difference":
		occurrences, err = q.CountCashCountDifferencesSince(ctx, since)
	case "wiref_invoice_status":
		occurrences, err = q.CountInvoiceRequestEventsSince(ctx, since)
	case "job_created":
		occurrences, err = q.CountJobsCreatedSince(ctx, since)
	case "survey_answered":
		occurrences, err = q.CountSurveyResponsesSince(ctx, pgtype.Date{Time: since, Valid: true})
	case "privacy_request_created":
		occurrences, err = q.CountPrivacyRequestsSince(ctx, since)
	case "open_day_signup":
		occurrences, err = q.CountOpenDaySignupsSince(ctx, since)
	default:
		return nil, "This kind of event is not recorded, so its past cannot be counted."
	}
	if err != nil {
		return nil, "The past events could not be counted."
	}
	note := "Counts every event of the last 30 days; conditions on the event itself are not applied."
	if def.Loop == nil {
		occurrences *= 1
		if matches == 0 {
			occurrences = 0
		}
	} else {
		occurrences *= matches
	}
	return &occurrences, note
}

// ActivityRecipient is one line of a firing's delivery log. Only names are kept, never addresses.
type ActivityRecipient struct {
	Name    string
	Channel Channel
	Step    int
	Status  string
	SentAt  time.Time
	ReadAt  *time.Time
	// DeliveredAt, SeenAt and AcknowledgedAt are the earliest times the in-app copy reached, was shown to and was
	// acknowledged by the person's account; nil for other channels or while it has not happened.
	DeliveredAt    *time.Time
	SeenAt         *time.Time
	AcknowledgedAt *time.Time
}

// ActivityFiring is one time a rule fired, with its delivery log.
type ActivityFiring struct {
	ID             uuid.UUID
	RuleID         uuid.UUID
	RuleName       string
	Trigger        string
	Summary        string
	Channels       []Channel
	Reached        int64
	Result         string
	ResolvedReason *string
	CreatedAt      time.Time
	Recipients     []ActivityRecipient
}

// ActivityPage is one page of the log, newest first.
type ActivityPage struct {
	Items    []ActivityFiring
	Total    int64
	Page     int
	PageSize int
}

// Activity lists the firings of one rule or of all rules. Needs notification_rules.read.
func (s *Service) Activity(ctx context.Context, p authorization.Principal, rule *uuid.UUID, page, pageSize int) (ActivityPage, error) {
	if !canReadCentral(p) {
		return ActivityPage{}, apperror.PermissionDenied
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = defaultActivityPage
	}
	pageSize = min(pageSize, maxActivityPage)
	return s.activity(ctx, newStore(s.pool), rule, page, pageSize)
}
