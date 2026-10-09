package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) ListSurveys(ctx context.Context, _ openapi.ListSurveysRequestObject) (openapi.ListSurveysResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.surveys.List(ctx, p)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.Survey, len(items))
	for i, item := range items {
		result[i] = surveyDTO(item)
	}
	return openapi.ListSurveys200JSONResponse{Items: result}, nil
}

func (s *Server) CreateSurvey(ctx context.Context, request openapi.CreateSurveyRequestObject) (openapi.CreateSurveyResponseObject, error) {
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

func (s *Server) GetSurvey(ctx context.Context, request openapi.GetSurveyRequestObject) (openapi.GetSurveyResponseObject, error) {
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

func (s *Server) UpdateSurvey(ctx context.Context, request openapi.UpdateSurveyRequestObject) (openapi.UpdateSurveyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.surveys.Update(ctx, p, request.SurveyId, surveyInput(request.Body.Name, request.Body.Title, request.Body.Anonymous,
		request.Body.Description, request.Body.Introduction, request.Body.Questions, request.Body.ExpectedVersion), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSurvey200JSONResponse(surveyDTO(value)), nil
}

func (s *Server) PublishSurvey(ctx context.Context, request openapi.PublishSurveyRequestObject) (openapi.PublishSurveyResponseObject, error) {
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

func (s *Server) CloseSurvey(ctx context.Context, request openapi.CloseSurveyRequestObject) (openapi.CloseSurveyResponseObject, error) {
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

func (s *Server) UpdateSurveyTrigger(ctx context.Context, request openapi.UpdateSurveyTriggerRequestObject) (openapi.UpdateSurveyTriggerResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.surveys.UpdateTrigger(ctx, p, request.SurveyId, request.Body.Enabled, int32(request.Body.DelaySeconds),
		int32(request.Body.CooldownDays), request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSurveyTrigger200JSONResponse(surveyTriggerDTO(value)), nil
}

func (s *Server) GetPublicSurvey(ctx context.Context, request openapi.GetPublicSurveyRequestObject) (openapi.GetPublicSurveyResponseObject, error) {
	value, err := s.surveys.Public(ctx, request.Token)
	if err != nil {
		return nil, err
	}
	return openapi.GetPublicSurvey200JSONResponse(publicSurveyDTO(value)), nil
}

func (s *Server) SubmitPublicSurvey(ctx context.Context, request openapi.SubmitPublicSurveyRequestObject) (openapi.SubmitPublicSurveyResponseObject, error) {
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	answers := make([]surveys.AnswerInput, len(request.Body.Answers))
	for i, answer := range request.Body.Answers {
		answers[i] = surveys.AnswerInput{QuestionID: answer.QuestionId, OptionIDs: append([]openapi.UUIDv7(nil), answer.OptionIds...),
			TextValue: nullableStringPointer(answer.TextValue), NumericValue: nullableInt32Pointer(answer.NumericValue), BooleanValue: nullableBoolPointer(answer.BooleanValue)}
	}
	if err := s.surveys.Submit(ctx, request.Token, answers); err != nil {
		return nil, err
	}
	return openapi.SubmitPublicSurvey204Response{}, nil
}

func surveyInput(name, title string, anonymous bool, description, introduction nullable.Nullable[string], questions []openapi.SurveyQuestionInput, expected int64) surveys.Input {
	converted := make([]surveys.QuestionInput, len(questions))
	for i, question := range questions {
		options := make([]surveys.OptionInput, len(question.Options))
		for j, option := range question.Options {
			options[j] = surveys.OptionInput{Label: option.Label}
		}
		converted[i] = surveys.QuestionInput{Kind: string(question.Kind), Prompt: question.Prompt, Required: question.Required, Options: options,
			RatingMin: nullableInt32Pointer(question.RatingMin), RatingMax: nullableInt32Pointer(question.RatingMax)}
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
	return openapi.Survey{Id: value.ID, Name: value.Name, Description: nullablePointer[string](value.Description, func(v string) string { return v }),
		Status: openapi.SurveyStatus(value.Status), Anonymous: value.Anonymous, Title: value.Title,
		Introduction: nullablePointer[string](value.Introduction, func(v string) string { return v }), Revision: int(value.Revision),
		Questions: questions, Trigger: trigger, Version: value.Version, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
}

func surveyQuestionsDTO(values []surveys.Question) []openapi.SurveyQuestion {
	result := make([]openapi.SurveyQuestion, len(values))
	for i, value := range values {
		options := make([]openapi.SurveyOption, len(value.Options))
		for j, option := range value.Options {
			options[j] = openapi.SurveyOption{Id: option.ID, Label: option.Label, Position: int(option.Position)}
		}
		result[i] = openapi.SurveyQuestion{Id: value.ID, Kind: openapi.SurveyQuestionKind(value.Kind), Prompt: value.Prompt, Required: value.Required,
			Position: int(value.Position), Options: options, RatingMin: nullablePointer[int32](value.RatingMin, func(v int32) int { return int(v) }), RatingMax: nullablePointer[int32](value.RatingMax, func(v int32) int { return int(v) })}
	}
	return result
}

func surveyTriggerDTO(value surveys.Trigger) openapi.SurveyTrigger {
	return openapi.SurveyTrigger{Id: value.ID, Kind: openapi.SurveyTriggerKind(value.Kind), Enabled: value.Enabled,
		DelaySeconds: int(value.DelaySeconds), CooldownDays: int(value.CooldownDays), Version: value.Version}
}

func publicSurveyDTO(value surveys.PublicSurvey) openapi.PublicSurvey {
	return openapi.PublicSurvey{Title: value.Title, Introduction: nullablePointer[string](value.Introduction, func(v string) string { return v }),
		Anonymous: value.Anonymous, Questions: surveyQuestionsDTO(value.Questions), ExpiresAt: value.ExpiresAt}
}
