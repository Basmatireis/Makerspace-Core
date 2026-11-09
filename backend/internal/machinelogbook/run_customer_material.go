package machinelogbook

import (
	"context"
	"errors"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CustomerMaterialInput describes the customer material a usage is switched to. Both fields are optional; without
// a material type the usage keeps the type of the article it was booked from.
type CustomerMaterialInput struct {
	MaterialTypeID *uuid.UUID
	Label          *string
}

// SwitchRunUsageToCustomerMaterial turns one active makerspace usage of a run (booked by the machine or by staff)
// into customer material: the stock booking is reversed with a compensating inventory transaction, exactly like any
// usage correction, the quantity stays, and the job is priced again without charging the material. Only the given
// usage is touched; the run's other usages keep their bookings. It is a staff correction, so later machine reports
// do not replace it. Switching back is a usage replacement (ReplaceRunUsages), which picks the article and spool.
func (s *Service) SwitchRunUsageToCustomerMaterial(
	ctx context.Context,
	p authorization.Principal,
	runID, usageID uuid.UUID,
	expected int64,
	input CustomerMaterialInput,
	requestID *uuid.UUID,
) (RunUpdateResult, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return RunUpdateResult{}, err
	}
	if expected < 1 {
		return RunUpdateResult{}, apperror.Invalid("expectedVersion must be positive")
	}
	label := optional.Trimmed(input.Label)
	if label != nil && utf8.RuneCountInString(*label) > MaxUsageLabelLength {
		return RunUpdateResult{}, apperror.Invalid("label must be 1 to 120 characters")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RunUpdateResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	run, _, err := s.lockedRun(ctx, tx, runID)
	if err != nil {
		return RunUpdateResult{}, err
	}
	if run.Version != expected {
		return RunUpdateResult{}, apperror.StaleWrite
	}
	if run.State != nil && RunState(*run.State) == RunStateReplaced {
		return RunUpdateResult{}, apperror.Conflicting("run_replaced", "A replaced run cannot be changed")
	}
	active, err := q.ListActiveRunUsagesForUpdate(ctx, runID)
	if err != nil {
		return RunUpdateResult{}, err
	}
	var target *machinelogbookdb.MachineRunUsage
	for i := range active {
		if active[i].ID == usageID {
			target = &active[i]
		}
	}
	if target == nil {
		return RunUpdateResult{}, apperror.NotFound
	}
	if UsageOwnership(target.Ownership) == OwnershipExternal {
		return RunUpdateResult{}, apperror.Conflicting(
			"usage_already_customer_material",
			"The usage already is customer material",
		)
	}
	typeID := input.MaterialTypeID
	if typeID != nil {
		exists, existsErr := q.MaterialTypeExists(ctx, *typeID)
		if existsErr != nil {
			return RunUpdateResult{}, existsErr
		}
		if !exists {
			return RunUpdateResult{}, apperror.Invalid("unknown material type")
		}
	} else if target.MaterialID != nil {
		articleType, typeErr := q.GetMaterialTypeOfMaterial(ctx, *target.MaterialID)
		if typeErr != nil && !errors.Is(typeErr, pgx.ErrNoRows) {
			return RunUpdateResult{}, typeErr
		}
		if typeErr == nil {
			typeID = &articleType
		}
	}
	replacement := parsedUsage{
		Ownership:            string(OwnershipExternal),
		ExternalMaterialName: label,
		MaterialTypeID:       typeID,
		QuantityBasis:        target.QuantityBasis,
		Quantity:             decimalFromNumeric(target.Quantity),
		UsageID:              ids.New(),
		StaffCorrected:       true,
	}
	if err = s.replaceRunUsages(
		ctx, tx, q, p, runID, []machinelogbookdb.MachineRunUsage{*target}, []parsedUsage{replacement}, time.Now().UTC(),
		requestID,
	); err != nil {
		return RunUpdateResult{}, err
	}
	updated, err := q.BumpRunVersion(ctx, machinelogbookdb.BumpRunVersionParams{ID: runID, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return RunUpdateResult{}, apperror.StaleWrite
	}
	if err != nil {
		return RunUpdateResult{}, err
	}
	if err = s.finishRunChange(
		ctx, tx, q, p, updated, "machine_run.usage_switched_to_customer_material", []string{"usages", "inventory"}, requestID,
	); err != nil {
		return RunUpdateResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RunUpdateResult{}, err
	}
	return s.runResult(ctx, runID)
}
