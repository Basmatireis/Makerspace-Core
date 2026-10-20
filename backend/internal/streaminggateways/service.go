// Package streaminggateways owns the local streaming gateways that restream printer cameras to
// digital-signage players: the gateway registry and its enrollment/credential lifecycle (modelled
// on the printer connectors), camera assignments, the configuration a gateway polls, heartbeat
// health, and the Ed25519 tickets that authorise players to watch a stream.
package streaminggateways

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateways/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	enrollmentTTL = 15 * time.Minute
	credentialTTL = 90 * 24 * time.Hour
	// ProtocolVersion is the gateway protocol this Core speaks.
	ProtocolVersion = 1
	// cameraStatusStaleAfter is how old a heartbeat's camera report may be before the camera counts as unknown.
	cameraStatusStaleAfter = 90 * time.Second
	maxStreamsPerDisplay   = 20
)

// Service implements the streaming gateway use cases. Every administrative method checks
// local_services.manage; mutations write their audit event in the same transaction.
type Service struct {
	pool    *pgxpool.Pool
	keyring *security.Keyring
	now     func() time.Time

	keyMu     sync.Mutex
	cachedKey *signingKey
}

// NewService builds the service. Without encryption keys, cameras cannot be configured and no
// tickets are issued.
func NewService(pool *pgxpool.Pool, encryptionKeys [][]byte) (*Service, error) {
	var keyring *security.Keyring
	if len(encryptionKeys) != 0 {
		var err error
		if keyring, err = security.NewKeyring(encryptionKeys); err != nil {
			return nil, err
		}
	}
	return &Service{pool: pool, keyring: keyring, now: func() time.Time { return time.Now().UTC() }}, nil
}

// Gateway is a registered streaming gateway.
type Gateway struct {
	ID                                    uuid.UUID
	Name, PublicHost, Lifecycle           string
	ConfigurationRevision, AppliedRevison int64
	SoftwareVersion, HealthState          *string
	HealthSummary                         *string
	ProtocolVersion                       *int
	LastHeartbeatAt, EnrolledAt           *time.Time
	DisabledAt, RevokedAt                 *time.Time
	CredentialExpiresAt                   *time.Time
	Version                               int64
	CreatedAt, UpdatedAt                  time.Time
}

// Camera is a machine camera assigned to a gateway, with the gateway's last reported health.
type Camera struct {
	ID, GatewayID, MachineID      uuid.UUID
	GatewayName, GatewayLifecycle string
	MachineName                   string
	Enabled                       bool
	Health                        string
	Viewers                       *int
	Codec                         *string
	Width, Height                 *int
	FPS                           *float64
	ReportedAt                    *time.Time
	Version                       int64
	CreatedAt, UpdatedAt          time.Time
}

// EnrollmentIssue is the one-time secret shown to the administrator.
type EnrollmentIssue struct {
	Gateway   Gateway
	ID        uuid.UUID
	Secret    string
	ExpiresAt time.Time
}

// EnrollmentResult answers a gateway's enrollment or credential rotation.
type EnrollmentResult struct {
	Gateway             Gateway
	CredentialExpiresAt time.Time
}

// Context identifies an authenticated gateway.
type Context struct {
	ID, CredentialID uuid.UUID
	Name, Lifecycle  string
}

// TicketKey is a public ticket verification key a gateway trusts.
type TicketKey struct {
	KeyID      string
	PublicKey  []byte
	ValidUntil *time.Time
}

// ConfigCamera is one camera in a gateway's configuration. SourceURL embeds the printer's LAN
// access code and must only ever reach the authenticated gateway.
type ConfigCamera struct {
	MachineID  uuid.UUID
	Name       string
	StreamName string
	SourceURL  string
}

// Configuration is what a gateway polls.
type Configuration struct {
	SessionEpoch     int64
	RevokedDisplays  []uuid.UUID
	Revision         int64
	ProtocolVersion  int
	PublicHost       string
	TicketPublicKeys []TicketKey
	Cameras          []ConfigCamera
}

// CameraHealth is a gateway's report about one camera.
type CameraHealth struct {
	MachineID     uuid.UUID
	Health        string
	Viewers       int
	Codec         *string
	Width, Height *int
	FPS           *float64
}

// Heartbeat is what a gateway reports every 30 seconds.
type Heartbeat struct {
	SoftwareVersion, HealthState string
	ProtocolVersion              int
	AppliedConfigurationRevision int64
	HealthSummary                *string
	Cameras                      []CameraHealth
}

func validation(message string) error     { return apperror.New(422, "validation_failed", message) }
func conflict(code, message string) error { return apperror.New(409, code, message) }

func requireManage(principal authorization.Principal) error {
	if !principal.Has(authorization.LocalServicesManage) {
		return apperror.PermissionDenied
	}
	return nil
}

func nullableTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time.UTC()
	return &v
}

func timestamptz(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func gatewayFrom(row db.StreamingGateway) Gateway {
	var protocol *int
	if row.ProtocolVersion != nil {
		v := int(*row.ProtocolVersion)
		protocol = &v
	}
	return Gateway{
		ID: row.ID, Name: row.Name, PublicHost: row.PublicHost, Lifecycle: row.Lifecycle,
		ConfigurationRevision: row.ConfigurationRevision, AppliedRevison: row.AppliedConfigurationRevision,
		SoftwareVersion: row.SoftwareVersion, ProtocolVersion: protocol, HealthState: row.HealthState, HealthSummary: row.HealthSummary,
		LastHeartbeatAt: nullableTime(row.LastHeartbeatAt), EnrolledAt: nullableTime(row.EnrolledAt),
		DisabledAt: nullableTime(row.DisabledAt), RevokedAt: nullableTime(row.RevokedAt),
		Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

// withCredentialExpiry fills in when the gateway's current credential expires (nil without one).
func withCredentialExpiry(ctx context.Context, q *db.Queries, gateway Gateway) (Gateway, error) {
	expires, err := q.GetGatewayCredentialExpiry(ctx, gateway.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return gateway, nil
	}
	if err != nil {
		return Gateway{}, err
	}
	expires = expires.UTC()
	gateway.CredentialExpiresAt = &expires
	return gateway, nil
}

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 120 {
		return "", validation("name is required and limited to 120 characters")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", validation("name must not contain control characters")
		}
	}
	return name, nil
}

var hostLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// NormalizePublicHost validates a hostname or IPv4 address with an optional port ("name",
// "name:8443", "192.0.2.10:8443") and returns it in lower case. Schemes, paths, credentials and
// IPv6 literals are rejected: the host is spliced into https:// and wss:// URLs.
func NormalizePublicHost(raw string) (string, error) {
	host := strings.ToLower(strings.TrimSpace(raw))
	invalid := validation("publicHost must be a hostname or IPv4 address with an optional port, for example signage-gw.example.org:8443")
	if host == "" || len(host) > 260 {
		return "", invalid
	}
	name, port := host, ""
	if index := strings.LastIndex(host, ":"); index >= 0 {
		name, port = host[:index], host[index+1:]
		if port == "" || len(port) > 5 {
			return "", invalid
		}
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 || strconv.Itoa(number) != port {
			return "", invalid
		}
	}
	if len(name) == 0 || len(name) > 253 {
		return "", invalid
	}
	if addr, err := netip.ParseAddr(name); err == nil {
		if !addr.Is4() {
			return "", invalid
		}
	} else {
		for _, label := range strings.Split(name, ".") {
			if !hostLabel.MatchString(label) {
				return "", invalid
			}
		}
	}
	return host, nil
}

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return conflict("streaming_gateway_conflict", "A gateway with this name or a camera for this machine already exists")
		case "23503":
			return apperror.NotFound
		}
	}
	return err
}

func (s *Service) Create(ctx context.Context, principal authorization.Principal, name, publicHost string, requestID *uuid.UUID) (Gateway, error) {
	if err := requireManage(principal); err != nil {
		return Gateway{}, err
	}
	name, err := normalizeName(name)
	if err != nil {
		return Gateway{}, err
	}
	if publicHost, err = NormalizePublicHost(publicHost); err != nil {
		return Gateway{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Gateway{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := uuid.Must(uuid.NewV7())
	row, err := db.New(tx).CreateGateway(ctx, db.CreateGatewayParams{ID: id, Name: name, PublicHost: publicHost})
	if err != nil {
		return Gateway{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "streaming_gateway.created", ResourceType: "streaming_gateway", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "publicHost"}}); err != nil {
		return Gateway{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Gateway{}, err
	}
	return gatewayFrom(row), nil
}

func (s *Service) List(ctx context.Context, principal authorization.Principal) ([]Gateway, error) {
	if err := requireManage(principal); err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListGateways(ctx)
	if err != nil {
		return nil, err
	}
	expiries, err := db.New(s.pool).ListGatewayCredentialExpiries(ctx)
	if err != nil {
		return nil, err
	}
	expiryOf := make(map[uuid.UUID]time.Time, len(expiries))
	for _, expiry := range expiries {
		expiryOf[expiry.GatewayID] = expiry.ExpiresAt.UTC()
	}
	result := make([]Gateway, 0, len(rows))
	for _, row := range rows {
		gateway := gatewayFrom(row)
		if expires, ok := expiryOf[row.ID]; ok {
			gateway.CredentialExpiresAt = &expires
		}
		result = append(result, gateway)
	}
	return result, nil
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Gateway, error) {
	if err := requireManage(principal); err != nil {
		return Gateway{}, err
	}
	row, err := db.New(s.pool).GetGateway(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.NotFound
	}
	if err != nil {
		return Gateway{}, err
	}
	return withCredentialExpiry(ctx, db.New(s.pool), gatewayFrom(row))
}

// Update renames a gateway, changes its public host and enables or disables it.
func (s *Service) Update(ctx context.Context, principal authorization.Principal, id uuid.UUID, name, publicHost string, enabled bool, expected int64, requestID *uuid.UUID) (Gateway, error) {
	if err := requireManage(principal); err != nil {
		return Gateway{}, err
	}
	name, err := normalizeName(name)
	if err != nil {
		return Gateway{}, err
	}
	if publicHost, err = NormalizePublicHost(publicHost); err != nil {
		return Gateway{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Gateway{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	current, err := q.GetGatewayForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.NotFound
	}
	if err != nil {
		return Gateway{}, err
	}
	if current.Lifecycle == "revoked" {
		return Gateway{}, conflict("streaming_gateway_revoked", "A revoked gateway cannot be updated")
	}
	lifecycle := current.Lifecycle
	var disabledAt *time.Time
	switch {
	case lifecycle == "pending":
		if !enabled {
			return Gateway{}, validation("A pending gateway cannot be disabled before enrollment")
		}
	case enabled:
		lifecycle = "active"
	default:
		lifecycle = "disabled"
		now := s.now()
		disabledAt = &now
	}
	row, err := q.UpdateGateway(ctx, db.UpdateGatewayParams{Name: name, PublicHost: publicHost, Lifecycle: lifecycle, DisabledAt: timestamptz(disabledAt), ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.StaleWrite
	}
	if err != nil {
		return Gateway{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "streaming_gateway.updated", ResourceType: "streaming_gateway", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "publicHost", "lifecycle"}}); err != nil {
		return Gateway{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Gateway{}, err
	}
	return withCredentialExpiry(ctx, db.New(s.pool), gatewayFrom(row))
}

// Delete removes a gateway with its credentials, enrollments and camera assignments.
func (s *Service) Delete(ctx context.Context, principal authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
	if err := requireManage(principal); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.GetGatewayForUpdate(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	affected, err := q.DeleteGateway(ctx, db.DeleteGatewayParams{ID: id, ExpectedVersion: expected})
	if err != nil {
		return databaseError(err)
	}
	if affected == 0 {
		return apperror.StaleWrite
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "streaming_gateway.deleted", ResourceType: "streaming_gateway", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"gateway", "credentials", "cameras"}}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// IssueEnrollment creates the one-time enrollment secret of a pending gateway.
func (s *Service) IssueEnrollment(ctx context.Context, principal authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (EnrollmentIssue, error) {
	if err := requireManage(principal); err != nil {
		return EnrollmentIssue{}, err
	}
	secret, digest, err := security.NewOpaqueToken()
	if err != nil {
		return EnrollmentIssue{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EnrollmentIssue{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	gateway, err := q.GetGatewayForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentIssue{}, apperror.NotFound
	}
	if err != nil {
		return EnrollmentIssue{}, err
	}
	// Pending gateways are enrolled for the first time; active and disabled ones are re-enrolled
	// (new host, lost data volume). Their current credential stays valid until the secret is used.
	if gateway.Lifecycle == "revoked" {
		return EnrollmentIssue{}, conflict("streaming_gateway_revoked", "A revoked gateway cannot be enrolled")
	}
	if err = q.RevokeOpenGatewayEnrollments(ctx, id); err != nil {
		return EnrollmentIssue{}, err
	}
	expires := s.now().Add(enrollmentTTL).Truncate(time.Microsecond)
	enrollmentID := uuid.Must(uuid.NewV7())
	actor := principal.AccountID
	if _, err = q.CreateGatewayEnrollment(ctx, db.CreateGatewayEnrollmentParams{ID: enrollmentID, GatewayID: id, TokenDigest: digest, ExpiresAt: expires, CreatedByAccountID: &actor}); err != nil {
		return EnrollmentIssue{}, err
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "streaming_gateway.enrollment_issued", ResourceType: "streaming_gateway", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"enrollment"}}); err != nil {
		return EnrollmentIssue{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EnrollmentIssue{}, err
	}
	return EnrollmentIssue{Gateway: gatewayFrom(gateway), ID: enrollmentID, Secret: secret, ExpiresAt: expires}, nil
}

func validOpaqueToken(raw string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	return err == nil && len(decoded) == 32
}

// Enroll exchanges a gateway-generated credential for the one-time enrollment secret. Replaying the
// same exchange (same credential) is idempotent so a lost response can be retried.
func (s *Service) Enroll(ctx context.Context, enrollmentSecret string, credentialID uuid.UUID, credentialSecret, softwareVersion string, protocolVersion int) (EnrollmentResult, error) {
	if !validOpaqueToken(enrollmentSecret) || !validOpaqueToken(credentialSecret) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	softwareVersion = strings.TrimSpace(softwareVersion)
	if softwareVersion == "" || len(softwareVersion) > 80 || protocolVersion != ProtocolVersion || credentialID == uuid.Nil {
		return EnrollmentResult{}, validation("unsupported gateway identity or protocol version")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EnrollmentResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	enrollment, err := q.GetGatewayEnrollmentByDigestForUpdate(ctx, security.DigestToken(enrollmentSecret))
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	if enrollment.RevokedAt.Valid || s.now().After(enrollment.ExpiresAt) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	fingerprintBytes := sha256.Sum256([]byte(credentialSecret))
	fingerprint := hex.EncodeToString(fingerprintBytes[:])
	if enrollment.ConsumedAt.Valid {
		if enrollment.CredentialFingerprint == nil || *enrollment.CredentialFingerprint != fingerprint || enrollment.AcceptedCredentialID == nil || *enrollment.AcceptedCredentialID != credentialID {
			return EnrollmentResult{}, conflict("enrollment_replay_conflict", "Enrollment was already consumed with different credentials")
		}
		row, getErr := q.GetGateway(ctx, enrollment.GatewayID)
		if getErr != nil {
			return EnrollmentResult{}, getErr
		}
		credential, credentialErr := q.GetGatewayCredential(ctx, db.GetGatewayCredentialParams{ID: credentialID, GatewayID: enrollment.GatewayID})
		if credentialErr != nil {
			return EnrollmentResult{}, credentialErr
		}
		if err = tx.Commit(ctx); err != nil {
			return EnrollmentResult{}, err
		}
		gateway := gatewayFrom(row)
		gateway.CredentialExpiresAt = &credential.ExpiresAt
		return EnrollmentResult{Gateway: gateway, CredentialExpiresAt: credential.ExpiresAt}, nil
	}
	current, err := q.GetGatewayForUpdate(ctx, enrollment.GatewayID)
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	if current.Lifecycle == "revoked" {
		return EnrollmentResult{}, conflict("streaming_gateway_revoked", "Gateway cannot be enrolled in its current state")
	}
	reenroll := current.Lifecycle != "pending"
	if reenroll {
		if err = q.RevokeGatewayCredentials(ctx, enrollment.GatewayID); err != nil {
			return EnrollmentResult{}, err
		}
	}
	expires := s.now().Add(credentialTTL).Truncate(time.Microsecond)
	if _, err = q.CreateGatewayCredential(ctx, db.CreateGatewayCredentialParams{ID: credentialID, GatewayID: enrollment.GatewayID, TokenDigest: security.DigestToken(credentialSecret), ExpiresAt: expires}); err != nil {
		return EnrollmentResult{}, databaseError(err)
	}
	if _, err = q.CompleteGatewayEnrollment(ctx, db.CompleteGatewayEnrollmentParams{CredentialFingerprint: &fingerprint, CredentialID: &credentialID, ID: enrollment.ID}); err != nil {
		return EnrollmentResult{}, err
	}
	action, changed := "streaming_gateway.enrolled", []string{"lifecycle", "credential"}
	var row db.StreamingGateway
	if reenroll {
		action, changed = "streaming_gateway.reenrolled", []string{"credential", "configuration"}
		row, err = q.ReenrollGateway(ctx, enrollment.GatewayID)
	} else {
		row, err = q.ActivateGateway(ctx, enrollment.GatewayID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, conflict("streaming_gateway_revoked", "Gateway cannot be enrolled in its current state")
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: action, ResourceType: "streaming_gateway", ResourceID: &row.ID, ChangedFields: changed, Source: "http"}); err != nil {
		return EnrollmentResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EnrollmentResult{}, err
	}
	gateway := gatewayFrom(row)
	gateway.CredentialExpiresAt = &expires
	return EnrollmentResult{Gateway: gateway, CredentialExpiresAt: expires}, nil
}

// Authenticate resolves a runtime credential; it answers nil for anything unknown or revoked.
func (s *Service) Authenticate(ctx context.Context, raw string) (*Context, error) {
	if !validOpaqueToken(raw) {
		return nil, nil
	}
	q := db.New(s.pool)
	row, err := q.AuthenticateGateway(ctx, security.DigestToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = q.TouchGatewayCredential(ctx, row.CredentialID)
	return &Context{ID: row.ID, CredentialID: row.CredentialID, Name: row.Name, Lifecycle: row.Lifecycle}, nil
}

// Revoke ends the gateway's credentials and open enrollment immediately.
func (s *Service) Revoke(ctx context.Context, principal authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (Gateway, error) {
	if err := requireManage(principal); err != nil {
		return Gateway{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Gateway{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	current, err := q.GetGatewayForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.NotFound
	}
	if err != nil {
		return Gateway{}, err
	}
	if current.Lifecycle == "revoked" {
		return Gateway{}, conflict("streaming_gateway_revoked", "The gateway is already revoked")
	}
	row, err := q.RevokeGateway(ctx, db.RevokeGatewayParams{ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.StaleWrite
	}
	if err != nil {
		return Gateway{}, err
	}
	if err = q.RevokeGatewayCredentials(ctx, id); err != nil {
		return Gateway{}, err
	}
	if err = q.RevokeOpenGatewayEnrollments(ctx, id); err != nil {
		return Gateway{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "streaming_gateway.revoked", ResourceType: "streaming_gateway", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"lifecycle", "credentials"}}); err != nil {
		return Gateway{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Gateway{}, err
	}
	return gatewayFrom(row), nil
}

// RotateCredential replaces the gateway's credential; the previous one stays valid for 24 hours.
func (s *Service) RotateCredential(ctx context.Context, gateway Context, credentialID uuid.UUID, credentialSecret string) (time.Time, error) {
	if gateway.Lifecycle != "active" || credentialID == uuid.Nil || !validOpaqueToken(credentialSecret) {
		return time.Time{}, validation("valid gateway credentials are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	existing, existingErr := q.GetGatewayCredential(ctx, db.GetGatewayCredentialParams{ID: credentialID, GatewayID: gateway.ID})
	if existingErr == nil {
		if !bytes.Equal(existing.TokenDigest, security.DigestToken(credentialSecret)) || existing.State == "revoked" {
			return time.Time{}, conflict("credential_rotation_conflict", "Credential identifier was reused with different credentials")
		}
		if err = tx.Commit(ctx); err != nil {
			return time.Time{}, err
		}
		return existing.ExpiresAt, nil
	}
	if !errors.Is(existingErr, pgx.ErrNoRows) {
		return time.Time{}, existingErr
	}
	if err = q.RevokeRetiringGatewayCredentials(ctx, gateway.ID); err != nil {
		return time.Time{}, err
	}
	if err = q.BeginGatewayCredentialRotation(ctx, gateway.ID); err != nil {
		return time.Time{}, err
	}
	expires := s.now().Add(credentialTTL).Truncate(time.Microsecond)
	if _, err = q.CreateRotatedGatewayCredential(ctx, db.CreateRotatedGatewayCredentialParams{ID: credentialID, GatewayID: gateway.ID, TokenDigest: security.DigestToken(credentialSecret), ExpiresAt: expires}); err != nil {
		return time.Time{}, databaseError(err)
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "streaming_gateway.credential_rotated", ResourceType: "streaming_gateway", ResourceID: &gateway.ID, ChangedFields: []string{"credential"}, Source: "http"}); err != nil {
		return time.Time{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return time.Time{}, err
	}
	return expires, nil
}

// ---- cameras ----

// CameraCandidate is a machine that can be given a camera.
type CameraCandidate struct {
	ID         uuid.UUID
	Name, Kind string
}

// ListCameraCandidates lists machines with an active Bambu printer assignment and no camera yet.
// It needs local_services.manage only, so the assign dialog works without machines.read.
func (s *Service) ListCameraCandidates(ctx context.Context, principal authorization.Principal) ([]CameraCandidate, error) {
	if err := requireManage(principal); err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListCameraCandidates(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]CameraCandidate, 0, len(rows))
	for _, row := range rows {
		result = append(result, CameraCandidate{ID: row.ID, Name: row.Name, Kind: row.Kind})
	}
	return result, nil
}

func cameraFrom(row db.GetCameraViewRow, now time.Time) Camera {
	return buildCamera(row.ID, row.GatewayID, row.MachineID, row.GatewayName, row.GatewayLifecycle, row.MachineName, row.Enabled, row.Health, row.Viewers, row.Codec, row.Width, row.Height, row.Fps, row.ReportedAt, row.Version, row.CreatedAt, row.UpdatedAt, now)
}

func buildCamera(id, gatewayID, machineID uuid.UUID, gatewayName, gatewayLifecycle, machineName string, enabled bool, health *string, viewers *int32, codec *string, width, height *int32, fps *float64, reportedAt pgtype.Timestamptz, version int64, createdAt, updatedAt, now time.Time) Camera {
	camera := Camera{ID: id, GatewayID: gatewayID, MachineID: machineID, GatewayName: gatewayName, GatewayLifecycle: gatewayLifecycle,
		MachineName: machineName, Enabled: enabled, Health: "unknown", Version: version, CreatedAt: createdAt, UpdatedAt: updatedAt}
	reported := nullableTime(reportedAt)
	if health == nil || reported == nil || now.Sub(*reported) > cameraStatusStaleAfter || gatewayLifecycle != "active" {
		return camera
	}
	camera.Health, camera.Codec, camera.FPS, camera.ReportedAt = *health, codec, fps, reported
	if viewers != nil {
		v := int(*viewers)
		camera.Viewers = &v
	}
	if width != nil {
		v := int(*width)
		camera.Width = &v
	}
	if height != nil {
		v := int(*height)
		camera.Height = &v
	}
	return camera
}

// ListCameras lists a gateway's cameras with their last reported health.
func (s *Service) ListCameras(ctx context.Context, principal authorization.Principal, gatewayID uuid.UUID) ([]Camera, error) {
	if err := requireManage(principal); err != nil {
		return nil, err
	}
	q := db.New(s.pool)
	if _, err := q.GetGateway(ctx, gatewayID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	return s.listCameras(ctx, q, &gatewayID)
}

// ListAllCameras lists the cameras of every gateway (the local services status view).
func (s *Service) ListAllCameras(ctx context.Context, principal authorization.Principal) ([]Camera, error) {
	if err := requireManage(principal); err != nil {
		return nil, err
	}
	return s.listCameras(ctx, db.New(s.pool), nil)
}

func (s *Service) listCameras(ctx context.Context, q *db.Queries, gatewayID *uuid.UUID) ([]Camera, error) {
	rows, err := q.ListCameraViews(ctx, gatewayID)
	if err != nil {
		return nil, err
	}
	now := s.now()
	result := make([]Camera, 0, len(rows))
	for _, row := range rows {
		result = append(result, buildCamera(row.ID, row.GatewayID, row.MachineID, row.GatewayName, row.GatewayLifecycle, row.MachineName, row.Enabled, row.Health, row.Viewers, row.Codec, row.Width, row.Height, row.Fps, row.ReportedAt, row.Version, row.CreatedAt, row.UpdatedAt, now))
	}
	return result, nil
}

// AssignCamera binds a machine's printer camera to a gateway. The machine must exist and have an
// active Bambu printer assignment, because the stream source comes from that assignment.
func (s *Service) AssignCamera(ctx context.Context, principal authorization.Principal, gatewayID, machineID uuid.UUID, enabled bool, requestID *uuid.UUID) (Camera, error) {
	if err := requireManage(principal); err != nil {
		return Camera{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Camera{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	gateway, err := q.GetGatewayForUpdate(ctx, gatewayID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Camera{}, apperror.NotFound
	}
	if err != nil {
		return Camera{}, err
	}
	if gateway.Lifecycle == "revoked" {
		return Camera{}, conflict("streaming_gateway_revoked", "A revoked gateway cannot receive cameras")
	}
	exists, err := q.MachineExists(ctx, machineID)
	if err != nil {
		return Camera{}, err
	}
	if !exists {
		return Camera{}, validation("machineId does not refer to an existing machine")
	}
	if _, err = q.ActiveBambuAssignmentForMachine(ctx, machineID); errors.Is(err, pgx.ErrNoRows) {
		return Camera{}, validation("the machine needs an active Bambu printer assignment (H2D or X1 Carbon) before its camera can be streamed")
	} else if err != nil {
		return Camera{}, err
	}
	id := uuid.Must(uuid.NewV7())
	if _, err = q.CreateCamera(ctx, db.CreateCameraParams{ID: id, GatewayID: gatewayID, MachineID: machineID, Enabled: enabled}); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Camera{}, conflict("streaming_camera_exists", "This machine already has a streaming camera")
		}
		return Camera{}, databaseError(err)
	}
	if err = q.BumpGatewayConfiguration(ctx, gatewayID); err != nil {
		return Camera{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "streaming_camera.assigned", ResourceType: "streaming_camera", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"gatewayId", "machineId", "enabled"}}); err != nil {
		return Camera{}, err
	}
	view, err := q.GetCameraView(ctx, id)
	if err != nil {
		return Camera{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Camera{}, err
	}
	return cameraFrom(view, s.now()), nil
}

// UpdateCamera enables or disables a camera.
func (s *Service) UpdateCamera(ctx context.Context, principal authorization.Principal, gatewayID, cameraID uuid.UUID, enabled bool, expected int64, requestID *uuid.UUID) (Camera, error) {
	if err := requireManage(principal); err != nil {
		return Camera{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Camera{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.GetCameraForUpdate(ctx, db.GetCameraForUpdateParams{ID: cameraID, GatewayID: gatewayID}); errors.Is(err, pgx.ErrNoRows) {
		return Camera{}, apperror.NotFound
	} else if err != nil {
		return Camera{}, err
	}
	if _, err = q.UpdateCameraEnabled(ctx, db.UpdateCameraEnabledParams{Enabled: enabled, ID: cameraID, GatewayID: gatewayID, ExpectedVersion: expected}); errors.Is(err, pgx.ErrNoRows) {
		return Camera{}, apperror.StaleWrite
	} else if err != nil {
		return Camera{}, err
	}
	if err = q.BumpGatewayConfiguration(ctx, gatewayID); err != nil {
		return Camera{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "streaming_camera.updated", ResourceType: "streaming_camera", ResourceID: &cameraID, RequestID: requestID, ChangedFields: []string{"enabled"}}); err != nil {
		return Camera{}, err
	}
	view, err := q.GetCameraView(ctx, cameraID)
	if err != nil {
		return Camera{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Camera{}, err
	}
	return cameraFrom(view, s.now()), nil
}

// DeleteCamera unassigns a camera.
func (s *Service) DeleteCamera(ctx context.Context, principal authorization.Principal, gatewayID, cameraID uuid.UUID, requestID *uuid.UUID) error {
	if err := requireManage(principal); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	affected, err := q.DeleteCamera(ctx, db.DeleteCameraParams{ID: cameraID, GatewayID: gatewayID})
	if err != nil {
		return err
	}
	if affected == 0 {
		return apperror.NotFound
	}
	if err = q.BumpGatewayConfiguration(ctx, gatewayID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "streaming_camera.unassigned", ResourceType: "streaming_camera", ResourceID: &cameraID, RequestID: requestID, ChangedFields: []string{"gatewayId", "machineId"}}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---- gateway-facing: configuration and heartbeat ----

// BuildSourceURL builds the go2rtc source of a Bambu printer camera. The rtspx scheme is go2rtc's
// RTSPS without certificate verification, which Bambu's self-signed printer certificate needs.
// Verify the path and port on real hardware; see docs/streaming-gateway.md.
func BuildSourceURL(ip, accessCode string) string {
	source := url.URL{Scheme: "rtspx", User: url.UserPassword("bblp", accessCode), Host: ip + ":322", Path: "/streaming/live/1"}
	return source.String()
}

// Configuration returns the complete configuration of an authenticated gateway.
func (s *Service) Configuration(ctx context.Context, gateway Context) (Configuration, error) {
	if gateway.Lifecycle != "active" && gateway.Lifecycle != "disabled" {
		return Configuration{}, apperror.New(403, "streaming_gateway_inactive", "Gateway is not active")
	}
	q := db.New(s.pool)
	row, err := q.GetGateway(ctx, gateway.ID)
	if err != nil {
		return Configuration{}, err
	}
	keys, err := s.PublicKeys(ctx)
	if err != nil {
		return Configuration{}, err
	}
	epoch, err := q.GetSessionEpoch(ctx)
	if err != nil {
		return Configuration{}, err
	}
	revoked, err := q.ListRevokedDisplayIDs(ctx, s.now().Add(-24*time.Hour))
	if err != nil {
		return Configuration{}, err
	}
	result := Configuration{SessionEpoch: epoch, RevokedDisplays: revoked, Revision: row.ConfigurationRevision, ProtocolVersion: ProtocolVersion, PublicHost: row.PublicHost, TicketPublicKeys: keys, Cameras: []ConfigCamera{}}
	if gateway.Lifecycle == "disabled" {
		return result, nil
	}
	cameras, err := q.ListGatewayConfigCameras(ctx, gateway.ID)
	if err != nil {
		return Configuration{}, err
	}
	for _, camera := range cameras {
		var settings struct {
			IPAddress string `json:"ipAddress"`
		}
		if json.Unmarshal(camera.Settings, &settings) != nil {
			continue
		}
		addr, parseErr := netip.ParseAddr(strings.TrimSpace(settings.IPAddress))
		if parseErr != nil || !addr.Is4() {
			continue
		}
		var secrets map[string]string
		if len(camera.EncryptedSecrets) == 0 {
			continue
		}
		if s.keyring == nil {
			return Configuration{}, conflict("encryption_not_configured", "Printer credentials cannot be decrypted")
		}
		plain, decryptErr := s.keyring.Decrypt(camera.EncryptedSecrets, "printer-connector-assignment:"+camera.AssignmentID.String())
		if decryptErr != nil {
			return Configuration{}, decryptErr
		}
		if json.Unmarshal(plain, &secrets) != nil || secrets["lanAccessCode"] == "" {
			continue
		}
		result.Cameras = append(result.Cameras, ConfigCamera{MachineID: camera.MachineID, Name: camera.MachineName, StreamName: StreamName(camera.MachineID), SourceURL: BuildSourceURL(addr.String(), secrets["lanAccessCode"])})
	}
	return result, nil
}

func plainText(value string, maxRunes int) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// Heartbeat records gateway and camera health. Camera health is ephemeral and not audited.
func (s *Service) Heartbeat(ctx context.Context, gateway Context, input Heartbeat) (Gateway, error) {
	if gateway.Lifecycle != "active" {
		return Gateway{}, apperror.New(403, "streaming_gateway_inactive", "Gateway is not active")
	}
	input.SoftwareVersion = strings.TrimSpace(input.SoftwareVersion)
	if input.SoftwareVersion == "" || !plainText(input.SoftwareVersion, 80) || input.ProtocolVersion != ProtocolVersion ||
		(input.HealthState != "connected" && input.HealthState != "degraded") || input.AppliedConfigurationRevision < 0 || len(input.Cameras) > 100 {
		return Gateway{}, validation("invalid heartbeat")
	}
	if input.HealthSummary != nil && !plainText(*input.HealthSummary, 500) {
		return Gateway{}, validation("invalid heartbeat")
	}
	for _, camera := range input.Cameras {
		if (camera.Health != "live" && camera.Health != "idle" && camera.Health != "unavailable") || camera.Viewers < 0 || camera.Viewers > 100000 ||
			(camera.Codec != nil && (*camera.Codec == "" || !plainText(*camera.Codec, 40))) ||
			(camera.Width != nil && (*camera.Width < 1 || *camera.Width > 16384)) || (camera.Height != nil && (*camera.Height < 1 || *camera.Height > 16384)) ||
			(camera.FPS != nil && (*camera.FPS < 0 || *camera.FPS > 1000)) {
			return Gateway{}, validation("invalid camera health")
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Gateway{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	protocol := int32(input.ProtocolVersion)
	row, err := q.RecordGatewayHeartbeat(ctx, db.RecordGatewayHeartbeatParams{SoftwareVersion: &input.SoftwareVersion, ProtocolVersion: &protocol, AppliedConfigurationRevision: input.AppliedConfigurationRevision, HealthState: &input.HealthState, HealthSummary: input.HealthSummary, ID: gateway.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.New(403, "streaming_gateway_inactive", "Gateway is not active")
	}
	if err != nil {
		return Gateway{}, err
	}
	assigned, err := q.ListGatewayCameraMachines(ctx, gateway.ID)
	if err != nil {
		return Gateway{}, err
	}
	byMachine := make(map[uuid.UUID]uuid.UUID, len(assigned))
	for _, camera := range assigned {
		byMachine[camera.MachineID] = camera.ID
	}
	if err = q.DeleteCameraStatesOfGateway(ctx, gateway.ID); err != nil {
		return Gateway{}, err
	}
	for _, camera := range input.Cameras {
		cameraID, ok := byMachine[camera.MachineID]
		if !ok {
			continue
		}
		var width, height *int32
		if camera.Width != nil {
			v := int32(*camera.Width)
			width = &v
		}
		if camera.Height != nil {
			v := int32(*camera.Height)
			height = &v
		}
		if err = q.UpsertCameraState(ctx, db.UpsertCameraStateParams{CameraID: cameraID, Health: camera.Health, Viewers: int32(camera.Viewers), Codec: camera.Codec, Width: width, Height: height, Fps: camera.FPS}); err != nil {
			return Gateway{}, err
		}
	}
	result, err := withCredentialExpiry(ctx, q, gatewayFrom(row))
	if err != nil {
		return Gateway{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Gateway{}, err
	}
	return result, nil
}
