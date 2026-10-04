package events

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ListTaskLists(ctx context.Context, principal authorization.Principal, eventID uuid.UUID) ([]TaskList, error) {
	if !canRead(principal) {
		return nil, apperror.PermissionDenied
	}
	rows, err := eventsdb.New(s.pool).ListEventTaskLists(ctx, eventID)
	if err != nil {
		return nil, err
	}
	result := make([]TaskList, 0, len(rows))
	for _, row := range rows {
		result = append(result, taskListFromRow(row))
	}
	return result, nil
}
func (s *Service) CreateTaskList(ctx context.Context, principal authorization.Principal, eventID uuid.UUID, input TaskListInput, requestID *uuid.UUID) (TaskList, error) {
	if !principal.Has(authorization.EventsManage) {
		return TaskList{}, apperror.PermissionDenied
	}
	name, err := cleanRequired(input.Name, "name", 200)
	if err != nil {
		return TaskList{}, err
	}
	description, err := cleanOptional(input.Description, 10000)
	if err != nil {
		return TaskList{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TaskList{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, true); err != nil {
		return TaskList{}, err
	}
	id := uuid.Must(uuid.NewV7())
	row, err := q.CreateEventTaskList(ctx, eventsdb.CreateEventTaskListParams{ID: id, EventID: eventID, Name: name, Description: description, SortOrder: int32(input.SortOrder)})
	if err != nil {
		return TaskList{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_task_list.created", "event_task_list", id, requestID, []string{"name", "description", "sortOrder"}, map[string]any{"eventId": eventID.String()}); err != nil {
		return TaskList{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return TaskList{}, err
	}
	return taskListFromRow(row), nil
}
func (s *Service) UpdateTaskList(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, input TaskListInput, requestID *uuid.UUID) (TaskList, error) {
	if !principal.Has(authorization.EventsManage) {
		return TaskList{}, apperror.PermissionDenied
	}
	if err := validateVersion(input.ExpectedVersion); err != nil {
		return TaskList{}, err
	}
	name, err := cleanRequired(input.Name, "name", 200)
	if err != nil {
		return TaskList{}, err
	}
	description, err := cleanOptional(input.Description, 10000)
	if err != nil {
		return TaskList{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TaskList{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, true); err != nil {
		return TaskList{}, err
	}
	current, err := q.GetEventTaskList(ctx, eventsdb.GetEventTaskListParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return TaskList{}, apperror.NotFound
	}
	if err != nil {
		return TaskList{}, err
	}
	if int64(current.Version) != input.ExpectedVersion {
		return TaskList{}, apperror.StaleWrite
	}
	row, err := q.UpdateEventTaskList(ctx, eventsdb.UpdateEventTaskListParams{Name: name, Description: description, SortOrder: int32(input.SortOrder), ID: id, EventID: eventID, ExpectedVersion: int32(input.ExpectedVersion)})
	if err != nil {
		return TaskList{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_task_list.updated", "event_task_list", id, requestID, []string{"name", "description", "sortOrder"}, map[string]any{"eventId": eventID.String()}); err != nil {
		return TaskList{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return TaskList{}, err
	}
	return taskListFromRow(row), nil
}
func (s *Service) DeleteTaskList(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
	if !principal.Has(authorization.EventsManage) {
		return apperror.PermissionDenied
	}
	if err := validateVersion(expected); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, true); err != nil {
		return err
	}
	current, err := q.GetEventTaskList(ctx, eventsdb.GetEventTaskListParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if int64(current.Version) != expected {
		return apperror.StaleWrite
	}
	if _, err = q.DeleteEventTaskList(ctx, eventsdb.DeleteEventTaskListParams{ID: id, EventID: eventID, ExpectedVersion: int32(expected)}); err != nil {
		return databaseError(err)
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_task_list.deleted", "event_task_list", id, requestID, nil, map[string]any{"eventId": eventID.String()}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) ListTasks(ctx context.Context, principal authorization.Principal, eventID uuid.UUID) ([]Task, error) {
	if !canRead(principal) {
		return nil, apperror.PermissionDenied
	}
	rows, err := eventsdb.New(s.pool).ListEventTasks(ctx, eventID)
	if err != nil {
		return nil, err
	}
	result := make([]Task, 0, len(rows))
	for _, row := range rows {
		result = append(result, taskFromRow(row))
	}
	return result, nil
}
func (s *Service) CreateTask(ctx context.Context, principal authorization.Principal, eventID uuid.UUID, input TaskInput, requestID *uuid.UUID) (Task, error) {
	if !principal.Has(authorization.EventsManage) {
		return Task{}, apperror.PermissionDenied
	}
	input, err := validateTaskInput(input)
	if err != nil {
		return Task{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Task{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, true); err != nil {
		return Task{}, err
	}
	id := uuid.Must(uuid.NewV7())
	var completedAt *time.Time
	var completedBy *uuid.UUID
	if input.Status == "done" {
		now := time.Now().UTC()
		completedAt = &now
		actor := principal.AccountID
		completedBy = &actor
	}
	row, err := q.CreateEventTask(ctx, eventsdb.CreateEventTaskParams{ID: id, EventID: eventID, TaskListID: input.TaskListID, Title: input.Title, Description: input.Description, Status: input.Status, Priority: input.Priority, AssigneePersonID: input.AssigneePersonID, DueAt: toPGTime(input.DueAt), CompletedAt: toPGTime(completedAt), CompletedByAccountID: completedBy, SortOrder: int32(input.SortOrder), CreatedByAccountID: &principal.AccountID})
	if err != nil {
		return Task{}, databaseError(err)
	}
	action := "event_task.created"
	if input.Status == "done" {
		action = "event_task.completed"
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, action, "event_task", id, requestID, []string{"taskListId", "title", "description", "status", "priority", "assigneePersonId", "dueAt", "sortOrder"}, map[string]any{"eventId": eventID.String()}); err != nil {
		return Task{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Task{}, err
	}
	return taskFromRow(row), nil
}
func (s *Service) UpdateTask(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, input TaskInput, requestID *uuid.UUID) (Task, error) {
	if !principal.Has(authorization.EventsManage) {
		return Task{}, apperror.PermissionDenied
	}
	if err := validateVersion(input.ExpectedVersion); err != nil {
		return Task{}, err
	}
	input, err := validateTaskInput(input)
	if err != nil {
		return Task{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Task{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, true); err != nil {
		return Task{}, err
	}
	current, err := q.GetEventTask(ctx, eventsdb.GetEventTaskParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Task{}, apperror.NotFound
	}
	if err != nil {
		return Task{}, err
	}
	if int64(current.Version) != input.ExpectedVersion {
		return Task{}, apperror.StaleWrite
	}
	completedAt := pgTime(current.CompletedAt)
	completedBy := current.CompletedByAccountID
	action := "event_task.updated"
	if input.Status == "done" && current.Status != "done" {
		now := time.Now().UTC()
		completedAt = &now
		actor := principal.AccountID
		completedBy = &actor
		action = "event_task.completed"
	} else if input.Status != "done" && current.Status == "done" {
		completedAt = nil
		completedBy = nil
		action = "event_task.reopened"
	}
	row, err := q.UpdateEventTask(ctx, eventsdb.UpdateEventTaskParams{TaskListID: input.TaskListID, Title: input.Title, Description: input.Description, Status: input.Status, Priority: input.Priority, AssigneePersonID: input.AssigneePersonID, DueAt: toPGTime(input.DueAt), CompletedAt: toPGTime(completedAt), CompletedByAccountID: completedBy, SortOrder: int32(input.SortOrder), ID: id, EventID: eventID, ExpectedVersion: int32(input.ExpectedVersion)})
	if err != nil {
		return Task{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, action, "event_task", id, requestID, []string{"taskListId", "title", "description", "status", "priority", "assigneePersonId", "dueAt", "sortOrder"}, map[string]any{"eventId": eventID.String()}); err != nil {
		return Task{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Task{}, err
	}
	return taskFromRow(row), nil
}
func (s *Service) DeleteTask(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
	if !principal.Has(authorization.EventsManage) {
		return apperror.PermissionDenied
	}
	if err := validateVersion(expected); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, true); err != nil {
		return err
	}
	current, err := q.GetEventTask(ctx, eventsdb.GetEventTaskParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if int64(current.Version) != expected {
		return apperror.StaleWrite
	}
	if _, err = q.DeleteEventTask(ctx, eventsdb.DeleteEventTaskParams{ID: id, EventID: eventID, ExpectedVersion: int32(expected)}); err != nil {
		return databaseError(err)
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_task.deleted", "event_task", id, requestID, nil, map[string]any{"eventId": eventID.String()}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validateTaskInput(input TaskInput) (TaskInput, error) {
	var err error
	input.Title, err = cleanRequired(input.Title, "title", 300)
	if err != nil {
		return input, err
	}
	input.Description, err = cleanOptional(input.Description, 10000)
	if err != nil {
		return input, err
	}
	if input.Status == "" {
		input.Status = "open"
	}
	switch input.Status {
	case "open", "in_progress", "blocked", "done", "cancelled":
	default:
		return input, validation("task status is invalid")
	}
	if input.Priority == "" {
		input.Priority = "normal"
	}
	switch input.Priority {
	case "low", "normal", "high", "urgent":
	default:
		return input, validation("task priority is invalid")
	}
	return input, nil
}
func taskListFromRow(row eventsdb.EventTaskList) TaskList {
	return TaskList{ID: row.ID, EventID: row.EventID, Name: row.Name, Description: row.Description, SortOrder: int(row.SortOrder), Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func taskFromRow(row eventsdb.EventTask) Task {
	return Task{ID: row.ID, EventID: row.EventID, TaskListID: row.TaskListID, Title: row.Title, Description: row.Description, Status: row.Status, Priority: row.Priority, AssigneePersonID: row.AssigneePersonID, DueAt: pgTime(row.DueAt), CompletedAt: pgTime(row.CompletedAt), CompletedByAccount: row.CompletedByAccountID, SortOrder: int(row.SortOrder), Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
