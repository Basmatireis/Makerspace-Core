package notifyrules

import (
	"context"
	"fmt"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

func notifyrulesdbRange(from, to time.Time) notifyrulesdb.CountScheduledOpenDaysBetweenParams {
	return notifyrulesdb.CountScheduledOpenDaysBetweenParams{FromTime: from, ToTime: to}
}

func pgtypeTime(at time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: at, Valid: true} }

// activityResult is the tag a firing carries in the log.
func activityResult(test bool, resolved bool, escalated, reached, throttled, total int64) string {
	switch {
	case test:
		return "test"
	case resolved:
		return "resolved"
	case escalated > 0:
		return "escalated"
	case total > 0 && throttled == total:
		return "throttled"
	case reached == 0:
		return "skipped"
	}
	return "delivered"
}

func (s *Service) activity(ctx context.Context, q *store, rule *uuid.UUID, page, pageSize int) (ActivityPage, error) {
	total, err := q.CountActivity(ctx, rule)
	if err != nil {
		return ActivityPage{}, fmt.Errorf("count activity: %w", err)
	}
	rows, err := q.ListActivity(ctx, notifyrulesdb.ListActivityParams{
		RuleID: rule, PageLimit: int32(pageSize), PageOffset: int32((page - 1) * pageSize),
	})
	if err != nil {
		return ActivityPage{}, fmt.Errorf("list activity: %w", err)
	}
	firingIDs := make([]uuid.UUID, len(rows))
	for i, row := range rows {
		firingIDs[i] = row.ID
	}
	recipientRows, err := q.ListActivityRecipients(ctx, uuidStrings(firingIDs))
	if err != nil {
		return ActivityPage{}, fmt.Errorf("list activity recipients: %w", err)
	}
	byFiring := map[uuid.UUID][]ActivityRecipient{}
	channels := map[uuid.UUID][]Channel{}
	for _, row := range recipientRows {
		name := ""
		if row.FirstName != nil {
			name = personName(*row.FirstName, derefText(row.LastName))
		}
		channel := Channel(row.Channel)
		byFiring[row.FiringID] = append(byFiring[row.FiringID], ActivityRecipient{
			Name: name, Channel: channel, Step: int(row.Step), Status: row.Status, SentAt: row.SentAt,
			ReadAt: epochPointer(row.ReadEpoch),
		})
		if (row.Status == statusSent || row.Status == statusFallback) && !containsChannel(channels[row.FiringID], channel) {
			channels[row.FiringID] = append(channels[row.FiringID], channel)
		}
	}
	page_ := ActivityPage{Total: total, Page: page, PageSize: pageSize, Items: make([]ActivityFiring, 0, len(rows))}
	for _, row := range rows {
		firing := ActivityFiring{
			ID: row.ID, RuleID: row.RuleID, RuleName: row.RuleName, Trigger: row.TriggerType, Summary: row.Summary,
			Channels: channels[row.ID], Reached: row.Reached, ResolvedReason: row.ResolvedReason, CreatedAt: row.CreatedAt,
			Result:     activityResult(row.Test, row.ResolvedAt.Valid, row.Escalated, row.Reached, row.Throttled, row.Total),
			Recipients: byFiring[row.ID],
		}
		if firing.Channels == nil {
			firing.Channels = []Channel{}
		}
		if firing.Recipients == nil {
			firing.Recipients = []ActivityRecipient{}
		}
		page_.Items = append(page_.Items, firing)
	}
	return page_, nil
}

func derefText(text *string) string {
	if text == nil {
		return ""
	}
	return *text
}

func containsChannel(list []Channel, channel Channel) bool {
	for _, item := range list {
		if item == channel {
			return true
		}
	}
	return false
}

func epochPointer(epoch float64) *time.Time {
	if epoch <= 0 {
		return nil
	}
	at := time.UnixMicro(int64(epoch * 1e6)).UTC()
	return &at
}
