package orders

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// MaxCashNoteLength bounds the free-text note of movements and counts.
const MaxCashNoteLength = 500

// countClockSkew tolerates clocks of the counting device that run slightly ahead of the server.
const countClockSkew = time.Minute

func cashCountReference(n int64) string {
	return fmt.Sprintf("K-%04d-%04d", time.Now().UTC().Year(), n)
}

func validCountReason(reason CashCountReason) bool {
	switch reason {
	case CountReasonCountingError, CountReasonChangeGivenWrong, CountReasonReceiptNotRecorded, CountReasonUnknown,
		CountReasonOther:
		return true
	}
	return false
}

func (s *Service) loadCashCount(ctx context.Context, q *db.Queries, id uuid.UUID) (CashCount, error) {
	row, err := q.GetCashCountDetails(ctx, id)
	if err != nil {
		return CashCount{}, databaseError(err)
	}
	v := CashCount{
		ID:             row.ID,
		Reference:      row.Reference,
		CountedAmount:  money(row.CountedAmount),
		ExpectedAmount: money(row.ExpectedAmount),
		Difference:     money(row.Difference),
		Note:           row.Note,
		CountedAt:      row.CountedAt,
		CreatedAt:      row.CreatedAt,
		Version:        row.Version,
		UpdatedAt:      row.UpdatedAt,
	}
	if row.Reason != nil {
		reason := CashCountReason(*row.Reason)
		v.Reason = &reason
	}
	if row.RecordedByPersonID != nil {
		v.RecordedBy = &Actor{ID: *row.RecordedByPersonID, DisplayName: row.RecordedByName}
	}
	if row.CorrectionID != nil && row.CorrectionReference != nil {
		v.Correction = &CashCountCorrection{ID: *row.CorrectionID, Reference: *row.CorrectionReference}
	}
	return v, nil
}

// latestCashCount is the newest count before `to` (exclusive), nil when there is none.
func (s *Service) latestCashCount(ctx context.Context, q *db.Queries, to *time.Time) (*CashCount, error) {
	id, err := q.LatestCashCountID(ctx, nullableTime(to))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	count, err := s.loadCashCount(ctx, q, id)
	if err != nil {
		return nil, err
	}
	return &count, nil
}

// ListCashCounts lists counts newest first. Counts show expected amounts, which are derived from payments.
func (s *Service) ListCashCounts(
	ctx context.Context,
	p authorization.Principal,
	from, to *time.Time,
	page, size int,
) (CashCountPage, error) {
	if err := require(p, authorization.PaymentsRead, authorization.CashMovementsRead); err != nil {
		return CashCountPage{}, err
	}
	limit, offset, err := pageBounds(page, size)
	if err != nil {
		return CashCountPage{}, err
	}
	q := db.New(s.pool)
	rows, err := q.ListCashCountIDs(ctx, db.ListCashCountIDsParams{
		FromTime:   nullableTime(from),
		ToTime:     nullableTime(to),
		PageLimit:  limit,
		PageOffset: offset,
	})
	if err != nil {
		return CashCountPage{}, err
	}
	result := CashCountPage{Items: []CashCount{}, Page: int64(page), PageSize: int64(size)}
	if result.Total, err = q.CountCashCounts(
		ctx,
		db.CountCashCountsParams{FromTime: nullableTime(from), ToTime: nullableTime(to)},
	); err != nil {
		return result, err
	}
	for _, id := range rows {
		count, e := s.loadCashCount(ctx, q, id)
		if e != nil {
			return result, e
		}
		result.Items = append(result.Items, count)
	}
	return result, nil
}

type countInput struct {
	counted  decimal.Decimal
	at       time.Time
	reason   *CashCountReason
	note     string
	expected *decimal.Decimal
}

func validateCashCount(input CashCountInput) (countInput, error) {
	var v countInput
	if input.OperationKey == uuid.Nil {
		return v, apperror.Invalid("operationKey is required")
	}
	counted, err := parseAmount(input.CountedAmount, 2, false)
	if err != nil {
		return v, err
	}
	v.counted = counted
	if input.CountedAt.IsZero() {
		return v, apperror.Invalid("The time of the count is required")
	}
	if input.CountedAt.After(time.Now().Add(countClockSkew)) {
		return v, apperror.Invalid("A count cannot be in the future")
	}
	v.at = input.CountedAt.UTC().Truncate(time.Microsecond)
	if input.Reason != nil {
		if !validCountReason(*input.Reason) {
			return v, apperror.Invalid("Unsupported reason for a count difference")
		}
		v.reason = input.Reason
	}
	v.note = strings.TrimSpace(input.Note)
	if len(v.note) > MaxCashNoteLength {
		return v, apperror.Invalid("The note can have up to 500 characters")
	}
	if input.ExpectedAmount != nil {
		expected, e := decimal.NewFromString(*input.ExpectedAmount)
		if e != nil || expected.Exponent() < -2 {
			return v, apperror.Invalid("expectedAmount must be a decimal with up to two places")
		}
		v.expected = &expected
	}
	return v, nil
}

// sameCashCount says whether a retry under the same operation key asks for the count that was recorded.
func sameCashCount(existing db.CashCount, v countInput, person uuid.UUID) bool {
	sameReason := (existing.Reason == nil && (v.reason == nil || d(existing.Difference).IsZero())) ||
		(existing.Reason != nil && v.reason != nil && *existing.Reason == string(*v.reason))
	samePerson := (existing.RecordedByPersonID == nil && person == uuid.Nil) ||
		(existing.RecordedByPersonID != nil && *existing.RecordedByPersonID == person)
	return d(existing.CountedAmount).Equal(v.counted) && existing.CountedAt.Equal(v.at) && sameReason &&
		existing.Note == v.note && samePerson
}

// RecordCashCount stores a count of the register with what it should have held at that moment. A difference is
// booked as one correction movement in the same transaction, so the expected cash follows what is really there; a
// matching count books nothing.
func (s *Service) RecordCashCount(
	ctx context.Context,
	p authorization.Principal,
	input CashCountInput,
	requestID *uuid.UUID,
) (CashCount, error) {
	if err := require(
		p,
		authorization.PaymentsRead,
		authorization.CashMovementsRead,
		authorization.CashMovementsRecord,
	); err != nil {
		return CashCount{}, err
	}
	v, err := validateCashCount(input)
	if err != nil {
		return CashCount{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CashCount{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	// One writer at a time: the expected amount and the correction are computed against a stable register.
	if err = q.LockCashRegister(ctx); err != nil {
		return CashCount{}, err
	}
	existing, err := q.GetCashCountByKey(ctx, input.OperationKey)
	if err == nil {
		if !sameCashCount(existing, v, p.PersonID) {
			return CashCount{}, apperror.Conflicting(
				"idempotency_conflict",
				"Operation key was used for different input",
			)
		}
		return s.loadCashCount(ctx, q, existing.ID)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CashCount{}, err
	}
	latest, err := q.LatestCashCountTime(ctx)
	if err == nil && !v.at.After(latest) {
		return CashCount{}, apperror.Conflicting(
			"cash_count_out_of_order",
			"The register was already counted at or after this time",
		)
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return CashCount{}, err
	}
	// Everything recorded up to and including the counting time is expected in the register.
	until := v.at.Add(time.Microsecond)
	then, err := cashFiguresUntil(ctx, q, &until)
	if err != nil {
		return CashCount{}, err
	}
	expected := then.expected()
	if v.expected != nil && !v.expected.Equal(expected) {
		return CashCount{}, apperror.Conflicting(
			"cash_expected_changed",
			"The expected amount changed since it was shown; check it and count again",
		)
	}
	difference := v.counted.Sub(expected)
	reason := v.reason
	if difference.IsZero() {
		reason = nil
	} else if reason == nil {
		return CashCount{}, apperror.New(
			http.StatusUnprocessableEntity,
			"cash_count_reason_required",
			"Say why the count differs from the expected amount",
		)
	}
	if reason != nil && (*reason == CountReasonUnknown || *reason == CountReasonOther) && v.note == "" {
		return CashCount{}, apperror.Invalid("Say what you found in the note")
	}
	if difference.IsNegative() {
		// A backdated count that found less cash than expected cannot leave the register owing cash now.
		now, e := cashFiguresUntil(ctx, q, nil)
		if e != nil {
			return CashCount{}, e
		}
		if now.expected().Add(difference).IsNegative() {
			return CashCount{}, apperror.Conflicting(
				"cash_count_inconsistent",
				"Later withdrawals took more cash than this count found; count again at a later time",
			)
		}
	}
	n, err := q.NextCashCountReference(ctx)
	if err != nil {
		return CashCount{}, err
	}
	var person *uuid.UUID
	if p.PersonID != uuid.Nil {
		person = &p.PersonID
	}
	var reasonText *string
	if reason != nil {
		text := string(*reason)
		reasonText = &text
	}
	count, err := q.InsertCashCount(ctx, db.InsertCashCountParams{
		ID:                 ids.New(),
		Reference:          cashCountReference(n),
		OperationKey:       input.OperationKey,
		CountedAmount:      numeric(v.counted),
		ExpectedAmount:     numeric(expected),
		Difference:         numeric(difference),
		Reason:             reasonText,
		Note:               v.note,
		CountedAt:          v.at,
		RecordedByPersonID: person,
	})
	if err != nil {
		return CashCount{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"cash_count.recorded",
		"cash_count",
		count.ID,
		requestID,
		"countedAmount",
		"expectedAmount",
		"difference",
		"reason",
	); err != nil {
		return CashCount{}, err
	}
	if !difference.IsZero() {
		if err = s.bookCountCorrection(ctx, tx, q, p, count, difference, person, requestID); err != nil {
			return CashCount{}, err
		}
		if s.notices != nil {
			if err = s.notices.CashCountDifference(ctx, tx, count.ID); err != nil {
				return CashCount{}, err
			}
		}
	}
	result, err := s.loadCashCount(ctx, q, count.ID)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}

// bookCountCorrection records the signed correction a count with a difference books, at the counting time.
func (s *Service) bookCountCorrection(
	ctx context.Context,
	tx pgx.Tx,
	q *db.Queries,
	p authorization.Principal,
	count db.CashCount,
	difference decimal.Decimal,
	person *uuid.UUID,
	requestID *uuid.UUID,
) error {
	n, err := q.NextCashMovementReference(ctx)
	if err != nil {
		return err
	}
	movement, err := q.InsertCashMovement(ctx, db.InsertCashMovementParams{
		ID:                 ids.New(),
		Reference:          reference("C", n),
		OperationKey:       ids.New(),
		Kind:               string(CashCorrection),
		Amount:             numeric(difference),
		Reason:             string(CashReasonCountDifference),
		Note:               "",
		OccurredAt:         count.CountedAt,
		RecordedByPersonID: person,
		CashCountID:        &count.ID,
	})
	if err != nil {
		return databaseError(err)
	}
	return writeAudit(
		ctx,
		tx,
		p,
		"cash_movement.recorded",
		"cash_movement",
		movement.ID,
		requestID,
		"kind",
		"amount",
		"reason",
	)
}
