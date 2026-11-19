package workinggroups

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// statusWindowDays is the number of calendar days, today included, that daysNotOkLast90 looks at.
const statusWindowDays = 90

// SetMachineStatus sets the status of a machine of the group. Inside people only; a machine that does not belong to
// this group answers 404. Setting ok clears note and date.
func (s *Service) SetMachineStatus(
	ctx context.Context,
	p authorization.Principal,
	groupID, machineID uuid.UUID,
	input StatusInput,
	requestID *uuid.UUID,
) (Group, error) {
	return s.setItemStatus(ctx, p, groupID, input, requestID, "working_group_machine", machineID,
		func(q *workinggroupsdb.Queries) (current, error) {
			row, err := q.GetWorkingGroupMachineStatus(ctx, workinggroupsdb.GetWorkingGroupMachineStatusParams{
				GroupID: groupID, MachineID: machineID,
			})
			return current{row.Status, row.StatusNote, dateValue(row.StatusUntil)}, err
		},
		func(q *workinggroupsdb.Queries, next current, at time.Time, by uuid.UUID) error {
			changed, err := q.SetWorkingGroupMachineStatus(ctx, workinggroupsdb.SetWorkingGroupMachineStatusParams{
				Status: next.status, StatusNote: next.note, StatusUntil: dateParam(next.until),
				ChangedAt: pgtype.Timestamptz{Time: at, Valid: true}, ChangedBy: &by, GroupID: groupID, MachineID: machineID,
			})
			if err != nil {
				return err
			}
			if changed == 0 {
				return apperror.NotFound
			}
			return q.InsertWorkingGroupStatusChange(ctx, workinggroupsdb.InsertWorkingGroupStatusChangeParams{
				ID: ids.New(), GroupID: groupID, MachineID: &machineID, Status: next.status, ChangedAt: at, ChangedByPersonID: &by,
			})
		})
}

// SetPlaceStatus sets the status of a place of the group, like SetMachineStatus.
func (s *Service) SetPlaceStatus(
	ctx context.Context,
	p authorization.Principal,
	groupID, placeID uuid.UUID,
	input StatusInput,
	requestID *uuid.UUID,
) (Group, error) {
	return s.setItemStatus(ctx, p, groupID, input, requestID, "working_group_place", placeID,
		func(q *workinggroupsdb.Queries) (current, error) {
			row, err := q.GetWorkingGroupPlaceStatus(ctx, workinggroupsdb.GetWorkingGroupPlaceStatusParams{
				GroupID: groupID, PlaceID: placeID,
			})
			return current{row.Status, row.StatusNote, dateValue(row.StatusUntil)}, err
		},
		func(q *workinggroupsdb.Queries, next current, at time.Time, by uuid.UUID) error {
			changed, err := q.SetWorkingGroupPlaceStatus(ctx, workinggroupsdb.SetWorkingGroupPlaceStatusParams{
				Status: next.status, StatusNote: next.note, StatusUntil: dateParam(next.until),
				ChangedAt: pgtype.Timestamptz{Time: at, Valid: true}, ChangedBy: &by, GroupID: groupID, PlaceID: placeID,
			})
			if err != nil {
				return err
			}
			if changed == 0 {
				return apperror.NotFound
			}
			return q.InsertWorkingGroupStatusChange(ctx, workinggroupsdb.InsertWorkingGroupStatusChangeParams{
				ID: ids.New(), GroupID: groupID, PlaceID: &placeID, Status: next.status, ChangedAt: at, ChangedByPersonID: &by,
			})
		})
}

type current struct {
	status string
	note   *string
	until  *time.Time
}

func (s *Service) setItemStatus(
	ctx context.Context,
	p authorization.Principal,
	groupID uuid.UUID,
	input StatusInput,
	requestID *uuid.UUID,
	resourceType string,
	itemID uuid.UUID,
	load func(q *workinggroupsdb.Queries) (current, error),
	store func(q *workinggroupsdb.Queries, next current, at time.Time, by uuid.UUID) error,
) (result Group, err error) {
	if err := requireRead(p); err != nil {
		return Group{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		if _, err := q.LockWorkingGroup(ctx, groupID); err != nil {
			return noRows(err)
		}
		if err := requireInside(ctx, q, p, groupID); err != nil {
			return err
		}
		before, err := load(q)
		if err != nil {
			return noRows(err)
		}
		next, err := validateStatus(input)
		if err != nil {
			return err
		}
		if before.status != next.status || !sameText(before.note, next.note) || !sameDate(before.until, next.until) {
			var fields []string
			if before.status != next.status {
				fields = append(fields, "status")
			}
			if !sameText(before.note, next.note) {
				fields = append(fields, "note")
			}
			if !sameDate(before.until, next.until) {
				fields = append(fields, "until")
			}
			if err := store(q, next, time.Now().UTC(), p.PersonID); err != nil {
				return err
			}
			if err := writeTaskAudit(ctx, tx, p, resourceType+".status_changed", resourceType, itemID, requestID, fields); err != nil {
				return err
			}
		}
		result, err = loadGroup(ctx, q, p, groupID)
		return err
	})
	return result, err
}

// validateStatus checks the new status. ok carries neither note nor date.
func validateStatus(input StatusInput) (current, error) {
	if !validUsage(input.Usage) {
		return current{}, apperror.InvalidField("status")
	}
	if input.Usage == UsageOK {
		return current{status: string(UsageOK)}, nil
	}
	next := current{status: string(input.Usage), until: input.Until}
	if input.Note != nil {
		note, err := validateText(*input.Note, "note", MaxStatusNoteRun, false)
		if err != nil {
			return current{}, err
		}
		if note != "" {
			next.note = &note
		}
	}
	if next.until != nil {
		day := time.Date(next.until.Year(), next.until.Month(), next.until.Day(), 0, 0, 0, 0, time.UTC)
		next.until = &day
	}
	return next, nil
}

// ListStatus lists the status of every machine and place of every group, items that are not ok first, then by name.
func (s *Service) ListStatus(ctx context.Context, p authorization.Principal) ([]StatusItem, error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	q := workinggroupsdb.New(s.pool)
	rows, err := q.ListWorkingGroupItemStatuses(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	windowStart := statusWindowStart(now, s.location)
	changes, err := q.ListWorkingGroupStatusChangesSince(ctx, windowStart)
	if err != nil {
		return nil, err
	}
	baselines, err := q.ListWorkingGroupStatusBaselines(ctx, windowStart)
	if err != nil {
		return nil, err
	}
	history := map[uuid.UUID][]statusPoint{}
	for _, row := range baselines {
		history[row.ItemID] = append(history[row.ItemID], statusPoint{Usage(row.Status), row.ChangedAt})
	}
	for _, row := range changes {
		history[row.ItemID] = append(history[row.ItemID], statusPoint{Usage(row.Status), row.ChangedAt})
	}
	items := make([]StatusItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, StatusItem{
			Kind: row.Kind, ID: row.ItemID, Name: row.ItemName, GroupID: row.GroupID, GroupName: row.GroupName,
			State: ItemState{
				Usage: Usage(row.Status), Note: row.StatusNote, Until: dateValue(row.StatusUntil),
				ChangedAt: timeValue(row.StatusChangedAt), ChangedBy: personRef(row.ChangedByPersonID, row.ChangedByDisplayName),
			},
			DaysNotOkLast90: daysNotOk(history[row.ItemID], now, s.location),
		})
	}
	slices.SortFunc(items, func(a, b StatusItem) int {
		if (a.State.Usage == UsageOK) != (b.State.Usage == UsageOK) {
			if a.State.Usage == UsageOK {
				return 1
			}
			return -1
		}
		if c := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); c != 0 {
			return c
		}
		return strings.Compare(a.ID.String(), b.ID.String())
	})
	return items, nil
}

type statusPoint struct {
	usage Usage
	at    time.Time
}

// statusWindowStart is local midnight of the first of the last 90 days.
func statusWindowStart(now time.Time, location *time.Location) time.Time {
	local := now.In(location)
	return time.Date(local.Year(), local.Month(), local.Day()-(statusWindowDays-1), 0, 0, 0, 0, location)
}

// daysNotOk counts the local calendar days of the last 90 on which the item was not ok at any moment. points are the
// changes in ascending time order; a first point before the window is the status the window starts with, and an item
// without any earlier change starts ok.
func daysNotOk(points []statusPoint, now time.Time, location *time.Location) int {
	start := statusWindowStart(now, location)
	dayOf := func(moment time.Time) int {
		local := moment.In(location)
		first := start
		a := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
		b := time.Date(first.Year(), first.Month(), first.Day(), 0, 0, 0, 0, time.UTC)
		return int(a.Sub(b).Hours() / 24)
	}
	var marked [statusWindowDays]bool
	mark := func(usage Usage, from, to time.Time) {
		if usage == UsageOK || !to.After(from) {
			return
		}
		for day := max(dayOf(from), 0); day <= dayOf(to.Add(-time.Nanosecond)) && day < statusWindowDays; day++ {
			marked[day] = true
		}
	}
	usage, cursor := UsageOK, start
	for _, point := range points {
		at := point.at
		if at.Before(start) {
			usage = point.usage
			continue
		}
		mark(usage, cursor, at)
		usage, cursor = point.usage, at
	}
	mark(usage, cursor, now)
	count := 0
	for _, on := range marked {
		if on {
			count++
		}
	}
	return count
}
