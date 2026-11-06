package notifyrules

import (
	"context"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/jackc/pgx/v5"
)

// DeliveryRetention hard-deletes firings created before the cutoff; their recipients and pending actions cascade.
func DeliveryRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		return notifyrulesdb.New(tx).DeleteFiringsCreatedBefore(ctx, cutoff)
	})
}
