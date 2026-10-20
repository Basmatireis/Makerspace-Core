package signage

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const maxPlaylistItems = 100

// PlaylistItem is one scene slot of a playlist.
type PlaylistItem struct {
	SceneID    uuid.UUID
	Seconds    int
	Transition string
}

// Playlist is an ordered list of scenes with seconds per item and a transition.
type Playlist struct {
	ID        uuid.UUID
	Name      string
	Items     []PlaylistItem
	Version   int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

// PlaylistInput is the writable part of a playlist; Items replace the stored items atomically.
type PlaylistInput struct {
	Name  string
	Items []PlaylistItem
}

func playlistFrom(row signagedb.SignagePlaylist, items []PlaylistItem) Playlist {
	if items == nil {
		items = []PlaylistItem{}
	}
	return Playlist{
		ID:        row.ID,
		Name:      row.Name,
		Items:     items,
		Version:   row.Version,
		CreatedAt: row.CreatedAt.UTC(),
		UpdatedAt: row.UpdatedAt.UTC(),
	}
}

func validatePlaylistInput(ctx context.Context, q *signagedb.Queries, input PlaylistInput) (string, error) {
	name, err := cleanName(input.Name, "playlist name", 100)
	if err != nil {
		return "", err
	}
	if len(input.Items) > maxPlaylistItems {
		return "", validation("a playlist holds at most %d items", maxPlaylistItems)
	}
	scenes := make([]uuid.UUID, 0, len(input.Items))
	for _, item := range input.Items {
		if item.Seconds < 3 || item.Seconds > 3600 {
			return "", validation("item seconds must be between 3 and 3600")
		}
		if item.Transition != "cut" && item.Transition != "fade" {
			return "", validation("item transition must be cut or fade")
		}
		scenes = append(scenes, item.SceneID)
	}
	if distinctScenes := distinct(scenes); len(distinctScenes) > 0 {
		found, err := q.ListSignageSceneIDs(ctx, uuidStrings(distinctScenes))
		if err != nil {
			return "", err
		}
		if len(found) != len(distinctScenes) {
			return "", validation("a playlist item references a scene that does not exist")
		}
	}
	return name, nil
}

func replaceItems(ctx context.Context, q *signagedb.Queries, playlistID uuid.UUID, items []PlaylistItem) error {
	if err := q.DeleteSignagePlaylistItems(ctx, playlistID); err != nil {
		return err
	}
	for position, item := range items {
		if err := q.InsertSignagePlaylistItem(ctx, signagedb.InsertSignagePlaylistItemParams{
			PlaylistID: playlistID,
			Position:   int32(position),
			SceneID:    item.SceneID,
			Seconds:    int32(item.Seconds),
			Transition: item.Transition,
		}); err != nil {
			return databaseError(err)
		}
	}
	return nil
}

func itemsByPlaylist(rows []signagedb.SignagePlaylistItem) map[uuid.UUID][]PlaylistItem {
	result := map[uuid.UUID][]PlaylistItem{}
	for _, row := range rows {
		result[row.PlaylistID] = append(
			result[row.PlaylistID],
			PlaylistItem{SceneID: row.SceneID, Seconds: int(row.Seconds), Transition: row.Transition},
		)
	}
	return result
}

// ListPlaylists returns all playlists with their items.
func (s *Service) ListPlaylists(ctx context.Context, principal authorization.Principal) ([]Playlist, error) {
	if err := requireRead(principal); err != nil {
		return nil, err
	}
	q := signagedb.New(s.pool)
	rows, err := q.ListSignagePlaylists(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	itemRows, err := q.ListSignagePlaylistItems(ctx, uuidStrings(ids))
	if err != nil {
		return nil, err
	}
	items := itemsByPlaylist(itemRows)
	result := make([]Playlist, 0, len(rows))
	for _, row := range rows {
		result = append(result, playlistFrom(row, items[row.ID]))
	}
	return result, nil
}

// GetPlaylist reads one playlist.
func (s *Service) GetPlaylist(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Playlist, error) {
	if err := requireRead(principal); err != nil {
		return Playlist{}, err
	}
	return s.getPlaylist(ctx, signagedb.New(s.pool), id)
}

func (s *Service) getPlaylist(ctx context.Context, q *signagedb.Queries, id uuid.UUID) (Playlist, error) {
	row, err := q.GetSignagePlaylist(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Playlist{}, apperror.NotFound
	}
	if err != nil {
		return Playlist{}, err
	}
	itemRows, err := q.ListSignagePlaylistItems(ctx, []string{id.String()})
	if err != nil {
		return Playlist{}, err
	}
	return playlistFrom(row, itemsByPlaylist(itemRows)[id]), nil
}

// CreatePlaylist stores a playlist with its items.
func (s *Service) CreatePlaylist(
	ctx context.Context,
	principal authorization.Principal,
	input PlaylistInput,
	requestID *uuid.UUID,
) (Playlist, error) {
	if err := requireContentManage(principal); err != nil {
		return Playlist{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	name, err := validatePlaylistInput(ctx, q, input)
	if err != nil {
		return Playlist{}, err
	}
	id := ids.New()
	if _, err := q.CreateSignagePlaylist(ctx, signagedb.CreateSignagePlaylistParams{ID: id, Name: name}); err != nil {
		return Playlist{}, databaseError(err)
	}
	if err := replaceItems(ctx, q, id, input.Items); err != nil {
		return Playlist{}, err
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_playlist.created",
		"signage_playlist",
		id,
		requestID,
		[]string{"name", "items"},
	); err != nil {
		return Playlist{}, err
	}
	result, err := s.getPlaylist(ctx, q, id)
	if err != nil {
		return Playlist{}, err
	}
	return result, tx.Commit(ctx)
}

// UpdatePlaylist renames a playlist and replaces its items in one transaction.
func (s *Service) UpdatePlaylist(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	input PlaylistInput,
	requestID *uuid.UUID,
) (Playlist, error) {
	if err := requireContentManage(principal); err != nil {
		return Playlist{}, err
	}
	if err := requireExpected(expected); err != nil {
		return Playlist{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Playlist{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	name, err := validatePlaylistInput(ctx, q, input)
	if err != nil {
		return Playlist{}, err
	}
	current, err := q.GetSignagePlaylistForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Playlist{}, apperror.NotFound
	}
	if err != nil {
		return Playlist{}, err
	}
	if current.Version != expected {
		return Playlist{}, apperror.StaleWrite
	}
	if _, err := q.UpdateSignagePlaylist(
		ctx,
		signagedb.UpdateSignagePlaylistParams{Name: name, ID: id, ExpectedVersion: expected},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return Playlist{}, apperror.StaleWrite
	} else if err != nil {
		return Playlist{}, databaseError(err)
	}
	if err := replaceItems(ctx, q, id, input.Items); err != nil {
		return Playlist{}, err
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_playlist.updated",
		"signage_playlist",
		id,
		requestID,
		[]string{"name", "items"},
	); err != nil {
		return Playlist{}, err
	}
	result, err := s.getPlaylist(ctx, q, id)
	if err != nil {
		return Playlist{}, err
	}
	return result, tx.Commit(ctx)
}

// DeletePlaylist removes a playlist that no display (as default) or rule references.
func (s *Service) DeletePlaylist(
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
	current, err := q.GetSignagePlaylistForUpdate(ctx, id)
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
	displays, err := q.ListDisplaysByDefaultPlaylist(ctx, id)
	if err != nil {
		return err
	}
	for _, display := range displays {
		references = append(references, Reference{Kind: "display_default", ID: display.ID, Name: display.Name})
	}
	rules, err := q.ListRulesReferencingPlaylist(ctx, &id)
	if err != nil {
		return err
	}
	for _, rule := range rules {
		references = append(references, Reference{Kind: "display_rule", ID: rule.DisplayID, Name: rule.DisplayName})
	}
	if len(references) > 0 {
		return inUse("Playlist", references)
	}
	if _, err := q.DeleteSignagePlaylist(
		ctx,
		signagedb.DeleteSignagePlaylistParams{ID: id, ExpectedVersion: expected},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_playlist.deleted",
		"signage_playlist",
		id,
		requestID,
		nil,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
