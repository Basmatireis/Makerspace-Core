package attendance

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/jackc/pgx/v5"
)

// VisitRetention is the retention handler of attendance visits. Check-out already rolls every visit into the
// non-identifying daily statistics and deletes it, and voiding deletes an open visit, so no completed visit is left
// for retention; open visits are never touched. The handler stays registered so the category keeps a working policy.
func VisitRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(_ context.Context, _ pgx.Tx, action privacy.Action, _ time.Time, _ int32) (int64, error) {
		if action != privacy.ActionAnonymize && action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		return 0, nil
	})
}
