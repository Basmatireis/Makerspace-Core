package surveys

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	surveysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/surveys/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Notifier interface {
	SendSurveyInvitation(context.Context, string, string, string, time.Time) error
}
type Service struct {
	pool     *pgxpool.Pool
	tokenKey []byte
	notifier Notifier
	// linkSubmits bounds submissions per share link; it is bounded in memory and evicts the least recently used key.
	linkSubmits *ratelimit.Limiter
}

func NewService(pool *pgxpool.Pool, cfg config.Config, notifier Notifier) *Service {
	return &Service{
		pool:        pool,
		tokenKey:    cfg.ChallengeHMACKey,
		notifier:    notifier,
		linkSubmits: ratelimit.New(LinkSubmitsPerWindow, LinkSubmitWindow),
	}
}

type OptionInput struct{ Label string }
type QuestionInput struct {
	Kind                 QuestionKind
	Prompt               string
	Required             bool
	Options              []OptionInput
	RatingMin, RatingMax *int32
	Condition            *ConditionInput
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
	Kind                 QuestionKind
	Prompt               string
	Required             bool
	Position             int32
	Options              []Option
	RatingMin, RatingMax *int32
	Condition            *Condition
}
type Trigger struct {
	ID                         uuid.UUID
	Kind                       TriggerKind
	Enabled                    bool
	DelaySeconds, CooldownDays int32
	Version                    int64
}
type Survey struct {
	ID                   uuid.UUID
	Name                 string
	Description          *string
	Status               Status
	Anonymous            bool
	Title                string
	Introduction         *string
	Revision             int32
	Questions            []Question
	Trigger              *Trigger
	ResponseCount        int64
	LinkCount            int64
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
	ExpiresAt    *time.Time
}

func clean(input Input) (Input, error) {
	input.Name, input.Title = strings.TrimSpace(input.Name), strings.TrimSpace(input.Title)
	if input.Name == "" || len([]rune(input.Name)) > 160 || input.Title == "" || len([]rune(input.Title)) > 200 {
		return input, apperror.InvalidField("name and title are required")
	}
	input.Description = optional.Trimmed(input.Description)
	input.Introduction = optional.Trimmed(input.Introduction)
	if len(input.Questions) < 1 || len(input.Questions) > 100 {
		return input, apperror.InvalidField("a survey needs between 1 and 100 questions")
	}
	for index := range input.Questions {
		q := &input.Questions[index]
		q.Prompt = strings.TrimSpace(q.Prompt)
		if q.Prompt == "" || len([]rune(q.Prompt)) > 1000 {
			return input, apperror.InvalidField("question prompts are required")
		}
		switch q.Kind {
		case QuestionSingleChoice, QuestionMultipleChoice:
			if len(q.Options) < 2 || len(q.Options) > 50 {
				return input, apperror.InvalidField("choice questions need between 2 and 50 options")
			}
			if q.RatingMin != nil || q.RatingMax != nil {
				return input, apperror.InvalidField("only rating questions accept rating bounds")
			}
		case QuestionRating:
			if q.RatingMin == nil || q.RatingMax == nil || *q.RatingMin < 0 || *q.RatingMax > 10 ||
				*q.RatingMin >= *q.RatingMax ||
				len(q.Options) != 0 {
				return input, apperror.InvalidField("rating bounds are invalid")
			}
		case QuestionFreeText, QuestionYesNo:
			if len(q.Options) != 0 || q.RatingMin != nil || q.RatingMax != nil {
				return input, apperror.InvalidField("this question type does not accept options or rating bounds")
			}
		default:
			return input, apperror.InvalidField("question kind is invalid")
		}
		seen := map[string]bool{}
		for optionIndex := range q.Options {
			q.Options[optionIndex].Label = strings.TrimSpace(q.Options[optionIndex].Label)
			label := q.Options[optionIndex].Label
			key := strings.ToLower(label)
			if label == "" || len([]rune(label)) > 500 || seen[key] {
				return input, apperror.InvalidField("choice labels must be unique and non-empty")
			}
			seen[key] = true
		}
	}
	if err := validateConditions(input.Questions); err != nil {
		return input, err
	}
	return input, nil
}

func (s *Service) Create(
	ctx context.Context,
	p authorization.Principal,
	input Input,
	requestID *uuid.UUID,
) (Survey, error) {
	if !p.Has(authorization.SurveysManage) {
		return Survey{}, apperror.PermissionDenied
	}
	var id uuid.UUID
	if err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		id, err = s.CreateTx(ctx, tx, p, input, requestID)
		return err
	}); err != nil {
		return Survey{}, err
	}
	return s.Get(ctx, p, id)
}

// CreateTx is Create inside the caller's transaction; the configuration import uses it.
func (s *Service) CreateTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	input Input,
	requestID *uuid.UUID,
) (uuid.UUID, error) {
	if !p.Has(authorization.SurveysManage) {
		return uuid.Nil, apperror.PermissionDenied
	}
	input, err := clean(input)
	if err != nil {
		return uuid.Nil, err
	}
	q := surveysdb.New(tx)
	id, versionID := ids.New(), ids.New()
	if _, err = q.CreateSurvey(
		ctx,
		surveysdb.CreateSurveyParams{
			ID:          id,
			Name:        input.Name,
			Description: input.Description,
			Anonymous:   input.Anonymous,
		},
	); err != nil {
		return uuid.Nil, err
	}
	if _, err = q.CreateSurveyVersion(
		ctx,
		surveysdb.CreateSurveyVersionParams{
			ID:           versionID,
			SurveyID:     id,
			Revision:     1,
			Title:        input.Title,
			Introduction: input.Introduction,
		},
	); err != nil {
		return uuid.Nil, err
	}
	if err = insertQuestions(ctx, q, versionID, input.Questions); err != nil {
		return uuid.Nil, err
	}
	actor := p.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "survey.created",
			ResourceType:   "survey",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

// insertQuestions stores the questions in order. A condition refers to an earlier question, whose id and option ids
// are known by the time the later question is inserted.
func insertQuestions(ctx context.Context, q *surveysdb.Queries, versionID uuid.UUID, inputs []QuestionInput) error {
	questionIDs := make([]uuid.UUID, len(inputs))
	optionIDs := make([][]uuid.UUID, len(inputs))
	for index, input := range inputs {
		id := ids.New()
		questionIDs[index] = id
		params := surveysdb.CreateSurveyQuestionParams{
			ID:                 id,
			SurveyVersionID:    versionID,
			Kind:               string(input.Kind),
			Prompt:             input.Prompt,
			Required:           input.Required,
			Position:           int32(index + 1),
			RatingMin:          input.RatingMin,
			RatingMax:          input.RatingMax,
			ConditionOptionIds: []string{},
		}
		if condition := input.Condition; condition != nil {
			source := questionIDs[condition.QuestionPosition-1]
			operator := string(condition.Operator)
			params.ConditionQuestionID = &source
			params.ConditionOperator = &operator
			params.ConditionNumber = condition.Number
			params.ConditionBoolean = condition.Boolean
			for _, position := range condition.OptionPositions {
				params.ConditionOptionIds = append(
					params.ConditionOptionIds,
					optionIDs[condition.QuestionPosition-1][position-1].String(),
				)
			}
		}
		if _, err := q.CreateSurveyQuestion(ctx, params); err != nil {
			return err
		}
		for optionIndex, option := range input.Options {
			optionID := ids.New()
			optionIDs[index] = append(optionIDs[index], optionID)
			if _, err := q.CreateSurveyOption(
				ctx,
				surveysdb.CreateSurveyOptionParams{
					ID:         optionID,
					QuestionID: id,
					Label:      option.Label,
					Position:   int32(optionIndex + 1),
				},
			); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) Update(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input Input,
	requestID *uuid.UUID,
) (Survey, error) {
	if !p.Has(authorization.SurveysManage) {
		return Survey{}, apperror.PermissionDenied
	}
	if err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		return s.UpdateTx(ctx, tx, p, id, input, requestID)
	}); err != nil {
		return Survey{}, err
	}
	return s.Get(ctx, p, id)
}

// UpdateTx is Update inside the caller's transaction; the configuration import uses it.
func (s *Service) UpdateTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	input Input,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.SurveysManage) {
		return apperror.PermissionDenied
	}
	input, err := clean(input)
	if err != nil {
		return err
	}
	if input.ExpectedVersion < 1 {
		return apperror.InvalidField("expectedVersion must be positive")
	}
	q := surveysdb.New(tx)
	current, err := q.GetSurveyForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != input.ExpectedVersion {
		return apperror.StaleWrite
	}
	if Status(current.Status) != StatusDraft {
		// A published or closed survey is edited in place, but only while nobody has answered it.
		if err = requireNoResponses(ctx, q, id); err != nil {
			return err
		}
	}
	version, err := q.GetLatestSurveyVersionForUpdate(ctx, id)
	if err != nil {
		return err
	}
	if _, err = q.UpdateSurveyDefinition(
		ctx,
		surveysdb.UpdateSurveyDefinitionParams{
			ID:              id,
			Name:            input.Name,
			Description:     input.Description,
			Anonymous:       input.Anonymous,
			ExpectedVersion: input.ExpectedVersion,
		},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if err != nil {
		return err
	}
	if err = q.UpdateSurveyVersionDefinition(
		ctx,
		surveysdb.UpdateSurveyVersionDefinitionParams{ID: version.ID, Title: input.Title, Introduction: input.Introduction},
	); err != nil {
		return err
	}
	if err = q.DeleteSurveyQuestions(ctx, version.ID); err != nil {
		return err
	}
	if err = insertQuestions(ctx, q, version.ID, input.Questions); err != nil {
		return err
	}
	actor := p.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "survey.updated",
			ResourceType:   "survey",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"name", "description", "anonymous", "title", "introduction", "questions"},
		},
	); err != nil {
		return err
	}
	return nil
}

func (s *Service) Publish(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (Survey, error) {
	if !p.Has(authorization.SurveysManage) {
		return Survey{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Survey{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := surveysdb.New(tx)
	current, err := q.GetSurveyForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Survey{}, apperror.NotFound
	}
	if err != nil {
		return Survey{}, err
	}
	if current.Version != expected || Status(current.Status) != StatusDraft {
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
		return Survey{}, apperror.InvalidField("survey needs questions before publication")
	}
	if _, err = q.PublishSurvey(ctx, surveysdb.PublishSurveyParams{ID: id, ExpectedVersion: expected}); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return Survey{}, apperror.StaleWrite
	} else if err != nil {
		return Survey{}, err
	}
	if err = q.MarkSurveyVersionPublished(ctx, version.ID); err != nil {
		return Survey{}, err
	}
	actor := p.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "survey.published",
			ResourceType:   "survey",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return Survey{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Survey{}, err
	}
	return s.Get(ctx, p, id)
}

func (s *Service) Close(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (Survey, error) {
	if !p.Has(authorization.SurveysManage) {
		return Survey{}, apperror.PermissionDenied
	}
	if expected < 1 {
		return Survey{}, apperror.InvalidField("expectedVersion must be positive")
	}
	if err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		return s.CloseTx(ctx, tx, p, id, expected, requestID)
	}); err != nil {
		return Survey{}, err
	}
	return s.Get(ctx, p, id)
}

// CloseTx is Close inside the caller's transaction; the configuration import uses it.
func (s *Service) CloseTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.SurveysManage) {
		return apperror.PermissionDenied
	}
	if expected < 1 {
		return apperror.InvalidField("expectedVersion must be positive")
	}
	q := surveysdb.New(tx)
	current, err := q.GetSurveyForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	if current.Version != expected || Status(current.Status) != StatusPublished {
		return apperror.StaleWrite
	}
	if _, err = q.CloseSurvey(ctx, surveysdb.CloseSurveyParams{ID: id, ExpectedVersion: expected}); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if err != nil {
		return err
	}
	if err = q.DisableSurveyTriggers(ctx, id); err != nil {
		return err
	}
	if _, err = q.CancelSurveyInvitationsForSurvey(ctx, id); err != nil {
		return err
	}
	actor := p.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "survey.closed",
			ResourceType:   "survey",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"status", "trigger"},
		},
	); err != nil {
		return err
	}
	return nil
}

func (s *Service) UpdateTrigger(
	ctx context.Context,
	p authorization.Principal,
	surveyID uuid.UUID,
	enabled bool,
	delay, cooldown int32,
	expected int64,
	requestID *uuid.UUID,
) (Trigger, error) {
	if !p.Has(authorization.SurveysManage) {
		return Trigger{}, apperror.PermissionDenied
	}
	var result Trigger
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdateTriggerTx(ctx, tx, p, surveyID, enabled, delay, cooldown, expected, requestID)
		return err
	})
	return result, err
}

// UpdateTriggerTx is UpdateTrigger inside the caller's transaction; the configuration import uses it.
func (s *Service) UpdateTriggerTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	surveyID uuid.UUID,
	enabled bool,
	delay, cooldown int32,
	expected int64,
	requestID *uuid.UUID,
) (Trigger, error) {
	if !p.Has(authorization.SurveysManage) {
		return Trigger{}, apperror.PermissionDenied
	}
	if delay < 0 || delay > 604800 || cooldown < 0 || cooldown > 3650 {
		return Trigger{}, apperror.InvalidField("trigger values are invalid")
	}
	q := surveysdb.New(tx)
	survey, err := q.GetSurveyForUpdate(ctx, surveyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Trigger{}, apperror.NotFound
	} else if err != nil {
		return Trigger{}, err
	}
	if enabled && Status(survey.Status) != StatusPublished {
		return Trigger{}, apperror.New(
			http.StatusConflict,
			"survey_not_published",
			"Only a published survey can have an enabled trigger",
		)
	}
	var row surveysdb.SurveyTrigger
	if expected == 0 {
		row, err = q.CreateSurveyTrigger(
			ctx,
			surveysdb.CreateSurveyTriggerParams{
				ID:           ids.New(),
				SurveyID:     surveyID,
				Enabled:      enabled,
				DelaySeconds: delay,
				CooldownDays: cooldown,
			},
		)
	} else {
		row, err = q.UpdateSurveyTrigger(
			ctx,
			surveysdb.UpdateSurveyTriggerParams{
				SurveyID:        surveyID,
				Enabled:         enabled,
				DelaySeconds:    delay,
				CooldownDays:    cooldown,
				ExpectedVersion: expected,
			},
		)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Trigger{}, apperror.StaleWrite
	}
	if err != nil {
		return Trigger{}, err
	}
	actor := p.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "survey.trigger_updated",
			ResourceType:   "survey",
			ResourceID:     &surveyID,
			RequestID:      requestID,
		},
	); err != nil {
		return Trigger{}, err
	}
	return triggerFromRow(row), nil
}

// ListParams filters, sorts and pages the survey table.
type ListParams struct {
	Search      *string
	Status      *Status
	Sort        string // name, status, updatedAt or responseCount
	Descending  bool
	Limit, Skip int32
}

// List returns one page of surveys and the total number of matches.
func (s *Service) List(ctx context.Context, p authorization.Principal, params ListParams) ([]Survey, int64, error) {
	if !p.Has(authorization.SurveysRead) && !p.Has(authorization.SurveysManage) {
		return nil, 0, apperror.PermissionDenied
	}
	if params.Limit < 1 || params.Limit > 200 {
		params.Limit = 50
	}
	if params.Skip < 0 {
		params.Skip = 0
	}
	if !slices.Contains([]string{"name", "status", "updatedAt", "responseCount"}, params.Sort) {
		params.Sort = "updatedAt"
	}
	var status *string
	if params.Status != nil {
		value := string(*params.Status)
		status = &value
	}
	search := optional.Trimmed(params.Search)
	if search != nil && len([]rune(*search)) > 160 {
		return nil, 0, apperror.InvalidField("search is too long")
	}
	q := surveysdb.New(s.pool)
	total, err := q.CountSurveys(ctx, surveysdb.CountSurveysParams{Status: status, Search: search})
	if err != nil {
		return nil, 0, err
	}
	rows, err := q.ListSurveys(
		ctx,
		surveysdb.ListSurveysParams{
			Status:     status,
			Search:     search,
			Sort:       params.Sort,
			Descending: params.Descending,
			PageLimit:  params.Limit,
			PageOffset: params.Skip,
		},
	)
	if err != nil {
		return nil, 0, err
	}
	result := make([]Survey, 0, len(rows))
	for _, row := range rows {
		item, err := s.hydrate(
			ctx,
			row.ID,
			row.Name,
			row.Description,
			Status(row.Status),
			row.Anonymous,
			row.Version,
			row.CreatedAt,
			row.UpdatedAt,
			row.SurveyVersionID,
			row.Revision,
			row.Title,
			row.Introduction,
		)
		if err != nil {
			return nil, 0, err
		}
		item.ResponseCount, item.LinkCount = row.ResponseCount, row.LinkCount
		result = append(result, item)
	}
	return result, total, nil
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
	item, err := s.hydrate(
		ctx,
		row.ID,
		row.Name,
		row.Description,
		Status(row.Status),
		row.Anonymous,
		row.Version,
		row.CreatedAt,
		row.UpdatedAt,
		row.SurveyVersionID,
		row.Revision,
		row.Title,
		row.Introduction,
	)
	item.ResponseCount, item.LinkCount = row.ResponseCount, row.LinkCount
	return item, err
}

func (s *Service) hydrate(
	ctx context.Context,
	id uuid.UUID,
	name string,
	description *string,
	status Status,
	anonymous bool,
	version int64,
	created, updated time.Time,
	versionID uuid.UUID,
	revision int32,
	title string,
	introduction *string,
) (Survey, error) {
	questions, err := loadQuestions(ctx, surveysdb.New(s.pool), versionID)
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
	return Survey{
		ID:           id,
		Name:         name,
		Description:  description,
		Status:       status,
		Anonymous:    anonymous,
		Title:        title,
		Introduction: introduction,
		Revision:     revision,
		Questions:    questions,
		Trigger:      trigger,
		Version:      version,
		CreatedAt:    created,
		UpdatedAt:    updated,
	}, nil
}

// loadQuestions reads the questions of a version with their options and display conditions.
func loadQuestions(ctx context.Context, q *surveysdb.Queries, versionID uuid.UUID) ([]Question, error) {
	rows, err := q.ListSurveyQuestions(ctx, versionID)
	if err != nil {
		return nil, err
	}
	positions := make(map[uuid.UUID]int32, len(rows))
	for _, row := range rows {
		positions[row.ID] = row.Position
	}
	result := make([]Question, 0, len(rows))
	for _, row := range rows {
		options, err := q.ListSurveyOptions(ctx, row.ID)
		if err != nil {
			return nil, err
		}
		item := Question{
			ID:        row.ID,
			Kind:      QuestionKind(row.Kind),
			Prompt:    row.Prompt,
			Required:  row.Required,
			Position:  row.Position,
			RatingMin: row.RatingMin,
			RatingMax: row.RatingMax,
			Options:   make([]Option, 0, len(options)),
		}
		for _, option := range options {
			item.Options = append(item.Options, Option{ID: option.ID, Label: option.Label, Position: option.Position})
		}
		if row.ConditionQuestionID != nil && row.ConditionOperator != nil {
			item.Condition = &Condition{
				QuestionID:       *row.ConditionQuestionID,
				QuestionPosition: positions[*row.ConditionQuestionID],
				Operator:         ConditionOperator(*row.ConditionOperator),
				OptionIDs:        row.ConditionOptionIds,
				Number:           row.ConditionNumber,
				Boolean:          row.ConditionBoolean,
			}
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
		id := ids.New()
		token := s.tokenForID(id)
		due := now.Add(time.Duration(trigger.DelaySeconds) * time.Second)
		if _, err = q.CreateSurveyInvitation(
			ctx,
			surveysdb.CreateSurveyInvitationParams{
				ID:              id,
				SurveyVersionID: trigger.SurveyVersionID,
				PersonID:        &personID,
				VisitID:         &visitID,
				TokenDigest:     security.DigestToken(token),
				RecipientEmail:  trigger.Email,
				DueAt:           due,
				ExpiresAt:       due.Add(14 * 24 * time.Hour),
			},
		); err != nil {
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
		if s.notifier == nil ||
			s.notifier.SendSurveyInvitation(ctx, *row.RecipientEmail, row.Title, token, row.ExpiresAt) != nil {
			code := "provider_error"
			_ = surveysdb.New(s.pool).
				MarkSurveyInvitationFailed(
					ctx,
					surveysdb.MarkSurveyInvitationFailedParams{ID: row.ID, DeliveryFailureCode: &code},
				)
			continue
		}
		if err = surveysdb.New(s.pool).MarkSurveyInvitationSent(ctx, row.ID); err != nil {
			return delivered, err
		}
		delivered++
	}
	return delivered, nil
}

func triggerFromRow(row surveysdb.SurveyTrigger) Trigger {
	return Trigger{
		ID:           row.ID,
		Kind:         TriggerKind(row.Kind),
		Enabled:      row.Enabled,
		DelaySeconds: row.DelaySeconds,
		CooldownDays: row.CooldownDays,
		Version:      row.Version,
	}
}

var _ Notifier = (*notifications.Service)(nil)

var errHasResponses = apperror.New(
	http.StatusConflict,
	"survey_has_responses",
	"The survey already has responses and can no longer be changed or deleted",
)

// requireNoResponses must run with the survey row locked, so no submission slips in between check and change.
func requireNoResponses(ctx context.Context, q *surveysdb.Queries, id uuid.UUID) error {
	has, err := q.SurveyHasResponses(ctx, id)
	if err != nil {
		return err
	}
	if has {
		return errHasResponses
	}
	return nil
}

// Reopen publishes a closed survey again. Its trigger stays disabled until it is re-enabled, and the invitations
// that closing cancelled stay cancelled.
func (s *Service) Reopen(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (Survey, error) {
	if !p.Has(authorization.SurveysManage) {
		return Survey{}, apperror.PermissionDenied
	}
	if expected < 1 {
		return Survey{}, apperror.InvalidField("expectedVersion must be positive")
	}
	if err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := surveysdb.New(tx)
		current, err := q.GetSurveyForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		} else if err != nil {
			return err
		}
		if current.Version != expected || Status(current.Status) != StatusClosed {
			return apperror.StaleWrite
		}
		if _, err = q.ReopenSurvey(ctx, surveysdb.ReopenSurveyParams{ID: id, ExpectedVersion: expected}); err != nil {
			return err
		}
		actor := p.AccountID
		return audit.Write(
			ctx,
			tx,
			audit.Event{
				ActorAccountID: &actor,
				Action:         "survey.reopened",
				ResourceType:   "survey",
				ResourceID:     &id,
				RequestID:      requestID,
				ChangedFields:  []string{"status"},
			},
		)
	}); err != nil {
		return Survey{}, err
	}
	return s.Get(ctx, p, id)
}

// Delete hard-deletes a survey that has no responses, together with its versions, questions, trigger, share links
// and invitations (the foreign keys cascade). Responses are the only thing that keeps a survey alive.
func (s *Service) Delete(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	if !p.Has(authorization.SurveysManage) {
		return apperror.PermissionDenied
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := surveysdb.New(tx)
		if _, err := q.GetSurveyForUpdate(ctx, id); errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		} else if err != nil {
			return err
		}
		if err := requireNoResponses(ctx, q, id); err != nil {
			return err
		}
		if _, err := q.DeleteSurvey(ctx, id); err != nil {
			return err
		}
		actor := p.AccountID
		return audit.Write(
			ctx,
			tx,
			audit.Event{
				ActorAccountID: &actor,
				Action:         "survey.deleted",
				ResourceType:   "survey",
				ResourceID:     &id,
				RequestID:      requestID,
			},
		)
	})
}
