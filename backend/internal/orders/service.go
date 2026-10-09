package orders

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

type Service struct {
	pool *pgxpool.Pool
	jobs *machinelogbook.Service
}

func NewService(pool *pgxpool.Pool, jobs *machinelogbook.Service) *Service {
	return &Service{pool, jobs}
}
func require(p authorization.Principal, perms ...authorization.Permission) error {
	for _, v := range perms {
		if !p.Has(v) {
			return apperror.PermissionDenied
		}
	}
	return nil
}
func validation(m string) error     { return apperror.New(422, "validation_failed", m) }
func conflict(code, m string) error { return apperror.New(409, code, m) }
func databaseError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	var e *pgconn.PgError
	if errors.As(err, &e) {
		switch e.Code {
		case "22003":
			return validation("Financial amount exceeds supported precision")
		case "23505":
			return conflict("already_exists", "A conflicting financial record exists")
		case "23503", "23514":
			return conflict("financial_integrity_conflict", "The financial operation conflicts with retained records")
		}
	}
	return err
}
func newID() uuid.UUID { return uuid.Must(uuid.NewV7()) }
func reference(prefix string, n int64) string {
	return fmt.Sprintf("%s-%04d-%06d", prefix, time.Now().UTC().Year(), n)
}
func d(n pgtype.Numeric) decimal.Decimal {
	if !n.Valid {
		return decimal.Zero
	}
	return decimal.NewFromBigInt(n.Int, n.Exp)
}
func numeric(v decimal.Decimal) pgtype.Numeric {
	return pgtype.Numeric{Int: v.Coefficient(), Exp: v.Exponent(), Valid: true}
}
func money(n pgtype.Numeric) string { return d(n).StringFixed(2) }

var decimalPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`)

func parseAmount(v string, scale int32, positive bool) (decimal.Decimal, error) {
	if !decimalPattern.MatchString(v) {
		return decimal.Zero, validation("A nonnegative decimal string is required")
	}
	x, e := decimal.NewFromString(v)
	if e != nil || x.Exponent() < -scale || x.GreaterThanOrEqual(decimal.New(1, 20-scale)) || (positive && !x.IsPositive()) {
		return decimal.Zero, validation("Amount exceeds supported precision or must be positive")
	}
	return x, nil
}
func timePointer(v pgtype.Timestamptz) *time.Time {
	if !v.Valid {
		return nil
	}
	return &v.Time
}
func pageBounds(page, size int) (int32, int32, error) {
	if page < 1 || size < 1 || size > 100 || page > 21474836 {
		return 0, 0, validation("Invalid pagination")
	}
	return int32(size), int32((page - 1) * size), nil
}
func writeAudit(ctx context.Context, tx pgx.Tx, p authorization.Principal, action, resource string, id uuid.UUID, requestID *uuid.UUID, fields ...string) error {
	return audit.Write(ctx, tx, audit.Event{ActorAccountID: &p.AccountID, Action: action, ResourceType: resource, ResourceID: &id, RequestID: requestID, ChangedFields: fields})
}
func checkVersion(o db.Order, expected int64) error {
	if expected < 1 {
		return validation("expectedVersion is required")
	}
	if o.Version != expected {
		return apperror.StaleWrite
	}
	return nil
}
func draft(o db.Order) error {
	if o.Status != "draft" {
		return conflict("order_not_draft", "Only draft orders may be edited")
	}
	return nil
}

// beginOperation serializes retries before checking versions. No request payload is persisted.
func beginOperation(ctx context.Context, q *db.Queries, p authorization.Principal, key uuid.UUID, kind string, input any) (*db.OrderOperation, []byte, error) {
	if key == uuid.Nil {
		return nil, nil, validation("operationKey is required")
	}
	encoded, err := json.Marshal(struct {
		Actor uuid.UUID
		Kind  string
		Input any
	}{p.AccountID, kind, input})
	if err != nil {
		return nil, nil, err
	}
	sum := sha256.Sum256(encoded)
	if err = q.LockOperation(ctx, key.String()); err != nil {
		return nil, nil, err
	}
	op, err := q.GetOperation(ctx, key)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, sum[:], nil
	}
	if err != nil {
		return nil, nil, err
	}
	if op.Kind != kind || !bytes.Equal(op.RequestFingerprint, sum[:]) {
		return nil, nil, conflict("idempotency_conflict", "Operation key was used for different input")
	}
	return &op, sum[:], nil
}
func finishOperation(ctx context.Context, q *db.Queries, p authorization.Principal, key uuid.UUID, kind string, hash []byte, orderID, requestID *uuid.UUID) error {
	return q.SaveOperation(ctx, db.SaveOperationParams{ID: newID(), OperationKey: key, Kind: kind, RequestFingerprint: hash, ActorAccountID: &p.AccountID, OrderID: orderID, RequestID: requestID})
}
func (s *Service) validateCustomer(ctx context.Context, q *db.Queries, c *OrderCustomer) (string, *uuid.UUID, *uuid.UUID, string, *string, error) {
	if c == nil {
		return "anonymous", nil, nil, "", nil, nil
	}
	switch c.Kind {
	case "person":
		v, e := q.GetPerson(ctx, c.ID)
		return c.Kind, &c.ID, nil, v.DisplayName, nil, databaseError(e)
	case "organization":
		v, e := q.GetOrganization(ctx, c.ID)
		if e != nil {
			return "", nil, nil, "", nil, databaseError(e)
		}
		if !v.Active {
			return "", nil, nil, "", nil, conflict("organization_inactive", "Organization is inactive")
		}
		return c.Kind, nil, &c.ID, v.Name, &v.Kind, nil
	}
	return "", nil, nil, "", nil, validation("Invalid customer")
}
func (s *Service) create(ctx context.Context, tx pgx.Tx, p authorization.Principal, input OrderDraftInput, original *db.Order, requestID *uuid.UUID) (db.Order, error) {
	q := db.New(tx)
	kind, person, org, _, _, err := s.validateCustomer(ctx, q, input.Customer)
	if err != nil {
		return db.Order{}, err
	}
	if input.FulfillmentMode != "immediate" && input.FulfillmentMode != "deferred" {
		return db.Order{}, validation("Invalid fulfillment mode")
	}
	n, err := q.NextOrderReference(ctx)
	if err != nil {
		return db.Order{}, err
	}
	params := db.CreateOrderParams{ID: newID(), Reference: reference("O", n), CustomerKind: kind, CustomerPersonID: person, CustomerOrganizationID: org, FulfillmentMode: input.FulfillmentMode, CreatedByAccountID: &p.AccountID}
	if original != nil {
		params.ReplacesOrderID = &original.ID
		params.ReplacesOrderReference = &original.Reference
	}
	o, err := q.CreateOrder(ctx, params)
	if err != nil {
		return o, err
	}
	return o, writeAudit(ctx, tx, p, "order.created", "order", o.ID, requestID, "customer", "fulfillmentMode")
}
func (s *Service) Create(ctx context.Context, p authorization.Principal, input OrderDraftInput, requestID *uuid.UUID) (Order, error) {
	if err := require(p, authorization.OrdersRead, authorization.OrdersWrite); err != nil {
		return Order{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, err
	}
	defer tx.Rollback(ctx)
	o, err := s.create(ctx, tx, p, input, nil, requestID)
	if err != nil {
		return Order{}, databaseError(err)
	}
	result, err := s.load(ctx, db.New(tx), o.ID)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}
func (s *Service) Update(ctx context.Context, p authorization.Principal, id uuid.UUID, input UpdateOrderDraftInput, requestID *uuid.UUID) (Order, error) {
	if err := require(p, authorization.OrdersRead, authorization.OrdersWrite); err != nil {
		return Order{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	o, err := q.LockOrder(ctx, id)
	if err != nil {
		return Order{}, databaseError(err)
	}
	customer := input.Customer
	if input.PreserveCustomer {
		customer = customerReference(o)
	}
	kind, person, org, _, _, err := s.validateCustomer(ctx, q, customer)
	if err != nil {
		return Order{}, err
	}
	if err = checkVersion(o, input.ExpectedVersion); err != nil {
		return Order{}, err
	}
	if err = draft(o); err != nil {
		return Order{}, err
	}
	if input.FulfillmentMode != "immediate" && input.FulfillmentMode != "deferred" {
		return Order{}, validation("Invalid fulfillment mode")
	}
	_, err = q.UpdateDraft(ctx, db.UpdateDraftParams{ID: id, CustomerKind: kind, CustomerPersonID: person, CustomerOrganizationID: org, FulfillmentMode: input.FulfillmentMode})
	if err == nil {
		err = writeAudit(ctx, tx, p, "order.updated", "order", id, requestID, "customer", "fulfillmentMode")
	}
	if err != nil {
		return Order{}, databaseError(err)
	}
	result, err := s.load(ctx, q, id)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}
func allocation(v db.PaymentAllocation) OrderAllocation {
	return OrderAllocation{ID: v.ID, PaymentID: v.PaymentID, PaymentReference: v.PaymentReference, OrderID: v.OrderID, OrderReference: v.OrderReference, Amount: d(v.Amount).StringFixed(2), OperationID: v.OperationID, CreatedAt: v.CreatedAt}
}
func (s *Service) load(ctx context.Context, q *db.Queries, id uuid.UUID) (Order, error) {
	o, err := q.GetOrder(ctx, id)
	if err != nil {
		return Order{}, databaseError(err)
	}
	v := Order{ID: o.ID, Reference: o.Reference, Status: o.Status, Currency: o.Currency, CustomerKind: o.CustomerKind, FulfillmentMode: o.FulfillmentMode, TotalAmount: money(o.TotalAmount), ReplacesOrderID: o.ReplacesOrderID, ReplacesOrderReference: o.ReplacesOrderReference, Version: o.Version, CreatedAt: o.CreatedAt, UpdatedAt: o.UpdatedAt, Items: []OrderItem{}, Allocations: []OrderAllocation{}, Adjustments: []OrderAdjustment{}}
	if o.CustomerPersonID != nil {
		v.Customer = &OrderCustomer{Kind: "person", ID: *o.CustomerPersonID}
	}
	if o.CustomerOrganizationID != nil {
		v.Customer = &OrderCustomer{Kind: "organization", ID: *o.CustomerOrganizationID}
	}
	name, e := q.GetCustomerName(ctx, id)
	if e == nil {
		v.CustomerName = &name
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return v, e
	}
	active, e := q.ActiveRequest(ctx, &id)
	if e == nil {
		v.ActiveExternalRequestID = &active.ID
		v.ActiveExternalRequestReference = &active.Reference
		v.ActiveExternalRequestState = &active.State
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return v, e
	}
	next, e := q.CommittedReplacement(ctx, &id)
	if e == nil {
		v.ReplacedByOrderID = &next.ID
		v.ReplacedByOrderReference = &next.Reference
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return v, e
	}
	items, e := q.ListItems(ctx, id)
	if e != nil {
		return v, e
	}
	total := decimal.Zero
	for _, i := range items {
		item := OrderItem{ID: i.ID, Position: int64(i.Position), Kind: i.Kind, Description: i.Description, Quantity: d(i.Quantity).String(), Unit: i.Unit, UnitPrice: d(i.UnitPrice).String(), Amount: money(i.Amount), SourceMachineJobID: i.SourceMachineJobID, SourceJobVersion: i.SourceJobVersion, CreatedAt: i.CreatedAt, RemovedAt: timePointer(i.RemovedAt)}
		if i.CurrentJobVersion != nil && i.SourceJobVersion != nil {
			item.SourceChanged = *i.CurrentJobVersion != *i.SourceJobVersion
		}
		if i.MachineJobSnapshot != nil {
			if e = json.Unmarshal(i.MachineJobSnapshot, &item.Snapshot); e != nil {
				return v, e
			}
		}
		v.Items = append(v.Items, item)
		if !i.RemovedAt.Valid {
			total = total.Add(d(i.Amount))
		}
	}
	if o.Status == "draft" {
		v.TotalAmount = total.StringFixed(2)
	} else {
		total = d(o.TotalAmount)
	}
	adjustments, e := q.ListAdjustments(ctx, &id)
	if e != nil {
		return v, e
	}
	for _, a := range adjustments {
		total = total.Sub(d(a.Amount))
		v.Adjustments = append(v.Adjustments, OrderAdjustment{ID: a.ID, Reference: a.Reference, Amount: money(a.Amount), Reason: a.Reason, CreatedAt: a.CreatedAt})
	}
	entries, e := q.ListAllocations(ctx, &id)
	if e != nil {
		return v, e
	}
	settled := decimal.Zero
	for _, a := range entries {
		settled = settled.Add(d(a.Amount))
		v.Allocations = append(v.Allocations, allocation(a))
	}
	v.NetCharge = total.StringFixed(2)
	v.SettledAmount = settled.StringFixed(2)
	v.OutstandingAmount = total.Sub(settled).StringFixed(2)
	v.SettlementState = "unpaid"
	if total.IsZero() {
		v.SettlementState = "no_payment_due"
	} else if settled.Equal(total) {
		v.SettlementState = "paid"
	} else if settled.IsPositive() {
		v.SettlementState = "partially_paid"
	}
	return v, nil
}
func (s *Service) Get(ctx context.Context, p authorization.Principal, id uuid.UUID) (Order, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return Order{}, err
	}
	return s.load(ctx, db.New(s.pool), id)
}
func (s *Service) List(ctx context.Context, p authorization.Principal, search, status string, page, size int) (OrderPage, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return OrderPage{}, err
	}
	limit, offset, err := pageBounds(page, size)
	if err != nil {
		return OrderPage{}, err
	}
	q := db.New(s.pool)
	rows, err := q.ListOrders(ctx, db.ListOrdersParams{Search: search, Status: status, PageLimit: limit, PageOffset: offset})
	if err != nil {
		return OrderPage{}, err
	}
	result := OrderPage{Items: []Order{}, Page: int64(page), PageSize: int64(size)}
	result.Total, err = q.CountOrders(ctx, db.CountOrdersParams{Search: search, Status: status})
	if err != nil {
		return result, err
	}
	for _, r := range rows {
		v, e := s.load(ctx, q, r.ID)
		if e != nil {
			return result, e
		}
		result.Items = append(result.Items, v)
	}
	return result, nil
}
