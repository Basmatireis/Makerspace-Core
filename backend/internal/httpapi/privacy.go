package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) GetPrivacyOverview(
	ctx context.Context,
	_ openapi.GetPrivacyOverviewRequestObject,
) (openapi.GetPrivacyOverviewResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	overview, err := s.privacy.Overview(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetPrivacyOverview200JSONResponse{
		Categories:           overview.Categories,
		OrphanedCategories:   overview.OrphanedCategories,
		AutomaticRunsEnabled: overview.AutomaticRunsEnabled,
	}, nil
}

func (s *Server) ListPrivacyCategories(
	ctx context.Context,
	_ openapi.ListPrivacyCategoriesRequestObject,
) (openapi.ListPrivacyCategoriesResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	categories, err := s.privacy.Categories(ctx, principal)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.PrivacyCategory, 0, len(categories))
	for _, category := range categories {
		result = append(result, privacyCategoryDTO(category))
	}
	return openapi.ListPrivacyCategories200JSONResponse{Categories: result}, nil
}

func (s *Server) GetPrivacySettings(
	ctx context.Context,
	_ openapi.GetPrivacySettingsRequestObject,
) (openapi.GetPrivacySettingsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	settings, err := s.privacy.GetSettings(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetPrivacySettings200JSONResponse(privacySettingsDTO(settings)), nil
}

func (s *Server) UpdatePrivacySettings(
	ctx context.Context,
	request openapi.UpdatePrivacySettingsRequestObject,
) (openapi.UpdatePrivacySettingsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	settings, err := s.privacy.UpdateSettings(ctx, principal, privacy.SettingsInput{
		ControllerName:        request.Body.ControllerName,
		ControllerAddress:     request.Body.ControllerAddress,
		DataProtectionContact: request.Body.DataProtectionContact,
		AutomaticRunsEnabled:  request.Body.AutomaticRunsEnabled,
		RunIntervalMinutes:    int32(request.Body.RunIntervalMinutes), //nolint:gosec // bounded by the contract (5..1440)
		ExpectedVersion:       request.Body.ExpectedVersion,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdatePrivacySettings200JSONResponse(privacySettingsDTO(settings)), nil
}

func privacySettingsDTO(settings privacy.Settings) openapi.PrivacySettings {
	return openapi.PrivacySettings{
		ControllerName:        settings.ControllerName,
		ControllerAddress:     settings.ControllerAddress,
		DataProtectionContact: settings.DataProtectionContact,
		AutomaticRunsEnabled:  settings.AutomaticRunsEnabled,
		RunIntervalMinutes:    int(settings.RunIntervalMinutes),
		Version:               settings.Version,
		UpdatedAt:             nullablePointer[time.Time](settings.UpdatedAt, func(v time.Time) time.Time { return v }),
	}
}

func privacyCategoryDTO(category privacy.Category) openapi.PrivacyCategory {
	triggers := make([]openapi.RetentionTrigger, 0, len(category.Triggers))
	for _, trigger := range category.Triggers {
		triggers = append(triggers, openapi.RetentionTrigger(trigger))
	}
	actions := make([]openapi.RetentionAction, 0, len(category.Actions))
	for _, action := range category.Actions {
		actions = append(actions, openapi.RetentionAction(action))
	}
	legacy := nullable.NewNullNullable[openapi.PrivacyLegacyDefault]()
	if category.Legacy != nil {
		legacy = nullable.NewNullableWithValue(openapi.PrivacyLegacyDefault{
			Trigger:      openapi.RetentionTrigger(category.Legacy.Trigger),
			PeriodDays:   int(category.Legacy.Period.Hours() / 24),
			Action:       openapi.RetentionAction(category.Legacy.Action),
			Source:       category.Legacy.Source,
			ZeroDisables: category.Legacy.ZeroDisables,
		})
	}
	fields := append([]string{}, category.Fields...)
	return openapi.PrivacyCategory{
		Id:            string(category.ID),
		Name:          category.Name,
		Description:   category.Description,
		OwnerModuleId: string(category.Owner),
		Orphaned:      category.Orphaned,
		Subject:       openapi.PrivacySubject(category.Subject),
		Fields:        fields,
		Triggers:      triggers,
		Actions:       actions,
		LegacyDefault: legacy,
		RetentionNote: category.RetentionNote,
		FirstSeenAt:   category.FirstSeenAt,
		LastSeenAt:    category.LastSeenAt,
	}
}
