package machinelogbook

import (
	"context"
	"errors"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ListMachineTypes(ctx context.Context, p authorization.Principal) ([]MachineType, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return nil, err
	}
	rows, err := machinelogbookdb.New(s.pool).ListMachineTypes(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]MachineType, 0, len(rows))
	for _, row := range rows {
		items = append(items, machineTypeFromRow(row))
	}
	return items, nil
}

func (s *Service) CreateMachineType(
	ctx context.Context,
	p authorization.Principal,
	name, process string,
	requestID *uuid.UUID,
) (MachineType, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return MachineType{}, err
	}
	name, err := validateName(name)
	if err != nil {
		return MachineType{}, err
	}
	if !validProcess(process) {
		return MachineType{}, apperror.Invalid("invalid machine process")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineType{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := ids.New()
	row, err := machinelogbookdb.New(tx).
		CreateMachineType(ctx, machinelogbookdb.CreateMachineTypeParams{ID: id, Name: name, Process: process})
	if err != nil {
		return MachineType{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_type.created",
		"machine_type",
		id,
		requestID,
		[]string{"name", "process"},
	); err != nil {
		return MachineType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineType{}, err
	}
	return machineTypeFromRow(row), nil
}

func (s *Service) UpdateMachineType(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	name *string,
	active *bool,
	process *string,
	requestID *uuid.UUID,
) (MachineType, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return MachineType{}, err
	}
	if expected < 1 {
		return MachineType{}, apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineType{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineTypeForUpdate(ctx, id)
	if err != nil {
		return MachineType{}, noRows(err)
	}
	if current.Version != expected {
		return MachineType{}, apperror.StaleWrite
	}
	if name != nil {
		current.Name, err = validateName(*name)
		if err != nil {
			return MachineType{}, err
		}
	}
	if active != nil {
		current.Active = *active
	}
	if process != nil {
		if !validProcess(*process) {
			return MachineType{}, apperror.Invalid("invalid machine process")
		}
		current.Process = *process
	}
	row, err := q.UpdateMachineType(
		ctx,
		machinelogbookdb.UpdateMachineTypeParams{
			Name:            current.Name,
			Active:          current.Active,
			Process:         current.Process,
			ID:              id,
			ExpectedVersion: expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineType{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineType{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_type.updated",
		"machine_type",
		id,
		requestID,
		[]string{"name", "active", "process"},
	); err != nil {
		return MachineType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineType{}, err
	}
	return machineTypeFromRow(row), nil
}

func validateMachine(status MachineStatus, automatic bool, external *string) error {
	if status != MachineStatusActive && status != MachineStatusMaintenance && status != MachineStatusRetired {
		return apperror.Invalid("invalid machine status")
	}
	if optional.Trimmed(external) != nil && !automatic {
		return apperror.Invalid("externalIdentifier requires automatic collection")
	}
	return nil
}

func machineFromGet(row machinelogbookdb.GetMachineRow) Machine {
	return Machine{
		ID: row.ID,
		MachineType: MachineType{
			ID:        row.MachineTypeID,
			Name:      row.MachineTypeName,
			Active:    row.MachineTypeActive,
			Process:   row.MachineTypeProcess,
			Version:   row.MachineTypeVersion,
			CreatedAt: row.MachineTypeCreatedAt,
			UpdatedAt: row.MachineTypeUpdatedAt,
		},
		Name:                       row.Name,
		Status:                     MachineStatus(row.Status),
		ExternalIdentifier:         row.ExternalIdentifier,
		AutomaticCollectionEnabled: row.AutomaticCollectionEnabled,
		LastIngestedAt:             nullableTime(row.LastIngestedAt),
		Version:                    row.Version,
		JobCount:                   row.JobCount,
		RuntimeSeconds:             row.RuntimeSeconds,
		FailureRate:                decimalString(row.FailureRate),
		CreatedAt:                  row.CreatedAt,
		UpdatedAt:                  row.UpdatedAt,
	}
}

func machineFromList(row machinelogbookdb.ListMachinesRow) Machine {
	return Machine{
		ID: row.ID,
		MachineType: MachineType{
			ID:        row.MachineTypeID,
			Name:      row.MachineTypeName,
			Active:    row.MachineTypeActive,
			Process:   row.MachineTypeProcess,
			Version:   row.MachineTypeVersion,
			CreatedAt: row.MachineTypeCreatedAt,
			UpdatedAt: row.MachineTypeUpdatedAt,
		},
		Name:                       row.Name,
		Status:                     MachineStatus(row.Status),
		ExternalIdentifier:         row.ExternalIdentifier,
		AutomaticCollectionEnabled: row.AutomaticCollectionEnabled,
		LastIngestedAt:             nullableTime(row.LastIngestedAt),
		Version:                    row.Version,
		JobCount:                   row.JobCount,
		RuntimeSeconds:             row.RuntimeSeconds,
		FailureRate:                decimalString(row.FailureRate),
		CreatedAt:                  row.CreatedAt,
		UpdatedAt:                  row.UpdatedAt,
	}
}

func (s *Service) GetMachine(ctx context.Context, p authorization.Principal, id uuid.UUID) (Machine, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return Machine{}, err
	}
	return s.loadMachine(ctx, id)
}

func (s *Service) loadMachine(ctx context.Context, id uuid.UUID) (Machine, error) {
	row, err := machinelogbookdb.New(s.pool).GetMachine(ctx, id)
	if err != nil {
		return Machine{}, noRows(err)
	}
	return machineFromGet(row), nil
}

func (s *Service) ListMachines(
	ctx context.Context,
	p authorization.Principal,
	search string,
	status *string,
	page, pageSize int,
) ([]Machine, int64, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(page, pageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListMachines(
		ctx,
		machinelogbookdb.ListMachinesParams{
			Search:     strings.TrimSpace(search),
			Status:     status,
			PageOffset: offset,
			PageLimit:  limit,
		},
	)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountMachines(
		ctx,
		machinelogbookdb.CountMachinesParams{Search: strings.TrimSpace(search), Status: status},
	)
	if err != nil {
		return nil, 0, err
	}
	items := make([]Machine, 0, len(rows))
	for _, row := range rows {
		items = append(items, machineFromList(row))
	}
	return items, total, nil
}

func (s *Service) CreateMachine(
	ctx context.Context,
	p authorization.Principal,
	machineTypeID uuid.UUID,
	name string,
	status MachineStatus,
	external *string,
	automatic bool,
	requestID *uuid.UUID,
) (Machine, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Machine{}, err
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return Machine{}, err
	}
	external = optional.Trimmed(external)
	if err = validateMachine(status, automatic, external); err != nil {
		return Machine{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Machine{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	typeRow, err := q.GetMachineType(ctx, machineTypeID)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if !typeRow.Active {
		return Machine{}, apperror.Conflicting("machine_type_inactive", "Machine type is inactive")
	}
	id := ids.New()
	_, err = q.CreateMachine(
		ctx,
		machinelogbookdb.CreateMachineParams{
			ID:                         id,
			MachineTypeID:              machineTypeID,
			Name:                       name,
			Status:                     string(status),
			ExternalIdentifier:         external,
			AutomaticCollectionEnabled: automatic,
		},
	)
	if err != nil {
		return Machine{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine.created",
		"machine",
		id,
		requestID,
		[]string{"machineTypeId", "name", "status", "externalIdentifier", "automaticCollectionEnabled"},
	); err != nil {
		return Machine{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Machine{}, err
	}
	return s.loadMachine(ctx, id)
}

func (s *Service) UpdateMachine(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	machineTypeID uuid.UUID,
	name string,
	status MachineStatus,
	external *string,
	automatic bool,
	requestID *uuid.UUID,
) (Machine, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Machine{}, err
	}
	if expected < 1 {
		return Machine{}, apperror.Invalid("expectedVersion must be positive")
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return Machine{}, err
	}
	external = optional.Trimmed(external)
	if err = validateMachine(status, automatic, external); err != nil {
		return Machine{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Machine{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineForUpdate(ctx, id)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if current.Version != expected {
		return Machine{}, apperror.StaleWrite
	}
	typeRow, err := q.GetMachineType(ctx, machineTypeID)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if !typeRow.Active && machineTypeID != current.MachineTypeID {
		return Machine{}, apperror.Conflicting("machine_type_inactive", "Machine type is inactive")
	}
	_, err = q.UpdateMachine(
		ctx,
		machinelogbookdb.UpdateMachineParams{
			MachineTypeID:              machineTypeID,
			Name:                       name,
			Status:                     string(status),
			ExternalIdentifier:         external,
			AutomaticCollectionEnabled: automatic,
			ID:                         id,
			ExpectedVersion:            expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Machine{}, apperror.StaleWrite
	}
	if err != nil {
		return Machine{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine.updated",
		"machine",
		id,
		requestID,
		[]string{"machineTypeId", "name", "status", "externalIdentifier", "automaticCollectionEnabled"},
	); err != nil {
		return Machine{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Machine{}, err
	}
	return s.loadMachine(ctx, id)
}

// DeleteMachine permanently deletes a machine that has no jobs or runs, with
// its printer setup, connector assignments, diagnostics and the tombstones of
// its deleted jobs and runs. Machines with history are retired instead.
func (s *Service) DeleteMachine(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.MachinesManage); err != nil {
		return err
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineForUpdate(ctx, id)
	if err != nil {
		return noRows(err)
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	connected, err := q.MachineHasConnectorAssignments(ctx, id)
	if err != nil {
		return err
	}
	if connected {
		if err = require(p, authorization.PrinterConnectorsManage); err != nil {
			return err
		}
	}
	inUse, err := q.MachineHasActiveWork(ctx, id)
	if err != nil {
		return err
	}
	if inUse {
		return apperror.Conflicting(
			"machine_in_use",
			"The machine has jobs or runs and cannot be deleted; retire it instead",
		)
	}
	mounted, err := q.MachineHasMountedSpool(ctx, id)
	if err != nil {
		return err
	}
	if mounted {
		return apperror.Conflicting(
			"machine_has_mounted_spools",
			"Unmount the spools of this machine before deleting it",
		)
	}
	// Order matters: runs go before printer events and assignments they reference.
	for _, step := range []func(context.Context, uuid.UUID) error{
		q.BumpConnectorsOfDeletedMachine,
		q.DeleteMachineErrorOccurrences,
		q.DeleteMachineRunsOfMachine,
		q.DeleteMachineJobsOfMachine,
		q.DeleteMachinePrinterEvents, q.DeleteMachineSpoolMountHistory, q.DeleteMachineConnectorAssignments,
	} {
		if err = step(ctx, id); err != nil {
			return databaseError(err)
		}
	}
	rows, err := q.DeleteMachine(ctx, machinelogbookdb.DeleteMachineParams{ID: id, ExpectedVersion: expected})
	if err != nil {
		return databaseError(err)
	}
	if rows == 0 {
		return apperror.StaleWrite
	}
	if err = writeAudit(ctx, tx, p, "machine.deleted", "machine", id, requestID, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
