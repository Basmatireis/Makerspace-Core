package manageddevices

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
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
	TerminalEnabled                  bool
	AllowedApplicationModes          []string
	CheckInAssurance                 string
	CheckOutAssurance                string
	CheckoutMode                     string
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
	ID                                                uuid.UUID
	Name                                              string
	DeviceTypeID                                      uuid.UUID
	DeviceTypeName                                    string
	ExpiresAt                                         *time.Time
	SessionPolicyID                                   *uuid.UUID
	TerminalEnabled                                   bool
	AllowedApplicationModes                           []string
	CheckInAssurance, CheckOutAssurance, CheckoutMode string
}

type DeviceSettings struct {
	SessionPolicyID         *uuid.UUID
	TerminalEnabled         bool
	AllowedApplicationModes []string
	CheckInAssurance        string
	CheckOutAssurance       string
	CheckoutMode            string
	Capabilities            []string
}

type SessionPolicy struct {
	ID                                          uuid.UUID
	Name                                        string
	IdleTimeoutSeconds, AbsoluteLifetimeSeconds int32
	PostSessionDestination                      string
	IsDefault                                   bool
	Version                                     int64
	CreatedAt, UpdatedAt                        time.Time
}

type SessionPolicyInput struct {
	Name                                        string
	IdleTimeoutSeconds, AbsoluteLifetimeSeconds int32
	PostSessionDestination                      string
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
	Platform, BridgeVersion string
	Capabilities            []string
}

type HardwareContext struct {
	DeviceID                                        uuid.UUID
	DeviceName                                      string
	TerminalEnabled                                 bool
	AllowedApplicationModes, ConfiguredCapabilities []string
	ReportedCapabilities, EffectiveCapabilities     []string
	SessionPolicyID                                 *uuid.UUID
	Platform, BridgeVersion                         *string
	ReportedAt                                      *time.Time
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Authenticate(ctx context.Context, raw string) (*DeviceContext, error) {
	decoded, decodeErr := base64.RawURLEncoding.DecodeString(raw)
	if decodeErr != nil || len(decoded) != 32 {
		return nil, nil
	}
	row, err := manageddevicesdb.New(s.pool).GetValidManagedDeviceByDigest(ctx, security.DigestToken(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = manageddevicesdb.New(s.pool).TouchManagedDevice(ctx, row.ID)
	return &DeviceContext{ID: row.ID, Name: row.Name, DeviceTypeID: row.DeviceTypeID, DeviceTypeName: row.DeviceTypeName,
		ExpiresAt: timePointer(row.ExpiresAt), SessionPolicyID: row.SessionPolicyID, TerminalEnabled: row.TerminalEnabled,
		AllowedApplicationModes: append([]string(nil), row.AllowedAppModes...),
		CheckInAssurance:        row.CheckInAssurance, CheckOutAssurance: row.CheckOutAssurance, CheckoutMode: row.CheckoutMode}, nil
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
		DeviceID: device.ID, DeviceName: device.Name, TerminalEnabled: device.TerminalEnabled,
		AllowedApplicationModes: append([]string(nil), device.AllowedApplicationModes...),
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
	result.Platform = &report.Platform
	result.BridgeVersion = &report.BridgeVersion
	reportedAt := report.ReportedAt.UTC()
	result.ReportedAt = &reportedAt
	return result, nil
}

func (s *Service) ReportHardware(ctx context.Context, device DeviceContext, report HardwareReport, requestID *uuid.UUID) (HardwareContext, error) {
	report.Platform = strings.TrimSpace(report.Platform)
	report.BridgeVersion = strings.TrimSpace(report.BridgeVersion)
	if report.Platform != "desktop" && report.Platform != "android" {
		return HardwareContext{}, validation("platform is invalid")
	}
	if report.BridgeVersion == "" || len([]rune(report.BridgeVersion)) > 40 {
		return HardwareContext{}, validation("bridgeVersion is required and limited to 40 characters")
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
		ManagedDeviceID: device.ID, Platform: report.Platform, BridgeVersion: report.BridgeVersion,
	}); err != nil {
		return HardwareContext{}, databaseError(err)
	}
	if err = q.ClearReportedDeviceCapabilities(ctx, device.ID); err != nil {
		return HardwareContext{}, err
	}
	for _, capability := range report.Capabilities {
		if err = q.AddReportedDeviceCapability(ctx, manageddevicesdb.AddReportedDeviceCapabilityParams{ManagedDeviceID: device.ID, Capability: capability}); err != nil {
			return HardwareContext{}, databaseError(err)
		}
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "unknown", Action: "managed_device.hardware_reported", ResourceType: "managed_device", ResourceID: &device.ID, RequestID: requestID, ChangedFields: []string{"platform", "bridgeVersion", "reportedCapabilities"}}); err != nil {
		return HardwareContext{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return HardwareContext{}, err
	}
	return s.GetHardwareContext(ctx, device)
}

func intersectCapabilities(configured, reported []string) []string {
	allowed := make(map[string]struct{}, len(configured))
	for _, capability := range configured {
		allowed[capability] = struct{}{}
	}
	result := make([]string, 0, len(reported))
	for _, capability := range reported {
		if _, ok := allowed[capability]; ok {
			result = append(result, capability)
		}
	}
	return result
}

func (s *Service) ListTypes(ctx context.Context, principal authorization.Principal) ([]DeviceType, error) {
	if !principal.Has(authorization.RolesRead) && !principal.Has(authorization.ManagedDevicesRead) && !principal.Has(authorization.VisitorEnrollmentManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := manageddevicesdb.New(s.pool).ListDeviceTypes(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]DeviceType, 0, len(rows))
	for _, row := range rows {
		result = append(result, typeFromRow(row))
	}
	return result, nil
}

func (s *Service) GetType(ctx context.Context, principal authorization.Principal, id uuid.UUID) (DeviceType, error) {
	if !principal.Has(authorization.RolesRead) && !principal.Has(authorization.ManagedDevicesRead) && !principal.Has(authorization.VisitorEnrollmentManage) {
		return DeviceType{}, apperror.PermissionDenied
	}
	row, err := manageddevicesdb.New(s.pool).GetDeviceType(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return DeviceType{}, apperror.NotFound
	}
	if err != nil {
		return DeviceType{}, err
	}
	return typeFromRow(row), nil
}

func (s *Service) List(ctx context.Context, principal authorization.Principal, limit int, cursor string) (Page, error) {
	if !principal.Has(authorization.ManagedDevicesRead) && !principal.Has(authorization.SessionPoliciesManage) {
		return Page{}, apperror.PermissionDenied
	}
	if limit < 1 || limit > 100 {
		return Page{}, invalidRequest("limit must be between 1 and 100")
	}
	if len(cursor) > 500 {
		return Page{}, invalidRequest("cursor is invalid")
	}
	rows, err := manageddevicesdb.New(s.pool).ListManagedDevices(ctx)
	if err != nil {
		return Page{}, err
	}
	start := 0
	if cursor != "" {
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(cursor)
		if decodeErr != nil {
			return Page{}, invalidRequest("cursor is invalid")
		}
		cursorID, parseErr := uuid.Parse(string(decoded))
		if parseErr != nil {
			return Page{}, invalidRequest("cursor is invalid")
		}
		found := false
		for index, row := range rows {
			if row.ID == cursorID {
				start, found = index+1, true
				break
			}
		}
		if !found {
			return Page{}, invalidRequest("cursor is invalid")
		}
	}
	end := min(start+limit, len(rows))
	items := make([]Device, 0, end-start)
	for _, row := range rows[start:end] {
		item := deviceFromListRow(row)
		item.Capabilities, err = manageddevicesdb.New(s.pool).ListDeviceCapabilities(ctx, row.ID)
		if err != nil {
			return Page{}, err
		}
		items = append(items, item)
	}
	var next *string
	if end < len(rows) && end > start {
		encoded := base64.RawURLEncoding.EncodeToString([]byte(rows[end-1].ID.String()))
		next = &encoded
	}
	return Page{Items: items, NextCursor: next}, nil
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Device, error) {
	if !principal.Has(authorization.ManagedDevicesRead) {
		return Device{}, apperror.PermissionDenied
	}
	row, err := manageddevicesdb.New(s.pool).GetManagedDevice(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, apperror.NotFound
	}
	if err != nil {
		return Device{}, err
	}
	item := deviceFromGetRow(row)
	item.Capabilities, err = manageddevicesdb.New(s.pool).ListDeviceCapabilities(ctx, id)
	if err != nil {
		return Device{}, err
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, principal authorization.Principal, id uuid.UUID, name string, typeID uuid.UUID, expiresAt *time.Time, version int64, requestID *uuid.UUID) (Device, error) {
	current, err := manageddevicesdb.New(s.pool).GetManagedDevice(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, apperror.NotFound
	}
	if err != nil {
		return Device{}, err
	}
	capabilities, err := manageddevicesdb.New(s.pool).ListDeviceCapabilities(ctx, id)
	if err != nil {
		return Device{}, err
	}
	return s.UpdateConfigured(ctx, principal, id, name, typeID, expiresAt, DeviceSettings{
		SessionPolicyID: current.SessionPolicyID, TerminalEnabled: current.TerminalEnabled,
		AllowedApplicationModes: append([]string(nil), current.AllowedAppModes...),
		CheckInAssurance:        current.CheckInAssurance, CheckOutAssurance: current.CheckOutAssurance,
		CheckoutMode: current.CheckoutMode, Capabilities: capabilities,
	}, version, requestID)
}

func (s *Service) UpdateConfigured(ctx context.Context, principal authorization.Principal, id uuid.UUID, name string, typeID uuid.UUID, expiresAt *time.Time, settings DeviceSettings, version int64, requestID *uuid.UUID) (Device, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return Device{}, apperror.PermissionDenied
	}
	name, err := validateDeviceName(name)
	if err != nil {
		return Device{}, err
	}
	settings, err = validateDeviceSettings(settings)
	if err != nil {
		return Device{}, err
	}
	if version < 1 {
		return Device{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Device{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	current, err := q.GetManagedDeviceForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, apperror.NotFound
	} else if err != nil {
		return Device{}, err
	}
	if current.Version != version {
		return Device{}, apperror.StaleWrite
	}
	now := time.Now().UTC()
	expirationUnchanged := (expiresAt == nil && !current.ExpiresAt.Valid) ||
		(expiresAt != nil && current.ExpiresAt.Valid && current.ExpiresAt.Time.Equal(*expiresAt))
	if current.ExpiresAt.Valid && !current.ExpiresAt.Time.After(now) && !expirationUnchanged {
		return Device{}, apperror.New(409, "managed_device_rotation_required", "Rotate the token to reactivate an expired managed device")
	}
	if expiresAt != nil && !expiresAt.After(now) && !expirationUnchanged {
		return Device{}, validation("expiration must be in the future")
	}
	if _, err = q.GetDeviceType(ctx, typeID); errors.Is(err, pgx.ErrNoRows) {
		return Device{}, apperror.NotFound
	} else if err != nil {
		return Device{}, err
	}
	if settings.SessionPolicyID != nil {
		if _, err = q.GetSessionPolicy(ctx, *settings.SessionPolicyID); errors.Is(err, pgx.ErrNoRows) {
			return Device{}, apperror.NotFound
		} else if err != nil {
			return Device{}, err
		}
	}
	_, err = q.UpdateManagedDevice(ctx, manageddevicesdb.UpdateManagedDeviceParams{ID: id, Name: name, DeviceTypeID: typeID,
		ExpiresAt: timestamp(expiresAt), SessionPolicyID: settings.SessionPolicyID, TerminalEnabled: settings.TerminalEnabled,
		AllowedAppModes:  settings.AllowedApplicationModes,
		CheckInAssurance: settings.CheckInAssurance, CheckOutAssurance: settings.CheckOutAssurance,
		CheckoutMode: settings.CheckoutMode, ExpectedVersion: version})
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, apperror.StaleWrite
	}
	if err != nil {
		return Device{}, databaseError(err)
	}
	if err = q.ClearDeviceCapabilities(ctx, id); err != nil {
		return Device{}, err
	}
	for _, capability := range settings.Capabilities {
		if err = q.AddDeviceCapability(ctx, manageddevicesdb.AddDeviceCapabilityParams{ManagedDeviceID: id, Capability: capability}); err != nil {
			return Device{}, err
		}
	}
	if !sameUUIDPointer(current.SessionPolicyID, settings.SessionPolicyID) || current.TerminalEnabled != settings.TerminalEnabled || !sameStringSet(current.AllowedAppModes, settings.AllowedApplicationModes) {
		if err = q.RevokeSessionsForManagedDevice(ctx, &id); err != nil {
			return Device{}, err
		}
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "managed_device.updated", ResourceType: "managed_device", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "deviceTypeId", "expiresAt", "sessionPolicyId", "terminalEnabled", "allowedApplicationModes", "attendancePolicy", "capabilities"}}); err != nil {
		return Device{}, err
	}
	view, err := q.GetManagedDevice(ctx, id)
	if err != nil {
		return Device{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Device{}, err
	}
	result := deviceFromGetRow(view)
	result.Capabilities = append([]string(nil), settings.Capabilities...)
	return result, nil
}

func (s *Service) Delete(ctx context.Context, principal authorization.Principal, id uuid.UUID, version int64, requestID *uuid.UUID) error {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return apperror.PermissionDenied
	}
	if version < 1 {
		return validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	current, err := q.GetManagedDeviceForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != version {
		return apperror.StaleWrite
	}
	if !current.RevokedAt.Valid {
		return apperror.New(409, "managed_device_not_revoked", "A managed device must be revoked before deletion")
	}
	if _, err = q.DeleteManagedDevice(ctx, manageddevicesdb.DeleteManagedDeviceParams{ID: id, ExpectedVersion: version}); err != nil {
		return err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "managed_device.deleted", ResourceType: "managed_device", ResourceID: &id, RequestID: requestID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Service) CreateType(ctx context.Context, principal authorization.Principal, name string, description *string, requestID *uuid.UUID) (DeviceType, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return DeviceType{}, apperror.PermissionDenied
	}
	name, description, err := validateType(name, description)
	if err != nil {
		return DeviceType{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DeviceType{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := manageddevicesdb.New(tx).CreateDeviceType(ctx, manageddevicesdb.CreateDeviceTypeParams{ID: uuid.Must(uuid.NewV7()), Name: name, Description: description})
	if err != nil {
		return DeviceType{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "device_type.created", ResourceType: "device_type", ResourceID: &row.ID, RequestID: requestID, ChangedFields: []string{"name", "description"}}); err != nil {
		return DeviceType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return DeviceType{}, err
	}
	return typeFromRow(row), nil
}
func (s *Service) Create(ctx context.Context, principal authorization.Principal, name string, typeID uuid.UUID, expiresAt *time.Time, requestID *uuid.UUID) (ProvisionedDevice, error) {
	return s.CreateConfigured(ctx, principal, name, typeID, expiresAt, DeviceSettings{
		AllowedApplicationModes: []string{"staff_ui"}, CheckInAssurance: "low", CheckOutAssurance: "low", CheckoutMode: "verified",
	}, requestID)
}

func (s *Service) CreateConfigured(ctx context.Context, principal authorization.Principal, name string, typeID uuid.UUID, expiresAt *time.Time, settings DeviceSettings, requestID *uuid.UUID) (ProvisionedDevice, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return ProvisionedDevice{}, apperror.PermissionDenied
	}
	name, expiresAt, err := validateDevice(name, expiresAt)
	if err != nil {
		return ProvisionedDevice{}, err
	}
	settings, err = validateDeviceSettings(settings)
	if err != nil {
		return ProvisionedDevice{}, err
	}
	token, digest, err := security.NewOpaqueToken()
	if err != nil {
		return ProvisionedDevice{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ProvisionedDevice{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	if _, err = q.GetDeviceType(ctx, typeID); errors.Is(err, pgx.ErrNoRows) {
		return ProvisionedDevice{}, apperror.NotFound
	} else if err != nil {
		return ProvisionedDevice{}, err
	}
	if settings.SessionPolicyID != nil {
		if _, err = q.GetSessionPolicy(ctx, *settings.SessionPolicyID); errors.Is(err, pgx.ErrNoRows) {
			return ProvisionedDevice{}, apperror.NotFound
		} else if err != nil {
			return ProvisionedDevice{}, err
		}
	}
	row, err := q.CreateManagedDevice(ctx, manageddevicesdb.CreateManagedDeviceParams{ID: uuid.Must(uuid.NewV7()), Name: name,
		DeviceTypeID: typeID, TokenDigest: digest, ExpiresAt: timestamp(expiresAt), SessionPolicyID: settings.SessionPolicyID,
		TerminalEnabled: settings.TerminalEnabled, CheckInAssurance: settings.CheckInAssurance,
		AllowedAppModes:   settings.AllowedApplicationModes,
		CheckOutAssurance: settings.CheckOutAssurance, CheckoutMode: settings.CheckoutMode})
	if err != nil {
		return ProvisionedDevice{}, databaseError(err)
	}
	for _, capability := range settings.Capabilities {
		if err = q.AddDeviceCapability(ctx, manageddevicesdb.AddDeviceCapabilityParams{ManagedDeviceID: row.ID, Capability: capability}); err != nil {
			return ProvisionedDevice{}, err
		}
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "managed_device.created", ResourceType: "managed_device", ResourceID: &row.ID, RequestID: requestID, ChangedFields: []string{"name", "deviceTypeId", "expiresAt", "sessionPolicyId", "terminalEnabled", "allowedApplicationModes", "attendancePolicy", "capabilities"}}); err != nil {
		return ProvisionedDevice{}, err
	}
	view, err := q.GetManagedDevice(ctx, row.ID)
	if err != nil {
		return ProvisionedDevice{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ProvisionedDevice{}, err
	}
	result := deviceFromGetRow(view)
	result.Capabilities = append([]string(nil), settings.Capabilities...)
	return ProvisionedDevice{Device: result, Token: token}, nil
}

func (s *Service) UpdateType(ctx context.Context, principal authorization.Principal, id uuid.UUID, version int64, name string, description *string, requestID *uuid.UUID) (DeviceType, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return DeviceType{}, apperror.PermissionDenied
	}
	name, description, err := validateType(name, description)
	if err != nil {
		return DeviceType{}, err
	}
	if version < 1 {
		return DeviceType{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DeviceType{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	if _, err = q.GetDeviceTypeForMutation(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return DeviceType{}, apperror.NotFound
	} else if err != nil {
		return DeviceType{}, err
	}
	row, err := q.UpdateDeviceType(ctx, manageddevicesdb.UpdateDeviceTypeParams{ID: id, ExpectedVersion: version, Name: name, Description: description})
	if errors.Is(err, pgx.ErrNoRows) {
		return DeviceType{}, apperror.StaleWrite
	}
	if err != nil {
		return DeviceType{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "device_type.updated", ResourceType: "device_type", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "description"}}); err != nil {
		return DeviceType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return DeviceType{}, err
	}
	return typeFromRow(row), nil
}
func (s *Service) DeleteType(ctx context.Context, principal authorization.Principal, id uuid.UUID, version int64, requestID *uuid.UUID) error {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return apperror.PermissionDenied
	}
	if version < 1 {
		return validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	if _, err = q.GetDeviceTypeForMutation(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	_, err = q.DeleteDeviceType(ctx, manageddevicesdb.DeleteDeviceTypeParams{ID: id, ExpectedVersion: version})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	}
	if err != nil {
		return databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "device_type.deleted", ResourceType: "device_type", ResourceID: &id, RequestID: requestID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Service) Revoke(ctx context.Context, principal authorization.Principal, id uuid.UUID, version int64, requestID *uuid.UUID) (Device, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return Device{}, apperror.PermissionDenied
	}
	if version < 1 {
		return Device{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Device{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	current, err := q.GetManagedDeviceForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, apperror.NotFound
	} else if err != nil {
		return Device{}, err
	}
	if current.Version != version {
		return Device{}, apperror.StaleWrite
	}
	if current.RevokedAt.Valid {
		return Device{}, apperror.New(409, "managed_device_revoked", "The managed device is already revoked")
	}
	_, err = q.RevokeManagedDevice(ctx, manageddevicesdb.RevokeManagedDeviceParams{ID: id, ExpectedVersion: version})
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, apperror.StaleWrite
	}
	if err != nil {
		return Device{}, err
	}
	if err = q.RevokeSessionsForManagedDevice(ctx, &id); err != nil {
		return Device{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "managed_device.revoked", ResourceType: "managed_device", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"revokedAt"}}); err != nil {
		return Device{}, err
	}
	view, err := q.GetManagedDevice(ctx, id)
	if err != nil {
		return Device{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Device{}, err
	}
	return deviceFromGetRow(view), nil
}
func (s *Service) Rotate(ctx context.Context, principal authorization.Principal, id uuid.UUID, version int64, expiresAt *time.Time, requestID *uuid.UUID) (ProvisionedDevice, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return ProvisionedDevice{}, apperror.PermissionDenied
	}
	_, expiresAt, err := validateDevice("valid", expiresAt)
	if err != nil {
		return ProvisionedDevice{}, err
	}
	if version < 1 {
		return ProvisionedDevice{}, validation("expectedVersion must be positive")
	}
	token, digest, err := security.NewOpaqueToken()
	if err != nil {
		return ProvisionedDevice{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ProvisionedDevice{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := manageddevicesdb.New(tx)
	current, err := q.GetManagedDeviceForMutation(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ProvisionedDevice{}, apperror.NotFound
	}
	if err != nil {
		return ProvisionedDevice{}, err
	}
	if current.Version != version {
		return ProvisionedDevice{}, apperror.StaleWrite
	}
	if current.RevokedAt.Valid {
		return ProvisionedDevice{}, apperror.New(409, "managed_device_revoked", "A revoked managed device cannot rotate its token")
	}
	row, err := q.RotateManagedDeviceToken(ctx, manageddevicesdb.RotateManagedDeviceTokenParams{ID: id, ExpectedVersion: version, TokenDigest: digest, ExpiresAt: timestamp(expiresAt)})
	if errors.Is(err, pgx.ErrNoRows) {
		return ProvisionedDevice{}, apperror.StaleWrite
	}
	if err != nil {
		return ProvisionedDevice{}, err
	}
	if err = q.RevokeSessionsForManagedDevice(ctx, &id); err != nil {
		return ProvisionedDevice{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "managed_device.token_rotated", ResourceType: "managed_device", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"expiresAt"}}); err != nil {
		return ProvisionedDevice{}, err
	}
	view, err := q.GetManagedDevice(ctx, row.ID)
	if err != nil {
		return ProvisionedDevice{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ProvisionedDevice{}, err
	}
	return ProvisionedDevice{Device: deviceFromGetRow(view), Token: token}, nil
}

func typeFromRow(row manageddevicesdb.DeviceType) DeviceType {
	return DeviceType{ID: row.ID, Name: row.Name, Description: row.Description, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func deviceFromListRow(row manageddevicesdb.ListManagedDevicesRow) Device {
	return Device{ID: row.ID, Name: row.Name, DeviceTypeID: row.DeviceTypeID, DeviceTypeName: row.DeviceTypeName,
		ExpiresAt: timePointer(row.ExpiresAt), RevokedAt: timePointer(row.RevokedAt), LastSeenAt: timePointer(row.LastSeenAt),
		SessionPolicyID: row.SessionPolicyID, TerminalEnabled: row.TerminalEnabled, CheckInAssurance: row.CheckInAssurance,
		AllowedApplicationModes: append([]string(nil), row.AllowedAppModes...),
		CheckOutAssurance:       row.CheckOutAssurance, CheckoutMode: row.CheckoutMode,
		Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func deviceFromGetRow(row manageddevicesdb.GetManagedDeviceRow) Device {
	return Device{ID: row.ID, Name: row.Name, DeviceTypeID: row.DeviceTypeID, DeviceTypeName: row.DeviceTypeName,
		ExpiresAt: timePointer(row.ExpiresAt), RevokedAt: timePointer(row.RevokedAt), LastSeenAt: timePointer(row.LastSeenAt),
		SessionPolicyID: row.SessionPolicyID, TerminalEnabled: row.TerminalEnabled, CheckInAssurance: row.CheckInAssurance,
		AllowedApplicationModes: append([]string(nil), row.AllowedAppModes...),
		CheckOutAssurance:       row.CheckOutAssurance, CheckoutMode: row.CheckoutMode,
		Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func policyFromRow(row manageddevicesdb.SessionPolicy) SessionPolicy {
	return SessionPolicy{ID: row.ID, Name: row.Name, IdleTimeoutSeconds: row.IdleTimeoutSeconds,
		AbsoluteLifetimeSeconds: row.AbsoluteLifetimeSeconds, PostSessionDestination: row.PostSessionDestination,
		IsDefault: row.IsDefault, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func (s *Service) ListSessionPolicies(ctx context.Context, principal authorization.Principal) ([]SessionPolicy, error) {
	if !principal.Has(authorization.ManagedDevicesRead) && !principal.Has(authorization.SessionPoliciesManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := manageddevicesdb.New(s.pool).ListSessionPolicies(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]SessionPolicy, 0, len(rows))
	for _, row := range rows {
		result = append(result, policyFromRow(row))
	}
	return result, nil
}

func validateSessionPolicy(input SessionPolicyInput) (SessionPolicyInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 120 {
		return input, validation("name is required and limited to 120 characters")
	}
	if input.IdleTimeoutSeconds < 60 || input.IdleTimeoutSeconds > 2592000 || input.AbsoluteLifetimeSeconds < 300 || input.AbsoluteLifetimeSeconds > 7776000 || input.IdleTimeoutSeconds > input.AbsoluteLifetimeSeconds {
		return input, validation("session lifetimes are invalid")
	}
	if input.PostSessionDestination != "login" && input.PostSessionDestination != "visitor_terminal" {
		return input, validation("postSessionDestination is invalid")
	}
	return input, nil
}

func (s *Service) CreateSessionPolicy(ctx context.Context, principal authorization.Principal, input SessionPolicyInput, requestID *uuid.UUID) (SessionPolicy, error) {
	if !principal.Has(authorization.SessionPoliciesManage) {
		return SessionPolicy{}, apperror.PermissionDenied
	}
	input, err := validateSessionPolicy(input)
	if err != nil {
		return SessionPolicy{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SessionPolicy{}, err
	}
	defer tx.Rollback(ctx)
	q := manageddevicesdb.New(tx)
	id := uuid.Must(uuid.NewV7())
	if input.IsDefault {
		previous, previousErr := q.GetDefaultSessionPolicy(ctx)
		if previousErr != nil && !errors.Is(previousErr, pgx.ErrNoRows) {
			return SessionPolicy{}, previousErr
		}
		if err = q.ClearDefaultSessionPolicy(ctx, id); err != nil {
			return SessionPolicy{}, err
		}
		if previousErr == nil {
			if err = q.RevokeSessionsForPolicy(ctx, &previous.ID); err != nil {
				return SessionPolicy{}, err
			}
		}
	}
	row, err := q.CreateSessionPolicy(ctx, manageddevicesdb.CreateSessionPolicyParams{ID: id, Name: input.Name,
		IdleTimeoutSeconds: input.IdleTimeoutSeconds, AbsoluteLifetimeSeconds: input.AbsoluteLifetimeSeconds,
		PostSessionDestination: input.PostSessionDestination, IsDefault: input.IsDefault})
	if err != nil {
		return SessionPolicy{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "session_policy.created", ResourceType: "session_policy", ResourceID: &id, RequestID: requestID}); err != nil {
		return SessionPolicy{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return SessionPolicy{}, err
	}
	return policyFromRow(row), nil
}

func (s *Service) UpdateSessionPolicy(ctx context.Context, principal authorization.Principal, id uuid.UUID, input SessionPolicyInput, requestID *uuid.UUID) (SessionPolicy, error) {
	if !principal.Has(authorization.SessionPoliciesManage) {
		return SessionPolicy{}, apperror.PermissionDenied
	}
	input, err := validateSessionPolicy(input)
	if err != nil {
		return SessionPolicy{}, err
	}
	if input.ExpectedVersion < 1 {
		return SessionPolicy{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SessionPolicy{}, err
	}
	defer tx.Rollback(ctx)
	q := manageddevicesdb.New(tx)
	current, err := q.GetSessionPolicy(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionPolicy{}, apperror.NotFound
	}
	if err != nil {
		return SessionPolicy{}, err
	}
	if current.Version != input.ExpectedVersion {
		return SessionPolicy{}, apperror.StaleWrite
	}
	if current.IsDefault && !input.IsDefault {
		return SessionPolicy{}, validation("the default policy can only be replaced by making another policy the default")
	}
	if input.IsDefault {
		previous, previousErr := q.GetDefaultSessionPolicy(ctx)
		if previousErr != nil && !errors.Is(previousErr, pgx.ErrNoRows) {
			return SessionPolicy{}, previousErr
		}
		if err = q.ClearDefaultSessionPolicy(ctx, id); err != nil {
			return SessionPolicy{}, err
		}
		if previousErr == nil && previous.ID != id {
			if err = q.RevokeSessionsForPolicy(ctx, &previous.ID); err != nil {
				return SessionPolicy{}, err
			}
		}
	}
	row, err := q.UpdateSessionPolicy(ctx, manageddevicesdb.UpdateSessionPolicyParams{ID: id, Name: input.Name,
		IdleTimeoutSeconds: input.IdleTimeoutSeconds, AbsoluteLifetimeSeconds: input.AbsoluteLifetimeSeconds,
		PostSessionDestination: input.PostSessionDestination, IsDefault: input.IsDefault, ExpectedVersion: input.ExpectedVersion})
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionPolicy{}, apperror.StaleWrite
	}
	if err != nil {
		return SessionPolicy{}, databaseError(err)
	}
	if err = q.RevokeSessionsForPolicy(ctx, &id); err != nil {
		return SessionPolicy{}, err
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "session_policy.updated", ResourceType: "session_policy", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "idleTimeoutSeconds", "absoluteLifetimeSeconds", "postSessionDestination", "isDefault"}}); err != nil {
		return SessionPolicy{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return SessionPolicy{}, err
	}
	return policyFromRow(row), nil
}

func sameUUIDPointer(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	values := make(map[string]struct{}, len(left))
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
		settings.AllowedApplicationModes = []string{"staff_ui"}
	}
	seenModes := map[string]bool{}
	for _, mode := range settings.AllowedApplicationModes {
		if (mode != "visitor_terminal" && mode != "staff_ui") || seenModes[mode] {
			return settings, validation("allowedApplicationModes must contain unique supported values")
		}
		seenModes[mode] = true
	}
	if settings.CheckInAssurance == "" {
		settings.CheckInAssurance = "low"
	}
	if settings.CheckOutAssurance == "" {
		settings.CheckOutAssurance = "low"
	}
	if settings.CheckoutMode == "" {
		settings.CheckoutMode = "verified"
	}
	validAssurance := func(v string) bool { return v == "low" || v == "normal" || v == "strong" || v == "strong_mfa" }
	if !validAssurance(settings.CheckInAssurance) || !validAssurance(settings.CheckOutAssurance) {
		return settings, validation("attendance assurance is invalid")
	}
	if settings.CheckoutMode != "verified" && settings.CheckoutMode != "public_tap" {
		return settings, validation("checkoutMode is invalid")
	}
	if err := validateCapabilities(settings.Capabilities); err != nil {
		return settings, err
	}
	if settings.TerminalEnabled && settings.SessionPolicyID == nil {
		return settings, validation("terminal-enabled devices require a session policy")
	}
	if settings.TerminalEnabled && !seenModes["visitor_terminal"] {
		return settings, validation("terminal-enabled devices must allow visitor_terminal mode")
	}
	return settings, nil
}

func validateCapabilities(capabilities []string) error {
	allowed := map[string]bool{"nfc": true, "camera": true, "qr": true, "barcode": true, "scale": true, "label_printer": true}
	seen := map[string]bool{}
	for _, value := range capabilities {
		if !allowed[value] || seen[value] {
			return validation("capabilities must be unique supported values")
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
		return "", nil, validation("device type name is invalid")
	}
	description = clean(description)
	if description != nil && len([]rune(*description)) > 500 {
		return "", nil, validation("description is too long")
	}
	return name, description, nil
}
func validateDevice(name string, expiresAt *time.Time) (string, *time.Time, error) {
	name, err := validateDeviceName(name)
	if err != nil {
		return "", nil, err
	}
	if expiresAt != nil && !expiresAt.After(time.Now().UTC()) {
		return "", nil, validation("expiration must be in the future")
	}
	return name, expiresAt, nil
}
func validateDeviceName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 100 {
		return "", validation("device name is invalid")
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
func validation(reason string) *apperror.Error {
	err := apperror.New(422, "validation_failed", "Request validation failed")
	err.Details["reason"] = reason
	return err
}
func invalidRequest(reason string) *apperror.Error {
	err := apperror.New(400, "invalid_request", "Request is invalid")
	err.Details["reason"] = reason
	return err
}
func databaseError(err error) error {
	var p *pgconn.PgError
	if errors.As(err, &p) && (p.Code == "23505" || p.Code == "23503") {
		return apperror.Conflict
	}
	return err
}
