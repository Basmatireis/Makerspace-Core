package workinggroups

import (
	"context"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	defaultActivityRows = 20
	maxActivityRows     = 50
)

// TicketNotifier raises the notification event of a ticket change inside the caller's transaction.
type TicketNotifier interface {
	WorkingGroupTicketUpdated(ctx context.Context, tx pgx.Tx, change notifyrules.WorkingGroupTicketChange) error
}

// WithNotifications gives the service the event source that tells ticket authors and followers about changes.
func (s *Service) WithNotifications(notifier TicketNotifier) *Service {
	s.notifier = notifier
	return s
}

// TaskLink is the purchase or project a ticket or to-do is linked to, as far as the caller may see it.
type TaskLink struct {
	Kind   string
	ID     uuid.UUID
	Title  string
	Status string
}

// LinkedTask is a ticket or to-do linked to a purchase or project; shown to people inside the group only.
type LinkedTask struct {
	Kind  string
	ID    uuid.UUID
	Title string
}

// LinkInput links a ticket or to-do to a purchase or a project, or removes the link when neither is set.
type LinkInput struct {
	ExpectedVersion int64
	PurchaseID      *uuid.UUID
	ProjectID       *uuid.UUID
}

// ActivityEntry is one event of the "lately" feed of a group.
type ActivityEntry struct {
	Kind       string
	At         time.Time
	Actor      *Person
	Title      string
	TargetKind string
	TargetID   uuid.UUID
}

func taskLink(kind string, id uuid.UUID, title, status string) *TaskLink {
	if kind == "" {
		return nil
	}
	return &TaskLink{Kind: kind, ID: id, Title: title, Status: status}
}

// checkLinkTarget validates the target of a link: at most one, one the caller may see (404 otherwise) and one of the
// same group (422 working_group_link_other_group).
func checkLinkTarget(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, groupID uuid.UUID, input LinkInput) error {
	if input.PurchaseID != nil && input.ProjectID != nil {
		return apperror.New(http.StatusUnprocessableEntity, "working_group_link_ambiguous", "Link a purchase or a project, not both")
	}
	var target uuid.UUID
	var err error
	switch {
	case input.PurchaseID != nil:
		target, err = q.GetWorkingGroupPurchaseLinkTarget(ctx, *input.PurchaseID)
	case input.ProjectID != nil:
		target, err = q.GetWorkingGroupProjectLinkTarget(ctx, *input.ProjectID)
	default:
		return nil
	}
	if err != nil {
		return noRows(err)
	}
	if !isFinance(p) {
		member, err := q.IsWorkingGroupMember(ctx, workinggroupsdb.IsWorkingGroupMemberParams{GroupID: target, PersonID: p.PersonID})
		if err != nil {
			return err
		}
		if !member {
			return apperror.NotFound
		}
	}
	if target != groupID {
		return apperror.New(http.StatusUnprocessableEntity, "working_group_link_other_group", "The purchase or project belongs to another group")
	}
	return nil
}

// SetTicketLink links a ticket to one purchase or project of its group, or removes the link. Inside people only.
func (s *Service) SetTicketLink(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input LinkInput,
	requestID *uuid.UUID,
) (TicketDetail, error) {
	return s.changeTicket(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTicketCoreRow) error {
		if err := requireInside(ctx, q, p, core.GroupID); err != nil {
			return err
		}
		if err := checkLinkTarget(ctx, q, p, core.GroupID, input); err != nil {
			return err
		}
		if input.ExpectedVersion < 1 {
			return apperror.Invalid("expectedVersion must be positive")
		}
		if core.Version != input.ExpectedVersion {
			return apperror.StaleWrite
		}
		if sameID(core.PurchaseID, input.PurchaseID) && sameID(core.ProjectID, input.ProjectID) {
			return nil
		}
		if _, err := q.SetWorkingGroupTicketLink(ctx, workinggroupsdb.SetWorkingGroupTicketLinkParams{
			ID: id, PurchaseID: input.PurchaseID, ProjectID: input.ProjectID,
		}); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_ticket.linked", "working_group_ticket", id, requestID,
			[]string{"purchaseId", "projectId"})
	})
}

// SetTodoLink links a to-do to one purchase or project of its group, or removes the link. People outside the group
// get 404 like for every to-do operation.
func (s *Service) SetTodoLink(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input LinkInput,
	requestID *uuid.UUID,
) (TodoDetail, error) {
	return s.changeTodo(ctx, p, id, func(q *workinggroupsdb.Queries, tx pgx.Tx, core workinggroupsdb.GetWorkingGroupTodoCoreRow) error {
		if err := checkLinkTarget(ctx, q, p, core.GroupID, input); err != nil {
			return err
		}
		if input.ExpectedVersion < 1 {
			return apperror.Invalid("expectedVersion must be positive")
		}
		if core.Version != input.ExpectedVersion {
			return apperror.StaleWrite
		}
		if sameID(core.PurchaseID, input.PurchaseID) && sameID(core.ProjectID, input.ProjectID) {
			return nil
		}
		if _, err := q.SetWorkingGroupTodoLink(ctx, workinggroupsdb.SetWorkingGroupTodoLinkParams{
			ID: id, PurchaseID: input.PurchaseID, ProjectID: input.ProjectID,
		}); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_todo.linked", "working_group_todo", id, requestID,
			[]string{"purchaseId", "projectId"})
	})
}

// linkedTasks loads the tickets and to-dos linked to purchases and projects for the people inside their group.
func linkedTasks(
	ctx context.Context,
	q *workinggroupsdb.Queries,
	p authorization.Principal,
	purchaseIDs, projectIDs []uuid.UUID,
) (byPurchase, byProject map[uuid.UUID][]LinkedTask, err error) {
	byPurchase, byProject = map[uuid.UUID][]LinkedTask{}, map[uuid.UUID][]LinkedTask{}
	if len(purchaseIDs) == 0 && len(projectIDs) == 0 {
		return byPurchase, byProject, nil
	}
	rows, err := q.ListWorkingGroupLinkedTasks(ctx, workinggroupsdb.ListWorkingGroupLinkedTasksParams{
		PurchaseIds: purchaseIDs, ProjectIds: projectIDs,
		CallerManage: p.Has(authorization.WorkingGroupsManage), CallerPersonID: p.PersonID,
	})
	if err != nil {
		return nil, nil, err
	}
	for _, row := range rows {
		task := LinkedTask{Kind: row.Kind, ID: row.ID, Title: row.Title}
		if row.PurchaseID != nil {
			byPurchase[*row.PurchaseID] = append(byPurchase[*row.PurchaseID], task)
		}
		if row.ProjectID != nil {
			byProject[*row.ProjectID] = append(byProject[*row.ProjectID], task)
		}
	}
	return byPurchase, byProject, nil
}

func attachPurchaseTasks(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, items []Purchase) error {
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	byPurchase, _, err := linkedTasks(ctx, q, p, ids, nil)
	if err != nil {
		return err
	}
	for i := range items {
		items[i].LinkedTasks = byPurchase[items[i].ID]
	}
	return nil
}

func attachProjectTasks(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, items []Project) error {
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	_, byProject, err := linkedTasks(ctx, q, p, nil, ids)
	if err != nil {
		return err
	}
	for i := range items {
		items[i].LinkedTasks = byProject[items[i].ID]
	}
	return nil
}

// notifyTicket tells the author and the followers of a ticket about a change, except the person who made it. An
// internal comment reaches only recipients who belong to the group. The event goes through the notification rules,
// which decide channels and preferences.
func (s *Service) notifyTicket(
	ctx context.Context,
	q *workinggroupsdb.Queries,
	tx pgx.Tx,
	p authorization.Principal,
	core workinggroupsdb.GetWorkingGroupTicketCoreRow,
	change string,
	internal bool,
) error {
	if s.notifier == nil {
		return nil
	}
	recipients, err := q.ListWorkingGroupTicketRecipients(ctx, workinggroupsdb.ListWorkingGroupTicketRecipientsParams{
		GroupID: core.GroupID, TicketID: core.ID,
	})
	if err != nil {
		return err
	}
	var author, followers []uuid.UUID
	for _, r := range recipients {
		if r.PersonID == nil || *r.PersonID == p.PersonID || (internal && !r.Inside) {
			continue
		}
		if core.AuthorPersonID != nil && *core.AuthorPersonID == *r.PersonID {
			author = append(author, *r.PersonID)
		} else {
			followers = append(followers, *r.PersonID)
		}
	}
	if len(author) == 0 && len(followers) == 0 {
		return nil
	}
	groupName, err := q.GetWorkingGroupName(ctx, core.GroupID)
	if err != nil {
		return noRows(err)
	}
	return s.notifier.WorkingGroupTicketUpdated(ctx, tx, notifyrules.WorkingGroupTicketChange{
		TicketID: core.ID, Subject: core.Subject, GroupName: groupName, Change: change, Internal: internal,
		ActorID: p.PersonID, Author: author, Followers: followers,
	})
}

// ListActivity returns the latest events of a group, newest first. People inside the group see everything the feed
// knows; everybody else sees only the ticket events. The feed is built from the records themselves, not the audit log.
func (s *Service) ListActivity(ctx context.Context, p authorization.Principal, groupID uuid.UUID, limit *int) ([]ActivityEntry, error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	rows := defaultActivityRows
	if limit != nil {
		if *limit < 1 || *limit > maxActivityRows {
			return nil, apperror.InvalidField("limit")
		}
		rows = *limit
	}
	q := workinggroupsdb.New(s.pool)
	if _, err := q.GetWorkingGroupName(ctx, groupID); err != nil {
		return nil, noRows(err)
	}
	inside, err := isInside(ctx, q, p, groupID)
	if err != nil {
		return nil, err
	}
	// Purchases and projects follow the visibility of the purchase and project lists: members and finance managers,
	// not working_groups.manage alone.
	seeMoney := isFinance(p)
	if !seeMoney {
		if seeMoney, err = q.IsWorkingGroupMember(ctx, workinggroupsdb.IsWorkingGroupMemberParams{GroupID: groupID, PersonID: p.PersonID}); err != nil {
			return nil, err
		}
	}
	events, err := q.ListWorkingGroupActivity(ctx, workinggroupsdb.ListWorkingGroupActivityParams{
		GroupID: groupID, Inside: inside, SeeMoney: seeMoney, RowLimit: int32(rows),
	})
	if err != nil {
		return nil, err
	}
	items := make([]ActivityEntry, 0, len(events))
	for _, e := range events {
		items = append(items, ActivityEntry{
			Kind: e.Kind, At: e.At.UTC(), Actor: personRef(e.ActorPersonID, e.ActorDisplayName), Title: e.Title,
			TargetKind: e.TargetKind, TargetID: e.TargetID,
		})
	}
	return items, nil
}
