package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
)

func (s *Server) GetPublicEvent(
	ctx context.Context,
	r openapi.GetPublicEventRequestObject,
) (openapi.GetPublicEventResponseObject, error) {
	item, err := s.events.GetPublic(ctx, r.PublicId)
	if err != nil {
		return nil, err
	}
	return openapi.GetPublicEvent200JSONResponse(publicEventDTO(item)), nil
}

func (s *Server) CreatePublicEventSignup(
	ctx context.Context,
	r openapi.CreatePublicEventSignupRequestObject,
) (openapi.CreatePublicEventSignupResponseObject, error) {
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	result, err := s.events.SignupAnonymous(
		ctx,
		r.PublicId,
		sourceAddress(ctx),
		eventSignupInput(*r.Body),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreatePublicEventSignup201JSONResponse{
		Body:    eventSignupResultDTO(result),
		Headers: openapi.CreatePublicEventSignup201ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) CreateAuthenticatedEventSignup(
	ctx context.Context,
	r openapi.CreateAuthenticatedEventSignupRequestObject,
) (openapi.CreateAuthenticatedEventSignupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := events.AssignmentInput{
		ShiftID:       r.Body.ShiftId,
		RequirementID: r.Body.RequirementId,
		FirstName:     r.Body.FirstName,
		LastName:      r.Body.LastName,
		Email:         nullableStringPointer(r.Body.Email),
		Phone:         nullableStringPointer(r.Body.Phone),
	}
	result, err := s.events.SignupAuthenticated(
		ctx,
		p,
		r.PublicId,
		sourceAddress(ctx),
		string(r.Body.SignupFor),
		input,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateAuthenticatedEventSignup201JSONResponse{
		Body:    eventSignupResultDTO(result),
		Headers: openapi.CreateAuthenticatedEventSignup201ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) GetCurrentEventSignup(
	ctx context.Context,
	r openapi.GetCurrentEventSignupRequestObject,
) (openapi.GetCurrentEventSignupResponseObject, error) {
	item, err := s.events.GetManagedSignup(ctx, r.Params.XEventSignupToken)
	if err != nil {
		return nil, err
	}
	return openapi.GetCurrentEventSignup200JSONResponse{
		Body:    eventSignupDTO(item),
		Headers: openapi.GetCurrentEventSignup200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) UpdateCurrentEventSignup(
	ctx context.Context,
	r openapi.UpdateCurrentEventSignupRequestObject,
) (openapi.UpdateCurrentEventSignupResponseObject, error) {
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.UpdateManagedSignup(
		ctx,
		r.Params.XEventSignupToken,
		eventSignupUpdateInput(*r.Body),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateCurrentEventSignup200JSONResponse{
		Body:    eventSignupDTO(item),
		Headers: openapi.UpdateCurrentEventSignup200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) CancelCurrentEventSignup(
	ctx context.Context,
	r openapi.CancelCurrentEventSignupRequestObject,
) (openapi.CancelCurrentEventSignupResponseObject, error) {
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CancelManagedSignup(
		ctx,
		r.Params.XEventSignupToken,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CancelCurrentEventSignup200JSONResponse{
		Body:    eventSignupDTO(item),
		Headers: openapi.CancelCurrentEventSignup200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) ListOwnPublicEventAssignments(
	ctx context.Context,
	r openapi.ListOwnPublicEventAssignmentsRequestObject,
) (openapi.ListOwnPublicEventAssignmentsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListOwnAssignments(ctx, p, r.PublicId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventSignup, 0, len(items))
	for _, item := range items {
		result = append(result, eventSignupDTO(item))
	}
	return openapi.ListOwnPublicEventAssignments200JSONResponse{
		Body:    openapi.EventSignupList{Items: result},
		Headers: openapi.ListOwnPublicEventAssignments200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) UpdateOwnPublicEventAssignment(
	ctx context.Context,
	r openapi.UpdateOwnPublicEventAssignmentRequestObject,
) (openapi.UpdateOwnPublicEventAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.UpdateOwnAssignment(
		ctx,
		p,
		r.PublicId,
		r.EventAssignmentId,
		eventSignupUpdateInput(*r.Body),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOwnPublicEventAssignment200JSONResponse{
		Body:    eventSignupDTO(item),
		Headers: openapi.UpdateOwnPublicEventAssignment200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) CancelOwnPublicEventAssignment(
	ctx context.Context,
	r openapi.CancelOwnPublicEventAssignmentRequestObject,
) (openapi.CancelOwnPublicEventAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CancelOwnAssignment(
		ctx,
		p,
		r.PublicId,
		r.EventAssignmentId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CancelOwnPublicEventAssignment200JSONResponse{
		Body:    eventSignupDTO(item),
		Headers: openapi.CancelOwnPublicEventAssignment200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) DownloadPublicEventFile(
	ctx context.Context,
	r openapi.DownloadPublicEventFileRequestObject,
) (openapi.DownloadPublicEventFileResponseObject, error) {
	_, file, reader, err := s.events.OpenPublicFile(ctx, r.PublicId, r.EventFileId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadPublicEventFile200ApplicationoctetStreamResponse{
		Body:          reader,
		ContentLength: file.Size,
		Headers: openapi.DownloadPublicEventFile200ResponseHeaders{
			CacheControl:          "no-store",
			ContentDisposition:    attachmentDisposition(file.OriginalFilename),
			XContentTypeOptions:   "nosniff",
			ContentSecurityPolicy: "default-src 'none'; sandbox",
		},
	}, nil
}

func (s *Server) GetPublicEventBanner(
	ctx context.Context,
	r openapi.GetPublicEventBannerRequestObject,
) (openapi.GetPublicEventBannerResponseObject, error) {
	file, reader, err := s.events.OpenPublicBanner(ctx, r.PublicId)
	if err != nil {
		return nil, err
	}
	headers := openapi.GetPublicEventBanner200ResponseHeaders{
		CacheControl:          "no-store",
		XContentTypeOptions:   "nosniff",
		ContentSecurityPolicy: "default-src 'none'; sandbox",
	}
	switch file.ContentType {
	case "image/jpeg":
		return openapi.GetPublicEventBanner200ImagejpegResponse{
			Body:          reader,
			ContentLength: file.Size,
			Headers:       headers,
		}, nil
	case "image/png":
		return openapi.GetPublicEventBanner200ImagepngResponse{
			Body:          reader,
			ContentLength: file.Size,
			Headers:       headers,
		}, nil
	case "image/gif":
		return openapi.GetPublicEventBanner200ImagegifResponse{
			Body:          reader,
			ContentLength: file.Size,
			Headers:       headers,
		}, nil
	case "image/webp":
		return openapi.GetPublicEventBanner200ImagewebpResponse{
			Body:          reader,
			ContentLength: file.Size,
			Headers:       headers,
		}, nil
	default:
		_ = reader.Close()
		return nil, invalidRequest("stored public Event banner content type is invalid")
	}
}

func eventSignupInput(v openapi.EventSignupRequest) events.AssignmentInput {
	return events.AssignmentInput{
		ShiftID:       v.ShiftId,
		RequirementID: v.RequirementId,
		FirstName:     v.FirstName,
		LastName:      v.LastName,
		Email:         nullableStringPointer(v.Email),
		Phone:         nullableStringPointer(v.Phone),
	}
}
func eventSignupUpdateInput(v openapi.UpdateEventSignupRequest) events.AssignmentUpdateInput {
	first, last := "", ""
	if v.FirstName != nil {
		first = *v.FirstName
	}
	if v.LastName != nil {
		last = *v.LastName
	}
	return events.AssignmentUpdateInput{
		FirstName:       first,
		LastName:        last,
		Email:           nullableStringPointer(v.Email),
		Phone:           nullableStringPointer(v.Phone),
		FirstNameSet:    v.FirstName != nil,
		LastNameSet:     v.LastName != nil,
		EmailSet:        v.Email.IsSpecified(),
		PhoneSet:        v.Phone.IsSpecified(),
		ShiftID:         nullableUUID(v.ShiftId),
		RequirementID:   nullableUUID(v.RequirementId),
		ExpectedVersion: v.ExpectedVersion,
	}
}
func eventSignupDTO(v events.Assignment) openapi.EventSignup {
	return openapi.EventSignup{
		Id:            v.ID,
		PublicId:      v.PublicID,
		ShiftId:       v.ShiftID,
		RequirementId: v.RequirementID,
		FirstName:     nullablePointer[string](v.FirstName, func(x string) string { return x }),
		LastName:      nullablePointer[string](v.LastName, func(x string) string { return x }),
		Email:         nullablePointer[string](v.Email, func(x string) string { return x }),
		Phone:         nullablePointer[string](v.Phone, func(x string) string { return x }),
		Source:        openapi.EventAssignmentSource(v.Source),
		Status:        openapi.EventAssignmentStatus(v.Status),
		CancelledAt:   nullablePointer(v.CancelledAt, func(x time.Time) time.Time { return x }),
		Version:       v.Version,
		CreatedAt:     v.CreatedAt,
		UpdatedAt:     v.UpdatedAt,
	}
}
func eventSignupResultDTO(v events.SignupResult) openapi.EventSignupResult {
	return openapi.EventSignupResult{
		Assignment:    eventSignupDTO(v.Assignment),
		ManagementUrl: nullablePointer[string](v.ManagementURL, func(x string) string { return x }),
	}
}
func publicEventDTO(v events.PublicEvent) openapi.PublicEvent {
	sessions := make([]openapi.PublicEventSession, 0, len(v.Sessions))
	for _, item := range v.Sessions {
		sessions = append(
			sessions,
			openapi.PublicEventSession{
				Id:          item.ID,
				Name:        nullablePointer[string](item.Name, func(x string) string { return x }),
				Location:    nullablePointer[string](item.Location, func(x string) string { return x }),
				Description: nullablePointer[string](item.Description, func(x string) string { return x }),
				StartsAt:    item.StartsAt,
				EndsAt:      item.EndsAt,
			},
		)
	}
	shifts := make([]openapi.PublicEventShift, 0, len(v.Shifts))
	for _, item := range v.Shifts {
		requirements := make([]openapi.PublicEventRequirement, 0, len(item.Requirements))
		for _, req := range item.Requirements {
			remaining := req.RequiredCount - req.FilledCount
			if remaining < 0 {
				remaining = 0
			}
			requirements = append(
				requirements,
				openapi.PublicEventRequirement{
					Id:             req.ID,
					Name:           req.Name,
					Description:    nullablePointer[string](req.Description, func(x string) string { return x }),
					RequiredCount:  req.RequiredCount,
					FilledCount:    req.FilledCount,
					RemainingCount: remaining,
					Availability:   openapi.PublicEventRequirementAvailability(req.Availability),
				},
			)
		}
		shifts = append(
			shifts,
			openapi.PublicEventShift{
				Id: item.ID,
				SessionId: nullablePointer[openapi.UUIDv7](
					item.SessionID,
					func(x uuid.UUID) openapi.UUIDv7 { return x },
				),
				Name:         item.Name,
				Description:  nullablePointer[string](item.Description, func(x string) string { return x }),
				StartsAt:     item.StartsAt,
				EndsAt:       item.EndsAt,
				Requirements: requirements,
			},
		)
	}
	files := make([]openapi.PublicEventFile, 0, len(v.Files))
	for _, item := range v.Files {
		files = append(
			files,
			openapi.PublicEventFile{
				Id:               item.ID,
				Description:      nullablePointer[string](item.Description, func(x string) string { return x }),
				OriginalFilename: item.OriginalFilename,
				ContentType:      item.ContentType,
				SizeBytes:        item.SizeBytes,
			},
		)
	}
	return openapi.PublicEvent{
		PublicId:            v.PublicID,
		Title:               v.Title,
		Description:         nullablePointer[string](v.Description, func(x string) string { return x }),
		Location:            nullablePointer[string](v.Location, func(x string) string { return x }),
		Status:              openapi.EventStatus(v.Status),
		TimeZone:            v.TimeZone,
		PublicSignupEnabled: v.PublicSignupEnabled,
		HasBanner:           v.HasBanner,
		Sessions:            sessions,
		Shifts:              shifts,
		Files:               files,
	}
}
