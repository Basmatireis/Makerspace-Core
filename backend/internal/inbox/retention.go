package inbox

import (
	"context"
	"time"

	inboxdb "github.com/Basmatireis/Makerspace-Core/backend/internal/inbox/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/jackc/pgx/v5"
)

// NotificationRetention hard-deletes notifications created before the cutoff
// (recipients cascade); it replaces the sweep that ran lazily on reads.
func NotificationRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		return inboxdb.New(tx).DeleteNotificationsCreatedBefore(ctx, cutoff)
	})
}
