package integration_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
)

type rulesEnv struct {
	*staffingEnv
	rules   *notifyrules.Service
	service uuid.UUID // the seeded service category
	news    uuid.UUID
	surveys uuid.UUID
}

func newRulesEnv(t *testing.T) *rulesEnv {
	t.Helper()
	env := &rulesEnv{staffingEnv: newStaffingEnv(t)}
	env.rules = notifyrules.NewService(env.pool)
	for key, target := range map[string]*uuid.UUID{"service": &env.service, "news": &env.news, "surveys": &env.surveys} {
		if err := env.pool.QueryRow(testContext(t), `SELECT id FROM notification_categories WHERE key=$1`, key).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	return env
}

// grant creates a role holding the permissions and returns its identifier.
func (e *rulesEnv) grant(permissions ...authorization.Permission) uuid.UUID {
	e.t.Helper()
	e.counter++
	return e.role(fmt.Sprintf("Grant %d", e.counter), nil, permissions...).ID
}

// customRules leaves out the system rules the migrations seeded, which every database has.
func customRules(rules []notifyrules.Rule) []notifyrules.Rule {
	var custom []notifyrules.Rule
	for _, rule := range rules {
		if rule.SystemKey == nil {
			custom = append(custom, rule)
		}
	}
	return custom
}

// settings returns the rules that reach a person without the seeded system rules, which reach everybody in some role.
func (e *rulesEnv) settings(ctx context.Context, p authorization.Principal) (notifyrules.Settings, error) {
	settings, err := e.rules.Settings(ctx, p)
	settings.Rules = e.withoutSystemRules(settings.Rules)
	return settings, err
}

// withoutSystemRules leaves out the seeded system rules from the rules that reach a person.
func (e *rulesEnv) withoutSystemRules(reaching []notifyrules.ReachingRule) []notifyrules.ReachingRule {
	e.t.Helper()
	rows, err := e.pool.Query(testContext(e.t), `SELECT id FROM notification_rules WHERE system_key IS NOT NULL`)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	system := map[uuid.UUID]bool{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			e.t.Fatal(err)
		}
		system[id] = true
	}
	var kept []notifyrules.ReachingRule
	for _, rule := range reaching {
		if !system[rule.RuleID] {
			kept = append(kept, rule)
		}
	}
	return kept
}

func (e *rulesEnv) reader() authorization.Principal {
	return e.person("rules-reader", e.grant(authorization.NotificationRulesRead))
}

func (e *rulesEnv) manager() authorization.Principal {
	return e.person("rules-manager", e.grant(authorization.NotificationRulesManage))
}

func eventRule(event string, recipients ...string) notifyrules.RuleInput {
	return notifyrules.RuleInput{
		Name:    "Rule on " + event,
		Enabled: true,
		Definition: notifyrules.Definition{
			Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: event},
			Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
			Actions: []notifyrules.Action{{
				Channel: notifyrules.ChannelInApp, Recipients: recipients, Title: "Heads up", Body: "Secret rule text",
			}},
		},
	}
}

func (e *rulesEnv) central(p authorization.Principal, event string, recipients ...string) notifyrules.Rule {
	e.t.Helper()
	input := eventRule(event, recipients...)
	input.CategoryID = &e.service
	rule, err := e.rules.CreateRule(testContext(e.t), p, input, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	return rule
}

func TestNotificationRulesCentralAccessFollowsPermissions(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	nobody := e.person("rules-nobody")
	reader, manager := e.reader(), e.manager()

	input := eventRule("lab_rules_published", "need_confirm")
	input.CategoryID = &e.service
	if _, err := e.rules.ListRules(ctx, nobody); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("listing without permission: %v", err)
	}
	if _, err := e.rules.CreateRule(ctx, reader, input, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("a reader created a rule: %v", err)
	}
	// manage implies the ability to look at what is being managed
	created, err := e.rules.CreateRule(ctx, manager, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Warnings) != 0 || created.Version != 1 || created.Definition.Actions[0].InApp == nil {
		t.Fatalf("created rule = %+v", created)
	}
	list, err := e.rules.ListRules(ctx, reader)
	list = customRules(list)
	if err != nil || len(list) != 1 || list[0].Stats == nil || len(list[0].Stats.Sparkline) != 14 {
		t.Fatalf("reader list = %+v, %v", list, err)
	}
	if _, err := e.rules.GetRule(ctx, reader, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.rules.GetRule(ctx, nobody, created.ID); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("get without permission: %v", err)
	}
	if err := e.rules.DeleteRule(ctx, reader, created.ID, created.Version, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("a reader deleted a rule: %v", err)
	}
	if _, err := e.rules.ListCategories(ctx, nobody); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("categories without permission: %v", err)
	}
	if _, err := e.rules.CreateCategory(
		ctx,
		reader,
		notifyrules.CategoryInput{Name: "Mine", Basis: notifyrules.BasisConsent},
		nil,
	); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("a reader created a category: %v", err)
	}
	if err := e.rules.DeleteRule(ctx, manager, created.ID, created.Version, nil); err != nil {
		t.Fatal(err)
	}

	// Audit holds the actions and the names of changed fields, never the rule's texts.
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='notification_rule.created' AND resource_id=$1`, 1, created.ID)
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='notification_rule.deleted' AND resource_id=$1`, 1, created.ID)
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE metadata::text LIKE '%Secret rule text%' OR changed_fields::text LIKE '%Secret%'`, 0)
}

func TestNotificationRuleValidationAndVersioning(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	manager := e.manager()
	machineAccess := e.person("rules-machines", e.grant(authorization.NotificationRulesManage, authorization.MachinesRead))

	// A manager without machines.read cannot build on printer errors; one with it can.
	input := eventRule("printer_error", "operator")
	input.CategoryID = &e.service
	if _, err := e.rules.CreateRule(ctx, manager, input, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("hidden trigger: %v", err)
	}
	rule, err := e.rules.CreateRule(ctx, machineAccess, input, nil)
	if err != nil {
		t.Fatal(err)
	}

	bad := map[string]func(*notifyrules.RuleInput){
		"unknown event":     func(r *notifyrules.RuleInput) { r.Definition.Trigger.Event = "nothing" },
		"unknown recipient": func(r *notifyrules.RuleInput) { r.Definition.Actions[0].Recipients = []string{"nobody"} },
		"missing role": func(r *notifyrules.RuleInput) {
			r.Definition.Actions[0].Recipients = []string{"role:" + uuid.NewString()}
		},
		"missing category": func(r *notifyrules.RuleInput) { id := uuid.New(); r.CategoryID = &id },
		"no category":      func(r *notifyrules.RuleInput) { r.CategoryID = nil },
		"empty name":       func(r *notifyrules.RuleInput) { r.Name = " " },
		"unknown machine": func(r *notifyrules.RuleInput) {
			r.Definition.Conditions.Items = []notifyrules.ConditionItem{
				{Condition: &notifyrules.Condition{Field: "e.machine", Op: notifyrules.OpIs, Value: uuid.NewString()}},
			}
		},
	}
	for name, edit := range bad {
		candidate := eventRule("printer_error", "operator")
		candidate.CategoryID = &e.service
		edit(&candidate)
		if _, err := e.rules.CreateRule(ctx, machineAccess, candidate, nil); !apperror.IsCode(err, "validation_failed") {
			t.Errorf("%s: %v", name, err)
		}
	}

	update := eventRule("printer_error", "operator")
	update.CategoryID = &e.service
	update.Name = "Renamed"
	if _, err := e.rules.UpdateRule(ctx, machineAccess, rule.ID, rule.Version+5, update, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale update: %v", err)
	}
	updated, err := e.rules.UpdateRule(ctx, machineAccess, rule.ID, rule.Version, update, nil)
	if err != nil || updated.Version != rule.Version+1 || updated.Name != "Renamed" {
		t.Fatalf("update = %+v, %v", updated, err)
	}
	// Saving the same content again changes nothing, not even the version.
	same, err := e.rules.UpdateRule(ctx, machineAccess, rule.ID, updated.Version, update, nil)
	if err != nil || same.Version != updated.Version {
		t.Fatalf("no-op update = %+v, %v", same, err)
	}
	// A manager who lost machines.read may still edit the rule's name, but not add new hidden things.
	if _, err := e.rules.UpdateRule(ctx, manager, rule.ID, updated.Version, update, nil); err != nil {
		t.Fatalf("keeping existing entries: %v", err)
	}
	if err := e.rules.DeleteRule(ctx, machineAccess, rule.ID, rule.Version, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale delete: %v", err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='notification_rule.updated' AND resource_id=$1`, 1, rule.ID)
}

func TestPersonalSubscriptionsAreIsolatedAndLimitedToWhatTheOwnerMaySee(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	alice := e.person("sub-alice", e.grant(authorization.MachinesRead))
	bob := e.person("sub-bob")
	manager := e.manager()

	own, err := e.rules.CreateSubscription(ctx, alice, eventRule("printer_error", "me"), nil)
	if err != nil || own.OwnerAccountID == nil || *own.OwnerAccountID != alice.AccountID || own.CategoryID != nil {
		t.Fatalf("subscription = %+v, %v", own, err)
	}
	// The category and mandatory flag of a personal rule are ignored, not honored.
	forced := eventRule("printer_error", "me")
	forced.CategoryID, forced.Mandatory = &e.service, true
	second, err := e.rules.CreateSubscription(ctx, alice, forced, nil)
	if err != nil || second.CategoryID != nil || second.Mandatory {
		t.Fatalf("forced subscription = %+v, %v", second, err)
	}

	// Bob sees none of it and cannot touch it.
	if list, err := e.rules.ListSubscriptions(ctx, bob); err != nil || len(list) != 0 {
		t.Fatalf("bob's list = %v, %v", list, err)
	}
	if _, err := e.rules.GetSubscription(ctx, bob, own.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("bob read alice's rule: %v", err)
	}
	if _, err := e.rules.UpdateSubscription(ctx, bob, own.ID, own.Version, eventRule("printer_error", "me"), nil); err == nil {
		t.Fatal("bob updated alice's rule")
	}
	if err := e.rules.DeleteSubscription(ctx, bob, own.ID, own.Version, nil); !apperror.IsCode(err, "not_found") {
		t.Fatalf("bob deleted alice's rule: %v", err)
	}
	// Not even a manager reaches a personal rule through the central endpoints, and the central list leaves it out.
	if _, err := e.rules.GetRule(ctx, manager, own.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("manager read a personal rule: %v", err)
	}
	if err := e.rules.DeleteRule(ctx, manager, own.ID, own.Version, nil); !apperror.IsCode(err, "not_found") {
		t.Fatalf("manager deleted a personal rule: %v", err)
	}
	if central, err := e.rules.ListRules(ctx, manager); err != nil || len(customRules(central)) != 0 {
		t.Fatalf("central list = %v, %v", central, err)
	}
	// ...and a central rule is no subscription.
	centralRule := e.central(manager, "lab_rules_published", "need_confirm")
	if _, err := e.rules.GetSubscription(ctx, alice, centralRule.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("subscription endpoint returned a central rule: %v", err)
	}

	// Trigger visibility: bob lacks machines.read.
	if _, err := e.rules.CreateSubscription(ctx, bob, eventRule("printer_error", "me"), nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("bob subscribed to printer errors: %v", err)
	}
	if _, err := e.rules.CreateSubscription(ctx, bob, eventRule("lab_rules_published", "me"), nil); err != nil {
		t.Fatalf("a trigger without permission requirement: %v", err)
	}
	// Collection visibility: people need people.read.all.
	loop := eventRule("lab_rules_published", "me")
	loop.Definition.Trigger = notifyrules.TriggerDef{
		Type: notifyrules.TriggerSchedule, Schedule: &notifyrules.Schedule{Repeat: notifyrules.RepeatDaily, Time: "09:00"},
	}
	loop.Definition.Loop = &notifyrules.Loop{Collection: "people", Mode: notifyrules.ModeSummary, Filter: notifyrules.ConditionSet{Mode: notifyrules.ModeAll}}
	if _, err := e.rules.CreateSubscription(ctx, bob, loop, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("bob looped over people: %v", err)
	}
	// Personal restrictions.
	other := eventRule("lab_rules_published", "need_confirm")
	if _, err := e.rules.CreateSubscription(ctx, bob, other, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("a personal rule notified others: %v", err)
	}
	signage := eventRule("lab_rules_published")
	signage.Definition.Actions[0] = notifyrules.Action{Channel: notifyrules.ChannelSignage, Title: "x"}
	if _, err := e.rules.CreateSubscription(ctx, bob, signage, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("a personal rule used signage: %v", err)
	}

	// Own rules update, are versioned and delete.
	renamed := eventRule("printer_error", "me")
	renamed.Name = "Renamed"
	if _, err := e.rules.UpdateSubscription(ctx, alice, own.ID, own.Version+1, renamed, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale subscription update: %v", err)
	}
	updated, err := e.rules.UpdateSubscription(ctx, alice, own.ID, own.Version, renamed, nil)
	if err != nil || updated.Name != "Renamed" {
		t.Fatalf("update = %+v, %v", updated, err)
	}
	if err := e.rules.DeleteSubscription(ctx, alice, own.ID, updated.Version, nil); err != nil {
		t.Fatal(err)
	}

	// Rules go with their owner's account.
	e.exec(`DELETE FROM accounts WHERE id=$1`, alice.AccountID)
	assertCount(t, e.pool, `SELECT count(*) FROM notification_rules WHERE owner_account_id IS NOT NULL AND name <> 'Rule on lab_rules_published'`, 0)
}

func TestPersonalSubscriptionLimit(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	alice := e.person("sub-limit")
	for range notifyrules.MaxPersonalRules {
		if _, err := e.rules.CreateSubscription(ctx, alice, eventRule("lab_rules_published", "me"), nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.rules.CreateSubscription(ctx, alice, eventRule("lab_rules_published", "me"), nil); !apperror.IsCode(err, "notification_rule_limit") {
		t.Fatalf("over the limit: %v", err)
	}
}

func TestCatalogHidesEntriesTheCallerMayNotSee(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	plain := e.person("catalog-plain")
	privileged := e.person("catalog-machines", e.grant(authorization.MachinesRead, authorization.OrdersRead))

	hasTrigger := func(view notifyrules.CatalogView, key string) bool {
		for _, trigger := range view.Triggers {
			if trigger.Key == key {
				return true
			}
		}
		return false
	}
	hasCollection := func(view notifyrules.CatalogView, key string) bool {
		for _, collection := range view.Collections {
			if collection.Key == key {
				return true
			}
		}
		return false
	}
	low, err := e.rules.Catalog(ctx, plain)
	if err != nil {
		t.Fatal(err)
	}
	high, err := e.rules.Catalog(ctx, privileged)
	if err != nil {
		t.Fatal(err)
	}
	if hasTrigger(low, "printer_error") || hasCollection(low, "orders") || !hasTrigger(low, "lab_rules_published") {
		t.Errorf("plain catalog shows %d triggers, %d collections", len(low.Triggers), len(low.Collections))
	}
	if !hasTrigger(high, "printer_error") || !hasCollection(high, "orders") || hasCollection(high, "people") {
		t.Errorf("privileged catalog shows %d triggers, %d collections", len(high.Triggers), len(high.Collections))
	}
	// Database options arrive resolved.
	e.exec(`INSERT INTO processes(id,name,integration) VALUES(gen_random_uuid(),'Laser cutting','none')`)
	machines, err := e.rules.Catalog(ctx, privileged)
	if err != nil {
		t.Fatal(err)
	}
	for _, collection := range machines.Collections {
		if collection.Key != "machines" {
			continue
		}
		for _, field := range collection.Fields {
			if field.Key == "process" && (len(field.Options) != 1 || field.Options[0].Label != "Laser cutting") {
				t.Errorf("process options = %+v", field.Options)
			}
		}
	}
}

func TestConsentsPendingFlagAskAgainAndAudit(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	manager := e.manager()
	alice := e.person("consent-alice")

	required, err := e.rules.ConsentRequired(ctx, alice)
	if err != nil || !required {
		t.Fatalf("a new person has unanswered consents: %v, %v", required, err)
	}
	settings, err := e.settings(ctx, alice)
	if err != nil || !settings.ConsentPending || !settings.AskFeedbackAtCheckout || len(settings.Consents) != 3 {
		t.Fatalf("settings = %+v, %v", settings, err)
	}
	if _, err := e.rules.AnswerConsents(
		ctx,
		alice,
		[]notifyrules.ConsentAnswer{{CategoryID: e.service, Granted: true}},
		notifyrules.PlaceApp,
		nil,
		nil,
	); !apperror.IsCode(err, "category_needs_no_consent") {
		t.Fatalf("answered the service category: %v", err)
	}
	if _, err := e.rules.AnswerConsents(
		ctx,
		alice,
		[]notifyrules.ConsentAnswer{{CategoryID: uuid.New(), Granted: true}},
		notifyrules.PlaceApp,
		nil,
		nil,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("answered an unknown category: %v", err)
	}
	if _, err := e.rules.AnswerConsents(
		ctx,
		alice,
		[]notifyrules.ConsentAnswer{{CategoryID: e.news, Granted: true}},
		"elsewhere",
		nil,
		nil,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("unknown place: %v", err)
	}
	answers := []notifyrules.ConsentAnswer{{CategoryID: e.news, Granted: true}, {CategoryID: e.surveys, Granted: false}}
	settings, err = e.rules.AnswerConsents(ctx, alice, answers, notifyrules.PlaceApp, nil, nil)
	if err != nil || settings.ConsentPending {
		t.Fatalf("after answering: %+v, %v", settings, err)
	}
	if required, _ := e.rules.ConsentRequired(ctx, alice); required {
		t.Fatal("consent still required after answering")
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='notification_consent.answered' AND actor_account_id=$1`, 2, alice.AccountID)
	// The same answers again change nothing and write no audit events.
	if _, err := e.rules.AnswerConsents(ctx, alice, answers, notifyrules.PlaceProfile, nil, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='notification_consent.answered' AND actor_account_id=$1`, 2, alice.AccountID)
	assertCount(t, e.pool, `SELECT count(*) FROM notification_consents WHERE person_id=$1 AND place='app'`, 2, alice.PersonID)

	// Asking again makes the answer to the old text pending; the service category cannot ask.
	news, err := e.rules.ListCategories(ctx, manager)
	if err != nil {
		t.Fatal(err)
	}
	var newsCategory notifyrules.Category
	for _, category := range news {
		if category.ID == e.news {
			newsCategory = category
		}
	}
	asked, err := e.rules.UpdateCategory(ctx, manager, e.news, newsCategory.Version, notifyrules.CategoryInput{
		Name: newsCategory.Name, Description: newsCategory.Description, AskAgain: true,
	}, nil)
	if err != nil || asked.TextVersion != newsCategory.TextVersion+1 {
		t.Fatalf("ask again = %+v, %v", asked, err)
	}
	if required, _ := e.rules.ConsentRequired(ctx, alice); !required {
		t.Fatal("asking again did not make the consent pending")
	}
	settings, _ = e.settings(ctx, alice)
	for _, entry := range settings.Consents {
		if entry.Category.ID == e.news && (entry.Current || entry.Granted == nil || !*entry.Granted) {
			t.Errorf("old answer should be kept but not current: %+v", entry)
		}
	}
}

func TestCategoryRulesImmutableServiceAndGuardedDeletion(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	manager := e.manager()

	categories, err := e.rules.ListCategories(ctx, manager)
	if err != nil || len(categories) != 3 || categories[0].Key == nil || *categories[0].Key != "service" || categories[0].Basis != notifyrules.BasisRequired {
		t.Fatalf("seeded categories = %+v, %v", categories, err)
	}
	service := categories[0]
	if _, err := e.rules.UpdateCategory(
		ctx,
		manager,
		service.ID,
		service.Version,
		notifyrules.CategoryInput{Name: "Renamed"},
		nil,
	); !apperror.IsCode(err, "notification_category_protected") {
		t.Fatalf("service update: %v", err)
	}
	if err := e.rules.DeleteCategory(ctx, manager, service.ID, service.Version, nil); !apperror.IsCode(err, "notification_category_protected") {
		t.Fatalf("service delete: %v", err)
	}
	if _, err := e.rules.CreateCategory(
		ctx,
		manager,
		notifyrules.CategoryInput{Name: "service & SAFETY", Basis: notifyrules.BasisConsent},
		nil,
	); !apperror.IsCode(err, "notification_category_exists") {
		t.Fatalf("duplicate name: %v", err)
	}
	if _, err := e.rules.CreateCategory(
		ctx,
		manager,
		notifyrules.CategoryInput{Name: "Odd", Basis: "mandatory"},
		nil,
	); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("unknown basis: %v", err)
	}
	custom, err := e.rules.CreateCategory(
		ctx,
		manager,
		notifyrules.CategoryInput{Name: "Workshops", Description: "Courses", Basis: notifyrules.BasisConsent, Position: 5},
		nil,
	)
	if err != nil || custom.Key != nil || custom.RuleCount != 0 {
		t.Fatalf("custom category = %+v, %v", custom, err)
	}
	if _, err := e.rules.UpdateCategory(
		ctx,
		manager,
		custom.ID,
		custom.Version+1,
		notifyrules.CategoryInput{Name: "Courses"},
		nil,
	); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale category update: %v", err)
	}
	renamed, err := e.rules.UpdateCategory(ctx, manager, custom.ID, custom.Version, notifyrules.CategoryInput{Name: "Courses", Position: 5}, nil)
	if err != nil || renamed.Name != "Courses" || renamed.TextVersion != 1 {
		t.Fatalf("rename = %+v, %v", renamed, err)
	}

	// A category that rules use cannot go; one nobody uses can.
	input := eventRule("lab_rules_published", "need_confirm")
	input.CategoryID = &custom.ID
	rule, err := e.rules.CreateRule(ctx, manager, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.rules.DeleteCategory(ctx, manager, custom.ID, renamed.Version, nil); !apperror.IsCode(err, "notification_category_in_use") {
		t.Fatalf("delete of a used category: %v", err)
	}
	if err := e.rules.DeleteRule(ctx, manager, rule.ID, rule.Version, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.rules.DeleteCategory(ctx, manager, custom.ID, renamed.Version, nil); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"created", "updated", "deleted"} {
		assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action=$1 AND resource_id=$2`, 1, "notification_category."+action, custom.ID)
	}
}

func TestRulePreferencesAndTheRulesThatReachAPerson(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	manager := e.person("pref-manager", e.grant(authorization.NotificationRulesManage, authorization.OpenDaysRead))
	crew := e.role("Print crew", nil)
	member := e.person("pref-member", crew.ID)
	outsider := e.person("pref-outsider")

	roleRule := eventRule("lab_rules_published", "role:"+crew.ID.String())
	roleRule.CategoryID = &e.service
	roleRule.Mandatory = true
	roleRule.Definition.Actions = append(roleRule.Definition.Actions, notifyrules.Action{
		Channel: notifyrules.ChannelEmail, Recipients: []string{"role:" + crew.ID.String()}, Title: "Mail",
	})
	mandatory, err := e.rules.CreateRule(ctx, manager, roleRule, nil)
	if err != nil {
		t.Fatal(err)
	}
	optional := eventRule("period_opens", "staffing_people")
	optional.CategoryID = &e.news
	optional.Name = "Optional"
	optionalRule, err := e.rules.CreateRule(ctx, manager, optional, nil)
	if err != nil {
		t.Fatal(err)
	}
	disabled := eventRule("lab_rules_published", "role:"+crew.ID.String())
	disabled.CategoryID, disabled.Enabled = &e.service, false
	if _, err := e.rules.CreateRule(ctx, manager, disabled, nil); err != nil {
		t.Fatal(err)
	}

	settings, err := e.settings(ctx, member)
	if err != nil || len(settings.Rules) != 1 {
		t.Fatalf("the member is reached by %d rules, %v", len(settings.Rules), err)
	}
	reach := settings.Rules[0]
	if reach.RuleID != mandatory.ID || !reach.Mandatory || len(reach.DefaultChannels) != 2 || len(reach.Why) != 1 ||
		!strings.Contains(reach.Why[0], "Print crew") || reach.BlockedByConsent {
		t.Fatalf("reaching rule = %+v", reach)
	}
	if outsiderSettings, _ := e.settings(ctx, outsider); len(outsiderSettings.Rules) != 0 {
		t.Fatalf("the outsider is reached by %v", outsiderSettings.Rules)
	}

	// A mandatory rule keeps one channel; a normal one may be muted.
	if err := e.rules.SetRulePreference(ctx, member, mandatory.ID, notifyrules.Preference{}); !apperror.IsCode(err, "mandatory_notification") {
		t.Fatalf("muting a mandatory rule: %v", err)
	}
	if err := e.rules.SetRulePreference(ctx, member, mandatory.ID, notifyrules.Preference{Email: true}); err != nil {
		t.Fatal(err)
	}
	settings, _ = e.settings(ctx, member)
	if got := settings.Rules[0].EffectiveChannels; len(got) != 1 || got[0] != notifyrules.ChannelEmail {
		t.Fatalf("effective channels = %v", got)
	}
	if err := e.rules.SetRulePreference(ctx, member, optionalRule.ID, notifyrules.Preference{}); err != nil {
		t.Fatalf("muting a normal rule: %v", err)
	}
	// Personal rules and unknown rules take no choice; choices belong to the account.
	own, err := e.rules.CreateSubscription(ctx, member, eventRule("lab_rules_published", "me"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.rules.SetRulePreference(ctx, member, own.ID, notifyrules.Preference{InApp: true}); !apperror.IsCode(err, "not_found") {
		t.Fatalf("choice for a personal rule: %v", err)
	}
	if err := e.rules.SetRulePreference(ctx, member, uuid.New(), notifyrules.Preference{InApp: true}); !apperror.IsCode(err, "not_found") {
		t.Fatalf("choice for an unknown rule: %v", err)
	}
	if outsiderSettings, _ := e.settings(ctx, outsider); len(outsiderSettings.Rules) != 0 {
		t.Fatal("another account's choice leaked")
	}

	if err := e.rules.SetAskFeedbackAtCheckout(ctx, member, false); err != nil {
		t.Fatal(err)
	}
	if settings, _ = e.settings(ctx, member); settings.AskFeedbackAtCheckout {
		t.Fatal("feedback switch not stored")
	}
	if settings, _ = e.settings(ctx, outsider); !settings.AskFeedbackAtCheckout {
		t.Fatal("feedback switch leaked to another person")
	}

	// Consent categories gate their rules until the person says yes.
	staffing := e.person("pref-staffer", e.membershipRole("supervisor").ID)
	settings, _ = e.settings(ctx, staffing)
	if len(settings.Rules) != 1 || settings.Rules[0].RuleID != optionalRule.ID || !settings.Rules[0].BlockedByConsent {
		t.Fatalf("staffing rules = %+v", settings.Rules)
	}
	if _, err := e.rules.AnswerConsents(
		ctx,
		staffing,
		[]notifyrules.ConsentAnswer{{CategoryID: e.news, Granted: true}},
		notifyrules.PlaceApp,
		nil,
		nil,
	); err != nil {
		t.Fatal(err)
	}
	settings, _ = e.settings(ctx, staffing)
	if settings.Rules[0].BlockedByConsent {
		t.Fatal("rule still blocked after consent")
	}
}

func TestNotificationDataGoesWithPeopleAccountsAndRules(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	alice := e.person("cascade-alice")
	if _, err := e.rules.AnswerConsents(ctx, alice, []notifyrules.ConsentAnswer{{CategoryID: e.news, Granted: true}}, notifyrules.PlaceApp, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.rules.SetAskFeedbackAtCheckout(ctx, alice, false); err != nil {
		t.Fatal(err)
	}
	rule := e.central(e.manager(), "lab_rules_published", "need_confirm")
	firing := uuid.New()
	e.exec(`INSERT INTO notification_firings(id,rule_id,rule_name,trigger_type) VALUES($1,$2,'r','event')`, firing, rule.ID)
	e.exec(`INSERT INTO notification_firing_recipients(id,firing_id,person_id,channel,status,sent_at)
		VALUES(gen_random_uuid(),$1,$2,'in_app','sent',now())`, firing, alice.PersonID)
	e.exec(`INSERT INTO notification_throttle(rule_id,subject_key,last_at) VALUES($1,'x',now())`, rule.ID)
	e.exec(`DELETE FROM people WHERE id=$1`, alice.PersonID)
	assertCount(t, e.pool, `SELECT count(*) FROM notification_consents`, 0)
	assertCount(t, e.pool, `SELECT count(*) FROM person_notification_settings`, 0)
	assertCount(t, e.pool, `SELECT count(*) FROM notification_firing_recipients`, 0)
	e.exec(`DELETE FROM notification_rules WHERE id=$1`, rule.ID)
	assertCount(t, e.pool, `SELECT count(*) FROM notification_firings`, 0)
	assertCount(t, e.pool, `SELECT count(*) FROM notification_throttle`, 0)
}

func TestNotificationRulesOverHTTP(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	const (
		origin   = "http://makerspace.example.test"
		password = "Notification center workshop password 17"
	)
	hash, err := security.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	staff := e.person("http-staff")
	var staffLogin string
	if err := e.pool.QueryRow(ctx, `SELECT identifier_normalized FROM auth_identities WHERE account_id=$1`, staff.AccountID).Scan(&staffLogin); err != nil {
		t.Fatal(err)
	}
	e.exec(`UPDATE password_credentials SET password_hash=$1
		WHERE auth_identity_id IN (SELECT id FROM auth_identities WHERE account_id=$2)`, hash, staff.AccountID)
	baseURL, _ := url.Parse(origin)
	cfg := config.Config{
		PublicBaseURL: baseURL, MakerspaceTimeZone: "Europe/Vienna", SessionCookieName: "makerspace_session",
		CSRFCookieName: "makerspace_csrf", SessionIdleTTL: 6 * time.Hour, SessionAbsoluteTTL: 72 * time.Hour,
		PasswordResetTTL: 30 * time.Minute,
	}
	handler, err := httpapi.NewHandler(e.pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	api := server.URL + "/api/v1"

	anonymous := newCookieClient(t)
	for _, target := range []string{
		"/notification-rules", "/notification-rules/catalog", "/notification-categories", "/me/notifications/settings",
		"/me/notification-subscriptions",
	} {
		response := doJSON(t, anonymous, http.MethodGet, api+target, "", "", nil)
		assertStatus(t, response, http.StatusUnauthorized)
		response.Body.Close()
	}

	client := newCookieClient(t)
	response := doJSON(t, client, http.MethodPost, api+"/auth/login", origin, "", map[string]any{"email": staffLogin, "password": password})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	csrf := cookieValue(t, client, server.URL, cfg.CSRFCookieName)

	// Staff without notification_rules permissions are refused the central endpoints but use their own.
	for _, target := range []string{"/notification-rules", "/notification-categories"} {
		response = doJSON(t, client, http.MethodGet, api+target, "", "", nil)
		assertStatus(t, response, http.StatusForbidden)
		assertNoStoreAndRequestID(t, response)
		response.Body.Close()
	}
	response = doJSON(t, client, http.MethodPost, api+"/notification-rules", origin, csrf, map[string]any{})
	if response.StatusCode == http.StatusCreated {
		t.Fatal("an empty rule was created")
	}
	response.Body.Close()

	response = doJSON(t, client, http.MethodGet, api+"/auth/me", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var me openapi.CurrentUser
	decodeResponse(t, response, &me)
	if me.NotificationConsentRequired == nil || !*me.NotificationConsentRequired {
		t.Fatalf("auth/me consent flag = %v", me.NotificationConsentRequired)
	}

	response = doJSON(t, client, http.MethodGet, api+"/me/notifications/settings", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	assertNoStoreAndRequestID(t, response)
	var settings openapi.NotificationSettings
	decodeResponse(t, response, &settings)
	if !settings.ConsentPending || len(settings.Consents) != 3 {
		t.Fatalf("settings = %+v", settings)
	}
	response = doJSON(t, client, http.MethodPut, api+"/me/notifications/consents", origin, csrf, map[string]any{
		"place": "app",
		"answers": []map[string]any{
			{"categoryId": e.news.String(), "granted": true}, {"categoryId": e.surveys.String(), "granted": false},
		},
	})
	assertStatus(t, response, http.StatusOK)
	settings = openapi.NotificationSettings{}
	decodeResponse(t, response, &settings)
	if settings.ConsentPending {
		t.Fatal("consent still pending")
	}
	response = doJSON(t, client, http.MethodGet, api+"/auth/me", "", "", nil)
	me = openapi.CurrentUser{}
	decodeResponse(t, response, &me)
	if me.NotificationConsentRequired == nil || *me.NotificationConsentRequired {
		t.Fatalf("auth/me consent flag after answering = %v", me.NotificationConsentRequired)
	}

	// A personal subscription over the wire.
	subscription := map[string]any{
		"name": "Lab Rules", "enabled": true,
		"definition": map[string]any{
			"trigger": map[string]any{"type": "event", "event": "lab_rules_published"}, "loop": nil,
			"conditions": map[string]any{"mode": "all", "items": []any{}},
			"actions":    []any{map[string]any{"channel": "in_app", "recipients": []string{"me"}, "title": "New rules"}},
			"escalation": nil, "throttle": nil,
		},
	}
	response = doJSON(t, client, http.MethodPost, api+"/me/notification-subscriptions", origin, csrf, subscription)
	assertStatus(t, response, http.StatusCreated)
	var created openapi.NotificationRule
	decodeResponse(t, response, &created)
	if created.Version != 1 || created.Definition.Actions[0].InApp == nil {
		t.Fatalf("created = %+v", created)
	}
	subscription["definition"].(map[string]any)["actions"].([]any)[0].(map[string]any)["recipients"] = []string{"operator"}
	response = doJSON(t, client, http.MethodPost, api+"/me/notification-subscriptions", origin, csrf, subscription)
	assertStatus(t, response, http.StatusUnprocessableEntity)
	response.Body.Close()
	response = doJSON(t, client, http.MethodGet, api+"/me/notification-subscriptions/"+created.Id.String(), "", "", nil)
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
	subscriptionURL := api + "/me/notification-subscriptions/" + created.Id.String()
	response = doJSON(t, client, http.MethodDelete, subscriptionURL, origin, csrf, map[string]any{"expectedVersion": created.Version + 1})
	assertStatus(t, response, http.StatusConflict)
	response.Body.Close()
	response = doJSON(t, client, http.MethodDelete, subscriptionURL, origin, csrf, map[string]any{"expectedVersion": created.Version})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
}
