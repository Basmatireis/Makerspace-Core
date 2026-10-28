package subjectrequests

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	requestsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests/db"
	"github.com/jackc/pgx/v5"
)

// RetentionHandler deletes closed requests (completed, partially completed
// or rejected) whose completion lies before the cutoff, together with their
// export archives. Open requests are never touched.
func RetentionHandler() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, limit int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		q := requestsdb.New(tx)
		rows, err := q.ListSubjectRequestsClosedBefore(ctx, requestsdb.ListSubjectRequestsClosedBeforeParams{BeforeTime: cutoff, RowLimit: limit})
		if err != nil || len(rows) == 0 {
			return 0, err
		}
		ids := make([]string, 0, len(rows))
		var exports []string
		for _, row := range rows {
			ids = append(ids, row.ID.String())
			if row.ExportFileID != nil {
				exports = append(exports, row.ExportFileID.String())
			}
		}
		deleted, err := q.DeleteSubjectRequestsByID(ctx, ids)
		if err != nil {
			return 0, err
		}
		if len(exports) > 0 {
			if err := q.DeleteExportFilesQueueBlobs(ctx, exports); err != nil {
				return deleted, err
			}
		}
		return deleted, nil
	})
}
