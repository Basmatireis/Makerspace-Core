package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func spoolDTO(item machinelogbook.FilamentSpool) openapi.FilamentSpool {
	identifiers := make([]openapi.FilamentSpoolIdentifier, 0, len(item.Identifiers))
	for _, v := range item.Identifiers {
		identifiers = append(identifiers, openapi.FilamentSpoolIdentifier{Id: v.ID, Kind: openapi.FilamentSpoolIdentifierKind(v.Kind), Value: v.Value, CreatedAt: v.CreatedAt})
	}
	acquired := nullable.NewNullNullable[openapi_types.Date]()
	if item.AcquiredOn != nil {
		acquired = nullable.NewNullableWithValue(openapi_types.Date{Time: *item.AcquiredOn})
	}
	return openapi.FilamentSpool{Id: item.ID, DisplayId: item.DisplayID, MaterialId: item.MaterialID, MaterialName: item.MaterialName, Category: item.Category, Color: nullableString(item.Color), Unit: openapi.MaterialUnit(item.Unit), Manufacturer: nullableString(item.Manufacturer), ProductName: nullableString(item.ProductName), InitialNetWeightG: item.InitialNetWeightG, RemainingQuantity: item.RemainingQuantity, TareWeightG: nullableDecimalValue(item.TareWeightG), AcquiredOn: acquired, AcquisitionReference: nullableString(item.AcquisitionReference), StorageLocation: nullableString(item.StorageLocation), Notes: nullableString(item.Notes), Lifecycle: openapi.FilamentSpoolLifecycle(item.Lifecycle), Mounted: item.Mounted, Identifiers: identifiers, Version: item.Version, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}

func nullableDate(value nullable.Nullable[openapi_types.Date]) *time.Time {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	v := value.GetOrEmpty().Time
	return &v
}

func (s *Server) ListFilamentSpools(ctx context.Context, r openapi.ListFilamentSpoolsRequestObject) (openapi.ListFilamentSpoolsResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	items, total, e := s.machineLogbook.ListFilamentSpools(ctx, p, defaultString(r.Params.Search), r.Params.MaterialId, valueString(r.Params.Lifecycle), defaultString(r.Params.Location), defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if e != nil {
		return nil, e
	}
	dto := make([]openapi.FilamentSpool, 0, len(items))
	for _, v := range items {
		dto = append(dto, spoolDTO(v))
	}
	return openapi.ListFilamentSpools200JSONResponse{Items: dto, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25), Total: total}, nil
}
func (s *Server) GetFilamentSpool(ctx context.Context, r openapi.GetFilamentSpoolRequestObject) (openapi.GetFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	item, e := s.machineLogbook.GetFilamentSpool(ctx, p, r.SpoolId)
	if e != nil {
		return nil, e
	}
	return openapi.GetFilamentSpool200JSONResponse(spoolDTO(item)), nil
}
func (s *Server) LookupFilamentSpool(ctx context.Context, r openapi.LookupFilamentSpoolRequestObject) (openapi.LookupFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	item, e := s.machineLogbook.LookupFilamentSpool(ctx, p, string(r.Params.Kind), r.Params.Value)
	if e != nil {
		return nil, e
	}
	return openapi.LookupFilamentSpool200JSONResponse(spoolDTO(item)), nil
}
func (s *Server) CreateFilamentSpool(ctx context.Context, r openapi.CreateFilamentSpoolRequestObject) (openapi.CreateFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.CreateFilamentSpool(ctx, p, machinelogbook.FilamentSpoolInput{MaterialID: r.Body.MaterialId, InitialNetWeightG: string(r.Body.InitialNetWeightG), StockMode: string(r.Body.StockMode), TotalPrice: decimalMoneyNullable(r.Body.TotalPrice), Manufacturer: nullableStringPointer(r.Body.Manufacturer), ProductName: nullableStringPointer(r.Body.ProductName), TareWeightG: decimalNullable(r.Body.TareWeightG), AcquiredOn: nullableDate(r.Body.AcquiredOn), AcquisitionReference: nullableStringPointer(r.Body.AcquisitionReference), StorageLocation: nullableStringPointer(r.Body.StorageLocation), Notes: nullableStringPointer(r.Body.Notes), OccurredAt: r.Body.OccurredAt, ExpectedInventoryVersion: r.Body.ExpectedInventoryVersion}, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.CreateFilamentSpool201JSONResponse(spoolDTO(item)), nil
}
func (s *Server) UpdateFilamentSpool(ctx context.Context, r openapi.UpdateFilamentSpoolRequestObject) (openapi.UpdateFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.UpdateFilamentSpool(ctx, p, r.SpoolId, r.Body.ExpectedVersion, nullableStringPointer(r.Body.Manufacturer), nullableStringPointer(r.Body.ProductName), decimalNullable(r.Body.TareWeightG), nullableDate(r.Body.AcquiredOn), nullableStringPointer(r.Body.AcquisitionReference), nullableStringPointer(r.Body.StorageLocation), nullableStringPointer(r.Body.Notes), string(r.Body.Lifecycle), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.UpdateFilamentSpool200JSONResponse(spoolDTO(item)), nil
}
func (s *Server) AddFilamentSpoolIdentifier(ctx context.Context, r openapi.AddFilamentSpoolIdentifierRequestObject) (openapi.AddFilamentSpoolIdentifierResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.AddFilamentSpoolIdentifier(ctx, p, r.SpoolId, string(r.Body.Kind), r.Body.Value, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.AddFilamentSpoolIdentifier201JSONResponse{Id: item.ID, Kind: openapi.FilamentSpoolIdentifierKind(item.Kind), Value: item.Value, CreatedAt: item.CreatedAt}, nil
}
func (s *Server) DeleteFilamentSpoolIdentifier(ctx context.Context, r openapi.DeleteFilamentSpoolIdentifierRequestObject) (openapi.DeleteFilamentSpoolIdentifierResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if e = s.machineLogbook.DeleteFilamentSpoolIdentifier(ctx, p, r.SpoolId, r.IdentifierId, requestIDPointer(ctx)); e != nil {
		return nil, e
	}
	return openapi.DeleteFilamentSpoolIdentifier204Response{}, nil
}
func (s *Server) ListFilamentSpoolTransactions(ctx context.Context, r openapi.ListFilamentSpoolTransactionsRequestObject) (openapi.ListFilamentSpoolTransactionsResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	items, total, e := s.machineLogbook.ListFilamentSpoolTransactions(ctx, p, r.SpoolId, defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if e != nil {
		return nil, e
	}
	dto := make([]openapi.InventoryTransaction, 0, len(items))
	for _, v := range items {
		dto = append(dto, mlInventoryTransactionDTO(v))
	}
	return openapi.ListFilamentSpoolTransactions200JSONResponse{Items: dto, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25), Total: total}, nil
}
func (s *Server) TransferSpoolStock(ctx context.Context, r openapi.TransferSpoolStockRequestObject) (openapi.TransferSpoolStockResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.TransferSpoolStock(ctx, p, r.MaterialId, r.Body.ExpectedInventoryVersion, uuidNullable(r.Body.FromSpoolId), uuidNullable(r.Body.ToSpoolId), string(r.Body.Quantity), r.Body.OccurredAt, nullableStringPointer(r.Body.Note), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.TransferSpoolStock201JSONResponse(mlInventoryTransactionDTO(item)), nil
}
func (s *Server) ConsumeFilamentSpool(ctx context.Context, r openapi.ConsumeFilamentSpoolRequestObject) (openapi.ConsumeFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.ConsumeFilamentSpool(ctx, p, r.SpoolId, r.Body.ExpectedInventoryVersion, r.Body.ExpectedSpoolVersion, string(r.Body.Quantity), r.Body.OccurredAt, valueBool(r.Body.Disposal), nullableStringPointer(r.Body.Reason), nullableStringPointer(r.Body.Note), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.ConsumeFilamentSpool201JSONResponse(mlInventoryResultDTO(item)), nil
}
func (s *Server) CorrectFilamentSpoolStock(ctx context.Context, r openapi.CorrectFilamentSpoolStockRequestObject) (openapi.CorrectFilamentSpoolStockResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.CorrectFilamentSpoolStock(ctx, p, r.SpoolId, r.Body.ExpectedInventoryVersion, r.Body.ExpectedSpoolVersion, string(r.Body.PhysicalQuantity), decimalNullable(r.Body.AcquisitionUnitCost), r.Body.OccurredAt, string(r.Body.Reason), nullableStringPointer(r.Body.Note), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.CorrectFilamentSpoolStock201JSONResponse(mlInventoryResultDTO(item)), nil
}

func decimalMoneyNullable(value nullable.Nullable[openapi.Money]) *string {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	v := string(value.GetOrEmpty())
	return &v
}
func valueBool(value *bool) bool { return value != nil && *value }
