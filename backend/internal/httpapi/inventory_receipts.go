package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) ReceiveInventoryStock(ctx context.Context, r openapi.ReceiveInventoryStockRequestObject) (openapi.ReceiveInventoryStockResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := r.Body
	input := machinelogbook.ReceiptInput{MaterialID: body.MaterialId, PackageCount: body.PackageCount, TotalPrice: string(body.TotalPrice), Supplier: nullableStringPointer(body.Supplier),
		Reference: nullableStringPointer(body.Reference), Note: nullableStringPointer(body.Note), OccurredAt: body.OccurredAt}
	if body.ExpectedInventoryVersion != nil {
		input.ExpectedInventoryVersion = *body.ExpectedInventoryVersion
	}
	if body.PackageSize != nil {
		size := string(*body.PackageSize)
		input.PackageSize = &size
	}
	if body.Material != nil {
		material := materialCreateInput(*body.Material)
		input.Material = &material
	}
	if pl := body.Placement; pl != nil {
		placement := machinelogbook.ReceiptPlacement{Mode: string(pl.Mode), TareWeightG: decimalNullable(pl.TareWeightG), StorageLocation: nullableStringPointer(pl.StorageLocation), ReusableSpoolID: pl.ReusableSpoolId}
		if pl.ReusableSpoolExpectedVersion != nil {
			placement.ReusableSpoolExpectedVersion = *pl.ReusableSpoolExpectedVersion
		}
		if pl.Identifiers != nil {
			for _, identifier := range *pl.Identifiers {
				placement.Identifiers = append(placement.Identifiers, machinelogbook.NewSpoolIdentifier{Kind: string(identifier.Kind), Value: identifier.Value})
			}
		}
		input.Placement = &placement
	}
	result, err := s.machineLogbook.ReceiveStock(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	spools := make([]openapi.FilamentSpool, 0, len(result.Spools))
	for _, spool := range result.Spools {
		spools = append(spools, spoolDTO(spool))
	}
	transactions := make([]openapi.InventoryTransaction, 0, len(result.Transactions))
	for _, transaction := range result.Transactions {
		transactions = append(transactions, mlInventoryTransactionDTO(transaction))
	}
	return openapi.ReceiveInventoryStock201JSONResponse(openapi.InventoryReceiptResult{Material: mlMaterialDTO(result.Material), Spools: spools, Transactions: transactions}), nil
}

func (s *Server) ListInventorySuggestions(ctx context.Context, r openapi.ListInventorySuggestionsRequestObject) (openapi.ListInventorySuggestionsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.ListInventorySuggestions(ctx, p, r.Params.MaterialTypeId)
	if err != nil {
		return nil, err
	}
	return openapi.ListInventorySuggestions200JSONResponse(openapi.InventorySuggestions{Variants: item.Variants, Manufacturers: item.Manufacturers, Suppliers: item.Suppliers, StorageLocations: item.StorageLocations}), nil
}
