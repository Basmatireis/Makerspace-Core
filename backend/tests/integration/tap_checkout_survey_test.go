package integration_test

import (
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
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

// An identified survey is used on purpose: after a tap the answers stay anonymous whatever the survey says.
func TestTapCheckOutOffersASurveyThatNamesNobody(t *testing.T) {
	e := newCheckoutEnv(t, false)
	tap := e.newDevice("Tap tablet", true, true)
	a, visitID := e.person("tap-a", true, tap.Device.ID)

	offer := e.tapCheckOut(tap, visitID)
	if offer == nil {
		t.Fatal("no survey offered after a tap check-out on a tablet that offers surveys")
	}
	if !offer.Anonymous || !offer.CanAnswerNow || offer.CanSendByEmail || offer.CanStopAsking || len(offer.Token) != 43 {
		t.Fatalf("offer = %+v", offer)
	}
	if remaining := time.Until(offer.ExpiresAt); remaining < 14*time.Minute || remaining > 15*time.Minute+time.Second {
		t.Fatalf("offer expires in %s", remaining)
	}
	if e.count(`SELECT count(*) FROM survey_offers WHERE token_digest = $1 AND person_id IS NULL AND visit_id IS NULL
		AND device_id = $2`, security.DigestToken(offer.Token), tap.Device.ID) != 1 {
		t.Fatal("the tap offer must name neither the person nor the check-out")
	}
	// Asking after a tap neither starts the person's cooldown nor holds back their own invitation.
	if e.count(`SELECT count(*) FROM survey_ask_cooldowns WHERE person_id = $1`, a.personID) != 0 ||
		e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1 AND status = 'pending'
			AND due_at < now() + interval '31 minutes'`, a.personID) != 1 {
		t.Fatal("the tap offer touched the person's cooldown or invitation")
	}

	// Only the tablet that tapped can use it, and nothing that needs a person works.
	other := e.newDevice("Other tablet", true, true)
	if _, err := e.svc.OfferedSurvey(e.ctx, other.Device.ID, offer.Token); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("read on another tablet: %v", err)
	}
	if err := e.svc.SendOfferedByEmail(e.ctx, tap.Device.ID, offer.Token, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("send by e-mail: %v", err)
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
	if e.count(`SELECT count(*) FROM survey_offers WHERE consumed_at IS NOT NULL AND person_id IS NULL AND visit_id IS NULL`) != 1 {
		t.Fatal("the offer was not used up")
	}
	if e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1 AND status = 'pending'`, a.personID) != 1 {
		t.Fatal("the anonymous answer cancelled the tapped person's invitation")
	}
	// Single use.
	if err = e.svc.SubmitOffered(e.ctx, tap.Device.ID, offer.Token, answers); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("second submission: %v", err)
	}
	if e.count(`SELECT count(*) FROM survey_responses`) != 1 {
		t.Fatal("a used offer stored another response")
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
