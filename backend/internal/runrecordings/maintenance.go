package runrecordings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings/db"
	"github.com/google/uuid"
)

// maintenanceBatch bounds the rows one maintenance step handles per transaction.
const maintenanceBatch = 100

// MaintenanceResult counts what one maintenance pass changed.
type MaintenanceResult struct {
	ExpiredCommands, ExpiredTimelapses, DeletedBlobs int
}

// Maintainer runs one maintenance pass; *Service implements it.
type Maintainer interface {
	Maintain(ctx context.Context) (MaintenanceResult, error)
}

// Maintain fails commands the connector did not pick up or finish in time,
// removes timelapse videos older than the retention setting and deletes queued
// storage blobs (of removed timelapses and of runs deleted with theirs). Several
// API replicas may run it at once: rows are claimed with SKIP LOCKED and blob
// deletion is idempotent.
func (s *Service) Maintain(ctx context.Context) (MaintenanceResult, error) {
	var result MaintenanceResult
	now := s.now()
	expired, err := db.New(s.pool).ExpireStaleRunCommands(ctx, db.ExpireStaleRunCommandsParams{
		RequestedBefore: now.Add(-CommandPickupTimeout),
		RunningBefore:   now.Add(-CommandRunTimeout),
	})
	if err != nil {
		return result, fmt.Errorf("expire run commands: %w", err)
	}
	result.ExpiredCommands = len(expired)
	settings, err := db.New(s.pool).GetRecordingSettings(ctx)
	if err != nil {
		return result, err
	}
	if settings.TimelapseRetentionDays > 0 {
		cutoff := now.AddDate(0, 0, -int(settings.TimelapseRetentionDays))
		for {
			count, err := s.expireTimelapses(ctx, cutoff)
			result.ExpiredTimelapses += count
			if err != nil {
				return result, fmt.Errorf("expire timelapses: %w", err)
			}
			if count < maintenanceBatch {
				break
			}
		}
	}
	for {
		count, err := s.files.DeleteQueuedBlobs(ctx, maintenanceBatch)
		result.DeletedBlobs += count
		if err != nil {
			return result, fmt.Errorf("delete queued blobs: %w", err)
		}
		if count < maintenanceBatch {
			break
		}
	}
	return result, nil
}

func (s *Service) expireTimelapses(ctx context.Context, cutoff time.Time) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	rows, err := q.ListExpiredTimelapsesForUpdate(ctx, db.ListExpiredTimelapsesForUpdateParams{
		Cutoff:   cutoff,
		RowLimit: maintenanceBatch,
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
	return len(rows), tx.Commit(ctx)
}

// RunMaintenance calls Maintain right away and then every interval until ctx is
// cancelled. Errors are logged without file names, keys or run data and never stop the loop.
func RunMaintenance(ctx context.Context, maintainer Maintainer, interval time.Duration, logger *slog.Logger) {
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		result, err := maintainer.Maintain(ctx)
		switch {
		case err != nil && !errors.Is(err, context.Canceled) && ctx.Err() == nil:
			logger.Error("run recording maintenance failed", "error_type", fmt.Sprintf("%T", err))
		case result.ExpiredCommands+result.ExpiredTimelapses+result.DeletedBlobs > 0:
			logger.Info(
				"run recording maintenance",
				"expired_commands", result.ExpiredCommands,
				"expired_timelapses", result.ExpiredTimelapses,
				"deleted_blobs", result.DeletedBlobs,
			)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
