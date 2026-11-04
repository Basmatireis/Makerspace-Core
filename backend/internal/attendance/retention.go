package attendance

import (
	"context"
	"time"

	attendancedb "github.com/Basmatireis/Makerspace-Core/backend/internal/attendance/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// VisitRetention rolls completed visits that ended before the cutoff into the
// non-identifying daily statistics and deletes their detail; the former admin
// cleanup step. Open visits are never touched. The daily aggregates are kept
// for both actions, so delete behaves like anonymize here.
func VisitRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionAnonymize && action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		return attendancedb.New(tx).ArchiveExpiredVisitDetail(ctx, pgtype.Timestamptz{Time: cutoff, Valid: true})
	})
}
