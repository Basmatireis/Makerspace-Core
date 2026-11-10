package signage

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Group is a set of displays with one aspect ratio that show the same content: the group owns the rules and
// the default scene list, and publishing the group publishes every member.
type Group struct {
	ID             uuid.UUID
	Name           string
	AspectRatio    AspectRatio
	DefaultScenes  []SceneListItem
	DisplayIDs     []uuid.UUID // members by display name
	PendingChanges []PendingChange
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// GroupInput is the writable part of a group.
type GroupInput struct {
	Name          string
	AspectRatio   AspectRatio
	DefaultScenes []SceneListItem
}

// groupContent is what a group gives its members: the default list and the rules.
type groupContent struct {
	AspectRatio   AspectRatio
	DefaultScenes []SceneListItem
	Rules         []Rule
}

// loadGroupContent reads the default lists and rules of groups keyed by group id.
func loadGroupContent(
	ctx context.Context,
	q *signagedb.Queries,
	groupIDs []uuid.UUID,
) (map[uuid.UUID]groupContent, error) {
	result := map[uuid.UUID]groupContent{}
	groupIDs = distinct(groupIDs)
	if len(groupIDs) == 0 {
		return result, nil
	}
	rows, err := q.ListSignageDisplayGroupViews(ctx, uuidStrings(groupIDs))
	if err != nil {
		return nil, err
	}
	_, rules, err := loadRuleLists(ctx, q, nil, groupIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		defaults, err := decodeSceneList(row.DefaultScenes)
		if err != nil {
			return nil, err
		}
		result[row.ID] = groupContent{
			AspectRatio:   aspectRatioOf(row.AspectWidth, row.AspectHeight),
			DefaultScenes: defaults,
			Rules:         rules[row.ID],
		}
	}
	return result, nil
}

// loadGroups assembles groups with their pending changes: the union of the differences between the group's
// draft manifest for each member and that member's latest publication (members never published and revoked
// members contribute nothing).
func (s *Service) loadGroups(
	ctx context.Context,
	q *signagedb.Queries,
	rows []signagedb.ListSignageDisplayGroupViewsRow,
) ([]Group, error) {
	groups := make([]Group, 0, len(rows))
	groupIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		defaults, err := decodeSceneList(row.DefaultScenes)
		if err != nil {
			return nil, err
		}
		members := make([]uuid.UUID, 0, len(row.DisplayIds))
		for _, text := range row.DisplayIds {
			id, err := uuid.Parse(text)
			if err != nil {
				return nil, err
			}
			members = append(members, id)
		}
		groups = append(groups, Group{
			ID: row.ID, Name: row.Name, AspectRatio: aspectRatioOf(row.AspectWidth, row.AspectHeight),
			DefaultScenes: defaults, DisplayIDs: members, PendingChanges: []PendingChange{},
			Version: row.Version, CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
		})
		groupIDs = append(groupIDs, row.ID)
	}
	if len(groupIDs) == 0 {
		return groups, nil
	}
	_, rules, err := loadRuleLists(ctx, q, nil, groupIDs)
	if err != nil {
		return nil, err
	}
	members, err := q.ListSignageGroupMembers(ctx, uuidStrings(groupIDs))
	if err != nil {
		return nil, err
	}
	memberIDs := make([]uuid.UUID, 0, len(members))
	for _, member := range members {
		if !member.Revoked {
			memberIDs = append(memberIDs, member.ID)
		}
	}
	published := map[uuid.UUID]Manifest{}
	if len(memberIDs) > 0 {
		publications, err := q.ListLatestSignagePublications(ctx, uuidStrings(memberIDs))
		if err != nil {
			return nil, err
		}
		for _, publication := range publications {
			manifest, err := upgradeManifest(publication.Manifest)
			if err != nil {
				return nil, err
			}
			published[publication.DisplayID] = manifest
		}
	}
	byID := map[uuid.UUID]*Group{}
	for index := range groups {
		byID[groups[index].ID] = &groups[index]
	}
	media, err := embedMediaOf(ctx, q, embedMemberIDs(members))
	if err != nil {
		return nil, err
	}
	drafts := []displayDraft{}
	for _, member := range members {
		if _, ok := published[member.ID]; !ok || member.Revoked {
			continue
		}
		group := byID[member.GroupID]
		drafts = append(drafts, displayDraft{
			ID: member.ID, Name: member.Name, AspectRatio: aspectRatioOf(member.AspectWidth, member.AspectHeight),
			VisibleFromOutside: member.VisibleFromOutside,
			DefaultScenes:      group.DefaultScenes,
			Rules:              rules[member.GroupID],
			EmbedMedia:         media[member.ID],
		})
	}
	manifests, err := s.buildManifests(ctx, q, drafts)
	if err != nil {
		return nil, err
	}
	seen := map[uuid.UUID]map[PendingChange]bool{}
	for _, member := range members {
		draft, ok := manifests[member.ID]
		if !ok {
			continue
		}
		group := byID[member.GroupID]
		if seen[group.ID] == nil {
			seen[group.ID] = map[PendingChange]bool{}
		}
		for _, change := range diffManifests(published[member.ID], draft) {
			if !seen[group.ID][change] {
				seen[group.ID][change] = true
				group.PendingChanges = append(group.PendingChanges, change)
			}
		}
	}
	return groups, nil
}

// ListGroups returns all display groups by name.
func (s *Service) ListGroups(ctx context.Context, principal authorization.Principal) ([]Group, error) {
	if err := requireRead(principal); err != nil {
		return nil, err
	}
	q := signagedb.New(s.pool)
	rows, err := q.ListSignageDisplayGroupViews(ctx, []string{})
	if err != nil {
		return nil, err
	}
	return s.loadGroups(ctx, q, rows)
}

// GetGroup reads one display group.
func (s *Service) GetGroup(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Group, error) {
	if err := requireRead(principal); err != nil {
		return Group{}, err
	}
	return s.getGroup(ctx, signagedb.New(s.pool), id)
}

func (s *Service) getGroup(ctx context.Context, q *signagedb.Queries, id uuid.UUID) (Group, error) {
	rows, err := q.ListSignageDisplayGroupViews(ctx, []string{id.String()})
	if err != nil {
		return Group{}, err
	}
	if len(rows) == 0 {
		return Group{}, apperror.NotFound
	}
	groups, err := s.loadGroups(ctx, q, rows)
	if err != nil {
		return Group{}, err
	}
	return groups[0], nil
}

func validateGroupInput(input GroupInput) (GroupInput, error) {
	name, err := cleanName(input.Name, "group name", 100)
	if err != nil {
		return input, err
	}
	ratio, err := checkAspectRatio(input.AspectRatio)
	if err != nil {
		return input, err
	}
	defaults, err := checkSceneList(input.DefaultScenes, "defaultScenes")
	if err != nil {
		return input, err
	}
	input.Name, input.AspectRatio, input.DefaultScenes = name, ratio, defaults
	return input, nil
}

// CreateGroup creates a display group without members.
func (s *Service) CreateGroup(
	ctx context.Context,
	principal authorization.Principal,
	input GroupInput,
	requestID *uuid.UUID,
) (Group, error) {
	if err := requireManage(principal); err != nil {
		return Group{}, err
	}
	checked, err := validateGroupInput(input)
	if err != nil {
		return Group{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Group{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if err := verifySceneList(ctx, q, checked.AspectRatio, checked.DefaultScenes, "defaultScenes"); err != nil {
		return Group{}, err
	}
	id := ids.New()
	if err := q.CreateSignageDisplayGroup(ctx, signagedb.CreateSignageDisplayGroupParams{
		ID: id, Name: checked.Name,
		AspectWidth: int16(checked.AspectRatio.Width), AspectHeight: int16(checked.AspectRatio.Height),
	}); err != nil {
		return Group{}, databaseError(err)
	}
	if err := replaceDefaultScenes(ctx, q, ruleOwner{GroupID: id}, checked.DefaultScenes); err != nil {
		return Group{}, err
	}
	if err := writeAudit(ctx, tx, principal, "signage_display_group.created", "signage_display_group", id, requestID,
		[]string{"name", "aspectRatio", "defaultScenes"}); err != nil {
		return Group{}, err
	}
	result, err := s.getGroup(ctx, q, id)
	if err != nil {
		return Group{}, err
	}
	return result, tx.Commit(ctx)
}

// UpdateGroup changes the name, aspect ratio and default list of a group. The ratio can only change while
// no rule shows a scene of the old ratio and the group has no members (members keep the group's ratio).
func (s *Service) UpdateGroup(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	input GroupInput,
	requestID *uuid.UUID,
) (Group, error) {
	if err := requireManage(principal); err != nil {
		return Group{}, err
	}
	if err := requireExpected(expected); err != nil {
		return Group{}, err
	}
	checked, err := validateGroupInput(input)
	if err != nil {
		return Group{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Group{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, err := q.GetSignageDisplayGroupForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Group{}, apperror.NotFound
	}
	if err != nil {
		return Group{}, err
	}
	if current.Version != expected {
		return Group{}, apperror.StaleWrite
	}
	if err := verifySceneList(ctx, q, checked.AspectRatio, checked.DefaultScenes, "defaultScenes"); err != nil {
		return Group{}, err
	}
	ratioChanged := aspectRatioOf(current.AspectWidth, current.AspectHeight) != checked.AspectRatio
	if ratioChanged {
		mismatched, err := q.CountSceneRulesWithOtherAspectRatio(ctx, signagedb.CountSceneRulesWithOtherAspectRatioParams{
			GroupID:     &id,
			AspectWidth: int16(checked.AspectRatio.Width), AspectHeight: int16(checked.AspectRatio.Height),
		})
		if err != nil {
			return Group{}, err
		}
		if mismatched > 0 {
			return Group{}, validation(
				"%d rule(s) show a scene with another aspect ratio; change those rules first",
				mismatched,
			)
		}
		members, err := q.ListSignageGroupMembers(ctx, []string{id.String()})
		if err != nil {
			return Group{}, err
		}
		if len(members) > 0 {
			return Group{}, validation(
				"%d member display(s) have the group's current aspect ratio; remove them from the group first",
				len(members),
			)
		}
	}
	currentDefault, err := decodeSceneList(current.DefaultScenes)
	if err != nil {
		return Group{}, err
	}
	if _, err := q.UpdateSignageDisplayGroup(ctx, signagedb.UpdateSignageDisplayGroupParams{
		Name:        checked.Name,
		AspectWidth: int16(checked.AspectRatio.Width), AspectHeight: int16(checked.AspectRatio.Height),
		ID: id, ExpectedVersion: expected,
	}); errors.Is(err, pgx.ErrNoRows) {
		return Group{}, apperror.StaleWrite
	} else if err != nil {
		return Group{}, databaseError(err)
	}
	defaultChanged := !sceneListsEqual(currentDefault, checked.DefaultScenes)
	if defaultChanged {
		if err := replaceDefaultScenes(ctx, q, ruleOwner{GroupID: id}, checked.DefaultScenes); err != nil {
			return Group{}, err
		}
	}
	var changed []string
	if current.Name != checked.Name {
		changed = append(changed, "name")
	}
	if ratioChanged {
		changed = append(changed, "aspectRatio")
	}
	if defaultChanged {
		changed = append(changed, "defaultScenes")
	}
	if err := writeAudit(
		ctx, tx, principal, "signage_display_group.updated", "signage_display_group", id, requestID, changed,
	); err != nil {
		return Group{}, err
	}
	result, err := s.getGroup(ctx, q, id)
	if err != nil {
		return Group{}, err
	}
	return result, tx.Commit(ctx)
}

// DeleteGroup deletes a group without members together with its rules, default list and announcement
// targets. While displays are members it answers 409 signage_in_use listing them.
func (s *Service) DeleteGroup(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := requireManage(principal); err != nil {
		return err
	}
	if err := requireExpected(expected); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, err := q.GetSignageDisplayGroupForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	members, err := q.ListSignageGroupMembers(ctx, []string{id.String()})
	if err != nil {
		return err
	}
	if len(members) > 0 {
		references := make([]Reference, 0, len(members))
		for _, member := range members {
			references = append(references, Reference{Kind: ReferenceDisplay, ID: member.ID, Name: member.Name})
		}
		return inUse("Display group", references)
	}
	if _, err := q.DeleteSignageDisplayGroup(
		ctx,
		signagedb.DeleteSignageDisplayGroupParams{ID: id, ExpectedVersion: expected},
	); errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	if err := writeAudit(
		ctx, tx, principal, "signage_display_group.deleted", "signage_display_group", id, requestID, nil,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// PublishGroup stores one publication per member that is not revoked, all with the group's content, in one
// repeatable-read transaction. The group's audit event is accompanied by a signage_display.published event
// per member, which records the display ids.
func (s *Service) PublishGroup(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (Group, error) {
	group, err := s.publishGroup(ctx, principal, id, requestID)
	if err != nil {
		return Group{}, serializationConflict(err)
	}
	return group, nil
}

func (s *Service) publishGroup(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (Group, error) {
	if !principal.Has(authorization.SignagePublish) {
		return Group{}, apperror.PermissionDenied
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return Group{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if _, err := q.GetSignageDisplayGroupForUpdate(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return Group{}, apperror.NotFound
	} else if err != nil {
		return Group{}, err
	}
	members, err := q.ListSignageGroupMembers(ctx, []string{id.String()})
	if err != nil {
		return Group{}, err
	}
	contents, err := loadGroupContent(ctx, q, []uuid.UUID{id})
	if err != nil {
		return Group{}, err
	}
	content := contents[id]
	media, err := embedMediaOf(ctx, q, embedMemberIDs(members))
	if err != nil {
		return Group{}, err
	}
	drafts := []displayDraft{}
	kinds := map[uuid.UUID]DisplayKind{}
	for _, member := range members {
		// The member's row lock serialises this publication with the member's own publish and edits.
		row, err := q.GetSignageDisplayForUpdate(ctx, member.ID)
		if err != nil {
			return Group{}, err
		}
		if row.RevokedAt.Valid || row.DeviceRevokedAt.Valid || row.GroupID == nil || *row.GroupID != id {
			continue
		}
		kinds[row.ID] = DisplayKind(row.Kind)
		drafts = append(drafts, displayDraft{
			ID: row.ID, Name: row.Name, AspectRatio: aspectRatioOf(row.AspectWidth, row.AspectHeight),
			VisibleFromOutside: row.VisibleFromOutside,
			DefaultScenes:      content.DefaultScenes,
			Rules:              content.Rules,
			EmbedMedia:         media[row.ID],
		})
	}
	if len(drafts) == 0 {
		return Group{}, validation("the group has no displays to publish to")
	}
	manifests, err := s.buildManifests(ctx, q, drafts)
	if err != nil {
		return Group{}, err
	}
	for _, draft := range drafts {
		if err := s.storePublication(ctx, q, principal, draft.ID, manifests[draft.ID]); err != nil {
			return Group{}, err
		}
		action, resource := publishedAudit(kinds[draft.ID])
		if err := writeAudit(
			ctx, tx, principal, action, resource, draft.ID, requestID, []string{"revision", "groupId"},
		); err != nil {
			return Group{}, err
		}
	}
	if err := writeAudit(
		ctx, tx, principal, "signage_display_group.published", "signage_display_group", id, requestID,
		[]string{"revision", "displayIds"},
	); err != nil {
		return Group{}, err
	}
	result, err := s.getGroup(ctx, q, id)
	if err != nil {
		return Group{}, err
	}
	return result, tx.Commit(ctx)
}

// PreviewGroup returns the latest publication of the first member (by name) that has one together with that
// member's live data. Without any published member the manifest is nil and the live data is the first
// member's (or, without members, only what every display gets).
func (s *Service) PreviewGroup(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
) (DisplayPreview, error) {
	if err := requireRead(principal); err != nil {
		return DisplayPreview{}, err
	}
	q := signagedb.New(s.pool)
	groups, err := q.ListSignageDisplayGroupViews(ctx, []string{id.String()})
	if err != nil {
		return DisplayPreview{}, err
	}
	if len(groups) == 0 {
		return DisplayPreview{}, apperror.NotFound
	}
	members, err := q.ListSignageGroupMembers(ctx, []string{id.String()})
	if err != nil {
		return DisplayPreview{}, err
	}
	var chosen *uuid.UUID
	var manifest *Manifest
	for _, member := range members {
		latest, ok, err := s.latestManifest(ctx, q, member.ID)
		if err != nil {
			return DisplayPreview{}, err
		}
		if ok {
			memberID := member.ID
			chosen, manifest = &memberID, &latest
			break
		}
	}
	if chosen == nil && len(members) > 0 {
		chosen = &members[0].ID
	}
	display := PlayerDisplay{Name: groups[0].Name}
	if chosen != nil {
		if display, err = s.previewDisplayFor(ctx, q, *chosen); err != nil {
			return DisplayPreview{}, err
		}
	}
	// The preview never offers camera streams: it is not a display itself.
	live, err := s.playerLive(ctx, display, false)
	if err != nil {
		return DisplayPreview{}, err
	}
	return DisplayPreview{Manifest: manifest, Live: live}, nil
}
