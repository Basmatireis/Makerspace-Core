package httpapi

import (
	"bytes"
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) ListSurveyShareLinks(
	ctx context.Context,
	request openapi.ListSurveyShareLinksRequestObject,
) (openapi.ListSurveyShareLinksResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	links, err := s.surveys.ListLinks(ctx, p, request.SurveyId)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SurveyShareLink, len(links))
	for i, link := range links {
		items[i] = surveyShareLinkDTO(link)
	}
	return openapi.ListSurveyShareLinks200JSONResponse{Items: items}, nil
}

func (s *Server) CreateSurveyShareLink(
	ctx context.Context,
	request openapi.CreateSurveyShareLinkRequestObject,
) (openapi.CreateSurveyShareLinkResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	link, err := s.surveys.CreateLink(
		ctx,
		p,
		request.SurveyId,
		surveys.LinkInput{
			Label:        nullableStringLike(request.Body.Label),
			ExpiresAt:    nullableTime(request.Body.ExpiresAt),
			MaxResponses: nullableInt32Pointer(request.Body.MaxResponses),
			Active:       true,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateSurveyShareLink201JSONResponse(surveyShareLinkDTO(link)), nil
}

func (s *Server) UpdateSurveyShareLink(
	ctx context.Context,
	request openapi.UpdateSurveyShareLinkRequestObject,
) (openapi.UpdateSurveyShareLinkResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	link, err := s.surveys.UpdateLink(
		ctx,
		p,
		request.SurveyId,
		request.LinkId,
		surveys.LinkInput{
			Label:           nullableStringLike(request.Body.Label),
			ExpiresAt:       nullableTime(request.Body.ExpiresAt),
			MaxResponses:    nullableInt32Pointer(request.Body.MaxResponses),
			Active:          request.Body.Active,
			ExpectedVersion: request.Body.ExpectedVersion,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSurveyShareLink200JSONResponse(surveyShareLinkDTO(link)), nil
}

func (s *Server) DeleteSurveyShareLink(
	ctx context.Context,
	request openapi.DeleteSurveyShareLinkRequestObject,
) (openapi.DeleteSurveyShareLinkResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.surveys.DeleteLink(ctx, p, request.SurveyId, request.LinkId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteSurveyShareLink204Response{}, nil
}

func (s *Server) GetSurveyResultsOverview(
	ctx context.Context,
	request openapi.GetSurveyResultsOverviewRequestObject,
) (openapi.GetSurveyResultsOverviewResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.surveys.Overview(ctx, p, request.SurveyId)
	if err != nil {
		return nil, err
	}
	links := make([]openapi.SurveyLinkResponseCount, len(value.Links))
	for i, link := range value.Links {
		links[i] = openapi.SurveyLinkResponseCount{
			LinkId:    link.LinkID,
			Label:     nullableString(link.Label),
			Responses: link.Responses,
		}
	}
	result := openapi.SurveyResultsOverview{
		SurveyId:              value.SurveyID,
		InvitationsSent:       value.InvitationsSent,
		Responses:             value.Responses,
		ResponsesByInvitation: value.ResponsesByInvitation,
		ResponsesByLink:       value.ResponsesByLink,
		ResponseRate:          nullableValue(value.ResponseRate),
		FirstResponseOn:       dateNullable(value.FirstResponseOn),
		LastResponseOn:        dateNullable(value.LastResponseOn),
		Links:                 links,
	}
	return openapi.GetSurveyResultsOverview200JSONResponse(result), nil
}

func (s *Server) GetSurveyQuestionResults(
	ctx context.Context,
	request openapi.GetSurveyQuestionResultsRequestObject,
) (openapi.GetSurveyQuestionResultsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	var limit, offset int32
	if request.Params.TextLimit != nil {
		limit = int32(*request.Params.TextLimit)
	}
	if request.Params.TextOffset != nil {
		offset = int32(*request.Params.TextOffset)
	}
	value, err := s.surveys.QuestionResults(
		ctx,
		p,
		request.SurveyId,
		surveyResultFilter(request.Params.From, request.Params.To, request.Params.Source, request.Params.LinkId),
		limit,
		offset,
	)
	if err != nil {
		return nil, err
	}
	questions := make([]openapi.SurveyQuestionResult, len(value.Questions))
	for i, question := range value.Questions {
		questions[i] = surveyQuestionResultDTO(question)
	}
	return openapi.GetSurveyQuestionResults200JSONResponse{
		SurveyId:       value.SurveyID,
		TotalResponses: value.TotalResponses,
		Questions:      questions,
	}, nil
}

func (s *Server) ExportSurveyResultsCSV(
	ctx context.Context,
	request openapi.ExportSurveyResultsCSVRequestObject,
) (openapi.ExportSurveyResultsCSVResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	content, err := s.surveys.ExportCSV(
		ctx,
		p,
		request.SurveyId,
		surveyResultFilter(request.Params.From, request.Params.To, request.Params.Source, request.Params.LinkId),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.ExportSurveyResultsCSV200TextcsvResponse{
		Body:          bytes.NewReader(content),
		ContentLength: int64(len(content)),
		Headers: openapi.ExportSurveyResultsCSV200ResponseHeaders{
			ContentDisposition: `attachment; filename="survey-results-` + request.SurveyId.String() + `.csv"`,
		},
	}, nil
}

func surveyResultFilter(
	from, to *openapi_types.Date,
	source *openapi.SurveyResponseSource,
	linkID *uuid.UUID,
) surveys.ResultFilter {
	filter := surveys.ResultFilter{LinkID: linkID}
	if from != nil {
		filter.From = &from.Time
	}
	if to != nil {
		filter.To = &to.Time
	}
	if source != nil {
		value := surveys.ResponseSource(*source)
		filter.Source = &value
	}
	return filter
}

func dateNullable(value *time.Time) nullable.Nullable[openapi_types.Date] {
	if value == nil {
		return nullable.NewNullNullable[openapi_types.Date]()
	}
	return nullable.NewNullableWithValue(openapi_types.Date{Time: *value})
}

func nullableWith[T any](value T) nullable.Nullable[T] { return nullable.NewNullableWithValue(value) }

func surveyShareLinkDTO(value surveys.ShareLink) openapi.SurveyShareLink {
	return openapi.SurveyShareLink{
		Id:            value.ID,
		SurveyId:      value.SurveyID,
		Label:         nullableString(value.Label),
		Token:         value.Token,
		Active:        value.Active,
		State:         openapi.SurveyShareLinkState(value.State),
		ExpiresAt:     nullableTimeValue(value.ExpiresAt),
		MaxResponses:  nullableInt32Value(value.MaxResponses),
		ResponseCount: value.ResponseCount,
		Version:       value.Version,
		CreatedAt:     value.CreatedAt,
		UpdatedAt:     value.UpdatedAt,
	}
}

func surveyQuestionResultDTO(value surveys.QuestionResult) openapi.SurveyQuestionResult {
	options := make([]openapi.SurveyOptionResult, len(value.Options))
	for i, option := range value.Options {
		options[i] = openapi.SurveyOptionResult{
			OptionId: option.OptionID,
			Label:    option.Label,
			Position: int(option.Position),
			Count:    option.Count,
		}
	}
	result := openapi.SurveyQuestionResult{
		QuestionId:  value.QuestionID,
		Position:    int(value.Position),
		Kind:        openapi.SurveyQuestionKind(value.Kind),
		Prompt:      value.Prompt,
		Respondents: value.Respondents,
		Options:     options,
		Rating:      nullable.NewNullNullable[openapi.SurveyRatingResult](),
		YesNo:       nullable.NewNullNullable[openapi.SurveyYesNoResult](),
		Text:        nullable.NewNullNullable[openapi.SurveyTextResult](),
	}
	if value.Rating != nil {
		buckets := make([]openapi.SurveyRatingBucket, len(value.Rating.Distribution))
		for i, bucket := range value.Rating.Distribution {
			buckets[i] = openapi.SurveyRatingBucket{Value: int(bucket.Value), Count: bucket.Count}
		}
		result.Rating = nullableWith(openapi.SurveyRatingResult{
			Min:          int(value.Rating.Min),
			Max:          int(value.Rating.Max),
			Distribution: buckets,
			Mean:         nullableValue(value.Rating.Mean),
		})
	}
	if value.YesNo != nil {
		result.YesNo = nullableWith(openapi.SurveyYesNoResult{Yes: value.YesNo.Yes, No: value.YesNo.No})
	}
	if value.Text != nil {
		items := make([]openapi.SurveyTextAnswer, len(value.Text.Items))
		for i, item := range value.Text.Items {
			items[i] = openapi.SurveyTextAnswer{Text: item.Text, SubmittedOn: openapi_types.Date{Time: item.SubmittedOn}}
		}
		result.Text = nullableWith(openapi.SurveyTextResult{Total: value.Text.Total, Items: items})
	}
	return result
}
