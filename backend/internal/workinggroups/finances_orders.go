package workinggroups

import (
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

const (
	MaxShopRunes        = 120
	MaxOrderPurchases   = 100
	MaxOrderListRows    = 200
	MaxBookingTextRunes = 160
	MaxBookingListRows  = 500
)

func uuidTexts(values []uuid.UUID) []string {
	texts := make([]string, 0, len(values))
	for _, v := range values {
		texts = append(texts, v.String())
	}
	return texts
}

func (s *Service) queryOrders(ctx context.Context, q *workinggroupsdb.Queries, id *uuid.UUID, limit int32) ([]PurchaseOrder, error) {
	rows, err := q.ListWorkingGroupPurchaseOrders(ctx, workinggroupsdb.ListWorkingGroupPurchaseOrdersParams{OrderID: id, RowLimit: limit})
	if err != nil {
		return nil, err
	}
	orderIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		orderIDs = append(orderIDs, row.ID)
	}
	members, err := q.ListWorkingGroupOrderPurchaseIDs(ctx, uuidTexts(orderIDs))
	if err != nil {
		return nil, err
	}
	byOrder := map[uuid.UUID][]uuid.UUID{}
	for _, m := range members {
		byOrder[m.OrderID] = append(byOrder[m.OrderID], m.ID)
	}
	items := make([]PurchaseOrder, 0, len(rows))
	for _, row := range rows {
		purchaseIDs := byOrder[row.ID]
		if purchaseIDs == nil {
			purchaseIDs = []uuid.UUID{}
		}
		items = append(items, PurchaseOrder{
			ID: row.ID, PeriodID: row.PeriodID, Shop: row.Shop, TotalAmount: moneyText(dbMoney(row.TotalAmount)),
			Status: row.Status, ProjectRequestID: row.ProjectRequestID, ProjectNumber: row.ProjectNumber,
			PurchaseIDs: purchaseIDs, HasInvoice: row.HasInvoice, CreatedAt: row.CreatedAt,
			ArrivedAt: timeValue(row.ArrivedAt), Version: row.Version,
		})
	}
	return items, nil
}

func (s *Service) loadOrder(ctx context.Context, q *workinggroupsdb.Queries, id uuid.UUID) (PurchaseOrder, error) {
	items, err := s.queryOrders(ctx, q, &id, 1)
	if err != nil {
		return PurchaseOrder{}, err
	}
	if len(items) == 0 {
		return PurchaseOrder{}, apperror.NotFound
	}
	return items[0], nil
}

// ListOrders lists the collective orders, newest first. Finance managers only.
func (s *Service) ListOrders(ctx context.Context, p authorization.Principal) ([]PurchaseOrder, bool, error) {
	if err := requireRead(p); err != nil {
		return nil, false, err
	}
	if err := requireFinance(p); err != nil {
		return nil, false, err
	}
	items, err := s.queryOrders(ctx, workinggroupsdb.New(s.pool), nil, MaxOrderListRows+1)
	if err != nil {
		return nil, false, err
	}
	truncated := len(items) > MaxOrderListRows
	if truncated {
		items = items[:MaxOrderListRows]
	}
	return items, truncated, nil
}

// GetOrder returns one collective order. Finance managers only.
func (s *Service) GetOrder(ctx context.Context, p authorization.Principal, id uuid.UUID) (PurchaseOrder, error) {
	if err := requireRead(p); err != nil {
		return PurchaseOrder{}, err
	}
	if err := requireFinance(p); err != nil {
		return PurchaseOrder{}, err
	}
	return s.loadOrder(ctx, workinggroupsdb.New(s.pool), id)
}

// CreateOrder places a collective order for approved central purchases of one period and sets them to ordered.
func (s *Service) CreateOrder(
	ctx context.Context,
	p authorization.Principal,
	input CreateOrderInput,
	requestID *uuid.UUID,
) (result PurchaseOrder, err error) {
	if err := requireRead(p); err != nil {
		return PurchaseOrder{}, err
	}
	if err := requireFinance(p); err != nil {
		return PurchaseOrder{}, err
	}
	shop, err := validateShortText(input.Shop, "shop", MaxShopRunes)
	if err != nil {
		return PurchaseOrder{}, err
	}
	purchaseIDs := uniqueIDs(input.PurchaseIDs)
	if len(purchaseIDs) == 0 || len(purchaseIDs) > MaxOrderPurchases {
		return PurchaseOrder{}, apperror.InvalidField("purchaseIds")
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		rows, err := q.LockWorkingGroupPurchasesForOrder(ctx, uuidTexts(purchaseIDs))
		if err != nil {
			return err
		}
		if len(rows) != len(purchaseIDs) {
			return apperror.NotFound
		}
		total := decimal.Zero
		periodID := rows[0].PeriodID
		for _, row := range rows {
			if row.Status != PurchaseApproved || row.How != HowCentral {
				return withDetail(apperror.Conflicting("purchase_not_orderable", "Only approved purchases that are bought centrally can be ordered"),
					"purchaseId", row.ID)
			}
			if row.PeriodID != periodID {
				return apperror.New(http.StatusUnprocessableEntity, "purchases_mixed_periods", "The purchases belong to different budget periods")
			}
			total = total.Add(dbMoney(row.EstimatedTotal))
		}
		period, err := q.ShareLockWorkingGroupBudgetPeriod(ctx, periodID)
		if err != nil {
			return err
		}
		if period.ClosedAt.Valid {
			return periodClosedError()
		}
		rules, err := q.GetWorkingGroupFinanceRules(ctx)
		if err != nil {
			return err
		}
		var number *string
		if input.ProjectRequestID == nil && total.GreaterThanOrEqual(dbMoney(rules.ProjectThreshold)) {
			return apperror.New(http.StatusUnprocessableEntity, "project_request_required", "An order of this amount needs a project request")
		}
		if input.ProjectRequestID != nil {
			request, err := q.GetWorkingGroupProjectRequest(ctx, *input.ProjectRequestID)
			if err != nil {
				if errors.Is(noRows(err), apperror.NotFound) {
					return apperror.New(http.StatusUnprocessableEntity, "project_request_unknown", "The project request does not exist")
				}
				return err
			}
			number = &request.Number
		}
		id := ids.New()
		if err := q.CreateWorkingGroupPurchaseOrder(ctx, workinggroupsdb.CreateWorkingGroupPurchaseOrderParams{
			ID: id, PeriodID: periodID, Shop: shop, TotalAmount: moneyText(total),
			ProjectRequestID: input.ProjectRequestID, ProjectNumber: number,
		}); err != nil {
			if isForeignKeyViolation(err) {
				return apperror.New(http.StatusUnprocessableEntity, "project_request_unknown", "The project request does not exist")
			}
			return err
		}
		if _, err := q.MarkWorkingGroupPurchasesOrdered(ctx, workinggroupsdb.MarkWorkingGroupPurchasesOrderedParams{
			OrderID: &id, Ids: uuidTexts(purchaseIDs),
		}); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_purchase_order.created", "working_group_purchase_order", id, requestID,
			[]string{"shop", "purchaseIds", "projectRequestId"}); err != nil {
			return err
		}
		for _, purchaseID := range purchaseIDs {
			if err := writeTaskAudit(ctx, tx, p, "working_group_purchase.ordered", "working_group_purchase", purchaseID, requestID, []string{"status"}); err != nil {
				return err
			}
		}
		result, err = s.loadOrder(ctx, q, id)
		return err
	})
	return result, err
}

// MarkOrderArrived records the arrival of an order and sets its purchases that are still ordered to received.
func (s *Service) MarkOrderArrived(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (result PurchaseOrder, err error) {
	if err := requireRead(p); err != nil {
		return PurchaseOrder{}, err
	}
	if err := requireFinance(p); err != nil {
		return PurchaseOrder{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		order, err := q.LockWorkingGroupPurchaseOrder(ctx, id)
		if err != nil {
			return noRows(err)
		}
		period, err := q.ShareLockWorkingGroupBudgetPeriod(ctx, order.PeriodID)
		if err != nil {
			return err
		}
		if expected < 1 {
			return apperror.Invalid("expectedVersion must be positive")
		}
		if period.ClosedAt.Valid {
			return periodClosedError()
		}
		if order.Version != expected {
			return apperror.StaleWrite
		}
		if order.Status != "ordered" {
			return apperror.Conflicting("working_group_order_state", "The order has already arrived")
		}
		if err := q.MarkWorkingGroupPurchaseOrderArrived(ctx, id); err != nil {
			return err
		}
		received, err := q.ReceiveWorkingGroupOrderPurchases(ctx, &id)
		if err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_purchase_order.arrived", "working_group_purchase_order", id, requestID, []string{"status"}); err != nil {
			return err
		}
		for _, purchaseID := range received {
			if err := writeTaskAudit(ctx, tx, p, "working_group_purchase.received", "working_group_purchase", purchaseID, requestID, []string{"status"}); err != nil {
				return err
			}
		}
		result, err = s.loadOrder(ctx, q, id)
		return err
	})
	return result, err
}

// SetOrderInvoice attaches the invoice to an order, replacing an earlier file.
func (s *Service) SetOrderInvoice(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	upload FileUpload,
	requestID *uuid.UUID,
) (result PurchaseOrder, err error) {
	if err := requireRead(p); err != nil {
		return PurchaseOrder{}, err
	}
	if err := requireFinance(p); err != nil {
		return PurchaseOrder{}, err
	}
	if _, err := s.loadOrder(ctx, workinggroupsdb.New(s.pool), id); err != nil {
		return PurchaseOrder{}, err
	}
	stored, err := s.storeFile(ctx, p, upload, requestID)
	if err != nil {
		return PurchaseOrder{}, err
	}
	var replaced *uuid.UUID
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		order, err := q.LockWorkingGroupPurchaseOrder(ctx, id)
		if err != nil {
			return noRows(err)
		}
		period, err := q.ShareLockWorkingGroupBudgetPeriod(ctx, order.PeriodID)
		if err != nil {
			return err
		}
		if period.ClosedAt.Valid {
			return periodClosedError()
		}
		fileID := stored.ID
		if err := q.SetWorkingGroupPurchaseOrderInvoice(ctx, workinggroupsdb.SetWorkingGroupPurchaseOrderInvoiceParams{ID: id, FileID: &fileID}); err != nil {
			return err
		}
		replaced = order.InvoiceFileID
		if err := writeTaskAudit(ctx, tx, p, "working_group_purchase_order.invoice_set", "working_group_purchase_order", id, requestID, []string{"invoice"}); err != nil {
			return err
		}
		result, err = s.loadOrder(ctx, q, id)
		return err
	})
	if err != nil {
		s.discardFiles(&stored.ID)
		return PurchaseOrder{}, err
	}
	s.discardFiles(replaced)
	return result, nil
}

// OpenOrderInvoice opens the invoice of an order. Finance managers only.
func (s *Service) OpenOrderInvoice(ctx context.Context, p authorization.Principal, id uuid.UUID) (files.File, io.ReadCloser, error) {
	if err := requireRead(p); err != nil {
		return files.File{}, nil, err
	}
	if err := requireFinance(p); err != nil {
		return files.File{}, nil, err
	}
	fileID, err := workinggroupsdb.New(s.pool).GetWorkingGroupPurchaseOrderInvoice(ctx, id)
	if err != nil {
		return files.File{}, nil, noRows(err)
	}
	return s.openFile(ctx, fileID)
}

// ListBookings lists direct bookings, newest first: every booking for finance managers, those of the caller's groups
// for members.
func (s *Service) ListBookings(ctx context.Context, p authorization.Principal, groupID, periodID *uuid.UUID) ([]Booking, bool, error) {
	if err := requireRead(p); err != nil {
		return nil, false, err
	}
	items, err := s.queryBookings(ctx, workinggroupsdb.New(s.pool), p, nil, groupID, periodID, MaxBookingListRows+1)
	if err != nil {
		return nil, false, err
	}
	truncated := len(items) > MaxBookingListRows
	if truncated {
		items = items[:MaxBookingListRows]
	}
	return items, truncated, nil
}

func (s *Service) queryBookings(
	ctx context.Context,
	q *workinggroupsdb.Queries,
	p authorization.Principal,
	id, groupID, periodID *uuid.UUID,
	limit int32,
) ([]Booking, error) {
	rows, err := q.ListWorkingGroupBookings(ctx, workinggroupsdb.ListWorkingGroupBookingsParams{
		CallerFinance: isFinance(p), CallerPersonID: p.PersonID, BookingID: id, GroupID: groupID, PeriodID: periodID, RowLimit: limit,
	})
	if err != nil {
		return nil, err
	}
	items := make([]Booking, 0, len(rows))
	for _, row := range rows {
		items = append(items, Booking{
			ID: row.ID, GroupID: row.GroupID, GroupName: row.GroupName, PeriodID: row.PeriodID, Text: row.Text,
			Amount: moneyText(dbMoney(row.Amount)), BookedOn: day(row.BookedOn.Time), CreatedAt: row.CreatedAt,
		})
	}
	return items, nil
}

// CreateBooking books a cost directly against the budget of a group in an open period. Finance managers only.
func (s *Service) CreateBooking(
	ctx context.Context,
	p authorization.Principal,
	input CreateBookingInput,
	requestID *uuid.UUID,
) (result Booking, err error) {
	if err := requireRead(p); err != nil {
		return Booking{}, err
	}
	if err := requireFinance(p); err != nil {
		return Booking{}, err
	}
	text, err := validateShortText(input.Text, "text", MaxBookingTextRunes)
	if err != nil {
		return Booking{}, err
	}
	amount, err := parseMoney(input.Amount, "amount")
	if err != nil {
		return Booking{}, err
	}
	if input.BookedOn.IsZero() {
		return Booking{}, apperror.InvalidField("bookedOn")
	}
	bookedOn := day(input.BookedOn)
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		// Group before period, like every change that books into a period.
		if _, err := q.LockWorkingGroup(ctx, input.GroupID); err != nil {
			return noRows(err)
		}
		period, err := q.ShareLockWorkingGroupBudgetPeriod(ctx, input.PeriodID)
		if err != nil {
			return noRows(err)
		}
		if period.ClosedAt.Valid {
			return periodClosedError()
		}
		id := ids.New()
		if err := q.CreateWorkingGroupBooking(ctx, workinggroupsdb.CreateWorkingGroupBookingParams{
			ID: id, GroupID: input.GroupID, PeriodID: input.PeriodID, Text: text, Amount: moneyText(amount), BookedOn: dateParam(&bookedOn),
		}); err != nil {
			return err
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_booking.created", "working_group_booking", id, requestID,
			[]string{"groupId", "periodId", "text", "amount", "bookedOn"}); err != nil {
			return err
		}
		items, err := s.queryBookings(ctx, q, p, &id, nil, nil, 1)
		if err != nil || len(items) == 0 {
			return err
		}
		result = items[0]
		return nil
	})
	return result, err
}

// DeleteBooking removes a direct booking from an open period. Finance managers only.
func (s *Service) DeleteBooking(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	if err := requireFinance(p); err != nil {
		return err
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		periodID, err := q.GetWorkingGroupBookingPeriod(ctx, id)
		if err != nil {
			return noRows(err)
		}
		period, err := q.ShareLockWorkingGroupBudgetPeriod(ctx, periodID)
		if err != nil {
			return err
		}
		if period.ClosedAt.Valid {
			return periodClosedError()
		}
		removed, err := q.DeleteWorkingGroupBooking(ctx, id)
		if err != nil {
			return err
		}
		if removed == 0 {
			return apperror.NotFound
		}
		return writeTaskAudit(ctx, tx, p, "working_group_booking.deleted", "working_group_booking", id, requestID, nil)
	})
}

// CheckOrderUpload is the refusal an upload handler runs before it reads the body.
func (s *Service) CheckOrderUpload(ctx context.Context, p authorization.Principal, id uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	if err := requireFinance(p); err != nil {
		return err
	}
	_, err := s.loadOrder(ctx, workinggroupsdb.New(s.pool), id)
	return err
}

// RemoveOrderInvoice deletes the invoice file of an order, in any period. Finance managers only.
func (s *Service) RemoveOrderInvoice(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	if err := requireFinance(p); err != nil {
		return err
	}
	var replaced *uuid.UUID
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		order, err := q.LockWorkingGroupPurchaseOrder(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if order.InvoiceFileID == nil {
			return apperror.NotFound
		}
		replaced = order.InvoiceFileID
		if err := q.SetWorkingGroupPurchaseOrderInvoice(ctx, workinggroupsdb.SetWorkingGroupPurchaseOrderInvoiceParams{ID: id}); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_purchase_order.invoice_removed", "working_group_purchase_order", id, requestID, []string{"invoice"})
	})
	if err == nil {
		s.discardFiles(replaced)
	}
	return err
}

// RedactBooking replaces the text of a direct booking with "Removed", in any period. Finance managers only.
func (s *Service) RedactBooking(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (result Booking, err error) {
	if err := requireRead(p); err != nil {
		return Booking{}, err
	}
	if err := requireFinance(p); err != nil {
		return Booking{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		changed, err := q.RedactWorkingGroupBooking(ctx, id)
		if err != nil {
			return err
		}
		if changed == 0 {
			return apperror.NotFound
		}
		if err := writeTaskAudit(ctx, tx, p, "working_group_booking.redacted", "working_group_booking", id, requestID, []string{"text"}); err != nil {
			return err
		}
		items, err := s.queryBookings(ctx, q, p, &id, nil, nil, 1)
		if err != nil || len(items) == 0 {
			return err
		}
		result = items[0]
		return nil
	})
	return result, err
}
