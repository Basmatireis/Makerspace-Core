package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func nullableInt32Value(value *int32) nullable.Nullable[int] {
	if value == nil {
		return nullable.NewNullNullable[int]()
	}
	return nullable.NewNullableWithValue(int(*value))
}

func nullableTimeValue(value *time.Time) nullable.Nullable[time.Time] {
	if value == nil {
		return nullable.NewNullNullable[time.Time]()
	}
	return nullable.NewNullableWithValue(*value)
}

func spoolIdentifiersDTO(items []machinelogbook.FilamentSpoolIdentifier) []openapi.FilamentSpoolIdentifier {
	identifiers := make([]openapi.FilamentSpoolIdentifier, 0, len(items))
	for _, v := range items {
		identifiers = append(
			identifiers,
			openapi.FilamentSpoolIdentifier{
				Id:        v.ID,
				Kind:      openapi.FilamentSpoolIdentifierKind(v.Kind),
				Value:     v.Value,
				CreatedAt: v.CreatedAt,
			},
		)
	}
	return identifiers
}

func valueOrZero[T any](value *T) T {
	var zero T
	if value == nil {
		return zero
	}
	return *value
}

func spoolMountDTO(item *machinelogbook.SpoolMount) nullable.Nullable[openapi.FilamentSpoolMount] {
	if item == nil {
		return nullable.NewNullNullable[openapi.FilamentSpoolMount]()
	}
	return nullable.NewNullableWithValue(
		openapi.FilamentSpoolMount{
			MachineId:     item.MachineID,
			MachineName:   item.MachineName,
			InputUnitName: nullableString(item.InputUnitName),
			SlotId:        item.SlotID,
			SlotName:      item.SlotName,
		},
	)
}

func attentionDTO(items []machinelogbook.Attention) []openapi.InventoryAttention {
	out := make([]openapi.InventoryAttention, 0, len(items))
	for _, item := range items {
		out = append(out, openapi.InventoryAttention{Code: openapi.InventoryAttentionCode(item.Code), Message: item.Message})
	}
	return out
}

func spoolDTO(item machinelogbook.FilamentSpool) openapi.FilamentSpool {
	acquired := nullable.NewNullNullable[openapi_types.Date]()
	if item.AcquiredOn != nil {
		acquired = nullable.NewNullableWithValue(openapi_types.Date{Time: *item.AcquiredOn})
	}
	outcome := nullable.NewNullNullable[openapi.SpoolRetireOutcome]()
	if item.RetiredOutcome != nil {
		outcome = nullable.NewNullableWithValue(openapi.SpoolRetireOutcome(*item.RetiredOutcome))
	}
	return openapi.FilamentSpool{
		Id:                   item.ID,
		DisplayId:            item.DisplayID,
		MaterialId:           item.MaterialID,
		MaterialDisplayId:    item.MaterialDisplayID,
		MaterialName:         item.MaterialName,
		MaterialTypeName:     item.MaterialTypeName,
		ColorName:            nullableString(item.ColorName),
		ColorHex:             nullableString(item.ColorHex),
		Manufacturer:         nullableString(item.Manufacturer),
		Unit:                 openapi.MaterialUnit(item.Unit),
		InitialNetWeightG:    item.InitialNetWeightG,
		RemainingQuantity:    item.RemainingQuantity,
		TareWeightG:          nullableDecimalValue(item.TareWeightG),
		AcquiredOn:           acquired,
		AcquisitionReference: nullableString(item.AcquisitionReference),
		StorageLocation:      nullableString(item.StorageLocation),
		Notes:                nullableString(item.Notes),
		Lifecycle:            openapi.FilamentSpoolLifecycle(item.Lifecycle),
		ArchivedAt:           nullableTimeValue(item.ArchivedAt),
		RetiredOutcome:       outcome,
		RetiredQuantity:      nullableDecimalValue(item.RetiredQuantity),
		RetiredByName:        nullableString(item.RetiredByName),
		Mounted:              item.Mounted,
		MountedOn:            spoolMountDTO(item.MountedOn),
		Identifiers:          spoolIdentifiersDTO(item.Identifiers),
		Attention:            attentionDTO(item.Attention),
		Version:              item.Version,
		CreatedAt:            item.CreatedAt,
		UpdatedAt:            item.UpdatedAt,
	}
}

func nullableDate(value nullable.Nullable[openapi_types.Date]) *time.Time {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	v := value.GetOrEmpty().Time
	return &v
}

func (s *Server) ListFilamentSpools(
	ctx context.Context,
	r openapi.ListFilamentSpoolsRequestObject,
) (openapi.ListFilamentSpoolsResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	params := r.Params
	filters := machinelogbook.SpoolFilters{
		Search:       defaultString(params.Search),
		MaterialID:   params.MaterialId,
		Lifecycle:    machinelogbook.SpoolLifecycle(valueString(params.Lifecycle)),
		Location:     defaultString(params.Location),
		Mounted:      params.Mounted,
		Manufacturer: defaultString(params.Manufacturer),
		Consumable:   valueBool(params.Consumable),
		Page:         defaultInt(params.Page, 1),
		PageSize:     defaultInt(params.PageSize, 25),
	}
	items, total, e := s.machineLogbook.ListFilamentSpools(ctx, p, filters)
	if e != nil {
		return nil, e
	}
	dto := make([]openapi.FilamentSpool, 0, len(items))
	for _, v := range items {
		dto = append(dto, spoolDTO(v))
	}
	return openapi.ListFilamentSpools200JSONResponse{
		Items:    dto,
		Page:     defaultInt(r.Params.Page, 1),
		PageSize: defaultInt(r.Params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) GetFilamentSpool(
	ctx context.Context,
	r openapi.GetFilamentSpoolRequestObject,
) (openapi.GetFilamentSpoolResponseObject, error) {
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

func (s *Server) LookupFilamentSpool(
	ctx context.Context,
	r openapi.LookupFilamentSpoolRequestObject,
) (openapi.LookupFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	item, e := s.machineLogbook.LookupFilamentSpool(
		ctx,
		p,
		machinelogbook.IdentifierKind(r.Params.Kind),
		r.Params.Value,
	)
	if e != nil {
		return nil, e
	}
	return openapi.LookupFilamentSpool200JSONResponse(spoolDTO(item)), nil
}

func (s *Server) CreateFilamentSpool(
	ctx context.Context,
	r openapi.CreateFilamentSpoolRequestObject,
) (openapi.CreateFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := r.Body
	var identifiers []machinelogbook.NewSpoolIdentifier
	if body.Identifiers != nil {
		for _, identifier := range *body.Identifiers {
			identifiers = append(
				identifiers,
				machinelogbook.NewSpoolIdentifier{
					Kind:  machinelogbook.IdentifierKind(identifier.Kind),
					Value: identifier.Value,
				},
			)
		}
	}
	item, e := s.machineLogbook.CreateFilamentSpool(
		ctx,
		p,
		machinelogbook.FilamentSpoolInput{
			MaterialID:               body.MaterialId,
			InitialNetWeightG:        body.InitialNetWeightG,
			StockMode:                machinelogbook.StockMode(body.StockMode),
			Supplier:                 nullableStringPointer(body.Supplier),
			TotalPrice:               decimalMoneyNullable(body.TotalPrice),
			TareWeightG:              decimalNullable(body.TareWeightG),
			AcquiredOn:               nullableDate(body.AcquiredOn),
			AcquisitionReference:     nullableStringPointer(body.AcquisitionReference),
			StorageLocation:          nullableStringPointer(body.StorageLocation),
			Notes:                    nullableStringPointer(body.Notes),
			OccurredAt:               body.OccurredAt,
			ExpectedInventoryVersion: body.ExpectedInventoryVersion,
			Identifiers:              identifiers,
		},
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	return openapi.CreateFilamentSpool201JSONResponse(spoolDTO(item)), nil
}

func (s *Server) UpdateFilamentSpool(
	ctx context.Context,
	r openapi.UpdateFilamentSpoolRequestObject,
) (openapi.UpdateFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := r.Body
	item, e := s.machineLogbook.UpdateFilamentSpool(
		ctx,
		p,
		r.SpoolId,
		machinelogbook.FilamentSpoolUpdate{
			ExpectedVersion:      body.ExpectedVersion,
			TareWeightG:          decimalNullable(body.TareWeightG),
			AcquiredOn:           nullableDate(body.AcquiredOn),
			AcquisitionReference: nullableStringPointer(body.AcquisitionReference),
			StorageLocation:      nullableStringPointer(body.StorageLocation),
			Notes:                nullableStringPointer(body.Notes),
		},
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	return openapi.UpdateFilamentSpool200JSONResponse(spoolDTO(item)), nil
}

func (s *Server) AddFilamentSpoolIdentifier(
	ctx context.Context,
	r openapi.AddFilamentSpoolIdentifierRequestObject,
) (openapi.AddFilamentSpoolIdentifierResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.AddFilamentSpoolIdentifier(
		ctx,
		p,
		r.SpoolId,
		machinelogbook.IdentifierKind(r.Body.Kind),
		r.Body.Value,
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	return openapi.AddFilamentSpoolIdentifier201JSONResponse{
		Id:        item.ID,
		Kind:      openapi.FilamentSpoolIdentifierKind(item.Kind),
		Value:     item.Value,
		CreatedAt: item.CreatedAt,
	}, nil
}

func (s *Server) DeleteFilamentSpoolIdentifier(
	ctx context.Context,
	r openapi.DeleteFilamentSpoolIdentifierRequestObject,
) (openapi.DeleteFilamentSpoolIdentifierResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if e = s.machineLogbook.DeleteFilamentSpoolIdentifier(
		ctx,
		p,
		r.SpoolId,
		r.IdentifierId,
		requestIDPointer(ctx),
	); e != nil {
		return nil, e
	}
	return openapi.DeleteFilamentSpoolIdentifier204Response{}, nil
}

func (s *Server) ListFilamentSpoolTransactions(
	ctx context.Context,
	r openapi.ListFilamentSpoolTransactionsRequestObject,
) (openapi.ListFilamentSpoolTransactionsResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	items, total, e := s.machineLogbook.ListFilamentSpoolTransactions(
		ctx,
		p,
		r.SpoolId,
		defaultInt(r.Params.Page, 1),
		defaultInt(r.Params.PageSize, 25),
	)
	if e != nil {
		return nil, e
	}
	dto := make([]openapi.InventoryTransaction, 0, len(items))
	for _, v := range items {
		dto = append(dto, mlInventoryTransactionDTO(v))
	}
	return openapi.ListFilamentSpoolTransactions200JSONResponse{
		Items:    dto,
		Page:     defaultInt(r.Params.Page, 1),
		PageSize: defaultInt(r.Params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) TransferSpoolStock(
	ctx context.Context,
	r openapi.TransferSpoolStockRequestObject,
) (openapi.TransferSpoolStockResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.TransferSpoolStock(
		ctx,
		p,
		r.MaterialId,
		r.Body.ExpectedInventoryVersion,
		uuidNullable(r.Body.FromSpoolId),
		uuidNullable(r.Body.ToSpoolId),
		r.Body.Quantity,
		r.Body.OccurredAt,
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	return openapi.TransferSpoolStock201JSONResponse(mlInventoryTransactionDTO(item)), nil
}

func (s *Server) ConsumeFilamentSpool(
	ctx context.Context,
	r openapi.ConsumeFilamentSpoolRequestObject,
) (openapi.ConsumeFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.ConsumeFilamentSpool(
		ctx,
		p,
		r.SpoolId,
		r.Body.ExpectedInventoryVersion,
		r.Body.ExpectedSpoolVersion,
		r.Body.Quantity,
		r.Body.OccurredAt,
		valueBool(r.Body.Disposal),
		nullableStringPointer(r.Body.Reason),
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	return openapi.ConsumeFilamentSpool201JSONResponse(mlInventoryResultDTO(item)), nil
}

func (s *Server) CorrectFilamentSpoolStock(
	ctx context.Context,
	r openapi.CorrectFilamentSpoolStockRequestObject,
) (openapi.CorrectFilamentSpoolStockResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.CorrectFilamentSpoolStock(
		ctx,
		p,
		r.SpoolId,
		r.Body.ExpectedInventoryVersion,
		r.Body.ExpectedSpoolVersion,
		r.Body.PhysicalQuantity,
		decimalNullable(r.Body.AcquisitionUnitCost),
		r.Body.OccurredAt,
		string(r.Body.Reason),
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	return openapi.CorrectFilamentSpoolStock201JSONResponse(mlInventoryResultDTO(item)), nil
}

func decimalMoneyNullable(value nullable.Nullable[openapi.Money]) *string {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	v := value.GetOrEmpty()
	return &v
}
func valueBool(value *bool) bool { return value != nil && *value }

func (s *Server) RetireFilamentSpool(
	ctx context.Context,
	r openapi.RetireFilamentSpoolRequestObject,
) (openapi.RetireFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.RetireFilamentSpool(
		ctx,
		p,
		r.SpoolId,
		r.Body.ExpectedVersion,
		machinelogbook.SpoolRetireOutcome(r.Body.Outcome),
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	return openapi.RetireFilamentSpool200JSONResponse(spoolDTO(item)), nil
}

func (s *Server) RestoreFilamentSpool(
	ctx context.Context,
	r openapi.RestoreFilamentSpoolRequestObject,
) (openapi.RestoreFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.RestoreFilamentSpool(ctx, p, r.SpoolId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.RestoreFilamentSpool200JSONResponse(spoolDTO(item)), nil
}

func (s *Server) PurgeFilamentSpool(
	ctx context.Context,
	r openapi.PurgeFilamentSpoolRequestObject,
) (openapi.PurgeFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if e = s.machineLogbook.PurgeFilamentSpool(ctx, p, r.SpoolId, r.Body.ExpectedVersion, requestIDPointer(ctx)); e != nil {
		return nil, e
	}
	return openapi.PurgeFilamentSpool204Response{}, nil
}
