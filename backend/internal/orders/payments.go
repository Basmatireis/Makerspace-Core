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
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// syncAlreadyPaid keeps the cash and card figure of a draft invoice request in step with the order's payments.
// From submission on the figure is frozen (payments are refused), so only drafts are touched.
func (s *Service) syncAlreadyPaid(ctx context.Context, q *db.Queries, orderID uuid.UUID) error {
	r, err := q.ActiveRequest(ctx, &orderID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && InvoiceState(r.State) != InvoiceDraft) {
		return nil
	}
	if err != nil {
		return err
	}
	paid, err := q.SumCashCardAllocations(ctx, &orderID)
	if err != nil {
		return err
	}
	return q.SetRequestAlreadyPaid(ctx, db.SetRequestAlreadyPaidParams{RequestID: r.ID, AlreadyPaid: paid})
}

func (s *Service) allocate(
	ctx context.Context,
	q *db.Queries,
	p authorization.Principal,
	payment db.Payment,
	o db.Order,
	amount decimal.Decimal,
	op uuid.UUID,
) error {
	return q.InsertAllocation(
		ctx,
		db.InsertAllocationParams{
			ID:               ids.New(),
			PaymentID:        &payment.ID,
			PaymentReference: payment.Reference,
			OrderID:          &o.ID,
			OrderReference:   o.Reference,
			Amount:           numeric(amount),
			OperationID:      op,
			ActorAccountID:   &p.AccountID,
		},
	)
}

func (s *Service) receipt(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	o db.Order,
	input PaymentInput,
	op uuid.UUID,
	requestID *uuid.UUID,
) (db.Payment, error) {
	if err := require(p, authorization.PaymentsRead, authorization.PaymentsRecord); err != nil {
		return db.Payment{}, err
	}
	if OrderStatus(o.Status) != OrderFinalized {
		return db.Payment{}, apperror.Conflicting("order_not_finalized", "Payments require a finalized order")
	}
	if input.Method == PaymentExternal {
		return db.Payment{}, apperror.Conflicting(
			"invoice_settles_balance",
			"An issued wiRef invoice settles the open balance by itself; it cannot be recorded as a payment",
		)
	}
	q := db.New(tx)
	amount, err := parseAmount(input.Amount, 2, true)
	if err != nil {
		return db.Payment{}, err
	}
	if input.OccurredAt.IsZero() {
		return db.Payment{}, apperror.Invalid("Payment occurrence time is required")
	}
	if input.Method != PaymentCash && input.Method != PaymentCard {
		return db.Payment{}, apperror.Invalid("Unsupported payment method")
	}
	if input.Method == PaymentCard &&
		(strings.TrimSpace(input.ExternalSource) == "" || strings.TrimSpace(input.ExternalReference) == "") {
		return db.Payment{}, apperror.Invalid("Card terminal and transaction references are required")
	}
	// The request states what was already paid. From submission on that figure is frozen, until the request is returned or cancelled.
	if r, e := q.ActiveRequest(ctx, &o.ID); e == nil {
		if InvoiceState(r.State) != InvoiceDraft {
			return db.Payment{}, apperror.Conflicting(
				"invoice_amount_frozen",
				"The wiRef request "+r.Reference+" states what was already paid; return or cancel it before recording cash or card",
			)
		}
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return db.Payment{}, e
	}
	receipts, err := q.ActiveReceipts(ctx, &o.ID)
	if err != nil {
		return db.Payment{}, err
	}
	for _, v := range receipts {
		if PaymentMethod(v.Method) == PaymentExternal {
			return db.Payment{}, apperror.Conflicting(
				"settlement_workflow_conflict",
				"Cash/card cannot be added while an external invoice payment is active",
			)
		}
	}
	balance, err := q.SumAllocations(ctx, &o.ID)
	if err != nil {
		return db.Payment{}, err
	}
	if amount.GreaterThan(d(o.TotalAmount).Sub(d(balance))) {
		return db.Payment{}, apperror.Conflicting("payment_exceeds_outstanding", "Payment exceeds outstanding amount")
	}
	n, err := q.NextPaymentReference(ctx)
	if err != nil {
		return db.Payment{}, err
	}
	payment, err := q.InsertPayment(
		ctx,
		db.InsertPaymentParams{
			ID:                ids.New(),
			Reference:         reference("P", n),
			EntryKind:         string(EntryReceipt),
			Method:            string(input.Method),
			Amount:            numeric(amount),
			OccurredAt:        input.OccurredAt.UTC(),
			ActorAccountID:    &p.AccountID,
			ExternalSource:    strings.TrimSpace(input.ExternalSource),
			ExternalReference: strings.TrimSpace(input.ExternalReference),
		},
	)
	if err != nil {
		return payment, databaseError(err)
	}
	if err = s.allocate(ctx, q, p, payment, o, amount, op); err != nil {
		return payment, err
	}
	if err = q.BumpOrder(ctx, o.ID); err != nil {
		return payment, err
	}
	if err = s.syncAlreadyPaid(ctx, q, o.ID); err != nil {
		return payment, err
	}
	return payment, writeAudit(
		ctx,
		tx,
		p,
		"payment.recorded",
		"payment",
		payment.ID,
		requestID,
		"amount",
		"method",
		"allocations",
	)
}

func (s *Service) reverseReceipt(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	o db.Order,
	input PaymentReversalInput,
	op uuid.UUID,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.PaymentsRead, authorization.PaymentsReverse); err != nil {
		return err
	}
	q := db.New(tx)
	original, err := q.LockPayment(ctx, input.PaymentID)
	if err != nil {
		return databaseError(err)
	}
	if PaymentEntryKind(original.EntryKind) != EntryReceipt {
		return apperror.Invalid("Only original receipts can be reversed")
	}
	reversed, err := q.PaymentReversalExists(ctx, &original.ID)
	if err != nil {
		return err
	}
	if reversed {
		return apperror.Conflicting("payment_already_reversed", "Payment was already reversed")
	}
	allocated, err := q.AllocatedOrderID(ctx, &original.ID)
	if err != nil {
		return databaseError(err)
	}
	if allocated == nil || *allocated != o.ID {
		return apperror.Conflicting("payment_allocation_changed", "Payment is no longer allocated to this order")
	}
	reason := strings.TrimSpace(input.Reason)
	if reason == "" || len(reason) > 500 || input.OccurredAt.IsZero() {
		return apperror.Invalid("Reason and occurrence time are required")
	}
	if PaymentMethod(original.Method) == PaymentExternal {
		if input.ReasonKind != ReversalExternalCorrection || strings.TrimSpace(input.ExternalReference) == "" {
			return apperror.Invalid("External accounting correction evidence is required")
		}
		r, e := q.LatestRequest(ctx, &o.ID)
		if e != nil || InvoiceState(r.State) != InvoiceCancelled {
			return apperror.Conflicting(
				"external_reconciliation_required",
				"Confirm external cancellation/correction first",
			)
		}
	} else {
		if input.ReasonKind != ReversalRefund && input.ReasonKind != ReversalRecordingError {
			return apperror.Invalid("Select refund or recording error")
		}
		if r, e := q.ActiveRequest(ctx, &o.ID); e == nil {
			if InvoiceState(r.State) != InvoiceDraft {
				return apperror.Conflicting(
					"invoice_amount_frozen",
					"The wiRef request "+r.Reference+" states what was already paid; return or cancel it first",
				)
			}
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
	}
	occurred := input.OccurredAt.UTC()
	if input.ReasonKind == ReversalRecordingError {
		occurred = original.OccurredAt
	}
	n, err := q.NextPaymentReference(ctx)
	if err != nil {
		return err
	}
	v, err := q.InsertPayment(
		ctx,
		db.InsertPaymentParams{
			ID:                       ids.New(),
			Reference:                reference("P", n),
			EntryKind:                string(EntryReversal),
			Method:                   original.Method,
			Amount:                   original.Amount,
			OccurredAt:               occurred,
			ActorAccountID:           &p.AccountID,
			ReversesPaymentID:        &original.ID,
			ReversedPaymentReference: &original.Reference,
			ReversalReasonKind:       reversalReasonText(input.ReasonKind),
			Reason:                   reason,
			ExternalSource:           original.ExternalSource,
			ExternalReference:        input.ExternalReference,
			ExternalInvoiceRequestID: original.ExternalInvoiceRequestID,
		},
	)
	if PaymentMethod(original.Method) == PaymentCard && input.ExternalReference == "" {
		return apperror.Invalid("Card refund/correction reference is required")
	}
	if err != nil {
		return databaseError(err)
	}
	if err = s.allocate(ctx, q, p, original, o, d(original.Amount).Neg(), op); err != nil {
		return err
	}
	if err = q.BumpOrder(ctx, o.ID); err != nil {
		return err
	}
	if err = s.syncAlreadyPaid(ctx, q, o.ID); err != nil {
		return err
	}
	return writeAudit(ctx, tx, p, "payment.reversed", "payment", v.ID, requestID, "reversal", "allocations")
}

func (s *Service) RecordPayment(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input RecordOrderPayment,
	requestID *uuid.UUID,
) (Order, error) {
	if err := require(
		p,
		authorization.OrdersRead,
		authorization.PaymentsRead,
		authorization.PaymentsRecord,
	); err != nil {
		return Order{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	old, hash, err := beginOperation(ctx, q, p, input.OperationKey, "payment.record", struct {
		ID    uuid.UUID
		Input RecordOrderPayment
	}{id, input})
	if err != nil {
		return Order{}, err
	}
	if old != nil {
		if old.OrderID == nil {
			return Order{}, apperror.Conflicting("operation_expired", "Operation source is unavailable")
		}
		return s.load(ctx, q, *old.OrderID)
	}
	o, err := q.LockOrder(ctx, id)
	if err != nil {
		return Order{}, databaseError(err)
	}
	if err = checkVersion(o, input.ExpectedVersion); err != nil {
		return Order{}, err
	}
	if _, err = s.receipt(ctx, tx, p, o, input.Payment, input.OperationKey, requestID); err != nil {
		return Order{}, err
	}
	if err = finishOperation(ctx, q, p, input.OperationKey, "payment.record", hash, &id, nil); err != nil {
		return Order{}, err
	}
	result, err := s.load(ctx, q, id)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}

func (s *Service) ReversePayment(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input ReversePaymentCommand,
	requestID *uuid.UUID,
) (Order, error) {
	if err := require(
		p,
		authorization.OrdersRead,
		authorization.PaymentsRead,
		authorization.PaymentsReverse,
	); err != nil {
		return Order{}, err
	}
	if input.Reversal.PaymentID != id {
		return Order{}, apperror.Invalid("Reversal payment ID does not match resource")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	old, hash, err := beginOperation(ctx, q, p, input.OperationKey, "payment.reverse", struct {
		ID    uuid.UUID
		Input ReversePaymentCommand
	}{id, input})
	if err != nil {
		return Order{}, err
	}
	if old != nil && old.OrderID != nil {
		return s.load(ctx, q, *old.OrderID)
	}
	orderID, err := q.AllocatedOrderID(ctx, &id)
	if err != nil || orderID == nil {
		return Order{}, apperror.Conflicting("payment_already_reversed", "No current allocation exists")
	}
	o, err := q.LockOrder(ctx, *orderID)
	if err != nil {
		return Order{}, databaseError(err)
	}
	if err = checkVersion(o, input.ExpectedVersion); err != nil {
		return Order{}, err
	}
	if err = s.reverseReceipt(ctx, tx, p, o, input.Reversal, input.OperationKey, requestID); err != nil {
		return Order{}, err
	}
	if input.ReplacementPayment != nil {
		if _, err = s.receipt(ctx, tx, p, o, *input.ReplacementPayment, input.OperationKey, requestID); err != nil {
			return Order{}, err
		}
	}
	if err = s.checkAnonymous(ctx, q, o); err != nil {
		return Order{}, err
	}
	if err = finishOperation(ctx, q, p, input.OperationKey, "payment.reverse", hash, &o.ID, nil); err != nil {
		return Order{}, err
	}
	result, err := s.load(ctx, q, o.ID)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}
func (s *Service) checkAnonymous(ctx context.Context, q *db.Queries, o db.Order) error {
	if CustomerKind(o.CustomerKind) != CustomerAnonymous {
		return nil
	}
	balance, err := q.SumAllocations(ctx, &o.ID)
	if err != nil {
		return err
	}
	if FulfillmentMode(o.FulfillmentMode) != FulfillmentImmediate || !d(balance).Equal(d(o.TotalAmount)) {
		return apperror.Conflicting(
			"anonymous_requires_full_settlement",
			"Anonymous sales require immediate fulfillment and full settlement",
		)
	}
	return nil
}
func (s *Service) loadPayment(ctx context.Context, q *db.Queries, id uuid.UUID) (OrderPayment, error) {
	r, err := q.GetPayment(ctx, id)
	if err != nil {
		return OrderPayment{}, databaseError(err)
	}
	v := OrderPayment{
		ID:                       r.ID,
		Reference:                r.Reference,
		EntryKind:                PaymentEntryKind(r.EntryKind),
		Method:                   PaymentMethod(r.Method),
		Amount:                   money(r.Amount),
		OccurredAt:               r.OccurredAt,
		RecordedAt:               r.RecordedAt,
		ReversesPaymentID:        r.ReversesPaymentID,
		ReversedPaymentReference: r.ReversedPaymentReference,
		ReasonKind:               reversalReasonFromText(r.ReversalReasonKind),
		Reason:                   r.Reason,
		ExternalSource:           r.ExternalSource,
		ExternalReference:        r.ExternalReference,
		Allocations:              []OrderAllocation{},
	}
	if v.RecordedBy, err = s.actor(ctx, q, r.ActorAccountID); err != nil {
		return v, err
	}
	a, err := q.PaymentAllocations(ctx, &id)
	if err != nil {
		return v, err
	}
	for _, entry := range a {
		v.Allocations = append(v.Allocations, allocation(entry))
	}
	return v, nil
}
func (s *Service) GetPayment(ctx context.Context, p authorization.Principal, id uuid.UUID) (OrderPayment, error) {
	if err := require(p, authorization.PaymentsRead); err != nil {
		return OrderPayment{}, err
	}
	return s.loadPayment(ctx, db.New(s.pool), id)
}
func nullableTime(v *time.Time) pgtype.Timestamptz {
	if v == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: v.UTC(), Valid: true}
}

func (s *Service) ListPayments(
	ctx context.Context,
	p authorization.Principal,
	method string,
	from, to *time.Time,
	page, size int,
) (OrderPaymentPage, error) {
	if err := require(p, authorization.PaymentsRead); err != nil {
		return OrderPaymentPage{}, err
	}
	limit, offset, err := pageBounds(page, size)
	if err != nil {
		return OrderPaymentPage{}, err
	}
	q := db.New(s.pool)
	rows, err := q.ListPayments(
		ctx,
		db.ListPaymentsParams{
			Method:     method,
			FromTime:   nullableTime(from),
			ToTime:     nullableTime(to),
			PageLimit:  limit,
			PageOffset: offset,
		},
	)
	if err != nil {
		return OrderPaymentPage{}, err
	}
	v := OrderPaymentPage{Items: []OrderPayment{}, Page: int64(page), PageSize: int64(size)}
	v.Total, err = q.CountPayments(
		ctx,
		db.CountPaymentsParams{Method: method, FromTime: nullableTime(from), ToTime: nullableTime(to)},
	)
	if err != nil {
		return v, err
	}
	for _, row := range rows {
		payment, e := s.loadPayment(ctx, q, row.ID)
		if e != nil {
			return v, e
		}
		v.Items = append(v.Items, payment)
	}
	return v, nil
}

func (s *Service) Reconciliation(
	ctx context.Context,
	p authorization.Principal,
	method string,
	from, to *time.Time,
	page, size int,
) (PaymentReconciliation, error) {
	v, err := s.ListPayments(ctx, p, method, from, to, page, size)
	if err != nil {
		return PaymentReconciliation{}, err
	}
	result := PaymentReconciliation{
		Cash:     "0.00",
		Card:     "0.00",
		External: "0.00",
		Entries:  v.Items,
		Page:     v.Page,
		PageSize: v.PageSize,
		Total:    v.Total,
	}
	rows, err := db.New(s.pool).
		ReconciliationTotals(ctx, db.ReconciliationTotalsParams{FromTime: nullableTime(from), ToTime: nullableTime(to)})
	if err != nil {
		return result, err
	}
	for _, r := range rows {
		switch PaymentMethod(r.Method) {
		case PaymentCash:
			result.Cash = money(r.Amount)
		case PaymentCard:
			result.Card = money(r.Amount)
		case PaymentExternal:
			result.External = money(r.Amount)
		}
	}
	return result, nil
}
