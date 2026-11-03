package orders

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// The register counts cash only. Card payments and external (wiRef) payments never go through it, whatever
// their reversals: figures are derived from method='cash' payments plus the immutable cash movements.

// cashFigures are sums up to a point in time. corrections is signed: what count corrections added to the register.
type cashFigures struct{ receipts, refunds, withdrawals, deposits, corrections decimal.Decimal }

func (f cashFigures) expected() decimal.Decimal {
	return f.receipts.Sub(f.refunds).Sub(f.withdrawals).Add(f.deposits).Add(f.corrections)
}

// cashFiguresUntil sums everything that occurred before `to` (exclusive); nil means everything recorded.
func cashFiguresUntil(ctx context.Context, q *db.Queries, to *time.Time) (cashFigures, error) {
	payments, err := q.CashPaymentFigures(ctx, nullableTime(to))
	if err != nil {
		return cashFigures{}, err
	}
	movements, err := q.CashMovementFigures(ctx, nullableTime(to))
	if err != nil {
		return cashFigures{}, err
	}
	return cashFigures{
		receipts:    d(payments.Receipts),
		refunds:     d(payments.Refunds),
		withdrawals: d(movements.Withdrawals),
		deposits:    d(movements.Deposits),
		corrections: d(movements.Corrections),
	}, nil
}

// register presents the figures as the derivation the cash register shows.
func (f cashFigures) register() CashRegister {
	takenOut := f.corrections.Neg()
	return CashRegister{
		Receipts:              f.receipts.StringFixed(2),
		Refunds:               f.refunds.StringFixed(2),
		Corrections:           takenOut.StringFixed(2),
		RefundsAndCorrections: f.refunds.Add(takenOut).StringFixed(2),
		Withdrawals:           f.withdrawals.StringFixed(2),
		Deposits:              f.deposits.StringFixed(2),
		Expected:              f.expected().StringFixed(2),
	}
}

func (s *Service) CashRegister(ctx context.Context, p authorization.Principal, to *time.Time) (CashRegister, error) {
	if err := require(p, authorization.PaymentsRead, authorization.CashMovementsRead); err != nil {
		return CashRegister{}, err
	}
	q := db.New(s.pool)
	figures, err := cashFiguresUntil(ctx, q, to)
	if err != nil {
		return CashRegister{}, err
	}
	result := figures.register()
	if to != nil {
		utc := to.UTC()
		result.To = &utc
	}
	if result.LastCount, err = s.latestCashCount(ctx, q, to); err != nil {
		return result, err
	}
	return result, nil
}

func (s *Service) cashMovement(ctx context.Context, q *db.Queries, row db.CashMovement) (CashMovement, error) {
	amount := d(row.Amount)
	v := CashMovement{
		ID:          row.ID,
		Reference:   row.Reference,
		Kind:        CashMovementKind(row.Kind),
		Direction:   CashIn,
		Amount:      amount.Abs().StringFixed(2),
		Reason:      CashMovementReason(row.Reason),
		Note:        row.Note,
		OccurredAt:  row.OccurredAt,
		CreatedAt:   row.CreatedAt,
		CashCountID: row.CashCountID,
	}
	if v.Kind == CashWithdrawal || amount.IsNegative() {
		v.Direction = CashOut
	}
	if row.CashCountID != nil {
		count, err := q.GetCashCountReference(ctx, *row.CashCountID)
		if err != nil {
			return v, err
		}
		v.CashCountReference = &count
	}
	if row.RecordedByPersonID != nil {
		person, err := q.GetPerson(ctx, *row.RecordedByPersonID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return v, err
		}
		if err == nil {
			v.RecordedBy = &Actor{ID: person.ID, DisplayName: person.DisplayName}
		}
	}
	return v, nil
}

func (s *Service) ListCashMovements(
	ctx context.Context,
	p authorization.Principal,
	kind string,
	from, to *time.Time,
	page, size int,
) (CashMovementPage, error) {
	if err := require(p, authorization.CashMovementsRead); err != nil {
		return CashMovementPage{}, err
	}
	switch CashMovementKind(kind) {
	case "", CashWithdrawal, CashDeposit, CashCorrection:
	default:
		return CashMovementPage{}, apperror.Invalid("Unsupported cash movement kind")
	}
	limit, offset, err := pageBounds(page, size)
	if err != nil {
		return CashMovementPage{}, err
	}
	q := db.New(s.pool)
	rows, err := q.ListCashMovements(
		ctx,
		db.ListCashMovementsParams{
			Kind:       kind,
			FromTime:   nullableTime(from),
			ToTime:     nullableTime(to),
			PageLimit:  limit,
			PageOffset: offset,
		},
	)
	if err != nil {
		return CashMovementPage{}, err
	}
	result := CashMovementPage{Items: []CashMovement{}, Page: int64(page), PageSize: int64(size)}
	if result.Total, err = q.CountCashMovements(
		ctx,
		db.CountCashMovementsParams{Kind: kind, FromTime: nullableTime(from), ToTime: nullableTime(to)},
	); err != nil {
		return result, err
	}
	for _, row := range rows {
		item, e := s.cashMovement(ctx, q, row)
		if e != nil {
			return result, e
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}

// CreateCashMovement records a withdrawal or deposit. Movements are immutable; a mistake is corrected with
// another movement. A withdrawal cannot exceed what the register should hold, neither at its own time nor now.
func (s *Service) CreateCashMovement(
	ctx context.Context,
	p authorization.Principal,
	input CashMovementInput,
	requestID *uuid.UUID,
) (CashMovement, error) {
	if err := require(p, authorization.CashMovementsRead, authorization.CashMovementsRecord); err != nil {
		return CashMovement{}, err
	}
	if input.OperationKey == uuid.Nil {
		return CashMovement{}, apperror.Invalid("operationKey is required")
	}
	if input.Kind != CashWithdrawal && input.Kind != CashDeposit {
		return CashMovement{}, apperror.Invalid("Unsupported cash movement kind")
	}
	switch input.Reason {
	case CashReasonBankDeposit, CashReasonSafe, CashReasonFloat, CashReasonOther:
	default:
		return CashMovement{}, apperror.Invalid("Unsupported cash movement reason")
	}
	amount, err := parseAmount(input.Amount, 2, true)
	if err != nil {
		return CashMovement{}, err
	}
	note := strings.TrimSpace(input.Note)
	if len(note) > 500 {
		return CashMovement{}, apperror.Invalid("The note can have up to 500 characters")
	}
	if input.Reason == CashReasonOther && note == "" {
		return CashMovement{}, apperror.Invalid("Say what the money was for in the note")
	}
	if input.OccurredAt.IsZero() {
		return CashMovement{}, apperror.Invalid("The time of the movement is required")
	}
	if input.OccurredAt.After(time.Now().Add(time.Minute)) {
		return CashMovement{}, apperror.Invalid("A cash movement cannot be in the future")
	}
	occurred := input.OccurredAt.UTC().Truncate(time.Microsecond)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CashMovement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	// One writer at a time: retries and the withdrawal limit are checked against a stable register.
	if err = q.LockCashRegister(ctx); err != nil {
		return CashMovement{}, err
	}
	existing, err := q.GetCashMovementByKey(ctx, input.OperationKey)
	if err == nil {
		same := CashMovementKind(existing.Kind) == input.Kind && d(existing.Amount).Equal(amount) && CashMovementReason(existing.Reason) == input.Reason &&
			existing.Note == note &&
			existing.OccurredAt.Equal(occurred) &&
			((existing.RecordedByPersonID == nil && p.PersonID == uuid.Nil) ||
				(existing.RecordedByPersonID != nil && *existing.RecordedByPersonID == p.PersonID))
		if !same {
			return CashMovement{}, apperror.Conflicting(
				"idempotency_conflict",
				"Operation key was used for different input",
			)
		}
		return s.cashMovement(ctx, q, existing)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CashMovement{}, err
	}
	if input.Kind == CashWithdrawal {
		at := occurred.Add(time.Microsecond)
		held, e := cashFiguresUntil(ctx, q, &at)
		if e != nil {
			return CashMovement{}, e
		}
		now, e := cashFiguresUntil(ctx, q, nil)
		if e != nil {
			return CashMovement{}, e
		}
		if amount.GreaterThan(held.expected()) || amount.GreaterThan(now.expected()) {
			return CashMovement{}, apperror.Conflicting(
				"insufficient_cash",
				"The register does not hold enough cash for this withdrawal",
			)
		}
	}
	n, err := q.NextCashMovementReference(ctx)
	if err != nil {
		return CashMovement{}, err
	}
	var person *uuid.UUID
	if p.PersonID != uuid.Nil {
		person = &p.PersonID
	}
	row, err := q.InsertCashMovement(
		ctx,
		db.InsertCashMovementParams{
			ID:                 ids.New(),
			Reference:          reference("C", n),
			OperationKey:       input.OperationKey,
			Kind:               string(input.Kind),
			Amount:             numeric(amount),
			Reason:             string(input.Reason),
			Note:               note,
			OccurredAt:         occurred,
			RecordedByPersonID: person,
			CashCountID:        nil,
		},
	)
	if err != nil {
		return CashMovement{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"cash_movement.recorded",
		"cash_movement",
		row.ID,
		requestID,
		"kind",
		"amount",
		"reason",
	); err != nil {
		return CashMovement{}, err
	}
	result, err := s.cashMovement(ctx, q, row)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}
