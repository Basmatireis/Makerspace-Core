package integration_test

import (
	"context"
	"errors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type triggerEnv struct {
	*rulesEnv
	manager authorization.Principal
}

func newTriggerEnv(t *testing.T) *triggerEnv {
	t.Helper()
	e := &triggerEnv{rulesEnv: newRulesEnv(t)}
	e.manager = e.person("trigger-manager", e.grant(
		authorization.NotificationRulesManage, authorization.OpenDaysRead, authorization.AttendanceRead,
		authorization.SurveysRead, authorization.AccountsRead,
	))
	return e
}

// rule creates a central rule on the event that tells the recipients with the given texts.
func (e *triggerEnv) rule(event, title string, recipients ...string) notifyrules.Rule {
	e.t.Helper()
	input := eventRule(event, recipients...)
	input.CategoryID = &e.service
	input.Definition.Actions[0].Title = title
	rule, err := e.rules.CreateRule(testContext(e.t), e.manager, input, nil)
	if err != nil {
		var app *apperror.Error
		if errors.As(err, &app) {
			e.t.Fatalf("create rule on %s: %v", event, app.Details)
		}
		e.t.Fatalf("create rule on %s: %v", event, err)
	}
	return rule
}

// told counts the notifications of a rule that a person's account received.
func (e *triggerEnv) told(personID, rule uuid.UUID) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(testContext(e.t), `SELECT count(*) FROM inbox_recipients r
		JOIN inbox_notifications n ON n.id = r.notification_id
		JOIN accounts a ON a.id = r.account_id
		WHERE a.person_id=$1 AND n.kind='rule' AND n.rule_id=$2`, personID, rule).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *triggerEnv) titles(rule uuid.UUID) []string {
	e.t.Helper()
	rows, err := e.pool.Query(testContext(e.t), `SELECT title FROM inbox_notifications WHERE rule_id=$1 ORDER BY created_at, id`, rule)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var titles []string
	for rows.Next() {
		var title string
		if err = rows.Scan(&title); err != nil {
			e.t.Fatal(err)
		}
		titles = append(titles, title)
	}
	return titles
}

func (e *triggerEnv) inTx(fn func(ctx context.Context, tx pgx.Tx) error) {
	e.t.Helper()
	ctx := testContext(e.t)
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = fn(ctx, tx); err != nil {
		e.t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		e.t.Fatal(err)
	}
}

func TestNotificationTriggerOpenDaySignupTellsThePersonAndTheTeam(t *testing.T) {
	e := newTriggerEnv(t)
	supervisor := e.role("", level(roles.MembershipSupervisor), authorization.OpenDaysRead, authorization.OpenDaysSignup)
	alice, bob := e.person("signup-alice", supervisor.ID), e.person("signup-bob", supervisor.ID)
	day := e.openDay(e.now.Add(5*24*time.Hour), 2*time.Hour, 5, 0)
	rule := e.rule("open_day_signup", "{person} took a {place} in {daysUntil} days", "self", "day_team")

	if _, err := e.opendays.Join(testContext(t), alice, day.id, day.supervisorRequirement, nil); err != nil {
		t.Fatal(err)
	}
	if e.told(alice.PersonID, rule.ID) != 1 || e.told(bob.PersonID, rule.ID) != 0 {
		t.Fatalf("after alice: alice %d, bob %d", e.told(alice.PersonID, rule.ID), e.told(bob.PersonID, rule.ID))
	}
	if _, err := e.opendays.Join(testContext(t), bob, day.id, day.supervisorRequirement, nil); err != nil {
		t.Fatal(err)
	}
	if e.told(alice.PersonID, rule.ID) != 2 || e.told(bob.PersonID, rule.ID) != 1 {
		t.Fatalf("after bob: alice %d (self, then team), bob %d (self only)", e.told(alice.PersonID, rule.ID), e.told(bob.PersonID, rule.ID))
	}
	if titles := e.titles(rule.ID); len(titles) != 2 || !strings.Contains(titles[1], "supervisor place in 4 days") {
		t.Fatalf("titles = %q", titles)
	}
}

func TestNotificationTriggerAccountCreatedTellsTheNewPerson(t *testing.T) {
	e := newTriggerEnv(t)
	admin := e.person("account-admin", e.grant(authorization.AccountsCreate))
	personID := ids.New()
	e.exec(`INSERT INTO people(id,first_name,last_name,email) VALUES($1,'Tobias','Lang','tobias.lang@example.test')`, personID)
	rule := e.rule("account_created", "Welcome {person}", "self")

	service := accounts.NewService(e.pool, config.Config{}, nil).WithNotifications(notifyrules.NewSystemEvents(nil))
	if _, err := service.Create(testContext(t), admin, personID, "tobias.lang@example.test", 1, nil); err != nil {
		t.Fatal(err)
	}
	if e.told(personID, rule.ID) != 1 {
		t.Fatalf("the new person was told %d times", e.told(personID, rule.ID))
	}
	if titles := e.titles(rule.ID); len(titles) != 1 || titles[0] != "Welcome Tobias Lang" {
		t.Fatalf("titles = %q", titles)
	}
}

func (e *triggerEnv) visit(personID uuid.UUID, method string) uuid.UUID {
	e.t.Helper()
	id := ids.New()
	e.exec(`INSERT INTO visits(id,person_id,checked_in_at,status,check_in_method,check_in_assurance,admission_decision)
		VALUES($1,$2,now() - interval '90 minutes','checked_in',$3,'normal','admitted')`, id, personID, method)
	return id
}

func TestNotificationTriggersCheckInAndCheckOutTellThePersonAndTheSupervisorsOnDuty(t *testing.T) {
	e := newTriggerEnv(t)
	supervisorRole := e.membershipRole(roles.MembershipSupervisor)
	visitorRole := e.membershipRole(roles.MembershipVisitor)
	onDuty := e.person("duty-supervisor", supervisorRole.ID)
	absent := e.person("absent-supervisor", supervisorRole.ID)
	arriving := e.person("arriving-visitor", visitorRole.ID)
	e.visit(onDuty.PersonID, "pin")
	checkIn := e.rule("check_in", "{person} arrived {method}", "self", "on_duty")
	checkOut := e.rule("check_out", "{person} left after {stayed}", "self", "on_duty")

	visit := e.visit(arriving.PersonID, "pin")
	events := notifyrules.NewSystemEvents(nil)
	e.inTx(func(ctx context.Context, tx pgx.Tx) error { return events.CheckIn(ctx, tx, visit) })
	if e.told(arriving.PersonID, checkIn.ID) != 1 || e.told(onDuty.PersonID, checkIn.ID) != 1 || e.told(absent.PersonID, checkIn.ID) != 0 {
		t.Fatalf("check-in: arriving %d, on duty %d, absent %d",
			e.told(arriving.PersonID, checkIn.ID), e.told(onDuty.PersonID, checkIn.ID), e.told(absent.PersonID, checkIn.ID))
	}
	if titles := e.titles(checkIn.ID); len(titles) != 1 || !strings.HasSuffix(titles[0], "arrived with their PIN") {
		t.Fatalf("titles = %q", titles)
	}

	e.exec(`UPDATE visits SET status='checked_out', checked_out_at=checked_in_at + interval '90 minutes', check_out_method='pin' WHERE id=$1`, visit)
	e.inTx(func(ctx context.Context, tx pgx.Tx) error { return events.CheckOut(ctx, tx, visit) })
	if e.told(arriving.PersonID, checkOut.ID) != 1 || e.told(onDuty.PersonID, checkOut.ID) != 1 {
		t.Fatalf("check-out: arriving %d, on duty %d", e.told(arriving.PersonID, checkOut.ID), e.told(onDuty.PersonID, checkOut.ID))
	}
	if titles := e.titles(checkOut.ID); len(titles) != 1 || !strings.HasSuffix(titles[0], "left after 1 h 30 min") {
		t.Fatalf("titles = %q", titles)
	}
}

func TestNotificationTriggerSurveyAnsweredNeverCarriesTheRespondent(t *testing.T) {
	e := newTriggerEnv(t)
	readerRole := e.grant(authorization.SurveysRead)
	reader := e.person("survey-reader", readerRole)
	respondent := e.person("survey-respondent")
	var respondentName string
	if err := e.pool.QueryRow(testContext(t), `SELECT first_name || ' ' || last_name FROM people WHERE id=$1`, respondent.PersonID).Scan(&respondentName); err != nil {
		t.Fatal(err)
	}
	surveyID, versionID, questionID, responseID := ids.New(), ids.New(), ids.New(), ids.New()
	e.exec(`INSERT INTO surveys(id,name,anonymous) VALUES($1,'Visit feedback',true)`, surveyID)
	e.exec(`INSERT INTO survey_versions(id,survey_id,revision,title) VALUES($1,$2,1,'Feedback')`, versionID, surveyID)
	e.exec(`INSERT INTO survey_questions(id,survey_version_id,kind,prompt,required,position,rating_min,rating_max)
		VALUES($1,$2,'rating','How was it?',true,1,1,5)`, questionID, versionID)
	e.exec(`INSERT INTO survey_responses(id,survey_version_id,submitted_on) VALUES($1,$2,current_date)`, responseID, versionID)
	e.exec(`INSERT INTO survey_answers(id,response_id,question_id,numeric_value,position) VALUES($1,$2,$3,2,1)`, ids.New(), responseID, questionID)
	rule := e.rule("survey_answered", "{survey}{ratingNote}", "role:"+readerRole.String())

	events := notifyrules.NewSystemEvents(nil)
	e.inTx(func(ctx context.Context, tx pgx.Tx) error { return events.SurveyAnswered(ctx, tx, responseID) })
	if e.told(reader.PersonID, rule.ID) != 1 || e.told(respondent.PersonID, rule.ID) != 0 {
		t.Fatalf("reader %d, respondent %d", e.told(reader.PersonID, rule.ID), e.told(respondent.PersonID, rule.ID))
	}
	titles := e.titles(rule.ID)
	if len(titles) != 1 || titles[0] != "Visit feedback rated 2" {
		t.Fatalf("titles = %q", titles)
	}
	// Nothing the firing stored points to a person but the roles' reader.
	var leaked int
	if err := e.pool.QueryRow(testContext(t), `SELECT count(*) FROM notification_firings f
		WHERE f.rule_id=$1 AND (f.summary ILIKE '%' || $2 || '%')`, rule.ID, respondentName).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatal("the firing summary names the respondent")
	}
	assertCount(t, e.pool, `SELECT count(*) FROM notification_firing_recipients fr JOIN notification_firings f ON f.id = fr.firing_id WHERE f.rule_id=$1`, 1, rule.ID)
}
