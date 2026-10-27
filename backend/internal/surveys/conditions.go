package surveys

import (
	"net/http"
	"slices"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// ConditionInput is a display condition as submitted: it refers to the source question and its options by position
// because neither has an id before the survey is saved.
type ConditionInput struct {
	QuestionPosition int
	Operator         ConditionOperator
	OptionPositions  []int
	Number           *int32
	Boolean          *bool
}

// Condition is a stored display condition. A question with a condition is shown only when it matches the answer to
// the earlier source question.
type Condition struct {
	QuestionID       uuid.UUID
	QuestionPosition int32
	Operator         ConditionOperator
	OptionIDs        []uuid.UUID
	Number           *int32
	Boolean          *bool
}

// Matches reports whether the answer to the source question satisfies the condition.
func (c Condition) Matches(answer AnswerInput) bool {
	switch c.Operator {
	case ConditionOneOf, ConditionIncludesAny:
		return slices.ContainsFunc(answer.OptionIDs, func(id uuid.UUID) bool { return slices.Contains(c.OptionIDs, id) })
	case ConditionLessEqual:
		return answer.NumericValue != nil && c.Number != nil && *answer.NumericValue <= *c.Number
	case ConditionGreaterEq:
		return answer.NumericValue != nil && c.Number != nil && *answer.NumericValue >= *c.Number
	case ConditionEquals:
		if c.Boolean != nil {
			return answer.BooleanValue != nil && *answer.BooleanValue == *c.Boolean
		}
		return answer.NumericValue != nil && c.Number != nil && *answer.NumericValue == *c.Number
	}
	return false
}

// validateConditions checks every submitted condition against the question it refers to.
func validateConditions(questions []QuestionInput) error {
	for index, question := range questions {
		condition := question.Condition
		if condition == nil {
			continue
		}
		source := condition.QuestionPosition - 1
		if source < 0 || source >= index {
			return apperror.InvalidField("a condition must refer to an earlier question")
		}
		if err := validateConditionAgainst(*condition, questions[source]); err != nil {
			return err
		}
	}
	return nil
}

func validateConditionAgainst(condition ConditionInput, source QuestionInput) error {
	invalid := apperror.InvalidField("the condition does not fit the question it refers to")
	switch source.Kind {
	case QuestionSingleChoice, QuestionMultipleChoice:
		want := ConditionOneOf
		if source.Kind == QuestionMultipleChoice {
			want = ConditionIncludesAny
		}
		if condition.Operator != want || condition.Number != nil || condition.Boolean != nil ||
			len(condition.OptionPositions) == 0 {
			return invalid
		}
		seen := map[int]bool{}
		for _, position := range condition.OptionPositions {
			if position < 1 || position > len(source.Options) || seen[position] {
				return invalid
			}
			seen[position] = true
		}
	case QuestionRating:
		if (condition.Operator != ConditionLessEqual && condition.Operator != ConditionGreaterEq &&
			condition.Operator != ConditionEquals) ||
			len(condition.OptionPositions) != 0 || condition.Boolean != nil || condition.Number == nil ||
			source.RatingMin == nil || source.RatingMax == nil ||
			*condition.Number < *source.RatingMin || *condition.Number > *source.RatingMax {
			return invalid
		}
	case QuestionYesNo:
		if condition.Operator != ConditionEquals || condition.Boolean == nil || condition.Number != nil ||
			len(condition.OptionPositions) != 0 {
			return invalid
		}
	default:
		return invalid
	}
	return nil
}

var errAnswerNotApplicable = apperror.New(
	http.StatusUnprocessableEntity,
	"survey_answer_not_applicable",
	"An answer was given to a question whose condition is not met",
)

// plannedAnswer is a validated answer ready to be stored.
type plannedAnswer struct {
	Question Question
	Answer   AnswerInput
}

// planAnswers evaluates the display conditions in question order and validates the submitted answers against the
// visible questions: a hidden question is never required and an answer to it is rejected. Only validated answers of
// visible questions can satisfy a later condition, so a chain of hidden questions stays hidden.
func planAnswers(questions []Question, answers []AnswerInput) ([]plannedAnswer, error) {
	submitted := make(map[uuid.UUID]AnswerInput, len(answers))
	for _, answer := range answers {
		if _, exists := submitted[answer.QuestionID]; exists {
			return nil, apperror.InvalidField("each question may be answered once")
		}
		submitted[answer.QuestionID] = answer
	}
	known := make(map[uuid.UUID]bool, len(questions))
	for _, question := range questions {
		known[question.ID] = true
	}
	for id := range submitted {
		if !known[id] {
			return nil, apperror.InvalidField("answer references an unknown question")
		}
	}
	accepted := map[uuid.UUID]AnswerInput{}
	planned := make([]plannedAnswer, 0, len(answers))
	for _, question := range questions {
		answer, answered := submitted[question.ID]
		if question.Condition != nil {
			source, sourceAnswered := accepted[question.Condition.QuestionID]
			if !sourceAnswered || !question.Condition.Matches(source) {
				if answered {
					return nil, errAnswerNotApplicable
				}
				continue
			}
		}
		if !answered {
			if question.Required {
				return nil, apperror.InvalidField("all required questions must be answered")
			}
			continue
		}
		normalized, err := validateAnswer(question, answer)
		if err != nil {
			return nil, err
		}
		accepted[question.ID] = normalized
		planned = append(planned, plannedAnswer{Question: question, Answer: normalized})
	}
	return planned, nil
}

// validateAnswer checks one answer against its question and returns it normalized (free text is trimmed).
func validateAnswer(question Question, answer AnswerInput) (AnswerInput, error) {
	values := 0
	for _, present := range []bool{
		answer.TextValue != nil, answer.NumericValue != nil, answer.BooleanValue != nil, len(answer.OptionIDs) > 0,
	} {
		if present {
			values++
		}
	}
	switch question.Kind {
	case QuestionSingleChoice, QuestionMultipleChoice:
		single := question.Kind == QuestionSingleChoice
		if values != 1 || len(answer.OptionIDs) == 0 || (single && len(answer.OptionIDs) != 1) {
			return answer, apperror.InvalidField("choice answer is invalid")
		}
		seen := map[uuid.UUID]bool{}
		for _, id := range answer.OptionIDs {
			valid := slices.ContainsFunc(question.Options, func(option Option) bool { return option.ID == id })
			if !valid || seen[id] {
				return answer, apperror.InvalidField("choice answer contains an invalid option")
			}
			seen[id] = true
		}
	case QuestionFreeText:
		if values != 1 || answer.TextValue == nil || strings.TrimSpace(*answer.TextValue) == "" {
			return answer, apperror.InvalidField("free-text answer is invalid")
		}
		value := strings.TrimSpace(*answer.TextValue)
		answer.TextValue = &value
	case QuestionRating:
		if values != 1 || answer.NumericValue == nil || question.RatingMin == nil || question.RatingMax == nil ||
			*answer.NumericValue < *question.RatingMin || *answer.NumericValue > *question.RatingMax {
			return answer, apperror.InvalidField("rating answer is invalid")
		}
	case QuestionYesNo:
		if values != 1 || answer.BooleanValue == nil {
			return answer, apperror.InvalidField("yes/no answer is invalid")
		}
	default:
		return answer, apperror.InvalidField("question kind is invalid")
	}
	return answer, nil
}
