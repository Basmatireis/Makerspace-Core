package manageddevices

import (
	"context"
	"encoding/base64"
	"errors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	manageddevicesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

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

func (s *Service) Update(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	name string,
	typeID uuid.UUID,
	expiresAt *time.Time,
	version int64,
	requestID *uuid.UUID,
) (Device, error) {
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
		AllowedApplicationModes: optional.ConvertSlice[ApplicationMode](current.AllowedAppModes),
		CheckInAssurance:        authorization.Assurance(current.CheckInAssurance),
		CheckOutAssurance:       authorization.Assurance(current.CheckOutAssurance),
		CheckoutMode:            CheckoutMode(current.CheckoutMode), Capabilities: capabilities,
	}, version, requestID)
}

func (s *Service) UpdateConfigured(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	name string,
	typeID uuid.UUID,
	expiresAt *time.Time,
	settings DeviceSettings,
	version int64,
	requestID *uuid.UUID,
) (Device, error) {
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
		return Device{}, apperror.InvalidField("expectedVersion must be positive")
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
	if isSignagePlayer(optional.ConvertSlice[ApplicationMode](current.AllowedAppModes)) {
		return Device{}, apperror.InvalidField("signage player devices are managed through signage displays")
	}
	now := time.Now().UTC()
	expirationUnchanged := (expiresAt == nil && !current.ExpiresAt.Valid) ||
		(expiresAt != nil && current.ExpiresAt.Valid && current.ExpiresAt.Time.Equal(*expiresAt))
	if current.ExpiresAt.Valid && !current.ExpiresAt.Time.After(now) && !expirationUnchanged {
		return Device{}, apperror.New(
			http.StatusConflict,
			"managed_device_rotation_required",
			"Rotate the token to reactivate an expired managed device",
		)
	}
	if expiresAt != nil && !expiresAt.After(now) && !expirationUnchanged {
		return Device{}, apperror.InvalidField("expiration must be in the future")
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
	_, err = q.UpdateManagedDevice(
		ctx,
		manageddevicesdb.UpdateManagedDeviceParams{ID: id, Name: name, DeviceTypeID: typeID,
			ExpiresAt: timestamp(
				expiresAt,
			), SessionPolicyID: settings.SessionPolicyID, TerminalEnabled: settings.TerminalEnabled,
			AllowedAppModes:  optional.ConvertSlice[string](settings.AllowedApplicationModes),
			CheckInAssurance: string(settings.CheckInAssurance), CheckOutAssurance: string(settings.CheckOutAssurance),
			CheckoutMode: string(settings.CheckoutMode), ExpectedVersion: version},
	)
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
		if err = q.AddDeviceCapability(
			ctx,
			manageddevicesdb.AddDeviceCapabilityParams{ManagedDeviceID: id, Capability: capability},
		); err != nil {
			return Device{}, err
		}
	}
	if !sameUUIDPointer(current.SessionPolicyID, settings.SessionPolicyID) ||
		current.TerminalEnabled != settings.TerminalEnabled ||
		!sameStringSet(optional.ConvertSlice[ApplicationMode](current.AllowedAppModes), settings.AllowedApplicationModes) {
		if err = q.RevokeSessionsForManagedDevice(ctx, &id); err != nil {
			return Device{}, err
		}
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "managed_device.updated",
			ResourceType:   "managed_device",
			ResourceID:     &id,
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
		},
	); err != nil {
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

func (s *Service) Delete(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	version int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return apperror.PermissionDenied
	}
	if version < 1 {
		return apperror.InvalidField("expectedVersion must be positive")
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
		return apperror.New(
			http.StatusConflict,
			"managed_device_not_revoked",
			"A managed device must be revoked before deletion",
		)
	}
	if _, err = q.DeleteManagedDevice(
		ctx,
		manageddevicesdb.DeleteManagedDeviceParams{ID: id, ExpectedVersion: version},
	); err != nil {
		return databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "managed_device.deleted",
			ResourceType:   "managed_device",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) Create(
	ctx context.Context,
	principal authorization.Principal,
	name string,
	typeID uuid.UUID,
	expiresAt *time.Time,
	requestID *uuid.UUID,
) (ProvisionedDevice, error) {
	return s.CreateConfigured(ctx, principal, name, typeID, expiresAt, DeviceSettings{
		AllowedApplicationModes: []ApplicationMode{
			ModeStaffUI,
		}, CheckInAssurance: authorization.AssuranceLow, CheckOutAssurance: authorization.AssuranceLow,
		CheckoutMode: CheckoutVerified,
	}, requestID)
}

func (s *Service) CreateConfigured(
	ctx context.Context,
	principal authorization.Principal,
	name string,
	typeID uuid.UUID,
	expiresAt *time.Time,
	settings DeviceSettings,
	requestID *uuid.UUID,
) (ProvisionedDevice, error) {
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
	row, err := q.CreateManagedDevice(
		ctx,
		manageddevicesdb.CreateManagedDeviceParams{ID: ids.New(), Name: name,
			DeviceTypeID:    typeID,
			TokenDigest:     digest,
			ExpiresAt:       timestamp(expiresAt),
			SessionPolicyID: settings.SessionPolicyID,
			TerminalEnabled: settings.TerminalEnabled, CheckInAssurance: string(settings.CheckInAssurance),
			AllowedAppModes:   optional.ConvertSlice[string](settings.AllowedApplicationModes),
			CheckOutAssurance: string(settings.CheckOutAssurance), CheckoutMode: string(settings.CheckoutMode)},
	)
	if err != nil {
		return ProvisionedDevice{}, databaseError(err)
	}
	for _, capability := range settings.Capabilities {
		if err = q.AddDeviceCapability(
			ctx,
			manageddevicesdb.AddDeviceCapabilityParams{ManagedDeviceID: row.ID, Capability: capability},
		); err != nil {
			return ProvisionedDevice{}, err
		}
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "managed_device.created",
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
		},
	); err != nil {
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

func (s *Service) Revoke(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	version int64,
	requestID *uuid.UUID,
) (Device, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return Device{}, apperror.PermissionDenied
	}
	if version < 1 {
		return Device{}, apperror.InvalidField("expectedVersion must be positive")
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
		return Device{}, apperror.New(
			http.StatusConflict,
			"managed_device_revoked",
			"The managed device is already revoked",
		)
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
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "managed_device.revoked",
			ResourceType:   "managed_device",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"revokedAt"},
		},
	); err != nil {
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

func (s *Service) Rotate(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	version int64,
	expiresAt *time.Time,
	requestID *uuid.UUID,
) (ProvisionedDevice, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return ProvisionedDevice{}, apperror.PermissionDenied
	}
	_, expiresAt, err := validateDevice("valid", expiresAt)
	if err != nil {
		return ProvisionedDevice{}, err
	}
	if version < 1 {
		return ProvisionedDevice{}, apperror.InvalidField("expectedVersion must be positive")
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
		return ProvisionedDevice{}, apperror.New(
			http.StatusConflict,
			"managed_device_revoked",
			"A revoked managed device cannot rotate its token",
		)
	}
	if isSignagePlayer(optional.ConvertSlice[ApplicationMode](current.AllowedAppModes)) {
		return ProvisionedDevice{}, apperror.InvalidField(
			"signage player devices cannot rotate their token; pair the display again",
		)
	}
	row, err := q.RotateManagedDeviceToken(
		ctx,
		manageddevicesdb.RotateManagedDeviceTokenParams{
			ID:              id,
			ExpectedVersion: version,
			TokenDigest:     digest,
			ExpiresAt:       timestamp(expiresAt),
		},
	)
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
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "managed_device.token_rotated",
			ResourceType:   "managed_device",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"expiresAt"},
		},
	); err != nil {
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

func deviceFromListRow(row manageddevicesdb.ListManagedDevicesRow) Device {
	return Device{ID: row.ID, Name: row.Name, DeviceTypeID: row.DeviceTypeID, DeviceTypeName: row.DeviceTypeName,
		ExpiresAt: timePointer(
			row.ExpiresAt,
		), RevokedAt: timePointer(row.RevokedAt), LastSeenAt: timePointer(row.LastSeenAt),
		SessionPolicyID:         row.SessionPolicyID,
		TerminalEnabled:         row.TerminalEnabled,
		CheckInAssurance:        authorization.Assurance(row.CheckInAssurance),
		AllowedApplicationModes: optional.ConvertSlice[ApplicationMode](row.AllowedAppModes),
		CheckOutAssurance:       authorization.Assurance(row.CheckOutAssurance), CheckoutMode: CheckoutMode(row.CheckoutMode),
		Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func deviceFromGetRow(row manageddevicesdb.GetManagedDeviceRow) Device {
	return Device{ID: row.ID, Name: row.Name, DeviceTypeID: row.DeviceTypeID, DeviceTypeName: row.DeviceTypeName,
		ExpiresAt: timePointer(
			row.ExpiresAt,
		), RevokedAt: timePointer(row.RevokedAt), LastSeenAt: timePointer(row.LastSeenAt),
		SessionPolicyID:         row.SessionPolicyID,
		TerminalEnabled:         row.TerminalEnabled,
		CheckInAssurance:        authorization.Assurance(row.CheckInAssurance),
		AllowedApplicationModes: optional.ConvertSlice[ApplicationMode](row.AllowedAppModes),
		CheckOutAssurance:       authorization.Assurance(row.CheckOutAssurance), CheckoutMode: CheckoutMode(row.CheckoutMode),
		Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
