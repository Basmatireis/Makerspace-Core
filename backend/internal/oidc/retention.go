package oidc

import (
	"context"
	"time"

	oidcdb "github.com/Basmatireis/Makerspace-Core/backend/internal/oidc/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/jackc/pgx/v5"
)

// FlowRetention deletes expired or used OIDC flows before the cutoff.
func FlowRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		return oidcdb.New(tx).DeleteExpiredFlows(ctx, cutoff)
	})
}
