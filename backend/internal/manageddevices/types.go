package manageddevices

import (
	"context"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	manageddevicesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ListTypes(ctx context.Context, principal authorization.Principal) ([]DeviceType, error) {
	if !principal.Has(authorization.RolesRead) && !principal.Has(authorization.ManagedDevicesRead) &&
		!principal.Has(authorization.VisitorEnrollmentManage) {
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
	if !principal.Has(authorization.RolesRead) && !principal.Has(authorization.ManagedDevicesRead) &&
		!principal.Has(authorization.VisitorEnrollmentManage) {
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

func (s *Service) CreateType(
	ctx context.Context,
	principal authorization.Principal,
	name string,
	description *string,
	requestID *uuid.UUID,
) (DeviceType, error) {
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
	row, err := manageddevicesdb.New(tx).
		CreateDeviceType(
			ctx,
			manageddevicesdb.CreateDeviceTypeParams{ID: ids.New(), Name: name, Description: description},
		)
	if err != nil {
		return DeviceType{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "device_type.created",
			ResourceType:   "device_type",
			ResourceID:     &row.ID,
			RequestID:      requestID,
			ChangedFields:  []string{"name", "description"},
		},
	); err != nil {
		return DeviceType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return DeviceType{}, err
	}
	return typeFromRow(row), nil
}

func (s *Service) UpdateType(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	version int64,
	name string,
	description *string,
	requestID *uuid.UUID,
) (DeviceType, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return DeviceType{}, apperror.PermissionDenied
	}
	name, description, err := validateType(name, description)
	if err != nil {
		return DeviceType{}, err
	}
	if version < 1 {
		return DeviceType{}, apperror.InvalidField("expectedVersion must be positive")
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
	row, err := q.UpdateDeviceType(
		ctx,
		manageddevicesdb.UpdateDeviceTypeParams{ID: id, ExpectedVersion: version, Name: name, Description: description},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return DeviceType{}, apperror.StaleWrite
	}
	if err != nil {
		return DeviceType{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "device_type.updated",
			ResourceType:   "device_type",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"name", "description"},
		},
	); err != nil {
		return DeviceType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return DeviceType{}, err
	}
	return typeFromRow(row), nil
}

func (s *Service) DeleteType(
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
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "device_type.deleted",
			ResourceType:   "device_type",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func typeFromRow(row manageddevicesdb.DeviceType) DeviceType {
	return DeviceType{
		ID:          row.ID,
		Name:        row.Name,
		Description: row.Description,
		Version:     row.Version,
		CreatedAt:   row.CreatedAt,
		UpdatedAt:   row.UpdatedAt,
	}
}
