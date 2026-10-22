package signage

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"slices"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	maxCustomZones     = 12
	maxLayoutTracks    = 12
	maxTrackWeight     = 100
	maxZoneLabelRunes  = 60
	maxLayoutNameRunes = 100

	// Free layouts use percentages of the screen with at most two decimals; values are compared
	// in hundredths so that no floating point rounding decides a bound.
	percentScale   = 100
	fullPercent    = 100 * percentScale
	minFreeExtent  = 1 * percentScale
	maxHundredths  = 1_000_000
	hundredthsSlop = 1e-6
)

var zoneIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// GridPlacement positions a zone on the tracks of a grid layout (1-based grid lines).
type GridPlacement struct {
	Col     int `json:"col"`
	Row     int `json:"row"`
	ColSpan int `json:"colSpan"`
	RowSpan int `json:"rowSpan"`
}

// FreeRect positions a zone of a free layout as percentages of the screen.
type FreeRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// CustomZone is one zone of a custom layout: grid layouts set Grid, free layouts set Rect.
type CustomZone struct {
	ID    string         `json:"id"`
	Label string         `json:"label"`
	Grid  *GridPlacement `json:"grid"`
	Rect  *FreeRect      `json:"rect"`
}

// CustomLayout is a user-defined zone arrangement. Free layouts store the tracks {1} / {1}.
type CustomLayout struct {
	ID         uuid.UUID
	Name       string
	Mode       CustomLayoutMode
	Columns    []int
	Rows       []int
	Zones      []CustomZone
	SceneCount int
	Version    int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// CustomLayoutInput is the writable part of a custom layout.
type CustomLayoutInput struct {
	Name    string
	Mode    CustomLayoutMode
	Columns []int
	Rows    []int
	Zones   []CustomZone
}

// layout reduces the custom layout to the zone list that scene validation and remapping need.
func (l CustomLayout) layout() Layout {
	return customZonesLayout(l.Name, l.Zones)
}

func customZonesLayout(name string, customZones []CustomZone) Layout {
	zones := make([]Zone, 0, len(customZones))
	for _, zone := range customZones {
		zones = append(zones, Zone{ID: zone.ID, Label: zone.Label})
	}
	return Layout{ID: CustomLayoutID, Name: name, Zones: zones}
}

func customLayoutFromRow(
	id uuid.UUID,
	name, mode string,
	columns, rows []int32,
	zones []byte,
	sceneCount int,
	version int64,
	createdAt, updatedAt time.Time,
) (CustomLayout, error) {
	var decoded []CustomZone
	if err := json.Unmarshal(zones, &decoded); err != nil {
		return CustomLayout{}, err
	}
	return CustomLayout{
		ID:         id,
		Name:       name,
		Mode:       CustomLayoutMode(mode),
		Columns:    intsFrom(columns),
		Rows:       intsFrom(rows),
		Zones:      decoded,
		SceneCount: sceneCount,
		Version:    version,
		CreatedAt:  createdAt.UTC(),
		UpdatedAt:  updatedAt.UTC(),
	}, nil
}

func intsFrom(values []int32) []int {
	result := make([]int, 0, len(values))
	for _, value := range values {
		result = append(result, int(value))
	}
	return result
}

func int32sFrom(values []int) []int32 {
	result := make([]int32, 0, len(values))
	for _, value := range values {
		result = append(result, int32(value))
	}
	return result
}

// hundredths converts a percentage with at most two decimals to integer hundredths.
func hundredths(value float64) (int, bool) {
	scaled := value * percentScale
	rounded := math.Round(scaled)
	if math.IsNaN(scaled) || math.Abs(scaled-rounded) > hundredthsSlop || math.Abs(rounded) > maxHundredths {
		return 0, false
	}
	return int(rounded), true
}

func validateTracks(label string, tracks []int) error {
	if len(tracks) < 1 || len(tracks) > maxLayoutTracks {
		return validation("%s need between 1 and %d tracks", label, maxLayoutTracks)
	}
	for _, weight := range tracks {
		if weight < 1 || weight > maxTrackWeight {
			return validation("%s weights must be between 1 and %d", label, maxTrackWeight)
		}
	}
	return nil
}

// validateCustomLayout checks a custom layout and returns its canonical form: trimmed names, free
// layouts with the tracks {1} / {1} and percentages rounded to two decimals.
func validateCustomLayout(input CustomLayoutInput) (CustomLayoutInput, error) {
	name, err := cleanName(input.Name, "layout name", maxLayoutNameRunes)
	if err != nil {
		return CustomLayoutInput{}, err
	}
	if input.Mode != LayoutModeGrid && input.Mode != LayoutModeFree {
		return CustomLayoutInput{}, validation("mode must be grid or free")
	}
	if len(input.Zones) < 1 || len(input.Zones) > maxCustomZones {
		return CustomLayoutInput{}, validation("a layout has between 1 and %d zones", maxCustomZones)
	}
	checked := CustomLayoutInput{Name: name, Mode: input.Mode, Zones: make([]CustomZone, 0, len(input.Zones))}
	if input.Mode == LayoutModeGrid {
		if err := validateTracks("columns", input.Columns); err != nil {
			return CustomLayoutInput{}, err
		}
		if err := validateTracks("rows", input.Rows); err != nil {
			return CustomLayoutInput{}, err
		}
		checked.Columns, checked.Rows = slices.Clone(input.Columns), slices.Clone(input.Rows)
	} else {
		checked.Columns, checked.Rows = []int{1}, []int{1}
	}
	seen := make(map[string]struct{}, len(input.Zones))
	occupied := map[[2]int]string{}
	for _, zone := range input.Zones {
		if !zoneIDPattern.MatchString(zone.ID) {
			return CustomLayoutInput{}, validation(
				"zone id %q must be lowercase letters, digits and underscores, starting with a letter",
				zone.ID,
			)
		}
		if _, duplicate := seen[zone.ID]; duplicate {
			return CustomLayoutInput{}, validation("zone id %q is used twice", zone.ID)
		}
		seen[zone.ID] = struct{}{}
		label, err := cleanName(zone.Label, "zone label", maxZoneLabelRunes)
		if err != nil {
			return CustomLayoutInput{}, err
		}
		cleaned := CustomZone{ID: zone.ID, Label: label}
		if input.Mode == LayoutModeGrid {
			if zone.Grid == nil || zone.Rect != nil {
				return CustomLayoutInput{}, validation("zone %q of a grid layout needs grid and no rect", zone.ID)
			}
			if err := validatePlacement(zone, len(checked.Columns), len(checked.Rows), occupied); err != nil {
				return CustomLayoutInput{}, err
			}
			placement := *zone.Grid
			cleaned.Grid = &placement
		} else {
			if zone.Rect == nil || zone.Grid != nil {
				return CustomLayoutInput{}, validation("zone %q of a free layout needs rect and no grid", zone.ID)
			}
			rect, err := validateRect(zone)
			if err != nil {
				return CustomLayoutInput{}, err
			}
			cleaned.Rect = &rect
		}
		checked.Zones = append(checked.Zones, cleaned)
	}
	return checked, nil
}

func validatePlacement(zone CustomZone, columns, rows int, occupied map[[2]int]string) error {
	grid := zone.Grid
	if grid.Col < 1 || grid.Row < 1 || grid.ColSpan < 1 || grid.RowSpan < 1 ||
		grid.Col+grid.ColSpan-1 > columns || grid.Row+grid.RowSpan-1 > rows {
		return validation("zone %q lies outside the grid tracks", zone.ID)
	}
	for column := grid.Col; column < grid.Col+grid.ColSpan; column++ {
		for row := grid.Row; row < grid.Row+grid.RowSpan; row++ {
			if other, taken := occupied[[2]int{column, row}]; taken {
				return validation("zones %q and %q overlap", other, zone.ID)
			}
			occupied[[2]int{column, row}] = zone.ID
		}
	}
	return nil
}

func validateRect(zone CustomZone) (FreeRect, error) {
	rect := zone.Rect
	x, okX := hundredths(rect.X)
	y, okY := hundredths(rect.Y)
	width, okWidth := hundredths(rect.Width)
	height, okHeight := hundredths(rect.Height)
	if !okX || !okY || !okWidth || !okHeight {
		return FreeRect{}, validation("zone %q: percentages have at most two decimals", zone.ID)
	}
	if x < 0 || y < 0 || width < minFreeExtent || height < minFreeExtent || x+width > fullPercent ||
		y+height > fullPercent {
		return FreeRect{}, validation(
			"zone %q must lie inside the screen with a width and height of at least 1 percent",
			zone.ID,
		)
	}
	return FreeRect{
		X:      float64(x) / percentScale,
		Y:      float64(y) / percentScale,
		Width:  float64(width) / percentScale,
		Height: float64(height) / percentScale,
	}, nil
}

func requireLayoutRead(principal authorization.Principal) error {
	if !principal.Has(authorization.SignageRead) && !principal.Has(authorization.SignageContentManage) {
		return apperror.PermissionDenied
	}
	return nil
}

// ListCustomLayouts returns all custom layouts by name with the number of scenes using each.
func (s *Service) ListCustomLayouts(ctx context.Context, principal authorization.Principal) ([]CustomLayout, error) {
	if err := requireLayoutRead(principal); err != nil {
		return nil, err
	}
	rows, err := signagedb.New(s.pool).ListSignageCustomLayouts(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]CustomLayout, 0, len(rows))
	for _, row := range rows {
		item, err := customLayoutFromRow(
			row.ID, row.Name, row.Mode, row.Columns, row.Rows, row.Zones, int(row.SceneCount),
			row.Version, row.CreatedAt, row.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

// GetCustomLayout reads one custom layout.
func (s *Service) GetCustomLayout(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
) (CustomLayout, error) {
	if err := requireLayoutRead(principal); err != nil {
		return CustomLayout{}, err
	}
	return s.getCustomLayout(ctx, signagedb.New(s.pool), id)
}

func (s *Service) getCustomLayout(ctx context.Context, q *signagedb.Queries, id uuid.UUID) (CustomLayout, error) {
	row, err := q.GetSignageCustomLayout(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return CustomLayout{}, apperror.NotFound
	}
	if err != nil {
		return CustomLayout{}, err
	}
	count, err := q.CountScenesUsingCustomLayout(ctx, id)
	if err != nil {
		return CustomLayout{}, err
	}
	return customLayoutFromRow(
		row.ID, row.Name, row.Mode, row.Columns, row.Rows, row.Zones, int(count),
		row.Version, row.CreatedAt, row.UpdatedAt,
	)
}

func encodeZones(zones []CustomZone) (string, error) {
	encoded, err := json.Marshal(zones)
	return string(encoded), err
}

// CreateCustomLayout validates and stores a custom layout.
func (s *Service) CreateCustomLayout(
	ctx context.Context,
	principal authorization.Principal,
	input CustomLayoutInput,
	requestID *uuid.UUID,
) (CustomLayout, error) {
	if err := requireContentManage(principal); err != nil {
		return CustomLayout{}, err
	}
	checked, err := validateCustomLayout(input)
	if err != nil {
		return CustomLayout{}, err
	}
	zones, err := encodeZones(checked.Zones)
	if err != nil {
		return CustomLayout{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CustomLayout{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	id := ids.New()
	if _, err := q.CreateSignageCustomLayout(ctx, signagedb.CreateSignageCustomLayoutParams{
		ID:      id,
		Name:    checked.Name,
		Mode:    string(checked.Mode),
		Columns: int32sFrom(checked.Columns),
		Rows:    int32sFrom(checked.Rows),
		Zones:   zones,
	}); err != nil {
		return CustomLayout{}, databaseError(err)
	}
	if err := writeAudit(
		ctx, tx, principal, "signage_custom_layout.created", "signage_custom_layout", id, requestID,
		[]string{"name", "mode", "columns", "rows", "zones"},
	); err != nil {
		return CustomLayout{}, err
	}
	result, err := s.getCustomLayout(ctx, q, id)
	if err != nil {
		return CustomLayout{}, err
	}
	return result, tx.Commit(ctx)
}

// reconcileZones keeps the widgets of zone ids that still exist and gives new zone ids an empty
// widget. changed reports whether the set of zone ids differs from the stored one.
func reconcileZones(stored map[string]RawWidget, zoneIDs []string) (zones map[string]RawWidget, changed bool) {
	zones = make(map[string]RawWidget, len(zoneIDs))
	for _, id := range zoneIDs {
		if widget, ok := stored[id]; ok {
			zones[id] = widget
			continue
		}
		zones[id] = emptyWidget
		changed = true
	}
	return zones, changed || len(stored) != len(zoneIDs)
}

// UpdateCustomLayout replaces a custom layout. Scenes that use it lose the widgets of removed zones and
// get empty widgets for new zones in the same transaction; each such scene's version is bumped and the
// change is audited as signage_scene.updated.
func (s *Service) UpdateCustomLayout(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	input CustomLayoutInput,
	requestID *uuid.UUID,
) (CustomLayout, error) {
	if err := requireContentManage(principal); err != nil {
		return CustomLayout{}, err
	}
	if err := requireExpected(expected); err != nil {
		return CustomLayout{}, err
	}
	checked, err := validateCustomLayout(input)
	if err != nil {
		return CustomLayout{}, err
	}
	zones, err := encodeZones(checked.Zones)
	if err != nil {
		return CustomLayout{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CustomLayout{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	current, err := q.GetSignageCustomLayoutForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return CustomLayout{}, apperror.NotFound
	}
	if err != nil {
		return CustomLayout{}, err
	}
	if current.Version != expected {
		return CustomLayout{}, apperror.StaleWrite
	}
	zoneIDs := make([]string, 0, len(checked.Zones))
	for _, zone := range checked.Zones {
		zoneIDs = append(zoneIDs, zone.ID)
	}
	scenes, err := q.ListScenesUsingCustomLayoutForUpdate(ctx, id)
	if err != nil {
		return CustomLayout{}, err
	}
	for _, scene := range scenes {
		stored := map[string]RawWidget{}
		if err := json.Unmarshal(scene.Zones, &stored); err != nil {
			return CustomLayout{}, err
		}
		reconciled, changed := reconcileZones(stored, zoneIDs)
		if !changed {
			continue
		}
		encoded, err := marshalZones(reconciled)
		if err != nil {
			return CustomLayout{}, err
		}
		if err := q.SetSignageSceneZones(
			ctx,
			signagedb.SetSignageSceneZonesParams{ID: scene.ID, Zones: string(encoded)},
		); err != nil {
			return CustomLayout{}, databaseError(err)
		}
		if err := writeAudit(
			ctx, tx, principal, "signage_scene.updated", "signage_scene", scene.ID, requestID, []string{"zones"},
		); err != nil {
			return CustomLayout{}, err
		}
	}
	if _, err := q.UpdateSignageCustomLayout(ctx, signagedb.UpdateSignageCustomLayoutParams{
		Name:            checked.Name,
		Mode:            string(checked.Mode),
		Columns:         int32sFrom(checked.Columns),
		Rows:            int32sFrom(checked.Rows),
		Zones:           zones,
		ID:              id,
		ExpectedVersion: expected,
	}); errors.Is(err, pgx.ErrNoRows) {
		return CustomLayout{}, apperror.StaleWrite
	} else if err != nil {
		return CustomLayout{}, databaseError(err)
	}
	var changed []string
	if current.Name != checked.Name {
		changed = append(changed, "name")
	}
	if current.Mode != string(checked.Mode) {
		changed = append(changed, "mode")
	}
	if !slices.Equal(current.Columns, int32sFrom(checked.Columns)) {
		changed = append(changed, "columns")
	}
	if !slices.Equal(current.Rows, int32sFrom(checked.Rows)) {
		changed = append(changed, "rows")
	}
	if !sameZones(current.Zones, checked.Zones) {
		changed = append(changed, "zones")
	}
	if err := writeAudit(
		ctx, tx, principal, "signage_custom_layout.updated", "signage_custom_layout", id, requestID, changed,
	); err != nil {
		return CustomLayout{}, err
	}
	result, err := s.getCustomLayout(ctx, q, id)
	if err != nil {
		return CustomLayout{}, err
	}
	return result, tx.Commit(ctx)
}

// sameZones compares the stored zones with the new ones by their canonical JSON.
func sameZones(stored []byte, zones []CustomZone) bool {
	var decoded []CustomZone
	if json.Unmarshal(stored, &decoded) != nil {
		return false
	}
	before, errBefore := json.Marshal(decoded)
	after, errAfter := json.Marshal(zones)
	return errBefore == nil && errAfter == nil && string(before) == string(after)
}

// DeleteCustomLayout removes a custom layout that no scene uses.
func (s *Service) DeleteCustomLayout(
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
	current, err := q.GetSignageCustomLayoutForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	scenes, err := q.ListScenesUsingCustomLayoutForUpdate(ctx, id)
	if err != nil {
		return err
	}
	if len(scenes) > 0 {
		references := make([]Reference, 0, len(scenes))
		for _, scene := range scenes {
			references = append(references, Reference{Kind: ReferenceScene, ID: scene.ID, Name: scene.Name})
		}
		return inUse("Custom layout", references)
	}
	if _, err := q.DeleteSignageCustomLayout(
		ctx,
		signagedb.DeleteSignageCustomLayoutParams{ID: id, ExpectedVersion: expected},
	); errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	if err := writeAudit(
		ctx, tx, principal, "signage_custom_layout.deleted", "signage_custom_layout", id, requestID, nil,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
