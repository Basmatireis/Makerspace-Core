package orders

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

func snapshot(job machinelogbook.MachineJob) (*JobChargeSnapshot, error) {
	if job.ReviewState != "confirmed" {
		return nil, conflict("job_not_confirmed", "Only confirmed jobs can be ordered")
	}
	if job.EffectivePrice == nil || job.PricingSnapshot == nil {
		return nil, conflict("pricing_incomplete", "A calculated charge or explicit final override is required")
	}
	p := job.PricingSnapshot
	pricing := PricingEvidence{ID: p.ID, Revision: p.Revision, PricingGroupName: p.PricingGroupName, Currency: p.Currency, Reason: p.Reason, Complete: p.Complete, CalculatedAmount: p.CalculatedAmount, CapturedAt: p.CapturedAt, Rules: []PriceRule{}}
	for _, r := range p.Rules {
		pricing.Rules = append(pricing.Rules, PriceRule{SourceRuleID: r.SourceRuleID, Kind: r.Kind, Label: r.Label, Selector: r.Selector, Unit: r.Unit, Rate: r.Rate, Missing: r.Missing})
	}
	usages := []JobUsage{}
	for _, u := range job.Usages {
		usages = append(usages, JobUsage{ID: u.ID, MaterialID: u.MaterialID, MaterialName: u.MaterialName, Category: u.Category, Unit: u.Unit, Quantity: u.Quantity})
	}
	return &JobChargeSnapshot{DisplayID: job.DisplayID, MachineID: job.Machine.ID, MachineName: job.Machine.Name, MachineTypeID: job.Machine.MachineType.ID, MachineTypeName: job.Machine.MachineType.Name, StartsAt: job.StartsAt, EndsAt: job.EndsAt, DurationNanoseconds: decimal.NewFromInt(job.EndsAt.Sub(job.StartsAt).Nanoseconds()).String(), Outcome: job.Outcome, Usages: usages, Pricing: pricing, PricingStatus: job.PricingStatus, CalculatedAmount: job.CalculatedPrice, FinalAmount: job.FinalPrice, EffectiveAmount: *job.EffectivePrice, OverrideReason: job.PriceOverrideReason, OverriddenAt: job.PriceOverriddenAt, CapturedAt: time.Now().UTC()}, nil
}
func (s *Service) insertItem(ctx context.Context, tx pgx.Tx, p authorization.Principal, o db.Order, input OrderItemInput, requestID *uuid.UUID) (db.OrderItem, error) {
	q := db.New(tx)
	params := db.InsertItemParams{ID: newID(), OrderID: o.ID, Kind: input.Kind, Description: strings.TrimSpace(input.Description), Unit: strings.TrimSpace(input.Unit), CreatedByAccountID: &p.AccountID}
	switch input.Kind {
	case "manual":
		qty, err := parseAmount(input.Quantity, 6, true)
		if err != nil {
			return db.OrderItem{}, err
		}
		price, err := parseAmount(input.UnitPrice, 6, false)
		if err != nil {
			return db.OrderItem{}, err
		}
		amount := qty.Mul(price).Round(2)
		if amount.GreaterThanOrEqual(decimal.New(1, 18)) {
			return db.OrderItem{}, validation("Item amount exceeds supported precision")
		}
		params.Quantity = numeric(qty)
		params.UnitPrice = numeric(price)
		params.Amount = numeric(amount)
	case "machine_job":
		job, err := s.jobs.ChargeSource(ctx, tx, p, input.MachineJobID)
		if err != nil {
			return db.OrderItem{}, err
		}
		if input.ExpectedJobVersion < 1 || job.Version != input.ExpectedJobVersion {
			return db.OrderItem{}, apperror.StaleWrite
		}
		evidence, err := snapshot(job)
		if err != nil {
			return db.OrderItem{}, err
		}
		if params.Description == "" {
			params.Description = job.DisplayID + " · " + job.Machine.Name
		}
		params.Quantity = numeric(decimal.NewFromInt(1))
		params.Unit = "job"
		amount, err := parseAmount(evidence.EffectiveAmount, 2, false)
		if err != nil {
			return db.OrderItem{}, err
		}
		params.UnitPrice = numeric(amount)
		params.Amount = numeric(amount)
		params.SourceMachineJobID = &job.ID
		params.SourceJobVersion = &job.Version
		params.MachineJobSnapshot, err = json.Marshal(evidence)
		if err != nil {
			return db.OrderItem{}, err
		}
	default:
		return db.OrderItem{}, validation("Invalid item kind")
	}
	if params.Description == "" || len(params.Description) > 500 || params.Unit == "" || len(params.Unit) > 40 {
		return db.OrderItem{}, validation("Description and unit are required and must fit their limits")
	}
	item, err := q.InsertItem(ctx, params)
	if err != nil {
		return item, databaseError(err)
	}
	if item.SourceMachineJobID != nil {
		claim, err := q.GetJobClaim(ctx, *item.SourceMachineJobID)
		if err == nil {
			if o.ReplacesOrderID == nil || claim.OrderID != *o.ReplacesOrderID {
				return item, conflict("job_already_ordered", "This job belongs to another active order")
			}
		} else if errors.Is(err, pgx.ErrNoRows) {
			if err = q.ClaimJob(ctx, db.ClaimJobParams{MachineJobID: *item.SourceMachineJobID, OrderItemID: item.ID}); err != nil {
				return item, conflict("job_already_ordered", "This job belongs to another active order")
			}
		} else {
			return item, err
		}
	}
	if err = q.BumpOrder(ctx, o.ID); err != nil {
		return item, err
	}
	return item, writeAudit(ctx, tx, p, "order.item_added", "order", o.ID, requestID, "items")
}
func (s *Service) ChangeItem(ctx context.Context, p authorization.Principal, id, itemID uuid.UUID, input OrderItemInput, action string, requestID *uuid.UUID) (Order, error) {
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
	if err = checkVersion(o, input.ExpectedVersion); err != nil {
		return Order{}, err
	}
	if err = draft(o); err != nil {
		return Order{}, err
	}
	if action != "add" {
		old, e := q.GetItem(ctx, db.GetItemParams{ID: itemID, OrderID: id})
		if e != nil {
			return Order{}, databaseError(e)
		}
		if old.RemovedAt.Valid {
			return Order{}, conflict("item_removed", "Item has already been removed")
		}
		if e = q.ReleaseItemClaim(ctx, itemID); e != nil {
			return Order{}, e
		}
		if e = q.RemoveItem(ctx, db.RemoveItemParams{ID: itemID, RemovedByAccountID: &p.AccountID}); e != nil {
			return Order{}, e
		}
		if e = writeAudit(ctx, tx, p, "order.item_removed", "order", id, requestID, "items"); e != nil {
			return Order{}, e
		}
		if action == "refresh" {
			if old.SourceMachineJobID == nil {
				return Order{}, validation("Only job items can be refreshed")
			}
			job, e := s.jobs.ChargeSource(ctx, tx, p, *old.SourceMachineJobID)
			if e != nil {
				return Order{}, e
			}
			input = OrderItemInput{Kind: "machine_job", MachineJobID: job.ID, ExpectedJobVersion: job.Version, Description: old.Description}
		}
	}
	if action == "remove" {
		err = q.BumpOrder(ctx, id)
	} else {
		_, err = s.insertItem(ctx, tx, p, o, input, requestID)
	}
	if err != nil {
		return Order{}, databaseError(err)
	}
	if action == "refresh" {
		if err = writeAudit(ctx, tx, p, "order.item_refreshed", "order", id, requestID, "items"); err != nil {
			return Order{}, err
		}
	}
	result, err := s.load(ctx, q, id)
	if err != nil {
		return result, err
	}
	return result, databaseError(tx.Commit(ctx))
}
func (s *Service) JobAssociation(ctx context.Context, p authorization.Principal, id uuid.UUID) (JobOrderAssociation, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return JobOrderAssociation{}, err
	}
	r, err := db.New(s.pool).GetJobClaim(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return JobOrderAssociation{}, nil
	}
	if err != nil {
		return JobOrderAssociation{}, err
	}
	return JobOrderAssociation{OrderID: &r.OrderID, OrderReference: &r.Reference, SourceChanged: r.SourceJobVersion != nil && r.CurrentJobVersion != *r.SourceJobVersion}, nil
}
