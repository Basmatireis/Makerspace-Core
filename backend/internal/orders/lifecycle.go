package orders

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

func customerReference(o db.Order) *OrderCustomer {
	if o.CustomerPersonID != nil {
		return &OrderCustomer{Kind: "person", ID: *o.CustomerPersonID}
	}
	if o.CustomerOrganizationID != nil {
		return &OrderCustomer{Kind: "organization", ID: *o.CustomerOrganizationID}
	}
	return nil
}
func (s *Service) finalize(ctx context.Context, tx pgx.Tx, p authorization.Principal, o db.Order, requestID *uuid.UUID) (db.Order, error) {
	if err := require(p, authorization.OrdersFinalize); err != nil {
		return o, err
	}
	if err := draft(o); err != nil {
		return o, err
	}
	q := db.New(tx)
	items, err := q.ListItems(ctx, o.ID)
	if err != nil {
		return o, err
	}
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i].SourceMachineJobID, items[j].SourceMachineJobID
		if a == nil {
			return false
		}
		if b == nil {
			return true
		}
		return a.String() < b.String()
	})
	count := 0
	total := decimal.Zero
	for _, i := range items {
		if i.RemovedAt.Valid {
			continue
		}
		count++
		total = total.Add(d(i.Amount))
		if i.SourceMachineJobID != nil {
			job, e := s.jobs.ChargeSource(ctx, tx, p, *i.SourceMachineJobID)
			if e != nil {
				return o, e
			}
			if i.SourceJobVersion == nil || job.Version != *i.SourceJobVersion {
				return o, conflict("source_snapshot_stale", "Refresh the changed job snapshot before finalization")
			}
			claim, e := q.GetJobClaim(ctx, job.ID)
			if e == nil && claim.OrderID != o.ID {
				return o, conflict("job_already_ordered", "Job still belongs to another order")
			}
			if errors.Is(e, pgx.ErrNoRows) {
				if e = q.ClaimJob(ctx, db.ClaimJobParams{MachineJobID: job.ID, OrderItemID: i.ID}); e != nil {
					return o, databaseError(e)
				}
			} else if e != nil {
				return o, e
			}
		}
	}
	if count == 0 {
		return o, validation("An order requires at least one item")
	}
	if total.GreaterThanOrEqual(decimal.New(1, 18)) {
		return o, validation("Order total exceeds supported precision")
	}
	c := customerReference(o)
	if o.CustomerKind != "anonymous" {
		if c == nil {
			return o, conflict("customer_unavailable", "Choose a current customer before finalizing")
		}
		_, _, _, name, kind, e := s.validateCustomer(ctx, q, c)
		if e != nil {
			return o, e
		}
		if e = q.CaptureCustomer(ctx, db.CaptureCustomerParams{OrderID: o.ID, DisplayName: name, OrganizationKind: kind}); e != nil {
			return o, e
		}
	}
	if o.CustomerKind == "anonymous" && o.FulfillmentMode != "immediate" {
		return o, conflict("anonymous_requires_full_settlement", "Deferred fulfillment requires a named customer")
	}
	if err = q.TransitionOrder(ctx, db.TransitionOrderParams{ID: o.ID, Status: "finalized", TotalAmount: numeric(total)}); err != nil {
		return o, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "order.finalized", "order", o.ID, requestID, "status", "totalAmount", "customerSnapshot"); err != nil {
		return o, err
	}
	return q.GetOrder(ctx, o.ID)
}
func (s *Service) reverse(ctx context.Context, tx pgx.Tx, p authorization.Principal, o db.Order, reason string, requestID *uuid.UUID) error {
	if err := require(p, authorization.OrdersReverse); err != nil {
		return err
	}
	if o.Status != "finalized" {
		return conflict("order_not_finalized", "Only finalized orders can be reversed")
	}
	reason = strings.TrimSpace(reason)
	if reason == "" || len(reason) > 500 {
		return validation("Reversal reason is required")
	}
	q := db.New(tx)
	r, e := q.LatestRequest(ctx, &o.ID)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	if e == nil && r.State != "cancelled" {
		return conflict("external_reconciliation_required", "Cancel or reconcile the active external invoice request first")
	}
	balance, err := q.SumAllocations(ctx, &o.ID)
	if err != nil {
		return err
	}
	if !d(balance).IsZero() {
		return conflict("payment_reconciliation_required", "Refund/correct payments or transfer them to a replacement first")
	}
	n, err := q.NextAdjustmentReference(ctx)
	if err != nil {
		return err
	}
	adj := newID()
	if err = q.InsertAdjustment(ctx, db.InsertAdjustmentParams{ID: adj, Reference: reference("A", n), OrderID: &o.ID, OrderReference: o.Reference, Amount: o.TotalAmount, Reason: reason, ActorAccountID: &p.AccountID}); err != nil {
		return err
	}
	items, err := q.ListItems(ctx, o.ID)
	if err != nil {
		return err
	}
	for _, i := range items {
		if !i.RemovedAt.Valid {
			if err = q.InsertAdjustmentItems(ctx, db.InsertAdjustmentItemsParams{ID: newID(), AdjustmentID: adj, OriginalOrderItemID: &i.ID, OriginalItemPosition: i.Position, Amount: i.Amount}); err != nil {
				return err
			}
		}
	}
	if err = q.ReleaseOrderClaims(ctx, o.ID); err != nil {
		return err
	}
	if err = q.TransitionOrder(ctx, db.TransitionOrderParams{ID: o.ID, Status: "reversed", TotalAmount: o.TotalAmount}); err != nil {
		return err
	}
	return writeAudit(ctx, tx, p, "order.reversed", "order", o.ID, requestID, "status", "adjustments")
}
func (s *Service) Command(ctx context.Context, p authorization.Principal, id uuid.UUID, input OrderCommand, action string, requestID *uuid.UUID) (Order, error) {
	perm := authorization.OrdersFinalize
	if action == "cancel" || action == "replacements" {
		perm = authorization.OrdersWrite
	}
	if action == "reverse" || action == "replace" {
		perm = authorization.OrdersReverse
	}
	if err := require(p, authorization.OrdersRead, perm); err != nil {
		return Order{}, err
	}
	if len(input.Reversals) > 0 {
		if err := require(p, authorization.PaymentsRead, authorization.PaymentsReverse); err != nil {
			return Order{}, err
		}
	}
	if len(input.Payments) > 0 || action == "checkout" {
		if err := require(p, authorization.PaymentsRead, authorization.PaymentsRecord); err != nil {
			return Order{}, err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	kind := "order." + action
	old, hash, err := beginOperation(ctx, q, p, input.OperationKey, kind, struct {
		ID    uuid.UUID
		Input OrderCommand
	}{id, input})
	if err != nil {
		return Order{}, err
	}
	if old != nil {
		if old.OrderID == nil {
			return Order{}, conflict("operation_expired", "Operation result is unavailable")
		}
		return s.load(ctx, q, *old.OrderID)
	}
	var o, replacement db.Order
	if action == "replace" {
		if input.ReplacementOrderID == uuid.Nil {
			return Order{}, validation("Replacement order is required")
		}
		ids := []uuid.UUID{id, input.ReplacementOrderID}
		sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
		for _, key := range ids {
			row, e := q.LockOrder(ctx, key)
			if e != nil {
				return Order{}, databaseError(e)
			}
			if key == id {
				o = row
			} else {
				replacement = row
			}
		}
	} else {
		o, err = q.LockOrder(ctx, id)
		if err != nil {
			return Order{}, databaseError(err)
		}
	}
	if err = checkVersion(o, input.ExpectedVersion); err != nil {
		return Order{}, err
	}
	resultID := id
	switch action {
	case "cancel":
		if err = draft(o); err == nil {
			err = q.ReleaseOrderClaims(ctx, id)
		}
		if err == nil {
			err = q.TransitionOrder(ctx, db.TransitionOrderParams{ID: id, Status: "cancelled", TotalAmount: o.TotalAmount})
		}
		if err == nil {
			err = writeAudit(ctx, tx, p, "order.cancelled", "order", id, requestID, "status")
		}
	case "finalize", "checkout":
		if o.ReplacesOrderReference != nil {
			return Order{}, conflict("replacement_commit_required", "Finalize replacements through their original order")
		}
		o, err = s.finalize(ctx, tx, p, o, requestID)
		if err == nil {
			for _, payment := range input.Payments {
				if _, err = s.receipt(ctx, tx, p, o, payment, input.OperationKey, requestID); err != nil {
					break
				}
			}
		}
		if err == nil {
			err = s.checkAnonymous(ctx, q, o)
		}
	case "reverse":
		for _, r := range input.Reversals {
			if err = s.reverseReceipt(ctx, tx, p, o, r, input.OperationKey, requestID); err != nil {
				break
			}
		}
		if err == nil {
			err = s.reverse(ctx, tx, p, o, input.Reason, requestID)
		}
	case "replacements":
		if o.Status != "finalized" && o.Status != "reversed" {
			return Order{}, conflict("order_not_finalized", "Replacement requires finalized or reversed original")
		}
		if _, e := q.CommittedReplacement(ctx, &id); e == nil {
			return Order{}, conflict("order_already_replaced", "This order already has a committed replacement")
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return Order{}, e
		}
		var next db.Order
		next, err = s.create(ctx, tx, p, OrderDraftInput{Customer: customerReference(o), FulfillmentMode: o.FulfillmentMode}, &o, requestID)
		if err == nil {
			items, e := q.ListItems(ctx, id)
			err = e
			for _, i := range items {
				if err != nil {
					break
				}
				if i.RemovedAt.Valid {
					continue
				}
				v := OrderItemInput{Kind: i.Kind, Description: i.Description, Quantity: d(i.Quantity).String(), Unit: i.Unit, UnitPrice: d(i.UnitPrice).String()}
				if i.SourceMachineJobID != nil {
					job, e := s.jobs.ChargeSource(ctx, tx, p, *i.SourceMachineJobID)
					if e != nil {
						err = e
						break
					}
					v.MachineJobID = job.ID
					v.ExpectedJobVersion = job.Version
				} else if i.Kind == "machine_job" {
					err = conflict("source_unavailable", "The original job is unavailable; add a manual replacement item explicitly")
					break
				}
				_, err = s.insertItem(ctx, tx, p, next, v, requestID)
			}
			resultID = next.ID
		}
	case "replace":
		if err = require(p, authorization.OrdersFinalize, authorization.PaymentsRead, authorization.PaymentsRecord); err != nil {
			return Order{}, err
		}
		if err = checkVersion(replacement, input.ExpectedReplacementVersion); err != nil {
			return Order{}, err
		}
		if err = draft(replacement); err != nil {
			return Order{}, err
		}
		if replacement.ReplacesOrderID == nil || *replacement.ReplacesOrderID != id {
			return Order{}, validation("Replacement is not linked to this original")
		}
		if o.Status != "finalized" && o.Status != "reversed" {
			return Order{}, conflict("order_not_finalized", "Original is no longer replaceable")
		}
		r, e := q.LatestRequest(ctx, &id)
		if e == nil && r.State != "cancelled" {
			return Order{}, conflict("external_reconciliation_required", "Resolve external invoicing first")
		}
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return Order{}, e
		}
		for _, rev := range input.Reversals {
			if err = s.reverseReceipt(ctx, tx, p, o, rev, input.OperationKey, requestID); err != nil {
				return Order{}, err
			}
		}
		receipts, e := q.ActiveReceipts(ctx, &id)
		if e != nil {
			return Order{}, e
		}
		paid := decimal.Zero
		for _, payment := range receipts {
			if payment.Method == "external" {
				return Order{}, conflict("external_reconciliation_required", "External payments cannot be carried forward")
			}
			paid = paid.Add(d(payment.Amount))
		}
		preview, e := s.load(ctx, q, replacement.ID)
		if e != nil {
			return Order{}, e
		}
		newTotal, e := parseAmount(preview.TotalAmount, 2, false)
		if e != nil {
			return Order{}, e
		}
		if paid.GreaterThan(newTotal) {
			return Order{}, conflict("payment_exceeds_outstanding", "Reverse whole receipts explicitly before replacing with a lower total")
		}
		for _, payment := range receipts {
			if err = s.allocate(ctx, q, p, payment, o, d(payment.Amount).Neg(), input.OperationKey); err != nil {
				return Order{}, err
			}
		}
		if o.Status == "finalized" {
			if err = s.reverse(ctx, tx, p, o, input.Reason, requestID); err != nil {
				return Order{}, err
			}
		} else {
			if err = q.BumpOrder(ctx, id); err != nil {
				return Order{}, err
			}
		}
		replacement, err = s.finalize(ctx, tx, p, replacement, requestID)
		if err != nil {
			return Order{}, err
		}
		for _, payment := range receipts {
			if err = s.allocate(ctx, q, p, payment, replacement, d(payment.Amount), input.OperationKey); err != nil {
				return Order{}, err
			}
			if err = writeAudit(ctx, tx, p, "payment.reallocated", "payment", payment.ID, requestID, "allocations"); err != nil {
				return Order{}, err
			}
		}
		for _, payment := range input.Payments {
			if _, err = s.receipt(ctx, tx, p, replacement, payment, input.OperationKey, requestID); err != nil {
				return Order{}, err
			}
		}
		if err = s.checkAnonymous(ctx, q, replacement); err != nil {
			return Order{}, err
		}
		if err = writeAudit(ctx, tx, p, "order.replaced", "order", id, requestID, "replacement"); err != nil {
			return Order{}, err
		}
		resultID = replacement.ID
	default:
		return Order{}, validation("Unsupported order action")
	}
	if err != nil {
		return Order{}, databaseError(err)
	}
	if err = finishOperation(ctx, q, p, input.OperationKey, kind, hash, &resultID, nil); err != nil {
		return Order{}, err
	}
	result, err := s.load(ctx, q, resultID)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}
func (s *Service) counterSale(ctx context.Context, p authorization.Principal, input CounterSaleCommand, preview bool, requestID *uuid.UUID) (Order, error) {
	if err := require(p, authorization.OrdersRead, authorization.OrdersWrite, authorization.OrdersFinalize, authorization.PaymentsRead, authorization.PaymentsRecord); err != nil {
		return Order{}, err
	}
	if !input.ImmediateFulfillmentConfirmed {
		return Order{}, validation("Confirm immediate fulfillment and no future follow-up")
	}
	if input.Job.ManualJob != nil && input.Job.ExistingJobID != uuid.Nil {
		return Order{}, validation("Choose an existing review job or a manual job")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	old, hash, err := beginOperation(ctx, q, p, input.OperationKey, "counter_sale", input)
	if err != nil {
		return Order{}, err
	}
	if old != nil && old.OrderID != nil {
		return s.load(ctx, q, *old.OrderID)
	}
	o, err := s.create(ctx, tx, p, OrderDraftInput{FulfillmentMode: "immediate"}, nil, requestID)
	if err != nil {
		return Order{}, err
	}
	var job machinelogbook.MachineJob
	if input.Job.ManualJob != nil {
		v := input.Job.ManualJob
		if v.Customer != nil {
			return Order{}, validation("Anonymous counter-sale jobs must omit customer identity")
		}
		usages := []machinelogbook.UsageInput{}
		for _, u := range v.Usages {
			usages = append(usages, machinelogbook.UsageInput{MaterialID: u.MaterialID, Quantity: u.Quantity})
		}
		job, err = s.jobs.CreateManualJobInTransaction(ctx, tx, true, p, machinelogbook.JobInput{MachineID: v.MachineID, StartsAt: v.StartsAt, EndsAt: v.EndsAt, OperatorPersonID: v.OperatorPersonID, Outcome: v.Outcome, Notes: v.Notes, PricingGroupID: v.PricingGroupID, Usages: usages}, requestID)
	} else if input.Job.ExistingJobID != uuid.Nil {
		var group *uuid.UUID
		if input.Job.PricingGroupID != uuid.Nil {
			group = &input.Job.PricingGroupID
		}
		var note *string
		if input.Job.Notes != "" {
			note = &input.Job.Notes
		}
		job, err = s.jobs.ConfirmJobInTransaction(ctx, tx, true, p, input.Job.ExistingJobID, input.Job.ExpectedJobVersion, machinelogbook.PartyReference{}, input.Job.OperatorPersonID, input.Job.Outcome, note, group, requestID)
	} else {
		return Order{}, validation("A machine job is required")
	}
	if err != nil {
		return Order{}, err
	}
	if _, err = s.insertItem(ctx, tx, p, o, OrderItemInput{Kind: "machine_job", MachineJobID: job.ID, ExpectedJobVersion: job.Version}, requestID); err != nil {
		return Order{}, err
	}
	for _, item := range input.ManualItems {
		if item.Kind != "manual" {
			return Order{}, validation("Additional counter-sale items must be manual")
		}
		if _, err = s.insertItem(ctx, tx, p, o, item, requestID); err != nil {
			return Order{}, err
		}
	}
	if preview {
		return s.load(ctx, q, o.ID)
	}
	o, err = s.finalize(ctx, tx, p, o, requestID)
	if err != nil {
		return Order{}, err
	}
	for _, payment := range input.Payments {
		if payment.Method == "external" {
			return Order{}, validation("Anonymous counter sales require cash/card")
		}
		if _, err = s.receipt(ctx, tx, p, o, payment, input.OperationKey, requestID); err != nil {
			return Order{}, err
		}
	}
	if err = s.checkAnonymous(ctx, q, o); err != nil {
		return Order{}, err
	}
	if err = finishOperation(ctx, q, p, input.OperationKey, "counter_sale", hash, &o.ID, nil); err != nil {
		return Order{}, err
	}
	result, err := s.load(ctx, q, o.ID)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}

func (s *Service) CounterSale(ctx context.Context, p authorization.Principal, input CounterSaleCommand, requestID *uuid.UUID) (Order, error) {
	return s.counterSale(ctx, p, input, false, requestID)
}
func (s *Service) PreviewCounterSale(ctx context.Context, p authorization.Principal, input CounterSaleCommand) (CounterSaleQuote, error) {
	o, err := s.counterSale(ctx, p, input, true, nil)
	return CounterSaleQuote{TotalAmount: o.TotalAmount, Currency: "EUR"}, err
}
