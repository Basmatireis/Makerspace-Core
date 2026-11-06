package opendays

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	opendaysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/opendays/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/trainings"
	goholidays "github.com/coredds/GoHoliday"
	"github.com/coredds/GoHoliday/countries"
	"github.com/emersion/go-ical"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Holiday struct {
	Name string
	Date time.Time
}
type HolidayProvider interface {
	Between(start, end time.Time) ([]Holiday, error)
}

type goHolidayProvider struct {
	country  *goholidays.Country
	language string
}

type austriaHolidayProvider struct {
	provider    *countries.ATProvider
	subdivision string
	language    string
}

func newHolidayProvider(cfg config.Config) (HolidayProvider, error) {
	country := strings.ToUpper(strings.TrimSpace(cfg.HolidayCountry))
	if country == "" {
		country = "AT"
	}
	subdivision := strings.ToUpper(strings.TrimSpace(cfg.HolidaySubdivision))
	if subdivision == "" {
		subdivision = "AT-6"
	}
	language := strings.ToLower(strings.TrimSpace(cfg.HolidayLanguage))
	if language == "" {
		language = "de"
	}
	if country == "AT" {
		provider := countries.NewATProvider()
		providerSubdivision := strings.TrimPrefix(subdivision, "AT-")
		if !containsString(provider.GetSupportedSubdivisions(), providerSubdivision) {
			return nil, fmt.Errorf(
				"validate Open Days holiday jurisdiction %s/%s: unsupported subdivision",
				country,
				subdivision,
			)
		}
		return &austriaHolidayProvider{provider: provider, subdivision: providerSubdivision, language: language}, nil
	}
	options := goholidays.CountryOptions{Language: language}
	if subdivision != "" {
		options.Subdivisions = []string{subdivision}
	}
	value, err := goholidays.NewCountryWithError(country, options)
	if err != nil {
		return nil, fmt.Errorf("validate Open Days holiday jurisdiction %s/%s: %w", country, subdivision, err)
	}
	return &goHolidayProvider{country: value, language: language}, nil
}

func (p *austriaHolidayProvider) Between(start, end time.Time) ([]Holiday, error) {
	start = dateOnly(start)
	end = dateOnly(end)
	items := []Holiday{}
	for year := start.Year(); year <= end.Year(); year++ {
		for date, value := range p.provider.LoadHolidays(year) {
			if !date.Before(start) && !date.After(end) {
				items = append(
					items,
					Holiday{Name: translatedHolidayName(value.Name, value.Languages, p.language), Date: date},
				)
			}
		}
		for date, value := range p.provider.GetRegionalHolidays(year, []string{p.subdivision}) {
			if !date.Before(start) && !date.After(end) {
				items = append(
					items,
					Holiday{Name: translatedHolidayName(value.Name, value.Languages, p.language), Date: date},
				)
			}
		}
	}
	sortHolidays(items)
	return items, nil
}

func (p *goHolidayProvider) Between(start, end time.Time) ([]Holiday, error) {
	values := p.country.HolidaysForDateRange(start, end)
	items := make([]Holiday, 0, len(values))
	for date, value := range values {
		items = append(items, Holiday{Name: translatedHolidayName(value.Name, value.Languages, p.language), Date: date})
	}
	sortHolidays(items)
	return items, nil
}

func translatedHolidayName(name string, translations map[string]string, language string) string {
	if translated := translations[language]; translated != "" {
		return translated
	}
	return name
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func sortHolidays(items []Holiday) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && (items[j].Date.Before(items[j-1].Date) || (items[j].Date.Equal(items[j-1].Date) && items[j].Name < items[j-1].Name)); j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}

type AcademicBreak struct {
	ID                   uuid.UUID
	Name                 string
	StartsOn, EndsOn     time.Time
	Version              int64
	CreatedAt, UpdatedAt time.Time
}
type CalendarEntry struct {
	ID               *uuid.UUID
	Name             string
	Source           EntrySource
	Category         EntryCategory
	StartsOn, EndsOn time.Time
}
type CalendarContext struct {
	TimeZone, CountryCode, SubdivisionCode, LanguageCode string
	Entries                                              []CalendarEntry
	AcademicBreaks                                       []AcademicBreak
}

func (s *Service) ListAcademicBreaks(ctx context.Context, p authorization.Principal) ([]AcademicBreak, error) {
	if !p.Has(authorization.OpenDaysManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := opendaysdb.New(s.pool).ListAcademicBreaks(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]AcademicBreak, 0, len(rows))
	for _, row := range rows {
		items = append(items, breakFromRow(row))
	}
	return items, nil
}

func (s *Service) CalendarContext(
	ctx context.Context,
	principal authorization.Principal,
	periodID uuid.UUID,
) (CalendarContext, error) {
	period, err := s.GetPeriod(ctx, principal, periodID)
	if err != nil {
		return CalendarContext{}, err
	}
	q := opendaysdb.New(s.pool)
	breaks, err := q.ListAcademicBreaksInRange(
		ctx,
		opendaysdb.ListAcademicBreaksInRangeParams{EndsOn: pgDate(period.EndsOn), StartsOn: pgDate(period.StartsOn)},
	)
	if err != nil {
		return CalendarContext{}, err
	}
	holidays, err := s.holidays.Between(period.StartsOn, period.EndsOn)
	if err != nil {
		return CalendarContext{}, err
	}
	result := CalendarContext{
		TimeZone:        s.location.String(),
		CountryCode:     valueOr(s.cfg.HolidayCountry, "AT"),
		SubdivisionCode: valueOr(s.cfg.HolidaySubdivision, "AT-6"),
		LanguageCode:    valueOr(s.cfg.HolidayLanguage, "de"),
		Entries:         []CalendarEntry{},
		AcademicBreaks:  []AcademicBreak{},
	}
	for _, holiday := range holidays {
		date := dateOnly(holiday.Date)
		result.Entries = append(
			result.Entries,
			CalendarEntry{
				Name:     holiday.Name,
				Source:   EntrySourceHolidayLibrary,
				Category: EntryPublicHoliday,
				StartsOn: date,
				EndsOn:   date,
			},
		)
	}
	for _, row := range breaks {
		item := breakFromRow(row)
		result.AcademicBreaks = append(result.AcademicBreaks, item)
		id := item.ID
		result.Entries = append(
			result.Entries,
			CalendarEntry{
				ID:       &id,
				Name:     item.Name,
				Source:   EntrySourceManual,
				Category: EntryAcademicBreak,
				StartsOn: item.StartsOn,
				EndsOn:   item.EndsOn,
			},
		)
	}
	return result, nil
}

// PublicHolidaysBetween returns the public holidays of the configured jurisdiction in the inclusive date
// range. Holidays are public knowledge, so no permission is needed (signage displays show them).
func (s *Service) PublicHolidaysBetween(start, end time.Time) ([]Holiday, error) {
	return s.holidays.Between(start, end)
}

// PublicAcademicBreaksBetween returns the academic breaks that overlap the inclusive date range. Breaks
// are shown on public displays, so no permission is needed; callers expose only name and dates.
func (s *Service) PublicAcademicBreaksBetween(ctx context.Context, start, end time.Time) ([]AcademicBreak, error) {
	rows, err := opendaysdb.New(s.pool).ListAcademicBreaksInRange(
		ctx,
		opendaysdb.ListAcademicBreaksInRangeParams{EndsOn: pgDate(end), StartsOn: pgDate(start)},
	)
	if err != nil {
		return nil, err
	}
	items := make([]AcademicBreak, 0, len(rows))
	for _, row := range rows {
		items = append(items, breakFromRow(row))
	}
	return items, nil
}

func (s *Service) CreateAcademicBreak(
	ctx context.Context,
	p authorization.Principal,
	name string,
	start, end time.Time,
	requestID *uuid.UUID,
) (AcademicBreak, error) {
	if !p.Has(authorization.OpenDaysManage) {
		return AcademicBreak{}, apperror.PermissionDenied
	}
	name, err := validateBreak(name, start, end)
	if err != nil {
		return AcademicBreak{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AcademicBreak{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := ids.New()
	row, err := opendaysdb.New(tx).
		CreateAcademicBreak(
			ctx,
			opendaysdb.CreateAcademicBreakParams{ID: id, Name: name, StartsOn: pgDate(start), EndsOn: pgDate(end)},
		)
	if err != nil {
		return AcademicBreak{}, databaseError(err)
	}
	actor := p.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "open_day_academic_break.created",
			ResourceType:   "open_day_academic_break",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"name", "startsOn", "endsOn"},
		},
	); err != nil {
		return AcademicBreak{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcademicBreak{}, err
	}
	return breakFromRow(row), nil
}

func (s *Service) UpdateAcademicBreak(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	name string,
	start, end time.Time,
	requestID *uuid.UUID,
) (AcademicBreak, error) {
	if !p.Has(authorization.OpenDaysManage) {
		return AcademicBreak{}, apperror.PermissionDenied
	}
	if expected < 1 {
		return AcademicBreak{}, apperror.Invalid("expectedVersion must be positive")
	}
	name, err := validateBreak(name, start, end)
	if err != nil {
		return AcademicBreak{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AcademicBreak{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := opendaysdb.New(tx)
	current, err := q.GetAcademicBreakForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return AcademicBreak{}, apperror.NotFound
	}
	if err != nil {
		return AcademicBreak{}, err
	}
	if current.Version != expected {
		return AcademicBreak{}, apperror.StaleWrite
	}
	row, err := q.UpdateAcademicBreak(
		ctx,
		opendaysdb.UpdateAcademicBreakParams{
			Name:            name,
			StartsOn:        pgDate(start),
			EndsOn:          pgDate(end),
			ID:              id,
			ExpectedVersion: expected,
		},
	)
	if err != nil {
		return AcademicBreak{}, databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		p,
		"open_day_academic_break.updated",
		"open_day_academic_break",
		id,
		requestID,
		[]string{"name", "startsOn", "endsOn"},
	); err != nil {
		return AcademicBreak{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcademicBreak{}, err
	}
	return breakFromRow(row), nil
}

func (s *Service) DeleteAcademicBreak(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.OpenDaysManage) {
		return apperror.PermissionDenied
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := opendaysdb.New(tx)
	current, err := q.GetAcademicBreakForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	if _, err := q.DeleteAcademicBreak(
		ctx,
		opendaysdb.DeleteAcademicBreakParams{ID: id, ExpectedVersion: expected},
	); err != nil {
		return databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		p,
		"open_day_academic_break.deleted",
		"open_day_academic_break",
		id,
		requestID,
		nil,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type RecurrenceInput struct {
	Weekday                                int
	StartsOn, EndsOn                       time.Time
	StartTime, EndTime                     string
	EveryWeeks                             int
	SkipPublicHolidays, SkipAcademicBreaks bool
	// Timeslots replace StartTime and EndTime when set.
	Timeslots []ClockRange
	// ForcedDates are holiday or break dates that get an open day anyway.
	ForcedDates []time.Time
}
type RecurrenceOccurrence struct {
	Date, StartsAt, EndsAt time.Time
	Timeslots              []PublicTimeslot
	Disposition            Disposition
	Reason                 string
}

func (s *Service) PreviewRecurrence(
	ctx context.Context,
	p authorization.Principal,
	periodID uuid.UUID,
	input RecurrenceInput,
) ([]RecurrenceOccurrence, error) {
	if !p.Has(authorization.OpenDaysManage) {
		return nil, apperror.PermissionDenied
	}
	period, err := s.GetPeriod(ctx, p, periodID)
	if err != nil {
		return nil, err
	}
	if input.Weekday < 1 || input.Weekday > 7 || input.EveryWeeks < 1 || input.EveryWeeks > 52 ||
		input.EndsOn.Before(input.StartsOn) {
		return nil, apperror.Invalid("recurrence range is invalid")
	}
	if len(input.Timeslots) > 0 {
		if err := validateTemplate(SeriesTemplate{Timeslots: input.Timeslots, ForcedDates: input.ForcedDates}); err != nil {
			return nil, err
		}
	} else {
		if _, err := time.Parse("15:04", input.StartTime); err != nil {
			return nil, apperror.Invalid("startTime is invalid")
		}
		if _, err := time.Parse("15:04", input.EndTime); err != nil {
			return nil, apperror.Invalid("endTime is invalid")
		}
	}
	if !input.StartsOn.Equal(dateOnly(input.StartsOn)) || !dateWithin(input.StartsOn, period.StartsOn, period.EndsOn) ||
		!dateWithin(input.EndsOn, period.StartsOn, period.EndsOn) {
		return nil, apperror.Invalid("recurrence must stay within the period")
	}
	q := opendaysdb.New(s.pool)
	days, err := q.ListOpenDaysByPeriod(ctx, periodID)
	if err != nil {
		return nil, err
	}
	breaks, err := q.ListAcademicBreaksInRange(
		ctx,
		opendaysdb.ListAcademicBreaksInRangeParams{EndsOn: pgDate(input.EndsOn), StartsOn: pgDate(input.StartsOn)},
	)
	if err != nil {
		return nil, err
	}
	holidays, err := s.holidays.Between(input.StartsOn, input.EndsOn)
	if err != nil {
		return nil, err
	}
	holidayDates := map[string]string{}
	for _, h := range holidays {
		holidayDates[dateKey(h.Date)] = h.Name
	}
	forced := map[string]bool{}
	for _, date := range input.ForcedDates {
		forced[dateKey(date)] = true
	}
	date := dateOnly(input.StartsOn)
	for int(date.Weekday()) != input.Weekday%7 {
		date = date.AddDate(0, 0, 1)
	}
	items := []RecurrenceOccurrence{}
	for !date.After(dateOnly(input.EndsOn)) {
		slots, err := s.occurrenceSlots(date, input)
		if err != nil {
			return nil, err
		}
		item := RecurrenceOccurrence{
			Date: date, StartsAt: slots[0].StartsAt, EndsAt: slots[len(slots)-1].EndsAt, Timeslots: slots,
			Disposition: DispositionCreate,
		}
		if name, ok := holidayDates[dateKey(date)]; ok && input.SkipPublicHolidays {
			item.Disposition = DispositionPublicHoliday
			item.Reason = name
		}
		for _, b := range breaks {
			if dateWithin(date, b.StartsOn.Time, b.EndsOn.Time) && input.SkipAcademicBreaks {
				item.Disposition = DispositionAcademicBreak
				item.Reason = b.Name
				break
			}
		}
		if item.Disposition != DispositionCreate && forced[dateKey(date)] {
			item.Disposition = DispositionForced
		}
		for _, day := range days {
			if DayStatus(day.Status) == DayScheduled && day.StartsAt.Before(item.EndsAt) && item.StartsAt.Before(day.EndsAt) {
				item.Disposition = DispositionConflict
				item.Reason = "Another Open Day overlaps this time"
				break
			}
		}
		items = append(items, item)
		date = date.AddDate(0, 0, 7*input.EveryWeeks)
	}
	return items, nil
}

// occurrenceSlots resolves one recurrence date's timeslots; a single range whose end is not after its start ends on
// the next day.
func (s *Service) occurrenceSlots(date time.Time, input RecurrenceInput) ([]PublicTimeslot, error) {
	if len(input.Timeslots) > 0 {
		inputs, err := s.templateTimeslots(date, SeriesTemplate{Timeslots: input.Timeslots})
		if err != nil {
			return nil, err
		}
		slots := make([]PublicTimeslot, 0, len(inputs))
		for _, slot := range inputs {
			slots = append(slots, PublicTimeslot{StartsAt: slot.StartsAt, EndsAt: slot.EndsAt})
		}
		return slots, nil
	}
	start, err := s.wallClock(date, input.StartTime)
	if err != nil {
		return nil, err
	}
	endDate := date
	if input.EndTime <= input.StartTime {
		endDate = endDate.AddDate(0, 0, 1)
	}
	end, err := s.wallClock(endDate, input.EndTime)
	if err != nil {
		return nil, err
	}
	return []PublicTimeslot{{StartsAt: start.UTC(), EndsAt: end.UTC()}}, nil
}

// PublicTimeslot is the time range of one timeslot, without any staffing.
type PublicTimeslot struct {
	StartsAt, EndsAt time.Time
}

type PublicOpenDay struct {
	ID               uuid.UUID
	Title            string
	StartsAt, EndsAt time.Time
	Timeslots        []PublicTimeslot
	Status           DayStatus
	UpdatedAt        time.Time
	Version          int64
	// Competencies hold only category IDs and labels: no people, trainings or trainer rights.
	Competencies []trainings.Competency
}

func (s *Service) ListPublic(ctx context.Context) ([]PublicOpenDay, error) {
	q := opendaysdb.New(s.pool)
	rows, err := q.ListPublishedOpenDays(ctx)
	if err != nil {
		return nil, err
	}
	dayIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		dayIDs = append(dayIDs, row.ID)
	}
	competencies, err := trainings.OpenDayCompetencies(ctx, s.pool, dayIDs)
	if err != nil {
		return nil, err
	}
	slotRows, err := q.ListTimeslotsByDays(ctx, idTexts(dayIDs))
	if err != nil {
		return nil, err
	}
	slots := map[uuid.UUID][]PublicTimeslot{}
	for _, slot := range slotRows {
		slots[slot.OpenDayID] = append(slots[slot.OpenDayID], PublicTimeslot{StartsAt: slot.StartsAt, EndsAt: slot.EndsAt})
	}
	items := make([]PublicOpenDay, 0, len(rows))
	for _, row := range rows {
		daySlots := slots[row.ID]
		if daySlots == nil {
			daySlots = []PublicTimeslot{}
		}
		items = append(
			items,
			PublicOpenDay{
				ID:           row.ID,
				Title:        "Open Day",
				StartsAt:     row.StartsAt,
				EndsAt:       row.EndsAt,
				Timeslots:    daySlots,
				Status:       DayStatus(row.Status),
				UpdatedAt:    row.UpdatedAt,
				Version:      row.Version,
				Competencies: competenciesOrEmpty(competencies[row.ID]),
			},
		)
	}
	return items, nil
}
func (s *Service) PublicICS(ctx context.Context) ([]byte, error) {
	items, err := s.ListPublic(ctx)
	if err != nil {
		return nil, err
	}
	cal := ical.NewCalendar()
	cal.Props.SetText(ical.PropProductID, "-//HTUGraz Makerspace//Open Days//EN")
	cal.Props.SetText(ical.PropVersion, "2.0")
	cal.Props.SetText(ical.PropCalendarScale, "GREGORIAN")
	cal.Props.SetText(ical.PropName, "Open Days")
	if len(items) == 0 {
		zone := ical.NewComponent(ical.CompTimezone)
		zone.Props.SetText(ical.PropTimezoneID, "UTC")
		standard := ical.NewComponent(ical.CompTimezoneStandard)
		standard.Props.SetDateTime(ical.PropDateTimeStart, time.Date(1970, time.January, 1, 0, 0, 0, 0, time.UTC))
		standard.Props.SetText(ical.PropTimezoneOffsetFrom, "+0000")
		standard.Props.SetText(ical.PropTimezoneOffsetTo, "+0000")
		zone.Children = append(zone.Children, standard)
		cal.Children = append(cal.Children, zone)
	}
	generatedAt := time.Now().UTC().Truncate(time.Second)
	for _, item := range items {
		event := ical.NewEvent()
		event.Props.SetText(ical.PropUID, "urn:uuid:"+item.ID.String())
		event.Props.SetText(ical.PropSummary, item.Title)
		event.Props.SetDateTime(ical.PropDateTimeStart, item.StartsAt.UTC())
		event.Props.SetDateTime(ical.PropDateTimeEnd, item.EndsAt.UTC())
		// DTSTAMP is when the feed was generated: the description follows assignments and training records, which do
		// not change the open day's version, LAST-MODIFIED or SEQUENCE.
		event.Props.SetDateTime(ical.PropDateTimeStamp, generatedAt)
		if description := s.publicDescription(item); description != "" {
			event.Props.SetText(ical.PropDescription, description)
		}
		event.Props.SetDateTime(ical.PropLastModified, item.UpdatedAt.UTC())
		event.Props.SetText(ical.PropSequence, strconv.FormatInt(item.Version, 10))
		if item.Status == DayCancelled {
			event.SetStatus(ical.EventCancelled)
		} else {
			event.SetStatus(ical.EventConfirmed)
		}
		cal.Children = append(cal.Children, event.Component)
	}
	var buffer bytes.Buffer
	if err := ical.NewEncoder(&buffer).Encode(cal); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// publicDescription is the ICS description: the timeslots of a day with more than one, in makerspace time, and the
// planned competencies, labelled as planned because staffing can still change.
func (s *Service) publicDescription(item PublicOpenDay) string {
	lines := []string{}
	if len(item.Timeslots) > 1 {
		ranges := make([]string, 0, len(item.Timeslots))
		for _, slot := range item.Timeslots {
			ranges = append(ranges, slot.StartsAt.In(s.location).Format("15:04")+"–"+slot.EndsAt.In(s.location).Format("15:04"))
		}
		lines = append(lines, "Timeslots: "+strings.Join(ranges, ", "))
	}
	if description := competencyDescription(item.Competencies); description != "" {
		lines = append(lines, description)
	}
	return strings.Join(lines, "\n")
}

// competencyDescription names the planned competencies, labelled as planned because staffing can still change.
func competencyDescription(items []trainings.Competency) string {
	if len(items) == 0 {
		return ""
	}
	labels := make([]string, 0, len(items))
	for _, item := range items {
		labels = append(labels, item.Label)
	}
	return "Planned support: " + strings.Join(labels, ", ")
}

func validateBreak(name string, start, end time.Time) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 150 {
		return "", apperror.Invalid("academic break name is invalid")
	}
	if start.IsZero() || end.IsZero() || end.Before(start) {
		return "", apperror.Invalid("academic break date range is invalid")
	}
	return name, nil
}
func breakFromRow(r opendaysdb.OpenDayAcademicBreak) AcademicBreak {
	return AcademicBreak{
		ID:        r.ID,
		Name:      r.Name,
		StartsOn:  r.StartsOn.Time,
		EndsOn:    r.EndsOn.Time,
		Version:   r.Version,
		CreatedAt: r.CreatedAt,
		UpdatedAt: r.UpdatedAt,
	}
}
func dateOnly(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}
func dateKey(t time.Time) string { return t.Format("2006-01-02") }
func valueOr(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}
