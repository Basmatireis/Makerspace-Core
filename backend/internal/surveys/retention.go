package surveys

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	surveysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/surveys/db"
	"github.com/jackc/pgx/v5"
)

// InvitationRetention clears the delivery identity of expired or redeemed
// invitations (unlink, the former admin cleanup step) or removes rows whose
// identity was already cleared (delete).
func InvitationRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		q := surveysdb.New(tx)
		switch action {
		case privacy.ActionUnlink:
			return q.DeleteExpiredSurveyInvitationPII(ctx, cutoff)
		case privacy.ActionDelete:
			unlinked, err := q.DeleteExpiredSurveyInvitationPII(ctx, cutoff)
			if err != nil {
				return 0, err
			}
			deleted, err := q.DeleteUnlinkedExpiredInvitations(ctx, cutoff)
			return unlinked + deleted, err
		default:
			return 0, privacy.ErrActionUnsupported
		}
	})
}
