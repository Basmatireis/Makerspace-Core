package httpapi

import (
	"bytes"
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) ListOpenDayPeriods(ctx context.Context, _ openapi.ListOpenDayPeriodsRequestObject) (openapi.ListOpenDayPeriodsResponseObject, error) {
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

func (s *Server) CreateOpenDayPeriod(ctx context.Context, r openapi.CreateOpenDayPeriodRequestObject) (openapi.CreateOpenDayPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.CreatePeriod(ctx, p, r.Body.Name, r.Body.StartsOn.Time, r.Body.EndsOn.Time, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateOpenDayPeriod201JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) GetOpenDayPeriod(ctx context.Context, r openapi.GetOpenDayPeriodRequestObject) (openapi.GetOpenDayPeriodResponseObject, error) {
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

func (s *Server) UpdateOpenDayPeriod(ctx context.Context, r openapi.UpdateOpenDayPeriodRequestObject) (openapi.UpdateOpenDayPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.UpdatePeriod(ctx, p, r.PeriodId, r.Body.ExpectedVersion, r.Body.Name, r.Body.StartsOn.Time, r.Body.EndsOn.Time, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOpenDayPeriod200JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) OpenOpenDayPeriodForStaffing(ctx context.Context, r openapi.OpenOpenDayPeriodForStaffingRequestObject) (openapi.OpenOpenDayPeriodForStaffingResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.TransitionPeriod(ctx, p, r.PeriodId, r.Body.ExpectedVersion, "staffing", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.OpenOpenDayPeriodForStaffing200JSONResponse(openDayPeriodDTO(item)), nil
}
func (s *Server) PublishOpenDayPeriod(ctx context.Context, r openapi.PublishOpenDayPeriodRequestObject) (openapi.PublishOpenDayPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.TransitionPeriod(ctx, p, r.PeriodId, r.Body.ExpectedVersion, "published", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PublishOpenDayPeriod200JSONResponse(openDayPeriodDTO(item)), nil
}
func (s *Server) ArchiveOpenDayPeriod(ctx context.Context, r openapi.ArchiveOpenDayPeriodRequestObject) (openapi.ArchiveOpenDayPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.TransitionPeriod(ctx, p, r.PeriodId, r.Body.ExpectedVersion, "archived", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ArchiveOpenDayPeriod200JSONResponse(openDayPeriodDTO(item)), nil
}

func (s *Server) ListOpenDays(ctx context.Context, r openapi.ListOpenDaysRequestObject) (openapi.ListOpenDaysResponseObject, error) {
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
func (s *Server) GetOpenDay(ctx context.Context, r openapi.GetOpenDayRequestObject) (openapi.GetOpenDayResponseObject, error) {
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

func (s *Server) CreateOpenDay(ctx context.Context, r openapi.CreateOpenDayRequestObject) (openapi.CreateOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := openDayInput(r.Body.StartsAt, r.Body.EndsAt, r.Body.InternalNote, r.Body.Requirements, uuid.Nil, 0)
	schedule, err := s.opendays.CreateOpenDay(ctx, p, r.PeriodId, r.Body.ExpectedPeriodVersion, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	for i := len(schedule.Items) - 1; i >= 0; i-- {
		if schedule.Items[i].StartsAt.Equal(r.Body.StartsAt) && schedule.Items[i].EndsAt.Equal(r.Body.EndsAt) {
			return openapi.CreateOpenDay201JSONResponse(openDayDTO(schedule.Items[i])), nil
		}
	}
	return nil, apperror.New(500, "internal_error", "Created Open Day could not be loaded")
}

func (s *Server) UpdateOpenDay(ctx context.Context, r openapi.UpdateOpenDayRequestObject) (openapi.UpdateOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := openDayInput(r.Body.StartsAt, r.Body.EndsAt, r.Body.InternalNote, r.Body.Requirements, r.OpenDayId, r.Body.ExpectedVersion)
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

func (s *Server) DeleteOpenDay(ctx context.Context, r openapi.DeleteOpenDayRequestObject) (openapi.DeleteOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if _, err := s.opendays.RemoveOpenDay(ctx, p, r.OpenDayId, 0, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteOpenDay204Response{}, nil
}
func (s *Server) CancelOpenDay(ctx context.Context, r openapi.CancelOpenDayRequestObject) (openapi.CancelOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if _, err := s.opendays.CancelOpenDay(ctx, p, r.OpenDayId, 0, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	item, err := s.opendays.GetOpenDay(ctx, p, r.OpenDayId)
	if err != nil {
		return nil, err
	}
	return openapi.CancelOpenDay200JSONResponse(openDayDTO(item)), nil
}

func (s *Server) SaveOpenDaySchedule(ctx context.Context, r openapi.SaveOpenDayScheduleRequestObject) (openapi.SaveOpenDayScheduleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	delta := opendays.ScheduleDelta{ExpectedPeriodVersion: r.Body.ExpectedPeriodVersion, Creates: make([]opendays.ScheduleInput, 0, len(r.Body.Creates)), Updates: make([]opendays.ScheduleInput, 0, len(r.Body.Updates)), Removals: make([]opendays.RemovalInput, 0, len(r.Body.Removals))}
	for _, v := range r.Body.Creates {
		delta.Creates = append(delta.Creates, openDayInput(v.StartsAt, v.EndsAt, v.InternalNote, v.Requirements, uuid.Nil, 0))
	}
	for _, v := range r.Body.Updates {
		delta.Updates = append(delta.Updates, openDayInput(v.StartsAt, v.EndsAt, v.InternalNote, v.Requirements, v.Id, v.ExpectedVersion))
	}
	for _, v := range r.Body.Removals {
		delta.Removals = append(delta.Removals, opendays.RemovalInput{ID: v.Id, ExpectedVersion: v.ExpectedVersion})
	}
	schedule, err := s.opendays.SaveSchedule(ctx, p, r.PeriodId, delta, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SaveOpenDaySchedule200JSONResponse(openDayScheduleDTO(schedule)), nil
}

func (s *Server) PreviewOpenDayRecurrence(ctx context.Context, r openapi.PreviewOpenDayRecurrenceRequestObject) (openapi.PreviewOpenDayRecurrenceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	items, err := s.opendays.PreviewRecurrence(ctx, p, r.PeriodId, opendays.RecurrenceInput{Weekday: r.Body.Weekday, StartsOn: r.Body.StartsOn.Time, EndsOn: r.Body.EndsOn.Time, StartTime: r.Body.StartTime, EndTime: r.Body.EndTime, EveryWeeks: r.Body.EveryWeeks, SkipPublicHolidays: r.Body.SkipPublicHolidays, SkipAcademicBreaks: r.Body.SkipAcademicBreaks})
	if err != nil {
		return nil, err
	}
	out := make([]openapi.RecurrenceOccurrence, 0, len(items))
	for _, v := range items {
		item := openapi.RecurrenceOccurrence{Date: apiDate(v.Date), StartsAt: v.StartsAt, EndsAt: v.EndsAt, Disposition: openapi.RecurrenceOccurrenceDisposition(v.Disposition)}
		if v.Reason != "" {
			reason := v.Reason
			item.Reason = &reason
		}
		out = append(out, item)
	}
	return openapi.PreviewOpenDayRecurrence200JSONResponse{Occurrences: out}, nil
}

func (s *Server) JoinOpenDay(ctx context.Context, r openapi.JoinOpenDayRequestObject) (openapi.JoinOpenDayResponseObject, error) {
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
func (s *Server) LeaveOpenDay(ctx context.Context, r openapi.LeaveOpenDayRequestObject) (openapi.LeaveOpenDayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.opendays.Leave(ctx, p, r.OpenDayId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.LeaveOpenDay204Response{}, nil
}
func (s *Server) AssignOpenDayPerson(ctx context.Context, r openapi.AssignOpenDayPersonRequestObject) (openapi.AssignOpenDayPersonResponseObject, error) {
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
func (s *Server) RemoveOpenDayAssignment(ctx context.Context, r openapi.RemoveOpenDayAssignmentRequestObject) (openapi.RemoveOpenDayAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.opendays.RemoveAssignment(ctx, p, r.OpenDayId, r.AssignmentId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.RemoveOpenDayAssignment204Response{}, nil
}

func (s *Server) ListOpenDayEligiblePeople(ctx context.Context, r openapi.ListOpenDayEligiblePeopleRequestObject) (openapi.ListOpenDayEligiblePeopleResponseObject, error) {
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
func (s *Server) ListOpenDayEligibilityRoles(ctx context.Context, _ openapi.ListOpenDayEligibilityRolesRequestObject) (openapi.ListOpenDayEligibilityRolesResponseObject, error) {
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

func (s *Server) GetOpenDayCalendarContext(ctx context.Context, r openapi.GetOpenDayCalendarContextRequestObject) (openapi.GetOpenDayCalendarContextResponseObject, error) {
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
		entries = append(entries, openapi.CalendarEntry{Id: v.ID, Name: v.Name, Source: openapi.CalendarEntrySource(v.Source), Category: openapi.CalendarEntryCategory(v.Category), StartsOn: apiDate(v.StartsOn), EndsOn: apiDate(v.EndsOn)})
	}
	breaks := make([]openapi.AcademicBreak, 0, len(value.AcademicBreaks))
	for _, v := range value.AcademicBreaks {
		breaks = append(breaks, academicBreakDTO(v))
	}
	subdivision := nullable.NewNullNullable[string]()
	if value.SubdivisionCode != "" {
		subdivision = nullable.NewNullableWithValue(value.SubdivisionCode)
	}
	return openapi.GetOpenDayCalendarContext200JSONResponse{TimeZone: value.TimeZone, CountryCode: value.CountryCode, SubdivisionCode: subdivision, LanguageCode: value.LanguageCode, Entries: entries, AcademicBreaks: breaks}, nil
}

func (s *Server) CreateOpenDayAcademicBreak(ctx context.Context, r openapi.CreateOpenDayAcademicBreakRequestObject) (openapi.CreateOpenDayAcademicBreakResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.CreateAcademicBreak(ctx, p, r.Body.Name, r.Body.StartsOn.Time, r.Body.EndsOn.Time, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateOpenDayAcademicBreak201JSONResponse(academicBreakDTO(item)), nil
}
func (s *Server) UpdateOpenDayAcademicBreak(ctx context.Context, r openapi.UpdateOpenDayAcademicBreakRequestObject) (openapi.UpdateOpenDayAcademicBreakResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.opendays.UpdateAcademicBreak(ctx, p, r.AcademicBreakId, r.Body.ExpectedVersion, r.Body.Name, r.Body.StartsOn.Time, r.Body.EndsOn.Time, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOpenDayAcademicBreak200JSONResponse(academicBreakDTO(item)), nil
}
func (s *Server) DeleteOpenDayAcademicBreak(ctx context.Context, r openapi.DeleteOpenDayAcademicBreakRequestObject) (openapi.DeleteOpenDayAcademicBreakResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.opendays.DeleteAcademicBreak(ctx, p, r.AcademicBreakId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteOpenDayAcademicBreak204Response{}, nil
}

func (s *Server) ListPublicOpenDays(ctx context.Context, _ openapi.ListPublicOpenDaysRequestObject) (openapi.ListPublicOpenDaysResponseObject, error) {
	items, err := s.opendays.ListPublic(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.PublicOpenDay, 0, len(items))
	for _, v := range items {
		out = append(out, openapi.PublicOpenDay{Id: v.ID, Title: openapi.PublicOpenDayTitle(v.Title), StartsAt: v.StartsAt, EndsAt: v.EndsAt, Status: openapi.OpenDayStatus(v.Status), UpdatedAt: v.UpdatedAt})
	}
	return openapi.ListPublicOpenDays200JSONResponse{Items: out}, nil
}
func (s *Server) GetPublicOpenDaysCalendar(ctx context.Context, _ openapi.GetPublicOpenDaysCalendarRequestObject) (openapi.GetPublicOpenDaysCalendarResponseObject, error) {
	body, err := s.opendays.PublicICS(ctx)
	if err != nil {
		return nil, err
	}
	return openapi.GetPublicOpenDaysCalendar200TextcalendarResponse{Body: bytes.NewReader(body), ContentLength: int64(len(body))}, nil
}

func openDayPeriodDTO(v opendays.Period) openapi.OpenDayPeriod {
	return openapi.OpenDayPeriod{Id: v.ID, Name: v.Name, StartsOn: apiDate(v.StartsOn), EndsOn: apiDate(v.EndsOn), Status: openapi.OpenDayPeriodStatus(v.Status), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt, TotalOpenDays: v.TotalOpenDays, FullyStaffedCount: v.FullyStaffedCount, NeedsStaffCount: v.NeedsStaffCount, CancelledCount: v.CancelledCount, MyAssignmentCount: v.MyAssignmentCount}
}
func openDayScheduleDTO(v opendays.Schedule) openapi.OpenDaySchedule {
	items := make([]openapi.OpenDay, 0, len(v.Items))
	for _, item := range v.Items {
		items = append(items, openDayDTO(item))
	}
	return openapi.OpenDaySchedule{Period: openDayPeriodDTO(v.Period), Items: items, TimeZone: v.TimeZone}
}
func openDayDTO(v opendays.OpenDay) openapi.OpenDay {
	result := openapi.OpenDay{Id: v.ID, PeriodId: v.PeriodID, StartsAt: v.StartsAt, EndsAt: v.EndsAt, Status: openapi.OpenDayStatus(v.Status), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt, Requirements: make([]openapi.OpenDayStaffRequirement, 0, len(v.Requirements)), MyAssignment: nullable.NewNullNullable[openapi.OpenDayAssignment]()}
	if v.InternalNoteVisible {
		result.InternalNote = nullable.NewNullNullable[string]()
		if v.InternalNote != nil {
			result.InternalNote = nullable.NewNullableWithValue(*v.InternalNote)
		}
	}
	if v.MyAssignment != nil {
		result.MyAssignment = nullable.NewNullableWithValue(assignmentDTO(*v.MyAssignment))
	}
	for _, req := range v.Requirements {
		item := openapi.OpenDayStaffRequirement{Id: req.ID, Kind: openapi.OpenDayRequirementKind(req.Kind), RequiredCount: req.RequiredCount, AssignedCount: req.AssignedCount}
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
		result.Requirements = append(result.Requirements, item)
	}
	return result
}
func assignmentDTO(v opendays.Assignment) openapi.OpenDayAssignment {
	return openapi.OpenDayAssignment{Id: v.ID, OpenDayId: v.OpenDayID, RequirementId: v.RequirementID, PersonId: v.PersonID, DisplayName: v.DisplayName, IsCurrentUser: v.IsCurrentUser, CreatedAt: v.CreatedAt}
}
func academicBreakDTO(v opendays.AcademicBreak) openapi.AcademicBreak {
	return openapi.AcademicBreak{Id: v.ID, Name: v.Name, StartsOn: apiDate(v.StartsOn), EndsOn: apiDate(v.EndsOn), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func apiDate(v time.Time) openapi_types.Date {
	return openapi_types.Date{Time: time.Date(v.Year(), v.Month(), v.Day(), 0, 0, 0, 0, time.UTC)}
}
func openDayInput(start, end time.Time, note nullable.Nullable[string], requirements []openapi.StaffingRequirementInput, id uuid.UUID, expected int64) opendays.ScheduleInput {
	values := make([]opendays.RequirementInput, 0, len(requirements))
	for _, r := range requirements {
		values = append(values, opendays.RequirementInput{Kind: string(r.Kind), RequiredCount: r.RequiredCount, EligibleRoleIDs: r.EligibleRoleIds})
	}
	return opendays.ScheduleInput{ID: id, ExpectedVersion: expected, StartsAt: start, EndsAt: end, InternalNote: nullableStringPointer(note), Requirements: values}
}
