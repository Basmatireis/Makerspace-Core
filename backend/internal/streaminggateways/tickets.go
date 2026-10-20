package streaminggateways

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateways/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/streamticket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	// retiredKeyValidity is how long a rotated-out public key stays in gateway configurations, so tickets
	// signed just before the rotation (valid 5 minutes) keep working.
	retiredKeyValidity = 10 * time.Minute
	signingKeyCacheTTL = time.Minute
	// keyActivationDelay is how long a rotated-in key is published before it signs, so every gateway
	// (polling every 30 s) knows it by the time the first ticket carries it.
	keyActivationDelay = 60 * time.Second
)

// StreamName is the stable go2rtc stream name of a machine's camera.
func StreamName(machineID uuid.UUID) string { return streamticket.StreamName(machineID) }

type signingKey struct {
	kid     string
	private ed25519.PrivateKey
	// pendingAt is when a published, not yet signing key becomes the signing key (nil without one).
	pendingAt *time.Time
	loadedAt  time.Time
}

// Stream is one camera stream a display may watch right now.
type Stream struct {
	MachineID uuid.UUID
	WebRTCURL string
	MSEURL    string
	Ticket    string
	ExpiresAt time.Time
}

func ticketKeyPurpose(id uuid.UUID) string { return "signage-ticket-key:" + id.String() }

// activeKey returns the signing key, generating the very first one on demand and promoting a
// pending key whose activation time has come.
func (s *Service) activeKey(ctx context.Context) (*signingKey, error) {
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	now := s.now()
	if s.cachedKey != nil && now.Sub(s.cachedKey.loadedAt) < signingKeyCacheTTL &&
		(s.cachedKey.pendingAt == nil || now.Before(*s.cachedKey.pendingAt)) {
		return s.cachedKey, nil
	}
	if s.keyring == nil {
		return nil, conflictEncryption()
	}
	if err := s.promoteDueKey(ctx, false); err != nil {
		return nil, err
	}
	key, err := s.loadActiveKey(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		if err = s.createKey(ctx, db.InsertTicketKeyParams{State: "active"}, "signage_ticket_key.created", nil, nil); err != nil {
			return nil, err
		}
		key, err = s.loadActiveKey(ctx)
	}
	if err != nil {
		return nil, err
	}
	s.cachedKey = key
	return key, nil
}

func conflictEncryption() error {
	return conflict(
		"encryption_not_configured",
		"Application encryption must be configured before stream tickets can be signed",
	)
}

func (s *Service) loadActiveKey(ctx context.Context) (*signingKey, error) {
	q := db.New(s.pool)
	row, err := q.GetActiveTicketKey(ctx)
	if err != nil {
		return nil, err
	}
	seed, err := s.keyring.Decrypt(row.EncryptedPrivateKey, ticketKeyPurpose(row.ID))
	if err != nil {
		return nil, err
	}
	if len(seed) != ed25519.SeedSize {
		return nil, errors.New("stored ticket signing key is invalid")
	}
	key := &signingKey{kid: row.Kid, private: ed25519.NewKeyFromSeed(seed), loadedAt: s.now()}
	if pending, pendingErr := q.GetPendingTicketKey(ctx); pendingErr == nil && pending.ActivatesAt.Valid {
		at := pending.ActivatesAt.Time.UTC()
		key.pendingAt = &at
	} else if pendingErr != nil && !errors.Is(pendingErr, pgx.ErrNoRows) {
		return nil, pendingErr
	}
	return key, nil
}

// promoteDueKey makes the pending key the signing key when its activation time has passed (or
// unconditionally with force) and retires the previous signing key. It is a no-op without a pending
// key and safe against concurrent callers.
func (s *Service) promoteDueKey(ctx context.Context, force bool) error {
	_, err := s.promote(ctx, db.New(s.pool), force)
	return err
}

func (s *Service) promote(ctx context.Context, q *db.Queries, force bool) (bool, error) {
	if _, err := q.GetPendingTicketKey(ctx); errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tq := db.New(tx)
	if _, err = tq.LockTicketKeys(ctx); err != nil {
		return false, err
	}
	pending, err := tq.GetPendingTicketKey(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // another caller promoted it
	}
	if err != nil {
		return false, err
	}
	now := s.now()
	if !force && (!pending.ActivatesAt.Valid || now.Before(pending.ActivatesAt.Time)) {
		return false, nil
	}
	if err = tq.RetireActiveTicketKey(ctx, timestamptz(&now)); err != nil {
		return false, err
	}
	if err = tq.ActivatePendingTicketKey(ctx); err != nil {
		return false, err
	}
	if err = tq.BumpAllGatewayConfigurations(ctx); err != nil {
		return false, err
	}
	id := pending.ID
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "signage_ticket_key.activated", ResourceType: "signage_ticket_key", ResourceID: &id, ChangedFields: []string{"signingKey"}, Source: "system"}); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	s.cachedKey = nil
	return true, nil
}

// createKey inserts a new key. A concurrent creator that loses the unique-key race is a no-op.
// actor and requestID attribute an administrator-initiated rotation; without them the event is a
// system event.
func (s *Service) createKey(
	ctx context.Context,
	params db.InsertTicketKeyParams,
	action string,
	actor *uuid.UUID,
	requestID *uuid.UUID,
) error {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	id := uuid.Must(uuid.NewV7())
	encrypted, err := s.keyring.Encrypt(private.Seed(), ticketKeyPurpose(id))
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	now := s.now()
	params.ID, params.Kid, params.PublicKey, params.EncryptedPrivateKey = id, streamticket.KeyID(
		public,
	), public, encrypted
	inserted, err := q.InsertTicketKey(ctx, params)
	if err != nil {
		return databaseError(err)
	}
	if inserted == 0 {
		return nil // another instance created the key concurrently
	}
	if params.State == "pending" {
		if err = q.BumpAllGatewayConfigurations(ctx); err != nil {
			return err
		}
	}
	if err = q.DeleteExpiredTicketKeys(ctx, timestamptz(ptrTime(now.Add(-24*time.Hour)))); err != nil {
		return err
	}
	event := audit.Event{
		ActorType:     "system",
		Action:        action,
		ResourceType:  "signage_ticket_key",
		ResourceID:    &id,
		ChangedFields: []string{"signingKey"},
		Source:        "system",
		RequestID:     requestID,
	}
	if actor != nil {
		event = audit.Event{
			ActorAccountID: actor,
			Action:         action,
			ResourceType:   "signage_ticket_key",
			ResourceID:     &id,
			ChangedFields:  []string{"signingKey"},
			RequestID:      requestID,
		}
	}
	if err = audit.Write(ctx, tx, event); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// KeyRotation describes a started rotation.
type KeyRotation struct {
	KeyID       string
	ActivatesAt time.Time
}

// RotateTicketKey starts a key rotation: it creates the next key as pending, publishes its public
// half to the gateways at once and makes it the signing key after keyActivationDelay (lazily, when a
// ticket is signed after that time, or by the next rotation call, which activates a still pending
// key first). The previous public key stays in gateway configurations for ten minutes after its
// retirement. Needs local_services.manage.
func (s *Service) RotateTicketKey(
	ctx context.Context,
	principal authorization.Principal,
	requestID *uuid.UUID,
) (KeyRotation, error) {
	if err := requireManage(principal); err != nil {
		return KeyRotation{}, err
	}
	if s.keyring == nil {
		return KeyRotation{}, conflictEncryption()
	}
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	s.cachedKey = nil
	if _, err := db.New(s.pool).GetActiveTicketKey(ctx); errors.Is(err, pgx.ErrNoRows) {
		if err = s.createKey(ctx, db.InsertTicketKeyParams{State: "active"}, "signage_ticket_key.created", nil, nil); err != nil {
			return KeyRotation{}, err
		}
	} else if err != nil {
		return KeyRotation{}, err
	}
	if _, err := s.promote(ctx, db.New(s.pool), true); err != nil {
		return KeyRotation{}, err
	}
	activates := s.now().Add(keyActivationDelay)
	actor := principal.AccountID
	if err := s.createKey(ctx, db.InsertTicketKeyParams{State: "pending", ActivatesAt: timestamptz(&activates)}, "signage_ticket_key.rotated", &actor, requestID); err != nil {
		return KeyRotation{}, err
	}
	pending, err := db.New(s.pool).GetPendingTicketKey(ctx)
	if err != nil {
		return KeyRotation{}, err
	}
	return KeyRotation{KeyID: pending.Kid, ActivatesAt: activates}, nil
}

// PublicKeys lists the ticket verification keys a gateway must trust: the signing key, a pending
// key (published ahead of its activation) and any key retired within the last ten minutes.
func (s *Service) PublicKeys(ctx context.Context) ([]TicketKey, error) {
	if _, err := s.activeKey(ctx); err != nil {
		return nil, err
	}
	now := s.now()
	rows, err := db.New(s.pool).ListValidTicketKeys(ctx, timestamptz(ptrTime(now.Add(-retiredKeyValidity))))
	if err != nil {
		return nil, err
	}
	keys := make([]TicketKey, 0, len(rows))
	for _, row := range rows {
		key := TicketKey{KeyID: row.Kid, PublicKey: row.PublicKey}
		if row.State == "retired" && row.RetiredAt.Valid {
			until := row.RetiredAt.Time.UTC().Add(retiredKeyValidity)
			key.ValidUntil = &until
		}
		keys = append(keys, key)
	}
	return keys, nil
}

// EncodePublicKey renders a public key the way gateway configurations carry it.
func EncodePublicKey(key []byte) string { return base64.RawURLEncoding.EncodeToString(key) }

// IssueStreams signs a ticket for each of the given machines that has an enabled camera on an
// active gateway. The caller decides which machines the display may watch (cameras of its
// published camera widgets) and must not call this for a revoked display.
func (s *Service) IssueStreams(ctx context.Context, displayID uuid.UUID, machineIDs []uuid.UUID) ([]Stream, error) {
	if len(machineIDs) == 0 || s.keyring == nil {
		return []Stream{}, nil
	}
	ids := make([]string, 0, len(machineIDs))
	for _, id := range machineIDs {
		ids = append(ids, id.String())
	}
	cameras, err := db.New(s.pool).ListStreamCamerasForMachines(ctx, ids)
	if err != nil {
		return nil, err
	}
	if len(cameras) == 0 {
		return []Stream{}, nil
	}
	key, err := s.activeKey(ctx)
	if err != nil {
		if apperror.IsCode(err, "encryption_not_configured") {
			return []Stream{}, nil
		}
		return nil, err
	}
	now := s.now()
	streams := make([]Stream, 0, len(cameras))
	for _, camera := range cameras {
		if len(streams) == maxStreamsPerDisplay {
			break
		}
		name := StreamName(camera.MachineID)
		ticket, claims, err := streamticket.Sign(key.private, key.kid, displayID, camera.MachineID, name, now)
		if err != nil {
			return nil, err
		}
		streams = append(streams, Stream{
			MachineID: camera.MachineID,
			WebRTCURL: "https://" + camera.PublicHost + "/api/webrtc?src=" + name,
			MSEURL:    "wss://" + camera.PublicHost + "/api/ws?src=" + name,
			Ticket:    ticket, ExpiresAt: claims.ExpiresAt(),
		})
	}
	return streams, nil
}

func ptrTime(t time.Time) *time.Time { return &t }
