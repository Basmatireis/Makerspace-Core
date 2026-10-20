package machinelogbook

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// maxAdjustmentValue keeps adjustment values inside numeric(20,6) with room to
// spare for the money columns derived from them.
var maxAdjustmentValue = decimal.NewFromInt(1_000_000_000_000)

// jobStatus derives the display status of a job: a recorded outcome wins,
// otherwise the job is running until its end and then waits for an outcome.
// validateOutcomeTiming rejects outcomes recorded before the run has ended.
func validateOutcomeTiming(endsAt time.Time, outcome *string, now time.Time) error {
	if outcome != nil && endsAt.After(now) {
		return apperror.New(422, "outcome_before_run_end", "An outcome cannot be recorded before the run has ended")
	}
	return nil
}

func cleanTitle(value *string) (*string, error) {
	title := cleanOptional(value)
	if title != nil && utf8.RuneCountInString(*title) > 200 {
		return nil, validation("title is limited to 200 characters")
	}
	return title, nil
}

func validatePriceAdjustment(kind string, value decimal.Decimal) error {
	switch kind {
	case "fixed":
		if value.IsNegative() {
			return validation("a fixed price must not be negative")
		}
	case "discount_percent":
		if !value.IsPositive() || value.GreaterThan(decimal.NewFromInt(100)) {
			return validation("a percent discount must be greater than 0 and at most 100")
		}
	case "discount_amount":
		if !value.IsPositive() {
			return validation("a discount amount must be greater than 0")
		}
	case "multiplier":
		if !value.IsPositive() || value.GreaterThan(decimal.NewFromInt(100)) {
			return validation("a multiplier must be greater than 0 and at most 100")
		}
	default:
		return validation("invalid price adjustment kind")
	}
	if value.GreaterThan(maxAdjustmentValue) {
		return validation("price adjustment value is too large")
	}
	return nil
}

// applyPriceAdjustment returns the effective price for a calculated price and
// an adjustment. A nil kind means no adjustment. Relative kinds cannot be
// applied to an unknown calculated price and yield nil; the result is rounded
// to cents like the calculation itself and never negative.
func applyPriceAdjustment(calculated *decimal.Decimal, kind *string, value decimal.Decimal) *decimal.Decimal {
	var result decimal.Decimal
	switch {
	case kind == nil:
		return calculated
	case *kind == "fixed":
		result = value
	case calculated == nil:
		return nil
	case *kind == "discount_percent":
		result = calculated.Mul(decimal.NewFromInt(100).Sub(value).Div(decimal.NewFromInt(100)))
	case *kind == "discount_amount":
		result = calculated.Sub(value)
	case *kind == "multiplier":
		result = calculated.Mul(value)
	default:
		return nil
	}
	result = result.Round(2)
	if result.IsNegative() {
		result = decimal.Zero
	}
	return &result
}

// effectivePriceForRow applies the adjustment stored on the job row to a newly
// calculated price. Every write of calculated_price or the adjustment stores
// this value in the same UPDATE.
func effectivePriceForRow(job machinelogbookdb.MachineJob, calculated pgtype.Numeric) pgtype.Numeric {
	var calc *decimal.Decimal
	if calculated.Valid {
		value := decimalFromNumeric(calculated)
		calc = &value
	}
	result := applyPriceAdjustment(calc, job.PriceAdjustmentKind, decimalFromNumeric(job.PriceAdjustmentValue))
	if result == nil {
		return pgtype.Numeric{}
	}
	return numericFromDecimal(*result)
}

func (s *Service) SetJobPriceAdjustment(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	kind, value, reason string,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsOverridePrice); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
	}
	amount, err := parseDecimal(value, false)
	if err != nil {
		return MachineJob{}, validation("value must be a decimal number")
	}
	amount = amount.Round(6)
	if err = validatePriceAdjustment(kind, amount); err != nil {
		return MachineJob{}, err
	}
	reason = strings.TrimSpace(reason)
	if reason == "" || utf8.RuneCountInString(reason) > 500 {
		return MachineJob{}, validation("reason is required and limited to 500 characters")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineJobForUpdate(ctx, id)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if current.Version != expected {
		return MachineJob{}, apperror.StaleWrite
	}
	current.PriceAdjustmentKind = &kind
	current.PriceAdjustmentValue = numericFromDecimal(amount)
	actor := p.AccountID
	_, err = q.SetMachineJobPriceAdjustment(
		ctx,
		machinelogbookdb.SetMachineJobPriceAdjustmentParams{
			Kind:            &kind,
			Value:           numericFromDecimal(amount),
			Reason:          &reason,
			ActorAccountID:  &actor,
			AdjustedAt:      pgtype.Timestamptz{Time: s.now(), Valid: true},
			EffectivePrice:  effectivePriceForRow(current, current.CalculatedPrice),
			ID:              id,
			ExpectedVersion: expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_job.price_adjusted",
		"machine_job",
		id,
		requestID,
		[]string{"priceAdjustment", "effectivePrice"},
	); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

func (s *Service) ClearJobPriceAdjustment(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsOverridePrice); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineJobForUpdate(ctx, id)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if current.Version != expected {
		return MachineJob{}, apperror.StaleWrite
	}
	if _, err = q.ClearMachineJobPriceAdjustment(
		ctx,
		machinelogbookdb.ClearMachineJobPriceAdjustmentParams{ID: id, ExpectedVersion: expected},
	); err != nil {
		return MachineJob{}, noRows(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_job.price_adjustment_cleared",
		"machine_job",
		id,
		requestID,
		[]string{"priceAdjustment", "effectivePrice"},
	); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}
