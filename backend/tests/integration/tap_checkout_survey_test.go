package integration_test

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/google/uuid"
)

func (e *checkoutEnv) tapCheckOut(device manageddevices.ProvisionedDevice, visitID uuid.UUID) *surveys.Offer {
	e.t.Helper()
	visit, err := e.attendance.PublicCheckOut(e.ctx, e.deviceContext(device), visitID, nil)
	if err != nil || visit.CheckOutMethod == nil || *visit.CheckOutMethod != "public_tap" {
		e.t.Fatalf("tap check-out: %+v, %v", visit, err)
	}
	return visit.SurveyOffer
}

// deliver runs the delivery loop once with a mail stub after making every waiting invitation due, as if the offer had
// run out, and returns how many survey e-mails went out.
func (e *checkoutEnv) deliver() int {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx, `UPDATE survey_invitations SET due_at = now() - interval '1 second'
		WHERE status IN ('pending', 'failed')`); err != nil {
		e.t.Fatal(err)
	}
	stub := &surveyNotifierStub{}
	svc := surveys.NewService(e.pool, config.Config{ChallengeHMACKey: bytes.Repeat([]byte{1}, 32)}, stub)
	if _, err := svc.DeliverDue(e.ctx, 100); err != nil {
		e.t.Fatal(err)
	}
	return stub.sent
}

// An identified survey is used on purpose: after a tap the answers stay anonymous whatever the survey says.
func TestTapCheckOutOfferNamesThePersonOnlyWhileOpenAndKeepsAnswersAnonymous(t *testing.T) {
	e := newCheckoutEnv(t, false)
	tap := e.newDevice("Tap tablet", true, true)
	a, visitID := e.person("tap-a", true, tap.Device.ID)

	offer := e.tapCheckOut(tap, visitID)
	if offer == nil {
		t.Fatal("no survey offered after a tap check-out on a tablet that offers surveys")
	}
	if !offer.Anonymous || !offer.CanAnswerNow || !offer.CanSendByEmail || !offer.MailConsent || offer.CanStopAsking ||
		len(offer.Token) != 43 {
		t.Fatalf("offer = %+v", offer)
	}
	if remaining := time.Until(offer.ExpiresAt); remaining < 14*time.Minute || remaining > 15*time.Minute+time.Second {
		t.Fatalf("offer expires in %s", remaining)
	}
	// While open the offer names the tapped person and the check-out (never the visit), like a self check-out offer.
	if e.count(`SELECT count(*) FROM survey_offers WHERE token_digest = $1 AND person_id = $2 AND visit_id IS NOT NULL
		AND visit_id <> $3 AND after_tap AND device_id = $4`, security.DigestToken(offer.Token), a.personID, visitID,
		tap.Device.ID) != 1 {
		t.Fatal("the open tap offer must name the tapped person and the check-out reference")
	}
	// Asking starts the cooldown and holds the automatic e-mail back until the offer has run out.
	if e.count(`SELECT count(*) FROM survey_ask_cooldowns WHERE person_id = $1`, a.personID) != 1 ||
		e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1 AND status = 'pending'
			AND due_at >= $2`, a.personID, offer.ExpiresAt.Add(-time.Second)) != 1 {
		t.Fatal("the tap offer did not start the cooldown or hold back the invitation")
	}

	// Only the tablet that tapped can use it, and nobody's choice can be switched off there.
	other := e.newDevice("Other tablet", true, true)
	if _, err := e.svc.OfferedSurvey(e.ctx, other.Device.ID, offer.Token); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("read on another tablet: %v", err)
	}
	if err := e.svc.DeclineOffered(e.ctx, tap.Device.ID, offer.Token, true, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("never: %v", err)
	}
	if e.count(`SELECT count(*) FROM person_notification_settings WHERE person_id = $1`, a.personID) != 0 {
		t.Fatal("a tap offer changed the tapped person's choice")
	}

	survey, err := e.svc.OfferedSurvey(e.ctx, tap.Device.ID, offer.Token)
	if err != nil || !survey.Anonymous {
		t.Fatalf("survey = %+v, %v", survey, err)
	}
	answers := []surveys.AnswerInput{answerChoice(survey.Questions[0], "No")}
	if err = e.svc.SubmitOffered(e.ctx, tap.Device.ID, offer.Token, answers); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM survey_responses WHERE identified_person_id IS NULL AND share_link_id IS NULL`) != 1 ||
		e.count(`SELECT count(*) FROM survey_responses`) != 1 {
		t.Fatal("the answer after a tap is missing or carries a person")
	}
	if e.count(`SELECT count(*) FROM survey_offers WHERE person_id IS NOT NULL OR visit_id IS NOT NULL`) != 0 ||
		e.count(`SELECT count(*) FROM survey_offers WHERE consumed_at IS NOT NULL`) != 1 {
		t.Fatal("the used offer still names the person or the check-out")
	}
	// Like an answer after a self check-out, the answer cancels the invitation and clears its delivery identity, so
	// the survey is not e-mailed as well.
	if e.count(`SELECT count(*) FROM survey_invitations WHERE status = 'cancelled' AND person_id IS NULL
			AND visit_id IS NULL AND recipient_email IS NULL`) != 1 ||
		e.count(`SELECT count(*) FROM survey_invitations WHERE status <> 'cancelled'`) != 0 {
		t.Fatal("the tapped person's invitation was not cancelled after the answer on the tablet")
	}
	if sent := e.deliver(); sent != 0 {
		t.Fatalf("%d survey e-mails followed an answer on the tablet", sent)
	}
	// Single use.
	if err = e.svc.SubmitOffered(e.ctx, tap.Device.ID, offer.Token, answers); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("second submission: %v", err)
	}
	if e.count(`SELECT count(*) FROM survey_responses`) != 1 {
		t.Fatal("a used offer stored another response")
	}
}

func TestTapCheckOutOfferSendsTheSurveyToTheTappedPersonOnce(t *testing.T) {
	e := newCheckoutEnv(t, true)
	tap := e.newDevice("Tap tablet", true, true)

	// With the Surveys & feedback consent the automatic invitation is brought forward instead of a second one.
	b, bVisit := e.person("tap-mail", true, tap.Device.ID)
	consented := e.tapCheckOut(tap, bVisit)
	if consented == nil || !consented.MailConsent || !consented.CanSendByEmail {
		t.Fatalf("offer = %+v", consented)
	}
	if err := e.svc.SendOfferedByEmail(e.ctx, tap.Device.ID, consented.Token, nil); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1 AND status = 'pending' AND due_at <= now()
		AND recipient_email = 'checkout-tap-mail@example.test'`, b.personID) != 1 ||
		e.count(`SELECT count(*) FROM survey_invitations`) != 1 {
		t.Fatal("the tapped person's invitation is not due right away, or a second one appeared")
	}
	if err := e.svc.SendOfferedByEmail(e.ctx, tap.Device.ID, consented.Token, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("second request: %v", err)
	}
	if sent := e.deliver(); sent != 1 {
		t.Fatalf("sent %d e-mails, want exactly one", sent)
	}
	if sent := e.deliver(); sent != 0 {
		t.Fatalf("sent %d more e-mails", sent)
	}

	// Without the consent there is no automatic invitation; the explicit request creates one and leaves consent alone.
	c, cVisit := e.person("tap-nomail", false, tap.Device.ID)
	plain := e.tapCheckOut(tap, cVisit)
	if plain == nil || plain.MailConsent || !plain.CanSendByEmail {
		t.Fatalf("offer = %+v", plain)
	}
	if e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1`, c.personID) != 0 {
		t.Fatal("automatic invitation without consent")
	}
	if err := e.svc.SendOfferedByEmail(e.ctx, tap.Device.ID, plain.Token, nil); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1 AND due_at <= now()
		AND recipient_email = 'checkout-tap-nomail@example.test'`, c.personID) != 1 ||
		e.count(`SELECT count(*) FROM notification_consents WHERE person_id = $1`, c.personID) != 0 {
		t.Fatal("the explicit request did not queue exactly one invitation, or it changed the consent")
	}
	if e.count(`SELECT count(*) FROM audit_events WHERE action = 'survey_offer.email_requested'`) != 2 {
		t.Fatal("missing audit events")
	}
	if e.count(`SELECT count(*) FROM survey_offers WHERE person_id IS NOT NULL OR visit_id IS NOT NULL`) != 0 {
		t.Fatal("a used offer still names the person")
	}
	if sent := e.deliver(); sent != 1 {
		t.Fatalf("sent %d e-mails, want exactly one", sent)
	}

	// "No thanks" after a tap only uses the offer up: it holds back nothing the tapped person agreed to.
	d, dVisit := e.person("tap-decline", true, tap.Device.ID)
	declined := e.tapCheckOut(tap, dVisit)
	if err := e.svc.DeclineOffered(e.ctx, tap.Device.ID, declined.Token, false, nil); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1 AND status = 'pending'`, d.personID) != 1 {
		t.Fatal("a decline after a tap cancelled the tapped person's invitation")
	}

	// An offer that runs out unused loses its person with the next delivery pass.
	_, eVisit := e.person("tap-expire", true, tap.Device.ID)
	expiring := e.tapCheckOut(tap, eVisit)
	if _, err := e.pool.Exec(e.ctx, `UPDATE survey_offers SET expires_at = now() - interval '1 second'
		WHERE token_digest = $1`, security.DigestToken(expiring.Token)); err != nil {
		t.Fatal(err)
	}
	e.deliver()
	if e.count(`SELECT count(*) FROM survey_offers WHERE person_id IS NOT NULL OR visit_id IS NOT NULL`) != 0 ||
		e.count(`SELECT count(*) FROM survey_offers WHERE token_digest = $1`, security.DigestToken(expiring.Token)) != 0 {
		t.Fatal("an expired offer still names the person")
	}
}

func TestTapCheckOutSurveyFollowsTheTabletAndTheTappedPersonAndExpires(t *testing.T) {
	e := newCheckoutEnv(t, true)

	// A tablet that does not offer surveys offers none after a tap either.
	plain := e.newDevice("Plain tap tablet", false, true)
	_, visitID := e.person("tap-plain", true, plain.Device.ID)
	if offer := e.tapCheckOut(plain, visitID); offer != nil {
		t.Fatalf("offered on a tablet with offerSurveysAtCheckout off: %+v", offer)
	}

	// The tapped person switched the question off.
	tap := e.newDevice("Tap tablet", true, true)
	off, offVisit := e.person("tap-off", true, tap.Device.ID)
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO person_notification_settings (person_id, ask_feedback_at_checkout)
		VALUES ($1, false)`, off.personID); err != nil {
		t.Fatal(err)
	}
	if offer := e.tapCheckOut(tap, offVisit); offer != nil {
		t.Fatal("offered after tapping a person who switched the question off")
	}

	// "No thanks" uses the offer up.
	_, declinedVisit := e.person("tap-no", true, tap.Device.ID)
	declined := e.tapCheckOut(tap, declinedVisit)
	if declined == nil {
		t.Fatal("no offer")
	}
	if err := e.svc.DeclineOffered(e.ctx, tap.Device.ID, declined.Token, false, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SubmitOffered(e.ctx, tap.Device.ID, declined.Token, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("submit after decline: %v", err)
	}

	// An expired offer can no longer be answered.
	_, lateVisit := e.person("tap-late", true, tap.Device.ID)
	late := e.tapCheckOut(tap, lateVisit)
	if late == nil {
		t.Fatal("no offer")
	}
	survey, err := e.svc.OfferedSurvey(e.ctx, tap.Device.ID, late.Token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.pool.Exec(e.ctx, `UPDATE survey_offers SET expires_at = now() - interval '1 second'
		WHERE token_digest = $1`, security.DigestToken(late.Token)); err != nil {
		t.Fatal(err)
	}
	if err = e.svc.SubmitOffered(e.ctx, tap.Device.ID, late.Token,
		[]surveys.AnswerInput{answerChoice(survey.Questions[0], "No")}); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("submit after expiry: %v", err)
	}
	if e.count(`SELECT count(*) FROM survey_responses`) != 0 {
		t.Fatal("a response was stored without a usable offer")
	}
}
