package httpapi

import (
	"context"
	"encoding/json"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

// convertJSON translates between the transport and domain representations of a rule definition, which have the same
// JSON shape. The domain side parses strictly, so anything the transport schema let through that the domain does not
// know is rejected there.
func convertJSON[To any](from any) (To, error) {
	var result To
	encoded, err := json.Marshal(from)
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(encoded, &result)
	return result, err
}

func notificationDefinition(transport openapi.NotificationRuleDefinition) (notifyrules.Definition, error) {
	encoded, err := json.Marshal(transport)
	if err != nil {
		return notifyrules.Definition{}, err
	}
	definition, err := notifyrules.ParseDefinition(encoded)
	if err != nil {
		return notifyrules.Definition{}, apperror.InvalidField("definition: the rule has an unexpected structure")
	}
	return definition, nil
}

func notificationRuleDTO(rule notifyrules.Rule) (openapi.NotificationRule, error) {
	definition, err := convertJSON[openapi.NotificationRuleDefinition](rule.Definition)
	if err != nil {
		return openapi.NotificationRule{}, err
	}
	dto := openapi.NotificationRule{
		Id: rule.ID, Name: rule.Name, Description: rule.Description, Enabled: rule.Enabled, Mandatory: rule.Mandatory,
		Definition: definition, Warnings: append([]string{}, rule.Warnings...), Version: rule.Version,
		CreatedAt: rule.CreatedAt, UpdatedAt: rule.UpdatedAt,
		CategoryId:  nullable.NewNullNullable[openapi.UUIDv7](),
		SystemKey:   optionalNullable(rule.SystemKey),
		LastFiredAt: optionalNullable(rule.LastFiredAt),
		Stats:       nullable.NewNullNullable[openapi.NotificationRuleStats](),
	}
	if rule.CategoryID != nil {
		dto.CategoryId = nullable.NewNullableWithValue(*rule.CategoryID)
	}
	if rule.Stats != nil {
		dto.Stats = nullable.NewNullableWithValue(openapi.NotificationRuleStats{
			Fired30: rule.Stats.Fired30, LastFiredAt: optionalNullable(rule.Stats.LastFiredAt), Sparkline: rule.Stats.Sparkline,
		})
	}
	return dto, nil
}

func notificationRuleList(rules []notifyrules.Rule) (openapi.NotificationRuleList, error) {
	items := make([]openapi.NotificationRule, 0, len(rules))
	for _, rule := range rules {
		dto, err := notificationRuleDTO(rule)
		if err != nil {
			return openapi.NotificationRuleList{}, err
		}
		items = append(items, dto)
	}
	return openapi.NotificationRuleList{Items: items}, nil
}

func ruleCategoryID(value nullable.Nullable[openapi.UUIDv7]) *uuid.UUID {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	id := value.GetOrEmpty()
	return &id
}

func createRuleInput(body *openapi.NotificationRuleInput) (notifyrules.RuleInput, error) {
	if body == nil {
		return notifyrules.RuleInput{}, invalidRequest("request body is required")
	}
	definition, err := notificationDefinition(body.Definition)
	if err != nil {
		return notifyrules.RuleInput{}, err
	}
	input := notifyrules.RuleInput{
		Name: body.Name, CategoryID: ruleCategoryID(body.CategoryId), Enabled: body.Enabled, Definition: definition,
	}
	if body.Description != nil {
		input.Description = *body.Description
	}
	if body.Mandatory != nil {
		input.Mandatory = *body.Mandatory
	}
	return input, nil
}

func updateRuleInput(body *openapi.UpdateNotificationRuleRequest) (notifyrules.RuleInput, error) {
	if body == nil {
		return notifyrules.RuleInput{}, invalidRequest("request body is required")
	}
	return createRuleInput(&openapi.NotificationRuleInput{
		Name: body.Name, Description: body.Description, CategoryId: body.CategoryId, Enabled: body.Enabled,
		Mandatory: body.Mandatory, Definition: body.Definition,
	})
}

func (s *Server) GetNotificationCatalog(
	ctx context.Context,
	_ openapi.GetNotificationCatalogRequestObject,
) (openapi.GetNotificationCatalogResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	view, err := s.notifyRules.Catalog(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.GetNotificationCatalog200JSONResponse(notificationCatalogDTO(view)), nil
}

func (s *Server) ListNotificationRules(
	ctx context.Context,
	_ openapi.ListNotificationRulesRequestObject,
) (openapi.ListNotificationRulesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	rules, err := s.notifyRules.ListRules(ctx, p)
	if err != nil {
		return nil, err
	}
	list, err := notificationRuleList(rules)
	if err != nil {
		return nil, err
	}
	return openapi.ListNotificationRules200JSONResponse(list), nil
}

func (s *Server) CreateNotificationRule(
	ctx context.Context,
	r openapi.CreateNotificationRuleRequestObject,
) (openapi.CreateNotificationRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	input, err := createRuleInput(r.Body)
	if err != nil {
		return nil, err
	}
	rule, err := s.notifyRules.CreateRule(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := notificationRuleDTO(rule)
	if err != nil {
		return nil, err
	}
	return openapi.CreateNotificationRule201JSONResponse(dto), nil
}

func (s *Server) GetNotificationRule(
	ctx context.Context,
	r openapi.GetNotificationRuleRequestObject,
) (openapi.GetNotificationRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	rule, err := s.notifyRules.GetRule(ctx, p, r.RuleId)
	if err != nil {
		return nil, err
	}
	dto, err := notificationRuleDTO(rule)
	if err != nil {
		return nil, err
	}
	return openapi.GetNotificationRule200JSONResponse(dto), nil
}

func (s *Server) UpdateNotificationRule(
	ctx context.Context,
	r openapi.UpdateNotificationRuleRequestObject,
) (openapi.UpdateNotificationRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	input, err := updateRuleInput(r.Body)
	if err != nil {
		return nil, err
	}
	rule, err := s.notifyRules.UpdateRule(ctx, p, r.RuleId, r.Body.ExpectedVersion, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := notificationRuleDTO(rule)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateNotificationRule200JSONResponse(dto), nil
}

func (s *Server) DeleteNotificationRule(
	ctx context.Context,
	r openapi.DeleteNotificationRuleRequestObject,
) (openapi.DeleteNotificationRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.notifyRules.DeleteRule(ctx, p, r.RuleId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteNotificationRule204Response{}, nil
}

func notificationCategoryDTO(category notifyrules.Category) openapi.NotificationCategory {
	return openapi.NotificationCategory{
		Id: category.ID, Key: nullableKey(category.Key), Name: category.Name, Description: category.Description,
		Basis: string(category.Basis), TextVersion: category.TextVersion,
		TextChangedAt: category.TextChangedAt, Position: category.Position, RuleCount: category.RuleCount,
		Version: category.Version, CreatedAt: category.CreatedAt, UpdatedAt: category.UpdatedAt,
	}
}

func nullableKey(key *string) nullable.Nullable[string] {
	if key == nil {
		return nullable.NewNullNullable[string]()
	}
	return nullable.NewNullableWithValue(*key)
}

func (s *Server) ListNotificationCategories(
	ctx context.Context,
	_ openapi.ListNotificationCategoriesRequestObject,
) (openapi.ListNotificationCategoriesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	categories, err := s.notifyRules.ListCategories(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.NotificationCategory, 0, len(categories))
	for _, category := range categories {
		items = append(items, notificationCategoryDTO(category))
	}
	return openapi.ListNotificationCategories200JSONResponse{Items: items}, nil
}

func (s *Server) CreateNotificationCategory(
	ctx context.Context,
	r openapi.CreateNotificationCategoryRequestObject,
) (openapi.CreateNotificationCategoryResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := notifyrules.CategoryInput{Name: r.Body.Name, Basis: notifyrules.Basis(r.Body.Basis)}
	if r.Body.Description != nil {
		input.Description = *r.Body.Description
	}
	if r.Body.Position != nil {
		input.Position = *r.Body.Position
	}
	category, err := s.notifyRules.CreateCategory(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateNotificationCategory201JSONResponse(notificationCategoryDTO(category)), nil
}

func (s *Server) UpdateNotificationCategory(
	ctx context.Context,
	r openapi.UpdateNotificationCategoryRequestObject,
) (openapi.UpdateNotificationCategoryResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := notifyrules.CategoryInput{Name: r.Body.Name}
	if r.Body.Description != nil {
		input.Description = *r.Body.Description
	}
	if r.Body.Position != nil {
		input.Position = *r.Body.Position
	}
	if r.Body.AskAgain != nil {
		input.AskAgain = *r.Body.AskAgain
	}
	category, err := s.notifyRules.UpdateCategory(
		ctx, p, r.CategoryId, r.Body.ExpectedVersion, input, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateNotificationCategory200JSONResponse(notificationCategoryDTO(category)), nil
}

func (s *Server) DeleteNotificationCategory(
	ctx context.Context,
	r openapi.DeleteNotificationCategoryRequestObject,
) (openapi.DeleteNotificationCategoryResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.notifyRules.DeleteCategory(ctx, p, r.CategoryId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteNotificationCategory204Response{}, nil
}

func notificationSettingsDTO(settings notifyrules.Settings) openapi.NotificationSettings {
	consents := make([]openapi.NotificationConsentEntry, 0, len(settings.Consents))
	for _, entry := range settings.Consents {
		consents = append(consents, openapi.NotificationConsentEntry{
			CategoryId: entry.Category.ID, Key: optionalNullable(entry.Category.Key), Name: entry.Category.Name,
			Description: entry.Category.Description, Basis: string(entry.Category.Basis),
			TextVersion: entry.Category.TextVersion, Granted: optionalNullable(entry.Granted),
			AnsweredAt: optionalNullable(entry.AnsweredAt), Current: entry.Current,
		})
	}
	rules := make([]openapi.NotificationReachingRule, 0, len(settings.Rules))
	for _, rule := range settings.Rules {
		defaults := make([]string, 0, len(rule.DefaultChannels))
		for _, channel := range rule.DefaultChannels {
			defaults = append(defaults, string(channel))
		}
		effective := make([]string, 0, len(rule.EffectiveChannels))
		for _, channel := range rule.EffectiveChannels {
			effective = append(effective, string(channel))
		}
		rules = append(rules, openapi.NotificationReachingRule{
			RuleId: rule.RuleID, Name: rule.Name, Description: rule.Description, CategoryId: rule.CategoryID,
			CategoryName: rule.CategoryName, Mandatory: rule.Mandatory, Why: append([]string{}, rule.Why...),
			DefaultChannels: defaults, EffectiveChannels: effective, BlockedByConsent: rule.BlockedByConsent,
		})
	}
	return openapi.NotificationSettings{
		Consents: consents, ConsentPending: settings.ConsentPending, AskFeedbackAtCheckout: settings.AskFeedbackAtCheckout,
		Rules: rules,
	}
}

func (s *Server) GetOwnNotificationSettings(
	ctx context.Context,
	_ openapi.GetOwnNotificationSettingsRequestObject,
) (openapi.GetOwnNotificationSettingsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	settings, err := s.notifyRules.Settings(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.GetOwnNotificationSettings200JSONResponse(notificationSettingsDTO(settings)), nil
}

func (s *Server) AnswerOwnNotificationConsents(
	ctx context.Context,
	r openapi.AnswerOwnNotificationConsentsRequestObject,
) (openapi.AnswerOwnNotificationConsentsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	answers := make([]notifyrules.ConsentAnswer, 0, len(r.Body.Answers))
	for _, answer := range r.Body.Answers {
		answers = append(answers, notifyrules.ConsentAnswer{CategoryID: answer.CategoryId, Granted: answer.Granted})
	}
	settings, err := s.notifyRules.AnswerConsents(
		ctx, p, answers, notifyrules.ConsentPlace(r.Body.Place), nil, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.AnswerOwnNotificationConsents200JSONResponse(notificationSettingsDTO(settings)), nil
}

func (s *Server) SetOwnNotificationRulePreference(
	ctx context.Context,
	r openapi.SetOwnNotificationRulePreferenceRequestObject,
) (openapi.SetOwnNotificationRulePreferenceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.notifyRules.SetRulePreference(
		ctx, p, r.RuleId, notifyrules.Preference{InApp: r.Body.InApp, Email: r.Body.Email},
	); err != nil {
		return nil, err
	}
	return openapi.SetOwnNotificationRulePreference204Response{}, nil
}

func (s *Server) SetOwnFeedbackAtCheckout(
	ctx context.Context,
	r openapi.SetOwnFeedbackAtCheckoutRequestObject,
) (openapi.SetOwnFeedbackAtCheckoutResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.notifyRules.SetAskFeedbackAtCheckout(ctx, p, r.Body.Ask); err != nil {
		return nil, err
	}
	return openapi.SetOwnFeedbackAtCheckout204Response{}, nil
}

func (s *Server) ListOwnNotificationSubscriptions(
	ctx context.Context,
	_ openapi.ListOwnNotificationSubscriptionsRequestObject,
) (openapi.ListOwnNotificationSubscriptionsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	rules, err := s.notifyRules.ListSubscriptions(ctx, p)
	if err != nil {
		return nil, err
	}
	list, err := notificationRuleList(rules)
	if err != nil {
		return nil, err
	}
	return openapi.ListOwnNotificationSubscriptions200JSONResponse(list), nil
}

func (s *Server) CreateOwnNotificationSubscription(
	ctx context.Context,
	r openapi.CreateOwnNotificationSubscriptionRequestObject,
) (openapi.CreateOwnNotificationSubscriptionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	input, err := createRuleInput(r.Body)
	if err != nil {
		return nil, err
	}
	rule, err := s.notifyRules.CreateSubscription(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := notificationRuleDTO(rule)
	if err != nil {
		return nil, err
	}
	return openapi.CreateOwnNotificationSubscription201JSONResponse(dto), nil
}

func (s *Server) GetOwnNotificationSubscription(
	ctx context.Context,
	r openapi.GetOwnNotificationSubscriptionRequestObject,
) (openapi.GetOwnNotificationSubscriptionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	rule, err := s.notifyRules.GetSubscription(ctx, p, r.SubscriptionId)
	if err != nil {
		return nil, err
	}
	dto, err := notificationRuleDTO(rule)
	if err != nil {
		return nil, err
	}
	return openapi.GetOwnNotificationSubscription200JSONResponse(dto), nil
}

func (s *Server) UpdateOwnNotificationSubscription(
	ctx context.Context,
	r openapi.UpdateOwnNotificationSubscriptionRequestObject,
) (openapi.UpdateOwnNotificationSubscriptionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	input, err := updateRuleInput(r.Body)
	if err != nil {
		return nil, err
	}
	rule, err := s.notifyRules.UpdateSubscription(
		ctx, p, r.SubscriptionId, r.Body.ExpectedVersion, input, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	dto, err := notificationRuleDTO(rule)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOwnNotificationSubscription200JSONResponse(dto), nil
}

func (s *Server) DeleteOwnNotificationSubscription(
	ctx context.Context,
	r openapi.DeleteOwnNotificationSubscriptionRequestObject,
) (openapi.DeleteOwnNotificationSubscriptionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.notifyRules.DeleteSubscription(
		ctx, p, r.SubscriptionId, r.Body.ExpectedVersion, requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteOwnNotificationSubscription204Response{}, nil
}

func catalogFieldsDTO(fields []notifyrules.FieldView) []openapi.NotificationCatalogField {
	items := make([]openapi.NotificationCatalogField, 0, len(fields))
	for _, field := range fields {
		options := make([]openapi.NotificationCatalogOption, 0, len(field.Options))
		for _, option := range field.Options {
			options = append(options, openapi.NotificationCatalogOption{Value: option.Value, Label: option.Label})
		}
		unit := nullable.NewNullNullable[string]()
		if field.Unit != "" {
			unit = nullable.NewNullableWithValue(field.Unit)
		}
		items = append(items, openapi.NotificationCatalogField{
			Key: field.Key, Label: field.Label, Type: string(field.Type),
			Options: options, Unit: unit,
		})
	}
	return items
}

func catalogChoicesDTO(choices []notifyrules.Choice) []openapi.NotificationCatalogChoice {
	items := make([]openapi.NotificationCatalogChoice, 0, len(choices))
	for _, choice := range choices {
		items = append(items, openapi.NotificationCatalogChoice{Key: choice.Key, Label: choice.Label})
	}
	return items
}

func catalogPlaceholdersDTO(placeholders []notifyrules.Placeholder) []openapi.NotificationCatalogPlaceholder {
	items := make([]openapi.NotificationCatalogPlaceholder, 0, len(placeholders))
	for _, placeholder := range placeholders {
		items = append(items, openapi.NotificationCatalogPlaceholder{
			Key: placeholder.Key, Label: placeholder.Label, Example: placeholder.Example,
		})
	}
	return items
}

func notificationCatalogDTO(view notifyrules.CatalogView) openapi.NotificationCatalog {
	triggers := make([]openapi.NotificationCatalogTrigger, 0, len(view.Triggers))
	for _, trigger := range view.Triggers {
		triggers = append(triggers, openapi.NotificationCatalogTrigger{
			Key: trigger.Key, Area: trigger.Area, Label: trigger.Label, Help: trigger.Help,
			Subject:          string(trigger.Subject),
			Fields:           catalogFieldsDTO(trigger.Fields),
			Recipients:       catalogChoicesDTO(trigger.Recipients),
			Placeholders:     catalogPlaceholdersDTO(trigger.Placeholders),
			Resolutions:      catalogChoicesDTO(trigger.Resolutions),
			ThrottleSubjects: catalogChoicesDTO(trigger.ThrottleSubjects),
		})
	}
	collections := make([]openapi.NotificationCatalogCollection, 0, len(view.Collections))
	for _, collection := range view.Collections {
		collections = append(collections, openapi.NotificationCatalogCollection{
			Key: collection.Key, Label: collection.Label, One: collection.One, Plural: collection.Plural,
			PlaceholderPrefix: collection.PlaceholderPrefix, Fields: catalogFieldsDTO(collection.Fields),
			SummaryFields: catalogFieldsDTO(collection.Summary), Recipients: catalogChoicesDTO(collection.Recipients),
		})
	}
	return openapi.NotificationCatalog{
		Triggers: triggers, Collections: collections,
		RecipientFields: catalogFieldsDTO(view.RecipientFields), NowFields: catalogFieldsDTO(view.NowFields),
		OpenDay: openapi.NotificationCatalogOpenDayContext{
			Fields: catalogFieldsDTO(view.OpenDayFields), Placeholders: catalogPlaceholdersDTO(view.OpenDayPlaceholders),
			Recipients: catalogChoicesDTO(view.OpenDayRecipients),
		},
		Resolutions: catalogChoicesDTO(view.Resolutions), Repeats: catalogChoicesDTO(view.Repeats),
	}
}
