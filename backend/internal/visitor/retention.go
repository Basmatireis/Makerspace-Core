package visitor

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	visitordb "github.com/Basmatireis/Makerspace-Core/backend/internal/visitor/db"
	"github.com/jackc/pgx/v5"
)

// EnrollmentContextRetention deletes kiosk enrollment contexts that expired before the cutoff.
func EnrollmentContextRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		return visitordb.New(tx).DeleteExpiredEnrollmentContexts(ctx, cutoff)
	})
}
