package printartifacts

import (
	"context"
	"fmt"
	"net/http"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	printartifactsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// limitBatch bounds one trim transaction.
const limitBatch = 50

// MaxArtifactBytes is the largest print file accepted right now: the recording setting, capped by MaxCompressedSize.
func (s *Service) MaxArtifactBytes(ctx context.Context) (int64, error) {
	limits, err := printartifactsdb.New(s.pool).GetArtifactLimits(ctx)
	if err != nil {
		return 0, err
	}
	return min(limits.ArtifactMaxBytes, MaxCompressedSize), nil
}

func tooLarge(limit int64) error {
	return apperror.New(
		http.StatusRequestEntityTooLarge,
		"artifact_too_large",
		fmt.Sprintf("Print files are limited to %d MiB", limit>>20),
	)
}

// EnforceLimits deletes the oldest print files (with their previews) while more than artifact_max_count are kept or
// they take more than artifact_max_total_bytes (0 means no limit). A file a running print uses is never removed; runs
// and jobs keep their records with the file link cleared. Each batch is its own transaction and audited per file.
func (s *Service) EnforceLimits(ctx context.Context) (int, error) {
	limits, err := printartifactsdb.New(s.pool).GetArtifactLimits(ctx)
	if err != nil {
		return 0, err
	}
	if limits.ArtifactMaxCount <= 0 && limits.ArtifactMaxTotalBytes <= 0 {
		return 0, nil
	}
	total := 0
	for {
		summary, err := printartifactsdb.New(s.pool).SummarizePrintArtifacts(ctx)
		if err != nil {
			return total, err
		}
		var over, excessBytes int64
		if limits.ArtifactMaxCount > 0 && summary.Count > int64(limits.ArtifactMaxCount) {
			over = summary.Count - int64(limits.ArtifactMaxCount)
		}
		if limits.ArtifactMaxTotalBytes > 0 && summary.TotalBytes > limits.ArtifactMaxTotalBytes {
			excessBytes = summary.TotalBytes - limits.ArtifactMaxTotalBytes
		}
		if over <= 0 && excessBytes <= 0 {
			return total, nil
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return total, err
		}
		count, err := trimArtifactsTx(ctx, tx, over, excessBytes, limitBatch)
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

func trimArtifactsTx(ctx context.Context, tx pgx.Tx, over, excessBytes int64, limit int32) (int, error) {
	q := printartifactsdb.New(tx)
	rows, err := q.ListOldestPrintArtifactsForUpdate(ctx, limit)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	var ids, files []uuid.UUID
	for _, row := range rows {
		if over <= 0 && excessBytes <= 0 {
			break
		}
		ids = append(ids, row.ID)
		files = append(files, row.OriginalFileID)
		over--
		excessBytes -= row.SizeBytes
	}
	if len(ids) == 0 {
		return 0, nil
	}
	if err = deleteArtifacts(ctx, q, ids, files); err != nil {
		return 0, err
	}
	for _, id := range ids {
		if err = audit.Write(ctx, tx, audit.Event{
			ActorType:     "system",
			Action:        "print_artifact.trimmed",
			ResourceType:  "print_artifact",
			ResourceID:    &id,
			ChangedFields: []string{"file"},
		}); err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}

// deleteArtifacts removes the print files with their previews and filament lines, clears the links from runs and
// jobs and queues every blob for deletion.
func deleteArtifacts(ctx context.Context, q *printartifactsdb.Queries, ids, files []uuid.UUID) error {
	if err := q.DetachRunArtifacts(ctx, ids); err != nil {
		return err
	}
	if err := q.DetachJobArtifacts(ctx, ids); err != nil {
		return err
	}
	if err := q.ClearPrimaryPreviews(ctx, ids); err != nil {
		return err
	}
	previews, err := q.DeletePrintArtifactPreviewsOf(ctx, ids)
	if err != nil {
		return err
	}
	files = append(files, previews...)
	if err := q.DeletePrintArtifactFilamentsOf(ctx, ids); err != nil {
		return err
	}
	if err := q.DeletePrintArtifactsByID(ctx, ids); err != nil {
		return err
	}
	return q.DeleteArtifactFilesQueueBlobs(ctx, files)
}
