package signage

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strconv"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// maxLiveTimelapses bounds the clips one display's live data lists across all its timelapse widgets.
const maxLiveTimelapses = 50

// TimelapseContentType is the media type every stored run timelapse has.
const TimelapseContentType = "video/mp4"

// LiveTimelapse is a timelapse clip of a finished print a display may play. It never names the job,
// the file or the person.
type LiveTimelapse struct {
	RunID, MachineID uuid.UUID
	MachineName      string
	EndedAt          time.Time
	SHA256           string
	SizeBytes        int64
	fileID           uuid.UUID
}

// TimelapseFile is a timelapse video together with its bytes.
type TimelapseFile struct {
	RunID     uuid.UUID
	SHA256    string
	SizeBytes int64
	Reader    io.ReadCloser
}

// timelapseNeed is what one or more timelapse widgets ask for: the newest count clips of the machines
// (every machine when all) that ended within maxAgeDays (0 is any age).
type timelapseNeed struct {
	all        bool
	machines   []uuid.UUID
	maxAgeDays int
	count      int
}

// timelapseNeedsOf collects the distinct needs of the publication's timelapse widgets; widgets that differ
// only in count share one need with the largest count. present reports any timelapse widget at all.
func timelapseNeedsOf(manifest Manifest) (needs []timelapseNeed, present bool) {
	byKey := map[string]int{}
	for _, scene := range manifest.Scenes {
		for _, raw := range scene.Zones {
			var widget struct {
				Type       WidgetType      `json:"type"`
				Source     TimelapseSource `json:"source"`
				MachineIDs []uuid.UUID     `json:"machineIds"`
				Count      int             `json:"count"`
				MaxAgeDays int             `json:"maxAgeDays"`
			}
			if json.Unmarshal(raw, &widget) != nil || widget.Type != WidgetTimelapse {
				continue
			}
			present = true
			need := timelapseNeed{
				all:        widget.Source == TimelapseSourceAll,
				maxAgeDays: min(max(widget.MaxAgeDays, 0), maxTimelapseAgeDays),
				count:      min(max(widget.Count, 0), maxTimelapseCount),
			}
			if !need.all {
				set := map[uuid.UUID]struct{}{}
				for _, id := range widget.MachineIDs {
					set[id] = struct{}{}
				}
				need.machines = sortedIDs(set)
				if len(need.machines) == 0 {
					continue
				}
			}
			if need.count == 0 {
				continue
			}
			var key bytes.Buffer
			if need.all {
				key.WriteString("all")
			}
			for _, id := range need.machines {
				key.Write(id[:])
			}
			key.WriteString("/" + strconv.Itoa(need.maxAgeDays))
			if index, seen := byKey[key.String()]; seen {
				needs[index].count = max(needs[index].count, need.count)
				continue
			}
			byKey[key.String()] = len(needs)
			needs = append(needs, need)
		}
	}
	return needs, present
}

// timelapseSelection lists the clips the publication's timelapse widgets show right now: finished recorded
// runs with a stored timelapse that are not hidden from signage, the union of every widget's newest clips,
// newest first and at most maxLiveTimelapses. present reports whether the publication has a timelapse widget.
func (s *Service) timelapseSelection(
	ctx context.Context,
	q *signagedb.Queries,
	manifest Manifest,
	now time.Time,
) (clips []LiveTimelapse, present bool, err error) {
	needs, present := timelapseNeedsOf(manifest)
	if !present {
		return nil, false, nil
	}
	seen := map[uuid.UUID]struct{}{}
	clips = []LiveTimelapse{}
	for _, need := range needs {
		params := signagedb.ListSignageTimelapsesParams{
			AllMachines: need.all,
			MachineIds:  uuidStrings(need.machines),
			RowLimit:    int32(need.count),
		}
		if params.MachineIds == nil {
			params.MachineIds = []string{}
		}
		if need.maxAgeDays > 0 {
			params.EndedAfter = pgtype.Timestamptz{Time: now.AddDate(0, 0, -need.maxAgeDays), Valid: true}
		}
		rows, err := q.ListSignageTimelapses(ctx, params)
		if err != nil {
			return nil, true, err
		}
		for _, row := range rows {
			if _, duplicate := seen[row.RunID]; duplicate {
				continue
			}
			seen[row.RunID] = struct{}{}
			clips = append(clips, LiveTimelapse{
				RunID: row.RunID, MachineID: row.MachineID, MachineName: row.MachineName, EndedAt: row.EndedAt.UTC(),
				SHA256: hex.EncodeToString(row.Sha256), SizeBytes: row.SizeBytes, fileID: row.FileID,
			})
		}
	}
	sort.SliceStable(clips, func(i, j int) bool {
		if !clips[i].EndedAt.Equal(clips[j].EndedAt) {
			return clips[i].EndedAt.After(clips[j].EndedAt)
		}
		return bytes.Compare(clips[i].RunID[:], clips[j].RunID[:]) > 0
	})
	if len(clips) > maxLiveTimelapses {
		clips = clips[:maxLiveTimelapses]
	}
	return clips, true, nil
}

// OpenPlayerTimelapse opens a timelapse video for a player, but only while the run is in the display's
// current timelapse selection with exactly this checksum; everything else is 404.
func (s *Service) OpenPlayerTimelapse(
	ctx context.Context,
	display PlayerDisplay,
	runID uuid.UUID,
	sha256 string,
) (TimelapseFile, error) {
	q := signagedb.New(s.pool)
	manifest, ok, err := s.latestManifest(ctx, q, display.ID)
	if err != nil {
		return TimelapseFile{}, err
	}
	if !ok {
		return TimelapseFile{}, apperror.NotFound
	}
	clips, _, err := s.timelapseSelection(ctx, q, manifest, s.now())
	if err != nil {
		return TimelapseFile{}, err
	}
	for _, clip := range clips {
		if clip.RunID == runID && clip.SHA256 == sha256 {
			return s.openTimelapse(ctx, clip.RunID, clip.SHA256, clip.SizeBytes, clip.fileID)
		}
	}
	return TimelapseFile{}, apperror.NotFound
}

// OpenTimelapse opens a run's timelapse for the admin preview of a timelapse widget (signage.read). Only
// finished recorded runs that are not hidden from signage qualify; everything else is 404.
func (s *Service) OpenTimelapse(
	ctx context.Context,
	principal authorization.Principal,
	runID uuid.UUID,
) (TimelapseFile, error) {
	if err := requireRead(principal); err != nil {
		return TimelapseFile{}, err
	}
	row, err := signagedb.New(s.pool).GetSignageTimelapse(ctx, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return TimelapseFile{}, apperror.NotFound
	}
	if err != nil {
		return TimelapseFile{}, err
	}
	return s.openTimelapse(ctx, row.RunID, hex.EncodeToString(row.Sha256), row.SizeBytes, row.FileID)
}

func (s *Service) openTimelapse(
	ctx context.Context,
	runID uuid.UUID,
	sha256 string,
	sizeBytes int64,
	fileID uuid.UUID,
) (TimelapseFile, error) {
	_, reader, err := s.files.Open(ctx, fileID)
	if err != nil {
		return TimelapseFile{}, err
	}
	return TimelapseFile{RunID: runID, SHA256: sha256, SizeBytes: sizeBytes, Reader: reader}, nil
}
