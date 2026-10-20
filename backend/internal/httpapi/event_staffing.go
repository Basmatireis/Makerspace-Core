package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
)

func (s *Server) ListEventShifts(
	ctx context.Context,
	r openapi.ListEventShiftsRequestObject,
) (openapi.ListEventShiftsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListShifts(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventShift, 0, len(items))
	for _, item := range items {
		result = append(result, eventShiftDTO(item))
	}
	return openapi.ListEventShifts200JSONResponse{Items: result}, nil
}

func (s *Server) CreateEventShift(
	ctx context.Context,
	r openapi.CreateEventShiftRequestObject,
) (openapi.CreateEventShiftResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CreateShift(ctx, p, r.EventId, eventShiftInput(*r.Body, 0), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateEventShift201JSONResponse(eventShiftDTO(item)), nil
}

func (s *Server) UpdateEventShift(
	ctx context.Context,
	r openapi.UpdateEventShiftRequestObject,
) (openapi.UpdateEventShiftResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := events.ShiftInput{
		SessionID:       nullableUUID(r.Body.SessionId),
		Name:            r.Body.Name,
		Description:     nullableStringPointer(r.Body.Description),
		StartsAt:        r.Body.StartsAt,
		EndsAt:          r.Body.EndsAt,
		SignupOpensAt:   nullableTime(r.Body.SignupOpensAt),
		SignupClosesAt:  nullableTime(r.Body.SignupClosesAt),
		IsPublic:        r.Body.IsPublic,
		Status:          string(r.Body.Status),
		ExpectedVersion: r.Body.ExpectedVersion,
	}
	item, err := s.events.UpdateShift(ctx, p, r.EventId, r.EventShiftId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventShift200JSONResponse(eventShiftDTO(item)), nil
}

func (s *Server) DeleteEventShift(
	ctx context.Context,
	r openapi.DeleteEventShiftRequestObject,
) (openapi.DeleteEventShiftResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.DeleteShift(
		ctx,
		p,
		r.EventId,
		r.EventShiftId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteEventShift204Response{}, nil
}

func (s *Server) ListEventShiftRequirements(
	ctx context.Context,
	r openapi.ListEventShiftRequirementsRequestObject,
) (openapi.ListEventShiftRequirementsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListRequirements(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	result := []openapi.EventRequirement{}
	for _, item := range items {
		if item.ShiftID == r.EventShiftId {
			result = append(result, eventRequirementDTO(item))
		}
	}
	return openapi.ListEventShiftRequirements200JSONResponse{Items: result}, nil
}

func (s *Server) CreateEventShiftRequirement(
	ctx context.Context,
	r openapi.CreateEventShiftRequirementRequestObject,
) (openapi.CreateEventShiftRequirementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CreateRequirement(
		ctx,
		p,
		r.EventId,
		r.EventShiftId,
		eventRequirementInput(*r.Body, 0),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateEventShiftRequirement201JSONResponse(eventRequirementDTO(item)), nil
}

func (s *Server) UpdateEventShiftRequirement(
	ctx context.Context,
	r openapi.UpdateEventShiftRequirementRequestObject,
) (openapi.UpdateEventShiftRequirementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	roles := make([]uuid.UUID, len(r.Body.EligibleRoleIds))
	copy(roles, r.Body.EligibleRoleIds)
	item, err := s.events.UpdateRequirement(
		ctx,
		p,
		r.EventId,
		r.EventShiftId,
		r.EventRequirementId,
		events.RequirementInput{
			Name:            r.Body.Name,
			Description:     nullableStringPointer(r.Body.Description),
			RequiredCount:   r.Body.RequiredCount,
			EligibilityMode: string(r.Body.EligibilityMode),
			EligibleRoleIDs: roles,
			ExpectedVersion: r.Body.ExpectedVersion,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventShiftRequirement200JSONResponse(eventRequirementDTO(item)), nil
}

func (s *Server) DeleteEventShiftRequirement(
	ctx context.Context,
	r openapi.DeleteEventShiftRequirementRequestObject,
) (openapi.DeleteEventShiftRequirementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.DeleteRequirement(
		ctx,
		p,
		r.EventId,
		r.EventShiftId,
		r.EventRequirementId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteEventShiftRequirement204Response{}, nil
}

func (s *Server) ListEventAssignments(
	ctx context.Context,
	r openapi.ListEventAssignmentsRequestObject,
) (openapi.ListEventAssignmentsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListAssignments(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	return openapi.ListEventAssignments200JSONResponse{Items: eventAssignmentDTOs(items)}, nil
}

func (s *Server) CreateEventAssignment(
	ctx context.Context,
	r openapi.CreateEventAssignmentRequestObject,
) (openapi.CreateEventAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CreateStaffAssignment(ctx, p, r.EventId, eventAssignmentInput(*r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateEventAssignment201JSONResponse(eventAssignmentDTO(item)), nil
}

func (s *Server) MoveEventAssignment(
	ctx context.Context,
	r openapi.MoveEventAssignmentRequestObject,
) (openapi.MoveEventAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	shiftID, reqID := r.Body.ShiftId, r.Body.RequirementId
	item, err := s.events.MoveAssignment(
		ctx,
		p,
		r.EventId,
		r.EventAssignmentId,
		events.AssignmentUpdateInput{
			ShiftID:          &shiftID,
			RequirementID:    &reqID,
			ExpectedVersion:  r.Body.ExpectedVersion,
			OverrideConflict: r.Body.OverrideConflict,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.MoveEventAssignment200JSONResponse(eventAssignmentDTO(item)), nil
}

func (s *Server) CancelEventAssignment(
	ctx context.Context,
	r openapi.CancelEventAssignmentRequestObject,
) (openapi.CancelEventAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CancelAssignment(
		ctx,
		p,
		r.EventId,
		r.EventAssignmentId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CancelEventAssignment200JSONResponse(eventAssignmentDTO(item)), nil
}

func (s *Server) ListEventAssignmentPersonMatches(
	ctx context.Context,
	r openapi.ListEventAssignmentPersonMatchesRequestObject,
) (openapi.ListEventAssignmentPersonMatchesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.FindAssignmentPersonMatches(ctx, p, r.EventId, r.EventAssignmentId)
	if err != nil {
		return nil, err
	}
	return openapi.ListEventAssignmentPersonMatches200JSONResponse{Items: eventPersonDTOs(items)}, nil
}

func (s *Server) LinkEventAssignmentPerson(
	ctx context.Context,
	r openapi.LinkEventAssignmentPersonRequestObject,
) (openapi.LinkEventAssignmentPersonResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.LinkAssignmentPerson(
		ctx,
		p,
		r.EventId,
		r.EventAssignmentId,
		r.Body.PersonId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.LinkEventAssignmentPerson200JSONResponse(eventAssignmentDTO(item)), nil
}

func (s *Server) ListEventEligibilityRoles(
	ctx context.Context,
	_ openapi.ListEventEligibilityRolesRequestObject,
) (openapi.ListEventEligibilityRolesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListEligibilityRoles(ctx, p)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventRole, 0, len(items))
	for _, item := range items {
		result = append(result, openapi.EventRole{Id: item.ID, Name: item.Name})
	}
	return openapi.ListEventEligibilityRoles200JSONResponse{Items: result}, nil
}

func (s *Server) ListEventPeople(
	ctx context.Context,
	r openapi.ListEventPeopleRequestObject,
) (openapi.ListEventPeopleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	search := ""
	if r.Params.Search != nil {
		search = *r.Params.Search
	}
	items, err := s.events.FindPeople(ctx, p, search)
	if err != nil {
		return nil, err
	}
	return openapi.ListEventPeople200JSONResponse{Items: eventPersonDTOs(items)}, nil
}

func eventShiftInput(v openapi.EventShiftInput, version int64) events.ShiftInput {
	return events.ShiftInput{
		SessionID:       nullableUUID(v.SessionId),
		Name:            v.Name,
		Description:     nullableStringPointer(v.Description),
		StartsAt:        v.StartsAt,
		EndsAt:          v.EndsAt,
		SignupOpensAt:   nullableTime(v.SignupOpensAt),
		SignupClosesAt:  nullableTime(v.SignupClosesAt),
		IsPublic:        v.IsPublic,
		Status:          string(v.Status),
		ExpectedVersion: version,
	}
}
func eventShiftDTO(v events.Shift) openapi.EventShift {
	return openapi.EventShift{
		Id:      v.ID,
		EventId: v.EventID,
		SessionId: nullablePointer[openapi.UUIDv7](
			v.SessionID,
			func(x uuid.UUID) openapi.UUIDv7 { return x },
		),
		Name:           v.Name,
		Description:    nullablePointer[string](v.Description, func(x string) string { return x }),
		StartsAt:       v.StartsAt,
		EndsAt:         v.EndsAt,
		SignupOpensAt:  nullablePointer(v.SignupOpensAt, func(x time.Time) time.Time { return x }),
		SignupClosesAt: nullablePointer(v.SignupClosesAt, func(x time.Time) time.Time { return x }),
		IsPublic:       v.IsPublic,
		Status:         openapi.EventShiftStatus(v.Status),
		LinkedSessionStatus: nullablePointer(
			v.LinkedSessionStatus,
			func(x string) openapi.EventSessionStatus { return openapi.EventSessionStatus(x) },
		),
		Version:   v.Version,
		CreatedAt: v.CreatedAt,
		UpdatedAt: v.UpdatedAt,
	}
}
func eventRequirementInput(v openapi.EventRequirementInput, version int64) events.RequirementInput {
	roles := make([]uuid.UUID, len(v.EligibleRoleIds))
	copy(roles, v.EligibleRoleIds)
	return events.RequirementInput{
		Name:            v.Name,
		Description:     nullableStringPointer(v.Description),
		RequiredCount:   v.RequiredCount,
		EligibilityMode: string(v.EligibilityMode),
		EligibleRoleIDs: roles,
		ExpectedVersion: version,
	}
}
func eventRequirementDTO(v events.Requirement) openapi.EventRequirement {
	roles := make([]openapi.UUIDv7, len(v.EligibleRoleIDs))
	copy(roles, v.EligibleRoleIDs)
	return openapi.EventRequirement{
		Id:              v.ID,
		EventId:         v.EventID,
		ShiftId:         v.ShiftID,
		Name:            v.Name,
		Description:     nullablePointer[string](v.Description, func(x string) string { return x }),
		RequiredCount:   v.RequiredCount,
		FilledCount:     v.FilledCount,
		EligibilityMode: openapi.EventEligibilityMode(v.EligibilityMode),
		EligibleRoleIds: roles,
		Version:         v.Version,
		CreatedAt:       v.CreatedAt,
		UpdatedAt:       v.UpdatedAt,
	}
}
func eventAssignmentInput(v openapi.EventAssignmentInput) events.AssignmentInput {
	first, last := "", ""
	if v.FirstName != nil {
		first = *v.FirstName
	}
	if v.LastName != nil {
		last = *v.LastName
	}
	return events.AssignmentInput{
		ShiftID:          v.ShiftId,
		RequirementID:    v.RequirementId,
		PersonID:         nullableUUID(v.PersonId),
		FirstName:        first,
		LastName:         last,
		Email:            nullableStringPointer(v.Email),
		Phone:            nullableStringPointer(v.Phone),
		OverrideConflict: v.OverrideConflict,
	}
}
func eventAssignmentDTO(v events.Assignment) openapi.EventAssignment {
	return openapi.EventAssignment{
		Id:            v.ID,
		EventId:       v.EventID,
		ShiftId:       v.ShiftID,
		RequirementId: v.RequirementID,
		PersonId: nullablePointer[openapi.UUIDv7](
			v.PersonID,
			func(x uuid.UUID) openapi.UUIDv7 { return x },
		),
		FirstName: nullablePointer[string](v.FirstName, func(x string) string { return x }),
		LastName:  nullablePointer[string](v.LastName, func(x string) string { return x }),
		Email:     nullablePointer[string](v.Email, func(x string) string { return x }),
		Phone:     nullablePointer[string](v.Phone, func(x string) string { return x }),
		Source:    openapi.EventAssignmentSource(v.Source),
		Status:    openapi.EventAssignmentStatus(v.Status),
		ConflictOverriddenByAccountId: nullablePointer[openapi.UUIDv7](
			v.ConflictOverriddenByAccountID,
			func(x uuid.UUID) openapi.UUIDv7 { return x },
		),
		CancelledAt: nullablePointer(v.CancelledAt, func(x time.Time) time.Time { return x }),
		PersonalDataErasedAt: nullablePointer(
			v.PersonalDataErasedAt,
			func(x time.Time) time.Time { return x },
		),
		Version:   v.Version,
		CreatedAt: v.CreatedAt,
		UpdatedAt: v.UpdatedAt,
	}
}
func eventAssignmentDTOs(values []events.Assignment) []openapi.EventAssignment {
	result := make([]openapi.EventAssignment, 0, len(values))
	for _, v := range values {
		result = append(result, eventAssignmentDTO(v))
	}
	return result
}
func eventPersonDTOs(values []events.PersonOption) []openapi.EventPersonOption {
	result := make([]openapi.EventPersonOption, 0, len(values))
	for _, v := range values {
		result = append(
			result,
			openapi.EventPersonOption{
				Id:        v.ID,
				FirstName: v.FirstName,
				LastName:  v.LastName,
				Email:     nullablePointer[string](v.Email, func(x string) string { return x }),
				Phone:     nullablePointer[string](v.Phone, func(x string) string { return x }),
			},
		)
	}
	return result
}
