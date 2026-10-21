package orders

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

func snapshot(job machinelogbook.MachineJob) (*JobChargeSnapshot, error) {
	if job.EffectivePrice == nil || job.PricingSnapshot == nil {
		return nil, apperror.Conflicting(
			"pricing_incomplete",
			"A calculated charge or explicit final override is required",
		)
	}
	p := job.PricingSnapshot
	pricing := PricingEvidence{
		ID:               p.ID,
		Revision:         p.Revision,
		PricingGroupName: p.PricingGroupName,
		Currency:         p.Currency,
		Reason:           p.Reason,
		Complete:         p.Complete,
		CalculatedAmount: p.CalculatedAmount,
		CapturedAt:       p.CapturedAt,
		Rules:            []PriceRule{},
	}
	for _, r := range p.Rules {
		pricing.Rules = append(
			pricing.Rules,
			PriceRule{
				SourceRuleID: r.SourceRuleID,
				Kind:         r.Kind,
				Label:        r.Label,
				Selector:     r.Selector,
				Unit:         r.Unit,
				Rate:         r.Rate,
				Missing:      r.Missing,
			},
		)
	}
	usages := []JobUsage{}
	for _, u := range job.Usages {
		usages = append(
			usages,
			JobUsage{
				ID:                 u.ID,
				MaterialID:         u.MaterialID,
				SpoolID:            u.SpoolID,
				SpoolDisplayID:     u.SpoolDisplayID,
				Ownership:          u.Ownership,
				MaterialName:       u.MaterialName,
				Category:           u.MaterialTypeName,
				Unit:               u.Unit,
				Quantity:           u.Quantity,
				QuantityBasis:      u.QuantityBasis,
				EstimationMethod:   u.EstimationMethod,
				CalculationVersion: u.CalculationVersion,
				EstimateQuality:    u.EstimateQuality,
				ReportRevision:     u.ReportRevision,
				StaffCorrected:     u.StaffCorrected,
			},
		)
	}
	var finalAmount, overrideReason *string
	var overriddenAt *time.Time
	if adj := job.PriceAdjustment; adj != nil {
		finalAmount, overrideReason, overriddenAt = job.EffectivePrice, &adj.Reason, &adj.AdjustedAt
	}
	// The job's times are those of its runs; a running job is captured up to its planned end.
	startsAt := time.Time{}
	if job.StartedAt != nil {
		startsAt = *job.StartedAt
	}
	endsAt := startsAt
	if job.EndedAt != nil {
		endsAt = *job.EndedAt
	} else if job.ExpectedEndAt != nil {
		endsAt = *job.ExpectedEndAt
	}
	return &JobChargeSnapshot{
		DisplayID:       job.DisplayID,
		MachineID:       job.Machine.ID,
		MachineName:     job.Machine.Name,
		MachineTypeID:   job.Machine.MachineType.ID,
		MachineTypeName: job.Machine.MachineType.Name,
		StartsAt:        startsAt,
		EndsAt:          endsAt,
		DurationNanoseconds: decimal.NewFromInt(job.DurationSeconds).
			Mul(decimal.NewFromInt(int64(time.Second))).
			String(),
		Outcome:          job.Outcome,
		Usages:           usages,
		Pricing:          pricing,
		PricingStatus:    job.PricingStatus,
		CalculatedAmount: job.CalculatedPrice,
		FinalAmount:      finalAmount,
		EffectiveAmount:  *job.EffectivePrice,
		OverrideReason:   overrideReason,
		OverriddenAt:     overriddenAt,
		CapturedAt:       time.Now().UTC(),
	}, nil
}

func (s *Service) insertItem(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	o db.Order,
	input OrderItemInput,
	requestID *uuid.UUID,
) (db.OrderItem, error) {
	q := db.New(tx)
	params := db.InsertItemParams{
		ID:                 ids.New(),
		OrderID:            o.ID,
		Kind:               string(input.Kind),
		Description:        strings.TrimSpace(input.Description),
		Unit:               strings.TrimSpace(input.Unit),
		CreatedByAccountID: &p.AccountID,
	}
	switch input.Kind {
	case ItemManual:
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
			return db.OrderItem{}, apperror.Invalid("Item amount exceeds supported precision")
		}
		params.Quantity = numeric(qty)
		params.UnitPrice = numeric(price)
		params.Amount = numeric(amount)
	case ItemMachineJob:
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
	case ItemInventory:
		if input.MaterialID == uuid.Nil {
			return db.OrderItem{}, apperror.Invalid("materialId is required")
		}
		article, err := s.jobs.SaleSource(ctx, tx, p, input.MaterialID)
		if err != nil {
			return db.OrderItem{}, err
		}
		if !article.Active {
			return db.OrderItem{}, apperror.Conflicting(
				"article_inactive",
				"The article is inactive and cannot be sold",
			)
		}
		qty, err := parseAmount(input.Quantity, 6, true)
		if err != nil {
			return db.OrderItem{}, err
		}
		priceText := strings.TrimSpace(input.UnitPrice)
		if priceText == "" && article.SalePrice != nil {
			priceText = *article.SalePrice
		}
		if priceText == "" {
			return db.OrderItem{}, apperror.New(
				http.StatusUnprocessableEntity,
				"sale_price_required",
				"The article has no sale price; enter a unit price",
			)
		}
		price, err := parseAmount(priceText, 6, false)
		if err != nil {
			return db.OrderItem{}, err
		}
		amount := qty.Mul(price).Round(2)
		if amount.GreaterThanOrEqual(decimal.New(1, 18)) {
			return db.OrderItem{}, apperror.Invalid("Item amount exceeds supported precision")
		}
		params.Description, params.Unit = article.Name, article.Unit
		params.Quantity = numeric(qty)
		params.UnitPrice = numeric(price)
		params.Amount = numeric(amount)
		params.SourceMaterialID = &article.ID
	default:
		return db.OrderItem{}, apperror.Invalid("Invalid item kind")
	}
	if params.Description == "" || len(params.Description) > 500 || params.Unit == "" || len(params.Unit) > 40 {
		return db.OrderItem{}, apperror.Invalid("Description and unit are required and must fit their limits")
	}
	item, err := q.InsertItem(ctx, params)
	if err != nil {
		return item, databaseError(err)
	}
	if item.SourceMachineJobID != nil {
		claim, err := q.GetJobClaim(ctx, *item.SourceMachineJobID)
		if err == nil {
			if o.ReplacesOrderID == nil || claim.OrderID != *o.ReplacesOrderID {
				return item, apperror.Conflicting("job_already_ordered", "This job belongs to another active order")
			}
		} else if errors.Is(err, pgx.ErrNoRows) {
			if err = q.ClaimJob(
				ctx,
				db.ClaimJobParams{MachineJobID: *item.SourceMachineJobID, OrderItemID: item.ID},
			); err != nil {
				return item, apperror.Conflicting("job_already_ordered", "This job belongs to another active order")
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

func (s *Service) ChangeItem(
	ctx context.Context,
	p authorization.Principal,
	id, itemID uuid.UUID,
	input OrderItemInput,
	action ItemAction,
	requestID *uuid.UUID,
) (Order, error) {
	if err := require(p, authorization.OrdersRead, authorization.OrdersWrite); err != nil {
		return Order{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
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
	if action != ItemActionAdd {
		old, e := q.GetItem(ctx, db.GetItemParams{ID: itemID, OrderID: id})
		if e != nil {
			return Order{}, databaseError(e)
		}
		if old.RemovedAt.Valid {
			return Order{}, apperror.Conflicting("item_removed", "Item has already been removed")
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
		if action == ItemActionRefresh {
			if old.SourceMachineJobID == nil {
				return Order{}, apperror.Invalid("Only job items can be refreshed")
			}
			job, e := s.jobs.ChargeSource(ctx, tx, p, *old.SourceMachineJobID)
			if e != nil {
				return Order{}, e
			}
			input = OrderItemInput{
				Kind:               ItemMachineJob,
				MachineJobID:       job.ID,
				ExpectedJobVersion: job.Version,
				Description:        old.Description,
			}
		}
	}
	if action == ItemActionRemove {
		err = q.BumpOrder(ctx, id)
	} else {
		_, err = s.insertItem(ctx, tx, p, o, input, requestID)
	}
	if err != nil {
		return Order{}, databaseError(err)
	}
	if action == ItemActionRefresh {
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

func (s *Service) JobAssociation(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
) (JobOrderAssociation, error) {
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
	return JobOrderAssociation{
		OrderID:        &r.OrderID,
		OrderReference: &r.Reference,
		SourceChanged:  r.SourceJobVersion != nil && r.CurrentJobVersion != *r.SourceJobVersion,
	}, nil
}
