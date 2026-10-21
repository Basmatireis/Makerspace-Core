package orders

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

const (
	// MaxOwnPaymentItems limits how many orders and jobs one own payment settles together.
	MaxOwnPaymentItems = 100
	// MaxOwnPaymentEntries limits the cash and card entries of one own payment.
	MaxOwnPaymentEntries = 10
)

const ownPaymentOperation = "payment.own"

// OwnPaymentInput pays the principal's own unpaid orders and jobs in full. Jobs are put on one new order first.
type OwnPaymentInput struct {
	OperationKey  uuid.UUID      `json:"operationKey"`
	OrderIDs      []uuid.UUID    `json:"orderIds"`
	JobIDs        []uuid.UUID    `json:"jobIds"`
	Payments      []PaymentInput `json:"payments"`
	ExpectedTotal string         `json:"expectedTotal"`
}

type OwnPaymentOrder struct {
	OrderID   uuid.UUID `json:"orderId"`
	Reference string    `json:"reference"`
	Amount    string    `json:"amount"`
}

type OwnPaymentResult struct {
	Total          string            `json:"total"`
	CreatedOrderID *uuid.UUID        `json:"createdOrderId"`
	Orders         []OwnPaymentOrder `json:"orders"`
}

var (
	errOrderNotPayable = apperror.Conflicting("order_not_payable", "The order is not one of your unpaid orders")
	errJobNotPayable   = apperror.Conflicting(
		"job_not_payable",
		"The job is not one of your priced jobs waiting for an order",
	)
	errTotalChanged = apperror.Conflicting(
		"payment_total_changed",
		"Your open balance changed; review it and pay again",
	)
)

// sortedUnique copies ids in ascending order, the order rows are locked in; false when an id repeats.
func sortedUnique(ids []uuid.UUID) ([]uuid.UUID, bool) {
	sorted := append([]uuid.UUID(nil), ids...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].String() < sorted[j].String() })
	for i := 1; i < len(sorted); i++ {
		if sorted[i] == sorted[i-1] {
			return nil, false
		}
	}
	return sorted, true
}

func validateOwnPayment(input OwnPaymentInput) (orderIDs, jobIDs []uuid.UUID, expected decimal.Decimal, err error) {
	count := len(input.OrderIDs) + len(input.JobIDs)
	if count == 0 || count > MaxOwnPaymentItems {
		return nil, nil, decimal.Zero, apperror.Invalid("Select between one and 100 orders and jobs")
	}
	if len(input.Payments) == 0 || len(input.Payments) > MaxOwnPaymentEntries {
		return nil, nil, decimal.Zero, apperror.Invalid("Enter between one and 10 payments")
	}
	orderIDs, uniqueOrders := sortedUnique(input.OrderIDs)
	jobIDs, uniqueJobs := sortedUnique(input.JobIDs)
	if !uniqueOrders || !uniqueJobs {
		return nil, nil, decimal.Zero, apperror.Invalid("Each order and job can be selected once")
	}
	if expected, err = parseAmount(input.ExpectedTotal, 2, true); err != nil {
		return nil, nil, decimal.Zero, err
	}
	references := map[string]bool{}
	for _, payment := range input.Payments {
		if payment.Method != PaymentCash && payment.Method != PaymentCard {
			return nil, nil, decimal.Zero, apperror.Invalid("Pay in cash or by card")
		}
		if payment.Method == PaymentCard {
			key := strings.TrimSpace(payment.ExternalSource) + "\x00" + strings.TrimSpace(payment.ExternalReference)
			if references[key] {
				return nil, nil, decimal.Zero, apperror.Invalid("Each card payment needs its own reference")
			}
			references[key] = true
		}
	}
	return orderIDs, jobIDs, expected, nil
}

// PayOwn settles the principal's own unpaid orders and jobs with one payment entry, in one transaction. Selected
// orders are paid in full; selected jobs are put on one new finalized order for the principal, which is paid in full
// too. The payment is recorded under the principal through the same receipt path as at the sales counter.
func (s *Service) PayOwn(
	ctx context.Context,
	p authorization.Principal,
	input OwnPaymentInput,
	requestID *uuid.UUID,
) (OwnPaymentResult, error) {
	if err := require(
		p,
		authorization.OrdersRead,
		authorization.PaymentsRead,
		authorization.PaymentsRecord,
	); err != nil {
		return OwnPaymentResult{}, err
	}
	// Putting jobs on an order is the same work as at the sales counter, with the same permissions.
	if len(input.JobIDs) > 0 {
		if err := require(p, authorization.OrdersWrite, authorization.OrdersFinalize); err != nil {
			return OwnPaymentResult{}, err
		}
	}
	orderIDs, jobIDs, expected, err := validateOwnPayment(input)
	if err != nil {
		return OwnPaymentResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return OwnPaymentResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	old, hash, err := beginOperation(ctx, q, p, input.OperationKey, ownPaymentOperation, input)
	if err != nil {
		return OwnPaymentResult{}, err
	}
	if old != nil {
		return s.ownPaymentResult(ctx, q, input.OperationKey, old.OrderID)
	}
	// Orders before jobs, each in ascending id order, as finalization and replacement lock them.
	targets := make([]db.Order, 0, len(orderIDs)+1)
	due := make([]decimal.Decimal, 0, len(orderIDs)+1)
	for _, id := range orderIDs {
		o, err := q.LockOrder(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return OwnPaymentResult{}, errOrderNotPayable
		}
		if err != nil {
			return OwnPaymentResult{}, err
		}
		if o.CustomerPersonID == nil || *o.CustomerPersonID != p.PersonID {
			return OwnPaymentResult{}, errOrderNotPayable
		}
		view, err := s.load(ctx, q, id)
		if err != nil {
			return OwnPaymentResult{}, err
		}
		amount := payableBalance(view)
		if !amount.IsPositive() {
			return OwnPaymentResult{}, errOrderNotPayable
		}
		targets = append(targets, o)
		due = append(due, amount)
	}
	var created *uuid.UUID
	if len(jobIDs) > 0 {
		o, err := s.orderOwnJobs(ctx, tx, p, jobIDs, requestID)
		if err != nil {
			return OwnPaymentResult{}, databaseError(err)
		}
		created = &o.ID
		targets = append(targets, o)
		due = append(due, d(o.TotalAmount))
	}
	total := decimal.Zero
	for _, amount := range due {
		total = total.Add(amount)
	}
	if !total.Equal(expected) {
		return OwnPaymentResult{}, errTotalChanged
	}
	if err = s.settleInFull(ctx, tx, p, targets, due, input, requestID); err != nil {
		return OwnPaymentResult{}, databaseError(err)
	}
	if err = finishOperation(ctx, q, p, input.OperationKey, ownPaymentOperation, hash, created, nil); err != nil {
		return OwnPaymentResult{}, err
	}
	result, err := s.ownPaymentResult(ctx, q, input.OperationKey, created)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}

// orderOwnJobs puts the principal's own jobs on one new order for them and finalizes it.
func (s *Service) orderOwnJobs(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	jobIDs []uuid.UUID,
	requestID *uuid.UUID,
) (db.Order, error) {
	q := db.New(tx)
	jobs, err := q.LockOwnPayableJobs(ctx, db.LockOwnPayableJobsParams{JobIds: jobIDs, PersonID: &p.PersonID})
	if err != nil {
		return db.Order{}, err
	}
	if len(jobs) != len(jobIDs) {
		return db.Order{}, errJobNotPayable
	}
	o, err := s.create(
		ctx,
		tx,
		p,
		OrderDraftInput{
			Customer:        &OrderCustomer{Kind: CustomerPerson, ID: p.PersonID},
			FulfillmentMode: FulfillmentImmediate,
		},
		nil,
		requestID,
	)
	if err != nil {
		return db.Order{}, err
	}
	for _, job := range jobs {
		if _, err = s.insertItem(
			ctx,
			tx,
			p,
			o,
			OrderItemInput{Kind: ItemMachineJob, MachineJobID: job.ID, ExpectedJobVersion: job.Version},
			requestID,
		); err != nil {
			return db.Order{}, err
		}
	}
	return s.finalize(ctx, tx, p, o, requestID)
}

// settleInFull pays each target its due amount from the payment entries in turn. A receipt settles one order, so an
// entry that spans orders becomes one receipt per order, numbered as parts of the entry.
func (s *Service) settleInFull(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	targets []db.Order,
	due []decimal.Decimal,
	input OwnPaymentInput,
	requestID *uuid.UUID,
) error {
	remaining := make([]decimal.Decimal, len(input.Payments))
	paid := decimal.Zero
	for i, payment := range input.Payments {
		amount, err := parseAmount(payment.Amount, 2, true)
		if err != nil {
			return err
		}
		remaining[i] = amount
		paid = paid.Add(amount)
	}
	total := decimal.Zero
	for _, amount := range due {
		total = total.Add(amount)
	}
	if !paid.Equal(total) {
		return apperror.New(
			http.StatusUnprocessableEntity,
			"payment_total_mismatch",
			"The payments must add up to exactly what is selected",
		)
	}
	entry := 0
	parts := make([]int16, len(input.Payments))
	for i, target := range targets {
		open := due[i]
		for open.IsPositive() {
			for !remaining[entry].IsPositive() {
				entry++
			}
			slice := decimal.Min(open, remaining[entry])
			payment := input.Payments[entry]
			payment.Amount = slice.StringFixed(2)
			parts[entry]++
			payment.splitPart = parts[entry]
			if _, err := s.receipt(ctx, tx, p, target, payment, input.OperationKey, requestID); err != nil {
				return err
			}
			open = open.Sub(slice)
			remaining[entry] = remaining[entry].Sub(slice)
		}
	}
	return nil
}

// ownPaymentResult reads what an own payment allocated, so a repeated request returns the same result.
func (s *Service) ownPaymentResult(
	ctx context.Context,
	q *db.Queries,
	operationKey uuid.UUID,
	created *uuid.UUID,
) (OwnPaymentResult, error) {
	rows, err := q.OperationAllocations(ctx, operationKey)
	if err != nil {
		return OwnPaymentResult{}, err
	}
	result := OwnPaymentResult{CreatedOrderID: created, Orders: make([]OwnPaymentOrder, 0, len(rows))}
	total := decimal.Zero
	for _, row := range rows {
		if row.OrderID == nil {
			continue
		}
		total = total.Add(d(row.Amount))
		result.Orders = append(
			result.Orders,
			OwnPaymentOrder{OrderID: *row.OrderID, Reference: row.OrderReference, Amount: money(row.Amount)},
		)
	}
	result.Total = total.StringFixed(2)
	return result, nil
}
