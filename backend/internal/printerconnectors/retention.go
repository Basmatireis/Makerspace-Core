package printerconnectors

import (
	"context"
	"time"

	printerconnectorsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/jackc/pgx/v5"
)

// TelemetryRetention deletes connector activity and printer events that
// occurred before the cutoff. Events a recorded run still cites stay with
// that run; live status snapshots are operational state and are not touched.
func TelemetryRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		q := printerconnectorsdb.New(tx)
		activity, err := q.DeleteConnectorActivityBefore(ctx, cutoff)
		if err != nil {
			return 0, err
		}
		events, err := q.DeleteUnreferencedPrinterEventsBefore(ctx, cutoff)
		if err != nil {
			return activity, err
		}
		return activity + events, nil
	})
}
