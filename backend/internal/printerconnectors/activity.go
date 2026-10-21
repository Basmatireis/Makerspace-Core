package printerconnectors

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The activity log keeps what a connector changed automatically. It is pruned
// on every heartbeat of the connector to entries newer than ActivityRetention
// and to at most ActivityLimitPerConnector entries.
const (
	ActivityRetention         = 30 * 24 * time.Hour
	ActivityLimitPerConnector = 10000
	// ActivityMaxPageSize is the largest page ListActivity returns.
	ActivityMaxPageSize = 100
)

// ActivityKind is what a connector's runtime traffic changed in Core.
type ActivityKind string

const (
	ActivityEventIngested      ActivityKind = "event_ingested"
	ActivitySpoolAutoMounted   ActivityKind = "spool_auto_mounted"
	ActivitySpoolAutoUnmounted ActivityKind = "spool_auto_unmounted"
	ActivityRunRecorded        ActivityKind = "run_recorded"
	ActivityJobRunUpdated      ActivityKind = "job_run_updated"
)

// Activity is one automatic change caused by a connector. ResourceID is the
// printer event, slot, run or job, depending on Kind; ResourceLabel is the
// slot name or the run or job display ID while the resource exists.
type Activity struct {
	ID            uuid.UUID
	Kind          ActivityKind
	MachineID     *uuid.UUID
	MachineName   *string
	ResourceID    *uuid.UUID
	ResourceLabel *string
	EventKind     *printing.EventKind
	ChangedFields []string
	OccurredAt    time.Time
}

// ActivityPage is one page of a connector's activity log, newest first.
type ActivityPage struct {
	Items          []Activity
	Page, PageSize int
	Total          int64
}

type activityEntry struct {
	connectorID   uuid.UUID
	machineID     *uuid.UUID
	kind          ActivityKind
	resourceID    *uuid.UUID
	eventKind     *string
	changedFields []string
}

// recordActivity writes an activity entry in the transaction of the change it describes.
func recordActivity(ctx context.Context, q *db.Queries, entry activityEntry) error {
	fields := entry.changedFields
	if fields == nil {
		fields = []string{}
	}
	return q.InsertConnectorActivity(
		ctx,
		db.InsertConnectorActivityParams{
			ID:            ids.New(),
			ConnectorID:   entry.connectorID,
			MachineID:     entry.machineID,
			Kind:          string(entry.kind),
			ResourceID:    entry.resourceID,
			EventKind:     entry.eventKind,
			ChangedFields: fields,
		},
	)
}

// recordRunActivity logs what a connector event changed on its recorded run and the run's job.
func recordRunActivity(
	ctx context.Context,
	q *db.Queries,
	connectorID, machineID uuid.UUID,
	change machinelogbook.RecordedRunChange,
) error {
	if len(change.RunFields) > 0 {
		if err := recordActivity(ctx, q, activityEntry{
			connectorID:   connectorID,
			machineID:     &machineID,
			kind:          ActivityRunRecorded,
			resourceID:    &change.RunID,
			changedFields: change.RunFields,
		}); err != nil {
			return err
		}
	}
	if change.JobID == nil || len(change.JobFields) == 0 {
		return nil
	}
	return recordActivity(ctx, q, activityEntry{
		connectorID:   connectorID,
		machineID:     &machineID,
		kind:          ActivityJobRunUpdated,
		resourceID:    change.JobID,
		changedFields: change.JobFields,
	})
}

func pruneActivity(ctx context.Context, q *db.Queries, connectorID uuid.UUID, now time.Time) error {
	return q.PruneConnectorActivity(
		ctx,
		db.PruneConnectorActivityParams{
			ConnectorID: connectorID,
			Cutoff:      now.Add(-ActivityRetention),
			KeepCount:   ActivityLimitPerConnector,
		},
	)
}

// ListActivity returns one page of the connector's activity log, newest first.
// It needs the same permission as the connector's other diagnostics.
func (s *Service) ListActivity(
	ctx context.Context,
	principal authorization.Principal,
	connectorID uuid.UUID,
	page, pageSize int,
) (ActivityPage, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return ActivityPage{}, apperror.PermissionDenied
	}
	if page < 1 || pageSize < 1 || pageSize > ActivityMaxPageSize ||
		page > ActivityLimitPerConnector/pageSize+1 {
		return ActivityPage{}, apperror.Invalid("page or pageSize is out of range")
	}
	q := db.New(s.pool)
	if _, err := q.GetConnector(ctx, connectorID); errors.Is(err, pgx.ErrNoRows) {
		return ActivityPage{}, apperror.NotFound
	} else if err != nil {
		return ActivityPage{}, err
	}
	total, err := q.CountConnectorActivity(ctx, connectorID)
	if err != nil {
		return ActivityPage{}, err
	}
	rows, err := q.ListConnectorActivity(
		ctx,
		db.ListConnectorActivityParams{
			ConnectorID: connectorID,
			PageLimit:   int32(pageSize),              //nolint:gosec // bounded by ActivityMaxPageSize above
			PageOffset:  int32((page - 1) * pageSize), //nolint:gosec // bounded by ActivityLimitPerConnector above
		},
	)
	if err != nil {
		return ActivityPage{}, err
	}
	items := make([]Activity, 0, len(rows))
	for _, row := range rows {
		label := row.SlotName
		if row.RunDisplayID != nil {
			label = row.RunDisplayID
		} else if row.JobDisplayID != nil {
			label = row.JobDisplayID
		}
		var eventKind *printing.EventKind
		if row.EventKind != nil {
			value := printing.EventKind(*row.EventKind)
			eventKind = &value
		}
		items = append(
			items,
			Activity{
				ID:            row.ID,
				Kind:          ActivityKind(row.Kind),
				MachineID:     row.MachineID,
				MachineName:   row.MachineName,
				ResourceID:    row.ResourceID,
				ResourceLabel: label,
				EventKind:     eventKind,
				ChangedFields: row.ChangedFields,
				OccurredAt:    row.OccurredAt.UTC(),
			},
		)
	}
	return ActivityPage{Items: items, Page: page, PageSize: pageSize, Total: total}, nil
}
