package surveys

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	surveysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/surveys/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func (s *Service) Public(ctx context.Context, token string) (PublicSurvey, error) {
	q := surveysdb.New(s.pool)
	row, err := q.GetPublicSurveyInvitation(ctx, security.DigestToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicSurvey{}, apperror.NotFound
	}
	if err != nil {
		return PublicSurvey{}, err
	}
	if time.Now().UTC().After(row.ExpiresAt) {
		return PublicSurvey{}, apperror.New(
			http.StatusGone,
			"survey_invitation_expired",
			"Survey invitation has expired",
		)
	}
	if slices.Contains(
		[]InvitationStatus{InvitationRedeemed, InvitationCancelled, InvitationExpired},
		InvitationStatus(row.Status),
	) {
		return PublicSurvey{}, apperror.New(
			http.StatusGone,
			"survey_invitation_unavailable",
			"Survey invitation is no longer available",
		)
	}
	questions, err := loadQuestions(ctx, q, row.SurveyVersionID)
	if err != nil {
		return PublicSurvey{}, err
	}
	expires := row.ExpiresAt
	return PublicSurvey{
		Title:        row.Title,
		Introduction: row.Introduction,
		Anonymous:    row.Anonymous,
		Questions:    questions,
		ExpiresAt:    &expires,
	}, nil
}

// Submit stores the response to an invitation and consumes the invitation in one transaction. The survey row is
// share-locked before the questions are read, so an edit or deletion cannot interleave with the submission; the lock
// order (survey, then invitation) matches deletion, which cascades from the survey to its invitations.
func (s *Service) Submit(ctx context.Context, token string, answers []AnswerInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := surveysdb.New(tx)
	digest := security.DigestToken(token)
	known, err := q.GetPublicSurveyInvitation(ctx, digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if _, err = q.LockSurveyShared(ctx, known.SurveyID); errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	invitation, err := q.GetPublicSurveyInvitationForUpdate(ctx, digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if time.Now().UTC().After(invitation.ExpiresAt) {
		return apperror.New(http.StatusGone, "survey_invitation_expired", "Survey invitation has expired")
	}
	if InvitationStatus(invitation.Status) == InvitationRedeemed {
		return apperror.New(http.StatusConflict, "survey_already_submitted", "Survey response was already submitted")
	}
	if InvitationStatus(invitation.Status) == InvitationCancelled ||
		InvitationStatus(invitation.Status) == InvitationExpired {
		return apperror.New(
			http.StatusGone,
			"survey_invitation_unavailable",
			"Survey invitation is no longer available",
		)
	}
	var personID *uuid.UUID
	if !invitation.Anonymous {
		personID = invitation.PersonID
	}
	if err = storeResponse(ctx, q, invitation.SurveyVersionID, SourceInvitation, nil, personID, answers); err != nil {
		return err
	}
	count, err := q.ConsumeSurveyInvitation(ctx, invitation.InvitationID)
	if err != nil {
		return err
	}
	if count != 1 {
		return apperror.Conflict
	}
	return tx.Commit(ctx)
}

// storeResponse validates the answers against the version's questions and conditions and stores the response.
func storeResponse(
	ctx context.Context,
	q *surveysdb.Queries,
	versionID uuid.UUID,
	source ResponseSource,
	linkID, personID *uuid.UUID,
	answers []AnswerInput,
) error {
	questions, err := loadQuestions(ctx, q, versionID)
	if err != nil {
		return err
	}
	planned, err := planAnswers(questions, answers)
	if err != nil {
		return err
	}
	// Responses keep only the calendar day (Vienna), not the time, to limit timing correlation.
	location, locationErr := time.LoadLocation("Europe/Vienna")
	if locationErr != nil {
		location = time.UTC
	}
	responseID := ids.New()
	if _, err = q.CreateSurveyResponse(
		ctx,
		surveysdb.CreateSurveyResponseParams{
			ID:                 responseID,
			SurveyVersionID:    versionID,
			SubmittedOn:        pgtype.Date{Time: time.Now().In(location), Valid: true},
			IdentifiedPersonID: personID,
			Source:             string(source),
			ShareLinkID:        linkID,
		},
	); err != nil {
		return err
	}
	for _, item := range planned {
		if err = storeAnswer(ctx, q, responseID, item.Question, item.Answer); err != nil {
			return err
		}
	}
	return nil
}

// storeAnswer writes an answer that planAnswers already validated.
func storeAnswer(
	ctx context.Context,
	q *surveysdb.Queries,
	responseID uuid.UUID,
	question Question,
	answer AnswerInput,
) error {
	row := surveysdb.CreateSurveyAnswerParams{ResponseID: responseID, QuestionID: question.ID, Position: 1}
	switch question.Kind {
	case QuestionSingleChoice, QuestionMultipleChoice:
		for index, optionID := range answer.OptionIDs {
			row.ID, row.OptionID, row.Position = ids.New(), &optionID, int32(index+1)
			if err := q.CreateSurveyAnswer(ctx, row); err != nil {
				return err
			}
		}
		return nil
	case QuestionFreeText:
		row.TextValue = answer.TextValue
	case QuestionRating:
		row.NumericValue = answer.NumericValue
	case QuestionYesNo:
		row.BooleanValue = answer.BooleanValue
	default:
		return apperror.InvalidField("question kind is invalid")
	}
	row.ID = ids.New()
	return q.CreateSurveyAnswer(ctx, row)
}
