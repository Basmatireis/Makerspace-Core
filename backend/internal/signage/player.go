package signage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	// machineStaleAfter is how old a printer status may be before the player must treat it as unknown.
	machineStaleAfter = 3 * time.Minute
	liveListLimit     = 5

	maxHeartbeatErrors      = 20
	maxHeartbeatErrorRunes  = 200
	maxHeartbeatVersionRune = 64
)

// PublicOpenDay is an upcoming open day from the public calendar.
type PublicOpenDay struct {
	StartsAt, EndsAt time.Time
	Status           string
}

// PublicEvent is the public-safe part of an upcoming event: nothing but title, start and location.
type PublicEvent struct {
	Title    string
	StartsAt time.Time
	Location string
}

// PublicCalendar supplies what the live endpoint may show about open days and events. It must only
// return what is already publicly visible.
type PublicCalendar interface {
	UpcomingOpenDays(ctx context.Context, now time.Time, limit int) ([]PublicOpenDay, error)
	UpcomingEvents(ctx context.Context, now time.Time, limit int) ([]PublicEvent, error)
}

// PlayerDisplay is the display a player credential is bound to.
type PlayerDisplay struct {
	ID                 uuid.UUID
	Name, Location     string
	Orientation        string
	Resolution         Resolution
	VisibleFromOutside bool
}

// PlayerDisplayFor resolves the display of a verified signage player device. A device without a
// display answers 404; a revoked display (or a revoked device behind it) answers 403.
func (s *Service) PlayerDisplayFor(ctx context.Context, deviceID uuid.UUID) (PlayerDisplay, error) {
	row, err := signagedb.New(s.pool).GetSignageDisplayByDevice(ctx, deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return PlayerDisplay{}, apperror.NotFound
	}
	if err != nil {
		return PlayerDisplay{}, err
	}
	if row.RevokedAt.Valid || row.DeviceRevokedAt.Valid {
		return PlayerDisplay{}, apperror.New(403, "signage_display_revoked", "The display is revoked")
	}
	return PlayerDisplay{
		ID: row.ID, Name: row.Name, Location: row.Location, Orientation: row.Orientation,
		Resolution: Resolution{Width: int(row.ResolutionWidth), Height: int(row.ResolutionHeight)}, VisibleFromOutside: row.VisibleFromOutside,
	}, nil
}

func (s *Service) latestManifest(ctx context.Context, q *signagedb.Queries, displayID uuid.UUID) (Manifest, bool, error) {
	row, err := q.GetLatestSignagePublication(ctx, displayID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Manifest{}, false, nil
	}
	if err != nil {
		return Manifest{}, false, err
	}
	var manifest Manifest
	if err := json.Unmarshal(row.Manifest, &manifest); err != nil {
		return Manifest{}, false, err
	}
	return manifest, true, nil
}

// PlayerManifest returns the display's latest publication, or unchanged when the player already
// runs revision known. A display that was never published answers 404 signage_not_published.
func (s *Service) PlayerManifest(ctx context.Context, display PlayerDisplay, known *int) (manifest Manifest, unchanged bool, err error) {
	latest, ok, err := s.latestManifest(ctx, signagedb.New(s.pool), display.ID)
	if err != nil {
		return Manifest{}, false, err
	}
	if !ok {
		return Manifest{}, false, apperror.New(404, "signage_not_published", "No content has been published for this display yet")
	}
	if known != nil && *known == latest.Revision {
		return Manifest{}, true, nil
	}
	return latest, false, nil
}

// PlayerAssetFile is an asset of the display's latest publication together with its bytes.
type PlayerAssetFile struct {
	Asset  ManifestAsset
	Reader io.ReadCloser
}

// OpenPlayerAsset opens an asset's bytes, but only when the display's latest publication lists the
// asset with exactly this checksum; everything else is 404.
func (s *Service) OpenPlayerAsset(ctx context.Context, display PlayerDisplay, assetID uuid.UUID, sha256 string) (PlayerAssetFile, error) {
	q := signagedb.New(s.pool)
	manifest, ok, err := s.latestManifest(ctx, q, display.ID)
	if err != nil {
		return PlayerAssetFile{}, err
	}
	if !ok {
		return PlayerAssetFile{}, apperror.NotFound
	}
	var listed *ManifestAsset
	for index := range manifest.Assets {
		if manifest.Assets[index].ID == assetID && manifest.Assets[index].SHA256 == sha256 {
			listed = &manifest.Assets[index]
		}
	}
	if listed == nil {
		return PlayerAssetFile{}, apperror.NotFound
	}
	row, err := q.GetSignageAsset(ctx, assetID)
	if errors.Is(err, pgx.ErrNoRows) {
		return PlayerAssetFile{}, apperror.NotFound
	}
	if err != nil {
		return PlayerAssetFile{}, err
	}
	if assetFromRow(row.ID, row.Kind, row.Name, row.Width, row.Height, row.DurationMs, nil, "", time.Time{}, row.ContentType, row.SizeBytes, row.Sha256).SHA256 != sha256 {
		return PlayerAssetFile{}, apperror.NotFound
	}
	_, reader, err := s.files.Open(ctx, row.FileID)
	if err != nil {
		return PlayerAssetFile{}, err
	}
	return PlayerAssetFile{Asset: *listed, Reader: reader}, nil
}

// LiveMachine is the status of a machine the display shows.
type LiveMachine struct {
	MachineID        uuid.UUID
	Name             string
	State            string
	ProgressPercent  *int
	RemainingMinutes *int
	ObservedAt       *time.Time
	Stale            bool
}

// LiveAnnouncement is a rendered announcement targeting the display. It never carries the raw
// field values, only the finished text.
type LiveAnnouncement struct {
	ID, TemplateID uuid.UUID
	Tone           string
	Title, Body    string
	StartsAt       time.Time
	EndsAt         *time.Time
}

// Stream is a camera stream the display may watch: gateway URLs plus a short-lived ticket.
type Stream struct {
	MachineID uuid.UUID
	WebRTCURL string
	MSEURL    string
	Ticket    string
	ExpiresAt time.Time
}

// StreamIssuer hands out stream tickets. It is implemented by the streaming gateway service.
type StreamIssuer interface {
	IssueStreams(ctx context.Context, displayID uuid.UUID, machineIDs []uuid.UUID) ([]Stream, error)
}

// LiveData is the short-lived data the player polls about every ten seconds.
type LiveData struct {
	ServerTime    time.Time
	Revision      *int
	Machines      []LiveMachine
	Announcements []LiveAnnouncement
	OpenDays      []PublicOpenDay
	Events        []PublicEvent
	Streams       []Stream
}

var knownLiveStates = map[string]struct{}{"idle": {}, "preparing": {}, "printing": {}, "paused": {}, "finished": {}, "failed": {}}

type liveSnapshot struct {
	State string `json:"state"`
	Job   *struct {
		ProgressPercent  *int `json:"progressPercent"`
		RemainingMinutes *int `json:"remainingMinutes"`
	} `json:"job"`
}

// liveMachineFrom reduces a printer snapshot to the few fields a screen may show. Snapshots older
// than machineStaleAfter (or missing) become state unknown without progress.
func liveMachineFrom(id uuid.UUID, name string, status *signagedb.ListSignageLiveStatusesRow, now time.Time) LiveMachine {
	machine := LiveMachine{MachineID: id, Name: name, State: "unknown", Stale: true}
	if status == nil {
		return machine
	}
	observed := status.ObservedAt.UTC()
	machine.ObservedAt = &observed
	if now.Sub(status.ReceivedAt) > machineStaleAfter {
		return machine
	}
	machine.Stale = false
	var snapshot liveSnapshot
	if json.Unmarshal(status.Snapshot, &snapshot) != nil {
		machine.State = "unknown"
		return machine
	}
	if _, ok := knownLiveStates[snapshot.State]; ok {
		machine.State = snapshot.State
	}
	if snapshot.Job != nil && (machine.State == "printing" || machine.State == "paused" || machine.State == "preparing") {
		machine.ProgressPercent, machine.RemainingMinutes = snapshot.Job.ProgressPercent, snapshot.Job.RemainingMinutes
	}
	return machine
}

// PlayerLive assembles the live data of a display, including stream tickets for the cameras its
// published camera widgets use. The display must not be revoked; PlayerDisplayFor guarantees that.
func (s *Service) PlayerLive(ctx context.Context, display PlayerDisplay) (LiveData, error) {
	return s.playerLive(ctx, display, true)
}

func (s *Service) playerLive(ctx context.Context, display PlayerDisplay, withStreams bool) (LiveData, error) {
	s.sweepExpiredThrottled(ctx)
	now := s.now()
	q := signagedb.New(s.pool)
	live := LiveData{ServerTime: now, Machines: []LiveMachine{}, Announcements: []LiveAnnouncement{}, OpenDays: []PublicOpenDay{}, Events: []PublicEvent{}, Streams: []Stream{}}
	manifest, published, err := s.latestManifest(ctx, q, display.ID)
	if err != nil {
		return LiveData{}, err
	}
	if published {
		revision := manifest.Revision
		live.Revision = &revision
		if withStreams && s.streams != nil {
			if ids := ManifestCameraMachineIDs(manifest); len(ids) > 0 {
				if live.Streams, err = s.streams.IssueStreams(ctx, display.ID, ids); err != nil {
					return LiveData{}, err
				}
			}
		}
		if ids := ManifestMachineIDs(manifest); len(ids) > 0 {
			names, err := q.ListSignageMachineNames(ctx, uuidStrings(ids))
			if err != nil {
				return LiveData{}, err
			}
			statuses, err := q.ListSignageLiveStatuses(ctx, uuidStrings(ids))
			if err != nil {
				return LiveData{}, err
			}
			byMachine := map[uuid.UUID]*signagedb.ListSignageLiveStatusesRow{}
			for index := range statuses {
				byMachine[statuses[index].MachineID] = &statuses[index]
			}
			for _, machine := range names {
				live.Machines = append(live.Machines, liveMachineFrom(machine.ID, machine.Name, byMachine[machine.ID], now))
			}
		}
	}
	rows, err := q.ListLiveSignageAnnouncementsForDisplay(ctx, signagedb.ListLiveSignageAnnouncementsForDisplayParams{Now: now, DisplayID: display.ID})
	if err != nil {
		return LiveData{}, err
	}
	announcements, err := s.hydrateFor(ctx, q, rows, display.Name, display.Location)
	if err != nil {
		return LiveData{}, err
	}
	for _, announcement := range announcements {
		live.Announcements = append(live.Announcements, LiveAnnouncement{
			ID: announcement.ID, TemplateID: announcement.TemplateID, Tone: announcement.Rendered.Tone,
			Title: announcement.Rendered.Title, Body: announcement.Rendered.Body, StartsAt: announcement.StartsAt, EndsAt: announcement.EndsAt,
		})
	}
	if s.calendar != nil {
		if live.OpenDays, err = s.calendar.UpcomingOpenDays(ctx, now, liveListLimit); err != nil {
			return LiveData{}, err
		}
		if live.Events, err = s.calendar.UpcomingEvents(ctx, now, liveListLimit); err != nil {
			return LiveData{}, err
		}
	}
	return live, nil
}

// DisplayPreview is what the admin live preview renders: the latest publication (nil before the
// first one) and the live data the display's player would poll right now.
type DisplayPreview struct {
	Manifest *Manifest
	Live     LiveData
}

// PreviewDisplay assembles the preview of one display for staff with signage.read.
func (s *Service) PreviewDisplay(ctx context.Context, principal authorization.Principal, id uuid.UUID) (DisplayPreview, error) {
	if err := requireRead(principal); err != nil {
		return DisplayPreview{}, err
	}
	q := signagedb.New(s.pool)
	row, err := q.GetSignageDisplayView(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return DisplayPreview{}, apperror.NotFound
	}
	if err != nil {
		return DisplayPreview{}, err
	}
	// The preview never carries stream tickets: it is not the display itself.
	live, err := s.playerLive(ctx, PlayerDisplay{ID: row.ID, Name: row.Name, Location: row.Location}, false)
	if err != nil {
		return DisplayPreview{}, err
	}
	preview := DisplayPreview{Live: live}
	if manifest, ok, err := s.latestManifest(ctx, q, id); err != nil {
		return DisplayPreview{}, err
	} else if ok {
		preview.Manifest = &manifest
	}
	return preview, nil
}

// Heartbeat is what a player reports about itself every 30 seconds.
type Heartbeat struct {
	Revision        *int
	CurrentRule     *string
	CurrentSceneID  *uuid.UUID
	PlayerVersion   *string
	CacheUsedBytes  *int64
	CacheQuotaBytes *int64
	Errors          []string
}

func shortText(value string, maxRunes int) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// ValidateHeartbeat bounds every reported value; heartbeats are untrusted telemetry.
func ValidateHeartbeat(h Heartbeat) (Heartbeat, error) {
	if h.Revision != nil && (*h.Revision < 1 || *h.Revision > 1_000_000_000) {
		return h, validation("revision must be a positive publication revision")
	}
	if h.CurrentRule != nil && (*h.CurrentRule == "" || !shortText(*h.CurrentRule, 64) || strings.ContainsAny(*h.CurrentRule, " \t")) {
		return h, validation("currentRule must be a rule id or default")
	}
	if h.PlayerVersion != nil && (*h.PlayerVersion == "" || !shortText(*h.PlayerVersion, maxHeartbeatVersionRune)) {
		return h, validation("playerVersion must be 1 to %d characters of plain text", maxHeartbeatVersionRune)
	}
	for _, bytes := range []*int64{h.CacheUsedBytes, h.CacheQuotaBytes} {
		if bytes != nil && (*bytes < 0 || *bytes > 1<<50) {
			return h, validation("cache sizes must be non-negative byte counts")
		}
	}
	if len(h.Errors) > maxHeartbeatErrors {
		return h, validation("a heartbeat reports at most %d errors", maxHeartbeatErrors)
	}
	errorsCopy := make([]string, 0, len(h.Errors))
	for _, message := range h.Errors {
		if !shortText(message, maxHeartbeatErrorRunes) {
			return h, validation("error messages are limited to %d characters of plain text", maxHeartbeatErrorRunes)
		}
		errorsCopy = append(errorsCopy, message)
	}
	h.Errors = errorsCopy
	return h, nil
}

// RecordHeartbeat upserts the display's ephemeral state. Heartbeats are telemetry: no audit event.
func (s *Service) RecordHeartbeat(ctx context.Context, display PlayerDisplay, heartbeat Heartbeat) error {
	checked, err := ValidateHeartbeat(heartbeat)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(checked.Errors)
	if err != nil {
		return err
	}
	var revision *int32
	if checked.Revision != nil {
		value := int32(*checked.Revision)
		revision = &value
	}
	return signagedb.New(s.pool).UpsertSignageDisplayState(ctx, signagedb.UpsertSignageDisplayStateParams{
		DisplayID: display.ID, LastHeartbeatAt: s.now(), PublicationRevision: revision, CurrentRule: checked.CurrentRule,
		CurrentSceneID: checked.CurrentSceneID, PlayerVersion: checked.PlayerVersion, CacheUsedBytes: checked.CacheUsedBytes,
		CacheQuotaBytes: checked.CacheQuotaBytes, Errors: string(encoded),
	})
}
