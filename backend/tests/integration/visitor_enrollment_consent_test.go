package integration_test

import (
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
	pool     *pgxpool.Pool
	service  *visitor.Service
	notifier *notificationRecorder
	device   uuid.UUID
	context  manageddevices.DeviceContext
}

// newConsentEnrollmentEnv enables enrollment on one kiosk, without Lab Rules, and wires the attendance and consent
// modules like the server does.
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
	notifier := newNotificationRecorder()
	service := visitor.NewService(pool, integrationConfig(t), fileService, labRules, notifier)
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
		Enabled: true, DeviceTypeIDs: []uuid.UUID{deviceType.ID}, ExpectedVersion: 1,
	}, nil); err != nil {
		t.Fatal(err)
	}
	return consentEnrollmentEnv{
		pool: pool, service: service, notifier: notifier, device: device.Device.ID,
		context: manageddevices.DeviceContext{ID: device.Device.ID, DeviceTypeID: deviceType.ID},
	}
}

// begin opens a fresh enrollment context without a verified address.
func (e consentEnrollmentEnv) begin(t *testing.T) visitor.Context {
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

// enrollment opens a context and verifies email on it with the mailed code.
func (e consentEnrollmentEnv) enrollment(t *testing.T, email string) visitor.Context {
	t.Helper()
	ctx := testContext(t)
	enrollment := e.begin(t)
	if err := e.service.SendEmailCode(ctx, enrollment, email, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.service.ConfirmEmail(ctx, enrollment, e.notifier.enrollmentCode(email), nil); err != nil {
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

func submission(first, last string) visitor.SubmissionInput {
	return visitor.SubmissionInput{FirstName: first, LastName: last}
}

func TestVisitorEnrollmentStoresConsentAnswers(t *testing.T) {
	e := newConsentEnrollmentEnv(t)
	ctx := testContext(t)
	news, surveys, service := e.category(t, "news"), e.category(t, "surveys"), e.category(t, "service")

	// A category that needs no consent cannot be answered; nothing of the enrollment is kept.
	refused := submission("Refused", "Visitor")
	refused.Consents = []notifyrules.ConsentAnswer{{CategoryID: service, Granted: true}}
	if _, err := e.service.Submit(ctx, e.enrollment(t, "refused@example.test"), refused, nil); !apperror.IsCode(err, "category_needs_no_consent") {
		t.Fatalf("answering a required category error=%v", err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM people WHERE first_name='Refused'`, 0)

	input := submission("Consenting", "Visitor")
	input.Consents = []notifyrules.ConsentAnswer{{CategoryID: news, Granted: true}, {CategoryID: surveys, Granted: false}}
	result, err := e.service.Submit(ctx, e.enrollment(t, "consenting@example.test"), input, nil)
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
	silent, err := e.service.Submit(ctx, e.enrollment(t, "silent@example.test"), submission("Silent", "Visitor"), nil)
	if err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM notification_consents WHERE person_id=$1`, 0, silent.PersonID)
}
