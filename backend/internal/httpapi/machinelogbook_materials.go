package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) ListMaterials(
	ctx context.Context,
	r openapi.ListMaterialsRequestObject,
) (openapi.ListMaterialsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, value, err := s.machineLogbook.ListMaterials(
		ctx,
		p,
		defaultString(r.Params.Search),
		r.Params.MaterialTypeId,
		machinelogbook.MaterialKind(valueString(r.Params.Kind)),
		machinelogbook.StockState(valueString(r.Params.StockState)),
		defaultInt(r.Params.Page, 1),
		defaultInt(r.Params.PageSize, 25),
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Material, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMaterialDTO(item))
	}
	return openapi.ListMaterials200JSONResponse{
		Items:               dto,
		Page:                defaultInt(r.Params.Page, 1),
		PageSize:            defaultInt(r.Params.PageSize, 25),
		Total:               total,
		TotalInventoryValue: value,
	}, nil
}

func (s *Server) CreateMaterial(
	ctx context.Context,
	r openapi.CreateMaterialRequestObject,
) (openapi.CreateMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateMaterial(ctx, p, materialCreateInput(*r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateMaterial201JSONResponse(mlMaterialDTO(item)), nil
}

func (s *Server) GetMaterial(
	ctx context.Context,
	r openapi.GetMaterialRequestObject,
) (openapi.GetMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetMaterial(ctx, p, r.MaterialId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMaterial200JSONResponse(mlMaterialDTO(item)), nil
}

func (s *Server) UpdateMaterial(
	ctx context.Context,
	r openapi.UpdateMaterialRequestObject,
) (openapi.UpdateMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	diameter := decimalNullable(r.Body.FilamentDiameterMm)
	if !r.Body.FilamentDiameterMm.IsSpecified() {
		current, getErr := s.machineLogbook.GetMaterial(ctx, p, r.MaterialId)
		if getErr != nil {
			return nil, getErr
		}
		diameter = current.FilamentDiameterMM
	}
	item, err := s.machineLogbook.UpdateMaterial(
		ctx,
		p,
		r.MaterialId,
		materialUpdateInput(*r.Body, diameter),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMaterial200JSONResponse(mlMaterialDTO(item)), nil
}

func (s *Server) AddMaterialPurchase(
	ctx context.Context,
	r openapi.AddMaterialPurchaseRequestObject,
) (openapi.AddMaterialPurchaseResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.AddPurchase(
		ctx,
		p,
		r.MaterialId,
		r.Body.ExpectedInventoryVersion,
		r.Body.Quantity,
		r.Body.TotalPrice,
		r.Body.OccurredAt,
		nullableStringPointer(r.Body.Supplier),
		nullableStringPointer(r.Body.Reference),
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.AddMaterialPurchase201JSONResponse(mlInventoryResultDTO(item)), nil
}

func (s *Server) RecordMaterialConsumption(
	ctx context.Context,
	r openapi.RecordMaterialConsumptionRequestObject,
) (openapi.RecordMaterialConsumptionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.RecordConsumption(
		ctx,
		p,
		r.MaterialId,
		r.Body.ExpectedInventoryVersion,
		r.Body.Quantity,
		r.Body.OccurredAt,
		r.Body.Disposal,
		nullableStringPointer(r.Body.Reason),
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.RecordMaterialConsumption201JSONResponse(mlInventoryResultDTO(item)), nil
}

func (s *Server) CorrectMaterialStock(
	ctx context.Context,
	r openapi.CorrectMaterialStockRequestObject,
) (openapi.CorrectMaterialStockResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CorrectStock(
		ctx,
		p,
		r.MaterialId,
		r.Body.ExpectedInventoryVersion,
		r.Body.PhysicalQuantity,
		decimalNullable(r.Body.AcquisitionUnitCost),
		r.Body.OccurredAt,
		string(r.Body.Reason),
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CorrectMaterialStock201JSONResponse(mlInventoryResultDTO(item)), nil
}

func (s *Server) MarkMaterialEmpty(
	ctx context.Context,
	r openapi.MarkMaterialEmptyRequestObject,
) (openapi.MarkMaterialEmptyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.MarkEmpty(
		ctx,
		p,
		r.MaterialId,
		r.Body.ExpectedInventoryVersion,
		r.Body.OccurredAt,
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.MarkMaterialEmpty201JSONResponse(mlInventoryResultDTO(item)), nil
}

func (s *Server) ListMaterialTransactions(
	ctx context.Context,
	r openapi.ListMaterialTransactionsRequestObject,
) (openapi.ListMaterialTransactionsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListMaterialTransactions(
		ctx,
		p,
		r.MaterialId,
		defaultInt(r.Params.Page, 1),
		defaultInt(r.Params.PageSize, 25),
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.InventoryTransaction, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlInventoryTransactionDTO(item))
	}
	return openapi.ListMaterialTransactions200JSONResponse{
		Items:    dto,
		Page:     defaultInt(r.Params.Page, 1),
		PageSize: defaultInt(r.Params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) ListMaterialTypes(
	ctx context.Context,
	_ openapi.ListMaterialTypesRequestObject,
) (openapi.ListMaterialTypesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.ListMaterialTypes(ctx, p)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.MaterialType, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMaterialTypeDTO(item))
	}
	return openapi.ListMaterialTypes200JSONResponse{Items: dto}, nil
}

func (s *Server) CreateMaterialType(
	ctx context.Context,
	r openapi.CreateMaterialTypeRequestObject,
) (openapi.CreateMaterialTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateMaterialType(
		ctx,
		p,
		r.Body.Name,
		machinelogbook.MaterialKind(r.Body.Kind),
		string(r.Body.Unit),
		machineProcessStringsPointer(r.Body.Processes),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateMaterialType201JSONResponse(mlMaterialTypeDTO(item)), nil
}

func (s *Server) GetMaterialType(
	ctx context.Context,
	r openapi.GetMaterialTypeRequestObject,
) (openapi.GetMaterialTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetMaterialType(ctx, p, r.MaterialTypeId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMaterialType200JSONResponse(mlMaterialTypeDTO(item)), nil
}

func (s *Server) UpdateMaterialType(
	ctx context.Context,
	r openapi.UpdateMaterialTypeRequestObject,
) (openapi.UpdateMaterialTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateMaterialType(
		ctx,
		p,
		r.MaterialTypeId,
		r.Body.ExpectedVersion,
		r.Body.Name,
		machinelogbook.MaterialKind(valueString(r.Body.Kind)),
		string(r.Body.Unit),
		machineProcessStringsPointer(r.Body.Processes),
		r.Body.Active,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMaterialType200JSONResponse(mlMaterialTypeDTO(item)), nil
}

func (s *Server) DeleteMaterialType(
	ctx context.Context,
	r openapi.DeleteMaterialTypeRequestObject,
) (openapi.DeleteMaterialTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.machineLogbook.DeleteMaterialType(
		ctx,
		p,
		r.MaterialTypeId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteMaterialType204Response{}, nil
}

func materialCreateInput(body openapi.CreateMaterialRequest) machinelogbook.MaterialInput {
	return machinelogbook.MaterialInput{
		Name:               defaultString(body.Name),
		MaterialTypeID:     body.MaterialTypeId,
		Unit:               materialUnitPointer(body.Unit),
		ColorName:          nullableStringPointer(body.ColorName),
		ColorHex:           nullableStringPointer(body.ColorHex),
		Variant:            nullableStringPointer(body.Variant),
		Manufacturer:       nullableStringPointer(body.Manufacturer),
		StorageLocation:    nullableStringPointer(body.StorageLocation),
		Notes:              nullableStringPointer(body.Notes),
		SalePrice:          decimalNullable(body.SalePrice),
		PackageSize:        decimalNullable(body.PackageSize),
		LowStockThreshold:  decimalNullable(body.LowStockThreshold),
		FilamentDiameterMM: decimalNullable(body.FilamentDiameterMm),
	}
}

func materialUpdateInput(body openapi.UpdateMaterialRequest, diameter *string) machinelogbook.MaterialInput {
	return machinelogbook.MaterialInput{
		Name:               defaultString(body.Name),
		MaterialTypeID:     body.MaterialTypeId,
		Unit:               materialUnitPointer(body.Unit),
		ColorName:          nullableStringPointer(body.ColorName),
		ColorHex:           nullableStringPointer(body.ColorHex),
		Variant:            nullableStringPointer(body.Variant),
		Manufacturer:       nullableStringPointer(body.Manufacturer),
		StorageLocation:    nullableStringPointer(body.StorageLocation),
		Notes:              nullableStringPointer(body.Notes),
		SalePrice:          decimalNullable(body.SalePrice),
		PackageSize:        decimalNullable(body.PackageSize),
		LowStockThreshold:  decimalNullable(body.LowStockThreshold),
		FilamentDiameterMM: diameter,
		Active:             body.Active,
		ExpectedVersion:    body.ExpectedVersion,
	}
}
