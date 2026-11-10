package integration_test

import (
	"net/http"
	"regexp"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type consentEnrollmentEnv struct {
	pool    *pgxpool.Pool
	service *visitor.Service
	device  uuid.UUID
	context manageddevices.DeviceContext
}

// newConsentEnrollmentEnv enables PIN and password enrollment on one kiosk, without Lab Rules, and wires the
// attendance and consent modules like the server does.
func newConsentEnrollmentEnv(t *testing.T) consentEnrollmentEnv {
	t.Helper()
	pool := migratedPool(t)
	ctx := testContext(t)
	actor := seedAccount(t, pool, "enroll-consent-admin", true)
	master := authorization.Principal{AccountID: actor.accountID, PersonID: actor.personID, Master: true}
	local, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := files.NewService(pool, local)
	labRules := laborordnung.NewService(pool, notifyrules.NewSystemEvents(nil), fileService)
	service := visitor.NewService(pool, integrationConfig(t), fileService, labRules, nil)
	service.SetAttendance(attendance.NewService(pool, nil, labRules, nil))
	service.SetConsents(notifyrules.NewService(pool))
	if _, err = pool.Exec(ctx, `UPDATE roles SET laborordnung_mode='not_required' WHERE system_key='visitor'`); err != nil {
		t.Fatal(err)
	}
	devices := manageddevices.NewService(pool)
	deviceType, err := devices.CreateType(ctx, master, "Consent terminal", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := devices.Create(ctx, master, "Consent terminal", deviceType.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.UpdateConfiguration(ctx, master, visitor.ConfigurationInput{
		Enabled: true, DeviceTypeIDs: []uuid.UUID{deviceType.ID},
		AllowedMethods: []visitor.AuthMethod{"pin", "password"}, ExpectedVersion: 1,
	}, nil); err != nil {
		t.Fatal(err)
	}
	return consentEnrollmentEnv{
		pool: pool, service: service, device: device.Device.ID,
		context: manageddevices.DeviceContext{ID: device.Device.ID, DeviceTypeID: deviceType.ID},
	}
}

func (e consentEnrollmentEnv) enrollment(t *testing.T) visitor.Context {
	t.Helper()
	ctx := testContext(t)
	issue, err := e.service.Begin(ctx, e.context)
	if err != nil {
		t.Fatal(err)
	}
	enrollment, err := e.service.AuthenticateContext(ctx, issue.ContextToken)
	if err != nil {
		t.Fatal(err)
	}
	return enrollment
}

func (e consentEnrollmentEnv) category(t *testing.T, key string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := e.pool.QueryRow(testContext(t), `SELECT id FROM notification_categories WHERE key=$1`, key).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func pinSubmission(first, last, email, login string) visitor.SubmissionInput {
	pin := "654321"
	return visitor.SubmissionInput{
		FirstName: first, LastName: last, Email: email,
		AuthMethods: []visitor.AuthMethod{"pin"}, PINLoginName: &login, PIN: &pin,
	}
}

func TestVisitorEnrollmentStoresConsentAnswers(t *testing.T) {
	e := newConsentEnrollmentEnv(t)
	ctx := testContext(t)
	news, surveys, service := e.category(t, "news"), e.category(t, "surveys"), e.category(t, "service")

	// A category that needs no consent cannot be answered; nothing of the enrollment is kept.
	refused := pinSubmission("Refused", "Visitor", "refused@example.test", "refused.visitor")
	refused.Consents = []notifyrules.ConsentAnswer{{CategoryID: service, Granted: true}}
	if _, err := e.service.Submit(ctx, e.enrollment(t), refused, nil); !apperror.IsCode(err, "category_needs_no_consent") {
		t.Fatalf("answering a required category error=%v", err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM people WHERE first_name='Refused'`, 0)

	input := pinSubmission("Consenting", "Visitor", "consenting@example.test", "consenting.visitor")
	input.Consents = []notifyrules.ConsentAnswer{{CategoryID: news, Granted: true}, {CategoryID: surveys, Granted: false}}
	result, err := e.service.Submit(ctx, e.enrollment(t), input, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `
		SELECT count(*) FROM notification_consents
		WHERE person_id=$1 AND place='kiosk' AND device_id=$2
		  AND ((category_id=$3 AND granted) OR (category_id=$4 AND NOT granted))`,
		2, result.PersonID, e.device, news, surveys)
	assertCount(t, e.pool, `
		SELECT count(*) FROM audit_events WHERE action='notification_consent.answered' AND actor_account_id=$1`,
		2, result.AccountID)
	pending, err := notifyrules.NewService(e.pool).PendingConsents(ctx, result.PersonID)
	if err != nil || len(pending) != 0 {
		t.Fatalf("pending consents after enrollment=%#v err=%v, want none", pending, err)
	}

	// Answering nothing is allowed: the check-in asks again later.
	silent, err := e.service.Submit(ctx, e.enrollment(t), pinSubmission("Silent", "Visitor", "silent@example.test", "silent.visitor"), nil)
	if err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM notification_consents WHERE person_id=$1`, 0, silent.PersonID)
}

func TestVisitorEnrollmentRequiresEmail(t *testing.T) {
	e := newConsentEnrollmentEnv(t)
	ctx := testContext(t)
	for _, email := range []string{"", "  ", "not-an-address"} {
		_, err := e.service.Submit(ctx, e.enrollment(t), pinSubmission("Mailless", "Visitor", email, "mailless.visitor"), nil)
		if !apperror.IsCode(err, "validation_failed") {
			t.Fatalf("email %q error=%v, want validation_failed", email, err)
		}
	}
	assertCount(t, e.pool, `SELECT count(*) FROM people WHERE first_name='Mailless'`, 0)
}

func TestVisitorLoginNameSuggestion(t *testing.T) {
	e := newConsentEnrollmentEnv(t)
	ctx := testContext(t)
	enrollment := e.enrollment(t)

	suggested, err := e.service.SuggestLoginName(ctx, enrollment, " Jonas ", "Weiß")
	if err != nil || suggested != "jonas.weiss" {
		t.Fatalf("suggestion=%q err=%v, want jonas.weiss", suggested, err)
	}
	if _, err = e.service.Submit(ctx, e.enrollment(t), pinSubmission("Jonas", "Weiß", "jonas@example.test", "Jonas.Weiss"), nil); err != nil {
		t.Fatal(err)
	}
	// Taken names are compared case-insensitively, like logins.
	suggested, err = e.service.SuggestLoginName(ctx, enrollment, "Jonas", "Weiss")
	if err != nil || !regexp.MustCompile(`^jonas\.weiss[0-9]+$`).MatchString(suggested) {
		t.Fatalf("suggestion for a taken name=%q err=%v, want jonas.weiss with a number", suggested, err)
	}
	if _, err = e.service.SuggestLoginName(ctx, enrollment, "李", "王"); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("suggestion without usable characters error=%v, want validation_failed", err)
	}
}

func TestVisitorLoginNameSuggestionOnlyWhenPINIsAllowed(t *testing.T) {
	e := newConsentEnrollmentEnv(t)
	ctx := testContext(t)
	enrollment := e.enrollment(t)
	if _, err := e.pool.Exec(ctx, `UPDATE visitor_enrollment_configuration SET allowed_methods=ARRAY['password']`); err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.SuggestLoginName(ctx, enrollment, "Jonas", "Weiss"); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("suggestion without PIN enrollment error=%v, want permission_denied", err)
	}
}

func TestVisitorLoginNameSuggestionNeedsAnEnrollingKiosk(t *testing.T) {
	e := newSignageEnv(t)
	body := map[string]any{"firstName": "Jonas", "lastName": "Weiss"}
	// Without a registered kiosk there is no enrollment context to suggest a name in.
	e.expectCode(
		e.do(
			newCookieClient(t), "", http.MethodPost, "/visitor-enrollment/login-name-suggestions", body,
			"X-Enrollment-CSRF-Token", "not-a-real-enrollment-csrf-token",
		),
		http.StatusNotFound, "not_found",
	)
}
