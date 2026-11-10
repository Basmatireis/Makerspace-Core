package signage

import (
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

// Scene is one screen composition: freely positioned blocks on a layout grid of the scene's aspect ratio, and
// the background.
type Scene struct {
	ID                uuid.UUID
	Name              string
	AspectRatio       AspectRatio
	BackgroundColor   string
	BackgroundAssetID *uuid.UUID
	BackgroundFit     MediaFit
	BackgroundDim     int
	Theme             Theme
	FontFamily        SceneFontFamily
	FontAssetID       *uuid.UUID
	Blocks            []Block
	Version           int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// SceneInput is the writable part of a scene. Blocks is the JSON array of the scene's blocks; it replaces the
// stored blocks (null or absent is an empty scene).
type SceneInput struct {
	Name              string
	AspectRatio       AspectRatio
	BackgroundColor   string
	BackgroundAssetID *uuid.UUID
	BackgroundFit     MediaFit
	BackgroundDim     int
	Theme             Theme
	// FontFamily empty means sans.
	FontFamily  SceneFontFamily
	FontAssetID *uuid.UUID
	Blocks      json.RawMessage
}

// storedBlocks decodes the blocks column. PostgreSQL normalises jsonb whitespace and key order; widgets are
// handed out in compact form again.
func storedBlocks(raw []byte) ([]Block, error) {
	blocks := []Block{}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil, err
	}
	for index := range blocks {
		compact, err := compactJSON(blocks[index].Widget)
		if err != nil {
			return nil, err
		}
		blocks[index].Widget = compact
	}
	return blocks, nil
}

func sceneFromRow(row signagedb.SignageScene) (Scene, error) {
	blocks, err := storedBlocks(row.Blocks)
	if err != nil {
		return Scene{}, err
	}
	return Scene{
		ID:                row.ID,
		Name:              row.Name,
		AspectRatio:       aspectRatioOf(row.AspectWidth, row.AspectHeight),
		BackgroundColor:   row.BackgroundColor,
		BackgroundAssetID: row.BackgroundAssetID,
		BackgroundFit:     MediaFit(row.BackgroundFit),
		BackgroundDim:     int(row.BackgroundDim),
		Theme:             Theme(row.Theme),
		FontFamily:        SceneFontFamily(row.FontFamily),
		FontAssetID:       row.FontAssetID,
		Blocks:            blocks,
		Version:           row.Version,
		CreatedAt:         row.CreatedAt.UTC(),
		UpdatedAt:         row.UpdatedAt.UTC(),
	}, nil
}

type validatedScene struct {
	SceneInput
	name   string
	blocks []Block
	refs   WidgetRefs
}

func validateSceneInput(input SceneInput) (validatedScene, error) {
	name, err := cleanName(input.Name, "scene name", 100)
	if err != nil {
		return validatedScene{}, err
	}
	ratio, err := checkAspectRatio(input.AspectRatio)
	if err != nil {
		return validatedScene{}, err
	}
	input.AspectRatio = ratio
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
	if input.FontFamily == "" {
		input.FontFamily = SceneFontSans
	}
	switch input.FontFamily {
	case SceneFontSans, SceneFontSerif, SceneFontMono, SceneFontCustom:
	default:
		return validatedScene{}, validation("fontFamily must be sans, serif, mono or custom")
	}
	if (input.FontFamily == SceneFontCustom) != (input.FontAssetID != nil) {
		return validatedScene{}, validation("fontAssetId is required exactly when fontFamily is custom")
	}
	blocks, refs, err := ParseBlocks(input.Blocks)
	if err != nil {
		return validatedScene{}, err
	}
	return validatedScene{SceneInput: input, name: name, blocks: blocks, refs: refs}, nil
}

func samePointer(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// verifyReferences checks that assets (with the right kind), machines and announcement templates
// named by a scene exist. Assets and templates are share-locked so that a concurrent deletion
// either waits for this transaction or finds the new reference.
func (s *Service) verifyReferences(
	ctx context.Context,
	q *signagedb.Queries,
	background, sceneFont *uuid.UUID,
	refs WidgetRefs,
) error {
	images, videos, fonts := refs.ImageAssets, refs.VideoAssets, refs.FontAssets
	if sceneFont != nil {
		fonts = append(append([]uuid.UUID{}, fonts...), *sceneFont)
	}
	if background != nil {
		images = append(append([]uuid.UUID{}, images...), *background)
	}
	if all := distinct(append(append(append([]uuid.UUID{}, images...), videos...), fonts...)); len(all) > 0 {
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
		for _, id := range distinct(fonts) {
			if kinds[id] != AssetKindFont {
				return validation("font asset %s does not exist", id)
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
	encoded, err := marshalBlocks(checked.blocks)
	if err != nil {
		return Scene{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Scene{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if err := s.verifyReferences(ctx, q, input.BackgroundAssetID, input.FontAssetID, checked.refs); err != nil {
		return Scene{}, err
	}
	id := ids.New()
	row, err := q.CreateSignageScene(ctx, signagedb.CreateSignageSceneParams{
		ID:                id,
		Name:              checked.name,
		AspectWidth:       int16(checked.AspectRatio.Width),
		AspectHeight:      int16(checked.AspectRatio.Height),
		BackgroundColor:   input.BackgroundColor,
		BackgroundAssetID: input.BackgroundAssetID,
		BackgroundFit:     string(input.BackgroundFit),
		BackgroundDim:     int32(input.BackgroundDim),
		Theme:             string(input.Theme),
		FontFamily:        string(checked.FontFamily),
		FontAssetID:       input.FontAssetID,
		Blocks:            string(encoded),
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
		[]string{"name", "aspectRatio", "background", "theme", "font", "blocks"},
	); err != nil {
		return Scene{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Scene{}, err
	}
	return sceneFromRow(row)
}

// UpdateScene replaces a scene with all its blocks. Changing the aspect ratio is refused while a rule or default
// scene list shows the scene on a display with another ratio.
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
	encoded, err := marshalBlocks(checked.blocks)
	if err != nil {
		return Scene{}, err
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
	if aspectRatioOf(current.AspectWidth, current.AspectHeight) != checked.AspectRatio {
		mismatched, err := q.CountSceneListsWithOtherAspectRatioForScene(
			ctx,
			signagedb.CountSceneListsWithOtherAspectRatioForSceneParams{
				SceneID:     id,
				AspectWidth: int16(checked.AspectRatio.Width), AspectHeight: int16(checked.AspectRatio.Height),
			},
		)
		if err != nil {
			return Scene{}, err
		}
		if mismatched > 0 {
			return Scene{}, validation(
				"%d rule(s) or default list(s) show this scene on a display with another aspect ratio; change those first",
				mismatched,
			)
		}
	}
	if err := s.verifyReferences(ctx, q, input.BackgroundAssetID, input.FontAssetID, checked.refs); err != nil {
		return Scene{}, err
	}
	changed := sceneChanges(current, checked)
	row, err := q.UpdateSignageScene(ctx, signagedb.UpdateSignageSceneParams{
		Name:              checked.name,
		AspectWidth:       int16(checked.AspectRatio.Width),
		AspectHeight:      int16(checked.AspectRatio.Height),
		BackgroundColor:   input.BackgroundColor,
		BackgroundAssetID: input.BackgroundAssetID,
		BackgroundFit:     string(input.BackgroundFit),
		BackgroundDim:     int32(input.BackgroundDim),
		Theme:             string(input.Theme),
		FontFamily:        string(checked.FontFamily),
		FontAssetID:       input.FontAssetID,
		Blocks:            string(encoded),
		ID:                id,
		ExpectedVersion:   expected,
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

// sceneChanges names the parts of a scene that an update changes; blocks are compared by content.
func sceneChanges(current signagedb.SignageScene, next validatedScene) []string {
	var changed []string
	if current.Name != next.name {
		changed = append(changed, "name")
	}
	if aspectRatioOf(current.AspectWidth, current.AspectHeight) != next.AspectRatio {
		changed = append(changed, "aspectRatio")
	}
	if current.BackgroundColor != next.BackgroundColor || !samePointer(current.BackgroundAssetID, next.BackgroundAssetID) ||
		current.BackgroundFit != string(next.BackgroundFit) || int(current.BackgroundDim) != next.BackgroundDim {
		changed = append(changed, "background")
	}
	if current.Theme != string(next.Theme) {
		changed = append(changed, "theme")
	}
	if current.FontFamily != string(next.FontFamily) || !samePointer(current.FontAssetID, next.FontAssetID) {
		changed = append(changed, "font")
	}
	if stored, err := storedBlocks(current.Blocks); err != nil || blocksDigest(stored) != blocksDigest(next.blocks) {
		changed = append(changed, "blocks")
	}
	return changed
}

// DeleteScene removes a scene that no rule's scene list and no default scene list refers to. Scenes only
// referenced by older publications may be deleted; the publications keep their copy.
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
	rules, err := q.ListRulesReferencingScene(ctx, id)
	if err != nil {
		return err
	}
	for _, rule := range rules {
		references = append(references, ruleReference(rule.OwnerID, rule.GroupOwned, rule.OwnerName, rule.Position))
	}
	displays, err := q.ListDisplaysWithDefaultScene(ctx, id)
	if err != nil {
		return err
	}
	for _, display := range displays {
		references = append(
			references,
			Reference{Kind: ReferenceDisplay, ID: display.ID, Name: "Default scenes of " + display.Name},
		)
	}
	groups, err := q.ListGroupsWithDefaultScene(ctx, id)
	if err != nil {
		return err
	}
	for _, group := range groups {
		references = append(
			references,
			Reference{Kind: ReferenceGroup, ID: group.ID, Name: "Default scenes of " + group.Name},
		)
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
