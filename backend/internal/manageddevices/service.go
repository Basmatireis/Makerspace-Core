package manageddevices

import (
	"context"
	"encoding/base64"
	"errors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	manageddevicesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DeviceType struct {
	ID                   uuid.UUID
	Name                 string
	Description          *string
	Version              int64
	CreatedAt, UpdatedAt time.Time
}
type Device struct {
	ID                               uuid.UUID
	Name                             string
	DeviceTypeID                     uuid.UUID
	DeviceTypeName                   string
	ExpiresAt, RevokedAt, LastSeenAt *time.Time
	SessionPolicyID                  *uuid.UUID
	KioskEnabled                     bool
	AllowedApplicationModes          []ApplicationMode
	CheckInAssurance                 authorization.Assurance
	CheckOutAssurance                authorization.Assurance
	CheckoutMode                     CheckoutMode
	Capabilities                     []string
	Version                          int64
	CreatedAt, UpdatedAt             time.Time
}

type Status string

const (
	StatusActive  Status = "active"
	StatusExpired Status = "expired"
	StatusRevoked Status = "revoked"
)

func (d Device) Status(now time.Time) Status {
	if d.RevokedAt != nil {
		return StatusRevoked
	}
	if d.ExpiresAt != nil && !d.ExpiresAt.After(now.UTC()) {
		return StatusExpired
	}
	return StatusActive
}

type DeviceContext struct {
	ID                                  uuid.UUID
	Name                                string
	DeviceTypeID                        uuid.UUID
	DeviceTypeName                      string
	ExpiresAt                           *time.Time
	SessionPolicyID                     *uuid.UUID
	KioskEnabled                        bool
	AllowedApplicationModes             []ApplicationMode
	CheckInAssurance, CheckOutAssurance authorization.Assurance
	CheckoutMode                        CheckoutMode
}

type DeviceSettings struct {
	SessionPolicyID         *uuid.UUID
	KioskEnabled            bool
	AllowedApplicationModes []ApplicationMode
	CheckInAssurance        authorization.Assurance
	CheckOutAssurance       authorization.Assurance
	CheckoutMode            CheckoutMode
	Capabilities            []string
}

type SessionPolicy struct {
	ID                                          uuid.UUID
	Name                                        string
	IdleTimeoutSeconds, AbsoluteLifetimeSeconds int32
	PostSessionDestination                      Destination
	IsDefault                                   bool
	Version                                     int64
	CreatedAt, UpdatedAt                        time.Time
}

type SessionPolicyInput struct {
	Name                                        string
	IdleTimeoutSeconds, AbsoluteLifetimeSeconds int32
	PostSessionDestination                      Destination
	IsDefault                                   bool
	ExpectedVersion                             int64
}
type ProvisionedDevice struct {
	Device Device
	Token  string
}

type Page struct {
	Items      []Device
	NextCursor *string
}

type HardwareReport struct {
	Platform      Platform
	BridgeVersion string
	Capabilities  []string
}

type HardwareContext struct {
	DeviceID                                    uuid.UUID
	DeviceName                                  string
	KioskEnabled                                bool
	AllowedApplicationModes                     []ApplicationMode
	ConfiguredCapabilities                      []string
	ReportedCapabilities, EffectiveCapabilities []string
	SessionPolicyID                             *uuid.UUID
	Platform                                    *Platform
	BridgeVersion                               *string
	ReportedAt                                  *time.Time
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Authenticate(ctx context.Context, raw string) (*DeviceContext, error) {
	decoded, decodeErr := base64.RawURLEncoding.DecodeString(raw)
	if decodeErr != nil || len(decoded) != 32 {
		return nil, nil //nolint:nilerr // a malformed token is simply unauthenticated, not a server error
	}
	row, err := manageddevicesdb.New(s.pool).GetValidManagedDeviceByDigest(ctx, security.DigestToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = manageddevicesdb.New(s.pool).TouchManagedDevice(ctx, row.ID)
	return &DeviceContext{
		ID:             row.ID,
		Name:           row.Name,
		DeviceTypeID:   row.DeviceTypeID,
		DeviceTypeName: row.DeviceTypeName,
		ExpiresAt: timePointer(
			row.ExpiresAt,
		),
		SessionPolicyID:         row.SessionPolicyID,
		KioskEnabled:            row.TerminalEnabled,
		AllowedApplicationModes: optional.ConvertSlice[ApplicationMode](row.AllowedAppModes),
		CheckInAssurance:        authorization.Assurance(row.CheckInAssurance),
		CheckOutAssurance:       authorization.Assurance(row.CheckOutAssurance),
		CheckoutMode:            CheckoutMode(row.CheckoutMode),
	}, nil
}

func (s *Service) GetHardwareContext(ctx context.Context, device DeviceContext) (HardwareContext, error) {
	q := manageddevicesdb.New(s.pool)
	configured, err := q.ListDeviceCapabilities(ctx, device.ID)
	if err != nil {
		return HardwareContext{}, err
	}
	reported, err := q.ListReportedDeviceCapabilities(ctx, device.ID)
	if err != nil {
		return HardwareContext{}, err
	}
	result := HardwareContext{
		DeviceID: device.ID, DeviceName: device.Name, KioskEnabled: device.KioskEnabled,
		AllowedApplicationModes: append([]ApplicationMode(nil), device.AllowedApplicationModes...),
		SessionPolicyID:         device.SessionPolicyID, ConfiguredCapabilities: configured,
		ReportedCapabilities: reported, EffectiveCapabilities: intersectCapabilities(configured, reported),
	}
	report, err := q.GetManagedDeviceHardwareReport(ctx, device.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return HardwareContext{}, err
	}
	result.Platform = optional.Of(Platform(report.Platform))
	result.BridgeVersion = &report.BridgeVersion
	reportedAt := report.ReportedAt.UTC()
	result.ReportedAt = &reportedAt
	return result, nil
}

func (s *Service) ReportHardware(
	ctx context.Context,
	device DeviceContext,
	report HardwareReport,
	requestID *uuid.UUID,
) (HardwareContext, error) {
	report.Platform = Platform(strings.TrimSpace(string(report.Platform)))
	report.BridgeVersion = strings.TrimSpace(report.BridgeVersion)
	if report.Platform != PlatformDesktop && report.Platform != PlatformAndroid {
		return HardwareContext{}, apperror.InvalidField("platform is invalid")
	}
	if report.BridgeVersion == "" || len([]rune(report.BridgeVersion)) > 40 {
		return HardwareContext{}, apperror.InvalidField("bridgeVersion is required and limited to 40 characters")
	}
	if err := validateCapabilities(report.Capabilities); err != nil {
		return HardwareContext{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return HardwareContext{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	if _, err = q.GetManagedDeviceForMutation(ctx, device.ID); errors.Is(err, pgx.ErrNoRows) {
		return HardwareContext{}, apperror.Unauthenticated
	} else if err != nil {
		return HardwareContext{}, err
	}
	if err = q.UpsertManagedDeviceHardwareReport(ctx, manageddevicesdb.UpsertManagedDeviceHardwareReportParams{
		ManagedDeviceID: device.ID, Platform: string(report.Platform), BridgeVersion: report.BridgeVersion,
	}); err != nil {
		return HardwareContext{}, databaseError(err)
	}
	if err = q.ClearReportedDeviceCapabilities(ctx, device.ID); err != nil {
		return HardwareContext{}, err
	}
	for _, capability := range report.Capabilities {
		if err = q.AddReportedDeviceCapability(
			ctx,
			manageddevicesdb.AddReportedDeviceCapabilityParams{ManagedDeviceID: device.ID, Capability: capability},
		); err != nil {
			return HardwareContext{}, databaseError(err)
		}
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorType:     "unknown",
			Action:        "managed_device.hardware_reported",
			ResourceType:  "managed_device",
			ResourceID:    &device.ID,
			RequestID:     requestID,
			ChangedFields: []string{"platform", "bridgeVersion", "reportedCapabilities"},
		},
	); err != nil {
		return HardwareContext{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return HardwareContext{}, err
	}
	return s.GetHardwareContext(ctx, device)
}

// Capability values that other features depend on.
const (
	CapabilityCamera = "camera"
	// CapabilityFileUpload needs no hardware: it is the browser's file picker, so no native client can report it and
	// it is effective whenever an administrator configured it.
	CapabilityFileUpload = "file_upload"
)

func intersectCapabilities(configured, reported []string) []string {
	allowed := make(map[string]struct{}, len(configured))
	for _, capability := range configured {
		allowed[capability] = struct{}{}
	}
	result := make([]string, 0, len(reported)+1)
	for _, capability := range reported {
		if _, ok := allowed[capability]; ok && capability != CapabilityFileUpload {
			result = append(result, capability)
		}
	}
	if _, ok := allowed[CapabilityFileUpload]; ok {
		result = append(result, CapabilityFileUpload)
	}
	return result
}

// EffectiveCapabilities are the configured capabilities of a device narrowed by what its native client reported.
// A device that never reported (a plain browser) is trusted to match its configuration.
func (s *Service) EffectiveCapabilities(ctx context.Context, deviceID uuid.UUID) ([]string, error) {
	q := manageddevicesdb.New(s.pool)
	configured, err := q.ListDeviceCapabilities(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	if _, err := q.GetManagedDeviceHardwareReport(ctx, deviceID); errors.Is(err, pgx.ErrNoRows) {
		return configured, nil
	} else if err != nil {
		return nil, err
	}
	reported, err := q.ListReportedDeviceCapabilities(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	return intersectCapabilities(configured, reported), nil
}

func sameUUIDPointer(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func sameStringSet[T ~string](left, right []T) bool {
	if len(left) != len(right) {
		return false
	}
	values := make(map[T]struct{}, len(left))
	for _, value := range left {
		values[value] = struct{}{}
	}
	for _, value := range right {
		if _, ok := values[value]; !ok {
			return false
		}
	}
	return true
}

func validateDeviceSettings(settings DeviceSettings) (DeviceSettings, error) {
	if len(settings.AllowedApplicationModes) == 0 {
		settings.AllowedApplicationModes = []ApplicationMode{ModeStaffUI}
	}
	seenModes := map[ApplicationMode]bool{}
	for _, mode := range settings.AllowedApplicationModes {
		if mode == ModeSignagePlayer {
			return settings, apperror.InvalidField("signage player devices are created by pairing a signage display")
		}
		if (mode != ModeVisitorKiosk && mode != ModeStaffUI) || seenModes[mode] {
			return settings, apperror.InvalidField("allowedApplicationModes must contain unique supported values")
		}
		seenModes[mode] = true
	}
	if settings.CheckInAssurance == "" {
		settings.CheckInAssurance = authorization.AssuranceLow
	}
	if settings.CheckOutAssurance == "" {
		settings.CheckOutAssurance = authorization.AssuranceLow
	}
	if settings.CheckoutMode == "" {
		settings.CheckoutMode = CheckoutVerified
	}
	validAssurance := func(v authorization.Assurance) bool {
		return v == authorization.AssuranceLow || v == authorization.AssuranceNormal || v == authorization.AssuranceStrong ||
			v == authorization.AssuranceStrongMFA
	}
	if !validAssurance(settings.CheckInAssurance) || !validAssurance(settings.CheckOutAssurance) {
		return settings, apperror.InvalidField("attendance assurance is invalid")
	}
	if settings.CheckoutMode != CheckoutVerified && settings.CheckoutMode != CheckoutPublicTap {
		return settings, apperror.InvalidField("checkoutMode is invalid")
	}
	if err := validateCapabilities(settings.Capabilities); err != nil {
		return settings, err
	}
	if settings.KioskEnabled && settings.SessionPolicyID == nil {
		return settings, apperror.InvalidField("kiosk-enabled devices require a session policy")
	}
	if settings.KioskEnabled && !seenModes[ModeVisitorKiosk] {
		return settings, apperror.InvalidField("kiosk-enabled devices must allow visitor_terminal mode")
	}
	return settings, nil
}

func validateCapabilities(capabilities []string) error {
	allowed := map[string]bool{
		"nfc":                true,
		"camera":             true,
		"qr":                 true,
		"barcode":            true,
		"scale":              true,
		"label_printer":      true,
		CapabilityFileUpload: true,
	}
	seen := map[string]bool{}
	for _, value := range capabilities {
		if !allowed[value] || seen[value] {
			return apperror.InvalidField("capabilities must be unique supported values")
		}
		seen[value] = true
	}
	return nil
}
func timePointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time.UTC()
	return &v
}
func timestamp(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}
func validateType(name string, description *string) (string, *string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 100 {
		return "", nil, apperror.InvalidField("device type name is invalid")
	}
	description = clean(description)
	if description != nil && len([]rune(*description)) > 500 {
		return "", nil, apperror.InvalidField("description is too long")
	}
	return name, description, nil
}
func validateDevice(name string, expiresAt *time.Time) (string, *time.Time, error) {
	name, err := validateDeviceName(name)
	if err != nil {
		return "", nil, err
	}
	if expiresAt != nil && !expiresAt.After(time.Now().UTC()) {
		return "", nil, apperror.InvalidField("expiration must be in the future")
	}
	return name, expiresAt, nil
}
func validateDeviceName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 100 {
		return "", apperror.InvalidField("device name is invalid")
	}
	return name, nil
}
func clean(value *string) *string {
	if value == nil {
		return nil
	}
	v := strings.TrimSpace(*value)
	if v == "" {
		return nil
	}
	return &v
}
func invalidRequest(reason string) *apperror.Error {
	err := apperror.New(http.StatusBadRequest, "invalid_request", "Request is invalid")
	err.Details["reason"] = reason
	return err
}
func databaseError(err error) error {
	var p *pgconn.PgError
	if errors.As(err, &p) && (p.Code == "23505" || p.Code == "23503" || p.Code == "23001") {
		return apperror.Conflict
	}
	return err
}
