package integration_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
)

const settingsOrigin = "http://makerspace.example.test"

// settingsHTTP is an API server and an auth service that share the challenge key, so a code requested through the
// service (whose mails a recorder catches) signs in over HTTP.
type settingsHTTP struct {
	*rulesEnv
	server   *httptest.Server
	auth     *auth.Service
	notifier *notificationRecorder
}

func newSettingsHTTP(t *testing.T) *settingsHTTP {
	t.Helper()
	env := newRulesEnv(t)
	cfg := integrationConfig(t)
	cfg.SessionCookieName, cfg.CSRFCookieName, cfg.MakerspaceTimeZone = "makerspace_session", "makerspace_csrf", "Europe/Vienna"
	cfg.Environment = "test"
	cfg.EncryptionKeys = [][]byte{make([]byte, 32)}
	handler, err := httpapi.NewHandler(env.pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	notifier := newNotificationRecorder()
	service, err := auth.NewService(env.pool, cfg, notifier)
	if err != nil {
		t.Fatal(err)
	}
	return &settingsHTTP{rulesEnv: env, server: server, auth: service, notifier: notifier}
}

func (h *settingsHTTP) do(client *http.Client, method, path string, body any) *http.Response {
	h.t.Helper()
	csrf := ""
	if hasCookie(client, h.server.URL, "makerspace_csrf") {
		csrf = cookieValue(h.t, client, h.server.URL, "makerspace_csrf")
	}
	return doJSON(h.t, client, method, h.server.URL+"/api/v1"+path, settingsOrigin, csrf, body)
}

func (h *settingsHTTP) expect(response *http.Response, status int, code string) {
	h.t.Helper()
	assertStatus(h.t, response, status)
	if code == "" {
		response.Body.Close()
		return
	}
	var failure openapi.Error
	decodeResponse(h.t, response, &failure)
	if failure.Code != code {
		h.t.Fatalf("error code = %q, want %q", failure.Code, code)
	}
}

// codeLogin requests an emailed code for the address and signs in with it over HTTP, with or without a purpose.
func (h *settingsHTTP) codeLogin(client *http.Client, email, purpose string) *http.Response {
	h.t.Helper()
	code := requestLoginCode(h.t, h.auth, h.notifier, email)
	body := map[string]any{"email": email, "code": code}
	if purpose != "" {
		body["purpose"] = purpose
	}
	return h.do(client, http.MethodPost, "/auth/email-code/login", body)
}

func (h *settingsHTTP) me(client *http.Client) openapi.CurrentUser {
	h.t.Helper()
	response := h.do(client, http.MethodGet, "/auth/me", nil)
	assertStatus(h.t, response, http.StatusOK)
	var current openapi.CurrentUser
	decodeResponse(h.t, response, &current)
	return current
}

// passwordClient signs a person in with a password over HTTP.
func (h *settingsHTTP) passwordClient(p authorization.Principal) *http.Client {
	h.t.Helper()
	const password = "Notification settings workshop password 23"
	hash, err := security.HashPassword(password)
	if err != nil {
		h.t.Fatal(err)
	}
	h.exec(`UPDATE password_credentials SET password_hash=$1
		WHERE auth_identity_id IN (SELECT id FROM auth_identities WHERE account_id=$2)`, hash, p.AccountID)
	var login string
	if err := h.pool.QueryRow(testContext(h.t), `SELECT identifier_normalized FROM auth_identities WHERE account_id=$1`,
		p.AccountID).Scan(&login); err != nil {
		h.t.Fatal(err)
	}
	client := newCookieClient(h.t)
	h.expect(h.do(client, http.MethodPost, "/auth/login", map[string]any{"email": login, "password": password}),
		http.StatusNoContent, "")
	return client
}

// visitor seeds a person holding only the Visitor membership role (no web.sign_in) who signs in with emailed codes.
func (h *settingsHTTP) visitor(suffix string) (authorization.Principal, string) {
	h.t.Helper()
	p := h.person(suffix, h.membershipRole("visitor").ID)
	// Seeding a fixture account lets visitors sign in to the web; take that back for this visitor's schema.
	revokeWebSignIn(h.t, h.pool)
	var email string
	if err := h.pool.QueryRow(testContext(h.t),
		`UPDATE auth_identities SET email_code_enabled=true WHERE account_id=$1 AND kind='password'
		 RETURNING identifier_normalized`, p.AccountID).Scan(&email); err != nil {
		h.t.Fatal(err)
	}
	return p, email
}

func TestVisitorGetsASessionRestrictedToNotificationSettingsOnlyWithThePurpose(t *testing.T) {
	h := newSettingsHTTP(t)
	manager := h.person("ns-manager", h.grant(authorization.NotificationRulesManage))
	visitor, email := h.visitor("ns-visitor")
	input := eventRule("lab_rules_published", "role:"+h.membershipRole("visitor").ID.String())
	input.CategoryID = &h.service
	rule, err := h.rules.CreateRule(testContext(t), manager, input, nil)
	if err != nil {
		t.Fatal(err)
	}

	// Without the purpose the visitor is refused as before.
	client := newCookieClient(t)
	h.expect(h.codeLogin(client, email, ""), http.StatusForbidden, auth.WebSignInNotPermittedCode)
	h.expect(h.do(client, http.MethodGet, "/auth/me", nil), http.StatusUnauthorized, "unauthenticated")

	h.expect(h.codeLogin(client, email, "notification_settings"), http.StatusNoContent, "")
	current := h.me(client)
	if restriction, err := current.Session.Restriction.Get(); err != nil ||
		restriction != openapi.SessionRestrictionNotificationSettings {
		t.Fatalf("session restriction = %v, %v", restriction, err)
	}
	if len(current.Permissions) != 0 || current.Person.Id != visitor.PersonID {
		t.Fatalf("restricted session reports permissions %v for %s", current.Permissions, current.Person.Id)
	}
	assertCount(t, h.pool, `SELECT count(*) FROM sessions WHERE account_id=$1 AND restriction='notification_settings'`, 1,
		visitor.AccountID)
	assertCount(t, h.pool, `SELECT count(*) FROM audit_events WHERE action='auth.email_code_login_succeeded'
		AND resource_id=$1 AND metadata->>'restriction'='notification_settings'`, 1, visitor.AccountID)

	// The own notification settings work.
	response := h.do(client, http.MethodGet, "/me/notifications/settings", nil)
	assertStatus(t, response, http.StatusOK)
	var settings openapi.NotificationSettings
	decodeResponse(t, response, &settings)
	reached := false
	for _, reaching := range settings.Rules {
		reached = reached || reaching.RuleId == rule.ID
	}
	if !reached {
		t.Fatalf("the visitor rule does not reach the visitor: %+v", settings.Rules)
	}
	h.expect(h.do(client, http.MethodPut, "/me/notifications/rules/"+rule.ID.String()+"/preference",
		map[string]any{"inApp": false, "email": true}), http.StatusNoContent, "")
	h.expect(h.do(client, http.MethodPut, "/me/notifications/feedback-at-checkout", map[string]any{"ask": false}),
		http.StatusNoContent, "")
	h.expect(h.do(client, http.MethodPut, "/me/notifications/consents", map[string]any{
		"place": "app", "answers": []map[string]any{{"categoryId": h.news.String(), "granted": true}},
	}), http.StatusOK, "")
	assertCount(t, h.pool, `SELECT count(*) FROM notification_rule_preferences WHERE account_id=$1 AND rule_id=$2
		AND email AND NOT in_app`, 1, visitor.AccountID, rule.ID)
	assertCount(t, h.pool, `SELECT count(*) FROM audit_events WHERE action='notification_preference.changed'
		AND actor_account_id=$1 AND metadata->>'personId'=$2`, 1, visitor.AccountID, visitor.PersonID.String())
	assertCount(t, h.pool, `SELECT count(*) FROM audit_events WHERE action='notification_feedback_at_checkout.changed'
		AND resource_id=$1`, 1, visitor.PersonID)
	// The same values again change nothing and are not audited.
	h.expect(h.do(client, http.MethodPut, "/me/notifications/rules/"+rule.ID.String()+"/preference",
		map[string]any{"inApp": false, "email": true}), http.StatusNoContent, "")
	h.expect(h.do(client, http.MethodPut, "/me/notifications/feedback-at-checkout", map[string]any{"ask": false}),
		http.StatusNoContent, "")
	assertCount(t, h.pool, `SELECT count(*) FROM audit_events WHERE action IN
		('notification_preference.changed','notification_feedback_at_checkout.changed') AND actor_account_id=$1`, 2,
		visitor.AccountID)

	// Everything else is refused, including what could widen the session.
	for _, call := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/people", nil},
		{http.MethodGet, "/people/" + visitor.PersonID.String(), nil},
		{http.MethodGet, "/me/dashboard", nil},
		{http.MethodGet, "/me/notification-subscriptions", nil},
		{http.MethodGet, "/people/" + visitor.PersonID.String() + "/notification-settings", nil},
		{http.MethodPost, "/auth/reauthenticate", map[string]any{"password": "Some workshop password 12"}},
		{http.MethodPost, "/auth/second-factors/totp/enrollment", nil},
		{http.MethodPut, "/auth/methods/email-code", nil},
	} {
		h.expect(h.do(client, call.method, call.path, call.body), http.StatusForbidden, auth.RestrictedSessionCode)
	}

	// Keeping the session alive reports the restriction; signing out works.
	response = h.do(client, http.MethodPost, "/auth/activity", nil)
	assertStatus(t, response, http.StatusOK)
	var activity openapi.SessionContext
	decodeResponse(t, response, &activity)
	if restriction, err := activity.Restriction.Get(); err != nil ||
		restriction != openapi.SessionRestrictionNotificationSettings {
		t.Fatalf("activity restriction = %v, %v", restriction, err)
	}
	h.expect(h.do(client, http.MethodPost, "/auth/logout", nil), http.StatusNoContent, "")
	h.expect(h.do(client, http.MethodGet, "/me/notifications/settings", nil), http.StatusUnauthorized, "unauthenticated")
}

func TestAccountWithWebSignInIgnoresTheNotificationSettingsPurpose(t *testing.T) {
	h := newSettingsHTTP(t)
	member := h.person("ns-member", h.membershipRole("supervisor").ID)
	var email string
	if err := h.pool.QueryRow(testContext(t),
		`UPDATE auth_identities SET email_code_enabled=true WHERE account_id=$1 AND kind='password'
		 RETURNING identifier_normalized`, member.AccountID).Scan(&email); err != nil {
		t.Fatal(err)
	}
	client := newCookieClient(t)
	h.expect(h.codeLogin(client, email, "notification_settings"), http.StatusNoContent, "")
	current := h.me(client)
	if !current.Session.Restriction.IsNull() || len(current.Permissions) == 0 {
		t.Fatalf("full account got restriction %v and permissions %v", current.Session.Restriction, current.Permissions)
	}
	h.expect(h.do(client, http.MethodGet, "/me/notification-subscriptions", nil), http.StatusOK, "")
	assertCount(t, h.pool, `SELECT count(*) FROM audit_events WHERE action='auth.email_code_login_succeeded'
		AND resource_id=$1 AND metadata ? 'restriction'`, 0, member.AccountID)
}

func TestRestrictedSignInPassesTheSecondFactorAndStaysRestricted(t *testing.T) {
	h := newSettingsHTTP(t)
	ctx := testContext(t)
	visitor, email := h.visitor("ns-totp")
	secret := []byte("12345678901234567890")
	if err := h.auth.EnrollFixtureTOTP(ctx, visitor.AccountID, secret); err != nil {
		t.Fatal(err)
	}
	if _, err := h.auth.LoginWithEmailCodeForPurpose(
		ctx, email, requestLoginCode(t, h.auth, h.notifier, email), "203.0.113.90", "", nil,
	); !apperror.IsCode(err, auth.WebSignInNotPermittedCode) {
		t.Fatalf("second-factor visitor without purpose: %v", err)
	}
	result, err := h.auth.LoginWithEmailCodeForPurpose(
		ctx, email, requestLoginCode(t, h.auth, h.notifier, email), "203.0.113.90",
		auth.RestrictionNotificationSettings, nil,
	)
	if err != nil || result.Pending == nil {
		t.Fatalf("restricted sign-in with a second factor: %+v %v", result, err)
	}
	totp := security.HOTP(secret, uint64(security.TOTPStep(time.Now())), security.TOTPDigits)
	session, err := h.auth.CompleteSecondFactorLogin(ctx, result.Pending.Token, auth.SecondFactorTOTP, totp, nil)
	if err != nil {
		t.Fatal(err)
	}
	authenticated, err := h.auth.Authenticate(ctx, session.Token)
	if err != nil || authenticated.Restriction != auth.RestrictionNotificationSettings ||
		authenticated.Principal.Has(authorization.WebSignIn) {
		t.Fatalf("completed restricted sign-in: %+v %v", authenticated.Restriction, err)
	}

	// Gaining web.sign_in later does not widen a restricted session; the restriction stays on the session row.
	allowVisitorWebSignIn(t, h.pool)
	if authenticated, err = h.auth.Authenticate(ctx, session.Token); err != nil ||
		authenticated.Restriction != auth.RestrictionNotificationSettings || len(authenticated.Principal.PermissionIDs()) != 0 {
		t.Fatalf("restricted session after gaining web.sign_in: %+v %v", authenticated.Restriction, err)
	}
}

func TestStaffReadAndChangeAnotherPersonsNotificationSettings(t *testing.T) {
	h := newSettingsHTTP(t)
	ctx := testContext(t)
	manager := h.person("ns-rules", h.grant(authorization.NotificationRulesManage))
	crew := h.role("Settings crew", nil)
	target := h.person("ns-target", crew.ID)
	optional := eventRule("lab_rules_published", "role:"+crew.ID.String())
	optional.CategoryID = &h.service
	rule, err := h.rules.CreateRule(ctx, manager, optional, nil)
	if err != nil {
		t.Fatal(err)
	}
	mandatoryInput := eventRule("lab_rules_published", "role:"+crew.ID.String())
	mandatoryInput.CategoryID, mandatoryInput.Mandatory, mandatoryInput.Name = &h.service, true, "Mandatory"
	mandatory, err := h.rules.CreateRule(ctx, manager, mandatoryInput, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.rules.AnswerConsents(ctx, target,
		[]notifyrules.ConsentAnswer{{CategoryID: h.news, Granted: true}}, notifyrules.PlaceApp, nil, nil); err != nil {
		t.Fatal(err)
	}
	noAccount := ids.New()
	h.exec(`INSERT INTO people(id,first_name,last_name,email) VALUES($1,'No','Account','no-account@example.test')`, noAccount)

	// The Supervisor membership role holds both permissions by migration.
	supervisor := h.passwordClient(h.person("ns-supervisor", h.membershipRole("supervisor").ID))
	reader := h.passwordClient(h.person("ns-reader", h.membershipRole("trainee").ID,
		h.grant(authorization.NotificationSettingsReadAll)))
	nobody := h.passwordClient(h.person("ns-nobody", h.membershipRole("trainee").ID))
	base := "/people/" + target.PersonID.String() + "/notification-settings"

	response := h.do(supervisor, http.MethodGet, base, nil)
	assertStatus(t, response, http.StatusOK)
	var view openapi.PersonNotificationSettings
	decodeResponse(t, response, &view)
	if !view.HasAccount || view.PersonId != target.PersonID {
		t.Fatalf("staff view = %+v", view)
	}
	found := map[uuid.UUID]bool{}
	for _, reaching := range view.Settings.Rules {
		found[reaching.RuleId] = true
	}
	granted := false
	for _, consent := range view.Settings.Consents {
		if consent.CategoryId == h.news {
			value, _ := consent.Granted.Get()
			granted = value
		}
	}
	if !found[rule.ID] || !found[mandatory.ID] || !granted {
		t.Fatalf("staff view lacks the rules or the consent: %+v", view.Settings)
	}
	response = h.do(reader, http.MethodGet, base, nil)
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
	h.expect(h.do(nobody, http.MethodGet, base, nil), http.StatusForbidden, "permission_denied")
	h.expect(h.do(supervisor, http.MethodGet, "/people/"+ids.New().String()+"/notification-settings", nil),
		http.StatusNotFound, "not_found")

	// Changing needs manage.all; the rules of the person's own choice apply.
	preference := base + "/rules/" + rule.ID.String() + "/preference"
	h.expect(h.do(reader, http.MethodPut, preference, map[string]any{"inApp": false, "email": false}),
		http.StatusForbidden, "permission_denied")
	h.expect(h.do(nobody, http.MethodPut, base+"/feedback-at-checkout", map[string]any{"ask": false}),
		http.StatusForbidden, "permission_denied")
	h.expect(h.do(supervisor, http.MethodPut, base+"/rules/"+mandatory.ID.String()+"/preference",
		map[string]any{"inApp": false, "email": false}), http.StatusUnprocessableEntity, "mandatory_notification")
	h.expect(h.do(supervisor, http.MethodPut, base+"/rules/"+ids.New().String()+"/preference",
		map[string]any{"inApp": true, "email": false}), http.StatusNotFound, "not_found")
	h.expect(h.do(supervisor, http.MethodPut, preference, map[string]any{"inApp": false, "email": false}),
		http.StatusNoContent, "")
	h.expect(h.do(supervisor, http.MethodPut, base+"/feedback-at-checkout", map[string]any{"ask": false}),
		http.StatusNoContent, "")
	assertCount(t, h.pool, `SELECT count(*) FROM notification_rule_preferences WHERE account_id=$1 AND rule_id=$2
		AND NOT in_app AND NOT email`, 1, target.AccountID, rule.ID)
	assertCount(t, h.pool, `SELECT count(*) FROM person_notification_settings WHERE person_id=$1
		AND NOT ask_feedback_at_checkout`, 1, target.PersonID)
	assertCount(t, h.pool, `SELECT count(*) FROM audit_events WHERE action IN
		('notification_preference.changed','notification_feedback_at_checkout.changed')
		AND metadata->>'personId'=$1 AND actor_account_id <> $2`, 2, target.PersonID.String(), target.AccountID)

	// A person without an account has no channel choices, but a feedback switch.
	response = h.do(supervisor, http.MethodGet, "/people/"+noAccount.String()+"/notification-settings", nil)
	assertStatus(t, response, http.StatusOK)
	view = openapi.PersonNotificationSettings{}
	decodeResponse(t, response, &view)
	if view.HasAccount || len(view.Settings.Rules) != 0 {
		t.Fatalf("person without an account = %+v", view)
	}
	h.expect(h.do(supervisor, http.MethodPut, "/people/"+noAccount.String()+"/notification-settings/rules/"+
		rule.ID.String()+"/preference", map[string]any{"inApp": true, "email": true}),
		http.StatusConflict, notifyrules.PersonHasNoAccountCode)
	h.expect(h.do(supervisor, http.MethodPut, "/people/"+noAccount.String()+"/notification-settings/feedback-at-checkout",
		map[string]any{"ask": false}), http.StatusNoContent, "")
}

func TestNotificationSettingsChangesRaiseOneEventPerSave(t *testing.T) {
	e := newTriggerEnv(t)
	ctx := testContext(t)
	e.manager = e.person("ns-trigger-manager", e.grant(
		authorization.NotificationRulesManage, authorization.NotificationSettingsReadAll,
	))
	input := eventRule("notification_settings_changed", "self")
	input.CategoryID = &e.service
	input.Definition.Actions[0].Title = "{person} by {by}"
	input.Definition.Actions[0].Body = "{changes}"
	rule, err := e.rules.CreateRule(ctx, e.manager, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	staffRule := eventRule("notification_settings_changed", "self")
	staffRule.CategoryID = &e.service
	staffRule.Name = "Changed by staff"
	staffRule.Definition.Conditions.Items = []notifyrules.ConditionItem{
		{Condition: &notifyrules.Condition{Field: "e.bySelf", Op: notifyrules.OpNo}},
	}
	byStaff, err := e.rules.CreateRule(ctx, e.manager, staffRule, nil)
	if err != nil {
		t.Fatal(err)
	}
	person := e.person("ns-trigger-person")
	staff := e.person("ns-trigger-staff", e.grant(authorization.NotificationSettingsManageAll))

	if _, err := e.rules.AnswerConsents(ctx, person, []notifyrules.ConsentAnswer{
		{CategoryID: e.news, Granted: true}, {CategoryID: e.surveys, Granted: false},
	}, notifyrules.PlaceApp, nil, nil); err != nil {
		t.Fatal(err)
	}
	if e.told(person.PersonID, rule.ID) != 1 || e.told(person.PersonID, byStaff.ID) != 0 {
		t.Fatalf("one save must raise one event: told %d", e.told(person.PersonID, rule.ID))
	}
	var title, body string
	if err := e.pool.QueryRow(ctx, `SELECT title, body FROM inbox_notifications WHERE rule_id=$1`, rule.ID).
		Scan(&title, &body); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(body, "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "Consent \"") || !strings.HasSuffix(lines[0], "\": granted") ||
		!strings.HasSuffix(lines[1], "\": withdrawn") {
		t.Fatalf("changes are not one line each: %q", body)
	}
	if title != "Test Person by Test Person" {
		t.Fatalf("title %q", title)
	}

	// The same answers again change nothing.
	if _, err := e.rules.AnswerConsents(ctx, person, []notifyrules.ConsentAnswer{{CategoryID: e.news, Granted: true}},
		notifyrules.PlaceApp, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.rules.SetPersonAskFeedbackAtCheckout(ctx, staff, person.PersonID, false, nil); err != nil {
		t.Fatal(err)
	}
	if e.told(person.PersonID, rule.ID) != 2 || e.told(person.PersonID, byStaff.ID) != 1 {
		t.Fatalf("staff change: told %d/%d", e.told(person.PersonID, rule.ID), e.told(person.PersonID, byStaff.ID))
	}
	if err := e.pool.QueryRow(ctx, `SELECT body FROM inbox_notifications WHERE rule_id=$1 ORDER BY created_at DESC, id DESC
		LIMIT 1`, rule.ID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if body != "Feedback at check-out: off" {
		t.Fatalf("staff change body %q", body)
	}

	// Answers given while enrolling are the person's first ones and stay quiet.
	newcomer := e.person("ns-trigger-newcomer")
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.rules.AnswerConsentsTx(ctx, tx, newcomer, []notifyrules.ConsentAnswer{{CategoryID: e.news, Granted: true}},
		notifyrules.PlaceKiosk, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if e.told(newcomer.PersonID, rule.ID) != 0 {
		t.Fatal("enrolment answers raised notification_settings_changed")
	}
}

// settingsMailer records which notification mails link the notification settings.
type settingsMailer struct{ links map[string]bool }

func (m *settingsMailer) SendNotice(_ context.Context, to, _, _, _ string, settingsLink bool) error {
	m.links[to] = settingsLink
	return nil
}

func TestStaffChangesRespectMastersRuleReachAndRuleVisibility(t *testing.T) {
	h := newSettingsHTTP(t)
	ctx := testContext(t)
	manager := h.person("ns-reach-manager", h.grant(authorization.NotificationRulesManage))
	crew := h.role("Reach crew", nil)
	target := h.person("ns-reach-target", crew.ID)
	outsider := h.person("ns-reach-outsider")
	input := eventRule("lab_rules_published", "role:"+crew.ID.String())
	input.CategoryID, input.Description = &h.service, "What the crew is told"
	rule, err := h.rules.CreateRule(ctx, manager, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	staff := h.person("ns-reach-staff", h.membershipRole("supervisor").ID)

	// A rule that does not reach the person takes no choice, for staff and for the person alike.
	if err := h.rules.SetPersonRulePreference(ctx, staff, outsider.PersonID, rule.ID, notifyrules.Preference{}, nil); !apperror.IsCode(
		err, "not_found",
	) {
		t.Fatalf("staff choice for a rule that does not reach the person: %v", err)
	}
	if err := h.rules.SetRulePreference(ctx, outsider, rule.ID, notifyrules.Preference{Email: true}, nil); !apperror.IsCode(
		err, "not_found",
	) {
		t.Fatalf("own choice for a rule that does not reach the person: %v", err)
	}
	if err := h.rules.SetPersonRulePreference(ctx, staff, target.PersonID, rule.ID, notifyrules.Preference{}, nil); err != nil {
		t.Fatal(err)
	}

	// Only a master changes a master's settings.
	masterAccount := seedAccount(t, h.pool, "ns-reach-master", true)
	if err := h.rules.SetPersonAskFeedbackAtCheckout(ctx, staff, masterAccount.personID, false, nil); !apperror.IsCode(
		err, "permission_denied",
	) {
		t.Fatalf("staff changed a master's feedback switch: %v", err)
	}
	if err := h.rules.SetPersonRulePreference(ctx, staff, masterAccount.personID, rule.ID, notifyrules.Preference{}, nil); !apperror.IsCode(
		err, "permission_denied",
	) {
		t.Fatalf("staff changed a master's channels: %v", err)
	}
	master, err := authorization.LoadPermissionsFrom(ctx, h.pool, authorization.Principal{
		AccountID: masterAccount.accountID, PersonID: masterAccount.personID, Assurance: authorization.AssuranceStrongMFA,
		AuthenticatedAt: time.Now().UTC(),
	})
	if err != nil || !master.Master {
		t.Fatalf("master principal: %v", err)
	}
	other := seedAccount(t, h.pool, "ns-reach-master-2", true)
	if err := h.rules.SetPersonAskFeedbackAtCheckout(ctx, master, other.personID, false, nil); err != nil {
		t.Fatalf("a master changing another master's switch: %v", err)
	}
	assertCount(t, h.pool, `SELECT count(*) FROM audit_events WHERE action='notification_feedback_at_checkout.changed'
		AND resource_id=$1`, 0, masterAccount.personID)

	// Staff who may not read the central rules see that a rule reaches the person, but not what it says.
	view, err := h.rules.PersonSettings(ctx, staff, target.PersonID)
	if err != nil {
		t.Fatal(err)
	}
	reader := h.person("ns-reach-reader", h.grant(authorization.NotificationSettingsReadAll, authorization.NotificationRulesRead))
	full, err := h.rules.PersonSettings(ctx, reader, target.PersonID)
	if err != nil {
		t.Fatal(err)
	}
	find := func(rules []notifyrules.ReachingRule) notifyrules.ReachingRule {
		for _, reaching := range rules {
			if reaching.RuleID == rule.ID {
				return reaching
			}
		}
		t.Fatalf("rule %s missing from %+v", rule.ID, rules)
		return notifyrules.ReachingRule{}
	}
	redacted, shown := find(view.Settings.Rules), find(full.Settings.Rules)
	if redacted.Description != "" || redacted.TriggerSummary != "" || redacted.Name == "" || redacted.CategoryName == "" ||
		len(redacted.Why) == 0 || len(redacted.DefaultChannels) == 0 {
		t.Fatalf("redacted rule = %+v", redacted)
	}
	if shown.Description != "What the crew is told" || shown.TriggerSummary == "" {
		t.Fatalf("rule for a rules reader = %+v", shown)
	}
}

func TestLowAssuranceStaffSessionsOnlyReadOtherPeoplesSettings(t *testing.T) {
	h := newSettingsHTTP(t)
	ctx := testContext(t)
	target := h.person("ns-pin-target")
	_, _, login := webSignInAccount(t, h.pool, "ns-pin-staff", h.membershipRole("supervisor").ID)
	session, err := h.auth.LoginWithPIN(ctx, login, "246810", "203.0.113.91", nil)
	if err != nil {
		t.Fatal(err)
	}
	authenticated, err := h.auth.Authenticate(ctx, session.Token)
	if err != nil {
		t.Fatal(err)
	}
	pin := authenticated.Principal
	if pin.Assurance != authorization.AssuranceLow {
		t.Fatalf("PIN session assurance = %s", pin.Assurance)
	}
	if _, err := h.rules.PersonSettings(ctx, pin, target.PersonID); err != nil {
		t.Fatalf("PIN session reading another person's settings: %v", err)
	}
	if err := h.rules.SetPersonAskFeedbackAtCheckout(ctx, pin, target.PersonID, false, nil); !apperror.IsCode(
		err, "permission_denied",
	) {
		t.Fatalf("PIN session changed another person's settings: %v", err)
	}
}

func TestNotificationSettingsTriggerLimitsChannelsRecipientsAndSubscribers(t *testing.T) {
	e := newTriggerEnv(t)
	ctx := testContext(t)
	// Rule managers see the trigger only with its permission.
	e.manager = e.person("ns-limit-manager", e.grant(
		authorization.NotificationRulesManage, authorization.NotificationSettingsReadAll,
	))

	signage := eventRule("notification_settings_changed", "self")
	signage.CategoryID = &e.service
	signage.Definition.Actions[0].Channel = notifyrules.ChannelSignage
	if _, err := e.rules.CreateRule(ctx, e.manager, signage, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("a signage action on notification_settings_changed: %v", err)
	}
	// A personal subscription needs the trigger's permission.
	plain := e.person("ns-limit-plain")
	if _, err := e.rules.CreateSubscription(ctx, plain, eventRule("notification_settings_changed", "me"), nil); err == nil {
		t.Fatal("a person without notification_settings.read.all subscribed to everyone's settings changes")
	}
	watcher := e.person("ns-limit-watcher", e.grant(authorization.NotificationSettingsReadAll))
	if _, err := e.rules.CreateSubscription(ctx, watcher, eventRule("notification_settings_changed", "me"), nil); err != nil {
		t.Fatalf("subscription with notification_settings.read.all: %v", err)
	}

	// A central rule telling a role reaches only the role's members who may see everyone's settings.
	crew := e.role("Settings watchers", nil)
	allowed := e.person("ns-limit-allowed", crew.ID, e.grant(authorization.NotificationSettingsReadAll))
	blind := e.person("ns-limit-blind", crew.ID)
	input := eventRule("notification_settings_changed", "self", "role:"+crew.ID.String())
	input.CategoryID = &e.service
	rule, err := e.rules.CreateRule(ctx, e.manager, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	person := e.person("ns-limit-person")
	if err := e.rules.SetAskFeedbackAtCheckout(ctx, person, false, nil); err != nil {
		t.Fatal(err)
	}
	if e.told(person.PersonID, rule.ID) != 1 || e.told(allowed.PersonID, rule.ID) != 1 || e.told(blind.PersonID, rule.ID) != 0 {
		t.Fatalf("told person %d, allowed %d, blind %d", e.told(person.PersonID, rule.ID),
			e.told(allowed.PersonID, rule.ID), e.told(blind.PersonID, rule.ID))
	}
	assertCount(t, e.pool, `SELECT count(*) FROM inbox_notifications WHERE rule_id=$1 AND link='/notification-settings'`, 1,
		rule.ID)
}

func TestNotificationMailsLinkTheSettingsOnlyForPeopleWhoCanSignIn(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	member := e.person("ns-mail-member")
	withoutAccount := ids.New()
	e.exec(`INSERT INTO people(id,first_name,last_name,email) VALUES($1,'No','Account','ns-mail-none@example.test')`,
		withoutAccount)
	organization := ids.New()
	e.exec(`INSERT INTO organizations(id,name,kind,contact_email) VALUES($1,'Lab Partner','company','office@example.test')`,
		organization)
	var memberEmail string
	if err := e.pool.QueryRow(ctx, `SELECT email FROM people WHERE id=$1`, member.PersonID).Scan(&memberEmail); err != nil {
		t.Fatal(err)
	}
	for _, recipient := range []struct{ person, organization *uuid.UUID }{
		{person: &member.PersonID}, {person: &withoutAccount}, {organization: &organization},
	} {
		e.exec(`INSERT INTO notification_mail_outbox(id,kind,person_id,organization_id,subject,body)
			VALUES($1,'rule',$2,$3,'Print finished','Ready')`, ids.New(), recipient.person, recipient.organization)
	}
	mailer := &settingsMailer{links: map[string]bool{}}
	if sent, err := inbox.NewMailDelivery(e.pool, mailer).Deliver(ctx, inbox.MailDeliveryBatch); err != nil || sent != 3 {
		t.Fatalf("delivered %d, %v", sent, err)
	}
	if !mailer.links[memberEmail] || mailer.links["ns-mail-none@example.test"] || mailer.links["office@example.test"] {
		t.Fatalf("settings links = %v", mailer.links)
	}
}

func TestRestrictedSessionEdgeCases(t *testing.T) {
	h := newSettingsHTTP(t)
	ctx := testContext(t)

	// An account that must set up a second factor is not also confined to that setup in a restricted session.
	mfaVisitor, mfaEmail := h.visitor("ns-edge-mfa")
	role := ids.New()
	h.exec(`INSERT INTO roles(id,name) VALUES($1,'Strong grant');
		INSERT INTO role_permission_grants(id,role_id,permission_id,minimum_assurance) VALUES(uuidv7(),$1,'audit.read','strong_mfa');
		INSERT INTO person_roles(person_id,role_id) VALUES($2,$1)`, role, mfaVisitor.PersonID)
	client := newCookieClient(t)
	h.expect(h.codeLogin(client, mfaEmail, "notification_settings"), http.StatusNoContent, "")
	if current := h.me(client); current.Authentication.MfaSetupRequired || !current.Authentication.MfaRequired {
		t.Fatalf("restricted session authentication = %+v", current.Authentication)
	}
	h.expect(h.do(client, http.MethodGet, "/me/notifications/settings", nil), http.StatusOK, "")

	// The CSRF check applies to restricted sessions as to any other.
	response := doJSON(t, client, http.MethodPut, h.server.URL+"/api/v1/me/notifications/feedback-at-checkout",
		settingsOrigin, "", map[string]any{"ask": false})
	h.expect(response, http.StatusForbidden, "csrf_invalid")

	// A disabled account's restricted session stops working.
	h.exec(`UPDATE accounts SET status='disabled' WHERE id=$1`, mfaVisitor.AccountID)
	h.expect(h.do(client, http.MethodGet, "/me/notifications/settings", nil), http.StatusUnauthorized, "unauthenticated")

	// A restricted sign-in waiting for its second factor becomes a normal session when the account gained
	// web.sign_in meanwhile: the purpose only ever stands in for a missing right.
	visitor, email := h.visitor("ns-edge-gain")
	secret := []byte("12345678901234567890")
	if err := h.auth.EnrollFixtureTOTP(ctx, visitor.AccountID, secret); err != nil {
		t.Fatal(err)
	}
	result, err := h.auth.LoginWithEmailCodeForPurpose(
		ctx, email, requestLoginCode(t, h.auth, h.notifier, email), "203.0.113.92",
		auth.RestrictionNotificationSettings, nil,
	)
	if err != nil || result.Pending == nil {
		t.Fatalf("restricted pending sign-in: %+v %v", result, err)
	}
	allowVisitorWebSignIn(t, h.pool)
	totp := security.HOTP(secret, uint64(security.TOTPStep(time.Now())), security.TOTPDigits)
	session, err := h.auth.CompleteSecondFactorLogin(ctx, result.Pending.Token, auth.SecondFactorTOTP, totp, nil)
	if err != nil {
		t.Fatal(err)
	}
	authenticated, err := h.auth.Authenticate(ctx, session.Token)
	if err != nil || authenticated.Restriction != "" || !authenticated.Principal.Has(authorization.WebSignIn) {
		t.Fatalf("second factor after gaining web.sign_in: restriction %q, %v", authenticated.Restriction, err)
	}
}
