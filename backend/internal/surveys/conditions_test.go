package surveys

import (
	"errors"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

func ptr[T any](value T) *T { return &value }

func choice(kind QuestionKind, labels ...string) Question {
	question := Question{ID: ids.New(), Kind: kind, Prompt: "Choice"}
	for index, label := range labels {
		question.Options = append(question.Options, Option{ID: ids.New(), Label: label, Position: int32(index + 1)})
	}
	return question
}

func TestConditionMatchesPerQuestionKind(t *testing.T) {
	a, b, c := ids.New(), ids.New(), ids.New()
	cases := []struct {
		name      string
		condition Condition
		answer    AnswerInput
		want      bool
	}{
		{"single choice in set", Condition{Operator: ConditionOneOf, OptionIDs: []uuid.UUID{a, b}}, AnswerInput{OptionIDs: []uuid.UUID{b}}, true},
		{"single choice outside set", Condition{Operator: ConditionOneOf, OptionIDs: []uuid.UUID{a}}, AnswerInput{OptionIDs: []uuid.UUID{c}}, false},
		{"multiple choice includes one", Condition{Operator: ConditionIncludesAny, OptionIDs: []uuid.UUID{a}}, AnswerInput{OptionIDs: []uuid.UUID{b, a}}, true},
		{"multiple choice includes none", Condition{Operator: ConditionIncludesAny, OptionIDs: []uuid.UUID{a}}, AnswerInput{OptionIDs: []uuid.UUID{b, c}}, false},
		{"rating lte equal", Condition{Operator: ConditionLessEqual, Number: ptr[int32](3)}, AnswerInput{NumericValue: ptr[int32](3)}, true},
		{"rating lte above", Condition{Operator: ConditionLessEqual, Number: ptr[int32](3)}, AnswerInput{NumericValue: ptr[int32](4)}, false},
		{"rating gte below", Condition{Operator: ConditionGreaterEq, Number: ptr[int32](4)}, AnswerInput{NumericValue: ptr[int32](3)}, false},
		{"rating gte equal", Condition{Operator: ConditionGreaterEq, Number: ptr[int32](4)}, AnswerInput{NumericValue: ptr[int32](4)}, true},
		{"rating eq", Condition{Operator: ConditionEquals, Number: ptr[int32](2)}, AnswerInput{NumericValue: ptr[int32](2)}, true},
		{"yes no eq yes", Condition{Operator: ConditionEquals, Boolean: ptr(true)}, AnswerInput{BooleanValue: ptr(true)}, true},
		{"yes no eq no", Condition{Operator: ConditionEquals, Boolean: ptr(true)}, AnswerInput{BooleanValue: ptr(false)}, false},
		{"missing answer", Condition{Operator: ConditionLessEqual, Number: ptr[int32](3)}, AnswerInput{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.condition.Matches(tc.answer); got != tc.want {
				t.Fatalf("Matches = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestValidateConditionsRejectsMisfits(t *testing.T) {
	choiceInput := QuestionInput{Kind: QuestionSingleChoice, Prompt: "q", Options: []OptionInput{{Label: "a"}, {Label: "b"}}}
	rating := QuestionInput{Kind: QuestionRating, Prompt: "r", RatingMin: ptr[int32](1), RatingMax: ptr[int32](5)}
	text := QuestionInput{Kind: QuestionFreeText, Prompt: "t"}
	withCondition := func(condition ConditionInput) QuestionInput {
		return QuestionInput{Kind: QuestionFreeText, Prompt: "dependent", Condition: &condition}
	}
	valid := [][]QuestionInput{
		{choiceInput, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionOneOf, OptionPositions: []int{2}})},
		{rating, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionLessEqual, Number: ptr[int32](3)})},
	}
	for index, questions := range valid {
		if err := validateConditions(questions); err != nil {
			t.Fatalf("valid case %d rejected: %v", index, err)
		}
	}
	invalid := map[string][]QuestionInput{
		"refers to itself":       {withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionOneOf, OptionPositions: []int{1}})},
		"refers to a later one":  {withCondition(ConditionInput{QuestionPosition: 2, Operator: ConditionOneOf, OptionPositions: []int{1}}), choiceInput},
		"free text source":       {text, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionEquals, Number: ptr[int32](1)})},
		"wrong operator":         {choiceInput, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionIncludesAny, OptionPositions: []int{1}})},
		"option out of range":    {choiceInput, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionOneOf, OptionPositions: []int{3}})},
		"duplicate option":       {choiceInput, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionOneOf, OptionPositions: []int{1, 1}})},
		"no options":             {choiceInput, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionOneOf})},
		"rating value outside":   {rating, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionEquals, Number: ptr[int32](9)})},
		"rating without value":   {rating, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionGreaterEq})},
		"options on rating":      {rating, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionEquals, Number: ptr[int32](2), OptionPositions: []int{1}})},
		"yes no needs a boolean": {{Kind: QuestionYesNo, Prompt: "y"}, withCondition(ConditionInput{QuestionPosition: 1, Operator: ConditionEquals})},
	}
	for name, questions := range invalid {
		if err := validateConditions(questions); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestPlanAnswersEvaluatesConditions(t *testing.T) {
	gate := choice(QuestionSingleChoice, "yes", "no")
	gate.Required = true
	followUp := Question{
		ID: ids.New(), Kind: QuestionFreeText, Prompt: "Why?", Required: true,
		Condition: &Condition{QuestionID: gate.ID, Operator: ConditionOneOf, OptionIDs: []uuid.UUID{gate.Options[0].ID}},
	}
	// A question conditioned on a hidden question stays hidden, even when it would match on its own.
	chained := Question{
		ID: ids.New(), Kind: QuestionFreeText, Prompt: "More?", Required: true,
		Condition: &Condition{QuestionID: followUp.ID, Operator: ConditionEquals, Number: ptr[int32](1)},
	}
	questions := []Question{gate, followUp, chained}
	text := "because"

	planned, err := planAnswers(questions, []AnswerInput{{QuestionID: gate.ID, OptionIDs: []uuid.UUID{gate.Options[1].ID}}})
	if err != nil || len(planned) != 1 {
		t.Fatalf("hidden follow-ups must not be required: planned %d, err %v", len(planned), err)
	}
	if _, err = planAnswers(questions, []AnswerInput{
		{QuestionID: gate.ID, OptionIDs: []uuid.UUID{gate.Options[1].ID}},
		{QuestionID: followUp.ID, TextValue: &text},
	}); !errors.Is(err, errAnswerNotApplicable) {
		t.Fatalf("answer to a hidden question: got %v", err)
	}
	if _, err = planAnswers(questions, []AnswerInput{{QuestionID: gate.ID, OptionIDs: []uuid.UUID{gate.Options[0].ID}}}); err == nil {
		t.Fatal("a visible required follow-up must be answered")
	}
	planned, err = planAnswers(questions, []AnswerInput{
		{QuestionID: gate.ID, OptionIDs: []uuid.UUID{gate.Options[0].ID}},
		{QuestionID: followUp.ID, TextValue: &text},
	})
	if err != nil || len(planned) != 2 {
		t.Fatalf("visible follow-up: planned %d, err %v", len(planned), err)
	}
	if _, err = planAnswers(questions, []AnswerInput{
		{QuestionID: gate.ID, OptionIDs: []uuid.UUID{gate.Options[0].ID}},
		{QuestionID: followUp.ID, TextValue: &text},
		{QuestionID: chained.ID, TextValue: &text},
	}); !errors.Is(err, errAnswerNotApplicable) {
		t.Fatalf("answer to a transitively hidden question: got %v", err)
	}
}

func TestPlanAnswersRejectsMalformedAnswers(t *testing.T) {
	single := choice(QuestionSingleChoice, "a", "b")
	rating := Question{ID: ids.New(), Kind: QuestionRating, Prompt: "r", RatingMin: ptr[int32](1), RatingMax: ptr[int32](5)}
	foreign := ids.New()
	cases := map[string][]AnswerInput{
		"two options for single choice": {{QuestionID: single.ID, OptionIDs: []uuid.UUID{single.Options[0].ID, single.Options[1].ID}}},
		"foreign option":                {{QuestionID: single.ID, OptionIDs: []uuid.UUID{foreign}}},
		"rating out of range":           {{QuestionID: rating.ID, NumericValue: ptr[int32](6)}},
		"unknown question":              {{QuestionID: foreign, BooleanValue: ptr(true)}},
		"duplicate answer":              {{QuestionID: rating.ID, NumericValue: ptr[int32](2)}, {QuestionID: rating.ID, NumericValue: ptr[int32](3)}},
	}
	for name, answers := range cases {
		if _, err := planAnswers([]Question{single, rating}, answers); err == nil {
			t.Errorf("%s was accepted", name)
		} else {
			var appErr *apperror.Error
			if !errors.As(err, &appErr) {
				t.Errorf("%s: error %v is not a client error", name, err)
			}
		}
	}
}
