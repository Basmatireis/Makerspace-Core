package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/google/uuid"
)

func (s *Server) ListPrivacyPolicies(
	ctx context.Context,
	_ openapi.ListPrivacyPoliciesRequestObject,
) (openapi.ListPrivacyPoliciesResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	policies, err := s.privacy.ListPolicies(ctx, principal)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.RetentionPolicy, 0, len(policies))
	for _, policy := range policies {
		result = append(result, policyDTO(policy))
	}
	return openapi.ListPrivacyPolicies200JSONResponse{Policies: result}, nil
}

func policyInputFrom(body *openapi.RetentionPolicyInput) privacy.PolicyInput {
	return privacy.PolicyInput{
		Category:   privacy.CategoryID(body.CategoryId),
		Trigger:    privacy.Trigger(body.Trigger),
		PeriodDays: int32(body.PeriodDays), //nolint:gosec // bounded by the contract
		Action:     privacy.Action(body.Action),
		Purpose:    body.Purpose,
		LegalBasis: body.LegalBasis,
		Reason:     body.Reason,
	}
}

func (s *Server) CreatePrivacyPolicy(
	ctx context.Context,
	request openapi.CreatePrivacyPolicyRequestObject,
) (openapi.CreatePrivacyPolicyResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	policy, err := s.privacy.CreatePolicy(ctx, principal, policyInputFrom(request.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreatePrivacyPolicy201JSONResponse(policyDTO(policy)), nil
}

func (s *Server) UpdatePrivacyPolicy(
	ctx context.Context,
	request openapi.UpdatePrivacyPolicyRequestObject,
) (openapi.UpdatePrivacyPolicyResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	policy, err := s.privacy.UpdatePolicy(ctx, principal, request.PolicyId, policyInputFrom(request.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdatePrivacyPolicy200JSONResponse(policyDTO(policy)), nil
}

func (s *Server) TransitionPrivacyPolicy(
	ctx context.Context,
	request openapi.TransitionPrivacyPolicyRequestObject,
) (openapi.TransitionPrivacyPolicyResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	policy, err := s.privacy.TransitionPolicy(ctx, principal, request.PolicyId, string(request.Body.Status), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.TransitionPrivacyPolicy200JSONResponse(policyDTO(policy)), nil
}

func (s *Server) ListPrivacyHolds(
	ctx context.Context,
	_ openapi.ListPrivacyHoldsRequestObject,
) (openapi.ListPrivacyHoldsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	holds, err := s.privacy.ListHolds(ctx, principal)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.RetentionHold, 0, len(holds))
	for _, hold := range holds {
		result = append(result, retentionHoldDTO(hold))
	}
	return openapi.ListPrivacyHolds200JSONResponse{Holds: result}, nil
}

func (s *Server) CreatePrivacyHold(
	ctx context.Context,
	request openapi.CreatePrivacyHoldRequestObject,
) (openapi.CreatePrivacyHoldResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	var category *privacy.CategoryID
	if request.Body.CategoryId != nil {
		value := privacy.CategoryID(*request.Body.CategoryId)
		category = &value
	}
	hold, err := s.privacy.CreateHold(ctx, principal, category, request.Body.PersonId, request.Body.Reason, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreatePrivacyHold201JSONResponse(retentionHoldDTO(hold)), nil
}

func (s *Server) ReleasePrivacyHold(
	ctx context.Context,
	request openapi.ReleasePrivacyHoldRequestObject,
) (openapi.ReleasePrivacyHoldResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	hold, err := s.privacy.ReleaseHold(ctx, principal, request.HoldId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReleasePrivacyHold200JSONResponse(retentionHoldDTO(hold)), nil
}

func (s *Server) ListRetentionRuns(
	ctx context.Context,
	_ openapi.ListRetentionRunsRequestObject,
) (openapi.ListRetentionRunsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	runs, err := s.privacy.ListRuns(ctx, principal)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.RetentionRun, 0, len(runs))
	for _, run := range runs {
		result = append(result, runDTO(run))
	}
	return openapi.ListRetentionRuns200JSONResponse{Runs: result}, nil
}

func (s *Server) StartRetentionRun(
	ctx context.Context,
	request openapi.StartRetentionRunRequestObject,
) (openapi.StartRetentionRunResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	var categories []privacy.CategoryID
	if request.Body.CategoryIds != nil {
		for _, id := range *request.Body.CategoryIds {
			categories = append(categories, privacy.CategoryID(id))
		}
	}
	run, err := s.privacy.StartRun(ctx, principal, string(request.Body.Mode), categories, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	if run.ID == uuid.Nil {
		run.Mode = string(request.Body.Mode)
		run.Trigger = privacy.TriggerManual
		run.StartedAt = time.Now().UTC()
		run.Status = "completed"
	}
	return openapi.StartRetentionRun200JSONResponse(runDTO(run)), nil
}

func (s *Server) GetRetentionRun(
	ctx context.Context,
	request openapi.GetRetentionRunRequestObject,
) (openapi.GetRetentionRunResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	run, err := s.privacy.GetRun(ctx, principal, request.RunId)
	if err != nil {
		return nil, err
	}
	return openapi.GetRetentionRun200JSONResponse(runDTO(run)), nil
}

func policyDTO(policy privacy.Policy) openapi.RetentionPolicy {
	return openapi.RetentionPolicy{
		Id:             policy.ID,
		CategoryId:     string(policy.Category),
		Version:        int(policy.Version),
		Trigger:        openapi.RetentionTrigger(policy.Trigger),
		PeriodDays:     int(policy.PeriodDays),
		Action:         openapi.RetentionAction(policy.Action),
		Purpose:        policy.Purpose,
		LegalBasis:     policy.LegalBasis,
		Reason:         policy.Reason,
		Status:         openapi.RetentionPolicyStatus(policy.Status),
		SourceTemplate: nullablePointer[string](policy.SourceTemplate, func(v string) string { return v }),
		CreatedAt:      policy.CreatedAt,
		UpdatedAt:      policy.UpdatedAt,
		ApprovedAt:     nullablePointer[time.Time](policy.ApprovedAt, func(v time.Time) time.Time { return v }),
		ActivatedAt:    nullablePointer[time.Time](policy.ActivatedAt, func(v time.Time) time.Time { return v }),
		RetiredAt:      nullablePointer[time.Time](policy.RetiredAt, func(v time.Time) time.Time { return v }),
		CreatedBy:      nullablePointer[uuid.UUID](policy.CreatedBy, func(v uuid.UUID) uuid.UUID { return v }),
		ApprovedBy:     nullablePointer[uuid.UUID](policy.ApprovedBy, func(v uuid.UUID) uuid.UUID { return v }),
		ActivatedBy:    nullablePointer[uuid.UUID](policy.ActivatedBy, func(v uuid.UUID) uuid.UUID { return v }),
	}
}

func retentionHoldDTO(hold privacy.Hold) openapi.RetentionHold {
	return openapi.RetentionHold{
		Id:         hold.ID,
		CategoryId: nullablePointer[privacy.CategoryID](hold.Category, func(v privacy.CategoryID) string { return string(v) }),
		PersonId:   nullablePointer[uuid.UUID](hold.PersonID, func(v uuid.UUID) uuid.UUID { return v }),
		Reason:     hold.Reason,
		CreatedAt:  hold.CreatedAt,
		CreatedBy:  nullablePointer[uuid.UUID](hold.CreatedBy, func(v uuid.UUID) uuid.UUID { return v }),
		ReleasedAt: nullablePointer[time.Time](hold.ReleasedAt, func(v time.Time) time.Time { return v }),
		ReleasedBy: nullablePointer[uuid.UUID](hold.ReleasedBy, func(v uuid.UUID) uuid.UUID { return v }),
	}
}

func runDTO(run privacy.Run) openapi.RetentionRun {
	items := make([]openapi.RetentionRunItem, 0, len(run.Items))
	for _, item := range run.Items {
		var code *string
		if item.Error != "" {
			value := item.Error
			code = &value
		}
		items = append(items, openapi.RetentionRunItem{
			CategoryId:    string(item.Category),
			PolicyId:      nullablePointer[uuid.UUID](item.PolicyID, func(v uuid.UUID) uuid.UUID { return v }),
			Action:        openapi.RetentionAction(item.Action),
			Cutoff:        item.Cutoff,
			AffectedCount: item.Affected,
			Status:        openapi.RetentionRunItemStatus(item.Status),
			ErrorCode:     nullablePointer[string](code, func(v string) string { return v }),
		})
	}
	var id *uuid.UUID
	if run.ID != uuid.Nil {
		value := run.ID
		id = &value
	}
	var errorCode *string
	if run.ErrorCode != "" {
		value := run.ErrorCode
		errorCode = &value
	}
	return openapi.RetentionRun{
		Id:             nullablePointer[uuid.UUID](id, func(v uuid.UUID) uuid.UUID { return v }),
		Mode:           openapi.RetentionRunMode(run.Mode),
		Trigger:        openapi.RetentionRunTrigger(run.Trigger),
		ActorAccountId: nullablePointer[uuid.UUID](run.ActorID, func(v uuid.UUID) uuid.UUID { return v }),
		StartedAt:      run.StartedAt,
		FinishedAt:     nullablePointer[time.Time](run.FinishedAt, func(v time.Time) time.Time { return v }),
		Status:         openapi.RetentionRunStatus(run.Status),
		ErrorCode:      nullablePointer[string](errorCode, func(v string) string { return v }),
		Items:          items,
	}
}
