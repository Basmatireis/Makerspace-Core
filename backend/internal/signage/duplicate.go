package signage

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// maxCopyNameRunes is the longest name any signage content item may have.
const maxCopyNameRunes = 100

// copyName is the first of "<name> (copy)", "<name> (copy 2)", "<name> (copy 3)", … that no existing item
// uses (compared exactly, case-sensitively). The original name is shortened so that the result fits 100
// characters.
func copyName(name string, taken []string) string {
	used := make(map[string]struct{}, len(taken))
	for _, existing := range taken {
		used[existing] = struct{}{}
	}
	for n := 1; ; n++ {
		suffix := " (copy)"
		if n > 1 {
			suffix = " (copy " + strconv.Itoa(n) + ")"
		}
		base := name
		if limit := maxCopyNameRunes - utf8.RuneCountInString(suffix); utf8.RuneCountInString(base) > limit {
			base = strings.TrimRight(string([]rune(base)[:limit]), " ")
		}
		candidate := base + suffix
		if _, ok := used[candidate]; !ok {
			return candidate
		}
	}
}

// DuplicateScene stores a copy of a scene: every field and block of the source with a fresh id and
// version 1, named by copyName.
func (s *Service) DuplicateScene(
	ctx context.Context,
	principal authorization.Principal,
	sourceID uuid.UUID,
	requestID *uuid.UUID,
) (Scene, error) {
	if err := requireContentManage(principal); err != nil {
		return Scene{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Scene{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	source, err := q.GetSignageScene(ctx, sourceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Scene{}, apperror.NotFound
	}
	if err != nil {
		return Scene{}, err
	}
	names, err := q.ListSignageSceneNames(ctx)
	if err != nil {
		return Scene{}, err
	}
	id := ids.New()
	row, err := q.CreateSignageScene(ctx, signagedb.CreateSignageSceneParams{
		ID:                id,
		Name:              copyName(source.Name, names),
		AspectWidth:       source.AspectWidth,
		AspectHeight:      source.AspectHeight,
		BackgroundColor:   source.BackgroundColor,
		BackgroundAssetID: source.BackgroundAssetID,
		BackgroundFit:     source.BackgroundFit,
		BackgroundDim:     source.BackgroundDim,
		Theme:             source.Theme,
		FontFamily:        source.FontFamily,
		FontAssetID:       source.FontAssetID,
		Blocks:            string(source.Blocks),
	})
	if err != nil {
		return Scene{}, databaseError(err)
	}
	if err := writeAudit(
		ctx, tx, principal, "signage_scene.created", "signage_scene", id, requestID,
		[]string{"name", "aspectRatio", "background", "theme", "font", "blocks"},
	); err != nil {
		return Scene{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Scene{}, err
	}
	return sceneFromRow(row)
}

// DuplicateTemplate stores a copy of an announcement template with its fields.
func (s *Service) DuplicateTemplate(
	ctx context.Context,
	principal authorization.Principal,
	sourceID uuid.UUID,
	requestID *uuid.UUID,
) (Template, error) {
	if err := requireContentManage(principal); err != nil {
		return Template{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Template{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	source, err := s.getTemplate(ctx, q, sourceID)
	if err != nil {
		return Template{}, err
	}
	names, err := q.ListSignageTemplateNames(ctx)
	if err != nil {
		return Template{}, err
	}
	id := ids.New()
	if _, err := q.CreateSignageTemplate(ctx, signagedb.CreateSignageTemplateParams{
		ID:         id,
		Name:       copyName(source.Name, names),
		Tone:       string(source.Tone),
		Title:      source.Title,
		Body:       source.Body,
		BodyFormat: string(source.BodyFormat),
		BodyCss:    source.BodyCSS,
	}); err != nil {
		return Template{}, databaseError(err)
	}
	if err := insertFields(ctx, q, id, source.Fields); err != nil {
		return Template{}, err
	}
	if err := writeAudit(
		ctx, tx, principal, "signage_announcement_template.created", "signage_announcement_template", id, requestID,
		[]string{"name", "tone", "title", "body", "bodyFormat", "bodyCss", "fields"},
	); err != nil {
		return Template{}, err
	}
	result, err := s.getTemplate(ctx, q, id)
	if err != nil {
		return Template{}, err
	}
	return result, tx.Commit(ctx)
}
