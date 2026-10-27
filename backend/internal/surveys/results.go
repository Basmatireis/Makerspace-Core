package surveys

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	surveysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/surveys/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// MaxTextAnswerPage bounds one page of free-text answers per question.
const MaxTextAnswerPage = 200

// ResultFilter narrows aggregates and exports. From and To are inclusive calendar days; responses store the day of
// submission, not the time.
type ResultFilter struct {
	From, To *time.Time
	Source   *ResponseSource
	LinkID   *uuid.UUID
}

type filterParams struct {
	surveyID uuid.UUID
	from, to pgtype.Date
	source   *string
	linkID   *uuid.UUID
}

func (f ResultFilter) params(surveyID uuid.UUID) (filterParams, error) {
	if f.From != nil && f.To != nil && f.To.Before(*f.From) {
		return filterParams{}, apperror.InvalidField("to must not be before from")
	}
	if f.Source != nil && *f.Source != SourceInvitation && *f.Source != SourceLink {
		return filterParams{}, apperror.InvalidField("source is invalid")
	}
	if f.LinkID != nil && f.Source != nil && *f.Source != SourceLink {
		return filterParams{}, apperror.InvalidField("a link filter requires the link source")
	}
	result := filterParams{surveyID: surveyID, linkID: f.LinkID}
	if f.From != nil {
		result.from = pgtype.Date{Time: *f.From, Valid: true}
	}
	if f.To != nil {
		result.to = pgtype.Date{Time: *f.To, Valid: true}
	}
	if f.Source != nil {
		value := string(*f.Source)
		result.source = &value
	}
	return result, nil
}

// LinkResponseCount is the number of responses that came through one share link.
type LinkResponseCount struct {
	LinkID    uuid.UUID
	Label     *string
	Responses int64
}

// Overview summarizes the responses of one survey.
type Overview struct {
	SurveyID                        uuid.UUID
	InvitationsSent, Responses      int64
	ResponsesByInvitation           int64
	ResponsesByLink                 int64
	ResponseRate                    *float64
	FirstResponseOn, LastResponseOn *time.Time
	Links                           []LinkResponseCount
}

type OptionResult struct {
	OptionID uuid.UUID
	Label    string
	Position int32
	Count    int64
}

type RatingBucket struct {
	Value int32
	Count int64
}

type RatingResult struct {
	Min, Max     int32
	Distribution []RatingBucket
	Mean         *float64
}

type TextAnswer struct {
	Text        string
	SubmittedOn time.Time
}

type TextResult struct {
	Total int64
	Items []TextAnswer
}

type YesNoResult struct{ Yes, No int64 }

// QuestionResult holds the aggregate of one question; exactly the section matching its kind is set.
type QuestionResult struct {
	QuestionID  uuid.UUID
	Position    int32
	Kind        QuestionKind
	Prompt      string
	Respondents int64
	Options     []OptionResult
	Rating      *RatingResult
	YesNo       *YesNoResult
	Text        *TextResult
}

type QuestionResults struct {
	SurveyID       uuid.UUID
	TotalResponses int64
	Questions      []QuestionResult
}

func datePtr(value pgtype.Date) *time.Time {
	if !value.Valid {
		return nil
	}
	return &value.Time
}

func (s *Service) requireRead(p authorization.Principal) error {
	if !p.Has(authorization.SurveysRead) {
		return apperror.PermissionDenied
	}
	return nil
}

// Overview returns response totals; it is not time-filtered.
func (s *Service) Overview(ctx context.Context, p authorization.Principal, surveyID uuid.UUID) (Overview, error) {
	if err := s.requireRead(p); err != nil {
		return Overview{}, err
	}
	q := surveysdb.New(s.pool)
	if _, err := q.GetSurvey(ctx, surveyID); errors.Is(err, pgx.ErrNoRows) {
		return Overview{}, apperror.NotFound
	} else if err != nil {
		return Overview{}, err
	}
	invitations, err := q.GetSurveyInvitationCounts(ctx, surveyID)
	if err != nil {
		return Overview{}, err
	}
	totals, err := q.GetSurveyResponseOverview(ctx, surveyID)
	if err != nil {
		return Overview{}, err
	}
	links, err := q.ListSurveyShareLinks(ctx, surveyID)
	if err != nil {
		return Overview{}, err
	}
	result := Overview{
		SurveyID:              surveyID,
		InvitationsSent:       invitations.Sent,
		Responses:             totals.Total,
		ResponsesByInvitation: totals.ByInvitation,
		ResponsesByLink:       totals.ByLink,
		FirstResponseOn:       datePtr(totals.FirstOn),
		LastResponseOn:        datePtr(totals.LastOn),
		Links:                 make([]LinkResponseCount, 0, len(links)),
	}
	if invitations.Sent > 0 {
		rate := min(float64(totals.ByInvitation)/float64(invitations.Sent), 1)
		result.ResponseRate = &rate
	}
	for _, link := range links {
		result.Links = append(
			result.Links,
			LinkResponseCount{LinkID: link.ID, Label: link.Label, Responses: link.ResponseCount},
		)
	}
	return result, nil
}

// QuestionResults aggregates the answers per question of the survey's current version. Answers are joined by
// question id across versions; because a survey with responses can no longer be edited, a survey has one version.
func (s *Service) QuestionResults(
	ctx context.Context,
	p authorization.Principal,
	surveyID uuid.UUID,
	filter ResultFilter,
	textLimit, textOffset int32,
) (QuestionResults, error) {
	if err := s.requireRead(p); err != nil {
		return QuestionResults{}, err
	}
	params, err := filter.params(surveyID)
	if err != nil {
		return QuestionResults{}, err
	}
	if textLimit < 1 || textLimit > MaxTextAnswerPage {
		textLimit = 50
	}
	if textOffset < 0 {
		textOffset = 0
	}
	q := surveysdb.New(s.pool)
	survey, err := q.GetSurvey(ctx, surveyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return QuestionResults{}, apperror.NotFound
	} else if err != nil {
		return QuestionResults{}, err
	}
	questions, err := loadQuestions(ctx, q, survey.SurveyVersionID)
	if err != nil {
		return QuestionResults{}, err
	}
	total, err := q.CountFilteredSurveyResponses(ctx, surveysdb.CountFilteredSurveyResponsesParams(params.sqlc()))
	if err != nil {
		return QuestionResults{}, err
	}
	aggregates, err := q.ListSurveyAnswerAggregates(ctx, surveysdb.ListSurveyAnswerAggregatesParams(params.sqlc()))
	if err != nil {
		return QuestionResults{}, err
	}
	respondentRows, err := q.ListSurveyQuestionRespondents(
		ctx,
		surveysdb.ListSurveyQuestionRespondentsParams(params.sqlc()),
	)
	if err != nil {
		return QuestionResults{}, err
	}
	respondents := map[uuid.UUID]int64{}
	for _, row := range respondentRows {
		respondents[row.QuestionID] = row.Respondents
	}
	result := QuestionResults{
		SurveyID:       surveyID,
		TotalResponses: total,
		Questions:      make([]QuestionResult, 0, len(questions)),
	}
	for _, question := range questions {
		item := QuestionResult{
			QuestionID:  question.ID,
			Position:    question.Position,
			Kind:        question.Kind,
			Prompt:      question.Prompt,
			Respondents: respondents[question.ID],
			Options:     []OptionResult{},
		}
		switch question.Kind {
		case QuestionSingleChoice, QuestionMultipleChoice:
			counts := map[uuid.UUID]int64{}
			for _, row := range aggregates {
				if row.QuestionID == question.ID && row.OptionID != nil {
					counts[*row.OptionID] += row.AnswerCount
				}
			}
			for _, option := range question.Options {
				item.Options = append(
					item.Options,
					OptionResult{OptionID: option.ID, Label: option.Label, Position: option.Position, Count: counts[option.ID]},
				)
			}
		case QuestionRating:
			item.Rating = ratingResult(question, aggregates)
		case QuestionYesNo:
			item.YesNo = &YesNoResult{}
			for _, row := range aggregates {
				if row.QuestionID != question.ID || row.BooleanValue == nil {
					continue
				}
				if *row.BooleanValue {
					item.YesNo.Yes += row.AnswerCount
				} else {
					item.YesNo.No += row.AnswerCount
				}
			}
		case QuestionFreeText:
			item.Text, err = s.textResult(ctx, q, question.ID, params, textLimit, textOffset)
			if err != nil {
				return QuestionResults{}, err
			}
		}
		result.Questions = append(result.Questions, item)
	}
	return result, nil
}

func ratingResult(question Question, aggregates []surveysdb.ListSurveyAnswerAggregatesRow) *RatingResult {
	if question.RatingMin == nil || question.RatingMax == nil {
		return nil
	}
	result := &RatingResult{Min: *question.RatingMin, Max: *question.RatingMax}
	counts := map[int32]int64{}
	var answers, sum int64
	for _, row := range aggregates {
		if row.QuestionID == question.ID && row.NumericValue != nil {
			counts[*row.NumericValue] += row.AnswerCount
			answers += row.AnswerCount
			sum += int64(*row.NumericValue) * row.AnswerCount
		}
	}
	for value := result.Min; value <= result.Max; value++ {
		result.Distribution = append(result.Distribution, RatingBucket{Value: value, Count: counts[value]})
	}
	if answers > 0 {
		mean := float64(sum) / float64(answers)
		result.Mean = &mean
	}
	return result
}

func (s *Service) textResult(
	ctx context.Context,
	q *surveysdb.Queries,
	questionID uuid.UUID,
	params filterParams,
	limit, offset int32,
) (*TextResult, error) {
	total, err := q.CountSurveyTextAnswers(
		ctx,
		surveysdb.CountSurveyTextAnswersParams{
			QuestionID: questionID,
			FromDate:   params.from,
			ToDate:     params.to,
			Source:     params.source,
			LinkID:     params.linkID,
		},
	)
	if err != nil {
		return nil, err
	}
	rows, err := q.ListSurveyTextAnswers(
		ctx,
		surveysdb.ListSurveyTextAnswersParams{
			QuestionID: questionID,
			FromDate:   params.from,
			ToDate:     params.to,
			Source:     params.source,
			LinkID:     params.linkID,
			PageLimit:  limit,
			PageOffset: offset,
		},
	)
	if err != nil {
		return nil, err
	}
	result := &TextResult{Total: total, Items: make([]TextAnswer, 0, len(rows))}
	for _, row := range rows {
		if row.TextValue != nil {
			result.Items = append(result.Items, TextAnswer{Text: *row.TextValue, SubmittedOn: row.SubmittedOn.Time})
		}
	}
	return result, nil
}

type sqlcFilter struct {
	SurveyID uuid.UUID
	FromDate pgtype.Date
	ToDate   pgtype.Date
	Source   *string
	LinkID   *uuid.UUID
}

func (f filterParams) sqlc() sqlcFilter {
	return sqlcFilter{SurveyID: f.surveyID, FromDate: f.from, ToDate: f.to, Source: f.source, LinkID: f.linkID}
}

// ExportCSV renders one row per response and one column per question. The Person column exists only for surveys that
// are not anonymous; anonymous surveys and every link response carry no identity at all. Every cell passes csvSafe.
func (s *Service) ExportCSV(
	ctx context.Context,
	p authorization.Principal,
	surveyID uuid.UUID,
	filter ResultFilter,
	requestID *uuid.UUID,
) ([]byte, error) {
	if err := s.requireRead(p); err != nil {
		return nil, err
	}
	params, err := filter.params(surveyID)
	if err != nil {
		return nil, err
	}
	q := surveysdb.New(s.pool)
	survey, err := q.GetSurvey(ctx, surveyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	questions, err := loadQuestions(ctx, q, survey.SurveyVersionID)
	if err != nil {
		return nil, err
	}
	responses, err := q.ListSurveyResponsesForExport(ctx, surveysdb.ListSurveyResponsesForExportParams(params.sqlc()))
	if err != nil {
		return nil, err
	}
	answerRows, err := q.ListSurveyAnswersForExport(ctx, surveysdb.ListSurveyAnswersForExportParams(params.sqlc()))
	if err != nil {
		return nil, err
	}
	type cellKey struct{ response, question uuid.UUID }
	cells := map[cellKey][]string{}
	for _, row := range answerRows {
		key := cellKey{row.ResponseID, row.QuestionID}
		switch {
		case row.OptionLabel != nil:
			cells[key] = append(cells[key], *row.OptionLabel)
		case row.TextValue != nil:
			cells[key] = append(cells[key], *row.TextValue)
		case row.NumericValue != nil:
			cells[key] = append(cells[key], strconv.Itoa(int(*row.NumericValue)))
		case row.BooleanValue != nil && *row.BooleanValue:
			cells[key] = append(cells[key], "yes")
		case row.BooleanValue != nil:
			cells[key] = append(cells[key], "no")
		}
	}
	var out bytes.Buffer
	writer := csv.NewWriter(&out)
	header := []string{"Submitted on", "Source"}
	if !survey.Anonymous {
		header = append(header, "Person")
	}
	for _, question := range questions {
		header = append(header, question.Prompt)
	}
	write := func(record []string) error {
		for index := range record {
			record[index] = csvSafe(record[index])
		}
		return writer.Write(record)
	}
	if err = write(header); err != nil {
		return nil, err
	}
	for _, response := range responses {
		record := []string{response.SubmittedOn.Time.Format(time.DateOnly), response.Source}
		if !survey.Anonymous {
			person := ""
			if response.FirstName != nil && response.LastName != nil {
				person = strings.TrimSpace(*response.FirstName + " " + *response.LastName)
			}
			record = append(record, person)
		}
		for _, question := range questions {
			record = append(record, strings.Join(cells[cellKey{response.ID, question.ID}], "; "))
		}
		if err = write(record); err != nil {
			return nil, err
		}
	}
	writer.Flush()
	if err = writer.Error(); err != nil {
		return nil, err
	}
	// Exports can contain names of identified respondents, so they leave a trace in the audit log.
	actor := p.AccountID
	if err = audit.Write(
		ctx,
		s.pool,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "survey.results_exported",
			ResourceType:   "survey",
			ResourceID:     &surveyID,
			RequestID:      requestID,
		},
	); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
