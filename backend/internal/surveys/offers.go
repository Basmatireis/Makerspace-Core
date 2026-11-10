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
	// CanStopAsking is false for an offer after a tap check-out: it names nobody, so nobody's choice can be changed.
	CanStopAsking bool
	ExpiresAt     time.Time
}

var errSurveyUnavailable = apperror.New(http.StatusGone, "survey_unavailable", "The survey is no longer published")

// OfferAtCheckOut offers the first survey whose check-out trigger asks at the tablet, unless the person switched the
// question off or the survey's cooldown applies. It runs inside the check-out transaction, after the automatic
// invitations were created, and starts the person's cooldown for the offered survey. It returns nil when nothing is
// offered.
func (s *Service) OfferAtCheckOut(ctx context.Context, tx pgx.Tx, personID, visitID, deviceID uuid.UUID) (*Offer, error) {
	q := surveysdb.New(tx)
	candidate, err := offerableSurvey(ctx, q, personID, visitID)
	if err != nil || candidate == nil {
		return nil, err
	}
	person, err := q.GetOfferPerson(ctx, personID)
	if err != nil {
		return nil, err
	}
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
		CanStopAsking: true, ExpiresAt: expires,
	}, nil
}

// OfferAfterTapCheckOut offers the same survey after a tap in the presence list. Anyone can tap any name, so the
// tablet cannot know who answers: the offer stores neither the person nor the check-out reference, its answers are
// stored without a person (whatever the survey's own setting), and it can neither send an e-mail nor switch a person's
// question off. The tapped person's choice and cooldown still decide whether to ask, but asking does not start the
// cooldown nor touch the person's invitations, since the answer may come from someone else. The offer is bound to the
// tablet, single use and short-lived, so anonymous answers can only follow a real tap check-out, one each.
func (s *Service) OfferAfterTapCheckOut(
	ctx context.Context,
	tx pgx.Tx,
	personID, checkOutRef, deviceID uuid.UUID,
) (*Offer, error) {
	q := surveysdb.New(tx)
	candidate, err := offerableSurvey(ctx, q, personID, checkOutRef)
	if err != nil || candidate == nil {
		return nil, err
	}
	token, digest, err := security.NewOpaqueToken()
	if err != nil {
		return nil, err
	}
	expires := time.Now().UTC().Add(OfferLifetime)
	if err = q.CreateSurveyOffer(ctx, surveysdb.CreateSurveyOfferParams{
		ID: ids.New(), TokenDigest: digest, DeviceID: deviceID, SurveyID: candidate.SurveyID,
		SurveyVersionID: candidate.SurveyVersionID, ExpiresAt: expires,
	}); err != nil {
		return nil, err
	}
	return &Offer{
		Token: token, SurveyName: candidate.SurveyName, QuestionCount: int(candidate.QuestionCount),
		Anonymous: true, CanAnswerNow: true, ExpiresAt: expires,
	}, nil
}

// offerableSurvey prunes expired offers and old cooldowns and returns the first survey the tablet may ask this person
// about, or nil when the person switched the question off or nothing qualifies.
func offerableSurvey(
	ctx context.Context,
	q *surveysdb.Queries,
	personID, checkOutRef uuid.UUID,
) (*surveysdb.ListOfferableSurveysRow, error) {
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
	candidates, err := q.ListOfferableSurveys(
		ctx,
		surveysdb.ListOfferableSurveysParams{PersonID: &personID, VisitID: &checkOutRef},
	)
	if err != nil || len(candidates) == 0 {
		return nil, err
	}
	return &candidates[0], nil
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
// response to the person who checked out, and the visit's automatic invitation for this survey is cancelled. The
// answers to an offer after a tap check-out are always stored without a person and leave invitations alone.
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
	if Status(offer.SurveyStatus) != StatusPublished {
		return errSurveyUnavailable
	}
	// The query reads an offer without a person (after a tap check-out) as anonymous, so its answers never get one.
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
	if offer.VisitID != nil {
		if _, err = q.CancelSurveyInvitationForVisitVersion(ctx, surveysdb.CancelSurveyInvitationForVisitVersionParams{
			VisitID: offer.VisitID, SurveyVersionID: offer.SurveyVersionID,
		}); err != nil {
			return err
		}
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
	if offer.VisitID == nil || offer.PersonID == nil {
		// An offer after a tap check-out names nobody, so there is no address to send it to.
		return apperror.NotFound
	}
	if Status(offer.SurveyStatus) != StatusPublished {
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
// switches the person's "feedback at check-out" choice off. The cooldown started when the offer was made. An offer
// after a tap check-out is only consumed, and never answers not found.
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
		// An offer after a tap check-out names nobody: "No thanks" only uses it up, and nobody's choice can change.
		if never {
			return apperror.NotFound
		}
		return consumeAndCommit(ctx, tx, q, offer.ID)
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

func consumeAndCommit(ctx context.Context, tx pgx.Tx, q *surveysdb.Queries, offerID uuid.UUID) error {
	if err := consumeOffer(ctx, q, offerID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
