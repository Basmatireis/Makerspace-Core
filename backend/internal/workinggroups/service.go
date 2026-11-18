package workinggroups

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	MaxNameRunes        = 80
	MaxDescriptionRunes = 500
	MaxChatURLRunes     = 300
	MaxMachines         = 200
	maxSearchRunes      = 200
	personPageLimit     = 50
)

// Service owns working groups, their members, machines and places.
type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// requireRead is the first check of every operation: nobody without working_groups.read sees or changes anything.
func requireRead(p authorization.Principal) error {
	if !p.Has(authorization.WorkingGroupsRead) {
		return apperror.PermissionDenied
	}
	return nil
}

func (s *Service) List(ctx context.Context, p authorization.Principal) ([]Summary, error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	rows, err := workinggroupsdb.New(s.pool).ListWorkingGroups(ctx, p.PersonID)
	if err != nil {
		return nil, err
	}
	items := make([]Summary, 0, len(rows))
	for _, row := range rows {
		items = append(items, summaryFromRow(
			row.ID, row.Name, row.Description, row.LeadPersonID, row.LeadDisplayName,
			row.MemberCount, row.MachineCount, row.IsMember, row.IsLead,
		))
	}
	return items, nil
}

func (s *Service) Get(ctx context.Context, p authorization.Principal, id uuid.UUID) (Group, error) {
	if err := requireRead(p); err != nil {
		return Group{}, err
	}
	return loadGroup(ctx, workinggroupsdb.New(s.pool), p, id)
}

// Create makes a group whose lead is its first member.
func (s *Service) Create(
	ctx context.Context,
	p authorization.Principal,
	input CreateInput,
	requestID *uuid.UUID,
) (result Group, err error) {
	if err := requireRead(p); err != nil {
		return Group{}, err
	}
	if !p.Has(authorization.WorkingGroupsManage) {
		return Group{}, apperror.PermissionDenied
	}
	name, err := validateName(input.Name)
	if err != nil {
		return Group{}, err
	}
	description, err := validateDescription(input.Description)
	if err != nil {
		return Group{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		if err := requirePerson(ctx, q, input.LeadPersonID); err != nil {
			return err
		}
		id := ids.New()
		if err := q.CreateWorkingGroup(ctx, workinggroupsdb.CreateWorkingGroupParams{
			ID: id, Name: name, Description: description,
		}); err != nil {
			return uniqueConflict(err, "working_group_exists", "A working group with this name already exists")
		}
		if err := q.AddWorkingGroupMember(ctx, workinggroupsdb.AddWorkingGroupMemberParams{
			GroupID: id, PersonID: input.LeadPersonID, IsLead: true, JoinedAt: time.Now().UTC(),
		}); err != nil {
			return err
		}
		for position, name := range defaultColumns {
			if err := q.InsertWorkingGroupColumn(ctx, workinggroupsdb.InsertWorkingGroupColumnParams{
				ID: ids.New(), GroupID: id, Name: name, Position: int32(position),
			}); err != nil {
				return err
			}
		}
		if err := writeAudit(ctx, tx, p, "working_group.created", id, requestID,
			[]string{"name", "description", "leadPersonId"}); err != nil {
			return err
		}
		result, err = loadGroup(ctx, q, p, id)
		return err
	})
	return result, err
}

// Update changes name (manage only), description and chat link (manage or lead) under optimistic locking.
func (s *Service) Update(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input UpdateInput,
	requestID *uuid.UUID,
) (result Group, err error) {
	if err := requireRead(p); err != nil {
		return Group{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		current, err := q.LockWorkingGroup(ctx, id)
		if err != nil {
			return noRows(err)
		}
		canManage := p.Has(authorization.WorkingGroupsManage)
		if input.Name != nil && !canManage {
			return apperror.PermissionDenied
		}
		if err := authorizeEdit(ctx, q, p, id); err != nil {
			return err
		}
		// Validation follows authorization so a caller without rights gets 403, never 422.
		if input.ExpectedVersion < 1 {
			return apperror.Invalid("expectedVersion must be positive")
		}
		var name, description *string
		if input.Name != nil {
			clean, err := validateName(*input.Name)
			if err != nil {
				return err
			}
			name = &clean
		}
		if input.Description != nil {
			clean, err := validateDescription(*input.Description)
			if err != nil {
				return err
			}
			description = &clean
		}
		chat := input.ChatURL
		if chat.Set && chat.Value != nil {
			clean, err := validateChatURL(*chat.Value)
			if err != nil {
				return err
			}
			chat.Value = clean
		}
		if current.Version != input.ExpectedVersion {
			return apperror.StaleWrite
		}
		var changed []string
		if name != nil && *name != current.Name {
			changed = append(changed, "name")
		}
		if description != nil && *description != current.Description {
			changed = append(changed, "description")
		}
		if chat.Set && !sameText(chat.Value, current.ChatUrl) {
			changed = append(changed, "chatUrl")
		}
		if len(changed) > 0 {
			if _, err := q.UpdateWorkingGroup(ctx, workinggroupsdb.UpdateWorkingGroupParams{
				Name: name, Description: description, SetChatUrl: chat.Set, ChatUrl: chat.Value,
				ID: id, ExpectedVersion: input.ExpectedVersion,
			}); err != nil {
				return uniqueConflict(err, "working_group_exists", "A working group with this name already exists")
			}
			if err := writeAudit(ctx, tx, p, "working_group.updated", id, requestID, changed); err != nil {
				return err
			}
		}
		result, err = loadGroup(ctx, q, p, id)
		return err
	})
	return result, err
}

// Delete removes a group with its memberships, machine assignments and places.
func (s *Service) Delete(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	if !p.Has(authorization.WorkingGroupsManage) {
		return apperror.PermissionDenied
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		if _, err := q.LockWorkingGroup(ctx, id); err != nil {
			return noRows(err)
		}
		if _, err := q.DeleteWorkingGroup(ctx, id); err != nil {
			return err
		}
		return writeAudit(ctx, tx, p, "working_group.deleted", id, requestID, nil)
	})
}

// AddMember adds a person to the group; a person already in it answers 409.
func (s *Service) AddMember(
	ctx context.Context,
	p authorization.Principal,
	groupID, personID uuid.UUID,
	requestID *uuid.UUID,
) (Group, error) {
	return s.mutate(ctx, p, groupID, false, func(q *workinggroupsdb.Queries, tx pgx.Tx) error {
		if err := requirePerson(ctx, q, personID); err != nil {
			return err
		}
		_, err := q.GetWorkingGroupMember(ctx, workinggroupsdb.GetWorkingGroupMemberParams{
			GroupID: groupID, PersonID: personID,
		})
		switch {
		case err == nil:
			return apperror.Conflicting("working_group_member_exists", "This person is already a member of the group")
		case !errors.Is(err, pgx.ErrNoRows):
			return err
		}
		if err := q.AddWorkingGroupMember(ctx, workinggroupsdb.AddWorkingGroupMemberParams{
			GroupID: groupID, PersonID: personID, JoinedAt: time.Now().UTC(),
		}); err != nil {
			return err
		}
		return writeAudit(ctx, tx, p, "working_group_member.added", groupID, requestID, []string{"memberPersonId"})
	})
}

// RemoveMember removes a person from the group. The lead cannot be removed; choose another lead first.
func (s *Service) RemoveMember(
	ctx context.Context,
	p authorization.Principal,
	groupID, personID uuid.UUID,
	requestID *uuid.UUID,
) (Group, error) {
	return s.mutate(ctx, p, groupID, false, func(q *workinggroupsdb.Queries, tx pgx.Tx) error {
		member, err := q.GetWorkingGroupMember(ctx, workinggroupsdb.GetWorkingGroupMemberParams{
			GroupID: groupID, PersonID: personID,
		})
		if err != nil {
			return noRows(err)
		}
		if member.IsLead {
			return apperror.Conflicting(
				"working_group_lead_required", "The lead cannot be removed; choose another lead first",
			)
		}
		if _, err := q.DeleteWorkingGroupMember(ctx, workinggroupsdb.DeleteWorkingGroupMemberParams{
			GroupID: groupID, PersonID: personID,
		}); err != nil {
			return err
		}
		// Tickets and to-dos assigned to the person go back to nobody.
		if err := q.ClearWorkingGroupTicketAssignments(ctx, workinggroupsdb.ClearWorkingGroupTicketAssignmentsParams{
			GroupID: groupID, PersonID: &personID,
		}); err != nil {
			return err
		}
		if err := q.ClearWorkingGroupTodoAssignments(ctx, workinggroupsdb.ClearWorkingGroupTodoAssignmentsParams{
			GroupID: groupID, PersonID: &personID,
		}); err != nil {
			return err
		}
		return writeAudit(ctx, tx, p, "working_group_member.removed", groupID, requestID, []string{"memberPersonId"})
	})
}

// SetLead makes a person the lead, adding them as a member if needed. The previous lead stays a normal member.
func (s *Service) SetLead(
	ctx context.Context,
	p authorization.Principal,
	groupID, personID uuid.UUID,
	requestID *uuid.UUID,
) (Group, error) {
	return s.mutate(ctx, p, groupID, true, func(q *workinggroupsdb.Queries, tx pgx.Tx) error {
		if err := requirePerson(ctx, q, personID); err != nil {
			return err
		}
		member, err := q.GetWorkingGroupMember(ctx, workinggroupsdb.GetWorkingGroupMemberParams{
			GroupID: groupID, PersonID: personID,
		})
		isMember := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if isMember && member.IsLead {
			return nil
		}
		if err := q.ClearWorkingGroupLead(ctx, groupID); err != nil {
			return err
		}
		if isMember {
			err = q.MarkWorkingGroupLead(ctx, workinggroupsdb.MarkWorkingGroupLeadParams{
				GroupID: groupID, PersonID: personID,
			})
		} else {
			err = q.AddWorkingGroupMember(ctx, workinggroupsdb.AddWorkingGroupMemberParams{
				GroupID: groupID, PersonID: personID, IsLead: true, JoinedAt: time.Now().UTC(),
			})
		}
		if err != nil {
			return err
		}
		return writeAudit(ctx, tx, p, "working_group_lead.changed", groupID, requestID, []string{"leadPersonId"})
	})
}

// SetMachines replaces the machines the group looks after. A machine of another group answers 409.
func (s *Service) SetMachines(
	ctx context.Context,
	p authorization.Principal,
	groupID uuid.UUID,
	machineIDs []uuid.UUID,
	requestID *uuid.UUID,
) (Group, error) {
	return s.mutate(ctx, p, groupID, false, func(q *workinggroupsdb.Queries, tx pgx.Tx) error {
		wanted := uniqueIDs(machineIDs)
		if len(wanted) > MaxMachines {
			return apperror.Invalid("too many machines")
		}
		// Inserting in id order keeps two groups that assign overlapping machines from deadlocking.
		slices.SortFunc(wanted, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
		existing, err := q.ListExistingMachineIDs(ctx, wanted)
		if err != nil {
			return err
		}
		for _, id := range wanted {
			if !slices.Contains(existing, id) {
				return withDetail(
					apperror.New(http.StatusUnprocessableEntity, "machine_not_found", "A machine does not exist"),
					"machineId", id,
				)
			}
		}
		assignments, err := q.ListMachineGroupAssignments(ctx, wanted)
		if err != nil {
			return err
		}
		for _, assignment := range assignments {
			if assignment.GroupID != groupID {
				return machineTaken(assignment.MachineID)
			}
		}
		current, err := q.ListWorkingGroupMachines(ctx, groupID)
		if err != nil {
			return err
		}
		unchanged := len(current) == len(wanted)
		for _, machine := range current {
			unchanged = unchanged && slices.Contains(wanted, machine.ID)
		}
		if unchanged {
			return nil
		}
		if err := q.DeleteWorkingGroupMachines(ctx, groupID); err != nil {
			return err
		}
		for _, id := range wanted {
			if err := q.AddWorkingGroupMachine(ctx, workinggroupsdb.AddWorkingGroupMachineParams{
				GroupID: groupID, MachineID: id,
			}); err != nil {
				// Another group took the machine between the check and the insert.
				if isUniqueViolation(err) {
					return machineTaken(id)
				}
				return err
			}
		}
		return writeAudit(ctx, tx, p, "working_group_machines.changed", groupID, requestID, []string{"machineIds"})
	})
}

// AddPlace adds a free-text place.
func (s *Service) AddPlace(
	ctx context.Context,
	p authorization.Principal,
	groupID uuid.UUID,
	name string,
	requestID *uuid.UUID,
) (Group, error) {
	return s.mutate(ctx, p, groupID, false, func(q *workinggroupsdb.Queries, tx pgx.Tx) error {
		clean, err := validateName(name)
		if err != nil {
			return err
		}
		if err := q.AddWorkingGroupPlace(ctx, workinggroupsdb.AddWorkingGroupPlaceParams{
			ID: ids.New(), GroupID: groupID, Name: clean,
		}); err != nil {
			return uniqueConflict(err, "working_group_place_exists", "The group already has a place with this name")
		}
		return writeAudit(ctx, tx, p, "working_group_place.added", groupID, requestID, []string{"places"})
	})
}

// RemovePlace removes a place of the group.
func (s *Service) RemovePlace(
	ctx context.Context,
	p authorization.Principal,
	groupID, placeID uuid.UUID,
	requestID *uuid.UUID,
) (Group, error) {
	return s.mutate(ctx, p, groupID, false, func(q *workinggroupsdb.Queries, tx pgx.Tx) error {
		removed, err := q.DeleteWorkingGroupPlace(ctx, workinggroupsdb.DeleteWorkingGroupPlaceParams{
			ID: placeID, GroupID: groupID,
		})
		if err != nil {
			return err
		}
		if removed == 0 {
			return apperror.NotFound
		}
		return writeAudit(ctx, tx, p, "working_group_place.removed", groupID, requestID, []string{"places"})
	})
}

// FindPeople lists minimal candidates for the member and lead pickers: id and name, nothing else.
func (s *Service) FindPeople(ctx context.Context, p authorization.Principal, search string) ([]PersonOption, error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	q := workinggroupsdb.New(s.pool)
	if err := requireManageOrLeadOfAny(ctx, q, p); err != nil {
		return nil, err
	}
	search = strings.TrimSpace(search)
	if utf8.RuneCountInString(search) > maxSearchRunes {
		return nil, apperror.Invalid("search is too long")
	}
	rows, err := q.FindWorkingGroupPeople(ctx, workinggroupsdb.FindWorkingGroupPeopleParams{
		Search: search, PageLimit: personPageLimit,
	})
	if err != nil {
		return nil, err
	}
	items := make([]PersonOption, 0, len(rows))
	for _, row := range rows {
		items = append(items, PersonOption{ID: row.ID, DisplayName: row.DisplayName})
	}
	return items, nil
}

// ListMachineOptions lists every machine with the group it already belongs to, for the machine picker.
func (s *Service) ListMachineOptions(ctx context.Context, p authorization.Principal) ([]MachineOption, error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	q := workinggroupsdb.New(s.pool)
	if err := requireManageOrLeadOfAny(ctx, q, p); err != nil {
		return nil, err
	}
	rows, err := q.ListWorkingGroupMachineOptions(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]MachineOption, 0, len(rows))
	for _, row := range rows {
		items = append(items, MachineOption{ID: row.ID, Name: row.Name, GroupID: row.WorkingGroupID, GroupName: row.WorkingGroupName})
	}
	return items, nil
}

// mutate runs one change of a group in a transaction: read permission, group lock (404), authorization (manage only
// or manage-or-lead), the change with its audit event, and the reloaded group for the caller.
func (s *Service) mutate(
	ctx context.Context,
	p authorization.Principal,
	groupID uuid.UUID,
	manageOnly bool,
	change func(q *workinggroupsdb.Queries, tx pgx.Tx) error,
) (result Group, err error) {
	if err := requireRead(p); err != nil {
		return Group{}, err
	}
	if manageOnly && !p.Has(authorization.WorkingGroupsManage) {
		return Group{}, apperror.PermissionDenied
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		if _, err := q.LockWorkingGroup(ctx, groupID); err != nil {
			return noRows(err)
		}
		if err := authorizeEdit(ctx, q, p, groupID); err != nil {
			return err
		}
		if err := change(q, tx); err != nil {
			return err
		}
		result, err = loadGroup(ctx, q, p, groupID)
		return err
	})
	return result, err
}

// authorizeEdit allows working_groups.manage or the lead of this very group.
func authorizeEdit(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, groupID uuid.UUID) error {
	if p.Has(authorization.WorkingGroupsManage) {
		return nil
	}
	lead, err := q.IsWorkingGroupLead(ctx, workinggroupsdb.IsWorkingGroupLeadParams{
		GroupID: groupID, PersonID: p.PersonID,
	})
	if err != nil {
		return err
	}
	if !lead {
		return apperror.PermissionDenied
	}
	return nil
}

func requireManageOrLeadOfAny(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal) error {
	if p.Has(authorization.WorkingGroupsManage) {
		return nil
	}
	lead, err := q.LeadsAnyWorkingGroup(ctx, p.PersonID)
	if err != nil {
		return err
	}
	if !lead {
		return apperror.PermissionDenied
	}
	return nil
}

func requirePerson(ctx context.Context, q *workinggroupsdb.Queries, personID uuid.UUID) error {
	exists, err := q.PersonExists(ctx, personID)
	if err != nil {
		return err
	}
	if exists {
		// Guests (the Visitor membership role) are never working group members.
		visitor, err := q.IsVisitorPerson(ctx, personID)
		if err != nil {
			return err
		}
		if visitor {
			return withDetail(
				apperror.New(http.StatusUnprocessableEntity, "person_not_eligible", "This person cannot join a working group"),
				"personId", personID,
			)
		}
	}
	if !exists {
		return withDetail(
			apperror.New(http.StatusUnprocessableEntity, "person_not_found", "The person does not exist"),
			"personId", personID,
		)
	}
	return nil
}

// loadGroup reads a group as the caller may see it: the chat link only for members and managers.
func loadGroup(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, id uuid.UUID) (Group, error) {
	row, err := q.GetWorkingGroup(ctx, workinggroupsdb.GetWorkingGroupParams{CallerPersonID: p.PersonID, ID: id})
	if err != nil {
		return Group{}, noRows(err)
	}
	members, err := q.ListWorkingGroupMembers(ctx, id)
	if err != nil {
		return Group{}, err
	}
	machines, err := q.ListWorkingGroupMachines(ctx, id)
	if err != nil {
		return Group{}, err
	}
	places, err := q.ListWorkingGroupPlaces(ctx, id)
	if err != nil {
		return Group{}, err
	}
	columns, err := q.ListWorkingGroupColumns(ctx, id)
	if err != nil {
		return Group{}, err
	}
	canManage := p.Has(authorization.WorkingGroupsManage)
	group := Group{
		Summary: summaryFromRow(
			row.ID, row.Name, row.Description, row.LeadPersonID, row.LeadDisplayName,
			row.MemberCount, row.MachineCount, row.IsMember, row.IsLead,
		),
		Version:   row.Version,
		Members:   make([]Member, 0, len(members)),
		Machines:  make([]Machine, 0, len(machines)),
		Places:    make([]Place, 0, len(places)),
		Columns:   make([]Column, 0, len(columns)),
		CanEdit:   canManage || row.IsLead,
		CanManage: canManage,
	}
	if row.IsMember || canManage {
		group.ChatURL = row.ChatUrl
	}
	for _, m := range members {
		group.Members = append(group.Members, Member{
			PersonID: m.PersonID, DisplayName: m.DisplayName, IsLead: m.IsLead, JoinedAt: m.JoinedAt,
		})
	}
	for _, m := range machines {
		group.Machines = append(group.Machines, Machine{ID: m.ID, Name: m.Name})
	}
	for _, place := range places {
		group.Places = append(group.Places, Place{ID: place.ID, Name: place.Name})
	}
	for _, column := range columns {
		group.Columns = append(group.Columns, Column{ID: column.ID, Name: column.Name})
	}
	return group, nil
}

func summaryFromRow(
	id uuid.UUID,
	name, description string,
	leadID *uuid.UUID,
	leadName string,
	memberCount, machineCount int64,
	isMember, isLead bool,
) Summary {
	summary := Summary{
		ID: id, Name: name, Description: description, MemberCount: memberCount, MachineCount: machineCount,
		IsMember: isMember, IsLead: isLead,
	}
	if leadID != nil {
		summary.Lead = &Person{ID: *leadID, DisplayName: leadName}
	}
	return summary
}

// validateName trims a group or place name and checks its length.
func validateName(value string) (string, error) {
	clean := strings.TrimSpace(value)
	if clean == "" || utf8.RuneCountInString(clean) > MaxNameRunes {
		return "", apperror.InvalidField("name")
	}
	return clean, nil
}

func validateDescription(value string) (string, error) {
	clean := strings.TrimSpace(value)
	if utf8.RuneCountInString(clean) > MaxDescriptionRunes {
		return "", apperror.InvalidField("description")
	}
	return clean, nil
}

// validateChatURL accepts an absolute https URL with a host; a blank value clears the link.
func validateChatURL(value string) (*string, error) {
	clean := strings.TrimSpace(value)
	if clean == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(clean) > MaxChatURLRunes || strings.IndexFunc(clean, unicode.IsSpace) >= 0 {
		return nil, apperror.InvalidField("chatUrl")
	}
	parsed, err := url.Parse(clean)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || !strings.HasPrefix(clean, "https://") {
		return nil, apperror.InvalidField("chatUrl")
	}
	return &clean, nil
}

func sameText(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func uniqueIDs(values []uuid.UUID) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(values))
	for _, value := range values {
		if !slices.Contains(result, value) {
			result = append(result, value)
		}
	}
	return result
}

func machineTaken(machineID uuid.UUID) error {
	return withDetail(
		apperror.Conflicting("machine_in_other_working_group", "A machine already belongs to another working group"),
		"machineId", machineID,
	)
}

func withDetail(err *apperror.Error, key string, id uuid.UUID) *apperror.Error {
	err.Details[key] = id.String()
	return err
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func uniqueConflict(err error, code, message string) error {
	if isUniqueViolation(err) {
		return apperror.Conflicting(code, message)
	}
	return err
}

func noRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	return err
}

// writeAudit records a change by group id and changed field names; names of people, places and the chat link are
// never written.
func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	action string,
	groupID uuid.UUID,
	requestID *uuid.UUID,
	fields []string,
) error {
	account := p.AccountID
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &account,
		Action:         action,
		ResourceType:   "working_group",
		ResourceID:     &groupID,
		RequestID:      requestID,
		ChangedFields:  fields,
	})
}
