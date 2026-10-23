package printerconnectors

import (
	"encoding/json"
	"net/netip"
	"regexp"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/localupdater"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
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

func NewService(
	pool *pgxpool.Pool,
	emitter machinelogbook.InboxEmitter,
	printingService *printing.Service,
	encryptionKeys [][]byte,
) (*Service, error) {
	var keyring *security.Keyring
	var err error
	if len(encryptionKeys) != 0 {
		keyring, err = security.NewKeyring(encryptionKeys)
		if err != nil {
			return nil, err
		}
	}
	return &Service{
		pool:     pool,
		printing: printingService,
		logbook:  machinelogbook.NewService(pool, emitter),
		keyring:  keyring,
	}, nil
}

type Connector struct {
	ID                                       uuid.UUID
	Name                                     string
	Lifecycle                                Lifecycle
	LocationLabel, SoftwareVersion           *string
	HealthState                              *HealthState
	HealthSummary                            *string
	ConfigurationRevision, AppliedRevision   int64
	PendingEventCount, QuarantinedEventCount int64
	ProtocolVersion                          *int
	LastHeartbeatAt, EnrolledAt, DisabledAt  *time.Time
	RevokedAt, EventsClearedAt               *time.Time
	EventsClearedByName                      *string
	UpdaterAvailable                         bool
	Update                                   *UpdateState
	Version                                  int64
	CreatedAt, UpdatedAt                     time.Time
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
	Name             string
	Lifecycle        Lifecycle
}

type Assignment struct {
	ID, ConnectorID, MachineID           uuid.UUID
	MachineName                          string
	AdapterKind                          AdapterKind
	AdapterSchemaVersion                 int
	Settings                             json.RawMessage
	EncryptedSecrets                     []byte
	ConfigurationVersion, AppliedVersion int64
	Enabled, PrinterEnabled              bool
	RuntimeState                         *AssignmentState
	RuntimeErrorCode                     *string
	ActivatedAt                          time.Time
	EndedAt                              *time.Time
	Version                              int64
	CreatedAt, UpdatedAt                 time.Time
}

type AssignmentInput struct {
	MachineID            uuid.UUID
	AdapterKind          AdapterKind
	AdapterSchemaVersion int
	Settings             json.RawMessage
	Secrets              map[string]string
	Enabled              bool
}

type AssignmentUpdate struct {
	AdapterKind          AdapterKind
	AdapterSchemaVersion int
	Settings             json.RawMessage
	Secrets              *map[string]string
	Enabled, End         bool
	ExpectedVersion      int64
}

type RuntimeAssignment struct {
	ID, MachineID        uuid.UUID
	MachineName          string
	AdapterKind          AdapterKind
	AdapterSchemaVersion int
	ConfigurationVersion int64
	Settings             json.RawMessage
	Secrets              map[string]string
	Enabled              bool
}

type Configuration struct {
	Revision        int64
	ProtocolVersion int
	Assignments     []RuntimeAssignment
	// Update is the open update request for the connector's updater, if any.
	Update *localupdater.Request
}

type AssignmentHealth struct {
	AssignmentID                uuid.UUID
	AppliedConfigurationVersion int64
	State                       AssignmentState
	ErrorCode                   *string
}

type Heartbeat struct {
	SoftwareVersion                          string
	HealthState                              HealthState
	ProtocolVersion                          int
	AppliedConfigurationRevision             int64
	HealthSummary                            *string
	PendingEventCount, QuarantinedEventCount int64
	Assignments                              []AssignmentHealth
	// Updater is nil for connectors without updater support.
	Updater *localupdater.Report
}

type EventInput struct {
	EventID, AssignmentID uuid.UUID
	RunID                 *uuid.UUID
	HistoryComplete       bool
	ConfigurationVersion  int64
	Sequence              int64
	OccurredAt            time.Time
	Kind                  printing.EventKind
	ExternalPrintID       *string
	ReportRevision        *int64
	Payload               json.RawMessage
}

type ObservedRun struct {
	ID, AssignmentID, MachineID     uuid.UUID
	MachineName                     string
	VendorJobID                     *string
	State                           RunState
	HistoryComplete                 bool
	FirstObservedAt, LastObservedAt time.Time
	Version                         int64
}

type ConnectorEvent struct {
	ID, MachineID, AssignmentID uuid.UUID
	Kind                        printing.EventKind
	OccurredAt, ReceivedAt      time.Time
	ApplicationState            printing.ApplicationState
	ApplicationReason           *string
	Payload                     json.RawMessage
}

type EventReceipt struct {
	EventID     uuid.UUID
	CoreEventID *uuid.UUID
	Status      ReceiptStatus
	ReasonCode  *string
	// NextSequence is the first sequence Core has not seen for the assignment,
	// sent with a sequence conflict so a connector that lost its local state
	// can renumber its pending events instead of quarantining them.
	NextSequence *int64
}

func nullableTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time.UTC()
	return &v
}

func validateAssignmentContract(
	kind AdapterKind,
	version int,
	settings json.RawMessage,
	secrets map[string]string,
	creating bool,
) (json.RawMessage, map[string]string, error) {
	if version != 1 {
		return nil, nil, apperror.Invalid("unsupported adapter schema version")
	}
	if len(settings) == 0 {
		settings = json.RawMessage(`{}`)
	}
	if len(settings) > 32768 {
		return nil, nil, apperror.Invalid("settings must be a bounded JSON object")
	}
	if !isBambuLANAdapter(kind) {
		var object map[string]any
		if json.Unmarshal(settings, &object) != nil || object == nil {
			return nil, nil, apperror.Invalid("settings must be a bounded JSON object")
		}
		return settings, secrets, nil
	}
	var value struct {
		IPAddress        string `json:"ipAddress"`
		SerialNumber     string `json:"serialNumber"`
		AutoDetectSpools bool   `json:"autoDetectSpools"`
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(settings, &value) != nil || json.Unmarshal(settings, &raw) != nil || len(raw) < 2 ||
		len(raw) > 3 {
		return nil, nil, apperror.Invalid(
			string(kind) + " settings require ipAddress, serialNumber, and optional autoDetectSpools",
		)
	}
	for key := range raw {
		if key != "ipAddress" && key != "serialNumber" && key != "autoDetectSpools" {
			return nil, nil, apperror.Invalid(string(kind) + " settings contain an unsupported field")
		}
	}
	if encoded, ok := raw["autoDetectSpools"]; ok {
		var enabled bool
		if json.Unmarshal(encoded, &enabled) != nil {
			return nil, nil, apperror.Invalid("autoDetectSpools must be a boolean")
		}
	}
	addr, err := netip.ParseAddr(strings.TrimSpace(value.IPAddress))
	if err != nil || !addr.Is4() || !addr.IsGlobalUnicast() && !addr.IsLinkLocalUnicast() {
		return nil, nil, apperror.Invalid("ipAddress must be an IPv4 unicast literal")
	}
	serial := strings.ToUpper(strings.TrimSpace(value.SerialNumber))
	if !bambuSerialPattern.MatchString(serial) {
		return nil, nil, apperror.Invalid("serialNumber must be an 8 to 32 character Bambu serial")
	}
	for key := range secrets {
		if key != "lanAccessCode" {
			return nil, nil, apperror.Invalid(string(kind) + " secrets contain only lanAccessCode")
		}
	}
	code := strings.TrimSpace(secrets["lanAccessCode"])
	if creating && code == "" {
		return nil, nil, apperror.Invalid("lanAccessCode is required")
	}
	if len(code) > 128 {
		return nil, nil, apperror.Invalid("lanAccessCode is invalid")
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
	return Connector{ID: row.ID, Name: row.Name, LocationLabel: row.LocationLabel, Lifecycle: Lifecycle(row.Lifecycle),
		ConfigurationRevision: row.ConfigurationRevision, AppliedRevision: row.AppliedConfigurationRevision,
		SoftwareVersion: row.SoftwareVersion, ProtocolVersion: protocol, HealthState: optional.Convert[HealthState](row.HealthState),
		HealthSummary:         row.HealthSummary,
		PendingEventCount:     row.PendingEventCount,
		QuarantinedEventCount: row.QuarantinedEventCount,
		LastHeartbeatAt: nullableTime(
			row.LastHeartbeatAt,
		), EnrolledAt: nullableTime(row.EnrolledAt), DisabledAt: nullableTime(row.DisabledAt),
		RevokedAt: nullableTime(
			row.RevokedAt,
		), EventsClearedAt: nullableTime(row.EventsClearedAt), UpdaterAvailable: row.UpdaterAvailable,
		Update: updateStateFrom(row), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return "", apperror.Invalid("name is required and limited to 120 characters")
	}
	return name, nil
}

func normalizeLocation(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	clean := strings.TrimSpace(*value)
	if clean == "" || len(clean) > 200 {
		return nil, apperror.Invalid("locationLabel must be non-empty and limited to 200 characters")
	}
	return &clean, nil
}
