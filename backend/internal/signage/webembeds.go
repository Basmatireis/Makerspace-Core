package signage

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Limits of a web embed; the database checks the same bounds.
const (
	MaxEmbedOrigins        = 20
	MaxEmbedOriginLength   = 300
	MaxEmbedCameraMachines = 20
	MaxEmbedCameraViewers  = 20
	MaxEmbedTimelapseCount = 20
	MaxEmbedTimelapseDays  = 90

	// embedKeyBytes random bytes make a 32-character base64url key.
	embedKeyBytes = 24

	webEmbedResource = "signage_web_embed"
)

// embedOriginPattern accepts an origin https://host[:port] with a lower-case DNS name or IPv4 host. Nothing else may
// reach the frame-ancestors header the web server builds from it: no path, query, fragment, wildcard, whitespace,
// quote or semicolon.
var embedOriginPattern = regexp.MustCompile(
	`^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$`,
)

// WebEmbed is a signage screen that other websites show in an iframe: a display without a device, with the websites
// that may frame it and the media it may show.
type WebEmbed struct {
	ID                  uuid.UUID
	Name                string
	AspectRatio         AspectRatio
	GroupID             *uuid.UUID
	DefaultScenes       []SceneListItem
	EmbedKey            string
	AllowedOrigins      []string
	OpenDirectly        bool
	Enabled             bool
	CameraEnabled       bool
	CameraMachineIDs    []uuid.UUID
	CameraViewerLimit   int
	TimelapseEnabled    bool
	TimelapseCount      int
	TimelapseMaxAgeDays int
	PublishedRevision   *int
	PublishedAt         *time.Time
	PendingChanges      []PendingChange
	LastLoadedAt        *time.Time
	LoadsToday          int
	Version             int64
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// HasUnpublishedChanges reports whether the websites do not show the drafts yet.
func (e WebEmbed) HasUnpublishedChanges() bool {
	return e.PublishedRevision == nil || len(e.PendingChanges) > 0
}

// WebEmbedInput creates a web embed.
type WebEmbedInput struct {
	Name           string
	AspectRatio    AspectRatio
	AllowedOrigins []string
	GroupID        *uuid.UUID
	DefaultScenes  []SceneListItem
}

// WebEmbedPatch changes a web embed; nil fields stay unchanged. GroupSet tells an omitted group (unchanged) from a
// null one (leave the group).
type WebEmbedPatch struct {
	Name                *string
	AspectRatio         *AspectRatio
	GroupSet            bool
	GroupID             *uuid.UUID
	DefaultScenes       *[]SceneListItem
	AllowedOrigins      *[]string
	OpenDirectly        *bool
	Enabled             *bool
	CameraEnabled       *bool
	CameraMachineIDs    *[]uuid.UUID
	CameraViewerLimit   *int
	TimelapseEnabled    *bool
	TimelapseCount      *int
	TimelapseMaxAgeDays *int
}

// embedSwitches are a web embed's current media switches. The public endpoints combine them with the switches its
// latest publication recorded, so switching a medium off takes effect at once and switching it on with a publication.
type embedSwitches struct {
	camera              bool
	cameraMachineIDs    []uuid.UUID
	timelapses          bool
	timelapseCount      int
	timelapseMaxAgeDays int
}

func embedSwitchesOf(
	camera bool,
	machineIDs []string,
	timelapses bool,
	count, maxAgeDays int16,
) (embedSwitches, error) {
	machines, err := parseUUIDs(machineIDs)
	if err != nil {
		return embedSwitches{}, err
	}
	return embedSwitches{
		camera: camera, cameraMachineIDs: machines, timelapses: timelapses,
		timelapseCount: int(count), timelapseMaxAgeDays: int(maxAgeDays),
	}, nil
}

// camerasFor returns the machines whose camera the embed may show with this publication: those chosen now and when it
// was published, while the camera is switched on now and was then.
func (e *embedSwitches) camerasFor(manifest Manifest) ([]uuid.UUID, bool) {
	published := manifest.EmbedMedia
	if published == nil || !published.Camera || !e.camera {
		return nil, false
	}
	machines := make([]uuid.UUID, 0, len(e.cameraMachineIDs))
	for _, id := range e.cameraMachineIDs {
		if slices.Contains(published.CameraMachineIDs, id) {
			machines = append(machines, id)
		}
	}
	return machines, len(machines) > 0
}

// timelapsesFor reports whether the embed may show timelapses with this publication and the caps that apply.
func (e *embedSwitches) timelapsesFor(manifest Manifest) (bool, timelapseCaps) {
	published := manifest.EmbedMedia
	if published == nil || !published.Timelapses || !e.timelapses {
		return false, timelapseCaps{}
	}
	return true, timelapseCaps{count: e.timelapseCount, maxAgeDays: e.timelapseMaxAgeDays}
}

func parseUUIDs(texts []string) ([]uuid.UUID, error) {
	result := make([]uuid.UUID, 0, len(texts))
	for _, text := range texts {
		id, err := uuid.Parse(text)
		if err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, nil
}

// embedMediaOf returns the current media switches of the web embeds among ids, as a publication records them.
func embedMediaOf(
	ctx context.Context,
	q *signagedb.Queries,
	displayIDs []uuid.UUID,
) (map[uuid.UUID]*ManifestEmbedMedia, error) {
	result := map[uuid.UUID]*ManifestEmbedMedia{}
	if len(displayIDs) == 0 {
		// The query lists every embed for an empty id list.
		return result, nil
	}
	rows, err := q.ListSignageWebEmbeds(ctx, uuidStrings(displayIDs))
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		machines, err := parseUUIDs(row.CameraMachineIds)
		if err != nil {
			return nil, err
		}
		slices.SortFunc(machines, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
		result[row.DisplayID] = &ManifestEmbedMedia{
			Camera: row.CameraEnabled, CameraMachineIDs: machines, Timelapses: row.TimelapseEnabled,
		}
	}
	return result, nil
}

// embedMemberIDs lists the web embeds among a group's members.
func embedMemberIDs(members []signagedb.ListSignageGroupMembersRow) []uuid.UUID {
	var result []uuid.UUID
	for _, member := range members {
		if DisplayKind(member.Kind) == DisplayKindWebEmbed {
			result = append(result, member.ID)
		}
	}
	return result
}

// newEmbedKey draws a new embed key from the CSPRNG.
func newEmbedKey() (string, error) {
	raw := make([]byte, embedKeyBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// CleanEmbedOrigins validates and normalises the websites that may frame an embed: 1 to MaxEmbedOrigins origins
// https://host[:port], lower-cased, duplicates removed, in the given order.
func CleanEmbedOrigins(origins []string) ([]string, error) {
	if len(origins) == 0 {
		return nil, validation("allowedOrigins must list at least one website; the last one cannot be removed")
	}
	cleaned := make([]string, 0, len(origins))
	for _, origin := range origins {
		value := strings.ToLower(strings.TrimSpace(origin))
		if len(value) > MaxEmbedOriginLength || !embedOriginPattern.MatchString(value) {
			return nil, validation(
				"allowedOrigins must be origins like https://www.example.org (https, a host name and an optional " +
					"port; no path, query or wildcard)",
			)
		}
		if _, port, found := strings.Cut(strings.TrimPrefix(value, "https://"), ":"); found {
			if number, err := strconv.Atoi(port); err != nil || number < 1 || number > 65535 {
				return nil, validation("allowedOrigins has a port outside 1 to 65535")
			}
		}
		if !slices.Contains(cleaned, value) {
			cleaned = append(cleaned, value)
		}
	}
	if len(cleaned) > MaxEmbedOrigins {
		return nil, validation("allowedOrigins lists at most %d websites", MaxEmbedOrigins)
	}
	return cleaned, nil
}

func requireEmbedRange(value int, field string, low, high int) error {
	if value < low || value > high {
		return validation("%s must be between %d and %d", field, low, high)
	}
	return nil
}

// checkEmbedCameraMachines removes duplicates and checks that the machines exist.
func checkEmbedCameraMachines(ctx context.Context, q *signagedb.Queries, machineIDs []uuid.UUID) ([]uuid.UUID, error) {
	machines := distinct(machineIDs)
	if len(machines) > MaxEmbedCameraMachines {
		return nil, validation("cameraMachineIds lists at most %d machines", MaxEmbedCameraMachines)
	}
	if len(machines) == 0 {
		return []uuid.UUID{}, nil
	}
	found, err := q.ListSignageMachineNames(ctx, uuidStrings(machines))
	if err != nil {
		return nil, err
	}
	if len(found) != len(machines) {
		return nil, validation("a selected camera machine does not exist")
	}
	return machines, nil
}

// webEmbedFrom joins a display view of kind web_embed with its embed row.
func webEmbedFrom(
	display Display,
	row signagedb.ListSignageWebEmbedsRow,
	today time.Time,
	unwritten embedLoads,
) (WebEmbed, error) {
	machines, err := parseUUIDs(row.CameraMachineIds)
	if err != nil {
		return WebEmbed{}, err
	}
	embed := WebEmbed{
		ID:                  display.ID,
		Name:                display.Name,
		AspectRatio:         display.AspectRatio,
		GroupID:             display.GroupID,
		DefaultScenes:       display.DefaultScenes,
		EmbedKey:            row.EmbedKey,
		AllowedOrigins:      row.AllowedOrigins,
		OpenDirectly:        row.OpenDirectly,
		Enabled:             row.Enabled,
		CameraEnabled:       row.CameraEnabled,
		CameraMachineIDs:    machines,
		CameraViewerLimit:   int(row.CameraViewerLimit),
		TimelapseEnabled:    row.TimelapseEnabled,
		TimelapseCount:      int(row.TimelapseCount),
		TimelapseMaxAgeDays: int(row.TimelapseMaxAgeDays),
		PublishedRevision:   display.PublishedRevision,
		PublishedAt:         display.PublishedAt,
		PendingChanges:      display.PendingChanges,
		LastLoadedAt:        fromPgTime(row.LastLoadedAt),
		Version:             display.Version,
		CreatedAt:           display.CreatedAt,
		UpdatedAt:           display.UpdatedAt,
	}
	if row.LoadsDay.Valid && row.LoadsDay.Time.Equal(utcDate(today)) {
		embed.LoadsToday = int(row.LoadsCount)
	}
	// Loads counted in memory but not written yet.
	embed.LoadsToday += unwritten.count
	if unwritten.count > 0 && (embed.LastLoadedAt == nil || unwritten.last.After(*embed.LastLoadedAt)) {
		last := unwritten.last.UTC()
		embed.LastLoadedAt = &last
	}
	return embed, nil
}

// utcDate is the UTC calendar day of an instant, as midnight UTC.
func utcDate(moment time.Time) time.Time {
	year, month, day := moment.UTC().Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

func (s *Service) loadWebEmbeds(ctx context.Context, q *signagedb.Queries, views []viewRow) ([]WebEmbed, error) {
	displays, err := s.loadDisplays(ctx, q, views)
	if err != nil || len(displays) == 0 {
		return []WebEmbed{}, err
	}
	ids := make([]uuid.UUID, 0, len(displays))
	for _, display := range displays {
		ids = append(ids, display.ID)
	}
	rows, err := q.ListSignageWebEmbeds(ctx, uuidStrings(ids))
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]signagedb.ListSignageWebEmbedsRow, len(rows))
	for _, row := range rows {
		byID[row.DisplayID] = row
	}
	today := s.now()
	embeds := make([]WebEmbed, 0, len(displays))
	for _, display := range displays {
		row, ok := byID[display.ID]
		if !ok {
			continue
		}
		embed, err := webEmbedFrom(display, row, today, s.embedLoads.today(display.ID, today))
		if err != nil {
			return nil, err
		}
		embeds = append(embeds, embed)
	}
	return embeds, nil
}

// ListWebEmbeds returns all web embeds by name.
func (s *Service) ListWebEmbeds(ctx context.Context, principal authorization.Principal) ([]WebEmbed, error) {
	if err := requireRead(principal); err != nil {
		return nil, err
	}
	q := signagedb.New(s.pool)
	rows, err := q.ListSignageDisplayViews(ctx, string(DisplayKindWebEmbed))
	if err != nil {
		return nil, err
	}
	views := make([]viewRow, 0, len(rows))
	for _, row := range rows {
		views = append(views, viewFromList(row))
	}
	return s.loadWebEmbeds(ctx, q, views)
}

// GetWebEmbed reads one web embed.
func (s *Service) GetWebEmbed(ctx context.Context, principal authorization.Principal, id uuid.UUID) (WebEmbed, error) {
	if err := requireRead(principal); err != nil {
		return WebEmbed{}, err
	}
	return s.getWebEmbed(ctx, signagedb.New(s.pool), id)
}

func (s *Service) getWebEmbed(ctx context.Context, q *signagedb.Queries, id uuid.UUID) (WebEmbed, error) {
	row, err := q.GetSignageDisplayView(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && DisplayKind(row.Kind) != DisplayKindWebEmbed) {
		return WebEmbed{}, apperror.NotFound
	}
	if err != nil {
		return WebEmbed{}, err
	}
	embeds, err := s.loadWebEmbeds(ctx, q, []viewRow{{row}})
	if err != nil {
		return WebEmbed{}, err
	}
	if len(embeds) != 1 {
		return WebEmbed{}, apperror.NotFound
	}
	return embeds[0], nil
}

// embedDisplayInput is the display part of a web embed: no location, always treated as visible from outside.
func embedDisplayInput(name string, ratio AspectRatio, groupID *uuid.UUID, defaults []SceneListItem) DisplayInput {
	return DisplayInput{
		Name: name, AspectRatio: ratio, VisibleFromOutside: true, GroupID: groupID, DefaultScenes: defaults,
	}
}

// CreateWebEmbed creates a web embed with a new embed key, switched on, without cameras and timelapses.
func (s *Service) CreateWebEmbed(
	ctx context.Context,
	principal authorization.Principal,
	input WebEmbedInput,
	requestID *uuid.UUID,
) (WebEmbed, error) {
	if err := requireManage(principal); err != nil {
		return WebEmbed{}, err
	}
	checked, err := validateDisplayInput(
		embedDisplayInput(input.Name, input.AspectRatio, input.GroupID, input.DefaultScenes),
	)
	if err != nil {
		return WebEmbed{}, err
	}
	if checked.GroupID == nil && len(checked.DefaultScenes) == 0 {
		return WebEmbed{}, defaultScenesRequired()
	}
	origins, err := CleanEmbedOrigins(input.AllowedOrigins)
	if err != nil {
		return WebEmbed{}, err
	}
	key, err := newEmbedKey()
	if err != nil {
		return WebEmbed{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WebEmbed{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if checked.GroupID != nil {
		if err := lockJoinedGroup(ctx, q, *checked.GroupID, checked.AspectRatio, false); err != nil {
			return WebEmbed{}, err
		}
	} else if err := verifySceneList(ctx, q, checked.AspectRatio, checked.DefaultScenes, "defaultScenes"); err != nil {
		return WebEmbed{}, err
	}
	id := ids.New()
	if _, err := q.CreateSignageDisplay(ctx, signagedb.CreateSignageDisplayParams{
		ID:                 id,
		Kind:               string(DisplayKindWebEmbed),
		Name:               checked.Name,
		AspectWidth:        int16(checked.AspectRatio.Width),
		AspectHeight:       int16(checked.AspectRatio.Height),
		VisibleFromOutside: true,
		GroupID:            checked.GroupID,
	}); err != nil {
		return WebEmbed{}, databaseError(err)
	}
	if err := q.CreateSignageWebEmbed(ctx, signagedb.CreateSignageWebEmbedParams{
		DisplayID: id, EmbedKey: key, AllowedOrigins: origins,
	}); err != nil {
		return WebEmbed{}, databaseError(err)
	}
	if err := replaceDefaultScenes(ctx, q, ruleOwner{DisplayID: id}, checked.DefaultScenes); err != nil {
		return WebEmbed{}, err
	}
	fields := []string{"name", "aspectRatio", "allowedOrigins", "defaultScenes"}
	if checked.GroupID != nil {
		fields = []string{"name", "aspectRatio", "allowedOrigins", "groupId"}
	}
	if err := writeAudit(ctx, tx, principal, "signage_web_embed.created", webEmbedResource, id, requestID,
		fields); err != nil {
		return WebEmbed{}, err
	}
	result, err := s.getWebEmbed(ctx, q, id)
	if err != nil {
		return WebEmbed{}, err
	}
	return result, tx.Commit(ctx)
}

// embedSettings is the writable state of a signage_web_embeds row.
type embedSettings struct {
	origins           []string
	openDirectly      bool
	enabled           bool
	camera            bool
	cameraMachines    []uuid.UUID
	viewerLimit       int
	timelapses        bool
	timelapseCount    int
	timelapseMaxDays  int
	changedFieldNames []string
}

// applyEmbedPatch merges the patch into the current settings and validates the result. It records the names of the
// fields that change; the audit event carries only those names, never values.
func applyEmbedPatch(
	ctx context.Context,
	q *signagedb.Queries,
	current signagedb.ListSignageWebEmbedsRow,
	patch WebEmbedPatch,
) (embedSettings, error) {
	currentMachines, err := parseUUIDs(current.CameraMachineIds)
	if err != nil {
		return embedSettings{}, err
	}
	next := embedSettings{
		origins: current.AllowedOrigins, openDirectly: current.OpenDirectly, enabled: current.Enabled,
		camera: current.CameraEnabled, cameraMachines: currentMachines, viewerLimit: int(current.CameraViewerLimit),
		timelapses: current.TimelapseEnabled, timelapseCount: int(current.TimelapseCount),
		timelapseMaxDays: int(current.TimelapseMaxAgeDays),
	}
	changed := func(field string, differs bool) {
		if differs {
			next.changedFieldNames = append(next.changedFieldNames, field)
		}
	}
	if patch.AllowedOrigins != nil {
		origins, err := CleanEmbedOrigins(*patch.AllowedOrigins)
		if err != nil {
			return embedSettings{}, err
		}
		changed("allowedOrigins", !slices.Equal(origins, next.origins))
		next.origins = origins
	}
	if patch.OpenDirectly != nil {
		changed("openDirectly", *patch.OpenDirectly != next.openDirectly)
		next.openDirectly = *patch.OpenDirectly
	}
	if patch.Enabled != nil {
		changed("enabled", *patch.Enabled != next.enabled)
		next.enabled = *patch.Enabled
	}
	if patch.CameraEnabled != nil {
		changed("cameraEnabled", *patch.CameraEnabled != next.camera)
		next.camera = *patch.CameraEnabled
	}
	if patch.CameraMachineIDs != nil {
		machines, err := checkEmbedCameraMachines(ctx, q, *patch.CameraMachineIDs)
		if err != nil {
			return embedSettings{}, err
		}
		changed("cameraMachineIds", !sameIDSet(machines, next.cameraMachines))
		next.cameraMachines = machines
	}
	if patch.CameraViewerLimit != nil {
		if err := requireEmbedRange(*patch.CameraViewerLimit, "cameraViewerLimit", 1, MaxEmbedCameraViewers); err != nil {
			return embedSettings{}, err
		}
		changed("cameraViewerLimit", *patch.CameraViewerLimit != next.viewerLimit)
		next.viewerLimit = *patch.CameraViewerLimit
	}
	if patch.TimelapseEnabled != nil {
		changed("timelapseEnabled", *patch.TimelapseEnabled != next.timelapses)
		next.timelapses = *patch.TimelapseEnabled
	}
	if patch.TimelapseCount != nil {
		if err := requireEmbedRange(*patch.TimelapseCount, "timelapseCount", 1, MaxEmbedTimelapseCount); err != nil {
			return embedSettings{}, err
		}
		changed("timelapseCount", *patch.TimelapseCount != next.timelapseCount)
		next.timelapseCount = *patch.TimelapseCount
	}
	if patch.TimelapseMaxAgeDays != nil {
		if err := requireEmbedRange(
			*patch.TimelapseMaxAgeDays, "timelapseMaxAgeDays", 1, MaxEmbedTimelapseDays,
		); err != nil {
			return embedSettings{}, err
		}
		changed("timelapseMaxAgeDays", *patch.TimelapseMaxAgeDays != next.timelapseMaxDays)
		next.timelapseMaxDays = *patch.TimelapseMaxAgeDays
	}
	return next, nil
}

func sameIDSet(a, b []uuid.UUID) bool {
	if len(a) != len(b) {
		return false
	}
	for _, id := range a {
		if !slices.Contains(b, id) {
			return false
		}
	}
	return true
}

// lockWebEmbed locks a web embed's display row, checks the expected version and reads its embed row.
func lockWebEmbed(
	ctx context.Context,
	q *signagedb.Queries,
	id uuid.UUID,
	expected int64,
) (signagedb.GetSignageDisplayForUpdateRow, signagedb.ListSignageWebEmbedsRow, error) {
	current, err := lockDisplayOfKind(ctx, q, id, DisplayKindWebEmbed)
	if err != nil {
		return current, signagedb.ListSignageWebEmbedsRow{}, err
	}
	if current.Version != expected {
		return current, signagedb.ListSignageWebEmbedsRow{}, apperror.StaleWrite
	}
	rows, err := q.ListSignageWebEmbeds(ctx, []string{id.String()})
	if err != nil {
		return current, signagedb.ListSignageWebEmbedsRow{}, err
	}
	if len(rows) != 1 {
		return current, signagedb.ListSignageWebEmbedsRow{}, apperror.NotFound
	}
	return current, rows[0], nil
}

// UpdateWebEmbed changes a web embed. Name, aspect ratio, group and default scenes are drafts as for displays; the
// embed settings apply at once (switching a medium on still needs a publication, see embedSwitches).
func (s *Service) UpdateWebEmbed(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	patch WebEmbedPatch,
	requestID *uuid.UUID,
) (WebEmbed, error) {
	if err := requireManage(principal); err != nil {
		return WebEmbed{}, err
	}
	if err := requireExpected(expected); err != nil {
		return WebEmbed{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WebEmbed{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, embedRow, err := lockWebEmbed(ctx, q, id, expected)
	if err != nil {
		return WebEmbed{}, err
	}
	input, err := mergeEmbedDraft(current, patch)
	if err != nil {
		return WebEmbed{}, err
	}
	checked, err := validateDisplayInput(input)
	if err != nil {
		return WebEmbed{}, err
	}
	settings, err := applyEmbedPatch(ctx, q, embedRow, patch)
	if err != nil {
		return WebEmbed{}, err
	}
	changed, err := applyDisplayDraft(ctx, q, current, checked)
	if err != nil {
		return WebEmbed{}, err
	}
	if err := q.UpdateSignageWebEmbed(ctx, signagedb.UpdateSignageWebEmbedParams{
		AllowedOrigins:      settings.origins,
		OpenDirectly:        settings.openDirectly,
		Enabled:             settings.enabled,
		CameraEnabled:       settings.camera,
		CameraMachineIds:    uuidStrings(settings.cameraMachines),
		CameraViewerLimit:   int16(settings.viewerLimit),
		TimelapseEnabled:    settings.timelapses,
		TimelapseCount:      int16(settings.timelapseCount),
		TimelapseMaxAgeDays: int16(settings.timelapseMaxDays),
		DisplayID:           id,
	}); err != nil {
		return WebEmbed{}, databaseError(err)
	}
	changed = append(changed, settings.changedFieldNames...)
	if err := writeAudit(ctx, tx, principal, "signage_web_embed.updated", webEmbedResource, id, requestID,
		changed); err != nil {
		return WebEmbed{}, err
	}
	result, err := s.getWebEmbed(ctx, q, id)
	if err != nil {
		return WebEmbed{}, err
	}
	return result, tx.Commit(ctx)
}

// mergeEmbedDraft turns a patch into the full draft input of the embed's display. Without defaultScenes the embed
// keeps its own list, takes none when it joins a group and a copy of the group's when it leaves one.
func mergeEmbedDraft(current signagedb.GetSignageDisplayForUpdateRow, patch WebEmbedPatch) (DisplayInput, error) {
	name := current.Name
	if patch.Name != nil {
		name = *patch.Name
	}
	ratio := aspectRatioOf(current.AspectWidth, current.AspectHeight)
	if patch.AspectRatio != nil {
		ratio = *patch.AspectRatio
	}
	groupID := current.GroupID
	if patch.GroupSet {
		groupID = patch.GroupID
	}
	var defaults []SceneListItem
	switch {
	case patch.DefaultScenes != nil:
		defaults = *patch.DefaultScenes
	case groupID == nil && current.GroupID == nil:
		own, err := decodeSceneList(current.DefaultScenes)
		if err != nil {
			return DisplayInput{}, err
		}
		defaults = own
	}
	return embedDisplayInput(name, ratio, groupID, defaults), nil
}

// RotateWebEmbedKey gives the embed a new key; the old embed code stops working at once. The audit event records
// that the key changed, never a key.
func (s *Service) RotateWebEmbedKey(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (WebEmbed, error) {
	if err := requireManage(principal); err != nil {
		return WebEmbed{}, err
	}
	if err := requireExpected(expected); err != nil {
		return WebEmbed{}, err
	}
	key, err := newEmbedKey()
	if err != nil {
		return WebEmbed{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WebEmbed{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if _, _, err := lockWebEmbed(ctx, q, id, expected); err != nil {
		return WebEmbed{}, err
	}
	if err := q.SetSignageWebEmbedKey(ctx, signagedb.SetSignageWebEmbedKeyParams{
		EmbedKey: key, DisplayID: id,
	}); err != nil {
		return WebEmbed{}, databaseError(err)
	}
	if _, err := q.BumpSignageDisplayVersion(ctx, signagedb.BumpSignageDisplayVersionParams{
		ID: id, ExpectedVersion: expected,
	}); errors.Is(err, pgx.ErrNoRows) {
		return WebEmbed{}, apperror.StaleWrite
	} else if err != nil {
		return WebEmbed{}, err
	}
	if err := writeAudit(ctx, tx, principal, "signage_web_embed.key_rotated", webEmbedResource, id, requestID,
		[]string{"embedKey"}); err != nil {
		return WebEmbed{}, err
	}
	result, err := s.getWebEmbed(ctx, q, id)
	if err != nil {
		return WebEmbed{}, err
	}
	return result, tx.Commit(ctx)
}

// DeleteWebEmbed hard-deletes a web embed with its rules, default list, publications and announcement targets.
// Running camera sessions end at their next re-authorization.
func (s *Service) DeleteWebEmbed(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := requireManage(principal); err != nil {
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
	if _, _, err := lockWebEmbed(ctx, q, id, expected); err != nil {
		return err
	}
	if _, err := q.DeleteSignageWebEmbedDisplay(ctx, signagedb.DeleteSignageWebEmbedDisplayParams{
		ID: id, ExpectedVersion: expected,
	}); errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	if err := writeAudit(ctx, tx, principal, "signage_web_embed.deleted", webEmbedResource, id, requestID,
		nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// PublishWebEmbed publishes the embed's drafts like PublishDisplay and records its media switches in the publication.
func (s *Service) PublishWebEmbed(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (WebEmbed, error) {
	if _, err := s.publishDisplay(ctx, principal, id, DisplayKindWebEmbed, requestID); err != nil {
		return WebEmbed{}, serializationConflict(err)
	}
	return s.getWebEmbed(ctx, signagedb.New(s.pool), id)
}
