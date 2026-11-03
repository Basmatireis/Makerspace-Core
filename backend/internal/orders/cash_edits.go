package orders

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// Editing and deleting withdrawals, deposits and counts (cash_movements.manage). A count anchors the register: after
// it the register holds what was counted, whatever came before. So when an entry before a count changes, the count's
// expected amount, difference and correction are recalculated; the counts after the next unchanged one stay as they
// are. Every change runs under the register lock and refuses to leave the register holding less than nothing at
// any later moment.

var errCashBalanceNegative = apperror.Conflicting(
	"cash_balance_negative",
	"After this change the register would hold less than nothing at a later moment",
)

func errCorrectionBelongsToCount() error {
	return apperror.Conflicting(
		"cash_movement_is_correction",
		"A count correction changes only with its count; edit or delete the count",
	)
}

func auditTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func writeCashAudit(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	action, resource string,
	id uuid.UUID,
	requestID *uuid.UUID,
	metadata map[string]any,
	fields ...string,
) error {
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &p.AccountID,
		Action:         action,
		ResourceType:   resource,
		ResourceID:     &id,
		RequestID:      requestID,
		ChangedFields:  fields,
		Metadata:       metadata,
	})
}

func movementAuditMetadata(row db.CashMovement) map[string]any {
	return map[string]any{
		"reference":          row.Reference,
		"previousKind":       row.Kind,
		"previousAmount":     d(row.Amount).StringFixed(2),
		"previousOccurredAt": auditTime(row.OccurredAt),
		"previousReason":     row.Reason,
	}
}

func countAuditMetadata(row db.CashCount) map[string]any {
	metadata := map[string]any{
		"reference":             row.Reference,
		"previousCountedAmount": d(row.CountedAmount).StringFixed(2),
		"previousCountedAt":     auditTime(row.CountedAt),
	}
	if row.Reason != nil {
		metadata["previousReason"] = *row.Reason
	}
	return metadata
}

// lowestBalance is the lowest running balance of the register at or after `from`; ok is false without an entry there.
func lowestBalance(ctx context.Context, q *db.Queries, from time.Time) (lowest decimal.Decimal, ok bool, err error) {
	value, err := q.LowestCashBalanceFrom(ctx, from)
	if err != nil {
		return decimal.Zero, false, err
	}
	return d(value), value.Valid, nil
}

// checkBalanceAfter refuses a change that leaves the register below zero after `from`. A dip that was already there
// (for example from refunds recorded long ago) does not block changes that do not deepen it.
func checkBalanceAfter(ctx context.Context, q *db.Queries, from time.Time, before decimal.Decimal, hadBefore bool) error {
	after, ok, err := lowestBalance(ctx, q, from)
	if err != nil {
		return err
	}
	if ok && after.IsNegative() && (!hadBefore || after.LessThan(before)) {
		return errCashBalanceNegative
	}
	return nil
}

func earlier(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

func later(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

func countCorrection(ctx context.Context, q *db.Queries, countID uuid.UUID) (*db.CashMovement, error) {
	row, err := q.GetCashCountCorrection(ctx, &countID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// expectedAtCount is what the register should hold at `at`, everything up to and including it, without the count's
// own correction (which is booked at the counting time).
func expectedAtCount(
	ctx context.Context,
	q *db.Queries,
	at time.Time,
	correction *db.CashMovement,
) (decimal.Decimal, error) {
	until := at.Add(time.Microsecond)
	figures, err := cashFiguresUntil(ctx, q, &until)
	if err != nil {
		return decimal.Zero, err
	}
	expected := figures.expected()
	if correction != nil && correction.OccurredAt.Before(until) {
		expected = expected.Sub(d(correction.Amount))
	}
	return expected, nil
}

// syncCountCorrection makes the count's correction book its difference at its time: it creates, changes or deletes it.
func (s *Service) syncCountCorrection(
	ctx context.Context,
	tx pgx.Tx,
	q *db.Queries,
	p authorization.Principal,
	count db.CashCount,
	correction *db.CashMovement,
	requestID *uuid.UUID,
) error {
	difference := d(count.Difference)
	switch {
	case correction == nil && difference.IsZero():
		return nil
	case correction == nil:
		var person *uuid.UUID
		if p.PersonID != uuid.Nil {
			person = &p.PersonID
		}
		return s.bookCountCorrection(ctx, tx, q, p, count, difference, person, requestID)
	case difference.IsZero():
		if err := q.DeleteCashMovement(ctx, correction.ID); err != nil {
			return databaseError(err)
		}
		return writeCashAudit(ctx, tx, p, "cash_movement.deleted", "cash_movement", correction.ID, requestID,
			movementAuditMetadata(*correction))
	}
	var fields []string
	if !d(correction.Amount).Equal(difference) {
		fields = append(fields, "amount")
	}
	if !correction.OccurredAt.Equal(count.CountedAt) {
		fields = append(fields, "occurredAt")
	}
	if len(fields) == 0 {
		return nil
	}
	if _, err := q.UpdateCashMovement(ctx, db.UpdateCashMovementParams{
		ID:         correction.ID,
		Amount:     numeric(difference),
		Reason:     correction.Reason,
		Note:       correction.Note,
		OccurredAt: count.CountedAt,
	}); err != nil {
		return databaseError(err)
	}
	return writeCashAudit(ctx, tx, p, "cash_movement.updated", "cash_movement", correction.ID, requestID,
		movementAuditMetadata(*correction), fields...)
}

// reconcileCounts recalculates the counts from `from` on, oldest first, after the entries before them changed. Once a
// count after `until` (the last moment the change touched) needs no change, the counts after it cannot either: from
// a count on the register holds what was counted. skip is the count the caller already recalculated.
func (s *Service) reconcileCounts(
	ctx context.Context,
	tx pgx.Tx,
	q *db.Queries,
	p authorization.Principal,
	from, until time.Time,
	skip uuid.UUID,
	requestID *uuid.UUID,
) error {
	counts, err := q.ListCashCountsFrom(ctx, from)
	if err != nil {
		return err
	}
	for _, count := range counts {
		if count.ID == skip {
			continue
		}
		correction, err := countCorrection(ctx, q, count.ID)
		if err != nil {
			return err
		}
		expected, err := expectedAtCount(ctx, q, count.CountedAt, correction)
		if err != nil {
			return err
		}
		if expected.Equal(d(count.ExpectedAmount)) {
			if count.CountedAt.After(until) {
				return nil
			}
			continue
		}
		difference := d(count.CountedAmount).Sub(expected)
		reason := count.Reason
		fields := []string{"expectedAmount", "difference"}
		if difference.IsZero() && reason != nil {
			reason = nil
			fields = append(fields, "reason")
		}
		updated, err := q.UpdateCashCount(ctx, db.UpdateCashCountParams{
			ID:             count.ID,
			CountedAmount:  count.CountedAmount,
			ExpectedAmount: numeric(expected),
			Difference:     numeric(difference),
			Reason:         reason,
			Note:           count.Note,
			CountedAt:      count.CountedAt,
		})
		if err != nil {
			return databaseError(err)
		}
		if err = writeCashAudit(ctx, tx, p, "cash_count.recalculated", "cash_count", count.ID, requestID,
			map[string]any{"reference": count.Reference}, fields...); err != nil {
			return err
		}
		if err = s.syncCountCorrection(ctx, tx, q, p, updated, correction, requestID); err != nil {
			return err
		}
	}
	return nil
}

func validEditableMovementReason(reason CashMovementReason) bool {
	switch reason {
	case CashReasonBankDeposit, CashReasonSafe, CashReasonFloat, CashReasonOther:
		return true
	}
	return false
}

func cashEntryTime(at time.Time, what string) (time.Time, error) {
	if at.IsZero() {
		return at, apperror.Invalid("The time of the " + what + " is required")
	}
	if at.After(time.Now().Add(countClockSkew)) {
		return at, apperror.Invalid("A " + what + " cannot be in the future")
	}
	return at.UTC().Truncate(time.Microsecond), nil
}

// UpdateCashMovement changes the amount, time, reason or note of a withdrawal or deposit. Counts after the change
// are recalculated in the same transaction.
func (s *Service) UpdateCashMovement(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	change CashMovementChange,
	requestID *uuid.UUID,
) (CashMovement, error) {
	if err := require(p, authorization.CashMovementsRead, authorization.CashMovementsManage); err != nil {
		return CashMovement{}, err
	}
	if change.ExpectedVersion < 1 {
		return CashMovement{}, apperror.Invalid("expectedVersion is required")
	}
	var amount *decimal.Decimal
	if change.Amount != nil {
		value, err := parseAmount(*change.Amount, 2, true)
		if err != nil {
			return CashMovement{}, err
		}
		amount = &value
	}
	if change.Reason != nil && !validEditableMovementReason(*change.Reason) {
		return CashMovement{}, apperror.Invalid("Unsupported cash movement reason")
	}
	var occurred *time.Time
	if change.OccurredAt != nil {
		value, err := cashEntryTime(*change.OccurredAt, "movement")
		if err != nil {
			return CashMovement{}, err
		}
		occurred = &value
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CashMovement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if err = q.LockCashRegister(ctx); err != nil {
		return CashMovement{}, err
	}
	row, err := q.GetCashMovementForUpdate(ctx, id)
	if err != nil {
		return CashMovement{}, databaseError(err)
	}
	if CashMovementKind(row.Kind) == CashCorrection {
		return CashMovement{}, errCorrectionBelongsToCount()
	}
	if row.Version != change.ExpectedVersion {
		return CashMovement{}, apperror.StaleWrite
	}
	next := db.UpdateCashMovementParams{
		ID:         row.ID,
		Amount:     row.Amount,
		Reason:     row.Reason,
		Note:       row.Note,
		OccurredAt: row.OccurredAt,
	}
	var fields []string
	if amount != nil && !amount.Equal(d(row.Amount)) {
		next.Amount = numeric(*amount)
		fields = append(fields, "amount")
	}
	if occurred != nil && !occurred.Equal(row.OccurredAt) {
		next.OccurredAt = *occurred
		fields = append(fields, "occurredAt")
	}
	if change.Reason != nil && string(*change.Reason) != row.Reason {
		next.Reason = string(*change.Reason)
		fields = append(fields, "reason")
	}
	if change.Note != nil {
		note := strings.TrimSpace(*change.Note)
		if len(note) > MaxCashNoteLength {
			return CashMovement{}, apperror.Invalid("The note can have up to 500 characters")
		}
		if note != row.Note {
			next.Note = note
			fields = append(fields, "note")
		}
	}
	if CashMovementReason(next.Reason) == CashReasonOther && next.Note == "" {
		return CashMovement{}, apperror.Invalid("Say what the money was for in the note")
	}
	if len(fields) == 0 {
		return s.cashMovement(ctx, q, row)
	}
	from, until := earlier(row.OccurredAt, next.OccurredAt), later(row.OccurredAt, next.OccurredAt)
	before, hadBefore, err := lowestBalance(ctx, q, from)
	if err != nil {
		return CashMovement{}, err
	}
	updated, err := q.UpdateCashMovement(ctx, next)
	if err != nil {
		return CashMovement{}, databaseError(err)
	}
	if err = s.reconcileCounts(ctx, tx, q, p, from, until, uuid.Nil, requestID); err != nil {
		return CashMovement{}, err
	}
	if err = checkBalanceAfter(ctx, q, from, before, hadBefore); err != nil {
		return CashMovement{}, err
	}
	if err = writeCashAudit(ctx, tx, p, "cash_movement.updated", "cash_movement", row.ID, requestID,
		movementAuditMetadata(row), fields...); err != nil {
		return CashMovement{}, err
	}
	result, err := s.cashMovement(ctx, q, updated)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}

// DeleteCashMovement deletes a withdrawal or deposit for good. Counts after it are recalculated without it.
func (s *Service) DeleteCashMovement(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	deletion CashEntryDeletion,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.CashMovementsRead, authorization.CashMovementsManage); err != nil {
		return err
	}
	if deletion.ExpectedVersion < 1 {
		return apperror.Invalid("expectedVersion is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if err = q.LockCashRegister(ctx); err != nil {
		return err
	}
	row, err := q.GetCashMovementForUpdate(ctx, id)
	if err != nil {
		return databaseError(err)
	}
	if CashMovementKind(row.Kind) == CashCorrection {
		return errCorrectionBelongsToCount()
	}
	if row.Version != deletion.ExpectedVersion {
		return apperror.StaleWrite
	}
	before, hadBefore, err := lowestBalance(ctx, q, row.OccurredAt)
	if err != nil {
		return err
	}
	if err = q.DeleteCashMovement(ctx, row.ID); err != nil {
		return databaseError(err)
	}
	if err = s.reconcileCounts(ctx, tx, q, p, row.OccurredAt, row.OccurredAt, uuid.Nil, requestID); err != nil {
		return err
	}
	if err = checkBalanceAfter(ctx, q, row.OccurredAt, before, hadBefore); err != nil {
		return err
	}
	if err = writeCashAudit(ctx, tx, p, "cash_movement.deleted", "cash_movement", row.ID, requestID,
		movementAuditMetadata(row)); err != nil {
		return err
	}
	return databaseError(tx.Commit(ctx))
}

// checkCountOrder keeps counts in time order: a count may move only between its neighbours.
func checkCountOrder(ctx context.Context, q *db.Queries, current, at time.Time) error {
	outOfOrder := apperror.Conflicting(
		"cash_count_out_of_order",
		"Counts stay in order: the new time must lie between the previous and the next count",
	)
	previous, err := q.PreviousCashCountTime(ctx, current)
	if err == nil && !at.After(previous) {
		return outOfOrder
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	next, err := q.NextCashCountTime(ctx, current)
	if err == nil && !at.Before(next) {
		return outOfOrder
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return nil
}

type countChange struct {
	counted  *decimal.Decimal
	at       *time.Time
	reason   *CashCountReason
	note     *string
	expected *decimal.Decimal
}

func validateCountChange(change CashCountChange) (countChange, error) {
	var v countChange
	if change.ExpectedVersion < 1 {
		return v, apperror.Invalid("expectedVersion is required")
	}
	if change.CountedAmount != nil {
		counted, err := parseAmount(*change.CountedAmount, 2, false)
		if err != nil {
			return v, err
		}
		v.counted = &counted
	}
	if change.CountedAt != nil {
		at, err := cashEntryTime(*change.CountedAt, "count")
		if err != nil {
			return v, err
		}
		v.at = &at
	}
	if change.Reason != nil {
		if !validCountReason(*change.Reason) {
			return v, apperror.Invalid("Unsupported reason for a count difference")
		}
		v.reason = change.Reason
	}
	if change.Note != nil {
		note := strings.TrimSpace(*change.Note)
		if len(note) > MaxCashNoteLength {
			return v, apperror.Invalid("The note can have up to 500 characters")
		}
		v.note = &note
	}
	if change.ExpectedAmount != nil {
		expected, err := decimal.NewFromString(*change.ExpectedAmount)
		if err != nil || expected.Exponent() < -2 {
			return v, apperror.Invalid("expectedAmount must be a decimal with up to two places")
		}
		v.expected = &expected
	}
	return v, nil
}

// UpdateCashCount changes what was counted, when, why it differs or the note. The expected amount, the difference
// and the correction follow, and so do the counts after it.
func (s *Service) UpdateCashCount(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	change CashCountChange,
	requestID *uuid.UUID,
) (CashCount, error) {
	if err := require(
		p,
		authorization.PaymentsRead,
		authorization.CashMovementsRead,
		authorization.CashMovementsManage,
	); err != nil {
		return CashCount{}, err
	}
	v, err := validateCountChange(change)
	if err != nil {
		return CashCount{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CashCount{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if err = q.LockCashRegister(ctx); err != nil {
		return CashCount{}, err
	}
	row, err := q.GetCashCountForUpdate(ctx, id)
	if err != nil {
		return CashCount{}, databaseError(err)
	}
	if row.Version != change.ExpectedVersion {
		return CashCount{}, apperror.StaleWrite
	}
	counted, at, note := d(row.CountedAmount), row.CountedAt, row.Note
	var fields []string
	if v.counted != nil && !v.counted.Equal(counted) {
		counted = *v.counted
		fields = append(fields, "countedAmount")
	}
	if v.at != nil && !v.at.Equal(at) {
		if err = checkCountOrder(ctx, q, row.CountedAt, *v.at); err != nil {
			return CashCount{}, err
		}
		at = *v.at
		fields = append(fields, "countedAt")
	}
	if v.note != nil && *v.note != note {
		note = *v.note
		fields = append(fields, "note")
	}
	var reason *CashCountReason
	if row.Reason != nil {
		stored := CashCountReason(*row.Reason)
		reason = &stored
	}
	if v.reason != nil {
		reason = v.reason
	}
	correction, err := countCorrection(ctx, q, row.ID)
	if err != nil {
		return CashCount{}, err
	}
	expected, err := expectedAtCount(ctx, q, at, correction)
	if err != nil {
		return CashCount{}, err
	}
	if v.expected != nil && !v.expected.Equal(expected) {
		return CashCount{}, apperror.Conflicting(
			"cash_expected_changed",
			"The expected amount changed since it was shown; check it and save again",
		)
	}
	difference := counted.Sub(expected)
	if difference.IsZero() {
		reason = nil
	} else if reason == nil {
		return CashCount{}, apperror.New(
			http.StatusUnprocessableEntity,
			"cash_count_reason_required",
			"Say why the count differs from the expected amount",
		)
	}
	if reason != nil && (*reason == CountReasonUnknown || *reason == CountReasonOther) && note == "" {
		return CashCount{}, apperror.Invalid("Say what you found in the note")
	}
	var reasonText *string
	if reason != nil {
		text := string(*reason)
		reasonText = &text
	}
	if (reasonText == nil) != (row.Reason == nil) || (reasonText != nil && *reasonText != *row.Reason) {
		fields = append(fields, "reason")
	}
	if !expected.Equal(d(row.ExpectedAmount)) {
		fields = append(fields, "expectedAmount")
	}
	if !difference.Equal(d(row.Difference)) {
		fields = append(fields, "difference")
	}
	if len(fields) == 0 {
		return s.loadCashCount(ctx, q, row.ID)
	}
	from, until := earlier(row.CountedAt, at), later(row.CountedAt, at)
	before, hadBefore, err := lowestBalance(ctx, q, from)
	if err != nil {
		return CashCount{}, err
	}
	updated, err := q.UpdateCashCount(ctx, db.UpdateCashCountParams{
		ID:             row.ID,
		CountedAmount:  numeric(counted),
		ExpectedAmount: numeric(expected),
		Difference:     numeric(difference),
		Reason:         reasonText,
		Note:           note,
		CountedAt:      at,
	})
	if err != nil {
		return CashCount{}, databaseError(err)
	}
	if err = writeCashAudit(ctx, tx, p, "cash_count.updated", "cash_count", row.ID, requestID,
		countAuditMetadata(row), fields...); err != nil {
		return CashCount{}, err
	}
	if err = s.syncCountCorrection(ctx, tx, q, p, updated, correction, requestID); err != nil {
		return CashCount{}, err
	}
	if err = s.reconcileCounts(ctx, tx, q, p, from, until, row.ID, requestID); err != nil {
		return CashCount{}, err
	}
	if err = checkBalanceAfter(ctx, q, from, before, hadBefore); err != nil {
		return CashCount{}, err
	}
	result, err := s.loadCashCount(ctx, q, row.ID)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}

// DeleteCashCount deletes a count and its correction for good. The next count is recalculated without them.
func (s *Service) DeleteCashCount(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	deletion CashEntryDeletion,
	requestID *uuid.UUID,
) error {
	if err := require(
		p,
		authorization.PaymentsRead,
		authorization.CashMovementsRead,
		authorization.CashMovementsManage,
	); err != nil {
		return err
	}
	if deletion.ExpectedVersion < 1 {
		return apperror.Invalid("expectedVersion is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if err = q.LockCashRegister(ctx); err != nil {
		return err
	}
	row, err := q.GetCashCountForUpdate(ctx, id)
	if err != nil {
		return databaseError(err)
	}
	if row.Version != deletion.ExpectedVersion {
		return apperror.StaleWrite
	}
	before, hadBefore, err := lowestBalance(ctx, q, row.CountedAt)
	if err != nil {
		return err
	}
	correction, err := countCorrection(ctx, q, row.ID)
	if err != nil {
		return err
	}
	if correction != nil {
		if err = q.DeleteCashMovement(ctx, correction.ID); err != nil {
			return databaseError(err)
		}
		if err = writeCashAudit(ctx, tx, p, "cash_movement.deleted", "cash_movement", correction.ID, requestID,
			movementAuditMetadata(*correction)); err != nil {
			return err
		}
	}
	if err = q.DeleteCashCount(ctx, row.ID); err != nil {
		return databaseError(err)
	}
	if err = writeCashAudit(ctx, tx, p, "cash_count.deleted", "cash_count", row.ID, requestID,
		countAuditMetadata(row)); err != nil {
		return err
	}
	if err = s.reconcileCounts(ctx, tx, q, p, row.CountedAt, row.CountedAt, row.ID, requestID); err != nil {
		return err
	}
	if err = checkBalanceAfter(ctx, q, row.CountedAt, before, hadBefore); err != nil {
		return err
	}
	return databaseError(tx.Commit(ctx))
}
