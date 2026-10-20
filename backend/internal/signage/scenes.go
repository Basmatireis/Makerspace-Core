package signage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var colorPattern = regexp.MustCompile(`^#[0-9a-f]{6}$`)

// Scene is one screen composition: a layout plus one widget per zone and the background.
type Scene struct {
	ID                uuid.UUID
	Name              string
	Orientation       Orientation
	LayoutID          string
	BackgroundColor   string
	BackgroundAssetID *uuid.UUID
	BackgroundFit     MediaFit
	BackgroundDim     int
	Theme             Theme
	Zones             map[string]RawWidget
	Version           int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// SceneInput is the writable part of a scene. A nil Zones keeps the stored widgets (remapped by
// position when the layout changes) on update and creates empty zones on create.
type SceneInput struct {
	Name              string
	Orientation       Orientation
	LayoutID          string
	BackgroundColor   string
	BackgroundAssetID *uuid.UUID
	BackgroundFit     MediaFit
	BackgroundDim     int
	Theme             Theme
	Zones             map[string]json.RawMessage
}

func sceneFromRow(row signagedb.SignageScene) (Scene, error) {
	stored := map[string]RawWidget{}
	if err := json.Unmarshal(row.Zones, &stored); err != nil {
		return Scene{}, err
	}
	// PostgreSQL normalises jsonb whitespace; hand out the compact canonical form again.
	zones := make(map[string]RawWidget, len(stored))
	for key, widget := range stored {
		var compact bytes.Buffer
		if err := json.Compact(&compact, widget); err != nil {
			return Scene{}, err
		}
		zones[key] = compact.Bytes()
	}
	return Scene{
		ID:                row.ID,
		Name:              row.Name,
		Orientation:       Orientation(row.Orientation),
		LayoutID:          row.LayoutID,
		BackgroundColor:   row.BackgroundColor,
		BackgroundAssetID: row.BackgroundAssetID,
		BackgroundFit:     MediaFit(row.BackgroundFit),
		BackgroundDim:     int(row.BackgroundDim),
		Theme:             Theme(row.Theme),
		Zones:             zones, Version: row.Version, CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
	}, nil
}

type validatedScene struct {
	SceneInput
	name   string
	layout Layout
}

func validateSceneInput(input SceneInput) (validatedScene, error) {
	name, err := cleanName(input.Name, "scene name", 100)
	if err != nil {
		return validatedScene{}, err
	}
	layout, ok := LayoutByID(input.LayoutID)
	if !ok {
		return validatedScene{}, validation("layoutId is not a known layout")
	}
	if input.Orientation != OrientationPortrait && input.Orientation != OrientationLandscape {
		return validatedScene{}, validation("orientation must be portrait or landscape")
	}
	if !colorPattern.MatchString(input.BackgroundColor) {
		return validatedScene{}, validation("backgroundColor must be a lowercase #rrggbb colour")
	}
	if input.BackgroundFit != MediaFitCover && input.BackgroundFit != MediaFitContain {
		return validatedScene{}, validation("backgroundFit must be cover or contain")
	}
	if input.BackgroundDim < 0 || input.BackgroundDim > 80 {
		return validatedScene{}, validation("backgroundDim must be between 0 and 80")
	}
	if input.Theme != ThemeDark && input.Theme != ThemeLight {
		return validatedScene{}, validation("theme must be dark or light")
	}
	return validatedScene{SceneInput: input, name: name, layout: layout}, nil
}

// verifyReferences checks that assets (with the right kind), machines and announcement templates
// named by a scene exist. Assets and templates are share-locked so that a concurrent deletion
// either waits for this transaction or finds the new reference.
func (s *Service) verifyReferences(
	ctx context.Context,
	q *signagedb.Queries,
	background *uuid.UUID,
	refs WidgetRefs,
) error {
	images, videos := refs.ImageAssets, refs.VideoAssets
	if background != nil {
		images = append(append([]uuid.UUID{}, images...), *background)
	}
	if all := distinct(append(append([]uuid.UUID{}, images...), videos...)); len(all) > 0 {
		rows, err := q.ListSignageAssetKinds(ctx, uuidStrings(all))
		if err != nil {
			return err
		}
		kinds := make(map[uuid.UUID]AssetKind, len(rows))
		for _, row := range rows {
			kinds[row.ID] = AssetKind(row.Kind)
		}
		for _, id := range distinct(images) {
			if kinds[id] != AssetKindImage {
				return validation("image asset %s does not exist", id)
			}
		}
		for _, id := range distinct(videos) {
			if kinds[id] != AssetKindVideo {
				return validation("video asset %s does not exist", id)
			}
		}
	}
	if len(refs.Machines) > 0 {
		rows, err := q.ListSignageMachineNames(ctx, uuidStrings(refs.Machines))
		if err != nil {
			return err
		}
		if len(rows) != len(refs.Machines) {
			return validation("a referenced machine does not exist")
		}
	}
	if len(refs.Templates) > 0 {
		ids, err := q.ListSignageTemplateIDsForShare(ctx, uuidStrings(refs.Templates))
		if err != nil {
			return err
		}
		if len(ids) != len(refs.Templates) {
			return validation("a referenced announcement template does not exist")
		}
	}
	return nil
}

// ListScenes returns all scenes ordered by name.
func (s *Service) ListScenes(ctx context.Context, principal authorization.Principal) ([]Scene, error) {
	if err := requireRead(principal); err != nil {
		return nil, err
	}
	rows, err := signagedb.New(s.pool).ListSignageScenes(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]Scene, 0, len(rows))
	for _, row := range rows {
		scene, err := sceneFromRow(row)
		if err != nil {
			return nil, err
		}
		items = append(items, scene)
	}
	return items, nil
}

// GetScene reads one scene.
func (s *Service) GetScene(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Scene, error) {
	if err := requireRead(principal); err != nil {
		return Scene{}, err
	}
	row, err := signagedb.New(s.pool).GetSignageScene(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Scene{}, apperror.NotFound
	}
	if err != nil {
		return Scene{}, err
	}
	return sceneFromRow(row)
}

// CreateScene validates and stores a scene.
func (s *Service) CreateScene(
	ctx context.Context,
	principal authorization.Principal,
	input SceneInput,
	requestID *uuid.UUID,
) (Scene, error) {
	if err := requireContentManage(principal); err != nil {
		return Scene{}, err
	}
	checked, err := validateSceneInput(input)
	if err != nil {
		return Scene{}, err
	}
	zones := emptyZones(checked.layout)
	var refs WidgetRefs
	if input.Zones != nil {
		if zones, refs, err = ParseZones(checked.layout, input.Zones); err != nil {
			return Scene{}, err
		}
	}
	encoded, err := marshalZones(zones)
	if err != nil {
		return Scene{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Scene{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if err := s.verifyReferences(ctx, q, input.BackgroundAssetID, refs); err != nil {
		return Scene{}, err
	}
	id := ids.New()
	row, err := q.CreateSignageScene(ctx, signagedb.CreateSignageSceneParams{
		ID:                id,
		Name:              checked.name,
		Orientation:       string(input.Orientation),
		LayoutID:          input.LayoutID,
		BackgroundColor:   input.BackgroundColor,
		BackgroundAssetID: input.BackgroundAssetID,
		BackgroundFit:     string(input.BackgroundFit),
		BackgroundDim:     int32(input.BackgroundDim),
		Theme:             string(input.Theme),
		Zones:             string(encoded),
	})
	if err != nil {
		return Scene{}, databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_scene.created",
		"signage_scene",
		id,
		requestID,
		[]string{"name", "orientation", "layoutId", "background", "theme", "zones"},
	); err != nil {
		return Scene{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Scene{}, err
	}
	return sceneFromRow(row)
}

// UpdateScene replaces a scene. Changing the layout without new zones keeps the existing widgets
// by position (zone n of the new layout takes the widget of zone n of the old one).
func (s *Service) UpdateScene(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	input SceneInput,
	requestID *uuid.UUID,
) (Scene, error) {
	if err := requireContentManage(principal); err != nil {
		return Scene{}, err
	}
	if err := requireExpected(expected); err != nil {
		return Scene{}, err
	}
	checked, err := validateSceneInput(input)
	if err != nil {
		return Scene{}, err
	}
	var parsed map[string]RawWidget
	var refs WidgetRefs
	if input.Zones != nil {
		if parsed, refs, err = ParseZones(checked.layout, input.Zones); err != nil {
			return Scene{}, err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Scene{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, err := q.GetSignageSceneForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Scene{}, apperror.NotFound
	}
	if err != nil {
		return Scene{}, err
	}
	if current.Version != expected {
		return Scene{}, apperror.StaleWrite
	}
	changed := []string{"name", "orientation", "layoutId", "background", "theme"}
	zones := parsed
	if zones == nil {
		stored := map[string]RawWidget{}
		if err := json.Unmarshal(current.Zones, &stored); err != nil {
			return Scene{}, err
		}
		zones = stored
		if current.LayoutID != input.LayoutID {
			previous, known := LayoutByID(current.LayoutID)
			if known {
				zones = remapZones(previous, stored, checked.layout)
			} else {
				zones = emptyZones(checked.layout)
			}
			changed = append(changed, "zones")
		}
	} else {
		changed = append(changed, "zones")
	}
	if err := s.verifyReferences(ctx, q, input.BackgroundAssetID, refs); err != nil {
		return Scene{}, err
	}
	encoded, err := marshalZones(zones)
	if err != nil {
		return Scene{}, err
	}
	row, err := q.UpdateSignageScene(ctx, signagedb.UpdateSignageSceneParams{
		Name:              checked.name,
		Orientation:       string(input.Orientation),
		LayoutID:          input.LayoutID,
		BackgroundColor:   input.BackgroundColor,
		BackgroundAssetID: input.BackgroundAssetID,
		BackgroundFit:     string(input.BackgroundFit),
		BackgroundDim:     int32(input.BackgroundDim),
		Theme:             string(input.Theme),
		Zones:             string(encoded), ID: id, ExpectedVersion: expected,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Scene{}, apperror.StaleWrite
	}
	if err != nil {
		return Scene{}, databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_scene.updated",
		"signage_scene",
		id,
		requestID,
		changed,
	); err != nil {
		return Scene{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Scene{}, err
	}
	return sceneFromRow(row)
}

// DeleteScene removes a scene that no playlist or rule references.
func (s *Service) DeleteScene(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := requireContentManage(principal); err != nil {
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
	current, err := q.GetSignageSceneForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	var references []Reference
	playlists, err := q.ListPlaylistsReferencingScene(ctx, id)
	if err != nil {
		return err
	}
	for _, playlist := range playlists {
		references = append(references, Reference{Kind: ReferencePlaylist, ID: playlist.ID, Name: playlist.Name})
	}
	rules, err := q.ListRulesReferencingScene(ctx, &id)
	if err != nil {
		return err
	}
	for _, rule := range rules {
		references = append(references, Reference{Kind: ReferenceDisplayRule, ID: rule.DisplayID, Name: rule.DisplayName})
	}
	if len(references) > 0 {
		return inUse("Scene", references)
	}
	if _, err := q.DeleteSignageScene(
		ctx,
		signagedb.DeleteSignageSceneParams{ID: id, ExpectedVersion: expected},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	if err := writeAudit(ctx, tx, principal, "signage_scene.deleted", "signage_scene", id, requestID, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
