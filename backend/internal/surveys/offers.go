package surveys

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	surveysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/surveys/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// OfferLifetime is how long a survey offered at the tablet stays usable.
const OfferLifetime = 15 * time.Minute

// Offer is a survey the tablet may show a person right after a self check-out. Token is the only copy of the opaque
// offer token; the database keeps its digest.
type Offer struct {
	Token          string
	SurveyName     string
	QuestionCount  int
	Anonymous      bool
	CanAnswerNow   bool
	CanSendByEmail bool
	ExpiresAt      time.Time
}

var errSurveyUnavailable = apperror.New(http.StatusGone, "survey_unavailable", "The survey is no longer published")

// OfferAtCheckOut offers the first survey whose check-out trigger asks at the tablet, unless the person switched the
// question off or the survey's cooldown applies. It runs inside the check-out transaction, after the automatic
// invitations were created, and starts the person's cooldown for the offered survey. It returns nil when nothing is
// offered.
func (s *Service) OfferAtCheckOut(ctx context.Context, tx pgx.Tx, personID, visitID, deviceID uuid.UUID) (*Offer, error) {
	q := surveysdb.New(tx)
	if err := q.DeleteExpiredSurveyOffers(ctx); err != nil {
		return nil, err
	}
	if err := q.DeleteStaleSurveyAsks(ctx); err != nil {
		return nil, err
	}
	ask, err := q.GetPersonAskFeedback(ctx, personID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err == nil && !ask {
		return nil, nil
	}
	candidates, err := q.ListOfferableSurveys(ctx, surveysdb.ListOfferableSurveysParams{PersonID: &personID, VisitID: &visitID})
	if err != nil || len(candidates) == 0 {
		return nil, err
	}
	person, err := q.GetOfferPerson(ctx, personID)
	if err != nil {
		return nil, err
	}
	candidate := candidates[0]
	token, digest, err := security.NewOpaqueToken()
	if err != nil {
		return nil, err
	}
	expires := time.Now().UTC().Add(OfferLifetime)
	if err = q.CreateSurveyOffer(ctx, surveysdb.CreateSurveyOfferParams{
		ID: ids.New(), TokenDigest: digest, VisitID: &visitID, PersonID: &personID, DeviceID: deviceID, SurveyID: candidate.SurveyID,
		SurveyVersionID: candidate.SurveyVersionID, ExpiresAt: expires,
	}); err != nil {
		return nil, err
	}
	if err = q.UpsertSurveyAsk(ctx, surveysdb.UpsertSurveyAskParams{PersonID: personID, SurveyID: candidate.SurveyID}); err != nil {
		return nil, err
	}
	// The automatic e-mail waits until the offer has run out, so the person is not asked twice at once.
	if _, err = q.PostponeSurveyInvitationForVisit(ctx, surveysdb.PostponeSurveyInvitationForVisitParams{
		NotBefore: expires, VisitID: &visitID, SurveyVersionID: candidate.SurveyVersionID,
	}); err != nil {
		return nil, err
	}
	return &Offer{
		Token: token, SurveyName: candidate.SurveyName, QuestionCount: int(candidate.QuestionCount),
		Anonymous: candidate.Anonymous, CanAnswerNow: true, CanSendByEmail: person.Email != nil && *person.Email != "",
		ExpiresAt: expires,
	}, nil
}

// lockOffer finds the usable offer of this tablet and locks it. Every unusable case (unknown, other tablet, used,
// expired) reads as not found. The survey is share-locked before the offer, like Submit does for invitations.
func lockOffer(
	ctx context.Context,
	q *surveysdb.Queries,
	deviceID uuid.UUID,
	token string,
) (surveysdb.GetSurveyOfferForUpdateRow, error) {
	digest := security.DigestToken(token)
	known, err := q.GetSurveyOffer(ctx, surveysdb.GetSurveyOfferParams{TokenDigest: digest, DeviceID: deviceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return surveysdb.GetSurveyOfferForUpdateRow{}, apperror.NotFound
	} else if err != nil {
		return surveysdb.GetSurveyOfferForUpdateRow{}, err
	}
	if _, err = q.LockSurveyShared(ctx, known.SurveyID); errors.Is(err, pgx.ErrNoRows) {
		return surveysdb.GetSurveyOfferForUpdateRow{}, apperror.NotFound
	} else if err != nil {
		return surveysdb.GetSurveyOfferForUpdateRow{}, err
	}
	offer, err := q.GetSurveyOfferForUpdate(ctx, surveysdb.GetSurveyOfferForUpdateParams{TokenDigest: digest, DeviceID: deviceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return offer, apperror.NotFound
	}
	return offer, err
}

func consumeOffer(ctx context.Context, q *surveysdb.Queries, offerID uuid.UUID) error {
	count, err := q.ConsumeSurveyOffer(ctx, offerID)
	if err != nil {
		return err
	}
	if count != 1 {
		return apperror.Conflict
	}
	return nil
}

// OfferedSurvey returns the questions of an offered survey. The offer stays usable until the responses are submitted.
func (s *Service) OfferedSurvey(ctx context.Context, deviceID uuid.UUID, token string) (PublicSurvey, error) {
	q := surveysdb.New(s.pool)
	row, err := q.GetSurveyOffer(ctx, surveysdb.GetSurveyOfferParams{TokenDigest: security.DigestToken(token), DeviceID: deviceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicSurvey{}, apperror.NotFound
	} else if err != nil {
		return PublicSurvey{}, err
	}
	if Status(row.SurveyStatus) != StatusPublished {
		return PublicSurvey{}, errSurveyUnavailable
	}
	questions, err := loadQuestions(ctx, q, row.SurveyVersionID)
	if err != nil {
		return PublicSurvey{}, err
	}
	expires := row.ExpiresAt
	return PublicSurvey{
		Title: row.Title, Introduction: row.Introduction, Anonymous: row.Anonymous, Questions: questions, ExpiresAt: &expires,
	}, nil
}

// SubmitOffered stores the answers to an offered survey and consumes the offer. An anonymous survey stores the response
// exactly like the redemption of an anonymous invitation: no person and no visit. An identified survey links the
// response to the person who checked out. The visit's automatic invitation for this survey is cancelled.
func (s *Service) SubmitOffered(ctx context.Context, deviceID uuid.UUID, token string, answers []AnswerInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := surveysdb.New(tx)
	offer, err := lockOffer(ctx, q, deviceID, token)
	if err != nil {
		return err
	}
	if Status(offer.SurveyStatus) != StatusPublished || offer.VisitID == nil || offer.PersonID == nil {
		return errSurveyUnavailable
	}
	var personID *uuid.UUID
	if !offer.Anonymous {
		personID = offer.PersonID
	}
	responseID, err := storeResponse(ctx, q, offer.SurveyVersionID, SourceInvitation, nil, personID, answers)
	if err != nil {
		return err
	}
	if err = s.notifyAnswered(ctx, tx, responseID); err != nil {
		return err
	}
	if _, err = q.CancelSurveyInvitationForVisitVersion(ctx, surveysdb.CancelSurveyInvitationForVisitVersionParams{
		VisitID: offer.VisitID, SurveyVersionID: offer.SurveyVersionID,
	}); err != nil {
		return err
	}
	if err = consumeOffer(ctx, q, offer.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SendOfferedByEmail sends the invitation right away, whatever the trigger delay says. It works without the person's
// Surveys & feedback consent: the person asked for it explicitly, once, and the consent stays as it is.
func (s *Service) SendOfferedByEmail(ctx context.Context, deviceID uuid.UUID, token string, requestID *uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := surveysdb.New(tx)
	offer, err := lockOffer(ctx, q, deviceID, token)
	if err != nil {
		return err
	}
	if Status(offer.SurveyStatus) != StatusPublished || offer.VisitID == nil || offer.PersonID == nil {
		return errSurveyUnavailable
	}
	person, err := q.GetOfferPerson(ctx, *offer.PersonID)
	if err != nil {
		return err
	}
	if person.Email == nil || *person.Email == "" {
		return apperror.New(http.StatusUnprocessableEntity, "no_email", "There is no e-mail address to send the survey to")
	}
	visitID := *offer.VisitID
	updated, err := q.SendSurveyInvitationNow(ctx, surveysdb.SendSurveyInvitationNowParams{
		RecipientEmail: person.Email, VisitID: &visitID, SurveyVersionID: offer.SurveyVersionID,
	})
	if err != nil {
		return err
	}
	if updated == 0 {
		id := ids.New()
		now := time.Now().UTC()
		if _, err = q.CreateSurveyInvitation(ctx, surveysdb.CreateSurveyInvitationParams{
			ID: id, SurveyVersionID: offer.SurveyVersionID, PersonID: &person.ID, VisitID: &visitID,
			TokenDigest: security.DigestToken(s.tokenForID(id)), RecipientEmail: person.Email, DueAt: now,
			ExpiresAt: now.Add(14 * 24 * time.Hour),
		}); err != nil {
			return err
		}
	}
	if err = consumeOffer(ctx, q, offer.ID); err != nil {
		return err
	}
	if err = audit.Write(ctx, tx, audit.Event{
		Action: "survey_offer.email_requested", ResourceType: "survey_offer", ResourceID: &offer.ID, RequestID: requestID,
	}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if s.notifier != nil {
		// Best effort: a failure leaves the invitation due, and the delivery loop retries it.
		_, _ = s.DeliverDue(ctx, 25)
	}
	return nil
}

// DeclineOffered consumes the offer ("No thanks") and cancels the visit's automatic invitation. With never it also
// switches the person's "feedback at check-out" choice off. The cooldown started when the offer was made.
func (s *Service) DeclineOffered(ctx context.Context, deviceID uuid.UUID, token string, never bool, requestID *uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := surveysdb.New(tx)
	offer, err := lockOffer(ctx, q, deviceID, token)
	if err != nil {
		return err
	}
	if offer.VisitID == nil || offer.PersonID == nil {
		return apperror.NotFound
	}
	visitID := *offer.VisitID
	if never {
		if err = q.DisableAskFeedbackAtCheckout(ctx, *offer.PersonID); err != nil {
			return err
		}
		if err = audit.Write(ctx, tx, audit.Event{
			Action: "survey_offer.never", ResourceType: "person_notification_settings", ResourceID: offer.PersonID,
			RequestID: requestID, ChangedFields: []string{"askFeedbackAtCheckout"},
		}); err != nil {
			return err
		}
	}
	if _, err = q.CancelSurveyInvitationForVisitVersion(ctx, surveysdb.CancelSurveyInvitationForVisitVersionParams{
		VisitID: &visitID, SurveyVersionID: offer.SurveyVersionID,
	}); err != nil {
		return err
	}
	if err = consumeOffer(ctx, q, offer.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
