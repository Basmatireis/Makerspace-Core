package printerconnectors

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"regexp"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	enrollmentTTL = 15 * time.Minute
	credentialTTL = 90 * 24 * time.Hour
)

var bambuSerialPattern = regexp.MustCompile(`^[A-Z0-9]{8,32}$`)

type Service struct {
	pool     *pgxpool.Pool
	printing *printing.Service
	logbook  *machinelogbook.Service
	keyring  *security.Keyring
}

func NewService(pool *pgxpool.Pool, printingService *printing.Service, encryptionKeys [][]byte) (*Service, error) {
	var keyring *security.Keyring
	var err error
	if len(encryptionKeys) != 0 {
		keyring, err = security.NewKeyring(encryptionKeys)
		if err != nil {
			return nil, err
		}
	}
	return &Service{pool: pool, printing: printingService, logbook: machinelogbook.NewService(pool), keyring: keyring}, nil
}

type Connector struct {
	ID                                          uuid.UUID
	Name, Lifecycle                             string
	LocationLabel, SoftwareVersion, HealthState *string
	HealthSummary                               *string
	ConfigurationRevision, AppliedRevision      int64
	PendingEventCount, QuarantinedEventCount    int64
	ProtocolVersion                             *int
	LastHeartbeatAt, EnrolledAt, DisabledAt     *time.Time
	RevokedAt, EventsClearedAt                  *time.Time
	EventsClearedByName                         *string
	Version                                     int64
	CreatedAt, UpdatedAt                        time.Time
}

type EnrollmentIssue struct {
	Connector Connector
	ID        uuid.UUID
	Secret    string
	ExpiresAt time.Time
}

type EnrollmentResult struct {
	Connector           Connector
	CredentialExpiresAt time.Time
}

type Context struct {
	ID, CredentialID uuid.UUID
	Name, Lifecycle  string
}

type Assignment struct {
	ID, ConnectorID, MachineID           uuid.UUID
	MachineName, AdapterKind             string
	AdapterSchemaVersion                 int
	Settings                             json.RawMessage
	EncryptedSecrets                     []byte
	ConfigurationVersion, AppliedVersion int64
	Enabled, PrinterEnabled              bool
	RuntimeState, RuntimeErrorCode       *string
	ActivatedAt                          time.Time
	EndedAt                              *time.Time
	Version                              int64
	CreatedAt, UpdatedAt                 time.Time
}

type AssignmentInput struct {
	MachineID            uuid.UUID
	AdapterKind          string
	AdapterSchemaVersion int
	Settings             json.RawMessage
	Secrets              map[string]string
	Enabled              bool
}

type AssignmentUpdate struct {
	AdapterKind          string
	AdapterSchemaVersion int
	Settings             json.RawMessage
	Secrets              *map[string]string
	Enabled, End         bool
	ExpectedVersion      int64
}

type RuntimeAssignment struct {
	ID, MachineID            uuid.UUID
	MachineName, AdapterKind string
	AdapterSchemaVersion     int
	ConfigurationVersion     int64
	Settings                 json.RawMessage
	Secrets                  map[string]string
	Enabled                  bool
}

type Configuration struct {
	Revision        int64
	ProtocolVersion int
	Assignments     []RuntimeAssignment
}

type AssignmentHealth struct {
	AssignmentID                uuid.UUID
	AppliedConfigurationVersion int64
	State                       string
	ErrorCode                   *string
}

type Heartbeat struct {
	SoftwareVersion, HealthState             string
	ProtocolVersion                          int
	AppliedConfigurationRevision             int64
	HealthSummary                            *string
	PendingEventCount, QuarantinedEventCount int64
	Assignments                              []AssignmentHealth
}

type EventInput struct {
	EventID, AssignmentID uuid.UUID
	RunID                 *uuid.UUID
	HistoryComplete       bool
	ConfigurationVersion  int64
	Sequence              int64
	OccurredAt            time.Time
	Kind                  string
	ExternalPrintID       *string
	ReportRevision        *int64
	Payload               json.RawMessage
}

type ObservedRun struct {
	ID, AssignmentID, MachineID     uuid.UUID
	MachineName                     string
	VendorJobID                     *string
	State                           string
	HistoryComplete                 bool
	FirstObservedAt, LastObservedAt time.Time
	Version                         int64
}

type ConnectorEvent struct {
	ID, MachineID, AssignmentID uuid.UUID
	Kind                        string
	OccurredAt, ReceivedAt      time.Time
	ApplicationState            string
	ApplicationReason           *string
	Payload                     json.RawMessage
}

type EventReceipt struct {
	EventID     uuid.UUID
	CoreEventID *uuid.UUID
	Status      string
	ReasonCode  *string
}

func validation(message string) error     { return apperror.New(422, "validation_failed", message) }
func conflict(code, message string) error { return apperror.New(409, code, message) }

func nullableTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time.UTC()
	return &v
}

func validateAssignmentContract(kind string, version int, settings json.RawMessage, secrets map[string]string, creating bool) (json.RawMessage, map[string]string, error) {
	if version != 1 {
		return nil, nil, validation("unsupported adapter schema version")
	}
	if len(settings) == 0 {
		settings = json.RawMessage(`{}`)
	}
	if len(settings) > 32768 {
		return nil, nil, validation("settings must be a bounded JSON object")
	}
	if !isBambuLANAdapter(kind) {
		var object map[string]any
		if json.Unmarshal(settings, &object) != nil || object == nil {
			return nil, nil, validation("settings must be a bounded JSON object")
		}
		return settings, secrets, nil
	}
	var value struct {
		IPAddress        string `json:"ipAddress"`
		SerialNumber     string `json:"serialNumber"`
		AutoDetectSpools bool   `json:"autoDetectSpools"`
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(settings, &value) != nil || json.Unmarshal(settings, &raw) != nil || len(raw) < 2 || len(raw) > 3 {
		return nil, nil, validation(kind + " settings require ipAddress, serialNumber, and optional autoDetectSpools")
	}
	for key := range raw {
		if key != "ipAddress" && key != "serialNumber" && key != "autoDetectSpools" {
			return nil, nil, validation(kind + " settings contain an unsupported field")
		}
	}
	if encoded, ok := raw["autoDetectSpools"]; ok {
		var enabled bool
		if json.Unmarshal(encoded, &enabled) != nil {
			return nil, nil, validation("autoDetectSpools must be a boolean")
		}
	}
	addr, err := netip.ParseAddr(strings.TrimSpace(value.IPAddress))
	if err != nil || !addr.Is4() || !(addr.IsGlobalUnicast() || addr.IsLinkLocalUnicast()) {
		return nil, nil, validation("ipAddress must be an IPv4 unicast literal")
	}
	serial := strings.ToUpper(strings.TrimSpace(value.SerialNumber))
	if !bambuSerialPattern.MatchString(serial) {
		return nil, nil, validation("serialNumber must be an 8 to 32 character Bambu serial")
	}
	for key := range secrets {
		if key != "lanAccessCode" {
			return nil, nil, validation(kind + " secrets contain only lanAccessCode")
		}
	}
	code := strings.TrimSpace(secrets["lanAccessCode"])
	if creating && code == "" {
		return nil, nil, validation("lanAccessCode is required")
	}
	if len(code) > 128 {
		return nil, nil, validation("lanAccessCode is invalid")
	}
	normalized, err := json.Marshal(struct {
		IPAddress        string `json:"ipAddress"`
		SerialNumber     string `json:"serialNumber"`
		AutoDetectSpools bool   `json:"autoDetectSpools"`
	}{IPAddress: addr.String(), SerialNumber: serial, AutoDetectSpools: value.AutoDetectSpools})
	if err != nil {
		return nil, nil, err
	}
	normalizedSecrets := map[string]string{}
	if code != "" {
		normalizedSecrets["lanAccessCode"] = code
	}
	return normalized, normalizedSecrets, nil
}

func timestamptz(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func connectorFrom(row db.PrinterConnector) Connector {
	var protocol *int
	if row.ProtocolVersion != nil {
		value := int(*row.ProtocolVersion)
		protocol = &value
	}
	return Connector{ID: row.ID, Name: row.Name, LocationLabel: row.LocationLabel, Lifecycle: row.Lifecycle,
		ConfigurationRevision: row.ConfigurationRevision, AppliedRevision: row.AppliedConfigurationRevision,
		SoftwareVersion: row.SoftwareVersion, ProtocolVersion: protocol, HealthState: row.HealthState,
		HealthSummary: row.HealthSummary, PendingEventCount: row.PendingEventCount, QuarantinedEventCount: row.QuarantinedEventCount,
		LastHeartbeatAt: nullableTime(row.LastHeartbeatAt), EnrolledAt: nullableTime(row.EnrolledAt), DisabledAt: nullableTime(row.DisabledAt),
		RevokedAt: nullableTime(row.RevokedAt), EventsClearedAt: nullableTime(row.EventsClearedAt), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return "", validation("name is required and limited to 120 characters")
	}
	return name, nil
}

func normalizeLocation(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	clean := strings.TrimSpace(*value)
	if clean == "" || len(clean) > 200 {
		return nil, validation("locationLabel must be non-empty and limited to 200 characters")
	}
	return &clean, nil
}

func (s *Service) Create(ctx context.Context, principal authorization.Principal, name string, location *string, requestID *uuid.UUID) (Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsManage) {
		return Connector{}, apperror.PermissionDenied
	}
	name, err := normalizeName(name)
	if err != nil {
		return Connector{}, err
	}
	location, err = normalizeLocation(location)
	if err != nil {
		return Connector{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer tx.Rollback(ctx)
	id := uuid.Must(uuid.NewV7())
	row, err := db.New(tx).CreateConnector(ctx, db.CreateConnectorParams{ID: id, Name: name, LocationLabel: location})
	if err != nil {
		return Connector{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "printer_connector.created", ResourceType: "printer_connector", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "locationLabel"}}); err != nil {
		return Connector{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return connectorFrom(row), nil
}

func (s *Service) List(ctx context.Context, principal authorization.Principal) ([]Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return nil, apperror.PermissionDenied
	}
	rows, err := db.New(s.pool).ListConnectors(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Connector, 0, len(rows))
	q := db.New(s.pool)
	for _, row := range rows {
		connector, err := connectorWithClearedBy(ctx, q, row)
		if err != nil {
			return nil, err
		}
		result = append(result, connector)
	}
	return result, nil
}

// connectorWithClearedBy converts a row and names the person who cleared the
// connector's events. The name is only shown on the connector's own reads.
func connectorWithClearedBy(ctx context.Context, q *db.Queries, row db.PrinterConnector) (Connector, error) {
	connector := connectorFrom(row)
	if row.EventsClearedBy == nil {
		return connector, nil
	}
	name, err := q.GetAccountDisplayName(ctx, *row.EventsClearedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return connector, nil
	}
	if err != nil {
		return Connector{}, err
	}
	connector.EventsClearedByName = &name
	return connector, nil
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return Connector{}, apperror.PermissionDenied
	}
	q := db.New(s.pool)
	row, err := q.GetConnector(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.NotFound
	}
	if err != nil {
		return Connector{}, err
	}
	return connectorWithClearedBy(ctx, q, row)
}

// ClearEvents hides the events received so far from the event lists. Events are
// never deleted; includeCleared brings them back.
func (s *Service) ClearEvents(ctx context.Context, principal authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsManage) {
		return Connector{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	if _, err = q.GetConnectorForUpdate(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.NotFound
	} else if err != nil {
		return Connector{}, err
	}
	actor := principal.AccountID
	row, err := q.ClearConnectorEvents(ctx, db.ClearConnectorEventsParams{ID: id, ClearedAt: pgTimestamp(timePtr(time.Now())), ClearedBy: &actor})
	if err != nil {
		return Connector{}, databaseError(err)
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "printer_connector.events_cleared", ResourceType: "printer_connector", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"eventsClearedAt"}}); err != nil {
		return Connector{}, err
	}
	connector, err := connectorWithClearedBy(ctx, q, row)
	if err != nil {
		return Connector{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return connector, nil
}

func (s *Service) Update(ctx context.Context, principal authorization.Principal, id uuid.UUID, name string, location *string, enabled bool, expected int64, requestID *uuid.UUID) (Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsManage) {
		return Connector{}, apperror.PermissionDenied
	}
	name, err := normalizeName(name)
	if err != nil {
		return Connector{}, err
	}
	location, err = normalizeLocation(location)
	if err != nil {
		return Connector{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	current, err := q.GetConnectorForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.NotFound
	}
	if err != nil {
		return Connector{}, err
	}
	if current.Lifecycle == "revoked" {
		return Connector{}, conflict("printer_connector_revoked", "A revoked connector cannot be updated")
	}
	lifecycle := current.Lifecycle
	var disabledAt *time.Time
	if lifecycle == "pending" {
		if !enabled {
			return Connector{}, validation("A pending connector cannot be disabled before enrollment")
		}
	} else if enabled {
		lifecycle = "active"
	} else {
		lifecycle = "disabled"
		now := time.Now().UTC()
		disabledAt = &now
	}
	row, err := q.UpdateConnector(ctx, db.UpdateConnectorParams{Name: name, LocationLabel: location, Lifecycle: lifecycle, DisabledAt: timestamptz(disabledAt), ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.StaleWrite
	}
	if err != nil {
		return Connector{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "printer_connector.updated", ResourceType: "printer_connector", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "locationLabel", "lifecycle"}}); err != nil {
		return Connector{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return connectorFrom(row), nil
}

func (s *Service) IssueEnrollment(ctx context.Context, principal authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (EnrollmentIssue, error) {
	if !principal.Has(authorization.PrinterConnectorsCredentialsManage) {
		return EnrollmentIssue{}, apperror.PermissionDenied
	}
	secret, digest, err := security.NewOpaqueToken()
	if err != nil {
		return EnrollmentIssue{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EnrollmentIssue{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	connector, err := q.GetConnectorForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentIssue{}, apperror.NotFound
	}
	if err != nil {
		return EnrollmentIssue{}, err
	}
	if connector.Lifecycle != "pending" {
		return EnrollmentIssue{}, conflict("printer_connector_not_pending", "Only a pending connector can be enrolled")
	}
	if err = q.RevokeOpenEnrollments(ctx, id); err != nil {
		return EnrollmentIssue{}, err
	}
	expires := time.Now().UTC().Add(enrollmentTTL)
	enrollmentID := uuid.Must(uuid.NewV7())
	actor := principal.AccountID
	if _, err = q.CreateEnrollment(ctx, db.CreateEnrollmentParams{ID: enrollmentID, ConnectorID: id, TokenDigest: digest, ExpiresAt: expires, CreatedByAccountID: &actor}); err != nil {
		return EnrollmentIssue{}, err
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "printer_connector.enrollment_issued", ResourceType: "printer_connector", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"enrollment"}}); err != nil {
		return EnrollmentIssue{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EnrollmentIssue{}, err
	}
	return EnrollmentIssue{Connector: connectorFrom(connector), ID: enrollmentID, Secret: secret, ExpiresAt: expires}, nil
}

func validOpaqueToken(raw string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	return err == nil && len(decoded) == 32
}

func (s *Service) Enroll(ctx context.Context, enrollmentSecret string, credentialID uuid.UUID, credentialSecret, softwareVersion string, protocolVersion int) (EnrollmentResult, error) {
	if !validOpaqueToken(enrollmentSecret) || !validOpaqueToken(credentialSecret) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	softwareVersion = strings.TrimSpace(softwareVersion)
	if softwareVersion == "" || len(softwareVersion) > 80 || protocolVersion != 1 {
		return EnrollmentResult{}, validation("unsupported connector identity or protocol version")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EnrollmentResult{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	enrollment, err := q.GetEnrollmentByDigestForUpdate(ctx, security.DigestToken(enrollmentSecret))
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	if enrollment.RevokedAt.Valid || time.Now().UTC().After(enrollment.ExpiresAt) {
		return EnrollmentResult{}, apperror.Unauthenticated
	}
	fingerprintBytes := sha256.Sum256([]byte(credentialSecret))
	fingerprint := hex.EncodeToString(fingerprintBytes[:])
	if enrollment.ConsumedAt.Valid {
		if enrollment.CredentialFingerprint == nil || *enrollment.CredentialFingerprint != fingerprint || enrollment.AcceptedCredentialID == nil || *enrollment.AcceptedCredentialID != credentialID {
			return EnrollmentResult{}, conflict("enrollment_replay_conflict", "Enrollment was already consumed with different credentials")
		}
		row, getErr := q.GetConnector(ctx, enrollment.ConnectorID)
		if getErr != nil {
			return EnrollmentResult{}, getErr
		}
		if err = tx.Commit(ctx); err != nil {
			return EnrollmentResult{}, err
		}
		credential, credentialErr := q.GetConnectorCredential(ctx, db.GetConnectorCredentialParams{ID: credentialID, ConnectorID: enrollment.ConnectorID})
		if credentialErr != nil {
			return EnrollmentResult{}, credentialErr
		}
		return EnrollmentResult{Connector: connectorFrom(row), CredentialExpiresAt: credential.ExpiresAt}, nil
	}
	expires := time.Now().UTC().Add(credentialTTL)
	if _, err = q.CreateCredential(ctx, db.CreateCredentialParams{ID: credentialID, ConnectorID: enrollment.ConnectorID, TokenDigest: security.DigestToken(credentialSecret), ExpiresAt: expires}); err != nil {
		return EnrollmentResult{}, databaseError(err)
	}
	if _, err = q.CompleteEnrollment(ctx, db.CompleteEnrollmentParams{CredentialFingerprint: &fingerprint, CredentialID: &credentialID, ID: enrollment.ID}); err != nil {
		return EnrollmentResult{}, err
	}
	row, err := q.ActivateConnector(ctx, enrollment.ConnectorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return EnrollmentResult{}, conflict("printer_connector_not_pending", "Connector cannot be enrolled in its current state")
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "printer_connector.enrolled", ResourceType: "printer_connector", ResourceID: &row.ID, ChangedFields: []string{"lifecycle", "credential"}, Source: "http"}); err != nil {
		return EnrollmentResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EnrollmentResult{}, err
	}
	return EnrollmentResult{Connector: connectorFrom(row), CredentialExpiresAt: expires}, nil
}

func (s *Service) Authenticate(ctx context.Context, raw string) (*Context, error) {
	if !validOpaqueToken(raw) {
		return nil, nil
	}
	q := db.New(s.pool)
	row, err := q.AuthenticateConnector(ctx, security.DigestToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = q.TouchCredential(ctx, row.CredentialID)
	return &Context{ID: row.ID, CredentialID: row.CredentialID, Name: row.Name, Lifecycle: row.Lifecycle}, nil
}

func (s *Service) Revoke(ctx context.Context, principal authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsCredentialsManage) {
		return Connector{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	row, err := q.RevokeConnector(ctx, db.RevokeConnectorParams{ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.StaleWrite
	}
	if err != nil {
		return Connector{}, err
	}
	if err = q.RevokeConnectorCredentials(ctx, id); err != nil {
		return Connector{}, err
	}
	if err = q.RevokeOpenEnrollments(ctx, id); err != nil {
		return Connector{}, err
	}
	if err = q.EndConnectorAssignments(ctx, id); err != nil {
		return Connector{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "printer_connector.revoked", ResourceType: "printer_connector", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"lifecycle", "credentials", "assignments"}}); err != nil {
		return Connector{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return connectorFrom(row), nil
}

func (s *Service) CreateAssignment(ctx context.Context, principal authorization.Principal, connectorID uuid.UUID, input AssignmentInput, requestID *uuid.UUID) (Assignment, error) {
	if !principal.Has(authorization.PrinterConnectorsManage) || !principal.Has(authorization.MachinesManage) {
		return Assignment{}, apperror.PermissionDenied
	}
	input.AdapterKind = strings.TrimSpace(input.AdapterKind)
	if input.AdapterKind == "" || len(input.AdapterKind) > 80 {
		return Assignment{}, validation("adapterKind and supported schema version are required")
	}
	var err error
	input.Settings, input.Secrets, err = validateAssignmentContract(input.AdapterKind, input.AdapterSchemaVersion, input.Settings, input.Secrets, true)
	if err != nil {
		return Assignment{}, err
	}
	var encrypted []byte
	if len(input.Secrets) != 0 {
		if s.keyring == nil {
			return Assignment{}, conflict("encryption_not_configured", "Application encryption must be configured before storing printer credentials")
		}
		plain, err := json.Marshal(input.Secrets)
		if err != nil {
			return Assignment{}, validation("invalid printer secrets")
		}
		assignmentID := uuid.Must(uuid.NewV7())
		encrypted, err = s.keyring.Encrypt(plain, "printer-connector-assignment:"+assignmentID.String())
		if err != nil {
			return Assignment{}, err
		}
		return s.createAssignment(ctx, principal, connectorID, assignmentID, input, encrypted, requestID)
	}
	return s.createAssignment(ctx, principal, connectorID, uuid.Must(uuid.NewV7()), input, nil, requestID)
}

func (s *Service) ListAssignments(ctx context.Context, principal authorization.Principal, connectorID uuid.UUID) ([]Assignment, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return nil, apperror.PermissionDenied
	}
	if _, err := db.New(s.pool).GetConnector(ctx, connectorID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListConnectorAssignments(ctx, connectorID)
	if err != nil {
		return nil, err
	}
	result := make([]Assignment, 0, len(rows))
	for _, row := range rows {
		result = append(result, Assignment{ID: row.ID, ConnectorID: row.ConnectorID, MachineID: row.MachineID, MachineName: row.MachineName, AdapterKind: row.AdapterKind, AdapterSchemaVersion: int(row.AdapterSchemaVersion), Settings: row.Settings, ConfigurationVersion: row.ConfigurationVersion, AppliedVersion: row.AppliedConfigurationVersion, Enabled: row.Enabled, RuntimeState: row.RuntimeState, RuntimeErrorCode: row.RuntimeErrorCode, ActivatedAt: row.ActivatedAt, EndedAt: nullableTime(row.EndedAt), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt})
	}
	return result, nil
}

func (s *Service) UpdateAssignment(ctx context.Context, principal authorization.Principal, connectorID, assignmentID uuid.UUID, input AssignmentUpdate, requestID *uuid.UUID) (Assignment, error) {
	if !principal.Has(authorization.PrinterConnectorsManage) || !principal.Has(authorization.MachinesManage) {
		return Assignment{}, apperror.PermissionDenied
	}
	input.AdapterKind = strings.TrimSpace(input.AdapterKind)
	if input.AdapterKind == "" || len(input.AdapterKind) > 80 {
		return Assignment{}, validation("adapterKind and supported schema version are required")
	}
	providedSecrets := map[string]string{}
	if input.Secrets != nil {
		providedSecrets = *input.Secrets
	}
	var contractErr error
	input.Settings, providedSecrets, contractErr = validateAssignmentContract(input.AdapterKind, input.AdapterSchemaVersion, input.Settings, providedSecrets, false)
	if contractErr != nil {
		return Assignment{}, contractErr
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	current, err := q.GetAssignmentForUpdate(ctx, db.GetAssignmentForUpdateParams{ID: assignmentID, ConnectorID: connectorID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	if current.EndedAt.Valid {
		return Assignment{}, conflict("printer_connector_assignment_ended", "An ended assignment cannot be updated")
	}
	encrypted := current.EncryptedSecrets
	if input.Secrets != nil && (!isBambuLANAdapter(input.AdapterKind) || len(providedSecrets) != 0) {
		encrypted = nil
		if len(providedSecrets) != 0 {
			if s.keyring == nil {
				return Assignment{}, conflict("encryption_not_configured", "Application encryption must be configured before storing printer credentials")
			}
			plain, marshalErr := json.Marshal(providedSecrets)
			if marshalErr != nil {
				return Assignment{}, validation("invalid printer secrets")
			}
			encrypted, err = s.keyring.Encrypt(plain, "printer-connector-assignment:"+assignmentID.String())
			if err != nil {
				return Assignment{}, err
			}
		}
	}
	_, err = q.UpdateAssignment(ctx, db.UpdateAssignmentParams{AdapterKind: input.AdapterKind, AdapterSchemaVersion: int32(input.AdapterSchemaVersion), Settings: input.Settings, EncryptedSecrets: encrypted, Enabled: input.Enabled, EndAssignment: input.End, ID: assignmentID, ConnectorID: connectorID, ExpectedVersion: input.ExpectedVersion})
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.StaleWrite
	}
	if err != nil {
		return Assignment{}, databaseError(err)
	}
	if _, err = q.BumpConnectorConfiguration(ctx, connectorID); err != nil {
		return Assignment{}, err
	}
	row, err := q.GetAssignment(ctx, db.GetAssignmentParams{ID: assignmentID, ConnectorID: connectorID})
	if err != nil {
		return Assignment{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "printer_connector.assignment_updated", ResourceType: "printer_connector_assignment", ResourceID: &assignmentID, RequestID: requestID, ChangedFields: []string{"adapterKind", "configuration", "enabled", "endedAt"}}); err != nil {
		return Assignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	return Assignment{ID: row.ID, ConnectorID: row.ConnectorID, MachineID: row.MachineID, MachineName: row.MachineName, AdapterKind: row.AdapterKind, AdapterSchemaVersion: int(row.AdapterSchemaVersion), Settings: row.Settings, ConfigurationVersion: row.ConfigurationVersion, AppliedVersion: row.AppliedConfigurationVersion, Enabled: row.Enabled, RuntimeState: row.RuntimeState, RuntimeErrorCode: row.RuntimeErrorCode, ActivatedAt: row.ActivatedAt, EndedAt: nullableTime(row.EndedAt), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func (s *Service) ListObservedRuns(ctx context.Context, principal authorization.Principal, connectorID uuid.UUID) ([]ObservedRun, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return nil, apperror.PermissionDenied
	}
	if _, err := db.New(s.pool).GetConnector(ctx, connectorID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListObservedRuns(ctx, connectorID)
	if err != nil {
		return nil, err
	}
	result := make([]ObservedRun, 0, len(rows))
	for _, row := range rows {
		if row.AssignmentID == nil || row.State == nil || !row.FirstObservedAt.Valid || !row.LastObservedAt.Valid {
			continue
		}
		result = append(result, ObservedRun{ID: row.ID, AssignmentID: *row.AssignmentID, MachineID: row.MachineID, MachineName: row.MachineName, VendorJobID: row.VendorJobID, State: *row.State, HistoryComplete: row.HistoryComplete, FirstObservedAt: row.FirstObservedAt.Time, LastObservedAt: row.LastObservedAt.Time, Version: row.Version})
	}
	return result, nil
}

func (s *Service) ListEvents(ctx context.Context, principal authorization.Principal, connectorID uuid.UUID, includeCleared bool) ([]ConnectorEvent, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return nil, apperror.PermissionDenied
	}
	q := db.New(s.pool)
	if _, err := q.GetConnector(ctx, connectorID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := q.ListConnectorEvents(ctx, db.ListConnectorEventsParams{ConnectorID: &connectorID, IncludeCleared: includeCleared})
	if err != nil {
		return nil, err
	}
	result := make([]ConnectorEvent, 0, len(rows))
	for _, row := range rows {
		if row.MachineID == nil || row.ConnectorAssignmentID == nil {
			return nil, errors.New("connector event is missing assignment metadata")
		}
		result = append(result, ConnectorEvent{ID: row.ID, MachineID: *row.MachineID, AssignmentID: *row.ConnectorAssignmentID, Kind: row.Kind, OccurredAt: row.OccurredAt, ReceivedAt: row.ReceivedAt, ApplicationState: row.ApplicationState, ApplicationReason: row.ApplicationReason, Payload: row.Payload})
	}
	return result, nil
}

func (s *Service) RotateCredential(ctx context.Context, connector Context, credentialID uuid.UUID, credentialSecret string) (time.Time, error) {
	if connector.Lifecycle != "active" || credentialID == uuid.Nil || !validOpaqueToken(credentialSecret) {
		return time.Time{}, validation("valid connector credentials are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return time.Time{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	existing, existingErr := q.GetConnectorCredential(ctx, db.GetConnectorCredentialParams{ID: credentialID, ConnectorID: connector.ID})
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
	if err = q.RevokeRetiringCredentials(ctx, connector.ID); err != nil {
		return time.Time{}, err
	}
	if err = q.BeginCredentialRotation(ctx, connector.ID); err != nil {
		return time.Time{}, err
	}
	expires := time.Now().UTC().Add(credentialTTL)
	if _, err = q.CreateRotatedCredential(ctx, db.CreateRotatedCredentialParams{ID: credentialID, ConnectorID: connector.ID, TokenDigest: security.DigestToken(credentialSecret), ExpiresAt: expires}); err != nil {
		return time.Time{}, databaseError(err)
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "printer_connector.credential_rotated", ResourceType: "printer_connector", ResourceID: &connector.ID, ChangedFields: []string{"credential"}, Source: "http"}); err != nil {
		return time.Time{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return time.Time{}, err
	}
	return expires, nil
}

func (s *Service) createAssignment(ctx context.Context, principal authorization.Principal, connectorID, assignmentID uuid.UUID, input AssignmentInput, encrypted []byte, requestID *uuid.UUID) (Assignment, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	connector, err := q.GetConnectorForUpdate(ctx, connectorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	if connector.Lifecycle == "revoked" {
		return Assignment{}, conflict("printer_connector_revoked", "A revoked connector cannot receive printers")
	}
	row, err := q.CreateAssignment(ctx, db.CreateAssignmentParams{ID: assignmentID, ConnectorID: connectorID, MachineID: input.MachineID, AdapterKind: input.AdapterKind, AdapterSchemaVersion: int32(input.AdapterSchemaVersion), Settings: input.Settings, EncryptedSecrets: encrypted, Enabled: input.Enabled})
	if err != nil {
		return Assignment{}, databaseError(err)
	}
	if _, err = q.BumpConnectorConfiguration(ctx, connectorID); err != nil {
		return Assignment{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "printer_connector.assignment_created", ResourceType: "printer_connector_assignment", ResourceID: &assignmentID, RequestID: requestID, ChangedFields: []string{"connectorId", "machineId", "adapterKind", "configuration"}}); err != nil {
		return Assignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	return Assignment{ID: row.ID, ConnectorID: row.ConnectorID, MachineID: row.MachineID, AdapterKind: row.AdapterKind, AdapterSchemaVersion: int(row.AdapterSchemaVersion), Settings: row.Settings, ConfigurationVersion: row.ConfigurationVersion, AppliedVersion: row.AppliedConfigurationVersion, Enabled: row.Enabled, ActivatedAt: row.ActivatedAt, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func (s *Service) Configuration(ctx context.Context, connector Context) (Configuration, error) {
	if connector.Lifecycle != "active" && connector.Lifecycle != "disabled" {
		return Configuration{}, apperror.New(403, "printer_connector_inactive", "Connector is not active")
	}
	q := db.New(s.pool)
	row, err := q.GetConnector(ctx, connector.ID)
	if err != nil {
		return Configuration{}, err
	}
	if connector.Lifecycle == "disabled" {
		return Configuration{Revision: row.ConfigurationRevision, ProtocolVersion: 1, Assignments: []RuntimeAssignment{}}, nil
	}
	assignments, err := q.ListActiveAssignments(ctx, connector.ID)
	if err != nil {
		return Configuration{}, err
	}
	result := Configuration{Revision: row.ConfigurationRevision, ProtocolVersion: 1, Assignments: make([]RuntimeAssignment, 0, len(assignments))}
	for _, a := range assignments {
		secrets := map[string]string{}
		if len(a.EncryptedSecrets) != 0 {
			if s.keyring == nil {
				return Configuration{}, conflict("encryption_not_configured", "Printer credentials cannot be decrypted")
			}
			plain, decryptErr := s.keyring.Decrypt(a.EncryptedSecrets, "printer-connector-assignment:"+a.ID.String())
			if decryptErr != nil {
				return Configuration{}, decryptErr
			}
			if json.Unmarshal(plain, &secrets) != nil {
				return Configuration{}, errors.New("decode printer credentials")
			}
		}
		result.Assignments = append(result.Assignments, RuntimeAssignment{ID: a.ID, MachineID: a.MachineID, MachineName: a.MachineName, AdapterKind: a.AdapterKind, AdapterSchemaVersion: int(a.AdapterSchemaVersion), ConfigurationVersion: a.ConfigurationVersion, Settings: a.Settings, Secrets: secrets, Enabled: a.Enabled && a.PrinterEnabled})
	}
	return result, nil
}

func (s *Service) Heartbeat(ctx context.Context, connector Context, input Heartbeat) (Connector, error) {
	if connector.Lifecycle != "active" {
		return Connector{}, apperror.New(403, "printer_connector_inactive", "Connector is not active")
	}
	input.SoftwareVersion = strings.TrimSpace(input.SoftwareVersion)
	input.HealthState = strings.TrimSpace(input.HealthState)
	if input.SoftwareVersion == "" || len(input.SoftwareVersion) > 80 || input.ProtocolVersion != 1 || (input.HealthState != "connected" && input.HealthState != "degraded") || input.AppliedConfigurationRevision < 0 || input.PendingEventCount < 0 || input.QuarantinedEventCount < 0 {
		return Connector{}, validation("invalid heartbeat")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	for _, h := range input.Assignments {
		if h.AppliedConfigurationVersion < 0 || (h.State != "connecting" && h.State != "connected" && h.State != "disconnected" && h.State != "degraded" && h.State != "disabled") {
			return Connector{}, validation("invalid assignment health")
		}
		if err = q.UpdateAssignmentRuntime(ctx, db.UpdateAssignmentRuntimeParams{AppliedConfigurationVersion: h.AppliedConfigurationVersion, RuntimeState: &h.State, RuntimeErrorCode: h.ErrorCode, ID: h.AssignmentID, ConnectorID: connector.ID}); err != nil {
			return Connector{}, err
		}
	}
	row, err := q.RecordHeartbeat(ctx, db.RecordHeartbeatParams{SoftwareVersion: &input.SoftwareVersion, ProtocolVersion: int32Pointer(input.ProtocolVersion), AppliedConfigurationRevision: input.AppliedConfigurationRevision, HealthState: &input.HealthState, HealthSummary: input.HealthSummary, PendingEventCount: input.PendingEventCount, QuarantinedEventCount: input.QuarantinedEventCount, ID: connector.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.New(403, "printer_connector_inactive", "Connector is not active")
	}
	if err != nil {
		return Connector{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return connectorFrom(row), nil
}

func int32Pointer(value int) *int32 { v := int32(value); return &v }

func (s *Service) IngestEvents(ctx context.Context, connector Context, inputs []EventInput) ([]EventReceipt, error) {
	if connector.Lifecycle != "active" {
		return nil, apperror.New(403, "printer_connector_inactive", "Connector is not active")
	}
	if len(inputs) == 0 || len(inputs) > 20 {
		return nil, validation("events must contain between 1 and 20 items")
	}
	seen := map[uuid.UUID]struct{}{}
	receipts := make([]EventReceipt, 0, len(inputs))
	for _, input := range inputs {
		if _, duplicate := seen[input.EventID]; duplicate {
			reason := "duplicate_event_in_batch"
			receipts = append(receipts, EventReceipt{EventID: input.EventID, Status: "rejected", ReasonCode: &reason})
			continue
		}
		seen[input.EventID] = struct{}{}
		receipt := s.ingestOne(ctx, connector, input)
		receipts = append(receipts, receipt)
	}
	return receipts, nil
}

func (s *Service) ingestOne(ctx context.Context, connector Context, input EventInput) EventReceipt {
	rejected := func(code string) EventReceipt {
		return EventReceipt{EventID: input.EventID, Status: "rejected", ReasonCode: &code}
	}
	if input.EventID == uuid.Nil || input.AssignmentID == uuid.Nil || input.ConfigurationVersion < 1 || input.Sequence < 1 || input.OccurredAt.IsZero() || input.OccurredAt.After(time.Now().UTC().Add(5*time.Minute)) || len(input.Payload) > 32768 {
		return rejected("invalid_event")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		code := "temporarily_unavailable"
		return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
	}
	defer tx.Rollback(ctx)
	a, err := db.New(tx).GetAssignmentForIngress(ctx, db.GetAssignmentForIngressParams{ID: input.AssignmentID, ConnectorID: connector.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return rejected("assignment_not_found")
	}
	if err != nil {
		code := "temporarily_unavailable"
		return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
	}
	applicationState, reason := "applied", (*string)(nil)
	if a.EndedAt.Valid || a.ConnectorLifecycle != "active" || !a.Enabled {
		applicationState = "review_required"
		v := "stale_assignment"
		reason = &v
	} else if input.ConfigurationVersion != a.ConfigurationVersion {
		applicationState = "review_required"
		v := "configuration_version_mismatch"
		reason = &v
	}
	var run db.MachineRun
	runDeleted := false
	if input.RunID != nil {
		state, stateErr := recordedRunState(input.Kind, input.Payload)
		if stateErr != nil {
			return rejected("invalid_event")
		}
		// Lock the run's job before the run, the order of every job operation.
		// An unknown run is created below and needs no lock.
		if _, _, lockErr := machinelogbook.LockRunChain(ctx, tx, *input.RunID); lockErr != nil && !apperror.IsCode(lockErr, "not_found") {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
		var runErr error
		run, runErr = recordObservedRun(ctx, db.New(tx), *input.RunID, a.ID, a.MachineID, input.ExternalPrintID, state, input.HistoryComplete, input.OccurredAt)
		if errors.Is(runErr, pgx.ErrNoRows) {
			return rejected("observed_run_conflict")
		}
		if errors.Is(runErr, errRunDeleted) {
			// Staff deleted the run. The event is stored for idempotency but
			// never resurrects or changes the run.
			runDeleted = true
			applicationState = "recorded"
			v := "run_deleted"
			reason = &v
			runErr = nil
		}
		if runErr != nil {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
		if !runDeleted && !run.HistoryComplete && applicationState == "applied" {
			applicationState = "review_required"
			v := "incomplete_run_history"
			reason = &v
		}
	}
	event, inserted, err := s.printing.IngestConnectorEvent(ctx, tx, printing.ConnectorEventInput{EventID: input.EventID, ConnectorID: connector.ID, AssignmentID: a.ID, MachineID: a.MachineID, RunID: input.RunID, ConfigurationVersion: input.ConfigurationVersion, Sequence: input.Sequence, Kind: input.Kind, OccurredAt: input.OccurredAt, ExternalPrintID: input.ExternalPrintID, Payload: input.Payload, ReportRevision: input.ReportRevision, ApplicationState: applicationState, ApplicationReason: reason})
	if err != nil {
		if apperror.IsCode(err, "printer_event_mismatch") || apperror.IsCode(err, "printer_event_sequence_conflict") || apperror.IsCode(err, "validation_failed") {
			return rejected(apperrorCode(err))
		}
		code := "temporarily_unavailable"
		return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
	}
	if inserted && input.RunID != nil && !runDeleted {
		if err = applyPrintFacts(ctx, db.New(tx), run, event.ID, input.Kind, input.Payload, input.OccurredAt, input.ReportRevision); err != nil {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
		// The recorded run's outcome, material usage and job price follow the
		// event in the same transaction.
		if err = s.logbook.ApplyRecordedRunEvent(ctx, tx, machinelogbook.RecordedRunEvent{RunID: run.ID, ConnectorID: connector.ID, Kind: input.Kind}); err != nil {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
	}
	if inserted && input.Kind == "printer_error" {
		if err = applyPrinterError(ctx, db.New(tx), a.MachineID, a.ID, input.RunID, input.Payload, input.OccurredAt); err != nil {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
	}
	if inserted && input.Kind == "slot_observation" && applicationState == "applied" && isBambuLANAdapter(a.AdapterKind) && bambuAutoDetectSpools(a.Settings) {
		if err = reconcileBambuSlotObservation(ctx, tx, connector.ID, a.ID, a.MachineID, event.ID, input.Payload, input.OccurredAt); err != nil {
			code := "temporarily_unavailable"
			return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		code := "temporarily_unavailable"
		return EventReceipt{EventID: input.EventID, Status: "retry", ReasonCode: &code}
	}
	status := "accepted"
	if !inserted {
		status = "duplicate"
	}
	id := event.ID
	return EventReceipt{EventID: input.EventID, CoreEventID: &id, Status: status}
}

func isBambuLANAdapter(kind string) bool {
	return kind == "bambu_h2d" || kind == "bambu_x1c"
}

func applyPrinterError(ctx context.Context, q *db.Queries, machineID, assignmentID uuid.UUID, runID *uuid.UUID, payload json.RawMessage, observedAt time.Time) error {
	var value struct {
		Transition   string `json:"transition"`
		SourceFamily string `json:"sourceFamily"`
		Code         string `json:"code"`
	}
	if json.Unmarshal(payload, &value) != nil {
		return nil
	}
	value.Transition = strings.TrimSpace(value.Transition)
	value.SourceFamily = strings.TrimSpace(value.SourceFamily)
	value.Code = strings.TrimSpace(value.Code)
	if (value.Transition != "appeared" && value.Transition != "cleared") || value.SourceFamily == "" || len(value.SourceFamily) > 80 || value.Code == "" || len(value.Code) > 120 {
		return nil
	}
	if value.Transition == "cleared" {
		return q.ResolvePrinterErrorOccurrence(ctx, db.ResolvePrinterErrorOccurrenceParams{AssignmentID: assignmentID, SourceFamily: value.SourceFamily, OriginalCode: value.Code, ObservedAt: observedAt.UTC()})
	}
	return q.UpsertPrinterErrorOccurrence(ctx, db.UpsertPrinterErrorOccurrenceParams{ID: uuid.Must(uuid.NewV7()), MachineID: machineID, AssignmentID: assignmentID, RunID: runID, SourceFamily: value.SourceFamily, OriginalCode: value.Code, ObservedAt: observedAt.UTC(), Context: json.RawMessage(`{}`)})
}

func recordedRunState(kind string, payload json.RawMessage) (string, error) {
	switch kind {
	case "progress":
		return "running", nil
	case "terminal_outcome":
		var value struct {
			Outcome string `json:"outcome"`
		}
		if json.Unmarshal(payload, &value) != nil {
			return "", errors.New("invalid terminal outcome")
		}
		switch value.Outcome {
		case "completed":
			return "finished", nil
		case "failed", "cancelled", "unknown":
			return value.Outcome, nil
		default:
			return "", errors.New("invalid terminal outcome")
		}
	case "operational_state":
		var value struct {
			State string `json:"state"`
		}
		if json.Unmarshal(payload, &value) == nil && value.State == "printing" {
			return "running", nil
		}
	}
	return "running", nil
}

func apperrorCode(err error) string {
	for _, code := range []string{"printer_event_mismatch", "printer_event_sequence_conflict", "validation_failed"} {
		if apperror.IsCode(err, code) {
			return code
		}
	}
	return "invalid_event"
}

func databaseError(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), "unique") || strings.Contains(err.Error(), "duplicate") {
		return conflict("printer_connector_conflict", "Connector identity or assignment already exists")
	}
	if strings.Contains(err.Error(), "foreign key") {
		return apperror.NotFound
	}
	return err
}
