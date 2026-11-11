package integration_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/google/uuid"
)

// identityVerifier accepts every credential and answers with the person registered for the login.
type identityVerifier struct {
	noEmailCodes
	people map[string]seededAccount
}

func (v identityVerifier) verify(email string) (auth.VerifiedIdentity, error) {
	account, ok := v.people[email]
	if !ok {
		return auth.VerifiedIdentity{}, apperror.Unauthenticated
	}
	return auth.VerifiedIdentity{
		AccountID: account.accountID, PersonID: account.personID, Method: "password", Assurance: authorization.AssuranceNormal,
	}, nil
}

func (v identityVerifier) VerifyPasswordForAttendance(_ context.Context, email, _, _ string) (auth.VerifiedIdentity, error) {
	return v.verify(email)
}

func (v identityVerifier) VerifyPINForAttendance(_ context.Context, login, _, _ string) (auth.VerifiedIdentity, error) {
	return v.verify(login)
}

type checkoutEnv struct {
	*surveyEnv
	ctx        context.Context
	attendance *attendance.Service
	verifier   identityVerifier
	logins     map[uuid.UUID]string
	devices    *manageddevices.Service
	principal  authorization.Principal
	device     manageddevices.ProvisionedDevice
	survey     surveys.Survey
	trigger    surveys.Trigger
}

// newCheckoutEnv builds a kiosk that offers surveys and a published survey whose trigger asks at the tablet.
func newCheckoutEnv(t *testing.T, anonymous bool) *checkoutEnv {
	t.Helper()
	base := newSurveyEnv(t)
	ctx := testContext(t)
	e := &checkoutEnv{surveyEnv: base, ctx: ctx, verifier: identityVerifier{people: map[string]seededAccount{}}, logins: map[uuid.UUID]string{}}
	e.attendance = attendance.NewService(base.pool, e.verifier, nil, base.svc)
	e.devices = manageddevices.NewService(base.pool)
	e.principal = authorization.Principal{AccountID: base.account.accountID, PersonID: base.account.personID, Master: true}
	e.device = e.newDevice("Entrance tablet", true, false)
	e.survey = base.published(conditionalSurveyInput("Visit feedback", anonymous))
	trigger, err := base.svc.UpdateTrigger(ctx, base.master, e.survey.ID, true, 1800, 30, ptr(true), 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	e.trigger = trigger
	return e
}

func (e *checkoutEnv) newDevice(name string, offerSurveys, allowTap bool) manageddevices.ProvisionedDevice {
	e.t.Helper()
	deviceType, err := e.devices.CreateType(e.ctx, e.principal, name+" type", nil, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	var policyID uuid.UUID
	if err = e.pool.QueryRow(e.ctx, `SELECT id FROM session_policies WHERE name='Entrance terminal'`).Scan(&policyID); err != nil {
		e.t.Fatal(err)
	}
	device, err := e.devices.CreateConfigured(e.ctx, e.principal, name, deviceType.ID, nil, manageddevices.DeviceSettings{
		SessionPolicyID: &policyID, KioskEnabled: true,
		AllowedApplicationModes: []manageddevices.ApplicationMode{"visitor_terminal"},
		CheckInMethods:          manageddevices.AllKioskMethods, CheckOutMethods: manageddevices.AllKioskMethods,
		OfferSurveysAtCheckout: offerSurveys,
		AllowTapCheckout:       allowTap, KioskResetSeconds: 60,
	}, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	return device
}

func (e *checkoutEnv) setTrigger(askAtTablet bool) {
	e.t.Helper()
	trigger, err := e.svc.UpdateTrigger(e.ctx, e.master, e.survey.ID, true, 1800, 30, &askAtTablet, e.trigger.Version, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	e.trigger = trigger
}

// person registers a visitor who is checked in at the given tablet; consent decides the Surveys & feedback answer.
func (e *checkoutEnv) person(suffix string, consent bool, deviceID uuid.UUID) (seededAccount, uuid.UUID) {
	e.t.Helper()
	account := seedAccount(e.t, e.pool, "checkout-"+suffix, false)
	login := "checkout-" + suffix + "@example.test"
	e.verifier.people[login] = account
	e.logins[account.personID] = login
	if consent {
		e.consent(account.personID, true, 0)
	}
	return account, e.checkIn(account, deviceID)
}

func (e *checkoutEnv) consent(personID uuid.UUID, granted bool, versionOffset int) {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx, `
		INSERT INTO notification_consents (person_id, category_id, granted, text_version, answered_at, place)
		SELECT $1, id, $2, text_version + $3, now(), 'app' FROM notification_categories WHERE key = 'surveys'
		ON CONFLICT (person_id, category_id) DO UPDATE SET granted = EXCLUDED.granted, text_version = EXCLUDED.text_version`,
		personID, granted, versionOffset); err != nil {
		e.t.Fatal(err)
	}
}

func (e *checkoutEnv) checkIn(account seededAccount, deviceID uuid.UUID) uuid.UUID {
	e.t.Helper()
	visitID := ids.New()
	if _, err := e.pool.Exec(e.ctx, `
		INSERT INTO visits (id, person_id, checked_in_at, check_in_device_id, check_in_method, check_in_assurance,
		  admission_decision, checked_in_by_account_id)
		VALUES ($1, $2, now() - interval '1 minute', $3, 'password', 'normal', 'admitted', $4)`,
		visitID, account.personID, deviceID, account.accountID); err != nil {
		e.t.Fatal(err)
	}
	return visitID
}

// selfCheckOut checks the person out with their password at the tablet.
func (e *checkoutEnv) selfCheckOut(account seededAccount, device manageddevices.ProvisionedDevice) attendance.Visit {
	e.t.Helper()
	visit, err := e.attendance.PasswordCheckOut(
		e.ctx, manageddevices.DeviceContext{ID: device.Device.ID}, e.logins[account.personID], "secret", "test", nil,
	)
	if err != nil {
		e.t.Fatalf("self check-out: %v", err)
	}
	return visit
}

func (e *checkoutEnv) deviceContext(device manageddevices.ProvisionedDevice) manageddevices.DeviceContext {
	return manageddevices.DeviceContext{ID: device.Device.ID}
}

func (e *checkoutEnv) count(query string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(e.ctx, query, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func TestSurveyIsOfferedOnlyAfterASelfCheckOutThatQualifies(t *testing.T) {
	e := newCheckoutEnv(t, true)

	a, _ := e.person("a", true, e.device.Device.ID)
	visit := e.selfCheckOut(a, e.device)
	offer := visit.SurveyOffer
	if offer == nil {
		t.Fatal("no survey offered after a self check-out on an enabled tablet")
	}
	if offer.SurveyName != "Visit feedback" || offer.QuestionCount != 3 || !offer.Anonymous || !offer.CanAnswerNow ||
		!offer.CanSendByEmail || len(offer.Token) != 43 {
		t.Fatalf("offer = %+v", offer)
	}
	if remaining := time.Until(offer.ExpiresAt); remaining < 14*time.Minute || remaining > 15*time.Minute+time.Second {
		t.Fatalf("offer expires in %s", remaining)
	}
	if e.count(`SELECT count(*) FROM survey_offers WHERE token_digest = $1`, security.DigestToken(offer.Token)) != 1 ||
		e.count(`SELECT count(*) FROM survey_offers WHERE token_digest = $1`, []byte(offer.Token)) != 0 {
		t.Fatal("the offer must be stored by digest only")
	}
	// The automatic e-mail waits until the offer has run out.
	if e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1 AND status = 'pending' AND due_at >= $2`,
		a.personID, offer.ExpiresAt.Add(-time.Second)) != 1 ||
		e.count(`SELECT count(*) FROM survey_invitations WHERE visit_id = $1`, visit.ID) != 0 {
		t.Fatal("the automatic invitation was not postponed behind the offer")
	}

	// Within the cooldown the same person is not asked again.
	e.checkIn(a, e.device.Device.ID)
	if second := e.selfCheckOut(a, e.device); second.SurveyOffer != nil {
		t.Fatal("offered again within the cooldown")
	}

	// A tablet that does not offer surveys.
	plain := e.newDevice("Plain tablet", false, true)
	b, _ := e.person("b", true, plain.Device.ID)
	if visit = e.selfCheckOut(b, plain); visit.SurveyOffer != nil {
		t.Fatal("offered on a tablet with offerSurveysAtCheckout off")
	}

	// A person who switched the question off.
	c, _ := e.person("c", true, e.device.Device.ID)
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO person_notification_settings (person_id, ask_feedback_at_checkout) VALUES ($1, false)`,
		c.personID); err != nil {
		t.Fatal(err)
	}
	if visit = e.selfCheckOut(c, e.device); visit.SurveyOffer != nil {
		t.Fatal("offered although the person turned feedback at check-out off")
	}

	// A supervisor's check-out is not at a tablet. (Tapping a name offers an anonymous survey, tested below.)
	_, f := e.person("f", true, e.device.Device.ID)
	supervised, err := e.attendance.SupervisedCheckOut(e.ctx, e.supervisor(), f, nil)
	if err != nil || supervised.SurveyOffer != nil {
		t.Fatalf("supervised check-out: %+v, %v", supervised, err)
	}

	// The trigger does not ask at the tablet.
	e.setTrigger(false)
	g, _ := e.person("g", true, e.device.Device.ID)
	if visit = e.selfCheckOut(g, e.device); visit.SurveyOffer != nil {
		t.Fatal("offered although the trigger does not ask at the tablet")
	}
	e.setTrigger(true)
	h, _ := e.person("h", true, e.device.Device.ID)
	if visit = e.selfCheckOut(h, e.device); visit.SurveyOffer == nil {
		t.Fatal("not offered after the trigger asks at the tablet again")
	}
}

func TestOfferedAnonymousSurveyStoresNoPersonAndConsumesTheOffer(t *testing.T) {
	e := newCheckoutEnv(t, true)
	other := e.newDevice("Other tablet", true, false)
	a, _ := e.person("anon", true, e.device.Device.ID)
	visit := e.selfCheckOut(a, e.device)
	token := visit.SurveyOffer.Token

	if _, err := e.svc.OfferedSurvey(e.ctx, other.Device.ID, token); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("offer read on another tablet: %v", err)
	}
	if err := e.svc.SubmitOffered(e.ctx, other.Device.ID, token, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("offer submitted on another tablet: %v", err)
	}
	survey, err := e.svc.OfferedSurvey(e.ctx, e.device.Device.ID, token)
	if err != nil || len(survey.Questions) != 3 || !survey.Anonymous {
		t.Fatalf("survey = %+v, %v", survey, err)
	}
	// Reading does not consume; invalid answers do not either.
	if err = e.svc.SubmitOffered(e.ctx, e.device.Device.ID, token, nil); appCode(err) == "" {
		t.Fatalf("empty answers accepted: %v", err)
	}
	answers := []surveys.AnswerInput{answerChoice(survey.Questions[0], "No")}
	if err = e.svc.SubmitOffered(e.ctx, e.device.Device.ID, token, answers); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM survey_responses WHERE identified_person_id IS NULL`) != 1 ||
		e.count(`SELECT count(*) FROM survey_responses`) != 1 {
		t.Fatal("anonymous response is missing or carries a person")
	}
	if e.count(`SELECT count(*) FROM survey_offers WHERE consumed_at IS NOT NULL AND visit_id IS NULL`) != 1 {
		t.Fatal("the offer keeps its link to the visit after use")
	}
	if e.count(`SELECT count(*) FROM survey_invitations WHERE status = 'cancelled' AND person_id IS NULL AND visit_id IS NULL`) != 1 ||
		e.count(`SELECT count(*) FROM survey_invitations WHERE status <> 'cancelled'`) != 0 {
		t.Fatal("the automatic invitation of the visit was not cancelled")
	}
	if err = e.svc.SubmitOffered(e.ctx, e.device.Device.ID, token, answers); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("second submission: %v", err)
	}
	if _, err = e.svc.OfferedSurvey(e.ctx, e.device.Device.ID, token); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("read after use: %v", err)
	}
}

func TestOfferedIdentifiedSurveyLinksTheResponseToThePerson(t *testing.T) {
	e := newCheckoutEnv(t, false)
	a, _ := e.person("ident", true, e.device.Device.ID)
	visit := e.selfCheckOut(a, e.device)
	survey, err := e.svc.OfferedSurvey(e.ctx, e.device.Device.ID, visit.SurveyOffer.Token)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.svc.SubmitOffered(e.ctx, e.device.Device.ID, visit.SurveyOffer.Token,
		[]surveys.AnswerInput{answerChoice(survey.Questions[0], "No")}); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM survey_responses WHERE identified_person_id = $1`, a.personID) != 1 {
		t.Fatal("identified response is not linked to the person")
	}
}

// mailConsent tells the tablet whether the survey reaches the person by e-mail anyway; an answer on the tablet then
// keeps that e-mail from following, for anonymous and identified surveys alike.
func TestAnsweringTheOfferAtTheTabletKeepsTheSurveyOutOfTheMailbox(t *testing.T) {
	for _, anonymous := range []bool{true, false} {
		e := newCheckoutEnv(t, anonymous)
		without, _ := e.person("noconsent", false, e.device.Device.ID)
		if offer := e.selfCheckOut(without, e.device).SurveyOffer; offer == nil || offer.MailConsent || !offer.CanSendByEmail {
			t.Fatalf("offer without consent = %+v", offer)
		}
		a, _ := e.person("answers", true, e.device.Device.ID)
		offer := e.selfCheckOut(a, e.device).SurveyOffer
		if offer == nil || !offer.MailConsent || !offer.CanStopAsking || offer.Anonymous != anonymous {
			t.Fatalf("offer with consent = %+v", offer)
		}
		survey, err := e.svc.OfferedSurvey(e.ctx, e.device.Device.ID, offer.Token)
		if err != nil {
			t.Fatal(err)
		}
		if err = e.svc.SubmitOffered(e.ctx, e.device.Device.ID, offer.Token,
			[]surveys.AnswerInput{answerChoice(survey.Questions[0], "No")}); err != nil {
			t.Fatal(err)
		}
		if e.count(`SELECT count(*) FROM survey_invitations WHERE status <> 'cancelled' OR person_id IS NOT NULL
			OR recipient_email IS NOT NULL`) != 0 {
			t.Fatal("the invitation of the answered survey is still deliverable")
		}
		if sent := e.deliver(); sent != 0 {
			t.Fatalf("%d survey e-mails followed an answer on the tablet (anonymous=%v)", sent, anonymous)
		}
	}
}

func TestSendingTheOfferByEmailWorksWithoutConsentAndLeavesConsentAlone(t *testing.T) {
	e := newCheckoutEnv(t, true)
	a, _ := e.person("mail", false, e.device.Device.ID)
	visit := e.selfCheckOut(a, e.device)
	if visit.SurveyOffer == nil || !visit.SurveyOffer.CanSendByEmail {
		t.Fatalf("offer = %+v", visit.SurveyOffer)
	}
	// Without the consent no automatic invitation exists.
	if e.count(`SELECT count(*) FROM survey_invitations`) != 0 {
		t.Fatal("automatic invitation created without consent")
	}
	if err := e.svc.SendOfferedByEmail(e.ctx, e.device.Device.ID, visit.SurveyOffer.Token, nil); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM survey_invitations WHERE visit_id <> $1 AND person_id = $2 AND status = 'pending'
		AND due_at <= now() AND recipient_email = 'checkout-mail@example.test'`, visit.ID, a.personID) != 1 {
		t.Fatal("the invitation is not due right away")
	}
	if e.count(`SELECT count(*) FROM notification_consents WHERE person_id = $1`, a.personID) != 0 {
		t.Fatal("sending the survey changed the person's consent")
	}
	if e.count(`SELECT count(*) FROM audit_events WHERE action = 'survey_offer.email_requested'`) != 1 {
		t.Fatal("missing audit event")
	}
	if err := e.svc.SendOfferedByEmail(e.ctx, e.device.Device.ID, visit.SurveyOffer.Token, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("second request: %v", err)
	}

	// With consent the postponed automatic invitation becomes due now instead of a second one appearing.
	b, _ := e.person("mail2", true, e.device.Device.ID)
	second := e.selfCheckOut(b, e.device)
	if err := e.svc.SendOfferedByEmail(e.ctx, e.device.Device.ID, second.SurveyOffer.Token, nil); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1 AND due_at <= now()`, b.personID) != 1 ||
		e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1`, b.personID) != 1 {
		t.Fatal("the existing invitation was not brought forward")
	}

	// A person without an e-mail address cannot receive it; the offer stays usable.
	c, _ := e.person("noemail", true, e.device.Device.ID)
	if _, err := e.pool.Exec(e.ctx, `UPDATE people SET email = NULL, phone = '+43 1 234' WHERE id = $1`, c.personID); err != nil {
		t.Fatal(err)
	}
	third := e.selfCheckOut(c, e.device)
	if third.SurveyOffer == nil || third.SurveyOffer.CanSendByEmail {
		t.Fatalf("offer without e-mail = %+v", third.SurveyOffer)
	}
	if err := e.svc.SendOfferedByEmail(e.ctx, e.device.Device.ID, third.SurveyOffer.Token, nil); appCode(err) != "no_email" {
		t.Fatalf("send without e-mail: %v", err)
	}
	if _, err := e.svc.OfferedSurvey(e.ctx, e.device.Device.ID, third.SurveyOffer.Token); err != nil {
		t.Fatalf("offer lost after a refused send: %v", err)
	}
}

func TestDecliningAndNeverAskingEndTheOfferAndStartTheCooldown(t *testing.T) {
	e := newCheckoutEnv(t, true)
	a, _ := e.person("no", true, e.device.Device.ID)
	visit := e.selfCheckOut(a, e.device)
	if err := e.svc.DeclineOffered(e.ctx, e.device.Device.ID, visit.SurveyOffer.Token, false, nil); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM survey_invitations WHERE status = 'cancelled'`) != 1 ||
		e.count(`SELECT count(*) FROM survey_ask_cooldowns WHERE person_id = $1`, a.personID) != 1 ||
		e.count(`SELECT count(*) FROM person_notification_settings WHERE person_id = $1 AND NOT ask_feedback_at_checkout`, a.personID) != 0 {
		t.Fatal("decline did not cancel the invitation and keep the choice")
	}
	if err := e.svc.DeclineOffered(e.ctx, e.device.Device.ID, visit.SurveyOffer.Token, false, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("second decline: %v", err)
	}
	e.checkIn(a, e.device.Device.ID)
	if again := e.selfCheckOut(a, e.device); again.SurveyOffer != nil {
		t.Fatal("asked again within the cooldown after declining")
	}

	// Never: the person's choice turns off, and the next survey is not offered either.
	b, _ := e.person("never", true, e.device.Device.ID)
	second := e.selfCheckOut(b, e.device)
	if err := e.svc.DeclineOffered(e.ctx, e.device.Device.ID, second.SurveyOffer.Token, true, nil); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM person_notification_settings WHERE person_id = $1 AND NOT ask_feedback_at_checkout`, b.personID) != 1 ||
		e.count(`SELECT count(*) FROM audit_events WHERE action = 'survey_offer.never'`) != 1 {
		t.Fatal("never did not switch the question off")
	}
	e.checkIn(b, e.device.Device.ID)
	if again := e.selfCheckOut(b, e.device); again.SurveyOffer != nil {
		t.Fatal("asked again after never")
	}
}

func TestOfferTokensExpireAndBelongToOneTablet(t *testing.T) {
	e := newCheckoutEnv(t, true)
	other := e.newDevice("Other tablet", true, false)
	a, _ := e.person("exp", true, e.device.Device.ID)
	token := e.selfCheckOut(a, e.device).SurveyOffer.Token
	for name, call := range map[string]func(uuid.UUID) error{
		"answer-now": func(d uuid.UUID) error { _, err := e.svc.OfferedSurvey(e.ctx, d, token); return err },
		"responses":  func(d uuid.UUID) error { return e.svc.SubmitOffered(e.ctx, d, token, nil) },
		"send-email": func(d uuid.UUID) error { return e.svc.SendOfferedByEmail(e.ctx, d, token, nil) },
		"decline":    func(d uuid.UUID) error { return e.svc.DeclineOffered(e.ctx, d, token, false, nil) },
		"never":      func(d uuid.UUID) error { return e.svc.DeclineOffered(e.ctx, d, token, true, nil) },
	} {
		if err := call(other.Device.ID); !errors.Is(err, apperror.NotFound) {
			t.Fatalf("%s on another tablet: %v", name, err)
		}
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE survey_offers SET expires_at = now() - interval '1 minute'`); err != nil {
		t.Fatal(err)
	}
	for name, call := range map[string]func(uuid.UUID) error{
		"answer-now": func(d uuid.UUID) error { _, err := e.svc.OfferedSurvey(e.ctx, d, token); return err },
		"responses":  func(d uuid.UUID) error { return e.svc.SubmitOffered(e.ctx, d, token, nil) },
		"send-email": func(d uuid.UUID) error { return e.svc.SendOfferedByEmail(e.ctx, d, token, nil) },
		"decline":    func(d uuid.UUID) error { return e.svc.DeclineOffered(e.ctx, d, token, false, nil) },
		"never":      func(d uuid.UUID) error { return e.svc.DeclineOffered(e.ctx, d, token, true, nil) },
	} {
		if err := call(e.device.Device.ID); !errors.Is(err, apperror.NotFound) {
			t.Fatalf("%s after expiry: %v", name, err)
		}
	}
	// Expired offers disappear a day later, with the next offer.
	if _, err := e.pool.Exec(e.ctx, `UPDATE survey_offers SET expires_at = now() - interval '2 days'`); err != nil {
		t.Fatal(err)
	}
	b, _ := e.person("exp2", true, e.device.Device.ID)
	if e.selfCheckOut(b, e.device).SurveyOffer == nil || e.count(`SELECT count(*) FROM survey_offers`) != 1 {
		t.Fatal("expired offers were not cleaned up")
	}
}

func TestAutomaticInvitationNeedsTheSurveysConsent(t *testing.T) {
	e := newCheckoutEnv(t, true)
	plain := e.newDevice("No-offer tablet", false, false)
	cases := []struct {
		name    string
		prepare func(personID uuid.UUID)
		want    int
	}{
		{"never answered", func(uuid.UUID) {}, 0},
		{"granted", func(p uuid.UUID) { e.consent(p, true, 0) }, 1},
		{"withdrawn", func(p uuid.UUID) { e.consent(p, false, 0) }, 0},
		{"granted for an older text", func(p uuid.UUID) { e.consent(p, true, -1) }, 0},
	}
	// The current text version is 1, so "older" needs a version bump first.
	if _, err := e.pool.Exec(e.ctx, `UPDATE notification_categories SET text_version = 2 WHERE key = 'surveys'`); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		account, _ := e.person(fmt.Sprintf("auto%d", i), false, plain.Device.ID)
		c.prepare(account.personID)
		visit := e.selfCheckOut(account, plain)
		if visit.SurveyOffer != nil {
			t.Fatalf("%s: offered on a tablet that does not offer", c.name)
		}
		if got := e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1`, account.personID); got != c.want {
			t.Fatalf("%s: %d automatic invitations, want %d", c.name, got, c.want)
		}
	}
}

func TestTapCheckOutNeedsTheSwitchAndIdentifiedCheckOutAlwaysWorks(t *testing.T) {
	e := newCheckoutEnv(t, true)
	plain := e.newDevice("Identified only", false, false)
	a, visitID := e.person("tap1", false, plain.Device.ID)
	if _, err := e.attendance.PublicCheckOut(e.ctx, e.deviceContext(plain), visitID, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("tap check-out without the switch: %v", err)
	}
	if visit := e.selfCheckOut(a, plain); visit.CheckOutMethod == nil || *visit.CheckOutMethod != "password" {
		t.Fatalf("identified check-out: %+v", visit)
	}
	b, bVisit := e.person("tap2", false, plain.Device.ID)
	if _, err := e.pool.Exec(e.ctx, `UPDATE managed_devices SET allow_tap_checkout = true WHERE id = $1`, plain.Device.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.attendance.PublicCheckOut(e.ctx, e.deviceContext(plain), bVisit, nil); err != nil {
		t.Fatalf("tap check-out with the switch: %v", err)
	}
	c, _ := e.person("tap3", false, plain.Device.ID)
	if visit := e.selfCheckOut(c, plain); visit.CheckOutMethod == nil {
		t.Fatal("identified check-out refused on a tablet that allows tapping")
	}
	_ = b

	kiosk, err := e.attendance.KioskContext(e.ctx, e.deviceContext(plain))
	if err != nil || !kiosk.AllowTapCheckout || kiosk.OfferSurveysAtCheckout || kiosk.KioskResetSeconds != 60 {
		t.Fatalf("kiosk context = %+v, %v", kiosk, err)
	}
}

func TestDeviceSettingsValidateTheResetTimeAndMigrateTapCheckOut(t *testing.T) {
	e := newCheckoutEnv(t, true)
	device := e.device.Device
	for _, seconds := range []int32{14, 601} {
		_, err := e.devices.UpdateConfigured(e.ctx, e.principal, device.ID, device.Name, device.DeviceTypeID, nil,
			manageddevices.DeviceSettings{
				SessionPolicyID: device.SessionPolicyID, KioskEnabled: true,
				AllowedApplicationModes: []manageddevices.ApplicationMode{"visitor_terminal"},
				CheckInMethods:          manageddevices.AllKioskMethods, CheckOutMethods: manageddevices.AllKioskMethods,
				KioskResetSeconds: seconds,
			}, device.Version, nil)
		if err == nil {
			t.Fatalf("reset time %d accepted: %v", seconds, err)
		}
	}
	updated, err := e.devices.UpdateConfigured(e.ctx, e.principal, device.ID, device.Name, device.DeviceTypeID, nil,
		manageddevices.DeviceSettings{
			SessionPolicyID: device.SessionPolicyID, KioskEnabled: true,
			AllowedApplicationModes: []manageddevices.ApplicationMode{"visitor_terminal"},
			CheckInMethods:          manageddevices.AllKioskMethods, CheckOutMethods: manageddevices.AllKioskMethods,
			AllowTapCheckout: true, OfferSurveysAtCheckout: true, KioskResetSeconds: 600,
		}, device.Version, nil)
	if err != nil || !updated.AllowTapCheckout || !updated.OfferSurveysAtCheckout || updated.KioskResetSeconds != 600 {
		t.Fatalf("updated = %+v, %v", updated, err)
	}
}

func TestKioskConsentIsStoredOnlyForTheOpenVisitOfThatTablet(t *testing.T) {
	e := newCheckoutEnv(t, true)
	other := e.newDevice("Other tablet", true, false)
	server := newManagedDeviceHTTPServer(t, e.pool, testOrigin)
	defer server.Close()
	client := newCookieClient(t)

	a, visitID := e.person("consent", false, e.device.Device.ID)
	pending, err := notifyrules.NewService(e.pool).PendingConsents(e.ctx, a.personID)
	if err != nil || len(pending) != 2 {
		t.Fatalf("pending consents = %d, %v", len(pending), err)
	}
	var newsID, serviceID uuid.UUID
	if err = e.pool.QueryRow(e.ctx, `SELECT id FROM notification_categories WHERE key = 'news'`).Scan(&newsID); err != nil {
		t.Fatal(err)
	}
	if err = e.pool.QueryRow(e.ctx, `SELECT id FROM notification_categories WHERE key = 'service'`).Scan(&serviceID); err != nil {
		t.Fatal(err)
	}
	body := func(visit uuid.UUID, category uuid.UUID) map[string]any {
		return map[string]any{"visitId": visit, "answers": []map[string]any{{"categoryId": category, "granted": true}}}
	}
	post := func(token string, payload map[string]any) int {
		response := doJSONWithDevice(t, client, http.MethodPost, server.URL+"/api/v1/terminal/consents", testOrigin, "", token, payload)
		defer response.Body.Close()
		return response.StatusCode
	}
	if status := post(other.Token, body(visitID, newsID)); status != http.StatusNotFound {
		t.Fatalf("another tablet: %d", status)
	}
	if status := post(e.device.Token, body(ids.New(), newsID)); status != http.StatusNotFound {
		t.Fatalf("unknown visit: %d", status)
	}
	if status := post(e.device.Token, body(visitID, serviceID)); status != http.StatusUnprocessableEntity {
		t.Fatalf("category that needs no consent: %d", status)
	}
	if e.count(`SELECT count(*) FROM notification_consents WHERE person_id = $1`, a.personID) != 0 {
		t.Fatal("refused answers were stored")
	}
	if status := post(e.device.Token, body(visitID, newsID)); status != http.StatusNoContent {
		t.Fatalf("valid answer: %d", status)
	}
	if e.count(`SELECT count(*) FROM notification_consents WHERE person_id = $1 AND category_id = $2 AND granted
		AND place = 'kiosk' AND device_id = $3`, a.personID, newsID, e.device.Device.ID) != 1 ||
		e.count(`SELECT count(*) FROM audit_events WHERE action = 'notification_consent.answered' AND actor_account_id = $1`,
			a.accountID) != 1 {
		t.Fatal("kiosk consent or its audit event is missing")
	}
	if pending, err = notifyrules.NewService(e.pool).PendingConsents(e.ctx, a.personID); err != nil || len(pending) != 1 {
		t.Fatalf("pending after the answer = %d, %v", len(pending), err)
	}

	// Ten minutes after the check-in the window is closed; so is a checked-out visit.
	if _, err = e.pool.Exec(e.ctx, `UPDATE visits SET checked_in_at = now() - interval '11 minutes' WHERE id = $1`, visitID); err != nil {
		t.Fatal(err)
	}
	if status := post(e.device.Token, body(visitID, newsID)); status != http.StatusNotFound {
		t.Fatalf("late answer: %d", status)
	}
	b, bVisit := e.person("consent2", false, e.device.Device.ID)
	_ = b
	if status := post(e.device.Token, body(bVisit, newsID)); status != http.StatusNoContent {
		t.Fatalf("second visitor: %d", status)
	}
	if _, err = e.attendance.SupervisedCheckOut(e.ctx, e.supervisor(), bVisit, nil); err != nil {
		t.Fatal(err)
	}
	if status := post(e.device.Token, body(bVisit, newsID)); status != http.StatusNotFound {
		t.Fatalf("answer after check-out: %d", status)
	}
	if status := post("", body(visitID, newsID)); status != http.StatusNotFound {
		t.Fatalf("no device credential: %d", status)
	}
}

func TestTerminalSurveyOfferEndpointsNeedTheOfferingDevice(t *testing.T) {
	e := newCheckoutEnv(t, true)
	other := e.newDevice("Other tablet", true, false)
	server := newManagedDeviceHTTPServer(t, e.pool, testOrigin)
	defer server.Close()
	client := newCookieClient(t)
	a, _ := e.person("http", true, e.device.Device.ID)
	token := e.selfCheckOut(a, e.device).SurveyOffer.Token
	url := func(action string) string {
		return server.URL + "/api/v1/terminal/survey-offers/" + token + "/" + action
	}
	call := func(deviceToken, action string) int {
		var payload any
		if action == "responses" {
			payload = map[string]any{"answers": []any{}}
		}
		response := doJSONWithDevice(t, client, http.MethodPost, url(action), testOrigin, "", deviceToken, payload)
		defer response.Body.Close()
		return response.StatusCode
	}
	for _, action := range []string{"answer-now", "responses", "send-email", "decline", "never"} {
		if status := call("", action); status != http.StatusNotFound {
			t.Fatalf("%s without a device credential: %d", action, status)
		}
		if status := call(other.Token, action); status != http.StatusNotFound {
			t.Fatalf("%s on another tablet: %d", action, status)
		}
	}
	if status := call(e.device.Token, "answer-now"); status != http.StatusOK {
		t.Fatalf("answer-now: %d", status)
	}
	if status := call(e.device.Token, "decline"); status != http.StatusNoContent {
		t.Fatalf("decline: %d", status)
	}
	if status := call(e.device.Token, "decline"); status != http.StatusNotFound {
		t.Fatalf("second decline: %d", status)
	}
}

const testOrigin = "http://makerspace.example.test"

// supervisor is a principal who may check people in and out on their behalf.
func (e *checkoutEnv) supervisor() authorization.Principal {
	p := e.principal
	p.Assurance = authorization.AssuranceNormal
	return p
}
