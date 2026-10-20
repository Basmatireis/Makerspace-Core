package signage

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	// PairingCodeAlphabet leaves out look-alike characters (0/O, 1/I).
	PairingCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	// PairingCodeLength is the number of characters of a pairing code.
	PairingCodeLength = 6
	// PairingTTL is how long an unclaimed pairing code stays valid.
	PairingTTL = 15 * time.Minute

	// deliveryGrace is how long a claimed request waits for the player to collect its credential.
	deliveryGrace = 5 * time.Minute

	maxOpenPairingRequests    = 50
	pairingRequestsPerWindow  = 10
	pairingRequestWindow      = time.Hour
	claimFailuresPerWindow    = 10
	claimFailureWindow        = 15 * time.Minute
	pairingGenerationAttempts = 5
	pairingPollsPerWindow     = 60
	pairingPollWindow         = time.Minute
)

// ErrPairingCodeInvalid is the single answer for unknown, expired, claimed and malformed codes.
func errPairingCodeInvalid() error {
	return apperror.New(422, "pairing_code_invalid", "The pairing code is invalid or has expired")
}

func rateLimited(message string) error {
	return apperror.New(429, "rate_limited", message)
}

// GeneratePairingCode returns a random code over PairingCodeAlphabet. The alphabet has 32
// characters, so masking a random byte to five bits is unbiased.
func GeneratePairingCode() (string, error) {
	raw := make([]byte, PairingCodeLength)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	code := make([]byte, PairingCodeLength)
	for index, value := range raw {
		code[index] = PairingCodeAlphabet[value&31]
	}
	return string(code), nil
}

// NormalizePairingCode upper-cases the code and drops spaces and dashes; ok is false when the
// result is not a well-formed code.
func NormalizePairingCode(raw string) (string, bool) {
	code := strings.ToUpper(strings.NewReplacer(" ", "", "-", "").Replace(raw))
	if len(code) != PairingCodeLength {
		return "", false
	}
	for _, character := range code {
		if !strings.ContainsRune(PairingCodeAlphabet, character) {
			return "", false
		}
	}
	return code, true
}

func pairingCodeDigest(code string) []byte {
	sum := sha256.Sum256([]byte("signage-pairing-code:" + code))
	return sum[:]
}

// PairingStart is what an unpaired player receives: the code to show and the secret that proves
// later polls come from the same player.
type PairingStart struct {
	Code       string
	ExpiresAt  time.Time
	PollSecret string
}

// StartPairing creates a pairing request for an unpaired player. clientIP keys the per-IP rate
// limit; pollSecret is the cookie value of a previous request of the same player, which is replaced.
func (s *Service) StartPairing(ctx context.Context, clientIP, previousPollSecret string) (PairingStart, error) {
	now := s.now()
	if !s.pairingRequests.Take(ratelimit.KeyForIP(clientIP), now) {
		return PairingStart{}, rateLimited("Too many pairing requests; try again later")
	}
	for attempt := 0; attempt < pairingGenerationAttempts; attempt++ {
		start, err := s.tryStartPairing(ctx, now, previousPollSecret)
		if err == nil {
			return start, nil
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			continue // a live request already uses this code; draw another one
		}
		return PairingStart{}, err
	}
	return PairingStart{}, errors.New("could not generate a unique pairing code")
}

func (s *Service) tryStartPairing(ctx context.Context, now time.Time, previousPollSecret string) (PairingStart, error) {
	code, err := GeneratePairingCode()
	if err != nil {
		return PairingStart{}, err
	}
	secret, secretDigest, err := security.NewOpaqueToken()
	if err != nil {
		return PairingStart{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PairingStart{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if err := q.DeleteExpiredSignagePairingRequests(ctx, now); err != nil {
		return PairingStart{}, err
	}
	if previousPollSecret != "" {
		// A request that staff already claimed stays collectable by the cookie that started it
		// until its delivery window ends; restarting must not destroy (or orphan) it.
		if previous, err := q.GetSignagePairingRequestForPoll(ctx, security.DigestToken(previousPollSecret)); err == nil && previous.ClaimedDisplayID != nil {
			return PairingStart{}, apperror.New(409, "pairing_claimed", "This display was already claimed; collect its credential instead of restarting")
		} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return PairingStart{}, err
		}
		if err := q.DeleteSignagePairingRequestByPollDigest(ctx, security.DigestToken(previousPollSecret)); err != nil {
			return PairingStart{}, err
		}
	}
	open, err := q.CountOpenSignagePairingRequests(ctx, now)
	if err != nil {
		return PairingStart{}, err
	}
	if open >= maxOpenPairingRequests {
		return PairingStart{}, rateLimited("Too many pairing requests are open; try again in a few minutes")
	}
	expires := now.Add(PairingTTL)
	if err := q.CreateSignagePairingRequest(ctx, signagedb.CreateSignagePairingRequestParams{
		ID: uuid.Must(uuid.NewV7()), CodeDigest: pairingCodeDigest(code), PollSecretDigest: secretDigest, CreatedAt: now, ExpiresAt: expires,
	}); err != nil {
		return PairingStart{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PairingStart{}, err
	}
	return PairingStart{Code: code, ExpiresAt: expires, PollSecret: secret}, nil
}

// PairingPoll is the answer to a player's poll. DeviceToken is set exactly once, on the first
// poll that sees the claimed request.
type PairingPoll struct {
	Status      string // pending | expired | paired
	DeviceToken string
}

// PollPairing reports the state of the player's request. On the first poll after a staff member
// claimed the code it issues the device credential, deletes the request and returns the token;
// the plaintext never rests in the database.
func (s *Service) PollPairing(ctx context.Context, clientIP, pollSecret string) (PairingPoll, error) {
	now := s.now()
	if decoded, err := base64.RawURLEncoding.DecodeString(pollSecret); err != nil || len(decoded) != 32 {
		return PairingPoll{Status: "expired"}, nil // cannot match any request; skip the database
	}
	if !s.pairingPolls.Take(ratelimit.KeyForIP(clientIP), now) {
		return PairingPoll{}, rateLimited("Too many pairing polls; slow down")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PairingPoll{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if err := q.DeleteExpiredSignagePairingRequests(ctx, now); err != nil {
		return PairingPoll{}, err
	}
	request, err := q.GetSignagePairingRequestForPoll(ctx, security.DigestToken(pollSecret))
	if errors.Is(err, pgx.ErrNoRows) {
		return PairingPoll{Status: "expired"}, tx.Commit(ctx)
	}
	if err != nil {
		return PairingPoll{}, err
	}
	if request.ClaimedDisplayID == nil || request.ManagedDeviceID == nil {
		return PairingPoll{Status: "pending"}, tx.Commit(ctx)
	}
	token, err := manageddevices.IssueSignagePlayerTokenTx(ctx, tx, *request.ManagedDeviceID)
	if apperror.IsCode(err, "not_found") {
		// The display was revoked before the player collected its credential.
		if err := q.DeleteSignagePairingRequest(ctx, request.ID); err != nil {
			return PairingPoll{}, err
		}
		return PairingPoll{Status: "expired"}, tx.Commit(ctx)
	}
	if err != nil {
		return PairingPoll{}, err
	}
	if err := q.DeleteSignagePairingRequest(ctx, request.ID); err != nil {
		return PairingPoll{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PairingPoll{}, err
	}
	return PairingPoll{Status: "paired", DeviceToken: token}, nil
}

// PairDisplay claims the player's pairing code for a new display. Unknown, expired, claimed and
// malformed codes all answer 422 pairing_code_invalid; repeated failures of one account are
// rate-limited.
func (s *Service) PairDisplay(ctx context.Context, principal authorization.Principal, code string, input DisplayInput, requestID *uuid.UUID) (Display, error) {
	if err := requireManage(principal); err != nil {
		return Display{}, err
	}
	checked, err := validateDisplayInput(input)
	if err != nil {
		return Display{}, err
	}
	now := s.now()
	account := principal.AccountID.String()
	// Reserve an attempt before looking at the code so concurrent guesses cannot all pass the
	// check; the reservation is given back unless the code itself was wrong.
	if !s.claimFailures.Take(account, now) {
		return Display{}, rateLimited("Too many wrong pairing codes; try again later")
	}
	wrongCode := false
	defer func() {
		if !wrongCode {
			s.claimFailures.Refund(account, now)
		}
	}()
	normalized, wellFormed := NormalizePairingCode(code)
	if !wellFormed {
		wrongCode = true
		return Display{}, errPairingCodeInvalid()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Display{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if _, err := q.LockSignagePlaylistForShare(ctx, checked.DefaultPlaylistID); errors.Is(err, pgx.ErrNoRows) {
		return Display{}, validation("the default playlist does not exist")
	} else if err != nil {
		return Display{}, err
	}
	requestRowID, err := q.GetOpenSignagePairingRequestByCode(ctx, signagedb.GetOpenSignagePairingRequestByCodeParams{CodeDigest: pairingCodeDigest(normalized), Now: now})
	if errors.Is(err, pgx.ErrNoRows) {
		wrongCode = true
		return Display{}, errPairingCodeInvalid()
	}
	if err != nil {
		return Display{}, err
	}
	deviceID, err := manageddevices.CreateSignagePlayerDeviceTx(ctx, tx, principal, checked.Name, requestID)
	if err != nil {
		return Display{}, err
	}
	displayID := uuid.Must(uuid.NewV7())
	if _, err := q.CreateSignageDisplay(ctx, signagedb.CreateSignageDisplayParams{
		ID: displayID, ManagedDeviceID: deviceID, Name: checked.Name, Location: checked.Location, Orientation: checked.Orientation,
		ResolutionWidth: int32(checked.Resolution.Width), ResolutionHeight: int32(checked.Resolution.Height),
		VisibleFromOutside: checked.VisibleFromOutside, AllowCameraOutside: checked.AllowCameraOutside != nil && *checked.AllowCameraOutside, DefaultPlaylistID: checked.DefaultPlaylistID,
	}); err != nil {
		return Display{}, databaseError(err)
	}
	if err := q.ClaimSignagePairingRequest(ctx, signagedb.ClaimSignagePairingRequestParams{
		DisplayID: &displayID, Now: now, DeliveryDeadline: now.Add(deliveryGrace), ID: requestRowID,
	}); err != nil {
		return Display{}, err
	}
	if err := writeAudit(ctx, tx, principal, "signage_display.paired", "signage_display", displayID, requestID,
		[]string{"name", "location", "orientation", "resolution", "visibleFromOutside", "defaultPlaylistId"}); err != nil {
		return Display{}, err
	}
	result, err := s.getDisplay(ctx, q, displayID)
	if err != nil {
		return Display{}, err
	}
	return result, tx.Commit(ctx)
}
