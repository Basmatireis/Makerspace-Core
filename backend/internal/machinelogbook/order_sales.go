package machinelogbook

import (
	"bytes"
	"context"
	"errors"
	"sort"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// SaleArticle is what an order needs to know about an article it sells.
type SaleArticle struct {
	ID         uuid.UUID
	Name, Unit string
	Kind       MaterialKind
	Active     bool
	SalePrice  *string
}

// SaleSource returns an article for an order item using the caller's
// transaction. Reading it requires inventory.read.
func (s *Service) SaleSource(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
) (SaleArticle, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return SaleArticle{}, err
	}
	row, err := machinelogbookdb.New(tx).GetMaterial(ctx, id)
	if err != nil {
		return SaleArticle{}, noRows(err)
	}
	return SaleArticle{
		ID:        row.ID,
		Name:      row.Name,
		Unit:      row.Unit,
		Kind:      MaterialKind(row.MaterialKind),
		Active:    row.Active,
		SalePrice: nullableDecimal(row.SalePrice),
	}, nil
}

// StockSale is the loose stock of one article sold by one order item.
type StockSale struct {
	MaterialID, OrderItemID uuid.UUID
	Quantity                decimal.Decimal
}

// SellFromStock books one order_sale ledger row per sale at the current
// weighted-average cost and only from unassigned (loose) stock. Orders have
// already authorized the operation, so inventory.manage is not required. The
// balances are locked in ascending id order; if any article lacks loose stock
// the whole call fails with 409 insufficient_stock and the caller rolls back.
func (s *Service) SellFromStock(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	sales []StockSale,
	requestID *uuid.UUID,
) error {
	if len(sales) == 0 {
		return nil
	}
	sorted := append([]StockSale(nil), sales...)
	sort.SliceStable(
		sorted,
		func(i, j int) bool { return bytes.Compare(sorted[i].MaterialID[:], sorted[j].MaterialID[:]) < 0 },
	)
	q := machinelogbookdb.New(tx)
	materialIDs := make([]uuid.UUID, 0, len(sorted))
	for _, sale := range sorted {
		materialIDs = append(materialIDs, sale.MaterialID)
	}
	if err := lockMaterials(ctx, q, materialIDs...); err != nil {
		return err
	}
	for _, sale := range sorted {
		current, err := q.GetMaterialForUpdate(ctx, sale.MaterialID)
		if err != nil {
			return noRows(err)
		}
		allocated, err := q.AllocatedMaterialQuantity(ctx, sale.MaterialID)
		if err != nil {
			return err
		}
		quantity, value := decimalFromNumeric(current.Quantity), decimalFromNumeric(current.InventoryValue)
		available := decimal.Max(quantity.Sub(decimalFromNumeric(allocated)), decimal.Zero)
		if available.LessThan(sale.Quantity) {
			e := apperror.Conflicting("insufficient_stock", "Loose stock does not cover the sold quantity")
			e.Details["materialId"] = sale.MaterialID.String()
			e.Details["available"] = available.String()
			return e
		}
		average := decimalFromNumeric(current.AverageUnitCost)
		delta := sale.Quantity.Mul(average).Round(6)
		if sale.Quantity.Equal(quantity) || delta.GreaterThan(value) {
			delta = value
		}
		itemID := sale.OrderItemID
		if _, err = s.applyInventoryMutation(
			ctx,
			tx,
			q,
			p,
			sale.MaterialID,
			anyInventoryVersion,
			inventoryMutation{
				Kind:          InventoryOrderSale,
				QuantityDelta: sale.Quantity.Neg(),
				UnitCost:      average,
				ValueDelta:    delta.Neg(),
				OccurredAt:    s.now().UTC(),
				OrderItemID:   &itemID,
			},
			requestID,
		); err != nil {
			return err
		}
	}
	return nil
}

// RestockOrderSale returns what an order item sold to loose stock: the same
// quantity and the same inventory value the sale removed. Items without a sale
// row (never finalized) are skipped.
func (s *Service) RestockOrderSale(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	orderItemID uuid.UUID,
	requestID *uuid.UUID,
) error {
	q := machinelogbookdb.New(tx)
	sale, err := q.GetOrderItemSaleTransaction(ctx, &orderItemID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	done, err := q.OrderItemHasSaleReversal(ctx, &orderItemID)
	if err != nil || done {
		return err
	}
	if err = lockMaterials(ctx, q, sale.MaterialID); err != nil {
		return err
	}
	_, err = s.applyInventoryMutation(
		ctx,
		tx,
		q,
		p,
		sale.MaterialID,
		anyInventoryVersion,
		inventoryMutation{
			Kind:          InventoryOrderSaleReversal,
			QuantityDelta: decimalFromNumeric(sale.QuantityDelta).Neg(),
			UnitCost:      decimalFromNumeric(sale.UnitAcquisitionCost),
			ValueDelta:    decimalFromNumeric(sale.InventoryValueDelta).Neg(),
			OccurredAt:    s.now().UTC(),
			OrderItemID:   &orderItemID,
		},
		requestID,
	)
	return err
}
