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
	"github.com/jackc/pgx/v5"
)

// maintenanceBatch bounds the rows one maintenance step handles per transaction.
const maintenanceBatch = 100

// MaintenanceResult counts what one maintenance pass changed.
type MaintenanceResult struct {
	ExpiredCommands, ExpiredTimelapses, DeletedBlobs int
	// RemovedTimelapses were deleted for the count or storage limit.
	RemovedTimelapses int
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
	removed, err := s.EnforceTimelapseLimits(ctx)
	result.RemovedTimelapses = removed
	if err != nil {
		return result, fmt.Errorf("enforce timelapse limits: %w", err)
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

// EnforceTimelapseLimits deletes the oldest timelapse videos while more than
// timelapse_max_count are kept or they take more than timelapse_max_total_bytes
// (0 means no limit). Videos go in small batches, each in its own transaction,
// and their blobs are queued for deletion like expired ones.
func (s *Service) EnforceTimelapseLimits(ctx context.Context) (int, error) {
	settings, err := db.New(s.pool).GetRecordingSettings(ctx)
	if err != nil {
		return 0, err
	}
	if settings.TimelapseMaxCount <= 0 && settings.TimelapseMaxTotalBytes <= 0 {
		return 0, nil
	}
	total := 0
	for {
		summary, err := db.New(s.pool).SummarizeTimelapses(ctx)
		if err != nil {
			return total, err
		}
		var over, excessBytes int64
		if settings.TimelapseMaxCount > 0 && summary.Count > int64(settings.TimelapseMaxCount) {
			over = summary.Count - int64(settings.TimelapseMaxCount)
		}
		if settings.TimelapseMaxTotalBytes > 0 && summary.TotalBytes > settings.TimelapseMaxTotalBytes {
			excessBytes = summary.TotalBytes - settings.TimelapseMaxTotalBytes
		}
		if over <= 0 && excessBytes <= 0 {
			return total, nil
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return total, err
		}
		count, err := s.trimTimelapsesTx(ctx, tx, over, excessBytes, maintenanceBatch)
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, err
		}
		if err := tx.Commit(ctx); err != nil {
			return total, err
		}
		total += count
		if count == 0 {
			return total, nil
		}
	}
}

// trimTimelapsesTx removes the oldest videos until both the count excess and the byte excess are gone, at most limit.
func (s *Service) trimTimelapsesTx(ctx context.Context, tx pgx.Tx, over, excessBytes int64, limit int32) (int, error) {
	q := db.New(tx)
	rows, err := q.ListOldestTimelapsesForUpdate(ctx, limit)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	var runIDs, fileIDs []uuid.UUID
	for _, row := range rows {
		if over <= 0 && excessBytes <= 0 {
			break
		}
		runIDs = append(runIDs, row.RunID)
		fileIDs = append(fileIDs, row.FileID)
		over--
		excessBytes -= row.SizeBytes
	}
	if len(runIDs) == 0 {
		return 0, nil
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
			Action:        "machine_run.timelapse_trimmed",
			ResourceType:  "machine_run",
			ResourceID:    &runID,
			ChangedFields: []string{"timelapse"},
		}); err != nil {
			return 0, err
		}
	}
	return len(runIDs), nil
}
