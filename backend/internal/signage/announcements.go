package signage

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	maxAnnouncementDisplays = 100
	endedRetention          = 30 * 24 * time.Hour
)

// Announcement is a started instance of a template: live data that is never published.
type Announcement struct {
	ID, TemplateID uuid.UUID
	Values         map[string]string
	AllDisplays    bool
	DisplayIDs     []uuid.UUID
	StartsAt       time.Time
	EndsAt         *time.Time
	Status         AnnouncementState // scheduled | active
	Rendered       Rendered
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// AnnouncementInput is the writable part of an announcement. StartsAt nil means now (on start).
type AnnouncementInput struct {
	TemplateID  uuid.UUID // start only; an announcement keeps its template
	Values      map[string]string
	AllDisplays bool
	DisplayIDs  []uuid.UUID
	StartsAt    *time.Time
	EndsAt      *time.Time
}

// sweepExpired hard-deletes announcements that ended more than 30 days ago, so message content is
// not retained indefinitely. It runs when announcements are read.
func (s *Service) sweepExpired(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ids, err := signagedb.New(tx).DeleteExpiredSignageAnnouncements(ctx, s.now().Add(-endedRetention))
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	for index := range ids {
		if err := audit.Write(
			ctx,
			tx,
			audit.Event{
				ActorType:    "system",
				Source:       "system",
				Action:       "signage_announcement.expired",
				ResourceType: "signage_announcement",
				ResourceID:   &ids[index],
			},
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// announcementSweepInterval is the minimum time between two sweeps triggered by player traffic.
const announcementSweepInterval = 10 * time.Minute

// sweepExpiredThrottled runs sweepExpired at most once per announcementSweepInterval per process,
// so retention holds even when nobody opens the admin lists. Failures are not fatal for the caller.
func (s *Service) sweepExpiredThrottled(ctx context.Context) {
	now := s.now()
	s.sweepMu.Lock()
	if !s.lastAnnounceGC.IsZero() && now.Sub(s.lastAnnounceGC) < announcementSweepInterval &&
		!now.Before(s.lastAnnounceGC) {
		s.sweepMu.Unlock()
		return
	}
	s.lastAnnounceGC = now
	s.sweepMu.Unlock()
	_ = s.sweepExpired(ctx)
}

func (s *Service) statusOf(startsAt time.Time, now time.Time) AnnouncementState {
	if startsAt.After(now) {
		return AnnouncementScheduled
	}
	return AnnouncementActive
}

// hydrate loads values, targets, templates and machine names and renders the announcements.
func (s *Service) hydrate(
	ctx context.Context,
	q *signagedb.Queries,
	rows []signagedb.SignageAnnouncement,
) ([]Announcement, error) {
	return s.hydrateFor(ctx, q, rows, "{display}", "{location}")
}

// hydrateFor renders the announcements for one display; the admin views keep the display
// placeholders as typed because they do not depend on a showing display.
func (s *Service) hydrateFor(
	ctx context.Context,
	q *signagedb.Queries,
	rows []signagedb.SignageAnnouncement,
	displayName, location string,
) ([]Announcement, error) {
	if len(rows) == 0 {
		return []Announcement{}, nil
	}
	ids := make([]uuid.UUID, 0, len(rows))
	templateIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
		templateIDs = append(templateIDs, row.TemplateID)
	}
	templateIDs = distinct(templateIDs)
	templateRows, err := q.ListSignageTemplates(ctx)
	if err != nil {
		return nil, err
	}
	templates := map[uuid.UUID]signagedb.SignageAnnouncementTemplate{}
	for _, row := range templateRows {
		templates[row.ID] = row
	}
	fieldRows, err := q.ListSignageTemplateFields(ctx, uuidStrings(templateIDs))
	if err != nil {
		return nil, err
	}
	fields := fieldsByTemplate(fieldRows)
	valueRows, err := q.ListSignageAnnouncementValues(ctx, uuidStrings(ids))
	if err != nil {
		return nil, err
	}
	values := map[uuid.UUID]map[string]string{}
	for _, row := range valueRows {
		if values[row.AnnouncementID] == nil {
			values[row.AnnouncementID] = map[string]string{}
		}
		values[row.AnnouncementID][row.Key] = row.Value
	}
	displayRows, err := q.ListSignageAnnouncementDisplays(ctx, uuidStrings(ids))
	if err != nil {
		return nil, err
	}
	displays := map[uuid.UUID][]uuid.UUID{}
	for _, row := range displayRows {
		displays[row.AnnouncementID] = append(displays[row.AnnouncementID], row.DisplayID)
	}
	// Machine names for machine-type fields.
	var machineIDs []uuid.UUID
	for _, row := range rows {
		for _, field := range fields[row.TemplateID] {
			if field.Type != FieldMachine {
				continue
			}
			if id, err := uuid.Parse(values[row.ID][field.Key]); err == nil {
				machineIDs = append(machineIDs, id)
			}
		}
	}
	machineNames := map[string]string{}
	if machineIDs = distinct(machineIDs); len(machineIDs) > 0 {
		machines, err := q.ListSignageMachineNames(ctx, uuidStrings(machineIDs))
		if err != nil {
			return nil, err
		}
		for _, machine := range machines {
			machineNames[machine.ID.String()] = machine.Name
		}
	}
	now := s.now()
	result := make([]Announcement, 0, len(rows))
	for _, row := range rows {
		template := templates[row.TemplateID]
		announcementValues := values[row.ID]
		if announcementValues == nil {
			announcementValues = map[string]string{}
		}
		displayIDs := displays[row.ID]
		if displayIDs == nil {
			displayIDs = []uuid.UUID{}
		}
		endsAt := fromPgTime(row.EndsAt)
		rendered := RenderAnnouncement(
			RenderTemplate{
				Fields:     renderFields(fields[row.TemplateID]),
				Title:      template.Title,
				Body:       template.Body,
				BodyFormat: RichTextFormat(template.BodyFormat),
				BodyCSS:    template.BodyCss,
				Tone:       Tone(template.Tone),
			},
			announcementValues,
			RenderTiming{StartsAt: row.StartsAt, EndsAt: endsAt},
			RenderContext{
				Now:          now,
				TimeZone:     s.location,
				DisplayName:  displayName,
				Location:     location,
				MachineNames: machineNames,
			},
		)
		result = append(result, Announcement{
			ID:          row.ID,
			TemplateID:  row.TemplateID,
			Values:      announcementValues,
			AllDisplays: row.AllDisplays,
			DisplayIDs:  displayIDs,
			StartsAt:    row.StartsAt.UTC(), EndsAt: endsAt, Status: s.statusOf(row.StartsAt, now), Rendered: rendered,
			Version: row.Version, CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
		})
	}
	return result, nil
}

// ListAnnouncements returns active and scheduled announcements, soonest start first.
func (s *Service) ListAnnouncements(ctx context.Context, principal authorization.Principal) ([]Announcement, error) {
	if err := requireRead(principal); err != nil {
		return nil, err
	}
	if err := s.sweepExpired(ctx); err != nil {
		return nil, err
	}
	q := signagedb.New(s.pool)
	rows, err := q.ListLiveSignageAnnouncements(ctx, s.now())
	if err != nil {
		return nil, err
	}
	return s.hydrate(ctx, q, rows)
}

// GetAnnouncement reads one active or scheduled announcement; ended ones are hidden.
func (s *Service) GetAnnouncement(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
) (Announcement, error) {
	if err := requireRead(principal); err != nil {
		return Announcement{}, err
	}
	if err := s.sweepExpired(ctx); err != nil {
		return Announcement{}, err
	}
	return s.getLive(ctx, signagedb.New(s.pool), id)
}

func (s *Service) getLive(ctx context.Context, q *signagedb.Queries, id uuid.UUID) (Announcement, error) {
	row, err := q.GetSignageAnnouncement(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Announcement{}, apperror.NotFound
	}
	if err != nil {
		return Announcement{}, err
	}
	if ended := fromPgTime(row.EndsAt); ended != nil && !ended.After(s.now()) {
		return Announcement{}, apperror.NotFound
	}
	items, err := s.hydrate(ctx, q, []signagedb.SignageAnnouncement{row})
	if err != nil {
		return Announcement{}, err
	}
	return items[0], nil
}

// normalizeValues applies defaults, rejects unknown keys and validates every value by field type.
// Empty optional values are not stored.
func normalizeValues(fields []TemplateField, given map[string]string) (map[string]string, error) {
	known := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		known[field.Key] = struct{}{}
	}
	for key := range given {
		if _, ok := known[key]; !ok {
			return nil, validation("value %q is not a field of this template", key)
		}
	}
	values := map[string]string{}
	for _, field := range fields {
		value, present := given[field.Key]
		if !present {
			value = field.DefaultValue
		}
		if value == "" {
			if field.Required {
				return nil, validation("%s is required", field.Label)
			}
			continue
		}
		if err := ValidateFieldValue(field, value); err != nil {
			return nil, err
		}
		values[field.Key] = value
	}
	return values, nil
}

func (s *Service) validateTargets(
	ctx context.Context,
	q *signagedb.Queries,
	input AnnouncementInput,
) ([]uuid.UUID, error) {
	if input.AllDisplays {
		if len(input.DisplayIDs) > 0 {
			return nil, validation("displayIds must be empty when the announcement targets all displays")
		}
		return []uuid.UUID{}, nil
	}
	ids := distinct(input.DisplayIDs)
	if len(ids) == 0 {
		return nil, validation("select at least one display or target all displays")
	}
	if len(ids) > maxAnnouncementDisplays {
		return nil, validation("an announcement targets at most %d displays", maxAnnouncementDisplays)
	}
	found, err := q.ListSignageDisplayIDs(ctx, uuidStrings(ids))
	if err != nil {
		return nil, err
	}
	if len(found) != len(ids) {
		return nil, validation("a selected display does not exist")
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	return ids, nil
}

func (s *Service) validateWindow(input AnnouncementInput, now time.Time) (time.Time, *time.Time, error) {
	startsAt := now
	if input.StartsAt != nil {
		startsAt = input.StartsAt.UTC()
	}
	var endsAt *time.Time
	if input.EndsAt != nil {
		ends := input.EndsAt.UTC()
		endsAt = &ends
		if !ends.After(startsAt) || !ends.After(now) {
			return time.Time{}, nil, validation("endsAt must be after the start and in the future")
		}
	}
	return startsAt, endsAt, nil
}

func writeValuesAndTargets(
	ctx context.Context,
	q *signagedb.Queries,
	id uuid.UUID,
	values map[string]string,
	displayIDs []uuid.UUID,
) error {
	if err := q.DeleteSignageAnnouncementValues(ctx, id); err != nil {
		return err
	}
	if err := q.DeleteSignageAnnouncementDisplays(ctx, id); err != nil {
		return err
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := q.InsertSignageAnnouncementValue(
			ctx,
			signagedb.InsertSignageAnnouncementValueParams{AnnouncementID: id, Key: key, Value: values[key]},
		); err != nil {
			return databaseError(err)
		}
	}
	for _, displayID := range displayIDs {
		if err := q.InsertSignageAnnouncementDisplay(
			ctx,
			signagedb.InsertSignageAnnouncementDisplayParams{AnnouncementID: id, DisplayID: displayID},
		); err != nil {
			return databaseError(err)
		}
	}
	return nil
}

// StartAnnouncement starts (or schedules, when StartsAt is in the future) an announcement.
func (s *Service) StartAnnouncement(
	ctx context.Context,
	principal authorization.Principal,
	input AnnouncementInput,
	requestID *uuid.UUID,
) (Announcement, error) {
	if err := requireOverride(principal); err != nil {
		return Announcement{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Announcement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	template, err := s.getTemplate(ctx, q, input.TemplateID)
	if errors.Is(err, apperror.NotFound) {
		return Announcement{}, validation("the announcement template does not exist")
	}
	if err != nil {
		return Announcement{}, err
	}
	values, err := normalizeValues(template.Fields, input.Values)
	if err != nil {
		return Announcement{}, err
	}
	displayIDs, err := s.validateTargets(ctx, q, input)
	if err != nil {
		return Announcement{}, err
	}
	startsAt, endsAt, err := s.validateWindow(input, s.now())
	if err != nil {
		return Announcement{}, err
	}
	if err := s.verifyMachineValues(ctx, q, template.Fields, values); err != nil {
		return Announcement{}, err
	}
	id := ids.New()
	actor := principal.AccountID
	row, err := q.CreateSignageAnnouncement(ctx, signagedb.CreateSignageAnnouncementParams{
		ID:                 id,
		TemplateID:         template.ID,
		AllDisplays:        input.AllDisplays,
		StartsAt:           startsAt,
		EndsAt:             pgTime(endsAt),
		CreatedByAccountID: &actor,
	})
	if err != nil {
		return Announcement{}, databaseError(err)
	}
	if err := writeValuesAndTargets(ctx, q, id, values, displayIDs); err != nil {
		return Announcement{}, err
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_announcement.started",
		"signage_announcement",
		id,
		requestID,
		[]string{"template", "values", "displays", "startsAt", "endsAt"},
	); err != nil {
		return Announcement{}, err
	}
	items, err := s.hydrate(ctx, q, []signagedb.SignageAnnouncement{row})
	if err != nil {
		return Announcement{}, err
	}
	return items[0], tx.Commit(ctx)
}

// verifyMachineValues checks that machine-typed values name existing machines.
func (s *Service) verifyMachineValues(
	ctx context.Context,
	q *signagedb.Queries,
	fields []TemplateField,
	values map[string]string,
) error {
	var ids []uuid.UUID
	for _, field := range fields {
		if field.Type == FieldMachine && values[field.Key] != "" {
			id, _ := uuid.Parse(values[field.Key])
			ids = append(ids, id)
		}
	}
	if ids = distinct(ids); len(ids) == 0 {
		return nil
	}
	found, err := q.ListSignageMachineNames(ctx, uuidStrings(ids))
	if err != nil {
		return err
	}
	if len(found) != len(ids) {
		return validation("a selected machine does not exist")
	}
	return nil
}

// UpdateAnnouncement edits values, targets and window of an active or scheduled announcement.
func (s *Service) UpdateAnnouncement(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	input AnnouncementInput,
	requestID *uuid.UUID,
) (Announcement, error) {
	if err := requireOverride(principal); err != nil {
		return Announcement{}, err
	}
	if err := requireExpected(expected); err != nil {
		return Announcement{}, err
	}
	if input.StartsAt == nil {
		return Announcement{}, validation("startsAt is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Announcement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, err := q.GetSignageAnnouncementForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Announcement{}, apperror.NotFound
	}
	if err != nil {
		return Announcement{}, err
	}
	now := s.now()
	if ended := fromPgTime(current.EndsAt); ended != nil && !ended.After(now) {
		return Announcement{}, apperror.NotFound
	}
	if current.Version != expected {
		return Announcement{}, apperror.StaleWrite
	}
	template, err := s.getTemplate(ctx, q, current.TemplateID)
	if err != nil {
		return Announcement{}, err
	}
	values, err := normalizeValues(template.Fields, input.Values)
	if err != nil {
		return Announcement{}, err
	}
	displayIDs, err := s.validateTargets(ctx, q, input)
	if err != nil {
		return Announcement{}, err
	}
	startsAt, endsAt, err := s.validateWindow(input, now)
	if err != nil {
		return Announcement{}, err
	}
	if err := s.verifyMachineValues(ctx, q, template.Fields, values); err != nil {
		return Announcement{}, err
	}
	row, err := q.UpdateSignageAnnouncement(ctx, signagedb.UpdateSignageAnnouncementParams{
		AllDisplays: input.AllDisplays, StartsAt: startsAt, EndsAt: pgTime(endsAt), ID: id, ExpectedVersion: expected,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Announcement{}, apperror.StaleWrite
	}
	if err != nil {
		return Announcement{}, databaseError(err)
	}
	if err := writeValuesAndTargets(ctx, q, id, values, displayIDs); err != nil {
		return Announcement{}, err
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_announcement.updated",
		"signage_announcement",
		id,
		requestID,
		[]string{"values", "displays", "startsAt", "endsAt"},
	); err != nil {
		return Announcement{}, err
	}
	items, err := s.hydrate(ctx, q, []signagedb.SignageAnnouncement{row})
	if err != nil {
		return Announcement{}, err
	}
	return items[0], tx.Commit(ctx)
}

// StopAnnouncement stops an announcement by hard-deleting it and its values.
func (s *Service) StopAnnouncement(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := requireOverride(principal); err != nil {
		return err
	}
	if err := requireExpected(expected); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, err := q.GetSignageAnnouncementForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	if _, err := q.DeleteSignageAnnouncement(
		ctx,
		signagedb.DeleteSignageAnnouncementParams{ID: id, ExpectedVersion: expected},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_announcement.stopped",
		"signage_announcement",
		id,
		requestID,
		nil,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
