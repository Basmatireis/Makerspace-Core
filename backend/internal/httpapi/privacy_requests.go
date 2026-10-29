package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

// Processing activities ---------------------------------------------------------

func (s *Server) ListProcessingActivities(
	ctx context.Context,
	_ openapi.ListProcessingActivitiesRequestObject,
) (openapi.ListProcessingActivitiesResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	activities, err := s.subjectRequests.ListActivities(ctx, principal)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.ProcessingActivity, 0, len(activities))
	for _, activity := range activities {
		result = append(result, activityDTO(activity))
	}
	return openapi.ListProcessingActivities200JSONResponse{Activities: result}, nil
}

func activityInputFrom(body openapi.ProcessingActivityInput) subjectrequests.ActivityInput {
	ids := make([]privacy.CategoryID, 0, len(body.CategoryIds))
	for _, id := range body.CategoryIds {
		ids = append(ids, privacy.CategoryID(id))
	}
	return subjectrequests.ActivityInput{
		Name: body.Name, Purpose: body.Purpose, LegalBasis: body.LegalBasis, CategoryIDs: ids,
		Recipients: body.Recipients, RetentionNote: body.RetentionNote,
	}
}

func (s *Server) CreateProcessingActivity(
	ctx context.Context,
	request openapi.CreateProcessingActivityRequestObject,
) (openapi.CreateProcessingActivityResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	activity, err := s.subjectRequests.CreateActivity(ctx, principal, activityInputFrom(*request.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateProcessingActivity201JSONResponse(activityDTO(activity)), nil
}

func (s *Server) UpdateProcessingActivity(
	ctx context.Context,
	request openapi.UpdateProcessingActivityRequestObject,
) (openapi.UpdateProcessingActivityResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := request.Body
	input := activityInputFrom(openapi.ProcessingActivityInput{
		Name: body.Name, Purpose: body.Purpose, LegalBasis: body.LegalBasis, CategoryIds: body.CategoryIds,
		Recipients: body.Recipients, RetentionNote: body.RetentionNote,
	})
	activity, err := s.subjectRequests.UpdateActivity(ctx, principal, request.ActivityId, input, body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateProcessingActivity200JSONResponse(activityDTO(activity)), nil
}

func (s *Server) DeleteProcessingActivity(
	ctx context.Context,
	request openapi.DeleteProcessingActivityRequestObject,
) (openapi.DeleteProcessingActivityResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.subjectRequests.DeleteActivity(ctx, principal, request.ActivityId, request.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteProcessingActivity204Response{}, nil
}

func activityDTO(activity subjectrequests.Activity) openapi.ProcessingActivity {
	ids := make([]openapi.PrivacyCategoryId, 0, len(activity.CategoryIDs))
	for _, id := range activity.CategoryIDs {
		ids = append(ids, string(id))
	}
	return openapi.ProcessingActivity{
		Id: activity.ID, Name: activity.Name, Purpose: activity.Purpose, LegalBasis: activity.LegalBasis, CategoryIds: ids,
		Recipients: activity.Recipients, RetentionNote: activity.RetentionNote, Version: activity.Version,
		CreatedAt: activity.CreatedAt, UpdatedAt: activity.UpdatedAt, UpdatedBy: nullableID(activity.UpdatedBy),
	}
}

// Data-subject requests ------------------------------------------------------------

func (s *Server) ListSubjectRequests(
	ctx context.Context,
	_ openapi.ListSubjectRequestsRequestObject,
) (openapi.ListSubjectRequestsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	requests, err := s.subjectRequests.List(ctx, principal)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.SubjectRequest, 0, len(requests))
	for _, request := range requests {
		result = append(result, subjectRequestDTO(request))
	}
	return openapi.ListSubjectRequests200JSONResponse{Requests: result}, nil
}

func (s *Server) CreateSubjectRequest(
	ctx context.Context,
	request openapi.CreateSubjectRequestRequestObject,
) (openapi.CreateSubjectRequestResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := request.Body
	input := subjectrequests.Input{
		Kind: string(body.Kind), PersonID: body.PersonId, Channel: string(body.Channel), ReceivedAt: body.ReceivedAt,
	}
	if body.Reference != nil {
		input.Reference = *body.Reference
	}
	if body.Notes != nil {
		input.Notes = *body.Notes
	}
	created, err := s.subjectRequests.Create(ctx, principal, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateSubjectRequest201JSONResponse(subjectRequestDTO(created)), nil
}

func (s *Server) GetSubjectRequest(
	ctx context.Context,
	request openapi.GetSubjectRequestRequestObject,
) (openapi.GetSubjectRequestResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	found, err := s.subjectRequests.Get(ctx, principal, request.RequestId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSubjectRequest200JSONResponse(subjectRequestDTO(found)), nil
}

func (s *Server) TransitionSubjectRequest(
	ctx context.Context,
	request openapi.TransitionSubjectRequestRequestObject,
) (openapi.TransitionSubjectRequestResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	note := ""
	if request.Body.Note != nil {
		note = *request.Body.Note
	}
	updated, err := s.subjectRequests.Transition(
		ctx, principal, request.RequestId, string(request.Body.Status), note, request.Body.ExpectedVersion, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.TransitionSubjectRequest200JSONResponse(subjectRequestDTO(updated)), nil
}

func (s *Server) ExecuteSubjectRequest(
	ctx context.Context,
	request openapi.ExecuteSubjectRequestRequestObject,
) (openapi.ExecuteSubjectRequestResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	executed, err := s.subjectRequests.Execute(ctx, principal, request.RequestId, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ExecuteSubjectRequest200JSONResponse(subjectRequestDTO(executed)), nil
}

func (s *Server) DownloadSubjectRequestExport(
	ctx context.Context,
	request openapi.DownloadSubjectRequestExportRequestObject,
) (openapi.DownloadSubjectRequestExportResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.subjectRequests.OpenExport(ctx, principal, request.RequestId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DownloadSubjectRequestExport200ApplicationzipResponse{
		Body:          reader,
		ContentLength: file.Size,
		Headers: openapi.DownloadSubjectRequestExport200ResponseHeaders{
			CacheControl:          "no-store",
			ContentDisposition:    attachmentDisposition(subjectrequests.ExportFilename(request.RequestId)),
			XContentTypeOptions:   "nosniff",
			ContentSecurityPolicy: "default-src 'none'; sandbox",
		},
	}, nil
}

func nullableName(name *string) nullable.Nullable[string] {
	if name == nil {
		return nullable.NewNullNullable[string]()
	}
	return nullable.NewNullableWithValue(*name)
}

func nullableID(id *uuid.UUID) nullable.Nullable[uuid.UUID] {
	return nullablePointer[uuid.UUID](id, func(v uuid.UUID) uuid.UUID { return v })
}

func assessmentDTO(assessment *subjectrequests.Assessment) nullable.Nullable[openapi.SubjectRequestAssessment] {
	if assessment == nil {
		return nullable.NewNullNullable[openapi.SubjectRequestAssessment]()
	}
	categories := make([]openapi.SubjectRequestCategory, 0, len(assessment.Categories))
	for _, category := range assessment.Categories {
		outcome := nullable.NewNullNullable[openapi.SubjectRequestOutcome]()
		if category.Outcome != nil {
			outcome = nullable.NewNullableWithValue(openapi.SubjectRequestOutcome(*category.Outcome))
		}
		categories = append(categories, openapi.SubjectRequestCategory{
			CategoryId: string(category.CategoryID), Name: category.Name, Records: category.Records, Outcome: outcome, Note: category.Note,
		})
	}
	uncovered := make([]openapi.PrivacyCategoryId, 0, len(assessment.UncoveredCategories))
	for _, id := range assessment.UncoveredCategories {
		uncovered = append(uncovered, string(id))
	}
	blockers := assessment.Blockers
	if blockers == nil {
		blockers = []string{}
	}
	return nullable.NewNullableWithValue(openapi.SubjectRequestAssessment{
		Categories: categories, Blockers: blockers, OpenHolds: int(assessment.OpenHolds), UncoveredCategories: uncovered,
	})
}

func subjectRequestDTO(request subjectrequests.Request) openapi.SubjectRequest {
	steps := make([]openapi.SubjectRequestStep, 0, len(request.Steps))
	for _, step := range request.Steps {
		steps = append(steps, openapi.SubjectRequestStep{
			Status: openapi.SubjectRequestStatus(step.Status), OccurredAt: step.OccurredAt, Actor: nullableID(step.Actor),
			ActorName: nullableName(step.ActorName), Note: step.Note,
		})
	}
	return openapi.SubjectRequest{
		Id:                     request.ID,
		Kind:                   openapi.SubjectRequestKind(request.Kind),
		Status:                 openapi.SubjectRequestStatus(request.Status),
		PersonId:               nullableID(request.PersonID),
		PersonName:             nullableName(request.PersonName),
		Reference:              request.Reference,
		Channel:                openapi.SubjectRequestChannel(request.Channel),
		ReceivedAt:             request.ReceivedAt,
		DueAt:                  request.DueAt,
		Notes:                  request.Notes,
		IdentityVerifiedAt:     nullableTimestamp(request.IdentityVerifiedAt),
		IdentityVerifiedBy:     nullableID(request.IdentityVerifiedBy),
		IdentityVerifiedByName: nullableName(request.IdentityVerifiedByName),
		AssessedAt:             nullableTimestamp(request.AssessedAt),
		Assessment:             assessmentDTO(request.Assessment),
		ApprovedAt:             nullableTimestamp(request.ApprovedAt),
		ApprovedBy:             nullableID(request.ApprovedBy),
		ApprovedByName:         nullableName(request.ApprovedByName),
		ExecutedAt:             nullableTimestamp(request.ExecutedAt),
		ExecutedBy:             nullableID(request.ExecutedBy),
		ExecutedByName:         nullableName(request.ExecutedByName),
		Result:                 assessmentDTO(request.Result),
		ExportAvailable:        request.ExportFileID != nil,
		CompletedAt:            nullableTimestamp(request.CompletedAt),
		RejectionReason:        request.RejectionReason,
		Steps:                  steps,
		Version:                request.Version,
		CreatedAt:              request.CreatedAt,
		CreatedBy:              nullableID(request.CreatedBy),
	}
}
