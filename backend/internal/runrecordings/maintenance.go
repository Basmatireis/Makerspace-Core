package runrecordings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	db "github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings/db"
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

// Maintain fails commands the connector did not pick up or finish in time and
// deletes queued storage blobs (of removed timelapses and of runs deleted with
// theirs). Timelapse videos older than the retention setting are removed by
// the privacy retention engine through TimelapseRetention. Several API
// replicas may run it at once: rows are claimed with SKIP LOCKED and blob
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

// ExpireTimelapsesBySetting removes timelapses older than the retention
// setting in one pass; the scheduler's retention job does this in production,
// tests and the legacy path use it directly.
func (s *Service) ExpireTimelapsesBySetting(ctx context.Context) (int, error) {
	settings, err := db.New(s.pool).GetRecordingSettings(ctx)
	if err != nil {
		return 0, err
	}
	if settings.TimelapseRetentionDays <= 0 {
		return 0, nil
	}
	cutoff := s.now().AddDate(0, 0, -int(settings.TimelapseRetentionDays))
	total := 0
	for {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return total, err
		}
		count, err := s.expireTimelapsesTx(ctx, tx, cutoff, maintenanceBatch)
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, err
		}
		if err := tx.Commit(ctx); err != nil {
			return total, err
		}
		total += count
		if count < maintenanceBatch {
			return total, nil
		}
	}
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
