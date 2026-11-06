package notifyrules

import (
	"context"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/jackc/pgx/v5"
)

// ConsentRetention hard-deletes consents that were withdrawn before the cutoff. A decline that was never preceded by
// a granted answer has no withdrawal time and stays while the person exists.
func ConsentRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		return notifyrulesdb.New(tx).DeleteConsentsWithdrawnBefore(ctx, pgtypeTime(cutoff))
	})
}

// DeliveryRetention hard-deletes firings created before the cutoff; their recipients and pending actions cascade.
func DeliveryRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		queries := notifyrulesdb.New(tx)
		firings, err := queries.DeleteFiringsCreatedBefore(ctx, cutoff)
		if err != nil {
			return 0, err
		}
		runs, err := queries.DeleteRuleRunsBefore(ctx, cutoff)
		if err != nil {
			return 0, err
		}
		signage, err := queries.DeleteSignageRuleNoticesBefore(ctx, cutoff)
		if err != nil {
			return 0, err
		}
		tablets, err := queries.DeleteKioskRuleNoticesBefore(ctx, cutoff)
		return firings + runs + signage + tablets, err
	})
}
