package events

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// canRead reports whether the principal may read events at all. Drafts additionally need canSeeDrafts.
func canRead(principal authorization.Principal) bool {
	return principal.Has(authorization.EventsRead) || canSeeDrafts(principal)
}

// canSeeDrafts reports whether the principal plans or staffs events and therefore sees drafts.
func canSeeDrafts(principal authorization.Principal) bool {
	return principal.Has(authorization.EventsManage) || principal.Has(authorization.EventsStaffingManage) ||
		principal.Has(authorization.EventsAssign)
}

// canViewPII reports whether the principal may see helper contact details.
func canViewPII(principal authorization.Principal) bool {
	return principal.Has(authorization.EventsStaffingManage) || principal.Has(authorization.EventsAssign)
}

// canSeeHelperNames reports whether the principal may see who fills a place; contact details need canViewPII.
func canSeeHelperNames(principal authorization.Principal) bool {
	return principal.Has(authorization.EventsReadAssignments) || canViewPII(principal)
}

// visibleEvent loads an event the principal may read. A draft is reported as missing to everyone who does not plan
// or staff events, so its existence does not leak.
func visibleEvent(
	ctx context.Context,
	q *eventsdb.Queries,
	principal authorization.Principal,
	id uuid.UUID,
) (eventsdb.Event, error) {
	if !canRead(principal) {
		return eventsdb.Event{}, apperror.PermissionDenied
	}
	row, err := q.GetEvent(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return eventsdb.Event{}, apperror.NotFound
	}
	if err != nil {
		return eventsdb.Event{}, err
	}
	if EventStatus(row.Status) == EventStatusDraft && !canSeeDrafts(principal) {
		return eventsdb.Event{}, apperror.NotFound
	}
	return row, nil
}

// eventFacts are the rows the derived values of one event are computed from.
type eventFacts struct {
	event        eventsdb.Event
	sessions     []eventsdb.EventSession
	shifts       []eventsdb.ListEventShiftsRow
	requirements []eventsdb.ListEventRequirementsRow
	tasks        []eventsdb.EventTask
}

func loadEventFacts(ctx context.Context, q *eventsdb.Queries, row eventsdb.Event) (eventFacts, error) {
	facts := eventFacts{event: row}
	var err error
	if facts.sessions, err = q.ListEventSessions(ctx, row.ID); err != nil {
		return facts, err
	}
	if facts.shifts, err = q.ListEventShifts(ctx, row.ID); err != nil {
		return facts, err
	}
	if facts.requirements, err = q.ListEventRequirements(ctx, row.ID); err != nil {
		return facts, err
	}
	if facts.tasks, err = q.ListEventTasks(ctx, row.ID); err != nil {
		return facts, err
	}
	return facts, nil
}

// eventView builds the full event representation with its derived values and the person's own shifts.
func (s *Service) eventView(
	ctx context.Context,
	q *eventsdb.Queries,
	row eventsdb.Event,
	personID uuid.UUID,
	now time.Time,
) (Event, error) {
	facts, err := loadEventFacts(ctx, q, row)
	if err != nil {
		return Event{}, err
	}
	item := eventFromRow(row)
	applyFacts(&item, facts, now)
	if item.HasBanner, err = q.EventBannerExists(ctx, row.ID); err != nil {
		return Event{}, err
	}
	history, err := q.CountEventAssignmentHistory(ctx, row.ID)
	if err != nil {
		return Event{}, err
	}
	item.HasAssignmentHistory = history > 0
	if item.MyShifts, err = ownAssignments(ctx, q, row, personID, now); err != nil {
		return Event{}, err
	}
	if row.OwnerPersonID != nil {
		owner, err := q.GetEventPerson(ctx, *row.OwnerPersonID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Event{}, err
		}
		if err == nil {
			name := strings.TrimSpace(owner.FirstName + " " + owner.LastName)
			item.OwnerName = &name
		}
	}
	return item, nil
}

// applyFacts fills the derived counts, dates and readiness of an event.
func applyFacts(item *Event, facts eventFacts, now time.Time) {
	for _, session := range facts.sessions {
		if SessionStatus(session.Status) == SessionStatusScheduled {
			extendRange(item, session.StartsAt, session.EndsAt)
			if session.StartsAt.After(now) {
				setEarlier(&item.NextScheduleAt, session.StartsAt)
			}
		}
	}
	liveShift := map[uuid.UUID]bool{}
	for _, shift := range facts.shifts {
		if ShiftStatus(shift.Status) != ShiftStatusCancelled {
			liveShift[shift.ID] = true
			extendRange(item, shift.StartsAt, shift.EndsAt)
			if shift.StartsAt.After(now) {
				setEarlier(&item.NextScheduleAt, shift.StartsAt)
			}
		}
	}
	// An event whose whole programme was cancelled still shows when it would have taken place.
	if item.RangeStartsAt == nil {
		for _, session := range facts.sessions {
			extendRange(item, session.StartsAt, session.EndsAt)
		}
		for _, shift := range facts.shifts {
			extendRange(item, shift.StartsAt, shift.EndsAt)
		}
	}
	for _, task := range facts.tasks {
		item.TaskTotal++
		if TaskStatus(task.Status) == TaskStatusDone {
			item.TaskCompleted++
			continue
		}
		if due := pgTime(task.DueAt); due != nil {
			setEarlier(&item.NextDeadline, *due)
			if due.Before(now) {
				item.TasksOverdue++
			}
		}
	}
	for _, requirement := range facts.requirements {
		if !liveShift[requirement.ShiftID] {
			continue
		}
		item.RequiredCount += int64(requirement.RequiredCount)
		item.FilledCount += min(int64(requirement.RequiredCount), requirement.FilledCount)
	}
	item.OpenPlaces = item.RequiredCount - item.FilledCount
	item.GoLive = deriveGoLive(facts, now)
}

// signupBlock says why a shift does not take signups. The rules are shared by in-app joins and public signups;
// public signups additionally need the public page, public signup and a public shift.
type signupBlock string

const (
	signupAllowed      signupBlock = ""
	signupBlockNotOpen signupBlock = "not_open"
	signupBlockOpensAt signupBlock = "opens_at"
	signupBlockClosed  signupBlock = "closed"
)

// shiftSignupBlock applies the event status (only confirmed events take signups), the shift status, a cancelled
// linked session, the end of the shift and its optional signup window.
func shiftSignupBlock(
	eventStatus EventStatus,
	shiftStatus ShiftStatus,
	sessionStatus *string,
	endsAt time.Time,
	opensAt, closesAt *time.Time,
	now time.Time,
) signupBlock {
	switch {
	case eventStatus.Closed():
		return signupBlockClosed
	case eventStatus != EventStatusConfirmed:
		return signupBlockNotOpen
	case shiftStatus == ShiftStatusDraft:
		return signupBlockNotOpen
	case shiftStatus != ShiftStatusOpen:
		return signupBlockClosed
	case sessionStatus != nil && SessionStatus(*sessionStatus) == SessionStatusCancelled:
		return signupBlockClosed
	case !endsAt.After(now):
		return signupBlockClosed
	case opensAt != nil && now.Before(*opensAt):
		return signupBlockOpensAt
	case closesAt != nil && !now.Before(*closesAt):
		return signupBlockClosed
	}
	return signupAllowed
}

// deriveGoLive computes whether the public page and public helper signup are live and what is missing.
func deriveGoLive(facts eventFacts, now time.Time) GoLive {
	event := facts.event
	status := EventStatus(event.Status)
	var hasSession, hasShift, hasPublicContent bool
	for _, session := range facts.sessions {
		if SessionStatus(session.Status) == SessionStatusScheduled {
			hasSession = true
			hasPublicContent = hasPublicContent || session.IsPublic
		}
	}
	positions := map[uuid.UUID]int{}
	freePlaces := map[uuid.UUID]bool{}
	for _, requirement := range facts.requirements {
		positions[requirement.ShiftID]++
		if requirement.FilledCount < int64(requirement.RequiredCount) {
			freePlaces[requirement.ShiftID] = true
		}
	}
	result := GoLive{
		PublicPageState:   PublicPageOff,
		PublicPageUnmet:   []ReadinessCode{},
		HelperSignupState: HelperSignupOff,
		HelperSignupUnmet: []ReadinessCode{},
		ConfirmUnmet:      []ReadinessCode{},
	}
	signupSwitchedOn := event.IsPublic && event.PublicSignupEnabled
	hasEligibleShift := false
	var opensAt *time.Time
	signupOpenNow := false
	for _, shift := range facts.shifts {
		if ShiftStatus(shift.Status) == ShiftStatusCancelled {
			continue
		}
		hasShift = true
		result.ShiftsTotal++
		if !shift.IsPublic {
			result.ShiftsNotPublic++
			continue
		}
		hasPublicContent = true
		sessionCancelled := shift.SessionStatus != nil && SessionStatus(*shift.SessionStatus) == SessionStatusCancelled
		if ShiftStatus(shift.Status) != ShiftStatusOpen || positions[shift.ID] == 0 || sessionCancelled {
			continue
		}
		hasEligibleShift = true
		block := shiftSignupBlock(
			status,
			ShiftStatus(shift.Status),
			shift.SessionStatus,
			shift.EndsAt,
			pgTime(shift.SignupOpensAt),
			pgTime(shift.SignupClosesAt),
			now,
		)
		switch block {
		case signupAllowed:
			signupOpenNow = true
			if signupSwitchedOn && freePlaces[shift.ID] {
				result.ShiftsAccepting++
			}
		case signupBlockOpensAt:
			setEarlier(&opensAt, shift.SignupOpensAt.Time)
		}
	}
	if event.IsPublic {
		result.PublicPageState = PublicPageLive
	}
	if status.Closed() {
		result.PublicPageUnmet = append(result.PublicPageUnmet, ReadinessEventClosed)
	}
	if event.OwnerPersonID == nil {
		result.PublicPageUnmet = append(result.PublicPageUnmet, ReadinessOwnerMissing)
		result.ConfirmUnmet = append(result.ConfirmUnmet, ReadinessOwnerMissing)
	}
	if !hasSession && !hasShift {
		result.ConfirmUnmet = append(result.ConfirmUnmet, ReadinessProgrammeMissing)
	}
	if event.PublicTitle == nil {
		result.PublicPageUnmet = append(result.PublicPageUnmet, ReadinessPublicTitleMissing)
	}
	if !hasPublicContent {
		result.PublicPageUnmet = append(result.PublicPageUnmet, ReadinessPublicContentMissing)
	}
	if !event.IsPublic {
		result.HelperSignupUnmet = append(result.HelperSignupUnmet, ReadinessPublicPageOff)
	}
	if !event.PublicSignupEnabled {
		result.HelperSignupUnmet = append(result.HelperSignupUnmet, ReadinessSignupDisabled)
	}
	switch {
	case status.Closed():
		result.HelperSignupUnmet = append(result.HelperSignupUnmet, ReadinessEventClosed)
	case status != EventStatusConfirmed:
		result.HelperSignupUnmet = append(result.HelperSignupUnmet, ReadinessEventNotConfirmed)
	}
	if !hasEligibleShift {
		result.HelperSignupUnmet = append(result.HelperSignupUnmet, ReadinessNoPublicOpenShift)
	} else if status == EventStatusConfirmed && !signupOpenNow && opensAt == nil {
		// Every public open shift has ended or its signup window has closed.
		result.HelperSignupUnmet = append(result.HelperSignupUnmet, ReadinessSignupPeriodOver)
	}
	switch {
	case !signupSwitchedOn:
		result.HelperSignupState = HelperSignupOff
	case signupOpenNow:
		result.HelperSignupState = HelperSignupOpen
	case opensAt != nil:
		result.HelperSignupState = HelperSignupOpensAt
		result.HelperSignupOpens = opensAt
	default:
		result.HelperSignupState = HelperSignupClosed
	}
	return result
}

// ownAssignments lists the person's active assignments in the event and whether each may still be left.
func ownAssignments(
	ctx context.Context,
	q *eventsdb.Queries,
	event eventsdb.Event,
	personID uuid.UUID,
	now time.Time,
) ([]MyAssignment, error) {
	result := []MyAssignment{}
	if personID == uuid.Nil {
		return result, nil
	}
	rows, err := q.ListOwnEventShiftAssignments(
		ctx,
		eventsdb.ListOwnEventShiftAssignmentsParams{EventID: event.ID, PersonID: &personID},
	)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		item := MyAssignment{
			AssignmentID:    row.ID,
			ShiftID:         row.ShiftID,
			RequirementID:   row.RequirementID,
			ShiftName:       row.ShiftName,
			RequirementName: row.RequirementName,
			StartsAt:        row.StartsAt,
			EndsAt:          row.EndsAt,
			ShiftStatus:     ShiftStatus(row.ShiftStatus),
			Version:         int64(row.Version),
			LeaveBlocked:    leaveBlock(EventStatus(event.Status), row.EndsAt, now),
		}
		result = append(result, item)
	}
	return result, nil
}

// leaveBlock applies the leave rule: helpers may leave until the event is closed or the shift has ended.
func leaveBlock(status EventStatus, shiftEndsAt, now time.Time) LeaveBlock {
	switch {
	case status.Closed():
		return LeaveBlockEventClosed
	case !shiftEndsAt.After(now):
		return LeaveBlockShiftEnded
	}
	return ""
}
