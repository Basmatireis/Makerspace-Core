package surveys

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	surveysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/surveys/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Notifier interface {
	SendSurveyInvitation(context.Context, string, string, string, time.Time) error
}
type Service struct {
	pool     *pgxpool.Pool
	tokenKey []byte
	notifier Notifier
}

func NewService(pool *pgxpool.Pool, cfg config.Config, notifier Notifier) *Service {
	return &Service{pool: pool, tokenKey: cfg.ChallengeHMACKey, notifier: notifier}
}

type OptionInput struct{ Label string }
type QuestionInput struct {
	Kind, Prompt         string
	Required             bool
	Options              []OptionInput
	RatingMin, RatingMax *int32
}
type Input struct {
	Name, Title               string
	Description, Introduction *string
	Anonymous                 bool
	Questions                 []QuestionInput
	ExpectedVersion           int64
}
type Option struct {
	ID       uuid.UUID
	Label    string
	Position int32
}
type Question struct {
	ID                   uuid.UUID
	Kind, Prompt         string
	Required             bool
	Position             int32
	Options              []Option
	RatingMin, RatingMax *int32
}
type Trigger struct {
	ID                         uuid.UUID
	Kind                       string
	Enabled                    bool
	DelaySeconds, CooldownDays int32
	Version                    int64
}
type Survey struct {
	ID                   uuid.UUID
	Name                 string
	Description          *string
	Status               string
	Anonymous            bool
	Title                string
	Introduction         *string
	Revision             int32
	Questions            []Question
	Trigger              *Trigger
	Version              int64
	CreatedAt, UpdatedAt time.Time
}
type AnswerInput struct {
	QuestionID   uuid.UUID
	OptionIDs    []uuid.UUID
	TextValue    *string
	NumericValue *int32
	BooleanValue *bool
}
type PublicSurvey struct {
	Title        string
	Introduction *string
	Anonymous    bool
	Questions    []Question
	ExpiresAt    time.Time
}

func clean(input Input) (Input, error) {
	input.Name, input.Title = strings.TrimSpace(input.Name), strings.TrimSpace(input.Title)
	if input.Name == "" || len([]rune(input.Name)) > 160 || input.Title == "" || len([]rune(input.Title)) > 200 {
		return input, validation("name and title are required")
	}
	input.Description = cleanOptional(input.Description)
	input.Introduction = cleanOptional(input.Introduction)
	if len(input.Questions) < 1 || len(input.Questions) > 100 {
		return input, validation("a survey needs between 1 and 100 questions")
	}
	for index := range input.Questions {
		q := &input.Questions[index]
		q.Prompt = strings.TrimSpace(q.Prompt)
		if q.Prompt == "" || len([]rune(q.Prompt)) > 1000 {
			return input, validation("question prompts are required")
		}
		switch q.Kind {
		case "single_choice", "multiple_choice":
			if len(q.Options) < 2 || len(q.Options) > 50 {
				return input, validation("choice questions need between 2 and 50 options")
			}
			if q.RatingMin != nil || q.RatingMax != nil {
				return input, validation("only rating questions accept rating bounds")
			}
		case "rating":
			if q.RatingMin == nil || q.RatingMax == nil || *q.RatingMin < 0 || *q.RatingMax > 10 || *q.RatingMin >= *q.RatingMax || len(q.Options) != 0 {
				return input, validation("rating bounds are invalid")
			}
		case "free_text", "yes_no":
			if len(q.Options) != 0 || q.RatingMin != nil || q.RatingMax != nil {
				return input, validation("this question type does not accept options or rating bounds")
			}
		default:
			return input, validation("question kind is invalid")
		}
		seen := map[string]bool{}
		for optionIndex := range q.Options {
			q.Options[optionIndex].Label = strings.TrimSpace(q.Options[optionIndex].Label)
			label := q.Options[optionIndex].Label
			key := strings.ToLower(label)
			if label == "" || len([]rune(label)) > 500 || seen[key] {
				return input, validation("choice labels must be unique and non-empty")
			}
			seen[key] = true
		}
	}
	return input, nil
}

func (s *Service) Create(ctx context.Context, p authorization.Principal, input Input, requestID *uuid.UUID) (Survey, error) {
	if !p.Has(authorization.SurveysManage) {
		return Survey{}, apperror.PermissionDenied
	}
	input, err := clean(input)
	if err != nil {
		return Survey{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Survey{}, err
	}
	defer tx.Rollback(ctx)
	q := surveysdb.New(tx)
	id, versionID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err = q.CreateSurvey(ctx, surveysdb.CreateSurveyParams{ID: id, Name: input.Name, Description: input.Description, Anonymous: input.Anonymous}); err != nil {
		return Survey{}, err
	}
	if _, err = q.CreateSurveyVersion(ctx, surveysdb.CreateSurveyVersionParams{ID: versionID, SurveyID: id, Revision: 1, Title: input.Title, Introduction: input.Introduction}); err != nil {
		return Survey{}, err
	}
	if err = insertQuestions(ctx, q, versionID, input.Questions); err != nil {
		return Survey{}, err
	}
	actor := p.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "survey.created", ResourceType: "survey", ResourceID: &id, RequestID: requestID}); err != nil {
		return Survey{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Survey{}, err
	}
	return s.Get(ctx, p, id)
}

func insertQuestions(ctx context.Context, q *surveysdb.Queries, versionID uuid.UUID, inputs []QuestionInput) error {
	for index, input := range inputs {
		id := uuid.Must(uuid.NewV7())
		if _, err := q.CreateSurveyQuestion(ctx, surveysdb.CreateSurveyQuestionParams{ID: id, SurveyVersionID: versionID, Kind: input.Kind, Prompt: input.Prompt, Required: input.Required, Position: int32(index + 1), RatingMin: input.RatingMin, RatingMax: input.RatingMax}); err != nil {
			return err
		}
		for optionIndex, option := range input.Options {
			if _, err := q.CreateSurveyOption(ctx, surveysdb.CreateSurveyOptionParams{ID: uuid.Must(uuid.NewV7()), QuestionID: id, Label: option.Label, Position: int32(optionIndex + 1)}); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) Update(ctx context.Context, p authorization.Principal, id uuid.UUID, input Input, requestID *uuid.UUID) (Survey, error) {
	if !p.Has(authorization.SurveysManage) {
		return Survey{}, apperror.PermissionDenied
	}
	input, err := clean(input)
	if err != nil {
		return Survey{}, err
	}
	if input.ExpectedVersion < 1 {
		return Survey{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Survey{}, err
	}
	defer tx.Rollback(ctx)
	q := surveysdb.New(tx)
	current, err := q.GetSurveyForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Survey{}, apperror.NotFound
	}
	if err != nil {
		return Survey{}, err
	}
	if current.Version != input.ExpectedVersion || current.Status != "draft" {
		return Survey{}, apperror.StaleWrite
	}
	version, err := q.GetLatestSurveyVersionForUpdate(ctx, id)
	if err != nil {
		return Survey{}, err
	}
	if _, err = q.UpdateSurveyDraft(ctx, surveysdb.UpdateSurveyDraftParams{ID: id, Name: input.Name, Description: input.Description, Anonymous: input.Anonymous, ExpectedVersion: input.ExpectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return Survey{}, apperror.StaleWrite
	} else if err != nil {
		return Survey{}, err
	}
	if err = q.UpdateSurveyVersionDraft(ctx, surveysdb.UpdateSurveyVersionDraftParams{ID: version.ID, Title: input.Title, Introduction: input.Introduction}); err != nil {
		return Survey{}, err
	}
	if err = q.DeleteSurveyQuestions(ctx, version.ID); err != nil {
		return Survey{}, err
	}
	if err = insertQuestions(ctx, q, version.ID, input.Questions); err != nil {
		return Survey{}, err
	}
	actor := p.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "survey.updated", ResourceType: "survey", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "description", "anonymous", "title", "introduction", "questions"}}); err != nil {
		return Survey{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Survey{}, err
	}
	return s.Get(ctx, p, id)
}

func (s *Service) Publish(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (Survey, error) {
	if !p.Has(authorization.SurveysManage) {
		return Survey{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Survey{}, err
	}
	defer tx.Rollback(ctx)
	q := surveysdb.New(tx)
	current, err := q.GetSurveyForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Survey{}, apperror.NotFound
	}
	if err != nil {
		return Survey{}, err
	}
	if current.Version != expected || current.Status != "draft" {
		return Survey{}, apperror.StaleWrite
	}
	version, err := q.GetLatestSurveyVersionForUpdate(ctx, id)
	if err != nil {
		return Survey{}, err
	}
	questions, err := q.ListSurveyQuestions(ctx, version.ID)
	if err != nil {
		return Survey{}, err
	}
	if len(questions) == 0 {
		return Survey{}, validation("survey needs questions before publication")
	}
	if _, err = q.PublishSurvey(ctx, surveysdb.PublishSurveyParams{ID: id, ExpectedVersion: expected}); errors.Is(err, pgx.ErrNoRows) {
		return Survey{}, apperror.StaleWrite
	} else if err != nil {
		return Survey{}, err
	}
	if err = q.MarkSurveyVersionPublished(ctx, version.ID); err != nil {
		return Survey{}, err
	}
	actor := p.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "survey.published", ResourceType: "survey", ResourceID: &id, RequestID: requestID}); err != nil {
		return Survey{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Survey{}, err
	}
	return s.Get(ctx, p, id)
}

func (s *Service) Close(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (Survey, error) {
	if !p.Has(authorization.SurveysManage) {
		return Survey{}, apperror.PermissionDenied
	}
	if expected < 1 {
		return Survey{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Survey{}, err
	}
	defer tx.Rollback(ctx)
	q := surveysdb.New(tx)
	current, err := q.GetSurveyForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Survey{}, apperror.NotFound
	} else if err != nil {
		return Survey{}, err
	}
	if current.Version != expected || current.Status != "published" {
		return Survey{}, apperror.StaleWrite
	}
	if _, err = q.CloseSurvey(ctx, surveysdb.CloseSurveyParams{ID: id, ExpectedVersion: expected}); errors.Is(err, pgx.ErrNoRows) {
		return Survey{}, apperror.StaleWrite
	} else if err != nil {
		return Survey{}, err
	}
	if err = q.DisableSurveyTriggers(ctx, id); err != nil {
		return Survey{}, err
	}
	if _, err = q.CancelSurveyInvitationsForSurvey(ctx, id); err != nil {
		return Survey{}, err
	}
	actor := p.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "survey.closed", ResourceType: "survey", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"status", "trigger"}}); err != nil {
		return Survey{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Survey{}, err
	}
	return s.Get(ctx, p, id)
}

func (s *Service) UpdateTrigger(ctx context.Context, p authorization.Principal, surveyID uuid.UUID, enabled bool, delay, cooldown int32, expected int64, requestID *uuid.UUID) (Trigger, error) {
	if !p.Has(authorization.SurveysManage) {
		return Trigger{}, apperror.PermissionDenied
	}
	if delay < 0 || delay > 604800 || cooldown < 0 || cooldown > 3650 {
		return Trigger{}, validation("trigger values are invalid")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Trigger{}, err
	}
	defer tx.Rollback(ctx)
	q := surveysdb.New(tx)
	survey, err := q.GetSurveyForUpdate(ctx, surveyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Trigger{}, apperror.NotFound
	} else if err != nil {
		return Trigger{}, err
	}
	if enabled && survey.Status != "published" {
		return Trigger{}, apperror.New(409, "survey_not_published", "Only a published survey can have an enabled trigger")
	}
	var row surveysdb.SurveyTrigger
	if expected == 0 {
		row, err = q.CreateSurveyTrigger(ctx, surveysdb.CreateSurveyTriggerParams{ID: uuid.Must(uuid.NewV7()), SurveyID: surveyID, Enabled: enabled, DelaySeconds: delay, CooldownDays: cooldown})
	} else {
		row, err = q.UpdateSurveyTrigger(ctx, surveysdb.UpdateSurveyTriggerParams{SurveyID: surveyID, Enabled: enabled, DelaySeconds: delay, CooldownDays: cooldown, ExpectedVersion: expected})
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Trigger{}, apperror.StaleWrite
	}
	if err != nil {
		return Trigger{}, err
	}
	actor := p.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "survey.trigger_updated", ResourceType: "survey", ResourceID: &surveyID, RequestID: requestID}); err != nil {
		return Trigger{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Trigger{}, err
	}
	return triggerFromRow(row), nil
}

func (s *Service) List(ctx context.Context, p authorization.Principal) ([]Survey, error) {
	if !p.Has(authorization.SurveysRead) && !p.Has(authorization.SurveysManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := surveysdb.New(s.pool).ListSurveys(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Survey, 0, len(rows))
	for _, row := range rows {
		item, err := s.hydrate(ctx, row.ID, row.Name, row.Description, row.Status, row.Anonymous, row.Version, row.CreatedAt, row.UpdatedAt, row.SurveyVersionID, row.Revision, row.Title, row.Introduction)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}
func (s *Service) Get(ctx context.Context, p authorization.Principal, id uuid.UUID) (Survey, error) {
	if !p.Has(authorization.SurveysRead) && !p.Has(authorization.SurveysManage) {
		return Survey{}, apperror.PermissionDenied
	}
	row, err := surveysdb.New(s.pool).GetSurvey(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Survey{}, apperror.NotFound
	}
	if err != nil {
		return Survey{}, err
	}
	return s.hydrate(ctx, row.ID, row.Name, row.Description, row.Status, row.Anonymous, row.Version, row.CreatedAt, row.UpdatedAt, row.SurveyVersionID, row.Revision, row.Title, row.Introduction)
}
func (s *Service) hydrate(ctx context.Context, id uuid.UUID, name string, description *string, status string, anonymous bool, version int64, created, updated time.Time, versionID uuid.UUID, revision int32, title string, introduction *string) (Survey, error) {
	questions, err := s.questions(ctx, versionID)
	if err != nil {
		return Survey{}, err
	}
	var trigger *Trigger
	row, err := surveysdb.New(s.pool).GetSurveyTrigger(ctx, id)
	if err == nil {
		value := triggerFromRow(row)
		trigger = &value
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Survey{}, err
	}
	return Survey{ID: id, Name: name, Description: description, Status: status, Anonymous: anonymous, Title: title, Introduction: introduction, Revision: revision, Questions: questions, Trigger: trigger, Version: version, CreatedAt: created, UpdatedAt: updated}, nil
}
func (s *Service) questions(ctx context.Context, versionID uuid.UUID) ([]Question, error) {
	q := surveysdb.New(s.pool)
	rows, err := q.ListSurveyQuestions(ctx, versionID)
	if err != nil {
		return nil, err
	}
	result := make([]Question, 0, len(rows))
	for _, row := range rows {
		options, err := q.ListSurveyOptions(ctx, row.ID)
		if err != nil {
			return nil, err
		}
		item := Question{ID: row.ID, Kind: row.Kind, Prompt: row.Prompt, Required: row.Required, Position: row.Position, RatingMin: row.RatingMin, RatingMax: row.RatingMax, Options: make([]Option, 0, len(options))}
		for _, option := range options {
			item.Options = append(item.Options, Option{ID: option.ID, Label: option.Label, Position: option.Position})
		}
		result = append(result, item)
	}
	return result, nil
}

func (s *Service) tokenForID(id uuid.UUID) string {
	mac := hmac.New(sha256.New, s.tokenKey)
	_, _ = mac.Write(id[:])
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Service) CreatePostVisitInvitations(ctx context.Context, tx pgx.Tx, personID, visitID uuid.UUID) error {
	q := surveysdb.New(tx)
	triggers, err := q.ListEligiblePostVisitTriggers(ctx, personID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, trigger := range triggers {
		if trigger.Email == nil {
			continue
		}
		id := uuid.Must(uuid.NewV7())
		token := s.tokenForID(id)
		due := now.Add(time.Duration(trigger.DelaySeconds) * time.Second)
		if _, err = q.CreateSurveyInvitation(ctx, surveysdb.CreateSurveyInvitationParams{ID: id, SurveyVersionID: trigger.SurveyVersionID, PersonID: &personID, VisitID: &visitID, TokenDigest: security.DigestToken(token), RecipientEmail: trigger.Email, DueAt: due, ExpiresAt: due.Add(14 * 24 * time.Hour)}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) CancelPostVisitInvitations(ctx context.Context, tx pgx.Tx, visitID uuid.UUID) error {
	_, err := surveysdb.New(tx).CancelSurveyInvitationsForVisit(ctx, &visitID)
	return err
}

func (s *Service) DeliverDue(ctx context.Context, limit int32) (int, error) {
	if limit < 1 || limit > 1000 {
		limit = 25
	}
	rows, err := surveysdb.New(s.pool).ClaimDueSurveyInvitations(ctx, limit)
	if err != nil {
		return 0, err
	}
	delivered := 0
	for _, row := range rows {
		token := s.tokenForID(row.ID)
		if row.RecipientEmail == nil {
			continue
		}
		if s.notifier == nil || s.notifier.SendSurveyInvitation(ctx, *row.RecipientEmail, row.Title, token, row.ExpiresAt) != nil {
			code := "provider_error"
			_ = surveysdb.New(s.pool).MarkSurveyInvitationFailed(ctx, surveysdb.MarkSurveyInvitationFailedParams{ID: row.ID, DeliveryFailureCode: &code})
			continue
		}
		if err = surveysdb.New(s.pool).MarkSurveyInvitationSent(ctx, row.ID); err != nil {
			return delivered, err
		}
		delivered++
	}
	return delivered, nil
}

func (s *Service) Public(ctx context.Context, token string) (PublicSurvey, error) {
	row, err := surveysdb.New(s.pool).GetPublicSurveyInvitation(ctx, security.DigestToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicSurvey{}, apperror.NotFound
	}
	if err != nil {
		return PublicSurvey{}, err
	}
	if time.Now().UTC().After(row.ExpiresAt) {
		return PublicSurvey{}, apperror.New(410, "survey_invitation_expired", "Survey invitation has expired")
	}
	if row.Status == "redeemed" || row.Status == "cancelled" || row.Status == "expired" {
		return PublicSurvey{}, apperror.New(410, "survey_invitation_unavailable", "Survey invitation is no longer available")
	}
	questions, err := s.questions(ctx, row.SurveyVersionID)
	if err != nil {
		return PublicSurvey{}, err
	}
	return PublicSurvey{Title: row.Title, Introduction: row.Introduction, Anonymous: row.Anonymous, Questions: questions, ExpiresAt: row.ExpiresAt}, nil
}

func (s *Service) Submit(ctx context.Context, token string, answers []AnswerInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := surveysdb.New(tx)
	invitation, err := q.GetPublicSurveyInvitationForUpdate(ctx, security.DigestToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if time.Now().UTC().After(invitation.ExpiresAt) {
		return apperror.New(410, "survey_invitation_expired", "Survey invitation has expired")
	}
	if invitation.Status == "redeemed" {
		return apperror.New(409, "survey_already_submitted", "Survey response was already submitted")
	}
	if invitation.Status == "cancelled" || invitation.Status == "expired" {
		return apperror.New(410, "survey_invitation_unavailable", "Survey invitation is no longer available")
	}
	questions, err := q.ListSurveyQuestions(ctx, invitation.SurveyVersionID)
	if err != nil {
		return err
	}
	answerMap := map[uuid.UUID]AnswerInput{}
	for _, answer := range answers {
		if _, exists := answerMap[answer.QuestionID]; exists {
			return validation("each question may be answered once")
		}
		answerMap[answer.QuestionID] = answer
	}
	responseID := uuid.Must(uuid.NewV7())
	var personID *uuid.UUID
	if !invitation.Anonymous {
		personID = invitation.PersonID
	}
	vienna, _ := time.LoadLocation("Europe/Vienna")
	today := time.Now().In(vienna)
	if _, err = q.CreateSurveyResponse(ctx, surveysdb.CreateSurveyResponseParams{ID: responseID, SurveyVersionID: invitation.SurveyVersionID, SubmittedOn: pgtype.Date{Time: today, Valid: true}, IdentifiedPersonID: personID}); err != nil {
		return err
	}
	for _, question := range questions {
		answer, exists := answerMap[question.ID]
		if !exists {
			if question.Required {
				return validation("all required questions must be answered")
			}
			continue
		}
		if err = storeAnswer(ctx, q, responseID, question, answer); err != nil {
			return err
		}
		delete(answerMap, question.ID)
	}
	if len(answerMap) > 0 {
		return validation("answer references an unknown question")
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

func storeAnswer(ctx context.Context, q *surveysdb.Queries, responseID uuid.UUID, question surveysdb.SurveyQuestion, answer AnswerInput) error {
	valueCount := 0
	if answer.TextValue != nil {
		valueCount++
	}
	if answer.NumericValue != nil {
		valueCount++
	}
	if answer.BooleanValue != nil {
		valueCount++
	}
	if len(answer.OptionIDs) > 0 {
		valueCount++
	}
	switch question.Kind {
	case "single_choice":
		if valueCount != 1 || len(answer.OptionIDs) != 1 {
			return validation("single-choice answer is invalid")
		}
		return storeOptions(ctx, q, responseID, question.ID, answer.OptionIDs)
	case "multiple_choice":
		if valueCount != 1 || len(answer.OptionIDs) == 0 {
			return validation("multiple-choice answer is invalid")
		}
		return storeOptions(ctx, q, responseID, question.ID, answer.OptionIDs)
	case "free_text":
		if valueCount != 1 || answer.TextValue == nil || strings.TrimSpace(*answer.TextValue) == "" {
			return validation("free-text answer is invalid")
		}
		value := strings.TrimSpace(*answer.TextValue)
		return q.CreateSurveyAnswer(ctx, surveysdb.CreateSurveyAnswerParams{ID: uuid.Must(uuid.NewV7()), ResponseID: responseID, QuestionID: question.ID, TextValue: &value, Position: 1})
	case "rating":
		if valueCount != 1 || answer.NumericValue == nil || question.RatingMin == nil || question.RatingMax == nil || *answer.NumericValue < *question.RatingMin || *answer.NumericValue > *question.RatingMax {
			return validation("rating answer is invalid")
		}
		return q.CreateSurveyAnswer(ctx, surveysdb.CreateSurveyAnswerParams{ID: uuid.Must(uuid.NewV7()), ResponseID: responseID, QuestionID: question.ID, NumericValue: answer.NumericValue, Position: 1})
	case "yes_no":
		if valueCount != 1 || answer.BooleanValue == nil {
			return validation("yes/no answer is invalid")
		}
		return q.CreateSurveyAnswer(ctx, surveysdb.CreateSurveyAnswerParams{ID: uuid.Must(uuid.NewV7()), ResponseID: responseID, QuestionID: question.ID, BooleanValue: answer.BooleanValue, Position: 1})
	}
	return validation("question kind is invalid")
}
func storeOptions(ctx context.Context, q *surveysdb.Queries, responseID, questionID uuid.UUID, optionIDs []uuid.UUID) error {
	options, err := q.ListSurveyOptions(ctx, questionID)
	if err != nil {
		return err
	}
	valid := map[uuid.UUID]bool{}
	for _, option := range options {
		valid[option.ID] = true
	}
	seen := map[uuid.UUID]bool{}
	for index, id := range optionIDs {
		if !valid[id] || seen[id] {
			return validation("choice answer contains an invalid option")
		}
		seen[id] = true
		if err = q.CreateSurveyAnswer(ctx, surveysdb.CreateSurveyAnswerParams{ID: uuid.Must(uuid.NewV7()), ResponseID: responseID, QuestionID: questionID, OptionID: &id, Position: int32(index + 1)}); err != nil {
			return err
		}
	}
	return nil
}
func triggerFromRow(row surveysdb.SurveyTrigger) Trigger {
	return Trigger{ID: row.ID, Kind: row.Kind, Enabled: row.Enabled, DelaySeconds: row.DelaySeconds, CooldownDays: row.CooldownDays, Version: row.Version}
}
func cleanOptional(value *string) *string {
	if value == nil {
		return nil
	}
	clean := strings.TrimSpace(*value)
	if clean == "" {
		return nil
	}
	return &clean
}
func validation(message string) *apperror.Error {
	err := apperror.New(422, "validation_failed", "Request validation failed")
	err.Details["reason"] = message
	return err
}

var _ Notifier = (*notifications.Service)(nil)
