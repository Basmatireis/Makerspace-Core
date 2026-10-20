package signage

import (
	"context"
	"errors"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	maxTemplateFields  = 20
	maxFieldOptions    = 20
	maxFieldValueRunes = 2000
)

var (
	fieldKeyPattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	timeValuePattern = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
	numberPattern    = regexp.MustCompile(`^-?[0-9]{1,15}([.,][0-9]{1,6})?$`)
	fieldTypes       = []string{"text", "longtext", "time", "date", "datetime", "number", "choice", "machine"}
	tones            = []string{"info", "warning", "critical", "neutral"}
)

// TemplateField is one typed input of an announcement template.
type TemplateField struct {
	Key, Label, Type string
	Required         bool
	DefaultValue     string
	HelperText       string
	Options          []string
}

// Template is an announcement template: fields, a title and body with {placeholders}, and a tone.
type Template struct {
	ID          uuid.UUID
	Name, Tone  string
	Title, Body string
	Fields      []TemplateField
	Version     int64
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// TemplateInput is the writable part of a template; Fields replace the stored fields.
type TemplateInput struct {
	Name, Tone  string
	Title, Body string
	Fields      []TemplateField
}

func templateFrom(row signagedb.SignageAnnouncementTemplate, fields []TemplateField) Template {
	if fields == nil {
		fields = []TemplateField{}
	}
	return Template{
		ID:        row.ID,
		Name:      row.Name,
		Tone:      row.Tone,
		Title:     row.Title,
		Body:      row.Body,
		Fields:    fields,
		Version:   row.Version,
		CreatedAt: row.CreatedAt.UTC(),
		UpdatedAt: row.UpdatedAt.UTC(),
	}
}

func fieldsByTemplate(rows []signagedb.SignageAnnouncementTemplateField) map[uuid.UUID][]TemplateField {
	result := map[uuid.UUID][]TemplateField{}
	for _, row := range rows {
		options := row.Options
		if options == nil {
			options = []string{}
		}
		result[row.TemplateID] = append(result[row.TemplateID], TemplateField{
			Key:          row.Key,
			Label:        row.Label,
			Type:         row.Type,
			Required:     row.Required,
			DefaultValue: row.DefaultValue,
			HelperText:   row.HelperText,
			Options:      options,
		})
	}
	return result
}

func renderFields(fields []TemplateField) []RenderField {
	result := make([]RenderField, 0, len(fields))
	for _, field := range fields {
		result = append(result, RenderField{Key: field.Key, Type: field.Type})
	}
	return result
}

// ValidateFieldValue checks a value against a field's type and options. The empty string is valid
// here; required-ness is checked by the caller.
func ValidateFieldValue(field TemplateField, value string) error {
	if value == "" {
		return nil
	}
	if utf8.RuneCountInString(value) > maxFieldValueRunes {
		return validation("%s is too long", field.Label)
	}
	switch field.Type {
	case "text":
		if !plainText(value, 200, false) {
			return validation("%s must be single-line text of at most 200 characters", field.Label)
		}
	case "longtext":
		if !plainText(value, maxFieldValueRunes, true) {
			return validation("%s must be plain text of at most %d characters", field.Label, maxFieldValueRunes)
		}
	case "time":
		if !timeValuePattern.MatchString(value) {
			return validation("%s must be a time as HH:MM", field.Label)
		}
	case "date":
		if _, err := time.Parse("2006-01-02", value); err != nil {
			return validation("%s must be a date as YYYY-MM-DD", field.Label)
		}
	case "datetime":
		if _, err := time.Parse("2006-01-02T15:04", value); err != nil {
			return validation("%s must be a date and time as YYYY-MM-DDTHH:MM", field.Label)
		}
	case "number":
		if !numberPattern.MatchString(value) {
			return validation("%s must be a number", field.Label)
		}
	case "choice":
		for _, option := range field.Options {
			if option == value {
				return nil
			}
		}
		return validation("%s must be one of its options", field.Label)
	case "machine":
		if _, err := uuid.Parse(value); err != nil {
			return validation("%s must be a machine id", field.Label)
		}
	}
	return nil
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func validateTemplateInput(input TemplateInput) (TemplateInput, error) {
	name, err := cleanName(input.Name, "template name", 100)
	if err != nil {
		return TemplateInput{}, err
	}
	if !contains(tones, input.Tone) {
		return TemplateInput{}, validation("tone must be info, warning, critical or neutral")
	}
	if input.Title == "" || !plainText(input.Title, 200, false) {
		return TemplateInput{}, validation("title is required and limited to 200 characters of single-line text")
	}
	if !plainText(input.Body, 2000, true) {
		return TemplateInput{}, validation("body must be plain text of at most 2000 characters")
	}
	if len(input.Fields) > maxTemplateFields {
		return TemplateInput{}, validation("a template has at most %d fields", maxTemplateFields)
	}
	keys := make([]string, 0, len(input.Fields))
	fields := make([]TemplateField, 0, len(input.Fields))
	for _, field := range input.Fields {
		if !fieldKeyPattern.MatchString(field.Key) {
			return TemplateInput{}, validation(
				"field key %q must be lowercase letters, digits and underscores, starting with a letter",
				field.Key,
			)
		}
		if isBuiltInKey(field.Key) {
			return TemplateInput{}, validation("field key %q is a built-in variable", field.Key)
		}
		if contains(keys, field.Key) {
			return TemplateInput{}, validation("field key %q is used twice", field.Key)
		}
		keys = append(keys, field.Key)
		label, err := cleanName(field.Label, "field label", 100)
		if err != nil {
			return TemplateInput{}, err
		}
		if !contains(fieldTypes, field.Type) {
			return TemplateInput{}, validation("field %q has an unknown type", field.Key)
		}
		if !plainText(field.HelperText, 300, false) {
			return TemplateInput{}, validation(
				"helper text of field %q is limited to 300 characters of single-line text",
				field.Key,
			)
		}
		options := []string{}
		if field.Type == "choice" {
			if len(field.Options) == 0 || len(field.Options) > maxFieldOptions {
				return TemplateInput{}, validation(
					"choice field %q needs between 1 and %d options",
					field.Key,
					maxFieldOptions,
				)
			}
			for _, option := range field.Options {
				if option == "" || !plainText(option, 100, false) || contains(options, option) {
					return TemplateInput{}, validation(
						"options of field %q must be distinct single-line texts of at most 100 characters",
						field.Key,
					)
				}
				options = append(options, option)
			}
		} else if len(field.Options) > 0 {
			return TemplateInput{}, validation("only choice fields have options")
		}
		checked := TemplateField{
			Key:          field.Key,
			Label:        label,
			Type:         field.Type,
			Required:     field.Required,
			DefaultValue: field.DefaultValue,
			HelperText:   field.HelperText,
			Options:      options,
		}
		if err := ValidateFieldValue(checked, checked.DefaultValue); err != nil {
			return TemplateInput{}, err
		}
		fields = append(fields, checked)
	}
	if unknown := UnknownPlaceholders(keys, input.Title, input.Body); len(unknown) > 0 {
		result := apperror.New(
			422,
			"unknown_placeholders",
			"Title or body use placeholders that are neither fields nor built-in variables",
		)
		result.Details["placeholders"] = unknown
		return TemplateInput{}, result
	}
	return TemplateInput{Name: name, Tone: input.Tone, Title: input.Title, Body: input.Body, Fields: fields}, nil
}

func insertFields(ctx context.Context, q *signagedb.Queries, templateID uuid.UUID, fields []TemplateField) error {
	if err := q.DeleteSignageTemplateFields(ctx, templateID); err != nil {
		return err
	}
	for position, field := range fields {
		if err := q.InsertSignageTemplateField(ctx, signagedb.InsertSignageTemplateFieldParams{
			TemplateID:   templateID,
			Position:     int32(position),
			Key:          field.Key,
			Label:        field.Label,
			Type:         field.Type,
			Required:     field.Required,
			DefaultValue: field.DefaultValue, HelperText: field.HelperText, Options: field.Options,
		}); err != nil {
			return databaseError(err)
		}
	}
	return nil
}

// ListTemplates returns all announcement templates with their fields.
func (s *Service) ListTemplates(ctx context.Context, principal authorization.Principal) ([]Template, error) {
	if err := requireRead(principal); err != nil {
		return nil, err
	}
	q := signagedb.New(s.pool)
	rows, err := q.ListSignageTemplates(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	fieldRows, err := q.ListSignageTemplateFields(ctx, uuidStrings(ids))
	if err != nil {
		return nil, err
	}
	fields := fieldsByTemplate(fieldRows)
	result := make([]Template, 0, len(rows))
	for _, row := range rows {
		result = append(result, templateFrom(row, fields[row.ID]))
	}
	return result, nil
}

// GetTemplate reads one template.
func (s *Service) GetTemplate(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Template, error) {
	if err := requireRead(principal); err != nil {
		return Template{}, err
	}
	return s.getTemplate(ctx, signagedb.New(s.pool), id)
}

func (s *Service) getTemplate(ctx context.Context, q *signagedb.Queries, id uuid.UUID) (Template, error) {
	row, err := q.GetSignageTemplate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Template{}, apperror.NotFound
	}
	if err != nil {
		return Template{}, err
	}
	fieldRows, err := q.ListSignageTemplateFields(ctx, []string{id.String()})
	if err != nil {
		return Template{}, err
	}
	return templateFrom(row, fieldsByTemplate(fieldRows)[id]), nil
}

// CreateTemplate stores a template and its fields.
func (s *Service) CreateTemplate(
	ctx context.Context,
	principal authorization.Principal,
	input TemplateInput,
	requestID *uuid.UUID,
) (Template, error) {
	if err := requireContentManage(principal); err != nil {
		return Template{}, err
	}
	checked, err := validateTemplateInput(input)
	if err != nil {
		return Template{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Template{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	id := ids.New()
	if _, err := q.CreateSignageTemplate(
		ctx,
		signagedb.CreateSignageTemplateParams{
			ID:    id,
			Name:  checked.Name,
			Tone:  checked.Tone,
			Title: checked.Title,
			Body:  checked.Body,
		},
	); err != nil {
		return Template{}, databaseError(err)
	}
	if err := insertFields(ctx, q, id, checked.Fields); err != nil {
		return Template{}, err
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_announcement_template.created",
		"signage_announcement_template",
		id,
		requestID,
		[]string{"name", "tone", "title", "body", "fields"},
	); err != nil {
		return Template{}, err
	}
	result, err := s.getTemplate(ctx, q, id)
	if err != nil {
		return Template{}, err
	}
	return result, tx.Commit(ctx)
}

// UpdateTemplate replaces a template and its fields. Stored values of removed fields are dropped
// from the template's announcements.
func (s *Service) UpdateTemplate(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	input TemplateInput,
	requestID *uuid.UUID,
) (Template, error) {
	if err := requireContentManage(principal); err != nil {
		return Template{}, err
	}
	if err := requireExpected(expected); err != nil {
		return Template{}, err
	}
	checked, err := validateTemplateInput(input)
	if err != nil {
		return Template{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Template{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, err := q.GetSignageTemplateForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Template{}, apperror.NotFound
	}
	if err != nil {
		return Template{}, err
	}
	if current.Version != expected {
		return Template{}, apperror.StaleWrite
	}
	if _, err := q.UpdateSignageTemplate(
		ctx,
		signagedb.UpdateSignageTemplateParams{
			Name:            checked.Name,
			Tone:            checked.Tone,
			Title:           checked.Title,
			Body:            checked.Body,
			ID:              id,
			ExpectedVersion: expected,
		},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return Template{}, apperror.StaleWrite
	} else if err != nil {
		return Template{}, databaseError(err)
	}
	if err := insertFields(ctx, q, id, checked.Fields); err != nil {
		return Template{}, err
	}
	keys := make([]string, 0, len(checked.Fields))
	for _, field := range checked.Fields {
		keys = append(keys, field.Key)
	}
	if err := q.DeleteSignageAnnouncementValuesNotIn(
		ctx,
		signagedb.DeleteSignageAnnouncementValuesNotInParams{TemplateID: id, Keys: keys},
	); err != nil {
		return Template{}, err
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_announcement_template.updated",
		"signage_announcement_template",
		id,
		requestID,
		[]string{"name", "tone", "title", "body", "fields"},
	); err != nil {
		return Template{}, err
	}
	result, err := s.getTemplate(ctx, q, id)
	if err != nil {
		return Template{}, err
	}
	return result, tx.Commit(ctx)
}

// DeleteTemplate removes a template that no active or scheduled announcement, rule filter or
// widget filter uses. Ended announcements of the template are deleted with it.
func (s *Service) DeleteTemplate(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := requireContentManage(principal); err != nil {
		return err
	}
	if err := requireExpected(expected); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, err := q.GetSignageTemplateForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	now := s.now()
	var references []Reference
	live, err := q.ListAnnouncementsUsingTemplate(
		ctx,
		signagedb.ListAnnouncementsUsingTemplateParams{TemplateID: id, Now: now},
	)
	if err != nil {
		return err
	}
	for _, announcementID := range live {
		references = append(references, Reference{Kind: "announcement", ID: announcementID, Name: current.Name})
	}
	rules, err := q.ListRulesFilteringTemplate(ctx, id)
	if err != nil {
		return err
	}
	for _, rule := range rules {
		references = append(references, Reference{Kind: "display_rule", ID: rule.DisplayID, Name: rule.DisplayName})
	}
	scenes, err := q.ListScenesReferencingTemplate(ctx, id)
	if err != nil {
		return err
	}
	for _, scene := range scenes {
		references = append(references, Reference{Kind: "scene", ID: scene.ID, Name: scene.Name})
	}
	if len(references) > 0 {
		return inUse("Announcement template", references)
	}
	if err := q.DeleteEndedAnnouncementsOfTemplate(
		ctx,
		signagedb.DeleteEndedAnnouncementsOfTemplateParams{TemplateID: id, Now: now},
	); err != nil {
		return err
	}
	if _, err := q.DeleteSignageTemplate(
		ctx,
		signagedb.DeleteSignageTemplateParams{ID: id, ExpectedVersion: expected},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_announcement_template.deleted",
		"signage_announcement_template",
		id,
		requestID,
		nil,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
