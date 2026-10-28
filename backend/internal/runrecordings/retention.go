package runrecordings

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TimelapseRetention deletes timelapse videos stored before the cutoff, in
// batches, queuing their blobs for the scheduler. The legacy period comes from
// run_recording_settings.timelapse_retention_days (0 keeps videos).
func (s *Service) TimelapseRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, limit int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		count, err := s.expireTimelapsesTx(ctx, tx, cutoff, limit)
		return int64(count), err
	})
}

// ConfiguredTimelapseRetention reads the legacy period from the settings row;
// nil means the setting is absent, zero means keep forever.
func (s *Service) ConfiguredTimelapseRetention(ctx context.Context) (*time.Duration, error) {
	settings, err := db.New(s.pool).GetRecordingSettings(ctx)
	if err != nil {
		return nil, err
	}
	period := time.Duration(settings.TimelapseRetentionDays) * 24 * time.Hour
	return &period, nil
}

func (s *Service) expireTimelapsesTx(ctx context.Context, tx pgx.Tx, cutoff time.Time, limit int32) (int, error) {
	q := db.New(tx)
	rows, err := q.ListExpiredTimelapsesForUpdate(ctx, db.ListExpiredTimelapsesForUpdateParams{
		Cutoff:   cutoff,
		RowLimit: limit,
	})
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	runIDs := make([]uuid.UUID, 0, len(rows))
	fileIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		runIDs = append(runIDs, row.RunID)
		fileIDs = append(fileIDs, row.FileID)
	}
	if err = q.DeleteRunTimelapses(ctx, runIDs); err != nil {
		return 0, err
	}
	if err = q.DeleteFilesQueueBlobs(ctx, fileIDs); err != nil {
		return 0, err
	}
	for _, runID := range runIDs {
		if err = audit.Write(ctx, tx, audit.Event{
			ActorType:     "system",
			Action:        "machine_run.timelapse_expired",
			ResourceType:  "machine_run",
			ResourceID:    &runID,
			ChangedFields: []string{"timelapse"},
		}); err != nil {
			return 0, err
		}
	}
	return len(rows), nil
}
