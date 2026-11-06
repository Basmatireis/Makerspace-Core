package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) ListOpenDayPeriods(
	ctx context.Context,
	_ openapi.ListOpenDayPeriodsRequestObject,
) (openapi.ListOpenDayPeriodsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.opendays.ListPeriods(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.OpenDayPeriod, 0, len(items))
	for _, item := range items {
		out = append(out, openDayPeriodDTO(item))
	}
	return openapi.ListOpenDayPeriods200JSONResponse{Items: out}, nil
}

func (s *Server) CreateOpenDayPeriod(
	ctx context.Context,
	r openapi.CreateOpenDayPeriodRequestObject,
) (openapi.CreateOpenDayPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.CreatePeriodCopyingSeries(
		ctx,
		p,
		r.Body.Name,
		r.Body.StartsOn.Time,
		r.Body.EndsOn.Time,
		nullableDate(r.Body.SignUpDeadline),
		r.Body.CopySeriesFromPeriodId,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateOpenDayPeriod201JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) GetOpenDayPeriod(
	ctx context.Context,
	r openapi.GetOpenDayPeriodRequestObject,
) (openapi.GetOpenDayPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.opendays.GetPeriod(ctx, p, r.PeriodId)
	if err != nil {
		return nil, err
	}
	return openapi.GetOpenDayPeriod200JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) UpdateOpenDayPeriod(
	ctx context.Context,
	r openapi.UpdateOpenDayPeriodRequestObject,
) (openapi.UpdateOpenDayPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.UpdatePeriod(
		ctx,
		p,
		r.PeriodId,
		r.Body.ExpectedVersion,
		r.Body.Name,
		r.Body.StartsOn.Time,
		r.Body.EndsOn.Time,
		nullableDate(r.Body.SignUpDeadline),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOpenDayPeriod200JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) DeleteOpenDayPeriod(
	ctx context.Context,
	r openapi.DeleteOpenDayPeriodRequestObject,
) (openapi.DeleteOpenDayPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.opendays.DeletePeriod(ctx, p, r.PeriodId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteOpenDayPeriod204Response{}, nil
}

func (s *Server) OpenOpenDayPeriodForStaffing(
	ctx context.Context,
	r openapi.OpenOpenDayPeriodForStaffingRequestObject,
) (openapi.OpenOpenDayPeriodForStaffingResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.TransitionPeriod(
		ctx,
		p,
		r.PeriodId,
		r.Body.ExpectedVersion,
		opendays.PeriodStaffing,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.OpenOpenDayPeriodForStaffing200JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) ReturnOpenDayPeriodToDraft(
	ctx context.Context,
	r openapi.ReturnOpenDayPeriodToDraftRequestObject,
) (openapi.ReturnOpenDayPeriodToDraftResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.TransitionPeriod(ctx, p, r.PeriodId, r.Body.ExpectedVersion, opendays.PeriodDraft, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReturnOpenDayPeriodToDraft200JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) PublishOpenDayPeriod(
	ctx context.Context,
	r openapi.PublishOpenDayPeriodRequestObject,
) (openapi.PublishOpenDayPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.TransitionPeriod(
		ctx,
		p,
		r.PeriodId,
		r.Body.ExpectedVersion,
		opendays.PeriodPublished,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.PublishOpenDayPeriod200JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) ReturnOpenDayPeriodToStaffing(
	ctx context.Context,
	r openapi.ReturnOpenDayPeriodToStaffingRequestObject,
) (openapi.ReturnOpenDayPeriodToStaffingResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.TransitionPeriod(
		ctx,
		p,
		r.PeriodId,
		r.Body.ExpectedVersion,
		opendays.PeriodStaffing,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.ReturnOpenDayPeriodToStaffing200JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) ArchiveOpenDayPeriod(
	ctx context.Context,
	r openapi.ArchiveOpenDayPeriodRequestObject,
) (openapi.ArchiveOpenDayPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.TransitionPeriod(
		ctx,
		p,
		r.PeriodId,
		r.Body.ExpectedVersion,
		opendays.PeriodArchived,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.ArchiveOpenDayPeriod200JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) ListOpenDays(
	ctx context.Context,
	r openapi.ListOpenDaysRequestObject,
) (openapi.ListOpenDaysResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	schedule, err := s.opendays.GetSchedule(ctx, p, r.PeriodId)
	if err != nil {
		return nil, err
	}
	return openapi.ListOpenDays200JSONResponse(openDayScheduleDTO(schedule)), nil
}

func (s *Server) GetOpenDay(
	ctx context.Context,
	r openapi.GetOpenDayRequestObject,
) (openapi.GetOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.opendays.GetOpenDay(ctx, p, r.OpenDayId)
	if err != nil {
		return nil, err
	}
	return openapi.GetOpenDay200JSONResponse(openDayDTO(item)), nil
}

func (s *Server) CreateOpenDay(
	ctx context.Context,
	r openapi.CreateOpenDayRequestObject,
) (openapi.CreateOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := openDayInput(r.Body.InternalNote, r.Body.Timeslots, uuid.Nil, 0)
	if len(r.Body.Timeslots) == 0 {
		return nil, invalidRequest("timeslots are required")
	}
	startsAt := r.Body.Timeslots[0].StartsAt
	endsAt := r.Body.Timeslots[len(r.Body.Timeslots)-1].EndsAt
	schedule, err := s.opendays.CreateOpenDay(
		ctx,
		p,
		r.PeriodId,
		r.Body.ExpectedPeriodVersion,
		input,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	for i := len(schedule.Items) - 1; i >= 0; i-- {
		if schedule.Items[i].StartsAt.Equal(startsAt) && schedule.Items[i].EndsAt.Equal(endsAt) {
			return openapi.CreateOpenDay201JSONResponse(openDayDTO(schedule.Items[i])), nil
		}
	}
	return nil, apperror.New(http.StatusInternalServerError, "internal_error", "Created Open Day could not be loaded")
}

func (s *Server) UpdateOpenDay(
	ctx context.Context,
	r openapi.UpdateOpenDayRequestObject,
) (openapi.UpdateOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := openDayInput(r.Body.InternalNote, r.Body.Timeslots, r.OpenDayId, r.Body.ExpectedVersion)
	_, err = s.opendays.UpdateOpenDay(ctx, p, r.OpenDayId, r.Body.ExpectedPeriodVersion, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	item, err := s.opendays.GetOpenDay(ctx, p, r.OpenDayId)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOpenDay200JSONResponse(openDayDTO(item)), nil
}

func (s *Server) DeleteOpenDay(
	ctx context.Context,
	r openapi.DeleteOpenDayRequestObject,
) (openapi.DeleteOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if _, err := s.opendays.RemoveOpenDay(
		ctx,
		p,
		r.OpenDayId,
		0,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteOpenDay204Response{}, nil
}

func (s *Server) CancelOpenDay(
	ctx context.Context,
	r openapi.CancelOpenDayRequestObject,
) (openapi.CancelOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if _, err := s.opendays.CancelOpenDay(
		ctx,
		p,
		r.OpenDayId,
		0,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	item, err := s.opendays.GetOpenDay(ctx, p, r.OpenDayId)
	if err != nil {
		return nil, err
	}
	return openapi.CancelOpenDay200JSONResponse(openDayDTO(item)), nil
}

func (s *Server) SaveOpenDaySchedule(
	ctx context.Context,
	r openapi.SaveOpenDayScheduleRequestObject,
) (openapi.SaveOpenDayScheduleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	delta := opendays.ScheduleDelta{
		ExpectedPeriodVersion: r.Body.ExpectedPeriodVersion,
		Creates:               make([]opendays.ScheduleInput, 0, len(r.Body.Creates)),
		Updates:               make([]opendays.ScheduleInput, 0, len(r.Body.Updates)),
		Removals:              make([]opendays.RemovalInput, 0, len(r.Body.Removals)),
	}
	for _, v := range r.Body.Creates {
		delta.Creates = append(delta.Creates, openDayInput(v.InternalNote, v.Timeslots, uuid.Nil, 0))
	}
	for _, v := range r.Body.Updates {
		delta.Updates = append(delta.Updates, openDayInput(v.InternalNote, v.Timeslots, v.Id, v.ExpectedVersion))
	}
	for _, v := range r.Body.Removals {
		delta.Removals = append(delta.Removals, opendays.RemovalInput{ID: v.Id, ExpectedVersion: v.ExpectedVersion})
	}
	if r.Body.SeriesCreates != nil {
		for _, v := range *r.Body.SeriesCreates {
			delta.SeriesCreates = append(delta.SeriesCreates, opendays.SeriesCreate{
				Weekday:   v.Weekday,
				FromDate:  v.FromDate.Time,
				UntilDate: v.UntilDate.Time,
				SeriesTemplate: seriesTemplate(
					v.Timeslots, v.SupervisorPlaces, v.TraineePlaces, v.SupervisorRoleIds, v.TraineeRoleIds, v.ForcedDates,
				),
			})
		}
	}
	if r.Body.SeriesUpdates != nil {
		for _, v := range *r.Body.SeriesUpdates {
			delta.SeriesUpdates = append(delta.SeriesUpdates, opendays.SeriesUpdate{
				ID:              v.Id,
				ExpectedVersion: v.ExpectedVersion,
				ApplyFrom:       v.ApplyFrom.Time,
				UntilDate:       v.UntilDate.Time,
				SeriesTemplate: seriesTemplate(
					v.Timeslots, v.SupervisorPlaces, v.TraineePlaces, v.SupervisorRoleIds, v.TraineeRoleIds, v.ForcedDates,
				),
			})
		}
	}
	if r.Body.SeriesRejoins != nil {
		for _, v := range *r.Body.SeriesRejoins {
			delta.SeriesRejoins = append(
				delta.SeriesRejoins,
				opendays.SeriesRejoin{OpenDayID: v.OpenDayId, ExpectedVersion: v.ExpectedVersion},
			)
		}
	}
	schedule, err := s.opendays.SaveSchedule(ctx, p, r.PeriodId, delta, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SaveOpenDaySchedule200JSONResponse(openDayScheduleDTO(schedule)), nil
}

func (s *Server) PreviewOpenDayRecurrence(
	ctx context.Context,
	r openapi.PreviewOpenDayRecurrenceRequestObject,
) (openapi.PreviewOpenDayRecurrenceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	items, err := s.opendays.PreviewRecurrence(
		ctx,
		p,
		r.PeriodId,
		opendays.RecurrenceInput{
			Weekday:            r.Body.Weekday,
			StartsOn:           r.Body.StartsOn.Time,
			EndsOn:             r.Body.EndsOn.Time,
			StartTime:          r.Body.StartTime,
			EndTime:            r.Body.EndTime,
			EveryWeeks:         r.Body.EveryWeeks,
			SkipPublicHolidays: r.Body.SkipPublicHolidays,
			SkipAcademicBreaks: r.Body.SkipAcademicBreaks,
			Timeslots:          clockRanges(r.Body.Timeslots),
			ForcedDates:        optionalDates(r.Body.ForcedDates),
		},
	)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.RecurrenceOccurrence, 0, len(items))
	for _, v := range items {
		item := openapi.RecurrenceOccurrence{
			Date:        apiDate(v.Date),
			StartsAt:    v.StartsAt,
			EndsAt:      v.EndsAt,
			Disposition: openapi.RecurrenceOccurrenceDisposition(v.Disposition),
		}
		slots := publicTimeslotDTOs(v.Timeslots)
		item.Timeslots = &slots
		if v.Reason != "" {
			reason := v.Reason
			item.Reason = &reason
		}
		out = append(out, item)
	}
	return openapi.PreviewOpenDayRecurrence200JSONResponse{Occurrences: out}, nil
}

func (s *Server) JoinOpenDay(
	ctx context.Context,
	r openapi.JoinOpenDayRequestObject,
) (openapi.JoinOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.Join(ctx, p, r.OpenDayId, r.Body.RequirementId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.JoinOpenDay201JSONResponse(assignmentDTO(item)), nil
}

func (s *Server) LeaveOpenDay(
	ctx context.Context,
	r openapi.LeaveOpenDayRequestObject,
) (openapi.LeaveOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.opendays.Leave(ctx, p, r.OpenDayId, r.Params.TimeslotId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.LeaveOpenDay204Response{}, nil
}

func (s *Server) AssignOpenDayPerson(
	ctx context.Context,
	r openapi.AssignOpenDayPersonRequestObject,
) (openapi.AssignOpenDayPersonResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.Assign(ctx, p, r.OpenDayId, r.Body.RequirementId, r.Body.PersonId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.AssignOpenDayPerson201JSONResponse(assignmentDTO(item)), nil
}

func (s *Server) RemoveOpenDayAssignment(
	ctx context.Context,
	r openapi.RemoveOpenDayAssignmentRequestObject,
) (openapi.RemoveOpenDayAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.opendays.RemoveAssignment(ctx, p, r.OpenDayId, r.AssignmentId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.RemoveOpenDayAssignment204Response{}, nil
}

func (s *Server) ListOpenDayEligiblePeople(
	ctx context.Context,
	r openapi.ListOpenDayEligiblePeopleRequestObject,
) (openapi.ListOpenDayEligiblePeopleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	search := ""
	if r.Params.Search != nil {
		search = *r.Params.Search
	}
	items, err := s.opendays.EligiblePeople(ctx, p, r.RequirementId, search)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.MinimalPerson, 0, len(items))
	for _, v := range items {
		out = append(out, openapi.MinimalPerson{PersonId: v.PersonID, DisplayName: v.DisplayName})
	}
	return openapi.ListOpenDayEligiblePeople200JSONResponse{Items: out}, nil
}

func (s *Server) ListOpenDayEligibilityRoles(
	ctx context.Context,
	_ openapi.ListOpenDayEligibilityRolesRequestObject,
) (openapi.ListOpenDayEligibilityRolesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.opendays.EligibilityRoles(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.EligibilityRole, 0, len(items))
	for _, v := range items {
		out = append(out, openapi.EligibilityRole{Id: v.ID, Name: v.Name})
	}
	return openapi.ListOpenDayEligibilityRoles200JSONResponse{Items: out}, nil
}

func (s *Server) GetOpenDayCalendarContext(
	ctx context.Context,
	r openapi.GetOpenDayCalendarContextRequestObject,
) (openapi.GetOpenDayCalendarContextResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.opendays.CalendarContext(ctx, p, r.PeriodId)
	if err != nil {
		return nil, err
	}
	entries := make([]openapi.CalendarEntry, 0, len(value.Entries))
	for _, v := range value.Entries {
		entries = append(
			entries,
			openapi.CalendarEntry{
				Id:       v.ID,
				Name:     v.Name,
				Source:   openapi.CalendarEntrySource(v.Source),
				Category: openapi.CalendarEntryCategory(v.Category),
				StartsOn: apiDate(v.StartsOn),
				EndsOn:   apiDate(v.EndsOn),
			},
		)
	}
	breaks := make([]openapi.AcademicBreak, 0, len(value.AcademicBreaks))
	for _, v := range value.AcademicBreaks {
		breaks = append(breaks, academicBreakDTO(v))
	}
	subdivision := nullable.NewNullNullable[string]()
	if value.SubdivisionCode != "" {
		subdivision = nullable.NewNullableWithValue(value.SubdivisionCode)
	}
	return openapi.GetOpenDayCalendarContext200JSONResponse{
		TimeZone:        value.TimeZone,
		CountryCode:     value.CountryCode,
		SubdivisionCode: subdivision,
		LanguageCode:    value.LanguageCode,
		Entries:         entries,
		AcademicBreaks:  breaks,
	}, nil
}

func (s *Server) ListOpenDayAcademicBreaks(
	ctx context.Context,
	_ openapi.ListOpenDayAcademicBreaksRequestObject,
) (openapi.ListOpenDayAcademicBreaksResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.opendays.ListAcademicBreaks(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.AcademicBreak, 0, len(items))
	for _, item := range items {
		out = append(out, academicBreakDTO(item))
	}
	return openapi.ListOpenDayAcademicBreaks200JSONResponse{Items: out}, nil
}

func (s *Server) CreateOpenDayAcademicBreak(
	ctx context.Context,
	r openapi.CreateOpenDayAcademicBreakRequestObject,
) (openapi.CreateOpenDayAcademicBreakResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.CreateAcademicBreak(
		ctx,
		p,
		r.Body.Name,
		r.Body.StartsOn.Time,
		r.Body.EndsOn.Time,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateOpenDayAcademicBreak201JSONResponse(academicBreakDTO(item)), nil
}

func (s *Server) UpdateOpenDayAcademicBreak(
	ctx context.Context,
	r openapi.UpdateOpenDayAcademicBreakRequestObject,
) (openapi.UpdateOpenDayAcademicBreakResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.UpdateAcademicBreak(
		ctx,
		p,
		r.AcademicBreakId,
		r.Body.ExpectedVersion,
		r.Body.Name,
		r.Body.StartsOn.Time,
		r.Body.EndsOn.Time,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOpenDayAcademicBreak200JSONResponse(academicBreakDTO(item)), nil
}

func (s *Server) DeleteOpenDayAcademicBreak(
	ctx context.Context,
	r openapi.DeleteOpenDayAcademicBreakRequestObject,
) (openapi.DeleteOpenDayAcademicBreakResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.opendays.DeleteAcademicBreak(
		ctx,
		p,
		r.AcademicBreakId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteOpenDayAcademicBreak204Response{}, nil
}

func (s *Server) ListPublicOpenDays(
	ctx context.Context,
	_ openapi.ListPublicOpenDaysRequestObject,
) (openapi.ListPublicOpenDaysResponseObject, error) {
	items, err := s.opendays.ListPublic(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.PublicOpenDay, 0, len(items))
	for _, v := range items {
		out = append(
			out,
			openapi.PublicOpenDay{
				Id:           v.ID,
				Title:        openapi.PublicOpenDayTitle(v.Title),
				StartsAt:     v.StartsAt,
				EndsAt:       v.EndsAt,
				Timeslots:    publicTimeslotDTOs(v.Timeslots),
				Status:       openapi.OpenDayStatus(v.Status),
				UpdatedAt:    v.UpdatedAt,
				Competencies: competencyDTOs(v.Competencies),
			},
		)
	}
	return openapi.ListPublicOpenDays200JSONResponse{Items: out}, nil
}

func (s *Server) GetPublicOpenDaysCalendar(
	ctx context.Context,
	_ openapi.GetPublicOpenDaysCalendarRequestObject,
) (openapi.GetPublicOpenDaysCalendarResponseObject, error) {
	body, err := s.opendays.PublicICS(ctx)
	if err != nil {
		return nil, err
	}
	return openapi.GetPublicOpenDaysCalendar200TextcalendarResponse{
		Body:          bytes.NewReader(body),
		ContentLength: int64(len(body)),
	}, nil
}

func openDayPeriodDTO(v opendays.Period) openapi.OpenDayPeriod {
	return openapi.OpenDayPeriod{
		Id:                      v.ID,
		Name:                    v.Name,
		StartsOn:                apiDate(v.StartsOn),
		EndsOn:                  apiDate(v.EndsOn),
		SignUpDeadline:          signUpDeadlineDTO(v.SignUpDeadline),
		Status:                  openapi.OpenDayPeriodStatus(v.Status),
		Version:                 v.Version,
		CreatedAt:               v.CreatedAt,
		UpdatedAt:               v.UpdatedAt,
		TotalOpenDays:           v.TotalOpenDays,
		FullyStaffedCount:       v.FullyStaffedCount,
		NeedsStaffCount:         v.NeedsStaffCount,
		OpenSupervisorPositions: v.OpenSupervisorPositions,
		CancelledCount:          v.CancelledCount,
		MyAssignmentCount:       v.MyAssignmentCount,
	}
}
func openDayScheduleDTO(v opendays.Schedule) openapi.OpenDaySchedule {
	items := make([]openapi.OpenDay, 0, len(v.Items))
	for _, item := range v.Items {
		items = append(items, openDayDTO(item))
	}
	return openapi.OpenDaySchedule{Period: openDayPeriodDTO(v.Period), Items: items, TimeZone: v.TimeZone}
}
func openDayDTO(v opendays.OpenDay) openapi.OpenDay {
	result := openapi.OpenDay{
		Id:                   v.ID,
		PeriodId:             v.PeriodID,
		StartsAt:             v.StartsAt,
		EndsAt:               v.EndsAt,
		Status:               openapi.OpenDayStatus(v.Status),
		Version:              v.Version,
		CreatedAt:            v.CreatedAt,
		UpdatedAt:            v.UpdatedAt,
		Timeslots:            make([]openapi.OpenDayTimeslot, 0, len(v.Timeslots)),
		Competencies:         competencyDTOs(v.Competencies),
		SeriesId:             nullableUUIDValue(v.SeriesID),
		DetachedFromSeriesId: nullableUUIDValue(v.DetachedFromSeriesID),
	}
	if v.InternalNoteVisible {
		result.InternalNote = nullable.NewNullNullable[string]()
		if v.InternalNote != nil {
			result.InternalNote = nullable.NewNullableWithValue(*v.InternalNote)
		}
	}
	for _, slot := range v.Timeslots {
		item := openapi.OpenDayTimeslot{
			Id:           slot.ID,
			Position:     slot.Position,
			StartsAt:     slot.StartsAt,
			EndsAt:       slot.EndsAt,
			Requirements: make([]openapi.OpenDayStaffRequirement, 0, len(slot.Requirements)),
			MyAssignment: nullable.NewNullNullable[openapi.OpenDayAssignment](),
		}
		if slot.MyAssignment != nil {
			item.MyAssignment = nullable.NewNullableWithValue(assignmentDTO(*slot.MyAssignment))
		}
		for _, req := range slot.Requirements {
			item.Requirements = append(item.Requirements, requirementDTO(req))
		}
		result.Timeslots = append(result.Timeslots, item)
	}
	return result
}

func requirementDTO(req opendays.Requirement) openapi.OpenDayStaffRequirement {
	item := openapi.OpenDayStaffRequirement{
		Id:            req.ID,
		TimeslotId:    req.TimeslotID,
		Kind:          openapi.OpenDayRequirementKind(req.Kind),
		RequiredCount: req.RequiredCount,
		AssignedCount: req.AssignedCount,
		Eligible:      req.Eligible,
		CanJoin:       req.CanJoin,
	}
	if req.EligibleRolesVisible {
		roles := req.EligibleRoleIDs
		item.EligibleRoleIds = &roles
	}
	if req.Assignments != nil {
		values := make([]openapi.OpenDayAssignment, 0, len(*req.Assignments))
		for _, a := range *req.Assignments {
			values = append(values, assignmentDTO(a))
		}
		item.Assignments = &values
	}
	return item
}

func publicTimeslotDTOs(items []opendays.PublicTimeslot) []openapi.PublicOpenDayTimeslot {
	out := make([]openapi.PublicOpenDayTimeslot, 0, len(items))
	for _, item := range items {
		out = append(out, openapi.PublicOpenDayTimeslot{StartsAt: item.StartsAt, EndsAt: item.EndsAt})
	}
	return out
}

func openDaySeriesDTO(v opendays.Series) openapi.OpenDaySeries {
	slots := make([]openapi.SeriesTimeslotTemplate, 0, len(v.Timeslots))
	for _, slot := range v.Timeslots {
		slots = append(slots, openapi.SeriesTimeslotTemplate{StartTime: slot.Start, EndTime: slot.End})
	}
	forced := make([]openapi_types.Date, 0, len(v.ForcedDates))
	for _, date := range v.ForcedDates {
		forced = append(forced, apiDate(date))
	}
	return openapi.OpenDaySeries{
		Id:                v.ID,
		PeriodId:          v.PeriodID,
		Weekday:           v.Weekday,
		FromDate:          apiDate(v.FromDate),
		UntilDate:         apiDate(v.UntilDate),
		Timeslots:         slots,
		SupervisorPlaces:  v.SupervisorPlaces,
		TraineePlaces:     v.TraineePlaces,
		SupervisorRoleIds: v.SupervisorRoleIDs,
		TraineeRoleIds:    v.TraineeRoleIDs,
		ForcedDates:       forced,
		DayCount:          v.DayCount,
		Version:           v.Version,
		CreatedAt:         v.CreatedAt,
		UpdatedAt:         v.UpdatedAt,
	}
}

func assignmentDTO(v opendays.Assignment) openapi.OpenDayAssignment {
	return openapi.OpenDayAssignment{
		Id:            v.ID,
		OpenDayId:     v.OpenDayID,
		TimeslotId:    v.TimeslotID,
		RequirementId: v.RequirementID,
		PersonId:      v.PersonID,
		DisplayName:   v.DisplayName,
		ProfileImageUrl: nullablePointer[string](
			assignmentProfileImageURL(v), func(x string) string { return x },
		),
		IsCurrentUser: v.IsCurrentUser,
		CreatedAt:     v.CreatedAt,
	}
}

func assignmentProfileImageURL(v opendays.Assignment) *string {
	if !v.HasProfileImage {
		return nil
	}
	url := fmt.Sprintf("/api/v1/open-days/%s/assignments/%s/profile-image", v.OpenDayID, v.ID)
	return &url
}

func (s *Server) GetOpenDayAssignmentProfileImage(
	ctx context.Context,
	request openapi.GetOpenDayAssignmentProfileImageRequestObject,
) (openapi.GetOpenDayAssignmentProfileImageResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	fileID, err := s.opendays.AssignmentProfileImageFile(ctx, principal, request.OpenDayId, request.AssignmentId)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.files.Open(ctx, fileID)
	if err != nil {
		return nil, err
	}
	return openapi.GetOpenDayAssignmentProfileImage200ImagejpegResponse{
		Body: reader, ContentLength: file.Size,
		Headers: openapi.GetOpenDayAssignmentProfileImage200ResponseHeaders{CacheControl: "private, no-store"},
	}, nil
}
func academicBreakDTO(v opendays.AcademicBreak) openapi.AcademicBreak {
	return openapi.AcademicBreak{
		Id:        v.ID,
		Name:      v.Name,
		StartsOn:  apiDate(v.StartsOn),
		EndsOn:    apiDate(v.EndsOn),
		Version:   v.Version,
		CreatedAt: v.CreatedAt,
		UpdatedAt: v.UpdatedAt,
	}
}
func signUpDeadlineDTO(v *time.Time) nullable.Nullable[openapi_types.Date] {
	if v == nil {
		return nullable.NewNullNullable[openapi_types.Date]()
	}
	return nullable.NewNullableWithValue(apiDate(*v))
}

func apiDate(v time.Time) openapi_types.Date {
	return openapi_types.Date{Time: time.Date(v.Year(), v.Month(), v.Day(), 0, 0, 0, 0, time.UTC)}
}

func openDayInput(
	note nullable.Nullable[string],
	timeslots []openapi.OpenDayTimeslotInput,
	id uuid.UUID,
	expected int64,
) opendays.ScheduleInput {
	slots := make([]opendays.TimeslotInput, 0, len(timeslots))
	for _, slot := range timeslots {
		values := make([]opendays.RequirementInput, 0, len(slot.Requirements))
		for _, r := range slot.Requirements {
			values = append(
				values,
				opendays.RequirementInput{
					Kind:            opendays.RequirementKind(r.Kind),
					RequiredCount:   r.RequiredCount,
					EligibleRoleIDs: r.EligibleRoleIds,
				},
			)
		}
		slots = append(slots, opendays.TimeslotInput{
			ID: slot.Id, StartsAt: slot.StartsAt, EndsAt: slot.EndsAt, Requirements: values,
		})
	}
	return opendays.ScheduleInput{
		ID:              id,
		ExpectedVersion: expected,
		InternalNote:    nullableStringPointer(note),
		Timeslots:       slots,
	}
}

func clockRanges(items *[]openapi.SeriesTimeslotTemplate) []opendays.ClockRange {
	if items == nil {
		return nil
	}
	out := make([]opendays.ClockRange, 0, len(*items))
	for _, item := range *items {
		out = append(out, opendays.ClockRange{Start: item.StartTime, End: item.EndTime})
	}
	return out
}

func optionalDates(items *[]openapi_types.Date) []time.Time {
	if items == nil {
		return nil
	}
	return dates(*items)
}

func dates(items []openapi_types.Date) []time.Time {
	out := make([]time.Time, 0, len(items))
	for _, item := range items {
		out = append(out, item.Time)
	}
	return out
}

func seriesTemplate(
	timeslots []openapi.SeriesTimeslotTemplate,
	supervisorPlaces, traineePlaces int,
	supervisorRoleIDs, traineeRoleIDs []openapi.UUIDv7,
	forcedDates []openapi_types.Date,
) opendays.SeriesTemplate {
	return opendays.SeriesTemplate{
		Timeslots:         clockRanges(&timeslots),
		SupervisorPlaces:  supervisorPlaces,
		TraineePlaces:     traineePlaces,
		SupervisorRoleIDs: supervisorRoleIDs,
		TraineeRoleIDs:    traineeRoleIDs,
		ForcedDates:       dates(forcedDates),
	}
}

func (s *Server) ListOpenDaySeries(
	ctx context.Context,
	r openapi.ListOpenDaySeriesRequestObject,
) (openapi.ListOpenDaySeriesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.opendays.ListSeries(ctx, p, r.PeriodId)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.OpenDaySeries, 0, len(items))
	for _, item := range items {
		out = append(out, openDaySeriesDTO(item))
	}
	return openapi.ListOpenDaySeries200JSONResponse{Items: out}, nil
}
