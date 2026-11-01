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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ListProcesses(ctx context.Context, p authorization.Principal) ([]Process, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return nil, err
	}
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListProcesses(ctx)
	if err != nil {
		return nil, err
	}
	processIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		processIDs = append(processIDs, row.ID)
	}
	measures, err := loadProcessMeasures(ctx, q, processIDs)
	if err != nil {
		return nil, err
	}
	items := make([]Process, 0, len(rows))
	for _, row := range rows {
		items = append(items, processFromRow(row, measures[row.ID]))
	}
	return items, nil
}

func (s *Service) CreateProcess(
	ctx context.Context,
	p authorization.Principal,
	name string,
	integration ProcessIntegration,
	measures []ProcessMeasure,
	requestID *uuid.UUID,
) (Process, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Process{}, err
	}
	var result Process
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.CreateProcessTx(ctx, tx, p, name, integration, measures, requestID)
		return err
	})
	return result, err
}

// CreateProcessTx is CreateProcess inside the caller's transaction; the configuration import uses it.
func (s *Service) CreateProcessTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	name string,
	integration ProcessIntegration,
	measures []ProcessMeasure,
	requestID *uuid.UUID,
) (Process, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Process{}, err
	}
	name, err := validateName(name)
	if err != nil {
		return Process{}, err
	}
	if !validIntegration(integration) {
		return Process{}, apperror.Invalid("invalid process integration")
	}
	measures, err = validateProcessMeasures(measures)
	if err != nil {
		return Process{}, err
	}
	id := ids.New()
	q := machinelogbookdb.New(tx)
	row, err := q.CreateProcess(
		ctx,
		machinelogbookdb.CreateProcessParams{ID: id, Name: name, Integration: string(integration)},
	)
	if err != nil {
		return Process{}, databaseError(err)
	}
	if err = storeProcessMeasures(ctx, q, id, measures); err != nil {
		return Process{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"process.created",
		"process",
		id,
		requestID,
		[]string{"name", "integration", "measures"},
	); err != nil {
		return Process{}, err
	}
	return processFromRow(row, measures), nil
}

// storeProcessMeasures replaces the stored measures of a process; the list order is kept.
func storeProcessMeasures(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	processID uuid.UUID,
	measures []ProcessMeasure,
) error {
	if err := q.ReplaceProcessMeasures(ctx, processID); err != nil {
		return err
	}
	for i, m := range measures {
		if err := q.InsertProcessMeasure(
			ctx,
			machinelogbookdb.InsertProcessMeasureParams{
				ProcessID: processID,
				Key:       m.Key,
				Label:     m.Label,
				Unit:      m.Unit,
				BlockSize: m.BlockSize,
				Position:  int32(i), //nolint:gosec // bounded by maxProcessMeasures
			},
		); err != nil {
			return databaseError(err)
		}
	}
	return nil
}

// requireMeasuresUnused refuses to drop a measure that pricing rules or runs still refer to.
func requireMeasuresUnused(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	processID uuid.UUID,
	current, next []ProcessMeasure,
) error {
	kept := map[string]bool{}
	for _, m := range next {
		kept[m.Key] = true
	}
	for _, m := range current {
		if kept[m.Key] {
			continue
		}
		uses, err := q.CountMeasureUses(ctx, machinelogbookdb.CountMeasureUsesParams{ProcessID: &processID, Key: &m.Key})
		if err != nil {
			return err
		}
		if uses > 0 {
			return apperror.Conflicting(
				"measure_in_use",
				"The measure \""+m.Label+"\" is used by pricing rules or runs and cannot be removed",
			)
		}
	}
	return nil
}

// ProcessChanges is the part of a process an update changes; nil fields stay as they are and non-nil Measures
// replace the whole list.
type ProcessChanges struct {
	Name        *string
	Active      *bool
	Integration *ProcessIntegration
	Measures    *[]ProcessMeasure
}

func (s *Service) UpdateProcess(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	changes ProcessChanges,
	requestID *uuid.UUID,
) (Process, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Process{}, err
	}
	var result Process
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdateProcessTx(ctx, tx, p, id, expected, changes, requestID)
		return err
	})
	return result, err
}

// UpdateProcessTx is UpdateProcess inside the caller's transaction; the configuration import uses it.
func (s *Service) UpdateProcessTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	changes ProcessChanges,
	requestID *uuid.UUID,
) (Process, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Process{}, err
	}
	if expected < 1 {
		return Process{}, apperror.Invalid("expectedVersion must be positive")
	}
	q := machinelogbookdb.New(tx)
	current, err := q.GetProcessForUpdate(ctx, id)
	if err != nil {
		return Process{}, noRows(err)
	}
	if current.Version != expected {
		return Process{}, apperror.StaleWrite
	}
	if changes.Name != nil {
		current.Name, err = validateName(*changes.Name)
		if err != nil {
			return Process{}, err
		}
	}
	if changes.Active != nil {
		current.Active = *changes.Active
	}
	if changes.Integration != nil {
		if !validIntegration(*changes.Integration) {
			return Process{}, apperror.Invalid("invalid process integration")
		}
		current.Integration = string(*changes.Integration)
	}
	stored, err := loadProcessMeasures(ctx, q, []uuid.UUID{id})
	if err != nil {
		return Process{}, err
	}
	measures := stored[id]
	if changes.Measures != nil {
		next, validationErr := validateProcessMeasures(*changes.Measures)
		if validationErr != nil {
			return Process{}, validationErr
		}
		if err = requireMeasuresUnused(ctx, q, id, measures, next); err != nil {
			return Process{}, err
		}
		measures = next
	}
	row, err := q.UpdateProcess(
		ctx,
		machinelogbookdb.UpdateProcessParams{
			Name:            current.Name,
			Active:          current.Active,
			Integration:     current.Integration,
			ID:              id,
			ExpectedVersion: expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Process{}, apperror.StaleWrite
	}
	if err != nil {
		return Process{}, databaseError(err)
	}
	if changes.Measures != nil {
		if err = storeProcessMeasures(ctx, q, id, measures); err != nil {
			return Process{}, err
		}
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"process.updated",
		"process",
		id,
		requestID,
		[]string{"name", "active", "integration", "measures"},
	); err != nil {
		return Process{}, err
	}
	return processFromRow(row, measures), nil
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
		Process: Process{
			ID:          row.ProcessID,
			Name:        row.ProcessName,
			Integration: ProcessIntegration(row.ProcessIntegration),
			Measures:    []ProcessMeasure{},
			Active:      row.ProcessActive,
			Version:     row.ProcessVersion,
			CreatedAt:   row.ProcessCreatedAt,
			UpdatedAt:   row.ProcessUpdatedAt,
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
	return machineFromGet(machinelogbookdb.GetMachineRow(row))
}

// attachProcessMeasures fills the measure lists of the processes embedded in the machines.
func attachProcessMeasures(ctx context.Context, q *machinelogbookdb.Queries, machines ...*Machine) error {
	processIDs := make([]uuid.UUID, 0, len(machines))
	for _, m := range machines {
		processIDs = append(processIDs, m.Process.ID)
	}
	measures, err := loadProcessMeasures(ctx, q, processIDs)
	if err != nil {
		return err
	}
	for _, m := range machines {
		if list := measures[m.Process.ID]; list != nil {
			m.Process.Measures = list
		}
	}
	return nil
}

func (s *Service) GetMachine(ctx context.Context, p authorization.Principal, id uuid.UUID) (Machine, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return Machine{}, err
	}
	return s.loadMachine(ctx, id)
}

func (s *Service) loadMachine(ctx context.Context, id uuid.UUID) (Machine, error) {
	return loadMachineFrom(ctx, machinelogbookdb.New(s.pool), id)
}

func loadMachineFrom(ctx context.Context, q *machinelogbookdb.Queries, id uuid.UUID) (Machine, error) {
	row, err := q.GetMachine(ctx, id)
	if err != nil {
		return Machine{}, noRows(err)
	}
	machine := machineFromGet(row)
	if err = attachProcessMeasures(ctx, q, &machine); err != nil {
		return Machine{}, err
	}
	return machine, nil
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
	pointers := make([]*Machine, len(items))
	for i := range items {
		pointers[i] = &items[i]
	}
	if err = attachProcessMeasures(ctx, q, pointers...); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

func (s *Service) CreateMachine(
	ctx context.Context,
	p authorization.Principal,
	processID uuid.UUID,
	name string,
	status MachineStatus,
	external *string,
	automatic bool,
	requestID *uuid.UUID,
) (Machine, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Machine{}, err
	}
	var result Machine
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.CreateMachineTx(ctx, tx, p, processID, name, status, external, automatic, requestID)
		return err
	})
	return result, err
}

// CreateMachineTx is CreateMachine inside the caller's transaction; the configuration import uses it.
func (s *Service) CreateMachineTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	processID uuid.UUID,
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
	q := machinelogbookdb.New(tx)
	processRow, err := q.GetProcess(ctx, processID)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if !processRow.Active {
		return Machine{}, apperror.Conflicting("process_inactive", "Process is inactive")
	}
	id := ids.New()
	_, err = q.CreateMachine(
		ctx,
		machinelogbookdb.CreateMachineParams{
			ID:                         id,
			ProcessID:                  processID,
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
		[]string{"processId", "name", "status", "externalIdentifier", "automaticCollectionEnabled"},
	); err != nil {
		return Machine{}, err
	}
	return loadMachineFrom(ctx, q, id)
}

func (s *Service) UpdateMachine(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	processID uuid.UUID,
	name string,
	status MachineStatus,
	external *string,
	automatic bool,
	requestID *uuid.UUID,
) (Machine, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Machine{}, err
	}
	var result Machine
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdateMachineTx(ctx, tx, p, id, expected, processID, name, status, external, automatic, requestID)
		return err
	})
	return result, err
}

// UpdateMachineTx is UpdateMachine inside the caller's transaction; the configuration import uses it.
func (s *Service) UpdateMachineTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	processID uuid.UUID,
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
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineForUpdate(ctx, id)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if current.Version != expected {
		return Machine{}, apperror.StaleWrite
	}
	processRow, err := q.GetProcess(ctx, processID)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if !processRow.Active && processID != current.ProcessID {
		return Machine{}, apperror.Conflicting("process_inactive", "Process is inactive")
	}
	_, err = q.UpdateMachine(
		ctx,
		machinelogbookdb.UpdateMachineParams{
			ProcessID:                  processID,
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
		[]string{"processId", "name", "status", "externalIdentifier", "automaticCollectionEnabled"},
	); err != nil {
		return Machine{}, err
	}
	return loadMachineFrom(ctx, q, id)
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
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		return s.DeleteMachineTx(ctx, tx, p, id, expected, requestID)
	})
}

// DeleteMachineTx is DeleteMachine inside the caller's transaction; the configuration import uses it.
func (s *Service) DeleteMachineTx(
	ctx context.Context,
	tx pgx.Tx,
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
	return nil
}
