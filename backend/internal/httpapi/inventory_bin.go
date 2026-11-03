package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func deletedMaterialDTO(item machinelogbook.DeletedMaterial) openapi.DeletedMaterial {
	return openapi.DeletedMaterial{
		Id:               item.ID,
		DisplayId:        item.DisplayID,
		Name:             item.Name,
		Kind:             openapi.MaterialKind(item.Kind),
		MaterialTypeName: item.MaterialTypeName,
		Unit:             openapi.MaterialUnit(item.Unit),
		Quantity:         item.Quantity,
		SpoolCount:       item.SpoolCount,
		DeletedAt:        item.DeletedAt,
		DeletedByName:    nullableString(item.DeletedByName),
		Version:          item.Version,
	}
}

func (s *Server) GetInventoryRecycleBin(
	ctx context.Context,
	_ openapi.GetInventoryRecycleBinRequestObject,
) (openapi.GetInventoryRecycleBinResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	bin, err := s.machineLogbook.GetInventoryRecycleBin(ctx, p)
	if err != nil {
		return nil, err
	}
	dto := openapi.InventoryRecycleBin{
		Materials:     make([]openapi.DeletedMaterial, 0, len(bin.Materials)),
		Spools:        make([]openapi.FilamentSpool, 0, len(bin.Spools)),
		LedgerEntries: make([]openapi.DeletedInventoryTransaction, 0, len(bin.LedgerEntries)),
	}
	for _, item := range bin.Materials {
		dto.Materials = append(dto.Materials, deletedMaterialDTO(item))
	}
	for _, item := range bin.Spools {
		dto.Spools = append(dto.Spools, spoolDTO(item))
	}
	for _, item := range bin.LedgerEntries {
		dto.LedgerEntries = append(dto.LedgerEntries, openapi.DeletedInventoryTransaction{
			Transaction:       mlInventoryTransactionDTO(item.Transaction),
			MaterialName:      item.MaterialName,
			MaterialDisplayId: item.MaterialDisplay,
			Unit:              openapi.MaterialUnit(item.Unit),
			DeletedAt:         item.DeletedAt,
			DeletedByName:     nullableString(item.DeletedByName),
		})
	}
	return openapi.GetInventoryRecycleBin200JSONResponse(dto), nil
}

func (s *Server) RestoreMaterial(
	ctx context.Context,
	r openapi.RestoreMaterialRequestObject,
) (openapi.RestoreMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.RestoreMaterial(ctx, p, r.MaterialId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RestoreMaterial200JSONResponse(mlMaterialDTO(item)), nil
}

func (s *Server) PurgeMaterial(
	ctx context.Context,
	r openapi.PurgeMaterialRequestObject,
) (openapi.PurgeMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.machineLogbook.PurgeMaterial(
		ctx,
		p,
		r.MaterialId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.PurgeMaterial204Response{}, nil
}

func (s *Server) DeleteInventoryTransaction(
	ctx context.Context,
	r openapi.DeleteInventoryTransactionRequestObject,
) (openapi.DeleteInventoryTransactionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.machineLogbook.DeleteInventoryTransaction(
		ctx,
		p,
		r.TransactionId,
		r.Body.ExpectedInventoryVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteInventoryTransaction204Response{}, nil
}

func (s *Server) RestoreInventoryTransaction(
	ctx context.Context,
	r openapi.RestoreInventoryTransactionRequestObject,
) (openapi.RestoreInventoryTransactionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.machineLogbook.RestoreInventoryTransaction(ctx, p, r.TransactionId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.RestoreInventoryTransaction204Response{}, nil
}

func (s *Server) PurgeInventoryTransaction(
	ctx context.Context,
	r openapi.PurgeInventoryTransactionRequestObject,
) (openapi.PurgeInventoryTransactionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.machineLogbook.PurgeInventoryTransaction(ctx, p, r.TransactionId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.PurgeInventoryTransaction204Response{}, nil
}
