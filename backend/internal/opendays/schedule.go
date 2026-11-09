package opendays

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	opendaysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/opendays/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SaveSchedule applies one delta of the schedule's working copy atomically: removals, single-day updates, series
// rejoins, single-day creates, series updates and series creates, in that order. The period and every targeted
// day are guarded by their versions, and the saved schedule never holds overlapping scheduled days.
func (s *Service) SaveSchedule(
	ctx context.Context,
	principal authorization.Principal,
	periodID uuid.UUID,
	delta ScheduleDelta,
	requestID *uuid.UUID,
) (Schedule, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Schedule{}, apperror.PermissionDenied
	}
	if delta.ExpectedPeriodVersion < 1 {
		return Schedule{}, apperror.Invalid("expectedPeriodVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Schedule{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := opendaysdb.New(tx)
	period, err := q.GetPeriodForUpdate(ctx, periodID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, apperror.NotFound
	}
	if err != nil {
		return Schedule{}, err
	}
	if period.Version != delta.ExpectedPeriodVersion {
		return Schedule{}, apperror.StaleWrite
	}
	if PeriodStatus(period.Status) == PeriodArchived {
		return Schedule{}, apperror.Conflicting("period_archived", "Archived Open Day periods are read-only")
	}
	existing, err := q.ListOpenDaysByPeriod(ctx, periodID)
	if err != nil {
		return Schedule{}, err
	}
	byID := make(map[uuid.UUID]opendaysdb.OpenDay, len(existing))
	for _, day := range existing {
		byID[day.ID] = day
	}
	targets := map[uuid.UUID]bool{}
	target := func(id uuid.UUID, expected int64, mustBeScheduled bool) (opendaysdb.OpenDay, error) {
		if id == uuid.Nil || targets[id] {
			return opendaysdb.OpenDay{}, apperror.Invalid("schedule operations must target each Open Day at most once")
		}
		targets[id] = true
		day, ok := byID[id]
		if !ok {
			return opendaysdb.OpenDay{}, apperror.NotFound
		}
		if day.Version != expected {
			return opendaysdb.OpenDay{}, apperror.StaleWrite
		}
		if mustBeScheduled && DayStatus(day.Status) != DayScheduled {
			return opendaysdb.OpenDay{}, apperror.Conflicting("open_day_cancelled", "Cancelled Open Days cannot be edited")
		}
		return day, nil
	}
	removals := make([]opendaysdb.OpenDay, 0, len(delta.Removals))
	for _, rm := range delta.Removals {
		day, err := target(rm.ID, rm.ExpectedVersion, false)
		if err != nil {
			return Schedule{}, err
		}
		removals = append(removals, day)
	}
	updates := make([]opendaysdb.OpenDay, 0, len(delta.Updates))
	for _, input := range delta.Updates {
		day, err := target(input.ID, input.ExpectedVersion, true)
		if err != nil {
			return Schedule{}, err
		}
		updates = append(updates, day)
	}
	rejoins := make([]opendaysdb.OpenDay, 0, len(delta.SeriesRejoins))
	for _, rejoin := range delta.SeriesRejoins {
		day, err := target(rejoin.OpenDayID, rejoin.ExpectedVersion, true)
		if err != nil {
			return Schedule{}, err
		}
		rejoins = append(rejoins, day)
	}
	roleIDs := []uuid.UUID{}
	for _, input := range append(slices.Clone(delta.Creates), delta.Updates...) {
		if err := s.validateTimeslots(period, input.timeslots()); err != nil {
			return Schedule{}, err
		}
		for _, slot := range input.timeslots() {
			for _, requirement := range slot.Requirements {
				roleIDs = append(roleIDs, requirement.EligibleRoleIDs...)
			}
		}
	}
	for _, create := range delta.SeriesCreates {
		if err := validateSeriesCreate(period, create); err != nil {
			return Schedule{}, err
		}
		roleIDs = append(roleIDs, create.SupervisorRoleIDs...)
		roleIDs = append(roleIDs, create.TraineeRoleIDs...)
	}
	for _, update := range delta.SeriesUpdates {
		if err := validateTemplate(update.SeriesTemplate); err != nil {
			return Schedule{}, err
		}
		roleIDs = append(roleIDs, update.SupervisorRoleIDs...)
		roleIDs = append(roleIDs, update.TraineeRoleIDs...)
	}
	if err := validateRestrictionRoles(ctx, q, roleIDs); err != nil {
		return Schedule{}, err
	}

	w := &scheduleWriter{
		s: s, q: q, tx: tx, principal: principal, period: period, requestID: requestID, now: time.Now().UTC(),
		removedDays: map[uuid.UUID]bool{}, deletedDays: map[uuid.UUID]bool{},
	}
	heldBefore, err := snapshotHeldSlots(ctx, q, periodID)
	if err != nil {
		return Schedule{}, err
	}
	for _, day := range removals {
		if err := w.removeDay(ctx, day); err != nil {
			return Schedule{}, err
		}
	}
	for i, day := range updates {
		if err := w.updateDay(ctx, day, delta.Updates[i]); err != nil {
			return Schedule{}, err
		}
	}
	if len(rejoins) > 0 {
		series, err := w.s.loadSeries(ctx, q, periodID)
		if err != nil {
			return Schedule{}, err
		}
		for _, day := range rejoins {
			if err := w.rejoin(ctx, day, series); err != nil {
				return Schedule{}, err
			}
		}
	}
	for _, input := range delta.Creates {
		if _, err := w.createDay(ctx, cleanNote(input.InternalNote), input.timeslots(), nil); err != nil {
			return Schedule{}, err
		}
	}
	for _, update := range delta.SeriesUpdates {
		if err := w.updateSeries(ctx, update); err != nil {
			return Schedule{}, err
		}
	}
	for _, create := range delta.SeriesCreates {
		if _, err := w.createSeries(ctx, create); err != nil {
			return Schedule{}, err
		}
	}
	if len(delta.Creates)+len(delta.Updates)+len(delta.Removals)+len(delta.SeriesCreates)+len(delta.SeriesUpdates)+
		len(delta.SeriesRejoins) > 0 {
		if err := w.rejectOverlaps(ctx); err != nil {
			return Schedule{}, err
		}
		if err := w.notifyScheduleChanges(ctx, heldBefore); err != nil {
			return Schedule{}, err
		}
		// A draft is still being prepared and nobody sees it; once people can, a save is news to the staffing people.
		if PeriodStatus(period.Status) != PeriodDraft {
			if err := s.inbox.OpenDayPeriodChanged(ctx, tx, periodID, notifyrules.OpenDayPeriodChanged); err != nil {
				return Schedule{}, err
			}
		}
		if _, err := q.BumpPeriodVersion(
			ctx,
			opendaysdb.BumpPeriodVersionParams{ID: periodID, ExpectedVersion: period.Version},
		); errors.Is(err, pgx.ErrNoRows) {
			return Schedule{}, apperror.StaleWrite
		} else if err != nil {
			return Schedule{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Schedule{}, databaseError(err)
	}
	return s.GetSchedule(ctx, principal, periodID)
}

// scheduleWriter performs the writes of one schedule save inside its transaction, with the period locked.
type scheduleWriter struct {
	s         *Service
	q         *opendaysdb.Queries
	tx        pgx.Tx
	principal authorization.Principal
	period    opendaysdb.OpenDayPeriod
	requestID *uuid.UUID
	now       time.Time
	// removedDays are the days this save cancelled or deleted, deletedDays those that no longer exist; both feed the
	// notifications to the people who were assigned.
	removedDays, deletedDays map[uuid.UUID]bool
}

// slotState is a stored timeslot with its places by kind.
type slotState struct {
	row          opendaysdb.OpenDayTimeslot
	requirements map[RequirementKind]requirementState
}

type requirementState struct {
	id       uuid.UUID
	required int
	assigned int64
	roles    []uuid.UUID
}

func (w *scheduleWriter) slotsOf(ctx context.Context, dayID uuid.UUID) ([]slotState, error) {
	dayIDs := []uuid.UUID{dayID}
	slots, err := w.q.ListTimeslotsByDays(ctx, idTexts(dayIDs))
	if err != nil {
		return nil, err
	}
	requirements, err := w.q.ListRequirementsByDays(ctx, idTexts(dayIDs))
	if err != nil {
		return nil, err
	}
	roleRows, err := w.q.ListRequirementRolesByDays(ctx, idTexts(dayIDs))
	if err != nil {
		return nil, err
	}
	roles := map[uuid.UUID][]uuid.UUID{}
	for _, row := range roleRows {
		roles[row.RequirementID] = append(roles[row.RequirementID], row.RoleID)
	}
	result := make([]slotState, 0, len(slots))
	for _, slot := range slots {
		state := slotState{row: slot, requirements: map[RequirementKind]requirementState{}}
		for _, req := range requirements {
			if req.TimeslotID == slot.ID {
				state.requirements[RequirementKind(req.Kind)] = requirementState{
					id: req.ID, required: int(req.RequiredCount), assigned: req.AssignedCount, roles: roles[req.ID],
				}
			}
		}
		result = append(result, state)
	}
	return result, nil
}

func (w *scheduleWriter) removeDay(ctx context.Context, day opendaysdb.OpenDay) error {
	action := "open_day.cancelled"
	if PeriodStatus(w.period.Status) == PeriodDraft {
		action = "open_day.deleted"
		if _, err := w.q.DeleteOpenDay(
			ctx,
			opendaysdb.DeleteOpenDayParams{ID: day.ID, ExpectedVersion: day.Version},
		); err != nil {
			return databaseError(err)
		}
		w.deletedDays[day.ID] = true
	} else if DayStatus(day.Status) == DayScheduled {
		if _, err := w.q.CancelOpenDay(
			ctx,
			opendaysdb.CancelOpenDayParams{ID: day.ID, ExpectedVersion: day.Version},
		); err != nil {
			return databaseError(err)
		}
	} else {
		return nil
	}
	w.removedDays[day.ID] = true
	return writeAudit(ctx, w.tx, w.principal, action, "open_day", day.ID, w.requestID, nil)
}

// updateDay rewrites one day as the working copy describes it. A day whose timeslots or places change leaves its
// series; a change of the note alone keeps it there.
func (w *scheduleWriter) updateDay(ctx context.Context, day opendaysdb.OpenDay, input ScheduleInput) error {
	current, err := w.slotsOf(ctx, day.ID)
	if err != nil {
		return err
	}
	inputs := slices.Clone(input.timeslots())
	if len(input.Timeslots) == 0 && len(current) == 1 {
		id := current[0].row.ID
		inputs[0].ID = &id
	}
	seriesID, detachedID := day.SeriesID, day.DetachedFromSeriesID
	fields := []string{"internalNote", "timeslots"}
	var metadata map[string]any
	if day.SeriesID != nil && !sameShape(current, inputs) {
		seriesID, detachedID = nil, day.SeriesID
		fields = append(fields, "seriesId")
		metadata = map[string]any{"detachedFromSeriesId": day.SeriesID.String()}
	}
	if err := w.writeSlots(ctx, day.ID, current, inputs); err != nil {
		return err
	}
	if _, err := w.q.UpdateOpenDay(ctx, opendaysdb.UpdateOpenDayParams{
		StartsAt:             inputs[0].StartsAt.UTC(),
		EndsAt:               inputs[len(inputs)-1].EndsAt.UTC(),
		InternalNote:         cleanNote(input.InternalNote),
		SeriesID:             seriesID,
		DetachedFromSeriesID: detachedID,
		ID:                   day.ID,
		ExpectedVersion:      day.Version,
	}); errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	return writeAuditWithMetadata(
		ctx, w.tx, w.principal, "open_day.updated", "open_day", day.ID, w.requestID, fields, metadata,
	)
}

// sameShape reports whether the inputs keep the day's timeslots, times and places exactly.
func sameShape(current []slotState, inputs []TimeslotInput) bool {
	if len(current) != len(inputs) {
		return false
	}
	for i, slot := range current {
		input := inputs[i]
		if input.ID == nil || *input.ID != slot.row.ID || !input.StartsAt.Equal(slot.row.StartsAt) ||
			!input.EndsAt.Equal(slot.row.EndsAt) || len(input.Requirements) != len(slot.requirements) {
			return false
		}
		for _, requirement := range input.Requirements {
			stored, ok := slot.requirements[requirement.Kind]
			if !ok || stored.required != requirement.RequiredCount || !sameIDs(stored.roles, requirement.EligibleRoleIDs) {
				return false
			}
		}
	}
	return true
}

func sameIDs(a, b []uuid.UUID) bool {
	left, right := uniqueIDs(a), uniqueIDs(b)
	if len(left) != len(right) {
		return false
	}
	set := map[uuid.UUID]bool{}
	for _, id := range left {
		set[id] = true
	}
	for _, id := range right {
		if !set[id] {
			return false
		}
	}
	return true
}

// writeSlots makes the day's timeslots match the inputs, which are ordered and validated. Inputs with an ID keep that
// timeslot and its assignments; timeslots left out are removed with their assignments.
func (w *scheduleWriter) writeSlots(
	ctx context.Context,
	dayID uuid.UUID,
	current []slotState,
	inputs []TimeslotInput,
) error {
	byID := map[uuid.UUID]slotState{}
	for _, slot := range current {
		byID[slot.row.ID] = slot
	}
	kept := map[uuid.UUID]bool{}
	for position, input := range inputs {
		if input.ID == nil {
			slotID := ids.New()
			if _, err := w.q.CreateTimeslot(ctx, opendaysdb.CreateTimeslotParams{
				ID: slotID, OpenDayID: dayID, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(),
				Position: int32(position),
			}); err != nil {
				return databaseError(err)
			}
			if err := createRequirements(ctx, w.q, dayID, slotID, input.Requirements); err != nil {
				return err
			}
			continue
		}
		slot, ok := byID[*input.ID]
		if !ok || kept[*input.ID] {
			return apperror.Invalid("timeslot ids must name distinct timeslots of the Open Day")
		}
		kept[*input.ID] = true
		if _, err := w.q.UpdateTimeslot(ctx, opendaysdb.UpdateTimeslotParams{
			StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), Position: int32(position),
			ID: slot.row.ID, OpenDayID: dayID,
		}); err != nil {
			return databaseError(err)
		}
		if err := replaceRequirements(ctx, w.q, dayID, slot, input.Requirements); err != nil {
			return err
		}
	}
	for _, slot := range current {
		if !kept[slot.row.ID] {
			if err := w.q.DeleteTimeslot(
				ctx,
				opendaysdb.DeleteTimeslotParams{ID: slot.row.ID, OpenDayID: dayID},
			); err != nil {
				return err
			}
		}
	}
	return nil
}

func (w *scheduleWriter) createDay(
	ctx context.Context,
	note *string,
	inputs []TimeslotInput,
	seriesID *uuid.UUID,
) (opendaysdb.OpenDay, error) {
	id := ids.New()
	row, err := w.q.CreateOpenDay(ctx, opendaysdb.CreateOpenDayParams{
		ID:           id,
		PeriodID:     w.period.ID,
		StartsAt:     inputs[0].StartsAt.UTC(),
		EndsAt:       inputs[len(inputs)-1].EndsAt.UTC(),
		InternalNote: note,
		SeriesID:     seriesID,
	})
	if err != nil {
		return opendaysdb.OpenDay{}, databaseError(err)
	}
	if err := w.writeSlots(ctx, id, nil, inputs); err != nil {
		return opendaysdb.OpenDay{}, err
	}
	var metadata map[string]any
	if seriesID != nil {
		metadata = map[string]any{"seriesId": seriesID.String()}
	}
	if err := writeAuditWithMetadata(
		ctx, w.tx, w.principal, "open_day.created", "open_day", id, w.requestID,
		[]string{"internalNote", "timeslots"}, metadata,
	); err != nil {
		return opendaysdb.OpenDay{}, err
	}
	return row, nil
}

// applyTemplate gives a day the timeslots and places of its series on its date. Timeslots keep their assignments by
// position; timeslots beyond the template are removed with theirs.
func (w *scheduleWriter) applyTemplate(
	ctx context.Context,
	day opendaysdb.OpenDay,
	series Series,
	seriesID, detachedID *uuid.UUID,
) error {
	inputs, err := w.s.templateTimeslots(w.s.localDate(day.StartsAt), series.SeriesTemplate)
	if err != nil {
		return err
	}
	if err := w.s.validateTimeslots(w.period, inputs); err != nil {
		return err
	}
	current, err := w.slotsOf(ctx, day.ID)
	if err != nil {
		return err
	}
	for i := range inputs {
		if i < len(current) {
			id := current[i].row.ID
			inputs[i].ID = &id
		}
	}
	if err := w.writeSlots(ctx, day.ID, current, inputs); err != nil {
		return err
	}
	if _, err := w.q.UpdateOpenDay(ctx, opendaysdb.UpdateOpenDayParams{
		StartsAt:             inputs[0].StartsAt.UTC(),
		EndsAt:               inputs[len(inputs)-1].EndsAt.UTC(),
		InternalNote:         day.InternalNote,
		SeriesID:             seriesID,
		DetachedFromSeriesID: detachedID,
		ID:                   day.ID,
		ExpectedVersion:      day.Version,
	}); errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	return nil
}

func (w *scheduleWriter) rejoin(ctx context.Context, day opendaysdb.OpenDay, series map[uuid.UUID]Series) error {
	if day.DetachedFromSeriesID == nil {
		return apperror.Conflicting("open_day_not_detached", "The Open Day did not leave a series")
	}
	item, ok := series[*day.DetachedFromSeriesID]
	if !ok {
		return apperror.NotFound
	}
	if err := w.applyTemplate(ctx, day, item, &item.ID, nil); err != nil {
		return err
	}
	return writeAuditWithMetadata(
		ctx, w.tx, w.principal, "open_day.rejoined_series", "open_day", day.ID, w.requestID,
		[]string{"timeslots", "seriesId"}, map[string]any{"seriesId": item.ID.String()},
	)
}

func (w *scheduleWriter) rejectOverlaps(ctx context.Context) error {
	pairs, err := w.q.ListOverlappingScheduledDays(ctx, w.period.ID)
	if err != nil {
		return err
	}
	if len(pairs) > 0 {
		return apperror.Conflicting("open_day_overlap", "Open Days must not overlap; another Open Day already uses this time")
	}
	return nil
}

func createRequirements(
	ctx context.Context,
	q *opendaysdb.Queries,
	openDayID, timeslotID uuid.UUID,
	inputs []RequirementInput,
) error {
	for _, input := range inputs {
		id := ids.New()
		if _, err := q.CreateRequirement(ctx, opendaysdb.CreateRequirementParams{
			ID:            id,
			OpenDayID:     openDayID,
			TimeslotID:    timeslotID,
			Kind:          string(input.Kind),
			RequiredCount: int32(input.RequiredCount),
		}); err != nil {
			return databaseError(err)
		}
		if err := addRequirementRoles(ctx, q, id, input.EligibleRoleIDs); err != nil {
			return err
		}
	}
	return nil
}

func replaceRequirements(
	ctx context.Context,
	q *opendaysdb.Queries,
	openDayID uuid.UUID,
	slot slotState,
	inputs []RequirementInput,
) error {
	for _, input := range inputs {
		stored, ok := slot.requirements[input.Kind]
		if !ok {
			if err := createRequirements(ctx, q, openDayID, slot.row.ID, []RequirementInput{input}); err != nil {
				return err
			}
			continue
		}
		if int64(input.RequiredCount) < stored.assigned {
			return apperror.Conflicting(
				"requirement_below_assignments",
				"Required staff count cannot be below current assignments",
			)
		}
		if _, err := q.UpdateRequirement(
			ctx,
			opendaysdb.UpdateRequirementParams{RequiredCount: int32(input.RequiredCount), ID: stored.id},
		); err != nil {
			return err
		}
		if err := q.DeleteRequirementRoles(ctx, stored.id); err != nil {
			return err
		}
		if err := addRequirementRoles(ctx, q, stored.id, input.EligibleRoleIDs); err != nil {
			return err
		}
	}
	return nil
}

func addRequirementRoles(ctx context.Context, q *opendaysdb.Queries, requirementID uuid.UUID, roleIDs []uuid.UUID) error {
	for _, roleID := range uniqueIDs(roleIDs) {
		if err := q.AddRequirementRole(
			ctx,
			opendaysdb.AddRequirementRoleParams{RequirementID: requirementID, RoleID: roleID},
		); err != nil {
			return databaseError(err)
		}
	}
	return nil
}

// validateRestrictionRoles requires every restriction to name an existing extra role: membership decides the kind
// of place, so membership and system roles cannot restrict one.
func validateRestrictionRoles(ctx context.Context, q *opendaysdb.Queries, roleIDs []uuid.UUID) error {
	unique := uniqueIDs(roleIDs)
	if len(unique) == 0 {
		return nil
	}
	count, err := q.CountExtraRoles(ctx, idTexts(unique))
	if err != nil {
		return err
	}
	if count != int64(len(unique)) {
		return apperror.InvalidField("eligible roles must be existing extra roles; membership and system roles cannot restrict a place")
	}
	return nil
}

// validateTimeslots checks the timeslots of one day: at least one, in order, not overlapping, all starting on the
// same local date, each inside the period with one supervisor and one trainee requirement.
func (s *Service) validateTimeslots(period opendaysdb.OpenDayPeriod, inputs []TimeslotInput) error {
	if len(inputs) == 0 || len(inputs) > MaxTimeslotsPerDay {
		return apperror.Invalid("an Open Day needs between 1 and 24 timeslots")
	}
	first := s.localDate(inputs[0].StartsAt)
	seen := map[uuid.UUID]bool{}
	for i, input := range inputs {
		if err := s.validateSlot(period, input.StartsAt, input.EndsAt); err != nil {
			return err
		}
		if i > 0 && input.StartsAt.Before(inputs[i-1].EndsAt) {
			return apperror.Invalid("timeslots must be in order and must not overlap")
		}
		if !s.localDate(input.StartsAt).Equal(first) {
			return apperror.Invalid("all timeslots of an Open Day start on the same date")
		}
		if input.ID != nil {
			if seen[*input.ID] {
				return apperror.Invalid("timeslot ids must name distinct timeslots of the Open Day")
			}
			seen[*input.ID] = true
		}
		if err := validateRequirements(input.Requirements); err != nil {
			return err
		}
	}
	return nil
}

func validateRequirements(inputs []RequirementInput) error {
	if len(inputs) != 2 {
		return apperror.Invalid("exactly supervisor and trainee requirements are required")
	}
	seen := map[RequirementKind]bool{}
	for _, r := range inputs {
		if r.Kind != RequirementSupervisor && r.Kind != RequirementTrainee {
			return apperror.Invalid("requirement kind is invalid")
		}
		if seen[r.Kind] {
			return apperror.Invalid("requirement kinds must be unique")
		}
		seen[r.Kind] = true
		if r.RequiredCount < 0 || r.RequiredCount > MaxRequiredCount {
			return apperror.Invalid("requiredCount must be between 0 and 100")
		}
		if len(r.EligibleRoleIDs) > MaxRestrictionRoles {
			return apperror.Invalid("too many eligible roles")
		}
	}
	return nil
}

func (s *Service) validateSlot(period opendaysdb.OpenDayPeriod, start, end time.Time) error {
	if start.IsZero() || end.IsZero() || !end.After(start) {
		return apperror.Invalid("endsAt must be after startsAt")
	}
	if err := s.validateSlotInstant(start); err != nil {
		return err
	}
	if err := s.validateSlotInstant(end); err != nil {
		return err
	}
	if !dateWithin(start.In(s.location), period.StartsOn.Time, period.EndsOn.Time) ||
		!dateWithin(end.Add(-time.Nanosecond).In(s.location), period.StartsOn.Time, period.EndsOn.Time) {
		return apperror.Invalid("Open Day must be within the period in the makerspace timezone")
	}
	return nil
}

// localDate is the makerspace calendar date of an instant, as a UTC midnight.
func (s *Service) localDate(instant time.Time) time.Time {
	local := instant.In(s.location)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
}
