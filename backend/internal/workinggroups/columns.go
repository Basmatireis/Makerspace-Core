package workinggroups

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	MaxColumnNameRunes = 40
	MaxColumns         = 20
	MaxTicketListRows  = 500
	MaxSubjectRunes    = 120
	MaxBodyRunes       = 2000
	MaxCommentRunes    = 2000
	MaxTodoTitleRunes  = 160
	MaxRepeatDays      = 730
)

// defaultColumns are the custom columns every new group starts with.
var defaultColumns = []string{"To do", "In progress"}

// SetColumns replaces the group's ordered column list. Entries with an ID are renamed and reordered, entries without
// one are created, columns missing from the list are deleted and their open tickets and to-dos move to the first
// column of the new list. At least one column must remain.
func (s *Service) SetColumns(
	ctx context.Context,
	p authorization.Principal,
	groupID uuid.UUID,
	columns []ColumnInput,
	requestID *uuid.UUID,
) (Group, error) {
	return s.mutate(ctx, p, groupID, false, func(q *workinggroupsdb.Queries, tx pgx.Tx) error {
		if len(columns) == 0 {
			return apperror.New(http.StatusUnprocessableEntity, "working_group_column_required", "A group needs at least one column")
		}
		if len(columns) > MaxColumns {
			return apperror.InvalidField("columns")
		}
		existing, err := q.ListWorkingGroupColumns(ctx, groupID)
		if err != nil {
			return err
		}
		current := map[uuid.UUID]string{}
		for _, column := range existing {
			current[column.ID] = column.Name
		}
		type entry struct {
			id      uuid.UUID
			name    string
			created bool
		}
		entries := make([]entry, 0, len(columns))
		kept := map[uuid.UUID]bool{}
		names := map[string]bool{}
		for _, input := range columns {
			name := strings.TrimSpace(input.Name)
			if name == "" || utf8.RuneCountInString(name) > MaxColumnNameRunes {
				return apperror.InvalidField("name")
			}
			if names[strings.ToLower(name)] {
				return apperror.Conflicting("working_group_column_exists", "Column names must be different")
			}
			names[strings.ToLower(name)] = true
			if input.ID == nil {
				entries = append(entries, entry{id: ids.New(), name: name, created: true})
				continue
			}
			if _, ok := current[*input.ID]; !ok || kept[*input.ID] {
				return withDetail(
					apperror.New(http.StatusUnprocessableEntity, "working_group_column_not_found", "A column does not belong to this group"),
					"columnId", *input.ID,
				)
			}
			kept[*input.ID] = true
			entries = append(entries, entry{id: *input.ID, name: name})
		}

		// Park the names of renamed and deleted columns first so a swap or a reused name never meets the unique index.
		var removed []uuid.UUID
		for _, column := range existing {
			switch {
			case !kept[column.ID]:
				removed = append(removed, column.ID)
			default:
				for _, e := range entries {
					if e.id == column.ID && !strings.EqualFold(e.name, column.Name) {
						if err := q.ParkWorkingGroupColumnName(ctx, workinggroupsdb.ParkWorkingGroupColumnNameParams{
							ID: column.ID, GroupID: groupID,
						}); err != nil {
							return err
						}
					}
				}
			}
		}
		for _, id := range removed {
			if err := q.ParkWorkingGroupColumnName(ctx, workinggroupsdb.ParkWorkingGroupColumnNameParams{
				ID: id, GroupID: groupID,
			}); err != nil {
				return err
			}
		}
		for position, e := range entries {
			if e.created {
				err = q.InsertWorkingGroupColumn(ctx, workinggroupsdb.InsertWorkingGroupColumnParams{
					ID: e.id, GroupID: groupID, Name: e.name, Position: int32(position),
				})
			} else {
				err = q.UpdateWorkingGroupColumn(ctx, workinggroupsdb.UpdateWorkingGroupColumnParams{
					ID: e.id, GroupID: groupID, Name: e.name, Position: int32(position),
				})
			}
			if err != nil {
				return uniqueConflict(err, "working_group_column_exists", "Column names must be different")
			}
		}
		for _, id := range removed {
			if err := q.MoveWorkingGroupTicketsToColumn(ctx, workinggroupsdb.MoveWorkingGroupTicketsToColumnParams{
				GroupID: groupID, FromColumnID: &id, ToColumnID: &entries[0].id,
			}); err != nil {
				return err
			}
			if err := q.MoveWorkingGroupTodosToColumn(ctx, workinggroupsdb.MoveWorkingGroupTodosToColumnParams{
				GroupID: groupID, FromColumnID: id, ToColumnID: entries[0].id,
			}); err != nil {
				return err
			}
			if err := q.DeleteWorkingGroupColumn(ctx, workinggroupsdb.DeleteWorkingGroupColumnParams{
				ID: id, GroupID: groupID,
			}); err != nil {
				return err
			}
		}
		return writeAudit(ctx, tx, p, "working_group_columns.changed", groupID, requestID, []string{"columns"})
	})
}

// isInside tells whether the caller is inside the group: a member of it or holding working_groups.manage.
func isInside(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, groupID uuid.UUID) (bool, error) {
	if p.Has(authorization.WorkingGroupsManage) {
		return true, nil
	}
	return q.IsWorkingGroupMember(ctx, workinggroupsdb.IsWorkingGroupMemberParams{GroupID: groupID, PersonID: p.PersonID})
}

func requireInside(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, groupID uuid.UUID) error {
	inside, err := isInside(ctx, q, p, groupID)
	if err != nil {
		return err
	}
	if !inside {
		return apperror.PermissionDenied
	}
	return nil
}

// requireColumn checks that the column belongs to the group.
func requireColumn(ctx context.Context, q *workinggroupsdb.Queries, groupID, columnID uuid.UUID) error {
	columns, err := q.ListWorkingGroupColumns(ctx, groupID)
	if err != nil {
		return err
	}
	for _, column := range columns {
		if column.ID == columnID {
			return nil
		}
	}
	return withDetail(
		apperror.New(http.StatusUnprocessableEntity, "working_group_column_not_found", "The column does not belong to this group"),
		"columnId", columnID,
	)
}

// requireAssignee checks that the assignee is a member of the group.
func requireAssignee(ctx context.Context, q *workinggroupsdb.Queries, groupID, personID uuid.UUID) error {
	member, err := q.IsWorkingGroupMember(ctx, workinggroupsdb.IsWorkingGroupMemberParams{GroupID: groupID, PersonID: personID})
	if err != nil {
		return err
	}
	if !member {
		return withDetail(
			apperror.New(http.StatusUnprocessableEntity, "assignee_not_in_group", "The assignee must be a member of the group"),
			"personId", personID,
		)
	}
	return nil
}

// writeTaskAudit records a change to a ticket or to-do by ids and changed field names only; subjects, titles, bodies,
// comments and answers are never written.
func writeTaskAudit(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	action, resourceType string,
	resourceID uuid.UUID,
	requestID *uuid.UUID,
	fields []string,
) error {
	account := p.AccountID
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &account,
		Action:         action,
		ResourceType:   resourceType,
		ResourceID:     &resourceID,
		RequestID:      requestID,
		ChangedFields:  fields,
	})
}

func timeValue(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	moment := value.Time.UTC()
	return &moment
}

func personRef(id *uuid.UUID, name string) *Person {
	if id == nil {
		return nil
	}
	return &Person{ID: *id, DisplayName: name}
}

func dateParam(value *time.Time) pgtype.Date {
	if value == nil {
		return pgtype.Date{}
	}
	return pgtype.Date{Time: time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC), Valid: true}
}

func dateValue(value pgtype.Date) *time.Time {
	if !value.Valid {
		return nil
	}
	day := time.Date(value.Time.Year(), value.Time.Month(), value.Time.Day(), 0, 0, 0, 0, time.UTC)
	return &day
}

func validateText(value, field string, maxRunes int, required bool) (string, error) {
	clean := strings.TrimSpace(value)
	if (required && clean == "") || utf8.RuneCountInString(clean) > maxRunes {
		return "", apperror.InvalidField(field)
	}
	return clean, nil
}

func stateConflict(message string) error {
	return apperror.Conflicting("working_group_task_state", message)
}
