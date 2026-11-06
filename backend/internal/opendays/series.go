package opendays

import (
	"context"
	"errors"
	"slices"
	"sort"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	opendaysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/opendays/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// ClockRange is a timeslot of a series template in makerspace wall-clock time ("15:04"); it ends on the day it
// starts.
type ClockRange struct {
	Start, End string
}

// SeriesTemplate is what every day of a weekly series looks like.
type SeriesTemplate struct {
	Timeslots                         []ClockRange
	SupervisorPlaces, TraineePlaces   int
	SupervisorRoleIDs, TraineeRoleIDs []uuid.UUID
	// ForcedDates are public holiday or academic break dates that get an open day anyway.
	ForcedDates []time.Time
}

// SeriesCreate is a new weekly series; saving it generates its open days.
type SeriesCreate struct {
	Weekday             int // ISO weekday, Monday is 1
	FromDate, UntilDate time.Time
	SeriesTemplate
}

// SeriesUpdate changes a series' template from ApplyFrom on and moves its end to UntilDate.
type SeriesUpdate struct {
	ID                   uuid.UUID
	ExpectedVersion      int64
	ApplyFrom, UntilDate time.Time
	SeriesTemplate
}

// SeriesRejoin makes a day that was edited on its own follow its series again.
type SeriesRejoin struct {
	OpenDayID       uuid.UUID
	ExpectedVersion int64
}

type Series struct {
	ID, PeriodID        uuid.UUID
	Weekday             int
	FromDate, UntilDate time.Time
	SeriesTemplate
	// DayCount counts the scheduled days that still follow the series.
	DayCount             int
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

// ListSeries returns the weekly series of a period to people who manage open days.
func (s *Service) ListSeries(ctx context.Context, principal authorization.Principal, periodID uuid.UUID) ([]Series, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return nil, apperror.PermissionDenied
	}
	q := opendaysdb.New(s.pool)
	if _, err := q.GetPeriod(ctx, periodID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	byID, err := s.loadSeries(ctx, q, periodID)
	if err != nil {
		return nil, err
	}
	items := make([]Series, 0, len(byID))
	for _, item := range byID {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Weekday != items[j].Weekday {
			return items[i].Weekday < items[j].Weekday
		}
		if !items[i].FromDate.Equal(items[j].FromDate) {
			return items[i].FromDate.Before(items[j].FromDate)
		}
		return items[i].ID.String() < items[j].ID.String()
	})
	return items, nil
}

func (s *Service) loadSeries(ctx context.Context, q *opendaysdb.Queries, periodID uuid.UUID) (map[uuid.UUID]Series, error) {
	rows, err := q.ListSeriesByPeriod(ctx, periodID)
	if err != nil {
		return nil, err
	}
	slots, err := q.ListSeriesTimeslots(ctx, periodID)
	if err != nil {
		return nil, err
	}
	roles, err := q.ListSeriesRoles(ctx, periodID)
	if err != nil {
		return nil, err
	}
	counts, err := q.CountSeriesDays(ctx, periodID)
	if err != nil {
		return nil, err
	}
	result := make(map[uuid.UUID]Series, len(rows))
	for _, row := range rows {
		item := seriesFromRow(row)
		for _, slot := range slots {
			if slot.SeriesID == row.ID {
				item.Timeslots = append(item.Timeslots, ClockRange{Start: clockOf(slot.StartTime), End: clockOf(slot.EndTime)})
			}
		}
		for _, role := range roles {
			if role.SeriesID != row.ID {
				continue
			}
			if RequirementKind(role.Kind) == RequirementSupervisor {
				item.SupervisorRoleIDs = append(item.SupervisorRoleIDs, role.RoleID)
			} else {
				item.TraineeRoleIDs = append(item.TraineeRoleIDs, role.RoleID)
			}
		}
		for _, count := range counts {
			if count.SeriesID == row.ID {
				item.DayCount = int(count.DayCount)
			}
		}
		result[row.ID] = item
	}
	return result, nil
}

func seriesFromRow(row opendaysdb.OpenDaySeries) Series {
	forced := make([]time.Time, 0, len(row.ForcedDates))
	for _, date := range row.ForcedDates {
		forced = append(forced, date.Time.UTC())
	}
	return Series{
		ID:        row.ID,
		PeriodID:  row.PeriodID,
		Weekday:   int(row.Weekday),
		FromDate:  row.FromDate.Time.UTC(),
		UntilDate: row.UntilDate.Time.UTC(),
		SeriesTemplate: SeriesTemplate{
			Timeslots:         []ClockRange{},
			SupervisorPlaces:  int(row.SupervisorPlaces),
			TraineePlaces:     int(row.TraineePlaces),
			SupervisorRoleIDs: []uuid.UUID{},
			TraineeRoleIDs:    []uuid.UUID{},
			ForcedDates:       forced,
		},
		Version:   row.Version,
		CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt,
	}
}

func clockOf(value pgtype.Time) string {
	minutes := value.Microseconds / int64(time.Minute/time.Microsecond)
	return time.Date(2000, time.January, 1, int(minutes/60), int(minutes%60), 0, 0, time.UTC).Format("15:04")
}

func pgClock(value string) pgtype.Time {
	clock, _ := time.Parse("15:04", value)
	minutes := int64(clock.Hour()*60 + clock.Minute())
	return pgtype.Time{Microseconds: minutes * int64(time.Minute/time.Microsecond), Valid: true}
}

func validateTemplate(tpl SeriesTemplate) error {
	if len(tpl.Timeslots) == 0 || len(tpl.Timeslots) > MaxTimeslotsPerDay {
		return apperror.Invalid("a series needs between 1 and 24 timeslots")
	}
	previousEnd := time.Time{}
	for i, slot := range tpl.Timeslots {
		start, startErr := time.Parse("15:04", slot.Start)
		end, endErr := time.Parse("15:04", slot.End)
		if startErr != nil || endErr != nil {
			return apperror.Invalid("timeslot times must be HH:MM")
		}
		if !end.After(start) {
			return apperror.Invalid("a timeslot must end after it starts")
		}
		if i > 0 && start.Before(previousEnd) {
			return apperror.Invalid("timeslots must be in order and must not overlap")
		}
		previousEnd = end
	}
	if tpl.SupervisorPlaces < 0 || tpl.SupervisorPlaces > MaxRequiredCount ||
		tpl.TraineePlaces < 0 || tpl.TraineePlaces > MaxRequiredCount {
		return apperror.Invalid("places must be between 0 and 100")
	}
	if len(tpl.SupervisorRoleIDs) > MaxRestrictionRoles || len(tpl.TraineeRoleIDs) > MaxRestrictionRoles {
		return apperror.Invalid("too many eligible roles")
	}
	if len(tpl.ForcedDates) > MaxForcedDates {
		return apperror.Invalid("too many forced dates")
	}
	return nil
}

func validateSeriesCreate(period opendaysdb.OpenDayPeriod, input SeriesCreate) error {
	if input.Weekday < 1 || input.Weekday > 7 {
		return apperror.Invalid("weekday must be between 1 and 7")
	}
	if input.FromDate.IsZero() || input.UntilDate.IsZero() || input.UntilDate.Before(input.FromDate) ||
		!dateWithin(input.FromDate, period.StartsOn.Time, period.EndsOn.Time) ||
		!dateWithin(input.UntilDate, period.StartsOn.Time, period.EndsOn.Time) {
		return apperror.Invalid("a series must run forward within the period")
	}
	if err := validateTemplate(input.SeriesTemplate); err != nil {
		return err
	}
	return validateForcedDates(input.ForcedDates, input.Weekday, input.FromDate, input.UntilDate)
}

func validateForcedDates(dates []time.Time, weekday int, from, until time.Time) error {
	for _, date := range dates {
		if !dateWithin(date, from, until) || int(dateOnly(date).Weekday()) != weekday%7 {
			return apperror.Invalid("forced dates must be dates of the series")
		}
	}
	return nil
}

// weekdayDates lists the dates with the ISO weekday from from to until, both included.
func weekdayDates(weekday int, from, until time.Time) []time.Time {
	date := dateOnly(from)
	for int(date.Weekday()) != weekday%7 {
		date = date.AddDate(0, 0, 1)
	}
	dates := []time.Time{}
	for !date.After(dateOnly(until)) {
		dates = append(dates, date)
		date = date.AddDate(0, 0, 7)
	}
	return dates
}

// templateTimeslots resolves the template's wall-clock timeslots on date.
func (s *Service) templateTimeslots(date time.Time, tpl SeriesTemplate) ([]TimeslotInput, error) {
	inputs := make([]TimeslotInput, 0, len(tpl.Timeslots))
	for _, slot := range tpl.Timeslots {
		start, err := s.wallClock(date, slot.Start)
		if err != nil {
			return nil, err
		}
		end, err := s.wallClock(date, slot.End)
		if err != nil {
			return nil, err
		}
		inputs = append(inputs, TimeslotInput{
			StartsAt: start.UTC(),
			EndsAt:   end.UTC(),
			Requirements: []RequirementInput{
				{
					Kind:            RequirementSupervisor,
					RequiredCount:   tpl.SupervisorPlaces,
					EligibleRoleIDs: slices.Clone(tpl.SupervisorRoleIDs),
				},
				{Kind: RequirementTrainee, RequiredCount: tpl.TraineePlaces, EligibleRoleIDs: slices.Clone(tpl.TraineeRoleIDs)},
			},
		})
	}
	return inputs, nil
}

func (s *Service) wallClock(date time.Time, clock string) (time.Time, error) {
	value, err := time.Parse("15:04", clock)
	if err != nil {
		return time.Time{}, apperror.Invalid("timeslot times must be HH:MM")
	}
	return s.resolveWallTime(
		time.Date(date.Year(), date.Month(), date.Day(), value.Hour(), value.Minute(), 0, 0, time.UTC),
	)
}

// blockedDates names the public holidays and academic breaks between from and until by date key.
func (s *Service) blockedDates(
	ctx context.Context,
	q *opendaysdb.Queries,
	from, until time.Time,
) (map[string]string, error) {
	result := map[string]string{}
	holidays, err := s.holidays.Between(from, until)
	if err != nil {
		return nil, err
	}
	for _, holiday := range holidays {
		result[dateKey(holiday.Date)] = holiday.Name
	}
	breaks, err := q.ListAcademicBreaksInRange(
		ctx,
		opendaysdb.ListAcademicBreaksInRangeParams{EndsOn: pgDate(until), StartsOn: pgDate(from)},
	)
	if err != nil {
		return nil, err
	}
	for date := dateOnly(from); !date.After(dateOnly(until)); date = date.AddDate(0, 0, 1) {
		for _, item := range breaks {
			if _, ok := result[dateKey(date)]; !ok && dateWithin(date, item.StartsOn.Time, item.EndsOn.Time) {
				result[dateKey(date)] = item.Name
			}
		}
	}
	return result, nil
}

type span struct{ start, end time.Time }

func overlapsAny(spans []span, start, end time.Time) bool {
	for _, item := range spans {
		if start.Before(item.end) && item.start.Before(end) {
			return true
		}
	}
	return false
}

func (w *scheduleWriter) occupied(ctx context.Context) ([]span, error) {
	days, err := w.q.ListOpenDaysByPeriod(ctx, w.period.ID)
	if err != nil {
		return nil, err
	}
	result := make([]span, 0, len(days))
	for _, day := range days {
		if DayStatus(day.Status) == DayScheduled {
			result = append(result, span{start: day.StartsAt, end: day.EndsAt})
		}
	}
	return result, nil
}

func (w *scheduleWriter) writeTemplate(ctx context.Context, seriesID uuid.UUID, tpl SeriesTemplate) error {
	if err := w.q.DeleteSeriesTimeslots(ctx, seriesID); err != nil {
		return err
	}
	for position, slot := range tpl.Timeslots {
		if err := w.q.CreateSeriesTimeslot(ctx, opendaysdb.CreateSeriesTimeslotParams{
			SeriesID: seriesID, Position: int32(position), StartTime: pgClock(slot.Start), EndTime: pgClock(slot.End),
		}); err != nil {
			return databaseError(err)
		}
	}
	if err := w.q.DeleteSeriesRoles(ctx, seriesID); err != nil {
		return err
	}
	for kind, roles := range map[RequirementKind][]uuid.UUID{
		RequirementSupervisor: tpl.SupervisorRoleIDs,
		RequirementTrainee:    tpl.TraineeRoleIDs,
	} {
		for _, roleID := range uniqueIDs(roles) {
			if err := w.q.AddSeriesRole(
				ctx,
				opendaysdb.AddSeriesRoleParams{SeriesID: seriesID, Kind: string(kind), RoleID: roleID},
			); err != nil {
				return databaseError(err)
			}
		}
	}
	return nil
}

func dateTexts(dates []time.Time) []string {
	unique := map[string]bool{}
	result := make([]string, 0, len(dates))
	for _, date := range dates {
		if key := dateKey(date); !unique[key] {
			unique[key] = true
			result = append(result, key)
		}
	}
	sort.Strings(result)
	return result
}

// createSeries stores the series and generates its days; it returns how many days it created.
func (w *scheduleWriter) createSeries(ctx context.Context, input SeriesCreate) (int, error) {
	id := ids.New()
	row, err := w.q.CreateSeries(ctx, opendaysdb.CreateSeriesParams{
		ID:               id,
		PeriodID:         w.period.ID,
		Weekday:          int32(input.Weekday),
		FromDate:         pgDate(input.FromDate),
		UntilDate:        pgDate(input.UntilDate),
		SupervisorPlaces: int32(input.SupervisorPlaces),
		TraineePlaces:    int32(input.TraineePlaces),
		ForcedDates:      dateTexts(input.ForcedDates),
	})
	if err != nil {
		return 0, databaseError(err)
	}
	if err := w.writeTemplate(ctx, id, input.SeriesTemplate); err != nil {
		return 0, err
	}
	if err := writeAudit(ctx, w.tx, w.principal, "open_day_series.created", "open_day_series", id, w.requestID,
		[]string{"weekday", "fromDate", "untilDate", "timeslots", "places", "roles", "forcedDates"}); err != nil {
		return 0, err
	}
	series := seriesFromRow(row)
	series.SeriesTemplate = input.SeriesTemplate
	return w.generate(ctx, series, weekdayDates(input.Weekday, input.FromDate, input.UntilDate))
}

// generate creates the series' days on the dates. A public holiday or academic break is skipped unless the series
// forces it; a date on which another open day overlaps is always skipped.
func (w *scheduleWriter) generate(ctx context.Context, series Series, dates []time.Time) (int, error) {
	if len(dates) == 0 {
		return 0, nil
	}
	blocked, err := w.s.blockedDates(ctx, w.q, dates[0], dates[len(dates)-1])
	if err != nil {
		return 0, err
	}
	forced := map[string]bool{}
	for _, date := range series.ForcedDates {
		forced[dateKey(date)] = true
	}
	occupied, err := w.occupied(ctx)
	if err != nil {
		return 0, err
	}
	created := 0
	for _, date := range dates {
		if _, ok := blocked[dateKey(date)]; ok && !forced[dateKey(date)] {
			continue
		}
		inputs, err := w.s.templateTimeslots(date, series.SeriesTemplate)
		if err != nil {
			return 0, err
		}
		if err := w.s.validateTimeslots(w.period, inputs); err != nil {
			return 0, err
		}
		start, end := inputs[0].StartsAt, inputs[len(inputs)-1].EndsAt
		if overlapsAny(occupied, start, end) {
			continue
		}
		seriesID := series.ID
		if _, err := w.createDay(ctx, nil, inputs, &seriesID); err != nil {
			return 0, err
		}
		occupied = append(occupied, span{start: start, end: end})
		created++
	}
	return created, nil
}

// updateSeries applies a changed template to the series' scheduled days that have not started, from the apply-from
// date (never before today) on. Moving the end earlier removes the later days: deleted in a draft period, cancelled
// otherwise. Moving it later, or forcing another holiday date, adds days.
func (w *scheduleWriter) updateSeries(ctx context.Context, input SeriesUpdate) error {
	row, err := w.q.GetSeriesForUpdate(ctx, input.ID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && row.PeriodID != w.period.ID) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if row.Version != input.ExpectedVersion {
		return apperror.StaleWrite
	}
	from := row.FromDate.Time.UTC()
	until := dateOnly(input.UntilDate)
	if input.UntilDate.IsZero() || input.ApplyFrom.IsZero() || until.Before(from) ||
		!dateWithin(until, w.period.StartsOn.Time, w.period.EndsOn.Time) {
		return apperror.Invalid("a series must run forward within the period")
	}
	if err := validateForcedDates(input.ForcedDates, int(row.Weekday), from, until); err != nil {
		return err
	}
	oldUntil := row.UntilDate.Time.UTC()
	oldForced := map[string]bool{}
	for _, date := range row.ForcedDates {
		oldForced[dateKey(date.Time)] = true
	}
	applyFrom := dateOnly(input.ApplyFrom)
	for _, floor := range []time.Time{w.s.localDate(w.now), from} {
		if applyFrom.Before(floor) {
			applyFrom = floor
		}
	}
	updated, err := w.q.UpdateSeries(ctx, opendaysdb.UpdateSeriesParams{
		UntilDate:        pgDate(until),
		SupervisorPlaces: int32(input.SupervisorPlaces),
		TraineePlaces:    int32(input.TraineePlaces),
		ForcedDates:      dateTexts(input.ForcedDates),
		ID:               row.ID,
		ExpectedVersion:  row.Version,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	}
	if err != nil {
		return databaseError(err)
	}
	if err := w.writeTemplate(ctx, row.ID, input.SeriesTemplate); err != nil {
		return err
	}
	series := seriesFromRow(updated)
	series.SeriesTemplate = input.SeriesTemplate
	days, err := w.q.ListOpenDaysByPeriod(ctx, w.period.ID)
	if err != nil {
		return err
	}
	taken := map[string]bool{}
	for _, day := range days {
		belongs := day.SeriesID != nil && *day.SeriesID == row.ID
		if belongs || (day.DetachedFromSeriesID != nil && *day.DetachedFromSeriesID == row.ID) {
			taken[dateKey(w.s.localDate(day.StartsAt))] = true
		}
		if !belongs || DayStatus(day.Status) != DayScheduled || !day.StartsAt.After(w.now) {
			continue
		}
		date := w.s.localDate(day.StartsAt)
		if date.After(until) {
			if err := w.removeDay(ctx, day); err != nil {
				return err
			}
			continue
		}
		if date.Before(applyFrom) {
			continue
		}
		if err := w.applyTemplate(ctx, day, series, &series.ID, nil); err != nil {
			return err
		}
		if err := writeAuditWithMetadata(ctx, w.tx, w.principal, "open_day.updated", "open_day", day.ID, w.requestID,
			[]string{"timeslots"}, map[string]any{"seriesId": series.ID.String()}); err != nil {
			return err
		}
	}
	if err := writeAudit(ctx, w.tx, w.principal, "open_day_series.updated", "open_day_series", row.ID, w.requestID,
		[]string{"untilDate", "timeslots", "places", "roles", "forcedDates"}); err != nil {
		return err
	}
	additions := []time.Time{}
	for _, date := range weekdayDates(int(row.Weekday), applyFrom, until) {
		key := dateKey(date)
		forcedNow := slices.ContainsFunc(input.ForcedDates, func(d time.Time) bool { return dateKey(d) == key })
		if !taken[key] && (date.After(oldUntil) || (forcedNow && !oldForced[key])) {
			additions = append(additions, date)
		}
	}
	_, err = w.generate(ctx, series, additions)
	return err
}

// copySeries copies the weekly series of another period into a new one: each runs from the first date of its
// weekday in the new period to its end, without the forced dates of the old period, and generates its days.
func (s *Service) copySeries(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	sourcePeriodID uuid.UUID,
	period opendaysdb.OpenDayPeriod,
	requestID *uuid.UUID,
) error {
	q := opendaysdb.New(tx)
	if _, err := q.GetPeriod(ctx, sourcePeriodID); errors.Is(err, pgx.ErrNoRows) {
		return apperror.InvalidField("copySeriesFromPeriodId does not name a period")
	} else if err != nil {
		return err
	}
	source, err := s.loadSeries(ctx, q, sourcePeriodID)
	if err != nil {
		return err
	}
	items := make([]Series, 0, len(source))
	for _, item := range source {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID.String() < items[j].ID.String() })
	w := &scheduleWriter{
		s: s, q: q, tx: tx, principal: principal, period: period, requestID: requestID, now: time.Now().UTC(),
	}
	start, end := period.StartsOn.Time.UTC(), period.EndsOn.Time.UTC()
	for _, item := range items {
		dates := weekdayDates(item.Weekday, start, end)
		if len(dates) == 0 {
			continue
		}
		template := item.SeriesTemplate
		template.ForcedDates = nil
		if _, err := w.createSeries(ctx, SeriesCreate{
			Weekday: item.Weekday, FromDate: dates[0], UntilDate: end, SeriesTemplate: template,
		}); err != nil {
			return err
		}
	}
	return nil
}
