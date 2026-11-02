package signage

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// retainedPublications is how many publications per display are kept.
const retainedPublications = 5

// serializationConflict maps a repeatable-read serialization failure to 409 stale_write: a row changed after
// the transaction's snapshot (e.g. a concurrent edit or publish), so the client must reload and publish again.
func serializationConflict(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "40001" {
		return apperror.StaleWrite
	}
	return err
}

// PublishDisplay snapshots the display's drafts (settings, enabled rules, the default scene list and every
// scene, custom layout and asset they reach) into the next immutable publication. A display in a group
// publishes the group's rules and default list. The snapshot is read in a repeatable-read transaction so all
// content comes from one consistent point; revisions are assigned under the display row lock. Older
// publications beyond the latest five are pruned.
func (s *Service) PublishDisplay(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (Display, error) {
	display, err := s.publishDisplay(ctx, principal, id, requestID)
	if err != nil {
		return Display{}, serializationConflict(err)
	}
	return display, nil
}

func (s *Service) publishDisplay(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (Display, error) {
	if !principal.Has(authorization.SignagePublish) {
		return Display{}, apperror.PermissionDenied
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
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
	if current.RevokedAt.Valid || current.DeviceRevokedAt.Valid {
		return Display{}, displayRevoked()
	}
	draft := displayDraft{
		ID: id, Name: current.Name, AspectRatio: aspectRatioOf(current.AspectWidth, current.AspectHeight),
		VisibleFromOutside: current.VisibleFromOutside,
	}
	if current.GroupID != nil {
		contents, err := loadGroupContent(ctx, q, []uuid.UUID{*current.GroupID})
		if err != nil {
			return Display{}, err
		}
		content := contents[*current.GroupID]
		draft.DefaultScenes, draft.Rules = content.DefaultScenes, content.Rules
	} else {
		rules, err := loadRules(ctx, q, []uuid.UUID{id})
		if err != nil {
			return Display{}, err
		}
		if draft.DefaultScenes, err = decodeSceneList(current.DefaultScenes); err != nil {
			return Display{}, err
		}
		draft.Rules = rules[id]
	}
	manifests, err := s.buildManifests(ctx, q, []displayDraft{draft})
	if err != nil {
		return Display{}, err
	}
	if err := s.storePublication(ctx, q, principal, id, manifests[id]); err != nil {
		return Display{}, err
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_display.published",
		"signage_display",
		id,
		requestID,
		[]string{"revision"},
	); err != nil {
		return Display{}, err
	}
	result, err := s.getDisplay(ctx, q, id)
	if err != nil {
		return Display{}, err
	}
	return result, tx.Commit(ctx)
}

// storePublication stores a manifest as the display's next revision and prunes the oldest publications. The
// caller holds the display's row lock.
func (s *Service) storePublication(
	ctx context.Context,
	q *signagedb.Queries,
	principal authorization.Principal,
	displayID uuid.UUID,
	manifest Manifest,
) error {
	revision, err := q.NextSignagePublicationRevision(ctx, displayID)
	if err != nil {
		return err
	}
	manifest.Revision = int(revision)
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(encoded)
	actor := principal.AccountID
	if err := q.InsertSignagePublication(ctx, signagedb.InsertSignagePublicationParams{
		ID:                   ids.New(),
		DisplayID:            displayID,
		Revision:             revision,
		Manifest:             string(encoded),
		ManifestSha256:       digest[:],
		PublishedByAccountID: &actor, PublishedAt: s.now(),
	}); err != nil {
		return databaseError(err)
	}
	return q.PruneSignagePublications(
		ctx,
		signagedb.PruneSignagePublicationsParams{DisplayID: displayID, MaxRevision: revision - retainedPublications},
	)
}
