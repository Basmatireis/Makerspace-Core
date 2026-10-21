package orders

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// OwnRecentOrdersLimit is how many of the latest orders the personal dashboard lists.
const OwnRecentOrdersLimit = 5

// OwnOrder is an order of the principal as customer, reduced to what the personal dashboard shows.
type OwnOrder struct {
	ID                uuid.UUID
	Reference         string
	Status            OrderStatus
	CreatedAt         time.Time
	ItemSummary       string
	ItemCount         int
	NetCharge         string
	OutstandingAmount string
	SettlementState   SettlementState
	// Invoiced orders are settled by their external (wiRef) invoice, not by a payment.
	Invoiced bool
	Payable  bool
}

// payableBalance is what a person may pay of their own order: the outstanding amount of a finalized order that no
// external invoice request covers. Zero when nothing can be paid.
func payableBalance(o Order) decimal.Decimal {
	if o.Status != OrderFinalized || o.ActiveExternalRequestID != nil {
		return decimal.Zero
	}
	outstanding, err := decimal.NewFromString(o.OutstandingAmount)
	if err != nil || !outstanding.IsPositive() {
		return decimal.Zero
	}
	return outstanding
}

func ownOrder(o Order) OwnOrder {
	result := OwnOrder{
		ID:                o.ID,
		Reference:         o.Reference,
		Status:            o.Status,
		CreatedAt:         o.CreatedAt,
		NetCharge:         o.NetCharge,
		OutstandingAmount: o.OutstandingAmount,
		SettlementState:   o.SettlementState,
		Invoiced:          o.ActiveExternalRequestID != nil,
		Payable:           payableBalance(o).IsPositive(),
	}
	for _, item := range o.Items {
		if item.RemovedAt != nil {
			continue
		}
		if result.ItemCount == 0 {
			result.ItemSummary = item.Description
		}
		result.ItemCount++
	}
	return result
}

func (s *Service) ownOrders(ctx context.Context, q *db.Queries, orderIDs []uuid.UUID) ([]OwnOrder, error) {
	result := make([]OwnOrder, 0, len(orderIDs))
	for _, id := range orderIDs {
		o, err := s.load(ctx, q, id)
		if err != nil {
			return nil, err
		}
		result = append(result, ownOrder(o))
	}
	return result, nil
}

// OwnPayableOrders lists the principal's own orders they can still pay, newest first; never another person's.
func (s *Service) OwnPayableOrders(ctx context.Context, p authorization.Principal) ([]OwnOrder, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return nil, err
	}
	q := db.New(s.pool)
	orderIDs, err := q.ListOwnPayableOrderIDs(ctx, &p.PersonID)
	if err != nil {
		return nil, err
	}
	return s.ownOrders(ctx, q, orderIDs)
}

// OwnRecentOrders lists the principal's latest finalized or reversed orders, newest first.
func (s *Service) OwnRecentOrders(ctx context.Context, p authorization.Principal) ([]OwnOrder, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return nil, err
	}
	q := db.New(s.pool)
	orderIDs, err := q.ListOwnRecentOrderIDs(
		ctx,
		db.ListOwnRecentOrderIDsParams{PersonID: &p.PersonID, PageLimit: OwnRecentOrdersLimit},
	)
	if err != nil {
		return nil, err
	}
	return s.ownOrders(ctx, q, orderIDs)
}
