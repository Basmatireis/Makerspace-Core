package manageddevices

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	manageddevicesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/pairingcode"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Pairing registers a kiosk the way a signage display is paired: the unregistered kiosk shows a short code, staff
// enter it in Core, and the kiosk collects its credential on its next poll.
const (
	// PairingTTL is how long an unclaimed pairing code stays valid.
	PairingTTL = 15 * time.Minute

	// pairingDeliveryGrace is how long a claimed request waits for the kiosk to collect its credential.
	pairingDeliveryGrace = 5 * time.Minute

	maxOpenPairingRequests    = 50
	pairingRequestsPerWindow  = 10
	pairingRequestWindow      = time.Hour
	claimFailuresPerWindow    = 10
	claimFailureWindow        = 15 * time.Minute
	pairingGenerationAttempts = 5
	pairingPollsPerWindow     = 60
	pairingPollWindow         = time.Minute

	pairingCodePurpose = "managed-device-pairing-code"
)

// CredentialDelivery is how a paired kiosk receives its credential.
type CredentialDelivery string

const (
	// DeliveryBrowserCookie installs the credential as the HttpOnly managed-device cookie (a kiosk browser).
	DeliveryBrowserCookie CredentialDelivery = "browser_cookie"
	// DeliveryNativeToken returns the one-time token in the poll body (the desktop app stores it natively).
	DeliveryNativeToken CredentialDelivery = "native_token"
)

// PairingStatus is the state a kiosk sees when it polls its pairing request.
type PairingStatus string

const (
	PairingPending PairingStatus = "pending"
	PairingExpired PairingStatus = "expired"
	PairingPaired  PairingStatus = "paired"
)

// PairingStart is what an unregistered kiosk receives: the code to show and the secret that proves later polls come
// from the same kiosk.
type PairingStart struct {
	Code       string
	ExpiresAt  time.Time
	PollSecret string
	Delivery   CredentialDelivery
}

// PairingPoll is the answer to a kiosk's poll. Token is set exactly once, on the first poll that sees the claimed
// request; CredentialExpiresAt is the device's expiry for the cookie lifetime.
type PairingPoll struct {
	Status              PairingStatus
	Delivery            CredentialDelivery
	Token               string
	CredentialExpiresAt *time.Time
}

func errPairingCodeInvalid() error {
	return apperror.New(
		http.StatusUnprocessableEntity,
		"pairing_code_invalid",
		"The pairing code is invalid or has expired",
	)
}

// ErrAlreadyRegistered answers a pairing request from a client that already presents a valid managed-device
// credential.
func ErrAlreadyRegistered() error {
	return apperror.New(
		http.StatusConflict,
		"device_already_registered",
		"This device is already registered; revoke it in Makerspace Core before pairing it again",
	)
}

func pairingRateLimited(message string, retryAfter time.Duration) error {
	return apperror.RateLimited("rate_limited", message, retryAfter)
}

func pairingCodeDigest(code string) []byte { return pairingcode.Digest(pairingCodePurpose, code) }

// wellFormedSecret reports whether value can be a poll secret at all, so garbage never reaches the database or
// consumes a rate-limit slot.
func wellFormedSecret(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32
}

// StartPairing creates a pairing request for an unregistered kiosk. clientIP keys the per-IP rate limit;
// previousPollSecret is the secret of an earlier request of the same kiosk, which is replaced.
func (s *Service) StartPairing(
	ctx context.Context,
	clientIP string,
	delivery CredentialDelivery,
	previousPollSecret string,
) (PairingStart, error) {
	if delivery != DeliveryBrowserCookie && delivery != DeliveryNativeToken {
		return PairingStart{}, apperror.InvalidField("credentialDelivery is invalid")
	}
	now := s.now()
	if !s.pairingRequests.Take(ratelimit.KeyForIP(clientIP), now) {
		return PairingStart{}, pairingRateLimited("Too many pairing requests; try again later", pairingRequestWindow)
	}
	if !wellFormedSecret(previousPollSecret) {
		previousPollSecret = ""
	}
	for attempt := 0; attempt < pairingGenerationAttempts; attempt++ {
		start, err := s.tryStartPairing(ctx, now, delivery, previousPollSecret)
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

func (s *Service) tryStartPairing(
	ctx context.Context,
	now time.Time,
	delivery CredentialDelivery,
	previousPollSecret string,
) (PairingStart, error) {
	code, err := pairingcode.Generate()
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
	q := manageddevicesdb.New(tx)
	if err := q.DeleteExpiredManagedDevicePairingRequests(ctx, now); err != nil {
		return PairingStart{}, err
	}
	if previousPollSecret != "" {
		previousDigest := security.DigestToken(previousPollSecret)
		// A request that staff already claimed stays collectable by the secret that started it until its delivery
		// window ends; restarting must not destroy (or orphan) it.
		previous, err := q.GetManagedDevicePairingRequestForPoll(ctx, previousDigest)
		if err == nil && previous.ClaimedDeviceID != nil {
			return PairingStart{}, apperror.New(
				http.StatusConflict,
				"pairing_claimed",
				"This kiosk was already claimed; collect its credential instead of restarting",
			)
		} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return PairingStart{}, err
		}
		if err := q.DeleteOpenManagedDevicePairingRequestByPollDigest(ctx, previousDigest); err != nil {
			return PairingStart{}, err
		}
	}
	open, err := q.CountOpenManagedDevicePairingRequests(ctx, now)
	if err != nil {
		return PairingStart{}, err
	}
	if open >= maxOpenPairingRequests {
		return PairingStart{}, pairingRateLimited(
			"Too many pairing requests are open; try again in a few minutes",
			pairingDeliveryGrace,
		)
	}
	expires := now.Add(PairingTTL)
	if err := q.CreateManagedDevicePairingRequest(ctx, manageddevicesdb.CreateManagedDevicePairingRequestParams{
		ID:                 ids.New(),
		CodeDigest:         pairingCodeDigest(code),
		PollSecretDigest:   secretDigest,
		CredentialDelivery: string(delivery),
		CreatedAt:          now,
		ExpiresAt:          expires,
	}); err != nil {
		return PairingStart{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PairingStart{}, err
	}
	return PairingStart{Code: code, ExpiresAt: expires, PollSecret: secret, Delivery: delivery}, nil
}

// PollPairing reports the state of the kiosk's request. On the first poll after a staff member claimed the code it
// issues the device credential, deletes the request and returns the token; the plaintext never rests in the
// database, and no later poll can obtain it again.
func (s *Service) PollPairing(ctx context.Context, clientIP, pollSecret string) (PairingPoll, error) {
	now := s.now()
	if !wellFormedSecret(pollSecret) {
		return PairingPoll{Status: PairingExpired}, nil // cannot match any request; skip the database
	}
	if !s.pairingPolls.Take(ratelimit.KeyForIP(clientIP), now) {
		return PairingPoll{}, pairingRateLimited("Too many pairing polls; slow down", pairingPollWindow)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PairingPoll{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	if err := q.DeleteExpiredManagedDevicePairingRequests(ctx, now); err != nil {
		return PairingPoll{}, err
	}
	request, err := q.GetManagedDevicePairingRequestForPoll(ctx, security.DigestToken(pollSecret))
	if errors.Is(err, pgx.ErrNoRows) {
		return PairingPoll{Status: PairingExpired}, tx.Commit(ctx)
	}
	if err != nil {
		return PairingPoll{}, err
	}
	delivery := CredentialDelivery(request.CredentialDelivery)
	if request.ClaimedDeviceID == nil {
		return PairingPoll{Status: PairingPending, Delivery: delivery}, tx.Commit(ctx)
	}
	deviceID := *request.ClaimedDeviceID
	token, digest, err := security.NewOpaqueToken()
	if err != nil {
		return PairingPoll{}, err
	}
	expiresAt, issueErr := q.IssuePairedManagedDeviceToken(
		ctx,
		manageddevicesdb.IssuePairedManagedDeviceTokenParams{ID: deviceID, TokenDigest: digest},
	)
	if issueErr != nil && !errors.Is(issueErr, pgx.ErrNoRows) {
		return PairingPoll{}, issueErr
	}
	if err := q.DeleteManagedDevicePairingRequest(ctx, request.ID); err != nil {
		return PairingPoll{}, err
	}
	if issueErr != nil {
		// The device was revoked or expired before the kiosk collected its credential.
		return PairingPoll{Status: PairingExpired, Delivery: delivery}, tx.Commit(ctx)
	}
	if err := audit.Write(ctx, tx, audit.Event{
		ActorType:     audit.ActorUnknown,
		Action:        "managed_device.credential_delivered",
		ResourceType:  "managed_device",
		ResourceID:    &deviceID,
		ChangedFields: []string{"credential"},
	}); err != nil {
		return PairingPoll{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PairingPoll{}, err
	}
	return PairingPoll{
		Status:              PairingPaired,
		Delivery:            delivery,
		Token:               token,
		CredentialExpiresAt: timePointer(expiresAt),
	}, nil
}

// Pair claims the kiosk's pairing code and creates its managed device with the given settings. The device starts
// with an unusable credential digest; PollPairing replaces it when the kiosk collects its credential. Unknown,
// expired, claimed and malformed codes all answer 422 pairing_code_invalid; repeated failures of one account are
// rate-limited.
func (s *Service) Pair(
	ctx context.Context,
	principal authorization.Principal,
	code string,
	name string,
	typeID uuid.UUID,
	expiresAt *time.Time,
	settings DeviceSettings,
	requestID *uuid.UUID,
) (Device, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return Device{}, apperror.PermissionDenied
	}
	name, expiresAt, err := validateDevice(name, expiresAt)
	if err != nil {
		return Device{}, err
	}
	settings, err = validateDeviceSettings(settings)
	if err != nil {
		return Device{}, err
	}
	now := s.now()
	account := principal.AccountID.String()
	// Reserve an attempt before looking at the code so that concurrent guesses cannot all pass the check; the
	// reservation is given back unless the code itself was wrong.
	if !s.claimFailures.Take(account, now) {
		return Device{}, pairingRateLimited("Too many wrong pairing codes; try again later", claimFailureWindow)
	}
	wrongCode := false
	defer func() {
		if !wrongCode {
			s.claimFailures.Refund(account, now)
		}
	}()
	normalized, wellFormed := pairingcode.Normalize(code)
	if !wellFormed {
		wrongCode = true
		return Device{}, errPairingCodeInvalid()
	}
	unusable := make([]byte, 32)
	if _, err := rand.Read(unusable); err != nil {
		return Device{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Device{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	requestRowID, err := q.GetOpenManagedDevicePairingRequestByCode(
		ctx,
		manageddevicesdb.GetOpenManagedDevicePairingRequestByCodeParams{CodeDigest: pairingCodeDigest(normalized), Now: now},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		wrongCode = true
		return Device{}, errPairingCodeInvalid()
	}
	if err != nil {
		return Device{}, err
	}
	row, err := insertDeviceTx(ctx, q, name, typeID, expiresAt, settings, security.DigestToken(string(unusable)))
	if err != nil {
		return Device{}, err
	}
	if err := q.ClaimManagedDevicePairingRequest(ctx, manageddevicesdb.ClaimManagedDevicePairingRequestParams{
		DeviceID:         &row.ID,
		Now:              now,
		DeliveryDeadline: now.Add(pairingDeliveryGrace),
		ID:               requestRowID,
	}); err != nil {
		return Device{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "managed_device.paired",
		ResourceType:   "managed_device",
		ResourceID:     &row.ID,
		RequestID:      requestID,
		ChangedFields: []string{
			"name",
			"deviceTypeId",
			"expiresAt",
			"sessionPolicyId",
			"terminalEnabled",
			"allowedApplicationModes",
			"attendancePolicy",
			"capabilities",
		},
	}); err != nil {
		return Device{}, err
	}
	view, err := q.GetManagedDevice(ctx, row.ID)
	if err != nil {
		return Device{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Device{}, err
	}
	result := deviceFromGetRow(view)
	result.Capabilities = append([]string(nil), settings.Capabilities...)
	return result, nil
}
