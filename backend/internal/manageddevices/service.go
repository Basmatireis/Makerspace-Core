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
	ID             uuid.UUID
	Name           string
	DeviceTypeID   uuid.UUID
	DeviceTypeName string
	ExpiresAt      *time.Time
}
type ProvisionedDevice struct {
	Device Device
	Token  string
}

type Page struct {
	Items      []Device
	NextCursor *string
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
	return &DeviceContext{ID: row.ID, Name: row.Name, DeviceTypeID: row.DeviceTypeID, DeviceTypeName: row.DeviceTypeName, ExpiresAt: timePointer(row.ExpiresAt)}, nil
}

func (s *Service) ListTypes(ctx context.Context, principal authorization.Principal) ([]DeviceType, error) {
	if !principal.Has(authorization.RolesRead) && !principal.Has(authorization.ManagedDevicesRead) {
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
	if !principal.Has(authorization.RolesRead) && !principal.Has(authorization.ManagedDevicesRead) {
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
	if !principal.Has(authorization.ManagedDevicesRead) {
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
		items = append(items, deviceFromListRow(row))
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
	return deviceFromGetRow(row), nil
}

func (s *Service) Update(ctx context.Context, principal authorization.Principal, id uuid.UUID, name string, typeID uuid.UUID, expiresAt *time.Time, version int64, requestID *uuid.UUID) (Device, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return Device{}, apperror.PermissionDenied
	}
	name, err := validateDeviceName(name)
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
	_, err = q.UpdateManagedDevice(ctx, manageddevicesdb.UpdateManagedDeviceParams{ID: id, Name: name, DeviceTypeID: typeID, ExpiresAt: timestamp(expiresAt), ExpectedVersion: version})
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, apperror.StaleWrite
	}
	if err != nil {
		return Device{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "managed_device.updated", ResourceType: "managed_device", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"name", "deviceTypeId", "expiresAt"}}); err != nil {
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
	if !principal.Has(authorization.ManagedDevicesManage) {
		return ProvisionedDevice{}, apperror.PermissionDenied
	}
	name, expiresAt, err := validateDevice(name, expiresAt)
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
	row, err := q.CreateManagedDevice(ctx, manageddevicesdb.CreateManagedDeviceParams{ID: uuid.Must(uuid.NewV7()), Name: name, DeviceTypeID: typeID, TokenDigest: digest, ExpiresAt: timestamp(expiresAt)})
	if err != nil {
		return ProvisionedDevice{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "managed_device.created", ResourceType: "managed_device", ResourceID: &row.ID, RequestID: requestID, ChangedFields: []string{"name", "deviceTypeId", "expiresAt"}}); err != nil {
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
	return Device{ID: row.ID, Name: row.Name, DeviceTypeID: row.DeviceTypeID, DeviceTypeName: row.DeviceTypeName, ExpiresAt: timePointer(row.ExpiresAt), RevokedAt: timePointer(row.RevokedAt), LastSeenAt: timePointer(row.LastSeenAt), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func deviceFromGetRow(row manageddevicesdb.GetManagedDeviceRow) Device {
	return Device{ID: row.ID, Name: row.Name, DeviceTypeID: row.DeviceTypeID, DeviceTypeName: row.DeviceTypeName, ExpiresAt: timePointer(row.ExpiresAt), RevokedAt: timePointer(row.RevokedAt), LastSeenAt: timePointer(row.LastSeenAt), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
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
