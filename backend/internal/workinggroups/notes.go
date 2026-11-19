package workinggroups

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	MaxNoteRunes     = 500
	MaxNoteListRows  = 200
	MaxStatusNoteRun = 200
)

// ListNotes lists the pinboard notes the caller may see, newest first, optionally of one group. A group note of a
// group the caller is not inside never appears, so the list does not reveal that it exists.
func (s *Service) ListNotes(ctx context.Context, p authorization.Principal, groupID *uuid.UUID) ([]Note, error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	rows, err := workinggroupsdb.New(s.pool).ListWorkingGroupNotes(ctx, workinggroupsdb.ListWorkingGroupNotesParams{
		CallerPersonID: p.PersonID,
		CallerManage:   p.Has(authorization.WorkingGroupsManage),
		GroupID:        groupID,
		RowLimit:       MaxNoteListRows,
	})
	if err != nil {
		return nil, err
	}
	items := make([]Note, 0, len(rows))
	for _, row := range rows {
		items = append(items, Note{
			ID: row.ID, GroupID: row.GroupID, GroupName: row.GroupName, Public: row.IsPublic, Text: row.Text,
			CreatedAt: row.CreatedAt, Author: personRef(row.AuthorPersonID, row.AuthorDisplayName),
			CanDelete: row.CanDelete != nil && *row.CanDelete,
		})
	}
	return items, nil
}

// CreateNote pins a note. People inside the group write group and public notes of it; only working_groups.manage
// writes a makerspace note (no group), which is always public.
func (s *Service) CreateNote(
	ctx context.Context,
	p authorization.Principal,
	input CreateNoteInput,
	requestID *uuid.UUID,
) (result Note, err error) {
	if err := requireRead(p); err != nil {
		return Note{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		if input.GroupID != nil {
			// Membership is decided under the group lock so a member removed meanwhile cannot still pin.
			if _, err := q.LockWorkingGroup(ctx, *input.GroupID); err != nil {
				return noRows(err)
			}
			if err := requireInside(ctx, q, p, *input.GroupID); err != nil {
				return err
			}
		} else if !p.Has(authorization.WorkingGroupsManage) {
			return apperror.PermissionDenied
		}
		text, err := validateText(input.Text, "text", MaxNoteRunes, true)
		if err != nil {
			return err
		}
		if input.GroupID == nil && !input.Public {
			return apperror.InvalidField("public")
		}
		id := ids.New()
		author := p.PersonID
		if err := q.CreateWorkingGroupNote(ctx, workinggroupsdb.CreateWorkingGroupNoteParams{
			ID: id, GroupID: input.GroupID, IsPublic: input.Public || input.GroupID == nil, Text: text, AuthorPersonID: &author,
		}); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_note.pinned", "working_group_note", id, requestID,
			[]string{"groupId", "public", "text"}); err != nil {
			return err
		}
		row, err := q.GetWorkingGroupNote(ctx, workinggroupsdb.GetWorkingGroupNoteParams{
			CallerPersonID: p.PersonID, CallerManage: p.Has(authorization.WorkingGroupsManage), ID: id,
		})
		if err != nil {
			return err
		}
		result = Note{
			ID: row.ID, GroupID: row.GroupID, GroupName: row.GroupName, Public: row.IsPublic, Text: row.Text,
			CreatedAt: row.CreatedAt, Author: personRef(row.AuthorPersonID, row.AuthorDisplayName),
			CanDelete: row.CanDelete != nil && *row.CanDelete,
		}
		return nil
	})
	return result, err
}

// DeleteNote removes a note. The author, the lead of the note's group and working_groups.manage may. A group note
// of a group the caller is not inside does not exist for them (404).
func (s *Service) DeleteNote(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		core, err := q.GetWorkingGroupNoteCore(ctx, id)
		if err != nil {
			return noRows(err)
		}
		isAuthor := core.AuthorPersonID != nil && *core.AuthorPersonID == p.PersonID
		manage := p.Has(authorization.WorkingGroupsManage)
		if core.GroupID != nil {
			if _, err := q.LockWorkingGroup(ctx, *core.GroupID); err != nil {
				return noRows(err)
			}
			if !core.IsPublic {
				inside, err := isInside(ctx, q, p, *core.GroupID)
				if err != nil {
					return err
				}
				if !inside {
					return apperror.NotFound
				}
			}
		}
		allowed := isAuthor || manage
		if !allowed && core.GroupID != nil {
			allowed, err = q.IsWorkingGroupLead(ctx, workinggroupsdb.IsWorkingGroupLeadParams{
				GroupID: *core.GroupID, PersonID: p.PersonID,
			})
			if err != nil {
				return err
			}
		}
		if !allowed {
			return apperror.PermissionDenied
		}
		removed, err := q.DeleteWorkingGroupNote(ctx, id)
		if err != nil {
			return err
		}
		if removed == 0 {
			return apperror.NotFound
		}
		return writeTaskAudit(ctx, tx, p, "working_group_note.removed", "working_group_note", id, requestID, []string{"groupId"})
	})
}
