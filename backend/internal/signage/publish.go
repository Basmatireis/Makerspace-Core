package signage

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// retainedPublications is how many publications per display are kept.
const retainedPublications = 5

// PublishDisplay snapshots the display's drafts (settings, enabled rules, default playlist and every
// scene, playlist and asset they reach) into the next immutable publication. The snapshot is read in a
// repeatable-read transaction so all content comes from one consistent point; revisions are
// assigned under the display row lock. Older publications beyond the latest five are pruned.
func (s *Service) PublishDisplay(ctx context.Context, principal authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (Display, error) {
	display, err := s.publishDisplay(ctx, principal, id, requestID)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "40001" {
		// The display row changed after this transaction's snapshot (e.g. a concurrent edit or
		// publish): the client must reload and publish again.
		return Display{}, apperror.StaleWrite
	}
	return display, err
}

func (s *Service) publishDisplay(ctx context.Context, principal authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (Display, error) {
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
	rules, err := loadRules(ctx, q, []uuid.UUID{id})
	if err != nil {
		return Display{}, err
	}
	draft := displayDraft{
		ID: id, Name: current.Name, Orientation: current.Orientation,
		Resolution:         Resolution{Width: int(current.ResolutionWidth), Height: int(current.ResolutionHeight)},
		VisibleFromOutside: current.VisibleFromOutside, DefaultPlaylistID: current.DefaultPlaylistID, Rules: rules[id],
	}
	manifests, err := s.buildManifests(ctx, q, []displayDraft{draft})
	if err != nil {
		return Display{}, err
	}
	manifest := manifests[id]
	revision, err := q.NextSignagePublicationRevision(ctx, id)
	if err != nil {
		return Display{}, err
	}
	manifest.Revision = int(revision)
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return Display{}, err
	}
	digest := sha256.Sum256(encoded)
	actor := principal.AccountID
	if err := q.InsertSignagePublication(ctx, signagedb.InsertSignagePublicationParams{
		ID: uuid.Must(uuid.NewV7()), DisplayID: id, Revision: revision, Manifest: string(encoded), ManifestSha256: digest[:],
		PublishedByAccountID: &actor, PublishedAt: s.now(),
	}); err != nil {
		return Display{}, databaseError(err)
	}
	if err := q.PruneSignagePublications(ctx, signagedb.PruneSignagePublicationsParams{DisplayID: id, MaxRevision: revision - retainedPublications}); err != nil {
		return Display{}, err
	}
	if err := writeAudit(ctx, tx, principal, "signage_display.published", "signage_display", id, requestID, []string{"revision"}); err != nil {
		return Display{}, err
	}
	result, err := s.getDisplay(ctx, q, id)
	if err != nil {
		return Display{}, err
	}
	return result, tx.Commit(ctx)
}
