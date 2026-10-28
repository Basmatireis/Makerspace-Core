package signage

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/jackc/pgx/v5"
)

// AnnouncementRetention deletes announcements that ended before the cutoff
// (values cascade), audited per announcement; it replaces the sweep that ran
// lazily on player traffic.
func AnnouncementRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		ids, err := signagedb.New(tx).DeleteExpiredSignageAnnouncements(ctx, cutoff)
		if err != nil {
			return 0, err
		}
		for index := range ids {
			if err := audit.Write(ctx, tx, audit.Event{
				ActorType:    "system",
				Source:       "system",
				Action:       "signage_announcement.expired",
				ResourceType: "signage_announcement",
				ResourceID:   &ids[index],
			}); err != nil {
				return 0, err
			}
		}
		return int64(len(ids)), nil
	})
}
