package streaminggateways

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
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
)

// StreamName is the stable go2rtc stream name of a machine's camera.
func StreamName(machineID uuid.UUID) string { return streamticket.StreamName(machineID) }

type signingKey struct {
	kid      string
	private  ed25519.PrivateKey
	loadedAt time.Time
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

// activeKey returns the signing key, generating the very first one on demand.
func (s *Service) activeKey(ctx context.Context) (*signingKey, error) {
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	if s.cachedKey != nil && s.now().Sub(s.cachedKey.loadedAt) < signingKeyCacheTTL {
		return s.cachedKey, nil
	}
	if s.keyring == nil {
		return nil, conflictEncryption()
	}
	key, err := s.loadActiveKey(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		if err = s.createKey(ctx, false); err != nil {
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
	return conflict("encryption_not_configured", "Application encryption must be configured before stream tickets can be signed")
}

func (s *Service) loadActiveKey(ctx context.Context) (*signingKey, error) {
	row, err := db.New(s.pool).GetActiveTicketKey(ctx)
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
	return &signingKey{kid: row.Kid, private: ed25519.NewKeyFromSeed(seed), loadedAt: s.now()}, nil
}

// createKey inserts a new active key; with rotate it first retires the current one. A concurrent
// creator that loses the unique-active-key race is a no-op.
func (s *Service) createKey(ctx context.Context, rotate bool) error {
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
	defer tx.Rollback(ctx)
	q := db.New(tx)
	now := s.now()
	if rotate {
		if err = q.RetireTicketKeys(ctx, timestamptz(&now)); err != nil {
			return err
		}
	}
	inserted, err := q.InsertTicketKey(ctx, db.InsertTicketKeyParams{ID: id, Kid: streamticket.KeyID(public), PublicKey: public, EncryptedPrivateKey: encrypted})
	if err != nil {
		return databaseError(err)
	}
	if inserted == 0 {
		return nil // another instance created the first key concurrently
	}
	action := "signage_ticket_key.created"
	if rotate {
		action = "signage_ticket_key.rotated"
		if err = q.BumpAllGatewayConfigurations(ctx); err != nil {
			return err
		}
	}
	if err = q.DeleteExpiredTicketKeys(ctx, timestamptz(ptrTime(now.Add(-24*time.Hour)))); err != nil {
		return err
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: action, ResourceType: "signage_ticket_key", ResourceID: &id, ChangedFields: []string{"signingKey"}, Source: "system"}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RotateTicketKey makes a new key the signing key. The previous public key stays in gateway
// configurations for ten minutes.
func (s *Service) RotateTicketKey(ctx context.Context) error {
	if s.keyring == nil {
		return conflictEncryption()
	}
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	s.cachedKey = nil
	return s.createKey(ctx, true)
}

// PublicKeys lists the ticket verification keys a gateway must trust: the active key and any key
// retired within the last ten minutes.
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
		if row.RetiredAt.Valid {
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
