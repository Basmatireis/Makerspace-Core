// Package streaminggateways owns the local streaming gateways that restream printer cameras to
// digital-signage players: the gateway registry and its enrollment/credential lifecycle (modelled
// on the printer connectors), camera assignments, the configuration a gateway polls, heartbeat
// health, and the Ed25519 tickets that authorise players to watch a stream.
package streaminggateways

import (
	"context"
	"errors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

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
	Name, PublicHost                      string
	Lifecycle                             Lifecycle
	ConfigurationRevision, AppliedRevison int64
	SoftwareVersion                       *string
	HealthState                           *HealthState
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
	ID, GatewayID, MachineID uuid.UUID
	GatewayName              string
	GatewayLifecycle         Lifecycle
	MachineName              string
	Enabled                  bool
	Health                   CameraStatus
	Viewers                  *int
	Codec                    *string
	Width, Height            *int
	FPS                      *float64
	ReportedAt               *time.Time
	Version                  int64
	CreatedAt, UpdatedAt     time.Time
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
	Name             string
	Lifecycle        Lifecycle
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
	Health        CameraStatus
	Viewers       int
	Codec         *string
	Width, Height *int
	FPS           *float64
}

// Heartbeat is what a gateway reports every 30 seconds.
type Heartbeat struct {
	SoftwareVersion              string
	HealthState                  HealthState
	ProtocolVersion              int
	AppliedConfigurationRevision int64
	HealthSummary                *string
	Cameras                      []CameraHealth
}

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
		ID: row.ID, Name: row.Name, PublicHost: row.PublicHost, Lifecycle: Lifecycle(row.Lifecycle),
		ConfigurationRevision: row.ConfigurationRevision, AppliedRevison: row.AppliedConfigurationRevision,
		SoftwareVersion: row.SoftwareVersion,
		ProtocolVersion: protocol,
		HealthState:     optional.Convert[HealthState](row.HealthState),
		HealthSummary:   row.HealthSummary,
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
		return "", apperror.Invalid("name is required and limited to 120 characters")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", apperror.Invalid("name must not contain control characters")
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
	invalid := apperror.Invalid(
		"publicHost must be a hostname or IPv4 address with an optional port, for example signage-gw.example.org:8443",
	)
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
			return apperror.Conflicting(
				"streaming_gateway_conflict",
				"A gateway with this name or a camera for this machine already exists",
			)
		case "23503":
			return apperror.NotFound
		}
	}
	return err
}

// ---- cameras ----

// ---- gateway-facing: configuration and heartbeat ----
