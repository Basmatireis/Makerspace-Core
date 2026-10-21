package configtransfer

import (
	"context"
	"slices"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	configtransferdb "github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Surveys: definitions by name (the current version's title, introduction and questions, and the post-visit trigger
// timing). Responses and invitations are never transferred. Imported surveys are drafts with a disabled trigger;
// publishing stays a deliberate step. Published surveys are immutable, so an overwrite keeps a published survey whose
// definition differs and closes published surveys missing from the file.

type surveyQuestionEntry struct {
	Kind      string   `json:"kind"`
	Prompt    string   `json:"prompt"`
	Required  bool     `json:"required"`
	Options   []string `json:"options"`
	RatingMin *int32   `json:"ratingMin"`
	RatingMax *int32   `json:"ratingMax"`
}

type surveyTriggerEntry struct {
	DelaySeconds int32 `json:"delaySeconds"`
	CooldownDays int32 `json:"cooldownDays"`
}

type surveyEntry struct {
	Name         string                `json:"name"`
	Description  *string               `json:"description"`
	Anonymous    bool                  `json:"anonymous"`
	Title        string                `json:"title"`
	Introduction *string               `json:"introduction"`
	Questions    []surveyQuestionEntry `json:"questions"`
	Trigger      *surveyTriggerEntry   `json:"trigger"`
}

func surveysSection() section {
	return define(
		SectionSurveys,
		permissions(authorization.SurveysRead),
		permissions(authorization.SurveysManage),
		func(ctx context.Context, q *configtransferdb.Queries) ([]surveyEntry, error) {
			stored, err := loadSurveys(ctx, q)
			if err != nil {
				return nil, err
			}
			items := make([]surveyEntry, 0, len(stored))
			for _, survey := range stored {
				if surveys.Status(survey.row.Status) != surveys.StatusClosed {
					items = append(items, survey.entry)
				}
			}
			return items, nil
		},
		func(items *[]surveyEntry) error {
			names := make([]*string, len(*items))
			for i := range *items {
				item := &(*items)[i]
				names[i] = &item.Name
				item.Title = strings.TrimSpace(item.Title)
				item.Description, item.Introduction = trimmed(item.Description), trimmed(item.Introduction)
				if item.Questions == nil {
					item.Questions = []surveyQuestionEntry{}
				}
				for j := range item.Questions {
					question := &item.Questions[j]
					question.Prompt = strings.TrimSpace(question.Prompt)
					if question.Options == nil {
						question.Options = []string{}
					}
					for k := range question.Options {
						question.Options[k] = strings.TrimSpace(question.Options[k])
					}
				}
			}
			return checkNames("survey", names, 160)
		},
		applySurveys,
	)
}

type storedSurvey struct {
	row     configtransferdb.ListSurveysRow
	entry   surveyEntry
	trigger *configtransferdb.ListSurveyTriggersRow
}

func loadSurveys(ctx context.Context, q *configtransferdb.Queries) ([]storedSurvey, error) {
	rows, err := q.ListSurveys(ctx)
	if err != nil {
		return nil, err
	}
	versionIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		versionIDs = append(versionIDs, row.SurveyVersionID)
	}
	questions, err := q.ListSurveyQuestions(ctx, versionIDs)
	if err != nil {
		return nil, err
	}
	options, err := q.ListSurveyOptions(ctx, versionIDs)
	if err != nil {
		return nil, err
	}
	triggers, err := q.ListSurveyTriggers(ctx)
	if err != nil {
		return nil, err
	}
	optionsByQuestion := map[uuid.UUID][]string{}
	for _, option := range options {
		optionsByQuestion[option.QuestionID] = append(optionsByQuestion[option.QuestionID], option.Label)
	}
	questionsByVersion := map[uuid.UUID][]surveyQuestionEntry{}
	for _, question := range questions {
		labels := optionsByQuestion[question.ID]
		if labels == nil {
			labels = []string{}
		}
		questionsByVersion[question.SurveyVersionID] = append(questionsByVersion[question.SurveyVersionID],
			surveyQuestionEntry{
				Kind:      question.Kind,
				Prompt:    question.Prompt,
				Required:  question.Required,
				Options:   labels,
				RatingMin: question.RatingMin,
				RatingMax: question.RatingMax,
			})
	}
	triggerBySurvey := map[uuid.UUID]configtransferdb.ListSurveyTriggersRow{}
	for _, trigger := range triggers {
		triggerBySurvey[trigger.SurveyID] = trigger
	}
	result := make([]storedSurvey, 0, len(rows))
	for _, row := range rows {
		entry := surveyEntry{
			Name:         row.Name,
			Description:  row.Description,
			Anonymous:    row.Anonymous,
			Title:        row.Title,
			Introduction: row.Introduction,
			Questions:    questionsByVersion[row.SurveyVersionID],
		}
		if entry.Questions == nil {
			entry.Questions = []surveyQuestionEntry{}
		}
		stored := storedSurvey{row: row, entry: entry}
		if trigger, ok := triggerBySurvey[row.ID]; ok {
			stored.trigger = &trigger
			stored.entry.Trigger = &surveyTriggerEntry{DelaySeconds: trigger.DelaySeconds, CooldownDays: trigger.CooldownDays}
		}
		result = append(result, stored)
	}
	return result, nil
}

func sameQuestions(a, b []surveyQuestionEntry) bool {
	return slices.EqualFunc(a, b, func(x, y surveyQuestionEntry) bool {
		return x.Kind == y.Kind && x.Prompt == y.Prompt && x.Required == y.Required &&
			slices.Equal(x.Options, y.Options) && sameInt(x.RatingMin, y.RatingMin) && sameInt(x.RatingMax, y.RatingMax)
	})
}

func sameInt(a, b *int32) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameDefinition(a, b surveyEntry) bool {
	return a.Name == b.Name && sameText(a.Description, b.Description) && a.Anonymous == b.Anonymous &&
		a.Title == b.Title && sameText(a.Introduction, b.Introduction) && sameQuestions(a.Questions, b.Questions)
}

func sameTrigger(a, b *surveyTriggerEntry) bool {
	if a == nil || b == nil {
		return b == nil // a file without trigger leaves an existing trigger alone
	}
	return *a == *b
}

func surveyInput(item surveyEntry, expected int64) surveys.Input {
	input := surveys.Input{
		Name:            item.Name,
		Title:           item.Title,
		Description:     item.Description,
		Introduction:    item.Introduction,
		Anonymous:       item.Anonymous,
		ExpectedVersion: expected,
	}
	for _, question := range item.Questions {
		value := surveys.QuestionInput{
			Kind:      surveys.QuestionKind(question.Kind),
			Prompt:    question.Prompt,
			Required:  question.Required,
			RatingMin: question.RatingMin,
			RatingMax: question.RatingMax,
		}
		for _, label := range question.Options {
			value.Options = append(value.Options, surveys.OptionInput{Label: label})
		}
		input.Questions = append(input.Questions, value)
	}
	return input
}

func applySurveys(r *run, items *[]surveyEntry) (func() error, error) {
	stored, err := loadSurveys(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	byName := map[string][]storedSurvey{}
	for _, survey := range stored {
		byName[nameKey(survey.row.Name)] = append(byName[nameKey(survey.row.Name)], survey)
	}
	inFile := map[string]bool{}
	for _, item := range *items {
		inFile[nameKey(item.Name)] = true
		matches := byName[nameKey(item.Name)]
		switch {
		case len(matches) == 0:
			_, err = r.attempt(item.Name, ActionCreate, "Created as a draft; publish it to use it.", func(tx pgx.Tx) error {
				id, err := r.svc.Surveys.CreateTx(r.ctx, tx, r.p, surveyInput(item, 0), r.requestID)
				if err != nil || item.Trigger == nil {
					return err
				}
				_, err = r.svc.Surveys.UpdateTriggerTx(
					r.ctx, tx, r.p, id, false, item.Trigger.DelaySeconds, item.Trigger.CooldownDays, 0, r.requestID,
				)
				return err
			})
		case r.mode == ModeInsert:
			r.skip(item.Name, reasonExists)
		case len(matches) > 1:
			r.conflict(item.Name, "survey_name_ambiguous", "Several surveys have this name.")
		default:
			err = r.updateSurvey(matches[0], item)
		}
		if err != nil {
			return nil, err
		}
	}
	return func() error {
		for _, survey := range stored {
			if inFile[nameKey(survey.row.Name)] {
				continue
			}
			if surveys.Status(survey.row.Status) != surveys.StatusPublished {
				r.keep(survey.row.Name, "Surveys cannot be deleted.")
				continue
			}
			if _, err := r.attempt(survey.row.Name, ActionDeactivate, "The published survey is closed.", func(tx pgx.Tx) error {
				return r.svc.Surveys.CloseTx(r.ctx, tx, r.p, survey.row.ID, survey.row.Version, r.requestID)
			}); err != nil {
				return err
			}
		}
		return nil
	}, nil
}

func (r *run) updateSurvey(current storedSurvey, item surveyEntry) error {
	definitionChanged := !sameDefinition(current.entry, item)
	triggerChanged := !sameTrigger(current.entry.Trigger, item.Trigger)
	if !definitionChanged && !triggerChanged {
		r.skip(item.Name, reasonUnchanged)
		return nil
	}
	if definitionChanged && surveys.Status(current.row.Status) != surveys.StatusDraft {
		r.keep(item.Name, "Published and closed surveys cannot be changed; it keeps its current definition.")
		return nil
	}
	_, err := r.attempt(item.Name, ActionUpdate, "", func(tx pgx.Tx) error {
		if definitionChanged {
			if err := r.svc.Surveys.UpdateTx(
				r.ctx, tx, r.p, current.row.ID, surveyInput(item, current.row.Version), r.requestID,
			); err != nil {
				return err
			}
		}
		if !triggerChanged {
			return nil
		}
		enabled, expected := false, int64(0)
		if current.trigger != nil {
			enabled, expected = current.trigger.Enabled, current.trigger.Version
		}
		_, err := r.svc.Surveys.UpdateTriggerTx(
			r.ctx, tx, r.p, current.row.ID, enabled, item.Trigger.DelaySeconds, item.Trigger.CooldownDays, expected,
			r.requestID,
		)
		return err
	})
	return err
}
