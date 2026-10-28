package printartifacts

import (
	"context"
	"time"

	printartifactsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ArtifactRetention deletes print files (3MF) and their previews that were
// stored before the cutoff and are not used by a running run. Runs and jobs
// keep their records with the artifact link cleared; the file blobs are queued
// for deletion and removed by the scheduler after the transaction committed.
func ArtifactRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, limit int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		q := printartifactsdb.New(tx)
		rows, err := q.ListPrintArtifactsBefore(ctx, printartifactsdb.ListPrintArtifactsBeforeParams{BeforeTime: cutoff, RowLimit: limit})
		if err != nil || len(rows) == 0 {
			return 0, err
		}
		ids := make([]uuid.UUID, 0, len(rows))
		files := make([]uuid.UUID, 0, len(rows)*2)
		for _, row := range rows {
			ids = append(ids, row.ID)
			files = append(files, row.OriginalFileID)
		}
		if err := q.DetachRunArtifacts(ctx, ids); err != nil {
			return 0, err
		}
		if err := q.DetachJobArtifacts(ctx, ids); err != nil {
			return 0, err
		}
		if err := q.ClearPrimaryPreviews(ctx, ids); err != nil {
			return 0, err
		}
		previews, err := q.DeletePrintArtifactPreviewsOf(ctx, ids)
		if err != nil {
			return 0, err
		}
		files = append(files, previews...)
		if err := q.DeletePrintArtifactFilamentsOf(ctx, ids); err != nil {
			return 0, err
		}
		if err := q.DeletePrintArtifactsByID(ctx, ids); err != nil {
			return 0, err
		}
		if err := q.DeleteArtifactFilesQueueBlobs(ctx, files); err != nil {
			return 0, err
		}
		return int64(len(rows)), nil
	})
}
