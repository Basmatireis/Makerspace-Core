package surveys

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	surveysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/surveys/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	// LinkSubmitsPerWindow bounds the submissions one share link accepts per window, whatever their source address,
	// so a leaked link cannot be used to flood the database.
	LinkSubmitsPerWindow = 120
	LinkSubmitWindow     = time.Minute
	maxLinkLabelRunes    = 120
	maxLinkResponses     = 1_000_000
)

// ShareLink is an anonymous entry point to a published survey.
type ShareLink struct {
	ID, SurveyID         uuid.UUID
	Label                *string
	Token                string
	Active               bool
	State                LinkState
	ExpiresAt            *time.Time
	MaxResponses         *int32
	ResponseCount        int64
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

// LinkInput is the editable part of a share link; ExpectedVersion is used on update only.
type LinkInput struct {
	Label           *string
	ExpiresAt       *time.Time
	MaxResponses    *int32
	Active          bool
	ExpectedVersion int64
}

// linkToken derives the public token from the link id like invitation tokens are derived. The domain prefix keeps
// the two token spaces apart; only the digest is stored, and the HMAC lets an administrator see the link again.
func (s *Service) linkToken(id uuid.UUID) string {
	mac := hmac.New(sha256.New, s.tokenKey)
	_, _ = mac.Write([]byte("survey-share-link:"))
	_, _ = mac.Write(id[:])
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func linkState(active bool, expires *time.Time, maxResponses *int32, responses int64, now time.Time) LinkState {
	switch {
	case !active:
		return LinkInactive
	case expires != nil && !now.Before(*expires):
		return LinkExpired
	case maxResponses != nil && responses >= int64(*maxResponses):
		return LinkFull
	}
	return LinkOpen
}

func timePtr(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC()
	return &result
}

func timestamptz(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func (s *Service) linkFromRow(row surveysdb.SurveyShareLink, responses int64) ShareLink {
	return ShareLink{
		ID:            row.ID,
		SurveyID:      row.SurveyID,
		Label:         row.Label,
		Token:         s.linkToken(row.ID),
		Active:        row.Active,
		State:         linkState(row.Active, timePtr(row.ExpiresAt), row.MaxResponses, responses, time.Now().UTC()),
		ExpiresAt:     timePtr(row.ExpiresAt),
		MaxResponses:  row.MaxResponses,
		ResponseCount: responses,
		Version:       row.Version,
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
	}
}

func cleanLinkInput(input LinkInput) (LinkInput, error) {
	input.Label = optional.Trimmed(input.Label)
	if input.Label != nil && len([]rune(*input.Label)) > maxLinkLabelRunes {
		return input, apperror.InvalidField("link label is too long")
	}
	if input.MaxResponses != nil && (*input.MaxResponses < 1 || *input.MaxResponses > maxLinkResponses) {
		return input, apperror.InvalidField("maxResponses must be positive")
	}
	return input, nil
}

// CreateLink adds an active share link. Reading and managing links needs surveys.manage because the token grants
// the right to submit.
func (s *Service) CreateLink(
	ctx context.Context,
	p authorization.Principal,
	surveyID uuid.UUID,
	input LinkInput,
	requestID *uuid.UUID,
) (ShareLink, error) {
	if !p.Has(authorization.SurveysManage) {
		return ShareLink{}, apperror.PermissionDenied
	}
	input, err := cleanLinkInput(input)
	if err != nil {
		return ShareLink{}, err
	}
	if input.ExpiresAt != nil && !input.ExpiresAt.After(time.Now()) {
		return ShareLink{}, apperror.InvalidField("expiresAt must be in the future")
	}
	var link ShareLink
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := surveysdb.New(tx)
		if _, err := q.GetSurveyForUpdate(ctx, surveyID); errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		} else if err != nil {
			return err
		}
		id := ids.New()
		row, err := q.CreateSurveyShareLink(
			ctx,
			surveysdb.CreateSurveyShareLinkParams{
				ID:           id,
				SurveyID:     surveyID,
				Label:        input.Label,
				TokenDigest:  security.DigestToken(s.linkToken(id)),
				ExpiresAt:    timestamptz(input.ExpiresAt),
				MaxResponses: input.MaxResponses,
			},
		)
		if err != nil {
			return err
		}
		link = s.linkFromRow(row, 0)
		actor := p.AccountID
		return audit.Write(
			ctx,
			tx,
			audit.Event{
				ActorAccountID: &actor,
				Action:         "survey.share_link_created",
				ResourceType:   "survey_share_link",
				ResourceID:     &id,
				RequestID:      requestID,
			},
		)
	})
	return link, err
}

// ListLinks returns the share links of a survey, oldest first.
func (s *Service) ListLinks(ctx context.Context, p authorization.Principal, surveyID uuid.UUID) ([]ShareLink, error) {
	if !p.Has(authorization.SurveysManage) {
		return nil, apperror.PermissionDenied
	}
	q := surveysdb.New(s.pool)
	if _, err := q.GetSurvey(ctx, surveyID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := q.ListSurveyShareLinks(ctx, surveyID)
	if err != nil {
		return nil, err
	}
	result := make([]ShareLink, 0, len(rows))
	for _, row := range rows {
		result = append(result, s.linkFromRow(linkRow(row), row.ResponseCount))
	}
	return result, nil
}

func linkRow(row surveysdb.ListSurveyShareLinksRow) surveysdb.SurveyShareLink {
	return surveysdb.SurveyShareLink{
		ID:           row.ID,
		SurveyID:     row.SurveyID,
		Label:        row.Label,
		TokenDigest:  row.TokenDigest,
		Active:       row.Active,
		ExpiresAt:    row.ExpiresAt,
		MaxResponses: row.MaxResponses,
		Version:      row.Version,
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
	}
}

// UpdateLink replaces label, expiry, response limit and the active flag.
func (s *Service) UpdateLink(
	ctx context.Context,
	p authorization.Principal,
	surveyID, linkID uuid.UUID,
	input LinkInput,
	requestID *uuid.UUID,
) (ShareLink, error) {
	if !p.Has(authorization.SurveysManage) {
		return ShareLink{}, apperror.PermissionDenied
	}
	input, err := cleanLinkInput(input)
	if err != nil {
		return ShareLink{}, err
	}
	if input.ExpectedVersion < 1 {
		return ShareLink{}, apperror.InvalidField("expectedVersion must be positive")
	}
	var link ShareLink
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := surveysdb.New(tx)
		if _, err := q.GetSurveyShareLink(
			ctx,
			surveysdb.GetSurveyShareLinkParams{ID: linkID, SurveyID: surveyID},
		); errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		} else if err != nil {
			return err
		}
		row, err := q.UpdateSurveyShareLink(
			ctx,
			surveysdb.UpdateSurveyShareLinkParams{
				ID:              linkID,
				SurveyID:        surveyID,
				Label:           input.Label,
				ExpiresAt:       timestamptz(input.ExpiresAt),
				MaxResponses:    input.MaxResponses,
				Active:          input.Active,
				ExpectedVersion: input.ExpectedVersion,
			},
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperror.StaleWrite
		} else if err != nil {
			return err
		}
		responses, err := q.CountSurveyShareLinkResponses(ctx, &linkID)
		if err != nil {
			return err
		}
		link = s.linkFromRow(row, responses)
		actor := p.AccountID
		return audit.Write(
			ctx,
			tx,
			audit.Event{
				ActorAccountID: &actor,
				Action:         "survey.share_link_updated",
				ResourceType:   "survey_share_link",
				ResourceID:     &linkID,
				RequestID:      requestID,
				ChangedFields:  []string{"label", "expiresAt", "maxResponses", "active"},
			},
		)
	})
	return link, err
}

// DeleteLink removes a share link. Its responses are kept without the link reference.
func (s *Service) DeleteLink(
	ctx context.Context,
	p authorization.Principal,
	surveyID, linkID uuid.UUID,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.SurveysManage) {
		return apperror.PermissionDenied
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		deleted, err := surveysdb.New(tx).DeleteSurveyShareLink(
			ctx,
			surveysdb.DeleteSurveyShareLinkParams{ID: linkID, SurveyID: surveyID},
		)
		if err != nil {
			return err
		}
		if deleted == 0 {
			return apperror.NotFound
		}
		actor := p.AccountID
		return audit.Write(
			ctx,
			tx,
			audit.Event{
				ActorAccountID: &actor,
				Action:         "survey.share_link_deleted",
				ResourceType:   "survey_share_link",
				ResourceID:     &linkID,
				RequestID:      requestID,
			},
		)
	})
}

func linkUnavailable(code, message string) error {
	return apperror.New(http.StatusGone, code, message)
}

// checkLink decides whether a link currently accepts the survey; the order of the checks is the order of precedence.
func checkLink(row surveysdb.GetSurveyShareLinkByDigestRow, now time.Time) error {
	if Status(row.SurveyStatus) != StatusPublished {
		return linkUnavailable("survey_unavailable", "The survey is not accepting answers")
	}
	switch linkState(row.Active, timePtr(row.ExpiresAt), row.MaxResponses, row.ResponseCount, now) {
	case LinkInactive:
		return linkUnavailable("survey_link_inactive", "This survey link has been deactivated")
	case LinkExpired:
		return linkUnavailable("survey_link_expired", "This survey link has expired")
	case LinkFull:
		return linkUnavailable("survey_link_full", "This survey link has reached its response limit")
	}
	return nil
}

// PublicByLink returns the published survey behind a share link. A link of a survey that was never published is
// reported as not found.
func (s *Service) PublicByLink(ctx context.Context, token string) (PublicSurvey, error) {
	q := surveysdb.New(s.pool)
	row, err := q.GetSurveyShareLinkByDigest(ctx, security.DigestToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicSurvey{}, apperror.NotFound
	}
	if err != nil {
		return PublicSurvey{}, err
	}
	if err = checkLink(row, time.Now().UTC()); err != nil {
		return PublicSurvey{}, err
	}
	questions, err := loadQuestions(ctx, q, row.SurveyVersionID)
	if err != nil {
		return PublicSurvey{}, err
	}
	// Responses through a link never identify a person, whatever the survey's own setting says.
	return PublicSurvey{
		Title:        row.Title,
		Introduction: row.Introduction,
		Anonymous:    true,
		Questions:    questions,
		ExpiresAt:    timePtr(row.ExpiresAt),
	}, nil
}

// SubmitByLink stores an anonymous response and records the link as its source. The survey is share-locked and the
// link row locked, so the response limit holds under concurrent submissions and an edit cannot interleave.
func (s *Service) SubmitByLink(ctx context.Context, token string, answers []AnswerInput) error {
	digest := security.DigestToken(token)
	known, err := surveysdb.New(s.pool).GetSurveyShareLinkByDigest(ctx, digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if !s.linkSubmits.Take(known.LinkID.String(), time.Now().UTC()) {
		return apperror.RateLimited(
			"rate_limited",
			"This survey link receives too many submissions, try again shortly",
			LinkSubmitWindow,
		)
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := surveysdb.New(tx)
		if _, err := q.LockSurveyShared(ctx, known.SurveyID); errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		} else if err != nil {
			return err
		}
		if _, err := q.LockSurveyShareLink(ctx, known.LinkID); errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		} else if err != nil {
			return err
		}
		row, err := q.GetSurveyShareLinkByDigest(ctx, digest)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		}
		if err != nil {
			return err
		}
		if err = checkLink(row, time.Now().UTC()); err != nil {
			return err
		}
		linkID := row.LinkID
		return storeResponse(ctx, q, row.SurveyVersionID, SourceLink, &linkID, nil, answers)
	})
}
