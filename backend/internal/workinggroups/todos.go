package workinggroups

import (
	"context"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ListTodos lists the open and done to-dos of the groups the caller is inside, optionally of one group. For everybody
// else the result is empty: to-dos are never shown outside the group.
func (s *Service) ListTodos(ctx context.Context, p authorization.Principal, groupID *uuid.UUID) ([]Todo, error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	rows, err := workinggroupsdb.New(s.pool).ListWorkingGroupTodos(ctx, workinggroupsdb.ListWorkingGroupTodosParams{
		CallerPersonID: &p.PersonID, CallerManage: p.Has(authorization.WorkingGroupsManage), CallerFinance: isFinance(p), GroupID: groupID,
		RowLimit: MaxTicketListRows,
	})
	if err != nil {
		return nil, err
	}
	items := make([]Todo, 0, len(rows))
	for _, row := range rows {
		items = append(items, todoFromRow(row))
	}
	return items, nil
}

// GetTodo returns one to-do with its comments; for a caller outside the group it does not exist (404).
func (s *Service) GetTodo(ctx context.Context, p authorization.Principal, id uuid.UUID) (TodoDetail, error) {
	if err := requireRead(p); err != nil {
		return TodoDetail{}, err
	}
	return loadTodoDetail(ctx, workinggroupsdb.New(s.pool), p, id)
}

// CreateTodo adds a to-do to a group the caller is inside. Without a column it goes to the group's first column.
func (s *Service) CreateTodo(
	ctx context.Context,
	p authorization.Principal,
	input CreateTodoInput,
	requestID *uuid.UUID,
) (result TodoDetail, err error) {
	if err := requireRead(p); err != nil {
		return TodoDetail{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		if _, err := q.LockWorkingGroup(ctx, input.GroupID); err != nil {
			return noRows(err)
		}
		if err := requireInside(ctx, q, p, input.GroupID); err != nil {
			return err
		}
		title, err := validateText(input.Title, "title", MaxTodoTitleRunes, true)
		if err != nil {
			return err
		}
		if input.DueOn.IsZero() {
			return apperror.InvalidField("dueOn")
		}
		if err := validateRepeat(input.RepeatEveryDays); err != nil {
			return err
		}
		if input.AssigneePersonID != nil {
			if err := requireAssignee(ctx, q, input.GroupID, *input.AssigneePersonID); err != nil {
				return err
			}
		}
		var column uuid.UUID
		if input.ColumnID != nil {
			if err := requireColumn(ctx, q, input.GroupID, *input.ColumnID); err != nil {
				return err
			}
			column = *input.ColumnID
		} else {
			columns, err := q.ListWorkingGroupColumns(ctx, input.GroupID)
			if err != nil {
				return err
			}
			if len(columns) == 0 {
				return apperror.New(http.StatusUnprocessableEntity, "working_group_column_required", "The group has no column")
			}
			column = columns[0].ID
		}
		id := ids.New()
		creator := p.PersonID
		if err := q.CreateWorkingGroupTodo(ctx, workinggroupsdb.CreateWorkingGroupTodoParams{
			ID: id, GroupID: input.GroupID, Title: title, AssigneePersonID: input.AssigneePersonID,
			DueOn: dateParam(&input.DueOn), ColumnID: column, RepeatEveryDays: intPtr32(input.RepeatEveryDays),
			CreatedByPersonID: &creator,
		}); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_todo.created", "working_group_todo", id, requestID,
			[]string{"groupId", "title", "assigneePersonId", "dueOn", "columnId", "repeatEveryDays"}); err != nil {
			return err
		}
		result, err = loadTodoDetail(ctx, q, p, id)
		return err
	})
	return result, err
}

// UpdateTodo changes the fields that are set under optimistic locking.
func (s *Service) UpdateTodo(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input UpdateTodoInput,
	requestID *uuid.UUID,
) (TodoDetail, error) {
	return s.changeTodo(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTodoCoreRow) error {
		if input.ExpectedVersion < 1 {
			return apperror.Invalid("expectedVersion must be positive")
		}
		if core.Version != input.ExpectedVersion {
			return apperror.StaleWrite
		}
		title, assignee, due, column, repeat := core.Title, core.AssigneePersonID, dateValue(core.DueOn), core.ColumnID, core.RepeatEveryDays
		var changed []string
		if input.Title != nil {
			clean, err := validateText(*input.Title, "title", MaxTodoTitleRunes, true)
			if err != nil {
				return err
			}
			if clean != title {
				title = clean
				changed = append(changed, "title")
			}
		}
		if input.Assignee.Set && !sameID(input.Assignee.Value, assignee) {
			if input.Assignee.Value != nil {
				if err := requireAssignee(ctx, q, core.GroupID, *input.Assignee.Value); err != nil {
					return err
				}
			}
			assignee = input.Assignee.Value
			changed = append(changed, "assigneePersonId")
		}
		if input.DueOn != nil {
			if input.DueOn.IsZero() {
				return apperror.InvalidField("dueOn")
			}
			if !sameDate(input.DueOn, due) {
				due = input.DueOn
				changed = append(changed, "dueOn")
			}
		}
		if input.ColumnID != nil && *input.ColumnID != column {
			if err := requireColumn(ctx, q, core.GroupID, *input.ColumnID); err != nil {
				return err
			}
			column = *input.ColumnID
			changed = append(changed, "columnId")
		}
		if input.RepeatEveryDays.Set {
			if err := validateRepeat(input.RepeatEveryDays.Value); err != nil {
				return err
			}
			var current *int
			if repeat != nil {
				value := int(*repeat)
				current = &value
			}
			if !sameInt(input.RepeatEveryDays.Value, current) {
				repeat = intPtr32(input.RepeatEveryDays.Value)
				changed = append(changed, "repeatEveryDays")
			}
		}
		if len(changed) == 0 {
			return nil
		}
		if _, err := q.UpdateWorkingGroupTodo(ctx, workinggroupsdb.UpdateWorkingGroupTodoParams{
			ID: id, Title: title, AssigneePersonID: assignee, DueOn: dateParam(due), ColumnID: column, RepeatEveryDays: repeat,
		}); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_todo.updated", "working_group_todo", id, requestID, changed)
	})
}

// MarkTodoDone marks a to-do as done. A repeating to-do creates the next open one with the same title, assignee,
// column and repeat and a due date of today plus the repeat interval, in the same transaction.
func (s *Service) MarkTodoDone(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (result TodoDetail, err error) {
	var next *uuid.UUID
	result, err = s.changeTodo(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTodoCoreRow) error {
		if core.DoneAt.Valid {
			return stateConflict("The to-do is already done")
		}
		if _, err := q.SetWorkingGroupTodoDone(ctx, workinggroupsdb.SetWorkingGroupTodoDoneParams{ID: id, Done: true}); err != nil {
			return err
		}
		fields := []string{"doneAt"}
		successor := false
		if core.RepeatEveryDays != nil {
			exists, existsErr := q.OpenWorkingGroupTodoSuccessorExists(ctx, workinggroupsdb.OpenWorkingGroupTodoSuccessorExistsParams{
				GroupID: core.GroupID, Title: core.Title, RepeatEveryDays: *core.RepeatEveryDays, ID: id,
			})
			if existsErr != nil {
				return existsErr
			}
			successor = exists
		}
		if core.RepeatEveryDays != nil && !successor {
			assignee := core.AssigneePersonID
			if assignee != nil {
				member, err := q.IsWorkingGroupMember(ctx, workinggroupsdb.IsWorkingGroupMemberParams{
					GroupID: core.GroupID, PersonID: *assignee,
				})
				if err != nil {
					return err
				}
				if !member {
					assignee = nil
				}
			}
			now := time.Now().In(s.location)
			due := time.Date(now.Year(), now.Month(), now.Day()+int(*core.RepeatEveryDays), 0, 0, 0, 0, time.UTC)
			nextID := ids.New()
			creator := p.PersonID
			if err := q.CreateWorkingGroupTodo(ctx, workinggroupsdb.CreateWorkingGroupTodoParams{
				ID: nextID, GroupID: core.GroupID, Title: core.Title, AssigneePersonID: assignee, DueOn: dateParam(&due),
				ColumnID: core.ColumnID, RepeatEveryDays: core.RepeatEveryDays, CreatedByPersonID: &creator,
			}); err != nil {
				return err
			}
			if err := writeTaskAudit(ctx, tx, p, "working_group_todo.created", "working_group_todo", nextID, requestID,
				[]string{"groupId", "title", "assigneePersonId", "dueOn", "columnId", "repeatEveryDays"}); err != nil {
				return err
			}
			next = &nextID
			fields = append(fields, "nextTodoId")
		}
		return writeTaskAudit(ctx, tx, p, "working_group_todo.done", "working_group_todo", id, requestID, fields)
	})
	result.NextTodoID = next
	return result, err
}

// ReopenTodo clears the done mark of a to-do.
func (s *Service) ReopenTodo(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (TodoDetail, error) {
	return s.changeTodo(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTodoCoreRow) error {
		if !core.DoneAt.Valid {
			return stateConflict("The to-do is not done")
		}
		if _, err := q.SetWorkingGroupTodoDone(ctx, workinggroupsdb.SetWorkingGroupTodoDoneParams{ID: id, Done: false}); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_todo.reopened", "working_group_todo", id, requestID, []string{"doneAt"})
	})
}

// DeleteTodo removes a to-do with its comments for good.
func (s *Service) DeleteTodo(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	_, err := s.changeTodo(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, _ workinggroupsdb.GetWorkingGroupTodoCoreRow) error {
		if _, err := q.DeleteWorkingGroupTodo(ctx, id); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_todo.deleted", "working_group_todo", id, requestID, nil)
	})
	return err
}

// DeleteTodoComment removes one comment of a to-do for good. Only working_groups.manage may; people outside the group
// get 404 like for every to-do operation.
func (s *Service) DeleteTodoComment(
	ctx context.Context,
	p authorization.Principal,
	id, commentID uuid.UUID,
	requestID *uuid.UUID,
) (TodoDetail, error) {
	return s.changeTodo(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, _ workinggroupsdb.GetWorkingGroupTodoCoreRow) error {
		if !p.Has(authorization.WorkingGroupsManage) {
			return apperror.PermissionDenied
		}
		removed, err := q.DeleteWorkingGroupTodoComment(ctx, workinggroupsdb.DeleteWorkingGroupTodoCommentParams{ID: commentID, TodoID: &id})
		if err != nil {
			return err
		}
		if removed == 0 {
			return apperror.NotFound
		}
		return writeTaskAudit(ctx, tx, p, "working_group_comment.deleted", "working_group_comment", commentID, requestID, nil)
	})
}

// AddTodoComment adds a comment to a to-do; to-do comments are only ever seen inside the group.
func (s *Service) AddTodoComment(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input CommentInput,
	requestID *uuid.UUID,
) (TodoDetail, error) {
	return s.changeTodo(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, _ workinggroupsdb.GetWorkingGroupTodoCoreRow) error {
		text, err := validateText(input.Text, "text", MaxCommentRunes, true)
		if err != nil {
			return err
		}
		author := p.PersonID
		if err := q.AddWorkingGroupComment(ctx, workinggroupsdb.AddWorkingGroupCommentParams{
			ID: ids.New(), TodoID: &id, AuthorPersonID: &author, Text: text, Internal: true,
		}); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_todo.commented", "working_group_todo", id, requestID, []string{"comments"})
	})
}

// changeTodo runs one change of a to-do: read permission, to-do lookup, the group lock, the to-do read again under
// the lock, the inside check (a caller outside the group gets 404, as if the to-do did not exist), the change with
// its audit event and the reloaded to-do.
func (s *Service) changeTodo(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	change func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTodoCoreRow) error,
) (result TodoDetail, err error) {
	if err := requireRead(p); err != nil {
		return TodoDetail{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		core, err := q.GetWorkingGroupTodoCore(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if _, err := q.LockWorkingGroup(ctx, core.GroupID); err != nil {
			return noRows(err)
		}
		inside, err := isInside(ctx, q, p, core.GroupID)
		if err != nil {
			return err
		}
		if !inside {
			return apperror.NotFound
		}
		core, err = q.GetWorkingGroupTodoCore(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if err := change(q, tx, core); err != nil {
			return err
		}
		result, err = loadTodoDetail(ctx, q, p, id)
		if apperror.IsCode(err, "not_found") {
			// Deleted by this very change.
			return nil
		}
		return err
	})
	return result, err
}

func loadTodoDetail(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, id uuid.UUID) (TodoDetail, error) {
	rows, err := q.ListWorkingGroupTodos(ctx, workinggroupsdb.ListWorkingGroupTodosParams{
		CallerPersonID: &p.PersonID, CallerManage: p.Has(authorization.WorkingGroupsManage), CallerFinance: isFinance(p), ID: &id, RowLimit: 1,
	})
	if err != nil {
		return TodoDetail{}, err
	}
	if len(rows) == 0 {
		return TodoDetail{}, apperror.NotFound
	}
	comments, err := q.ListWorkingGroupTodoComments(ctx, &id)
	if err != nil {
		return TodoDetail{}, err
	}
	detail := TodoDetail{Todo: todoFromRow(rows[0]), Comments: make([]Comment, 0, len(comments))}
	for _, c := range comments {
		detail.Comments = append(detail.Comments, Comment{
			ID: c.ID, Author: personRef(c.AuthorPersonID, c.AuthorName), Text: c.Text, Internal: c.Internal, CreatedAt: c.CreatedAt,
		})
	}
	return detail, nil
}

func todoFromRow(row workinggroupsdb.ListWorkingGroupTodosRow) Todo {
	due := dateValue(row.DueOn)
	var repeat *int
	if row.RepeatEveryDays != nil {
		value := int(*row.RepeatEveryDays)
		repeat = &value
	}
	return Todo{
		ID: row.ID, GroupID: row.GroupID, GroupName: row.GroupName, Title: row.Title,
		Assignee: personRef(row.AssigneePersonID, row.AssigneeName), CreatedBy: personRef(row.CreatedByPersonID, row.CreatorName),
		DueOn: *due, ColumnID: row.ColumnID, RepeatEveryDays: repeat, Done: row.DoneAt.Valid, DoneAt: timeValue(row.DoneAt),
		IsMine: row.IsMine, CommentCount: row.CommentCount, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		Link: taskLink(row.LinkKind, row.LinkID, row.LinkTitle, row.LinkStatus),
	}
}

func validateRepeat(days *int) error {
	if days != nil && (*days < 1 || *days > MaxRepeatDays) {
		return apperror.InvalidField("repeatEveryDays")
	}
	return nil
}

func intPtr32(value *int) *int32 {
	if value == nil {
		return nil
	}
	result := int32(*value)
	return &result
}

func sameInt(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
