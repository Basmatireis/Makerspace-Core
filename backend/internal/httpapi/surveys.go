package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/oapi-codegen/nullable"
)

// Anonymous share-link endpoints are limited per client address (a limiter bounded in memory, see ratelimit) on top of
// the per-link limit inside the surveys service.
const (
	surveyLinkViewsPerWindow   = 120
	surveyLinkSubmitsPerWindow = 20
	surveyLinkWindow           = time.Minute
)

func (s *Server) takeSurveyLinkRequest(ctx context.Context, limiter *ratelimit.Limiter) error {
	if limiter.Take(ratelimit.KeyForIP(sourceAddress(ctx)), time.Now().UTC()) {
		return nil
	}
	return apperror.RateLimited("rate_limited", "Too many survey requests, try again shortly", surveyLinkWindow)
}

func (s *Server) ListSurveys(
	ctx context.Context,
	request openapi.ListSurveysRequestObject,
) (openapi.ListSurveysResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	params := surveys.ListParams{Search: request.Params.Search}
	if request.Params.Status != nil {
		status := surveys.Status(*request.Params.Status)
		params.Status = &status
	}
	if request.Params.Sort != nil {
		params.Sort = string(*request.Params.Sort)
	}
	params.Descending = request.Params.Order == nil || *request.Params.Order == openapi.Desc
	if request.Params.Limit != nil {
		params.Limit = int32(*request.Params.Limit)
	}
	if request.Params.Offset != nil {
		params.Skip = int32(*request.Params.Offset)
	}
	items, total, err := s.surveys.List(ctx, p, params)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.Survey, len(items))
	for i, item := range items {
		result[i] = surveyDTO(item)
	}
	return openapi.ListSurveys200JSONResponse{Items: result, Total: total}, nil
}

func (s *Server) CreateSurvey(
	ctx context.Context,
	request openapi.CreateSurveyRequestObject,
) (openapi.CreateSurveyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.surveys.Create(ctx, p, surveyInput(request.Body.Name, request.Body.Title, request.Body.Anonymous,
		request.Body.Description, request.Body.Introduction, request.Body.Questions, 0), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateSurvey201JSONResponse(surveyDTO(value)), nil
}

func (s *Server) GetSurvey(
	ctx context.Context,
	request openapi.GetSurveyRequestObject,
) (openapi.GetSurveyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.surveys.Get(ctx, p, request.SurveyId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSurvey200JSONResponse(surveyDTO(value)), nil
}

func (s *Server) UpdateSurvey(
	ctx context.Context,
	request openapi.UpdateSurveyRequestObject,
) (openapi.UpdateSurveyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.surveys.Update(
		ctx,
		p,
		request.SurveyId,
		surveyInput(
			request.Body.Name,
			request.Body.Title,
			request.Body.Anonymous,
			request.Body.Description,
			request.Body.Introduction,
			request.Body.Questions,
			request.Body.ExpectedVersion,
		),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSurvey200JSONResponse(surveyDTO(value)), nil
}

func (s *Server) PublishSurvey(
	ctx context.Context,
	request openapi.PublishSurveyRequestObject,
) (openapi.PublishSurveyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.surveys.Publish(ctx, p, request.SurveyId, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PublishSurvey200JSONResponse(surveyDTO(value)), nil
}

func (s *Server) CloseSurvey(
	ctx context.Context,
	request openapi.CloseSurveyRequestObject,
) (openapi.CloseSurveyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.surveys.Close(ctx, p, request.SurveyId, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CloseSurvey200JSONResponse(surveyDTO(value)), nil
}

func (s *Server) ReopenSurvey(
	ctx context.Context,
	request openapi.ReopenSurveyRequestObject,
) (openapi.ReopenSurveyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.surveys.Reopen(ctx, p, request.SurveyId, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReopenSurvey200JSONResponse(surveyDTO(value)), nil
}

func (s *Server) DeleteSurvey(
	ctx context.Context,
	request openapi.DeleteSurveyRequestObject,
) (openapi.DeleteSurveyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.surveys.Delete(ctx, p, request.SurveyId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteSurvey204Response{}, nil
}

func (s *Server) UpdateSurveyTrigger(
	ctx context.Context,
	request openapi.UpdateSurveyTriggerRequestObject,
) (openapi.UpdateSurveyTriggerResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.surveys.UpdateTrigger(
		ctx,
		p,
		request.SurveyId,
		request.Body.Enabled,
		int32(request.Body.DelaySeconds),
		int32(request.Body.CooldownDays),
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSurveyTrigger200JSONResponse(surveyTriggerDTO(value)), nil
}

func (s *Server) GetPublicSurvey(
	ctx context.Context,
	request openapi.GetPublicSurveyRequestObject,
) (openapi.GetPublicSurveyResponseObject, error) {
	value, err := s.surveys.Public(ctx, request.Token)
	if err != nil {
		return nil, err
	}
	return openapi.GetPublicSurvey200JSONResponse(publicSurveyDTO(value)), nil
}

func (s *Server) SubmitPublicSurvey(
	ctx context.Context,
	request openapi.SubmitPublicSurveyRequestObject,
) (openapi.SubmitPublicSurveyResponseObject, error) {
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.surveys.Submit(ctx, request.Token, surveyAnswers(*request.Body)); err != nil {
		return nil, err
	}
	return openapi.SubmitPublicSurvey204Response{}, nil
}

func (s *Server) GetPublicSurveyByLink(
	ctx context.Context,
	request openapi.GetPublicSurveyByLinkRequestObject,
) (openapi.GetPublicSurveyByLinkResponseObject, error) {
	if err := s.takeSurveyLinkRequest(ctx, s.surveyLinkViews); err != nil {
		return nil, err
	}
	value, err := s.surveys.PublicByLink(ctx, request.Token)
	if err != nil {
		return nil, err
	}
	return openapi.GetPublicSurveyByLink200JSONResponse(publicSurveyDTO(value)), nil
}

func (s *Server) SubmitPublicSurveyByLink(
	ctx context.Context,
	request openapi.SubmitPublicSurveyByLinkRequestObject,
) (openapi.SubmitPublicSurveyByLinkResponseObject, error) {
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.takeSurveyLinkRequest(ctx, s.surveyLinkSubmits); err != nil {
		return nil, err
	}
	if err := s.surveys.SubmitByLink(ctx, request.Token, surveyAnswers(*request.Body)); err != nil {
		return nil, err
	}
	return openapi.SubmitPublicSurveyByLink204Response{}, nil
}

func surveyAnswers(body openapi.SubmitSurveyResponse) []surveys.AnswerInput {
	answers := make([]surveys.AnswerInput, len(body.Answers))
	for i, answer := range body.Answers {
		answers[i] = surveys.AnswerInput{
			QuestionID:   answer.QuestionId,
			OptionIDs:    append([]openapi.UUIDv7(nil), answer.OptionIds...),
			TextValue:    nullableStringPointer(answer.TextValue),
			NumericValue: nullableInt32Pointer(answer.NumericValue),
			BooleanValue: nullableBoolPointer(answer.BooleanValue),
		}
	}
	return answers
}

func surveyInput(
	name, title string,
	anonymous bool,
	description, introduction nullable.Nullable[string],
	questions []openapi.SurveyQuestionInput,
	expected int64,
) surveys.Input {
	converted := make([]surveys.QuestionInput, len(questions))
	for i, question := range questions {
		options := make([]surveys.OptionInput, len(question.Options))
		for j, option := range question.Options {
			options[j] = surveys.OptionInput{Label: option.Label}
		}
		converted[i] = surveys.QuestionInput{
			Kind:      surveys.QuestionKind(question.Kind),
			Prompt:    question.Prompt,
			Required:  question.Required,
			Options:   options,
			RatingMin: nullableInt32Pointer(question.RatingMin),
			RatingMax: nullableInt32Pointer(question.RatingMax),
		}
		if question.Condition.IsSpecified() && !question.Condition.IsNull() {
			condition := question.Condition.GetOrEmpty()
			converted[i].Condition = &surveys.ConditionInput{
				QuestionPosition: condition.QuestionPosition,
				Operator:         surveys.ConditionOperator(condition.Operator),
				Number:           nullableInt32Pointer(condition.NumericValue),
				Boolean:          nullableBoolPointer(condition.BooleanValue),
			}
			if condition.OptionPositions != nil {
				converted[i].Condition.OptionPositions = *condition.OptionPositions
			}
		}
	}
	return surveys.Input{Name: name, Title: title, Anonymous: anonymous, Description: nullableStringLike(description),
		Introduction: nullableStringLike(introduction), Questions: converted, ExpectedVersion: expected}
}

func nullableStringLike(value nullable.Nullable[string]) *string {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	result := value.GetOrEmpty()
	return &result
}

func nullableInt32Pointer(value nullable.Nullable[int]) *int32 {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	result := int32(value.GetOrEmpty())
	return &result
}

func nullableBoolPointer(value nullable.Nullable[bool]) *bool {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	result := value.GetOrEmpty()
	return &result
}

func surveyDTO(value surveys.Survey) openapi.Survey {
	questions := surveyQuestionsDTO(value.Questions)
	trigger := nullablePointer[surveys.Trigger, openapi.SurveyTrigger](value.Trigger, surveyTriggerDTO)
	return openapi.Survey{
		Id:          value.ID,
		Name:        value.Name,
		Description: nullablePointer[string](value.Description, func(v string) string { return v }),
		Status:      openapi.SurveyStatus(value.Status),
		Anonymous:   value.Anonymous,
		Title:       value.Title,
		Introduction: nullablePointer[string](
			value.Introduction,
			func(v string) string { return v },
		),
		Revision:      int(value.Revision),
		Questions:     questions,
		Trigger:       trigger,
		ResponseCount: value.ResponseCount,
		LinkCount:     value.LinkCount,
		Version:       value.Version,
		CreatedAt:     value.CreatedAt,
		UpdatedAt:     value.UpdatedAt,
	}
}

func surveyQuestionsDTO(values []surveys.Question) []openapi.SurveyQuestion {
	result := make([]openapi.SurveyQuestion, len(values))
	for i, value := range values {
		options := make([]openapi.SurveyOption, len(value.Options))
		for j, option := range value.Options {
			options[j] = openapi.SurveyOption{Id: option.ID, Label: option.Label, Position: int(option.Position)}
		}
		result[i] = openapi.SurveyQuestion{
			Id:       value.ID,
			Kind:     openapi.SurveyQuestionKind(value.Kind),
			Prompt:   value.Prompt,
			Required: value.Required,
			Position: int(
				value.Position,
			),
			Options:   options,
			RatingMin: nullablePointer[int32](value.RatingMin, func(v int32) int { return int(v) }),
			RatingMax: nullablePointer[int32](value.RatingMax, func(v int32) int { return int(v) }),
			Condition: nullablePointer[surveys.Condition](value.Condition, surveyConditionDTO),
		}
	}
	return result
}

func surveyTriggerDTO(value surveys.Trigger) openapi.SurveyTrigger {
	return openapi.SurveyTrigger{Id: value.ID, Kind: openapi.SurveyTriggerKind(value.Kind), Enabled: value.Enabled,
		DelaySeconds: int(value.DelaySeconds), CooldownDays: int(value.CooldownDays), Version: value.Version}
}

func publicSurveyDTO(value surveys.PublicSurvey) openapi.PublicSurvey {
	return openapi.PublicSurvey{
		Title:        value.Title,
		Introduction: nullablePointer[string](value.Introduction, func(v string) string { return v }),
		Anonymous:    value.Anonymous,
		Questions:    surveyQuestionsDTO(value.Questions),
		ExpiresAt:    nullablePointer[time.Time](value.ExpiresAt, func(v time.Time) time.Time { return v }),
	}
}

func surveyConditionDTO(value surveys.Condition) openapi.SurveyCondition {
	optionIDs := make([]openapi.UUIDv7, len(value.OptionIDs))
	copy(optionIDs, value.OptionIDs)
	result := openapi.SurveyCondition{
		QuestionId:       value.QuestionID,
		QuestionPosition: int(value.QuestionPosition),
		Operator:         openapi.SurveyConditionOperator(value.Operator),
		OptionIds:        optionIDs,
	}
	if value.Number != nil {
		result.NumericValue = nullable.NewNullableWithValue(int(*value.Number))
	}
	if value.Boolean != nil {
		result.BooleanValue = nullable.NewNullableWithValue(*value.Boolean)
	}
	return result
}
