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

// ListTickets lists the tickets of every group, open ones first and then the newest closed ones up to the cap (the
// second result says whether more matched), optionally of one group or one status. Everybody with
// working_groups.read sees every ticket; Inside says whether the caller may also work on it.
func (s *Service) ListTickets(ctx context.Context, p authorization.Principal, filter TicketFilter) ([]Ticket, bool, error) {
	if err := requireRead(p); err != nil {
		return nil, false, err
	}
	var status *string
	if filter.Status != nil {
		if !validStatus(*filter.Status) {
			return nil, false, apperror.InvalidField("status")
		}
		value := string(*filter.Status)
		status = &value
	}
	rows, err := workinggroupsdb.New(s.pool).ListWorkingGroupTickets(ctx, workinggroupsdb.ListWorkingGroupTicketsParams{
		CallerPersonID: p.PersonID,
		CallerManage:   p.Has(authorization.WorkingGroupsManage),
		CallerFinance:  isFinance(p),
		GroupID:        filter.GroupID,
		Status:         status,
		RowLimit:       MaxTicketListRows + 1,
	})
	if err != nil {
		return nil, false, err
	}
	truncated := len(rows) > MaxTicketListRows
	if truncated {
		rows = rows[:MaxTicketListRows]
	}
	items := make([]Ticket, 0, len(rows))
	for _, row := range rows {
		items = append(items, ticketFromRow(row))
	}
	return items, truncated, nil
}

// GetTicket returns one ticket with its followers and the comments the caller may see.
func (s *Service) GetTicket(ctx context.Context, p authorization.Principal, id uuid.UUID) (TicketDetail, error) {
	if err := requireRead(p); err != nil {
		return TicketDetail{}, err
	}
	return loadTicketDetail(ctx, workinggroupsdb.New(s.pool), p, id)
}

// CreateTicket writes a ticket for a group. Everybody with working_groups.read may.
func (s *Service) CreateTicket(
	ctx context.Context,
	p authorization.Principal,
	input CreateTicketInput,
	requestID *uuid.UUID,
) (result TicketDetail, err error) {
	if err := requireRead(p); err != nil {
		return TicketDetail{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		if _, err := q.LockWorkingGroup(ctx, input.GroupID); err != nil {
			return noRows(err)
		}
		if !validKind(input.Kind) {
			return apperror.InvalidField("kind")
		}
		subject, err := validateText(input.Subject, "subject", MaxSubjectRunes, true)
		if err != nil {
			return err
		}
		body, err := validateText(input.Body, "body", MaxBodyRunes, false)
		if err != nil {
			return err
		}
		if input.MachineID != nil {
			belongs, err := q.MachineBelongsToWorkingGroup(ctx, workinggroupsdb.MachineBelongsToWorkingGroupParams{
				GroupID: input.GroupID, MachineID: *input.MachineID,
			})
			if err != nil {
				return err
			}
			if !belongs {
				return withDetail(
					apperror.New(http.StatusUnprocessableEntity, "machine_not_in_working_group", "The machine does not belong to this group"),
					"machineId", *input.MachineID,
				)
			}
		}
		id := ids.New()
		author := p.PersonID
		if err := q.CreateWorkingGroupTicket(ctx, workinggroupsdb.CreateWorkingGroupTicketParams{
			ID: id, GroupID: input.GroupID, MachineID: input.MachineID, Kind: string(input.Kind), Subject: subject,
			Body: body, BlocksUse: input.BlocksUse, AuthorPersonID: &author,
		}); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_ticket.created", "working_group_ticket", id, requestID,
			[]string{"groupId", "machineId", "kind", "subject", "body", "blocksUse"}); err != nil {
			return err
		}
		result, err = loadTicketDetail(ctx, q, p, id)
		return err
	})
	return result, err
}

// PlanTicket moves a new ticket into a column with an assignee and a due date. Inside people only.
func (s *Service) PlanTicket(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input PlanTicketInput,
	requestID *uuid.UUID,
) (TicketDetail, error) {
	return s.changeTicket(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTicketCoreRow) error {
		if err := requireInside(ctx, q, p, core.GroupID); err != nil {
			return err
		}
		if core.Status != string(StatusNew) {
			return stateConflict("Only a new ticket can be planned")
		}
		if err := requireColumn(ctx, q, core.GroupID, input.ColumnID); err != nil {
			return err
		}
		if input.AssigneePersonID != nil {
			if err := requireAssignee(ctx, q, core.GroupID, *input.AssigneePersonID); err != nil {
				return err
			}
		}
		if err := setTicketState(ctx, q, id, StatusPlanned, input.AssigneePersonID, input.DueOn, &input.ColumnID); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_ticket.planned", "working_group_ticket", id, requestID,
			[]string{"status", "assigneePersonId", "dueOn", "columnId"}); err != nil {
			return err
		}
		return s.notifyTicket(ctx, q, tx, p, core, "planned", false)
	})
}

// UpdateTicket changes assignee, due date and column of a planned ticket under optimistic locking. Inside people only.
func (s *Service) UpdateTicket(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input UpdateTicketInput,
	requestID *uuid.UUID,
) (TicketDetail, error) {
	return s.changeTicket(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTicketCoreRow) error {
		if err := requireInside(ctx, q, p, core.GroupID); err != nil {
			return err
		}
		if input.ExpectedVersion < 1 {
			return apperror.Invalid("expectedVersion must be positive")
		}
		if core.Version != input.ExpectedVersion {
			return apperror.StaleWrite
		}
		if core.Status != string(StatusPlanned) {
			return stateConflict("Only a planned ticket can be changed")
		}
		assignee, due, column := core.AssigneePersonID, dateValue(core.DueOn), core.ColumnID
		var changed []string
		if input.Assignee.Set && !sameID(input.Assignee.Value, assignee) {
			if input.Assignee.Value != nil {
				if err := requireAssignee(ctx, q, core.GroupID, *input.Assignee.Value); err != nil {
					return err
				}
			}
			assignee = input.Assignee.Value
			changed = append(changed, "assigneePersonId")
		}
		if input.DueOn.Set && !sameDate(input.DueOn.Value, due) {
			due = input.DueOn.Value
			changed = append(changed, "dueOn")
		}
		if input.ColumnID != nil && (column == nil || *column != *input.ColumnID) {
			if err := requireColumn(ctx, q, core.GroupID, *input.ColumnID); err != nil {
				return err
			}
			column = input.ColumnID
			changed = append(changed, "columnId")
		}
		if len(changed) == 0 {
			return nil
		}
		if err := setTicketState(ctx, q, id, StatusPlanned, assignee, due, column); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_ticket.updated", "working_group_ticket", id, requestID, changed)
	})
}

// CloseTicket closes a ticket as done or declined. The answer becomes a public comment in the same transaction and is
// required when declining. Inside people only.
func (s *Service) CloseTicket(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input CloseTicketInput,
	requestID *uuid.UUID,
) (TicketDetail, error) {
	return s.changeTicket(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTicketCoreRow) error {
		if err := requireInside(ctx, q, p, core.GroupID); err != nil {
			return err
		}
		if input.Outcome != StatusDone && input.Outcome != StatusDeclined {
			return apperror.InvalidField("outcome")
		}
		answer, err := validateText(input.Answer, "answer", MaxCommentRunes, input.Outcome == StatusDeclined)
		if err != nil {
			return err
		}
		if core.Status != string(StatusNew) && core.Status != string(StatusPlanned) {
			return stateConflict("The ticket is already closed")
		}
		if err := setTicketState(ctx, q, id, input.Outcome, nil, nil, nil); err != nil {
			return err
		}
		fields := []string{"status"}
		if answer != "" {
			author := p.PersonID
			if err := q.AddWorkingGroupComment(ctx, workinggroupsdb.AddWorkingGroupCommentParams{
				ID: ids.New(), TicketID: &id, AuthorPersonID: &author, Text: answer, Internal: false,
			}); err != nil {
				return err
			}
			fields = append(fields, "comments")
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_ticket.closed", "working_group_ticket", id, requestID, fields); err != nil {
			return err
		}
		return s.notifyTicket(ctx, q, tx, p, core, string(input.Outcome), false)
	})
}

// ReopenTicket sends a planned, done or declined ticket back to the inbox and clears assignee, due date and column.
func (s *Service) ReopenTicket(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (TicketDetail, error) {
	return s.changeTicket(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTicketCoreRow) error {
		if err := requireInside(ctx, q, p, core.GroupID); err != nil {
			return err
		}
		if core.Status == string(StatusNew) {
			return stateConflict("The ticket is already in the inbox")
		}
		if err := setTicketState(ctx, q, id, StatusNew, nil, nil, nil); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_ticket.reopened", "working_group_ticket", id, requestID,
			[]string{"status", "assigneePersonId", "dueOn", "columnId"})
	})
}

// FollowTicket marks "I have this too". Following twice is idempotent; the author cannot follow their own ticket
// (409 working_group_ticket_own).
func (s *Service) FollowTicket(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (TicketDetail, error) {
	return s.changeTicket(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTicketCoreRow) error {
		if core.AuthorPersonID != nil && *core.AuthorPersonID == p.PersonID {
			return apperror.Conflicting("working_group_ticket_own", "You cannot follow your own ticket")
		}
		added, err := q.AddWorkingGroupTicketFollower(ctx, workinggroupsdb.AddWorkingGroupTicketFollowerParams{
			TicketID: id, PersonID: p.PersonID,
		})
		if err != nil || added == 0 {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_ticket.followed", "working_group_ticket", id, requestID, []string{"followers"})
	})
}

// UnfollowTicket withdraws "I have this too"; not following is not an error.
func (s *Service) UnfollowTicket(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (TicketDetail, error) {
	return s.changeTicket(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, _ workinggroupsdb.GetWorkingGroupTicketCoreRow) error {
		removed, err := q.DeleteWorkingGroupTicketFollower(ctx, workinggroupsdb.DeleteWorkingGroupTicketFollowerParams{
			TicketID: id, PersonID: p.PersonID,
		})
		if err != nil || removed == 0 {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_ticket.unfollowed", "working_group_ticket", id, requestID, []string{"followers"})
	})
}

// AddTicketComment adds a comment. Everybody with working_groups.read may write a public one; internal comments are
// for people inside the group.
func (s *Service) AddTicketComment(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input CommentInput,
	requestID *uuid.UUID,
) (TicketDetail, error) {
	return s.changeTicket(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTicketCoreRow) error {
		if input.Internal {
			if err := requireInside(ctx, q, p, core.GroupID); err != nil {
				return err
			}
		}
		text, err := validateText(input.Text, "text", MaxCommentRunes, true)
		if err != nil {
			return err
		}
		author := p.PersonID
		if err := q.AddWorkingGroupComment(ctx, workinggroupsdb.AddWorkingGroupCommentParams{
			ID: ids.New(), TicketID: &id, AuthorPersonID: &author, Text: text, Internal: input.Internal,
		}); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_ticket.commented", "working_group_ticket", id, requestID,
			[]string{"comments", "internal"}); err != nil {
			return err
		}
		return s.notifyTicket(ctx, q, tx, p, core, "comment", input.Internal)
	})
}

// DeleteTicket removes a ticket with its followers and comments for good. Only working_groups.manage may.
func (s *Service) DeleteTicket(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	_, err := s.changeTicket(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, _ workinggroupsdb.GetWorkingGroupTicketCoreRow) error {
		if !p.Has(authorization.WorkingGroupsManage) {
			return apperror.PermissionDenied
		}
		if _, err := q.DeleteWorkingGroupTicket(ctx, id); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_ticket.deleted", "working_group_ticket", id, requestID, nil)
	})
	return err
}

// DeleteTicketComment removes one comment of a ticket for good. Only working_groups.manage may.
func (s *Service) DeleteTicketComment(
	ctx context.Context,
	p authorization.Principal,
	id, commentID uuid.UUID,
	requestID *uuid.UUID,
) (TicketDetail, error) {
	return s.changeTicket(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, _ workinggroupsdb.GetWorkingGroupTicketCoreRow) error {
		if !p.Has(authorization.WorkingGroupsManage) {
			return apperror.PermissionDenied
		}
		removed, err := q.DeleteWorkingGroupTicketComment(ctx, workinggroupsdb.DeleteWorkingGroupTicketCommentParams{ID: commentID, TicketID: &id})
		if err != nil {
			return err
		}
		if removed == 0 {
			return apperror.NotFound
		}
		return writeTaskAudit(ctx, tx, p, "working_group_comment.deleted", "working_group_comment", commentID, requestID, nil)
	})
}

// changeTicket runs one change of a ticket: read permission, ticket lookup (404), the group lock, the ticket read
// again under the lock, the change with its audit event, and the reloaded ticket for the caller.
func (s *Service) changeTicket(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	change func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTicketCoreRow) error,
) (result TicketDetail, err error) {
	if err := requireRead(p); err != nil {
		return TicketDetail{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		core, err := q.GetWorkingGroupTicketCore(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if _, err := q.LockWorkingGroup(ctx, core.GroupID); err != nil {
			return noRows(err)
		}
		core, err = q.GetWorkingGroupTicketCore(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if err := change(q, tx, core); err != nil {
			return err
		}
		result, err = loadTicketDetail(ctx, q, p, id)
		if apperror.IsCode(err, "not_found") {
			// Deleted by this very change.
			return nil
		}
		return err
	})
	return result, err
}

func setTicketState(
	ctx context.Context,
	q *workinggroupsdb.Queries,
	id uuid.UUID,
	status TicketStatus,
	assignee *uuid.UUID,
	due *time.Time,
	column *uuid.UUID,
) error {
	_, err := q.SetWorkingGroupTicketState(ctx, workinggroupsdb.SetWorkingGroupTicketStateParams{
		ID: id, Status: string(status), AssigneePersonID: assignee, DueOn: dateParam(due), ColumnID: column,
	})
	return err
}

func loadTicketDetail(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, id uuid.UUID) (TicketDetail, error) {
	rows, err := q.ListWorkingGroupTickets(ctx, workinggroupsdb.ListWorkingGroupTicketsParams{
		CallerPersonID: p.PersonID, CallerManage: p.Has(authorization.WorkingGroupsManage), CallerFinance: isFinance(p), ID: &id, RowLimit: 1,
	})
	if err != nil {
		return TicketDetail{}, err
	}
	if len(rows) == 0 {
		return TicketDetail{}, apperror.NotFound
	}
	ticket := ticketFromRow(rows[0])
	followers, err := q.ListWorkingGroupTicketFollowers(ctx, id)
	if err != nil {
		return TicketDetail{}, err
	}
	comments, err := q.ListWorkingGroupTicketComments(ctx, workinggroupsdb.ListWorkingGroupTicketCommentsParams{
		TicketID: &id, IncludeInternal: ticket.Inside,
	})
	if err != nil {
		return TicketDetail{}, err
	}
	detail := TicketDetail{Ticket: ticket, Followers: make([]Person, 0, len(followers)), Comments: make([]Comment, 0, len(comments))}
	for _, f := range followers {
		detail.Followers = append(detail.Followers, Person{ID: f.PersonID, DisplayName: f.DisplayName})
	}
	for _, c := range comments {
		detail.Comments = append(detail.Comments, Comment{
			ID: c.ID, Author: personRef(c.AuthorPersonID, c.AuthorName), Text: c.Text, Internal: c.Internal, CreatedAt: c.CreatedAt,
		})
	}
	return detail, nil
}

func ticketFromRow(row workinggroupsdb.ListWorkingGroupTicketsRow) Ticket {
	return Ticket{
		ID: row.ID, GroupID: row.GroupID, GroupName: row.GroupName, MachineID: row.MachineID, MachineName: row.MachineName,
		Kind: TicketKind(row.Kind), Subject: row.Subject, Body: row.Body, BlocksUse: row.BlocksUse,
		Status: TicketStatus(row.Status), Author: personRef(row.AuthorPersonID, row.AuthorName),
		Assignee: personRef(row.AssigneePersonID, row.AssigneeName), DueOn: dateValue(row.DueOn), ColumnID: row.ColumnID,
		FollowerCount: row.FollowerCount, IsFollowing: row.IsFollowing, IsMine: row.IsMine,
		CommentCount: row.CommentCount, Inside: row.Inside, Version: row.Version,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, ClosedAt: timeValue(row.ClosedAt),
		Link: taskLink(row.LinkKind, row.LinkID, row.LinkTitle, row.LinkStatus),
	}
}

func validKind(kind TicketKind) bool {
	return kind == KindProblem || kind == KindRequest || kind == KindQuestion
}

func validStatus(status TicketStatus) bool {
	return status == StatusNew || status == StatusPlanned || status == StatusDone || status == StatusDeclined
}

func sameID(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameDate(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return dateParam(a) == dateParam(b)
}
