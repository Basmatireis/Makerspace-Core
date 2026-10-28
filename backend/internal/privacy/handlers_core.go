package privacy

import (
	"context"
	"time"

	auditdb "github.com/Basmatireis/Makerspace-Core/backend/internal/audit/db"
	"github.com/jackc/pgx/v5"
)

// AuditEventRetention deletes audit events that occurred before the cutoff.
// It lives here because the audit package is a dependency of this one.
func AuditEventRetention() RetentionHandler {
	return HandlerFunc(func(ctx context.Context, tx pgx.Tx, action Action, cutoff time.Time, _ int32) (int64, error) {
		if action != ActionDelete {
			return 0, ErrActionUnsupported
		}
		return auditdb.New(tx).DeleteAuditEventsBefore(ctx, cutoff)
	})
}
