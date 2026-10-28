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
	lastRun := nullable.NewNullNullable[openapi.RetentionRunSummary]()
	if overview.LastRun != nil {
		run := overview.LastRun
		lastRun = nullable.NewNullableWithValue(openapi.RetentionRunSummary{
			Id: run.ID, Mode: openapi.RetentionRunMode(run.Mode), Trigger: openapi.RetentionRunSummaryTrigger(run.Trigger),
			StartedAt: run.StartedAt, FinishedAt: nullableTimeValue(run.FinishedAt),
			Status: openapi.RetentionRunSummaryStatus(run.Status), AffectedCount: run.Affected,
		})
	}
	return openapi.GetPrivacyOverview200JSONResponse{
		Categories:           overview.Categories,
		OrphanedCategories:   overview.OrphanedCategories,
		AutomaticRunsEnabled: overview.AutomaticRunsEnabled,
		PoliciesActive:       overview.PoliciesActive,
		PoliciesPending:      overview.PoliciesPending,
		WithoutPolicy:        overview.WithoutPolicy,
		OpenCategoryHolds:    overview.OpenCategoryHolds,
		OpenPersonHolds:      overview.OpenPersonHolds,
		LastRun:              lastRun,
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
	coverage, err := s.privacy.Coverage(ctx, principal)
	if err != nil {
		return nil, err
	}
	activities, err := s.subjectRequests.ListActivities(ctx, principal)
	if err != nil {
		return nil, err
	}
	byCategory := map[privacy.CategoryID][]openapi.ProcessingActivityReference{}
	for _, activity := range activities {
		for _, id := range activity.CategoryIDs {
			byCategory[id] = append(byCategory[id], openapi.ProcessingActivityReference{Id: activity.ID, Name: activity.Name})
		}
	}
	result := make([]openapi.PrivacyCategory, 0, len(categories))
	for _, category := range categories {
		result = append(result, privacyCategoryDTO(category, privacy.CoverageOf(coverage, category.ID), byCategory[category.ID]))
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

func coverageDTO(coverage privacy.Coverage, activities []openapi.ProcessingActivityReference) openapi.PrivacyCategoryCoverage {
	policy := nullable.NewNullNullable[openapi.RetentionPolicy]()
	if coverage.Policy != nil {
		policy = nullable.NewNullableWithValue(policyDTO(*coverage.Policy))
	}
	hold := nullable.NewNullNullable[openapi.RetentionHold]()
	if coverage.Hold != nil {
		hold = nullable.NewNullableWithValue(retentionHoldDTO(*coverage.Hold))
	}
	lastRun := nullable.NewNullNullable[openapi.RetentionRunItemSummary]()
	if coverage.LastRun != nil {
		item := coverage.LastRun
		lastRun = nullable.NewNullableWithValue(openapi.RetentionRunItemSummary{
			RunId: item.RunID, Mode: openapi.RetentionRunMode(item.Mode), Trigger: openapi.RetentionRunItemSummaryTrigger(item.Trigger),
			StartedAt: item.StartedAt, Action: openapi.RetentionAction(item.Action), AffectedCount: item.Affected,
			Status: openapi.RetentionRunItemSummaryStatus(item.Status),
		})
	}
	if activities == nil {
		activities = []openapi.ProcessingActivityReference{}
	}
	return openapi.PrivacyCategoryCoverage{
		PolicyStatus: openapi.PrivacyCategoryCoveragePolicyStatus(coverage.PolicyStatus),
		Policy:       policy, Hold: hold, LastRun: lastRun, ProcessingActivities: activities,
	}
}

func privacyCategoryDTO(
	category privacy.Category, coverage privacy.Coverage, activities []openapi.ProcessingActivityReference,
) openapi.PrivacyCategory {
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
	erasure := category.ErasureOutcome
	if erasure == "" {
		erasure = privacy.ErasureNone
	}
	return openapi.PrivacyCategory{
		Id:            string(category.ID),
		Name:          category.Name,
		Description:   category.Description,
		Contains:      category.Contains,
		Erasure:       openapi.PrivacyCategoryErasure(erasure),
		Coverage:      coverageDTO(coverage, activities),
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
