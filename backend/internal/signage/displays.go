package signage

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// onlineWindow is how recent a heartbeat must be for a display to count as online.
const onlineWindow = 90 * time.Second

// Display is a physical screen with its draft settings, publication state and health.
type Display struct {
	ID, ManagedDeviceID uuid.UUID
	Name, Location      string
	AspectRatio         AspectRatio
	VisibleFromOutside  bool
	AllowCameraOutside  bool
	DefaultScenes       []SceneListItem // own list; empty while the display is in a group
	GroupID             *uuid.UUID
	Status              DisplayStatus // online | offline | revoked
	RevokedAt           *time.Time
	LastHeartbeatAt     *time.Time
	PublishedRevision   *int
	PublishedAt         *time.Time
	PendingChanges      []PendingChange
	ReportedRevision    *int
	CurrentRule         *string
	CurrentSceneID      *uuid.UUID
	PlayerVersion       *string
	CacheUsedBytes      *int64
	CacheQuotaBytes     *int64
	Errors              []string
	Version             int64
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// DisplayInput is the writable part of a display.
type DisplayInput struct {
	Name, Location     string
	AspectRatio        AspectRatio
	VisibleFromOutside bool
	// AllowCameraOutside nil means unchanged on update and false when pairing.
	AllowCameraOutside *bool
	// DefaultScenes must be empty with a GroupID and list at least one scene without one (except when the
	// display leaves its group: empty then keeps a copy of the group's list).
	DefaultScenes []SceneListItem
	GroupID       *uuid.UUID
}

// viewRow abstracts the two generated row types of the display view queries.
type viewRow struct {
	signagedb.GetSignageDisplayViewRow
}

func viewFromList(row signagedb.ListSignageDisplayViewsRow) viewRow {
	return viewRow{signagedb.GetSignageDisplayViewRow(row)}
}

func (s *Service) displayFromView(row viewRow) (Display, error) {
	now := s.now()
	defaultScenes, err := decodeSceneList(row.DefaultScenes)
	if err != nil {
		return Display{}, err
	}
	display := Display{
		ID:                 row.ID,
		ManagedDeviceID:    row.ManagedDeviceID,
		Name:               row.Name,
		Location:           row.Location,
		AspectRatio:        aspectRatioOf(row.AspectWidth, row.AspectHeight),
		VisibleFromOutside: row.VisibleFromOutside, AllowCameraOutside: row.AllowCameraOutside,
		DefaultScenes:   defaultScenes,
		GroupID:         row.GroupID,
		LastHeartbeatAt: fromPgTime(row.LastHeartbeatAt),
		PendingChanges:  []PendingChange{},
		ReportedRevision: intPointer(
			row.ReportedRevision,
		), CurrentRule: row.CurrentRule, CurrentSceneID: row.CurrentSceneID,
		PlayerVersion:   row.PlayerVersion,
		CacheUsedBytes:  row.CacheUsedBytes,
		CacheQuotaBytes: row.CacheQuotaBytes,
		Errors:          []string{},
		Version:         row.Version, CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(), Status: DisplayOffline,
	}
	if revoked := fromPgTime(row.RevokedAt); revoked != nil {
		display.RevokedAt = revoked
	} else {
		display.RevokedAt = fromPgTime(row.DeviceRevokedAt)
	}
	switch {
	case display.RevokedAt != nil:
		display.Status = DisplayRevoked
	case display.LastHeartbeatAt != nil && now.Sub(*display.LastHeartbeatAt) < onlineWindow:
		display.Status = DisplayOnline
	}
	if row.PublishedRevision > 0 {
		revision := int(row.PublishedRevision)
		published := row.PublishedAt.UTC()
		display.PublishedRevision, display.PublishedAt = &revision, &published
	}
	if len(row.Errors) > 0 {
		var messages []string
		if json.Unmarshal(row.Errors, &messages) == nil {
			display.Errors = messages
		}
	}
	return display, nil
}

// loadDisplays reads displays with their pending changes (drafts compared with the latest
// publication). ids nil means all displays.
func (s *Service) loadDisplays(ctx context.Context, q *signagedb.Queries, rows []viewRow) ([]Display, error) {
	displays := make([]Display, 0, len(rows))
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		display, err := s.displayFromView(row)
		if err != nil {
			return nil, err
		}
		displays = append(displays, display)
		ids = append(ids, row.ID)
	}
	if len(ids) == 0 {
		return displays, nil
	}
	rules, err := loadRules(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	// A member of a group is compared with the group's content.
	var groupIDs []uuid.UUID
	for _, display := range displays {
		if display.GroupID != nil {
			groupIDs = append(groupIDs, *display.GroupID)
		}
	}
	groups, err := loadGroupContent(ctx, q, groupIDs)
	if err != nil {
		return nil, err
	}
	publications, err := q.ListLatestSignagePublications(ctx, uuidStrings(ids))
	if err != nil {
		return nil, err
	}
	published := map[uuid.UUID]Manifest{}
	for _, publication := range publications {
		manifest, err := upgradeManifest(publication.Manifest)
		if err != nil {
			return nil, err
		}
		published[publication.DisplayID] = manifest
	}
	drafts := make([]displayDraft, 0, len(published))
	for _, display := range displays {
		if _, ok := published[display.ID]; ok {
			draft := displayDraft{
				ID: display.ID, Name: display.Name, AspectRatio: display.AspectRatio,
				VisibleFromOutside: display.VisibleFromOutside,
				DefaultScenes:      display.DefaultScenes,
				Rules:              rules[display.ID],
			}
			if display.GroupID != nil {
				group := groups[*display.GroupID]
				draft.DefaultScenes, draft.Rules = group.DefaultScenes, group.Rules
			}
			drafts = append(drafts, draft)
		}
	}
	manifests, err := s.buildManifests(ctx, q, drafts)
	if err != nil {
		return nil, err
	}
	for index := range displays {
		if previous, ok := published[displays[index].ID]; ok {
			displays[index].PendingChanges = diffManifests(previous, manifests[displays[index].ID])
		}
	}
	return displays, nil
}

// buildManifests loads the content the drafts reach and assembles one revision-less manifest each.
func (s *Service) buildManifests(
	ctx context.Context,
	q *signagedb.Queries,
	drafts []displayDraft,
) (map[uuid.UUID]Manifest, error) {
	result := make(map[uuid.UUID]Manifest, len(drafts))
	if len(drafts) == 0 {
		return result, nil
	}
	sceneSet := map[uuid.UUID]struct{}{}
	for _, draft := range drafts {
		for _, item := range draft.DefaultScenes {
			sceneSet[item.SceneID] = struct{}{}
		}
		for _, rule := range draft.Rules {
			if !rule.Enabled {
				continue
			}
			for _, item := range rule.Scenes {
				sceneSet[item.SceneID] = struct{}{}
			}
		}
	}
	content := manifestContent{
		scenes:        map[uuid.UUID]ManifestScene{},
		assets:        map[uuid.UUID]ManifestAsset{},
		customLayouts: map[uuid.UUID]ManifestCustomLayout{},
	}
	sceneRows, err := q.ListSignageScenesByIDs(ctx, uuidStrings(sortedIDs(sceneSet)))
	if err != nil {
		return nil, err
	}
	assetSet := map[uuid.UUID]struct{}{}
	layoutSet := map[uuid.UUID]struct{}{}
	for _, row := range sceneRows {
		scene, err := sceneFromRow(row)
		if err != nil {
			return nil, err
		}
		zones := make(map[string]json.RawMessage, len(scene.Zones))
		for key, widget := range scene.Zones {
			zones[key] = widget
		}
		published := ManifestScene{
			ID:                scene.ID,
			Name:              scene.Name,
			AspectRatio:       scene.AspectRatio,
			LayoutID:          scene.LayoutID,
			CustomLayoutID:    scene.CustomLayoutID,
			BackgroundColor:   scene.BackgroundColor,
			BackgroundAssetID: scene.BackgroundAssetID,
			BackgroundFit:     scene.BackgroundFit,
			BackgroundDim:     scene.BackgroundDim,
			Theme:             scene.Theme,
			Zones:             zones, Version: scene.Version,
		}
		ids, err := sceneAssetIDs(published)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			assetSet[id] = struct{}{}
		}
		if scene.CustomLayoutID != nil {
			layoutSet[*scene.CustomLayoutID] = struct{}{}
		}
		content.scenes[scene.ID] = published
	}
	if len(layoutSet) > 0 {
		layoutRows, err := q.ListSignageCustomLayoutsByIDs(ctx, uuidStrings(sortedIDs(layoutSet)))
		if err != nil {
			return nil, err
		}
		for _, row := range layoutRows {
			layout, err := customLayoutFromRow(
				row.ID, row.Name, row.Mode, row.Columns, row.Rows, row.Zones, 0, row.Version, row.CreatedAt, row.UpdatedAt,
			)
			if err != nil {
				return nil, err
			}
			content.customLayouts[row.ID] = ManifestCustomLayout{
				ID: layout.ID, Name: layout.Name, Mode: layout.Mode, Columns: layout.Columns, Rows: layout.Rows,
				Zones: layout.Zones, Version: layout.Version,
			}
		}
	}
	if len(assetSet) > 0 {
		assetRows, err := q.ListSignageAssetsByIDs(ctx, uuidStrings(sortedIDs(assetSet)))
		if err != nil {
			return nil, err
		}
		for _, row := range assetRows {
			asset := assetFromRow(
				row.ID,
				AssetKind(row.Kind),
				row.Name,
				row.Width,
				row.Height,
				row.DurationMs,
				nil,
				"",
				time.Time{},
				row.ContentType,
				row.SizeBytes,
				row.Sha256,
			)
			content.assets[row.ID] = ManifestAsset{
				ID:          row.ID,
				Kind:        AssetKind(row.Kind),
				Name:        row.Name,
				ContentType: row.ContentType,
				SHA256:      asset.SHA256,
				SizeBytes:   row.SizeBytes,
				Width:       asset.Width, Height: asset.Height, DurationMs: asset.DurationMs,
			}
		}
	}
	for _, draft := range drafts {
		manifest, err := assembleManifest(draft, content)
		if err != nil {
			return nil, err
		}
		result[draft.ID] = manifest
	}
	return result, nil
}

// ListDisplays returns all displays by name.
func (s *Service) ListDisplays(ctx context.Context, principal authorization.Principal) ([]Display, error) {
	if err := requireRead(principal); err != nil {
		return nil, err
	}
	q := signagedb.New(s.pool)
	rows, err := q.ListSignageDisplayViews(ctx)
	if err != nil {
		return nil, err
	}
	views := make([]viewRow, 0, len(rows))
	for _, row := range rows {
		views = append(views, viewFromList(row))
	}
	return s.loadDisplays(ctx, q, views)
}

// GetDisplay reads one display.
func (s *Service) GetDisplay(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Display, error) {
	if err := requireRead(principal); err != nil {
		return Display{}, err
	}
	return s.getDisplay(ctx, signagedb.New(s.pool), id)
}

func (s *Service) getDisplay(ctx context.Context, q *signagedb.Queries, id uuid.UUID) (Display, error) {
	row, err := q.GetSignageDisplayView(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Display{}, apperror.NotFound
	}
	if err != nil {
		return Display{}, err
	}
	displays, err := s.loadDisplays(ctx, q, []viewRow{{row}})
	if err != nil {
		return Display{}, err
	}
	return displays[0], nil
}

func requireManage(principal authorization.Principal) error {
	if !principal.Has(authorization.SignageManage) {
		return apperror.PermissionDenied
	}
	return nil
}

// cleanLocation validates the optional location text.
func cleanLocation(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", nil
	}
	return cleanName(trimmed, "location", 150)
}

// validateDisplayInput checks the fields and the shape of a non-empty default list. Whether an empty default
// list is allowed depends on the group membership before and after the write, so callers check that.
func validateDisplayInput(input DisplayInput) (DisplayInput, error) {
	name, err := cleanName(input.Name, "display name", 100)
	if err != nil {
		return input, err
	}
	location, err := cleanLocation(input.Location)
	if err != nil {
		return input, err
	}
	ratio, err := checkAspectRatio(input.AspectRatio)
	if err != nil {
		return input, err
	}
	defaultScenes := []SceneListItem{}
	if input.GroupID != nil {
		if len(input.DefaultScenes) > 0 {
			return input, validation("defaultScenes must be empty for a display in a group (the group's list applies)")
		}
	} else if len(input.DefaultScenes) > 0 {
		if defaultScenes, err = checkSceneList(input.DefaultScenes, "defaultScenes"); err != nil {
			return input, err
		}
	}
	input.Name, input.Location, input.AspectRatio, input.DefaultScenes = name, location, ratio, defaultScenes
	return input, nil
}

func defaultScenesRequired() error {
	return validation("defaultScenes must list 1 to %d scenes for a display without a group", maxSceneListItems)
}

// lockJoinedGroup share-locks the group a display joins or stays in and checks that it exists and has the
// display's aspect ratio. The share lock makes a concurrent ratio change of the group wait for this write.
func lockJoinedGroup(
	ctx context.Context,
	q *signagedb.Queries,
	groupID uuid.UUID,
	ratio AspectRatio,
	staying bool,
) error {
	group, err := q.GetSignageDisplayGroupForShare(ctx, groupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return validation("the selected display group does not exist")
	}
	if err != nil {
		return err
	}
	if groupRatio := aspectRatioOf(group.AspectWidth, group.AspectHeight); groupRatio != ratio {
		if staying {
			return validation(
				"a display in a group has the group's aspect ratio (%s); leave the group first",
				groupRatio,
			)
		}
		return validation("a display may only join a group with its aspect ratio (the group has %s)", groupRatio)
	}
	return nil
}

func sameGroup(a, b *uuid.UUID) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// UpdateDisplay changes the draft settings of a display. Joining a group deletes the display's own rules and
// default list; leaving one copies the group's rules (with new ids) and, when the request's default list is
// empty, the group's default list, so the display keeps showing the same.
func (s *Service) UpdateDisplay(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	input DisplayInput,
	requestID *uuid.UUID,
) (Display, error) {
	if err := requireManage(principal); err != nil {
		return Display{}, err
	}
	if err := requireExpected(expected); err != nil {
		return Display{}, err
	}
	checked, err := validateDisplayInput(input)
	if err != nil {
		return Display{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Display{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, err := q.GetSignageDisplayForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Display{}, apperror.NotFound
	}
	if err != nil {
		return Display{}, err
	}
	if current.Version != expected {
		return Display{}, apperror.StaleWrite
	}
	if current.RevokedAt.Valid || current.DeviceRevokedAt.Valid {
		return Display{}, displayRevoked()
	}
	groupChanged := !sameGroup(current.GroupID, checked.GroupID)
	leaving := current.GroupID != nil && checked.GroupID == nil
	if checked.GroupID == nil && len(checked.DefaultScenes) == 0 && !leaving {
		return Display{}, defaultScenesRequired()
	}
	if checked.GroupID != nil {
		if err := lockJoinedGroup(ctx, q, *checked.GroupID, checked.AspectRatio, !groupChanged); err != nil {
			return Display{}, err
		}
	}
	currentDefault, err := decodeSceneList(current.DefaultScenes)
	if err != nil {
		return Display{}, err
	}
	finalDefault := checked.DefaultScenes
	if leaving {
		contents, err := loadGroupContent(ctx, q, []uuid.UUID{*current.GroupID})
		if err != nil {
			return Display{}, err
		}
		group := contents[*current.GroupID]
		for position, rule := range group.Rules {
			if err := insertRule(ctx, q, ruleOwner{DisplayID: id}, ids.New(), position, ruleInputOf(rule)); err != nil {
				return Display{}, err
			}
		}
		if len(finalDefault) == 0 {
			finalDefault = group.DefaultScenes
		}
	}
	if groupChanged && checked.GroupID != nil {
		// Joining: the display shows the group's content and keeps nothing of its own.
		if err := q.DeleteSignageRulesOfDisplay(ctx, &id); err != nil {
			return Display{}, err
		}
	}
	// The default list is checked against the requested ratio, so a ratio change and a matching new
	// default list can be saved together.
	if len(finalDefault) > 0 {
		if err := verifySceneList(ctx, q, checked.AspectRatio, finalDefault, "defaultScenes"); err != nil {
			return Display{}, err
		}
	}
	ratioChanged := aspectRatioOf(current.AspectWidth, current.AspectHeight) != checked.AspectRatio
	if ratioChanged && checked.GroupID == nil {
		mismatched, err := q.CountSceneRulesWithOtherAspectRatio(
			ctx,
			signagedb.CountSceneRulesWithOtherAspectRatioParams{
				DisplayID:   &id,
				AspectWidth: int16(checked.AspectRatio.Width), AspectHeight: int16(checked.AspectRatio.Height),
			},
		)
		if err != nil {
			return Display{}, err
		}
		if mismatched > 0 {
			return Display{}, validation(
				"%d rule(s) show a scene with another aspect ratio; change those rules first",
				mismatched,
			)
		}
	}
	allowOutside := current.AllowCameraOutside
	if checked.AllowCameraOutside != nil {
		allowOutside = *checked.AllowCameraOutside
	}
	if _, err := q.UpdateSignageDisplay(ctx, signagedb.UpdateSignageDisplayParams{
		Name:               checked.Name,
		Location:           checked.Location,
		AspectWidth:        int16(checked.AspectRatio.Width),
		AspectHeight:       int16(checked.AspectRatio.Height),
		VisibleFromOutside: checked.VisibleFromOutside,
		AllowCameraOutside: allowOutside,
		GroupID:            checked.GroupID,
		ID:                 id, ExpectedVersion: expected,
	}); errors.Is(err, pgx.ErrNoRows) {
		return Display{}, apperror.StaleWrite
	} else if err != nil {
		return Display{}, databaseError(err)
	}
	defaultChanged := !sceneListsEqual(currentDefault, finalDefault)
	if defaultChanged {
		if err := replaceDefaultScenes(ctx, q, ruleOwner{DisplayID: id}, finalDefault); err != nil {
			return Display{}, err
		}
	}
	var changed []string
	if groupChanged {
		changed = append(changed, "groupId")
	}
	if current.Name != checked.Name {
		changed = append(changed, "name")
	}
	if current.Location != checked.Location {
		changed = append(changed, "location")
	}
	if ratioChanged {
		changed = append(changed, "aspectRatio")
	}
	if current.VisibleFromOutside != checked.VisibleFromOutside {
		changed = append(changed, "visibleFromOutside")
	}
	if current.AllowCameraOutside != allowOutside {
		changed = append(changed, "allowCameraOutside")
	}
	if defaultChanged {
		changed = append(changed, "defaultScenes")
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_display.updated",
		"signage_display",
		id,
		requestID,
		changed,
	); err != nil {
		return Display{}, err
	}
	result, err := s.getDisplay(ctx, q, id)
	if err != nil {
		return Display{}, err
	}
	return result, tx.Commit(ctx)
}

// RevokeDisplay revokes the display and its managed device in one transaction. The player's
// credential stops working at once; the display row stays until it is deleted.
func (s *Service) RevokeDisplay(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (Display, error) {
	if err := requireManage(principal); err != nil {
		return Display{}, err
	}
	if err := requireExpected(expected); err != nil {
		return Display{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Display{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, err := q.GetSignageDisplayForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Display{}, apperror.NotFound
	}
	if err != nil {
		return Display{}, err
	}
	if current.Version != expected {
		return Display{}, apperror.StaleWrite
	}
	if current.RevokedAt.Valid {
		return Display{}, displayRevoked()
	}
	if _, err := q.RevokeSignageDisplay(
		ctx,
		signagedb.RevokeSignageDisplayParams{ID: id, ExpectedVersion: expected},
	); err != nil {
		return Display{}, err
	}
	if err := manageddevices.RevokeSignagePlayerDeviceTx(
		ctx,
		tx,
		principal,
		current.ManagedDeviceID,
		requestID,
	); err != nil {
		return Display{}, err
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_display.revoked",
		"signage_display",
		id,
		requestID,
		[]string{"revokedAt"},
	); err != nil {
		return Display{}, err
	}
	result, err := s.getDisplay(ctx, q, id)
	if err != nil {
		return Display{}, err
	}
	return result, tx.Commit(ctx)
}

// DeleteDisplay removes a display in any state (revoking its device first), its rules, publications, state and managed device.
func (s *Service) DeleteDisplay(
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
	current, err := q.GetSignageDisplayForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	// An active display is disconnected first; deleting its managed device requires a revoked one.
	if err := manageddevices.RevokeSignagePlayerDeviceTx(
		ctx,
		tx,
		principal,
		current.ManagedDeviceID,
		requestID,
	); err != nil {
		return err
	}
	deviceID, err := q.DeleteSignageDisplay(
		ctx,
		signagedb.DeleteSignageDisplayParams{ID: id, ExpectedVersion: expected},
	)
	if err != nil {
		return databaseError(err)
	}
	if err := manageddevices.DeleteSignagePlayerDeviceTx(ctx, tx, principal, deviceID, requestID); err != nil {
		return err
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_display.deleted",
		"signage_display",
		id,
		requestID,
		nil,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
