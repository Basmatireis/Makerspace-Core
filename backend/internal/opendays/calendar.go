package opendays

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	opendaysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/opendays/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
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
			return nil, fmt.Errorf("validate Open Days holiday jurisdiction %s/%s: unsupported subdivision", country, subdivision)
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
				items = append(items, Holiday{Name: translatedHolidayName(value.Name, value.Languages, p.language), Date: date})
			}
		}
		for date, value := range p.provider.GetRegionalHolidays(year, []string{p.subdivision}) {
			if !date.Before(start) && !date.After(end) {
				items = append(items, Holiday{Name: translatedHolidayName(value.Name, value.Languages, p.language), Date: date})
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
	ID                     *uuid.UUID
	Name, Source, Category string
	StartsOn, EndsOn       time.Time
}
type CalendarContext struct {
	TimeZone, CountryCode, SubdivisionCode, LanguageCode string
	Entries                                              []CalendarEntry
	AcademicBreaks                                       []AcademicBreak
}

func (s *Service) CalendarContext(ctx context.Context, principal authorization.Principal, periodID uuid.UUID) (CalendarContext, error) {
	period, err := s.GetPeriod(ctx, principal, periodID)
	if err != nil {
		return CalendarContext{}, err
	}
	q := opendaysdb.New(s.pool)
	breaks, err := q.ListAcademicBreaksInRange(ctx, opendaysdb.ListAcademicBreaksInRangeParams{EndsOn: pgDate(period.EndsOn), StartsOn: pgDate(period.StartsOn)})
	if err != nil {
		return CalendarContext{}, err
	}
	holidays, err := s.holidays.Between(period.StartsOn, period.EndsOn)
	if err != nil {
		return CalendarContext{}, err
	}
	result := CalendarContext{TimeZone: s.location.String(), CountryCode: valueOr(s.cfg.HolidayCountry, "AT"), SubdivisionCode: valueOr(s.cfg.HolidaySubdivision, "AT-6"), LanguageCode: valueOr(s.cfg.HolidayLanguage, "de"), Entries: []CalendarEntry{}, AcademicBreaks: []AcademicBreak{}}
	for _, holiday := range holidays {
		date := dateOnly(holiday.Date)
		result.Entries = append(result.Entries, CalendarEntry{Name: holiday.Name, Source: "holidayLibrary", Category: "publicHoliday", StartsOn: date, EndsOn: date})
	}
	for _, row := range breaks {
		item := breakFromRow(row)
		result.AcademicBreaks = append(result.AcademicBreaks, item)
		id := item.ID
		result.Entries = append(result.Entries, CalendarEntry{ID: &id, Name: item.Name, Source: "manual", Category: "academicBreak", StartsOn: item.StartsOn, EndsOn: item.EndsOn})
	}
	return result, nil
}

func (s *Service) CreateAcademicBreak(ctx context.Context, p authorization.Principal, name string, start, end time.Time, requestID *uuid.UUID) (AcademicBreak, error) {
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
	id := uuid.Must(uuid.NewV7())
	row, err := opendaysdb.New(tx).CreateAcademicBreak(ctx, opendaysdb.CreateAcademicBreakParams{ID: id, Name: name, StartsOn: pgDate(start), EndsOn: pgDate(end)})
	if err != nil {
		return AcademicBreak{}, databaseError(err)
	}
	actor := p.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "open_day_academic_break.created", ResourceType: "open_day_academic_break", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "startsOn", "endsOn"}}); err != nil {
		return AcademicBreak{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcademicBreak{}, err
	}
	return breakFromRow(row), nil
}

func (s *Service) UpdateAcademicBreak(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, name string, start, end time.Time, requestID *uuid.UUID) (AcademicBreak, error) {
	if !p.Has(authorization.OpenDaysManage) {
		return AcademicBreak{}, apperror.PermissionDenied
	}
	if expected < 1 {
		return AcademicBreak{}, validation("expectedVersion must be positive")
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
	row, err := q.UpdateAcademicBreak(ctx, opendaysdb.UpdateAcademicBreakParams{Name: name, StartsOn: pgDate(start), EndsOn: pgDate(end), ID: id, ExpectedVersion: expected})
	if err != nil {
		return AcademicBreak{}, databaseError(err)
	}
	if err := writeAudit(ctx, tx, p, "open_day_academic_break.updated", "open_day_academic_break", id, requestID, []string{"name", "startsOn", "endsOn"}); err != nil {
		return AcademicBreak{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcademicBreak{}, err
	}
	return breakFromRow(row), nil
}

func (s *Service) DeleteAcademicBreak(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
	if !p.Has(authorization.OpenDaysManage) {
		return apperror.PermissionDenied
	}
	if expected < 1 {
		return validation("expectedVersion must be positive")
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
	if _, err := q.DeleteAcademicBreak(ctx, opendaysdb.DeleteAcademicBreakParams{ID: id, ExpectedVersion: expected}); err != nil {
		return databaseError(err)
	}
	if err := writeAudit(ctx, tx, p, "open_day_academic_break.deleted", "open_day_academic_break", id, requestID, nil); err != nil {
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
}
type RecurrenceOccurrence struct {
	Date, StartsAt, EndsAt time.Time
	Disposition, Reason    string
}

func (s *Service) PreviewRecurrence(ctx context.Context, p authorization.Principal, periodID uuid.UUID, input RecurrenceInput) ([]RecurrenceOccurrence, error) {
	if !p.Has(authorization.OpenDaysManage) {
		return nil, apperror.PermissionDenied
	}
	period, err := s.GetPeriod(ctx, p, periodID)
	if err != nil {
		return nil, err
	}
	if input.Weekday < 1 || input.Weekday > 7 || input.EveryWeeks < 1 || input.EveryWeeks > 52 || input.EndsOn.Before(input.StartsOn) {
		return nil, validation("recurrence range is invalid")
	}
	startClock, err := time.Parse("15:04", input.StartTime)
	if err != nil {
		return nil, validation("startTime is invalid")
	}
	endClock, err := time.Parse("15:04", input.EndTime)
	if err != nil {
		return nil, validation("endTime is invalid")
	}
	if !input.StartsOn.Equal(dateOnly(input.StartsOn)) || !dateWithin(input.StartsOn, period.StartsOn, period.EndsOn) || !dateWithin(input.EndsOn, period.StartsOn, period.EndsOn) {
		return nil, validation("recurrence must stay within the period")
	}
	q := opendaysdb.New(s.pool)
	days, err := q.ListOpenDaysByPeriod(ctx, periodID)
	if err != nil {
		return nil, err
	}
	breaks, err := q.ListAcademicBreaksInRange(ctx, opendaysdb.ListAcademicBreaksInRangeParams{EndsOn: pgDate(input.EndsOn), StartsOn: pgDate(input.StartsOn)})
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
	date := dateOnly(input.StartsOn)
	for int(date.Weekday()) != input.Weekday%7 {
		date = date.AddDate(0, 0, 1)
	}
	items := []RecurrenceOccurrence{}
	for !date.After(dateOnly(input.EndsOn)) {
		start, err := s.resolveWallTime(time.Date(date.Year(), date.Month(), date.Day(), startClock.Hour(), startClock.Minute(), 0, 0, time.UTC))
		if err != nil {
			return nil, err
		}
		endDate := date
		if !endClock.After(startClock) {
			endDate = endDate.AddDate(0, 0, 1)
		}
		end, err := s.resolveWallTime(time.Date(endDate.Year(), endDate.Month(), endDate.Day(), endClock.Hour(), endClock.Minute(), 0, 0, time.UTC))
		if err != nil {
			return nil, err
		}
		item := RecurrenceOccurrence{Date: date, StartsAt: start.UTC(), EndsAt: end.UTC(), Disposition: "create"}
		if name, ok := holidayDates[dateKey(date)]; ok && input.SkipPublicHolidays {
			item.Disposition = "publicHoliday"
			item.Reason = name
		}
		for _, b := range breaks {
			if dateWithin(date, b.StartsOn.Time, b.EndsOn.Time) && input.SkipAcademicBreaks {
				item.Disposition = "academicBreak"
				item.Reason = b.Name
				break
			}
		}
		for _, day := range days {
			if day.Status == "scheduled" && day.StartsAt.Equal(item.StartsAt) && day.EndsAt.Equal(item.EndsAt) {
				item.Disposition = "conflict"
				item.Reason = "An Open Day already uses this time range"
				break
			}
		}
		items = append(items, item)
		date = date.AddDate(0, 0, 7*input.EveryWeeks)
	}
	return items, nil
}

type PublicOpenDay struct {
	ID               uuid.UUID
	Title            string
	StartsAt, EndsAt time.Time
	Status           string
	UpdatedAt        time.Time
	Version          int64
}

func (s *Service) ListPublic(ctx context.Context) ([]PublicOpenDay, error) {
	rows, err := opendaysdb.New(s.pool).ListPublishedOpenDays(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]PublicOpenDay, 0, len(rows))
	for _, row := range rows {
		items = append(items, PublicOpenDay{ID: row.ID, Title: "Open Day", StartsAt: row.StartsAt, EndsAt: row.EndsAt, Status: row.Status, UpdatedAt: row.UpdatedAt, Version: row.Version})
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
	for _, item := range items {
		event := ical.NewEvent()
		event.Props.SetText(ical.PropUID, "urn:uuid:"+item.ID.String())
		event.Props.SetText(ical.PropSummary, item.Title)
		event.Props.SetDateTime(ical.PropDateTimeStart, item.StartsAt.UTC())
		event.Props.SetDateTime(ical.PropDateTimeEnd, item.EndsAt.UTC())
		event.Props.SetDateTime(ical.PropDateTimeStamp, item.UpdatedAt.UTC())
		event.Props.SetDateTime(ical.PropLastModified, item.UpdatedAt.UTC())
		event.Props.SetText(ical.PropSequence, strconv.FormatInt(item.Version, 10))
		if item.Status == "cancelled" {
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

func validateBreak(name string, start, end time.Time) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 150 {
		return "", validation("academic break name is invalid")
	}
	if start.IsZero() || end.IsZero() || end.Before(start) {
		return "", validation("academic break date range is invalid")
	}
	return name, nil
}
func breakFromRow(r opendaysdb.OpenDayAcademicBreak) AcademicBreak {
	return AcademicBreak{ID: r.ID, Name: r.Name, StartsOn: r.StartsOn.Time, EndsOn: r.EndsOn.Time, Version: r.Version, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
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
