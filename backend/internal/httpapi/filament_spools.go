package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
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

func spoolDTO(item machinelogbook.FilamentSpool) openapi.FilamentSpool {
	acquired := nullable.NewNullNullable[openapi_types.Date]()
	if item.AcquiredOn != nil {
		acquired = nullable.NewNullableWithValue(openapi_types.Date{Time: *item.AcquiredOn})
	}
	unit := nullable.NewNullNullable[openapi.MaterialUnit]()
	if item.Unit != nil {
		unit = nullable.NewNullableWithValue(openapi.MaterialUnit(*item.Unit))
	}
	dto := openapi.FilamentSpool{
		Id:        item.ID,
		DisplayId: item.DisplayID,
		Kind:      openapi.FilamentSpoolKind(item.Kind),
		Label:     nullableString(item.Label),
		Status:    openapi.FilamentSpoolStatus(item.Status),
		FillNumber: int(
			item.FillNumber,
		),
		FillId:     nullableUUIDValue(item.FillID),
		FilledAt:   nullableTimeValue(item.FilledAt),
		ArchivedAt: nullableTimeValue(item.ArchivedAt),
		MaterialId: nullableUUIDValue(
			item.MaterialID,
		),
		MaterialName:     nullableString(item.MaterialName),
		MaterialTypeName: nullableString(item.MaterialTypeName),
		ColorName:        nullableString(item.ColorName),
		ColorHex:         nullableString(item.ColorHex),
		Unit:             unit,
		ProductId: nullableUUIDValue(
			item.ProductID,
		),
		Manufacturer:         nullableString(item.Manufacturer),
		ProductName:          nullableString(item.ProductName),
		InitialNetWeightG:    nullableDecimalValue(item.InitialNetWeightG),
		RemainingQuantity:    item.RemainingQuantity,
		TareWeightG:          nullableDecimalValue(item.TareWeightG),
		AcquiredOn:           acquired,
		AcquisitionReference: nullableString(item.AcquisitionReference),
		StorageLocation: nullableString(
			item.StorageLocation,
		),
		Notes:     nullableString(item.Notes),
		Lifecycle: openapi.FilamentSpoolLifecycle(item.Lifecycle),
		Mounted:   item.Mounted,
		MountedOn: spoolMountDTO(item.MountedOn),
		Identifiers: spoolIdentifiersDTO(
			item.Identifiers,
		),
		Version:   item.Version,
		CreatedAt: item.CreatedAt,
		UpdatedAt: item.UpdatedAt,
	}
	if item.Fills != nil {
		fills := make([]openapi.FilamentSpoolFill, 0, len(item.Fills))
		for _, f := range item.Fills {
			fills = append(
				fills,
				openapi.FilamentSpoolFill{
					Id:           f.ID,
					FillNumber:   int(f.FillNumber),
					MaterialId:   f.MaterialID,
					MaterialName: f.MaterialName,
					ProductId:    nullableUUIDValue(f.ProductID),
					Manufacturer: nullableString(
						f.Manufacturer,
					),
					ProductName:       nullableString(f.ProductName),
					InitialNetWeightG: f.InitialNetWeightG,
					UsedG:             f.UsedG,
					LeftoverG:         f.LeftoverG,
					LeftoverOutcome: openapi.LeftoverOutcome(
						f.Outcome,
					),
					FilledAt:    f.FilledAt,
					ClosedAt:    f.ClosedAt,
					Identifiers: spoolIdentifiersDTO(f.Identifiers),
				},
			)
		}
		dto.Fills = &fills
	}
	return dto
}

func leftoverInput(v openapi.FilamentLeftoverInput) machinelogbook.LeftoverInput {
	var disposition *string
	if d := v.Disposition; d.IsSpecified() && !d.IsNull() {
		value := string(d.GetOrEmpty())
		disposition = &value
	}
	return machinelogbook.LeftoverInput{
		Basis:        string(v.Basis),
		GrossWeightG: decimalNullable(v.GrossWeightG),
		Disposition:  disposition,
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
		Search:     defaultString(params.Search),
		MaterialID: params.MaterialId,
		Lifecycle:  valueString(params.Lifecycle),
		Location:   defaultString(params.Location),
		Kind: valueString(
			params.Kind,
		),
		Mounted:      params.Mounted,
		ProductID:    params.ProductId,
		Manufacturer: defaultString(params.Manufacturer),
		Consumable:   valueBool(params.Consumable),
		Page:         defaultInt(params.Page, 1),
		PageSize:     defaultInt(params.PageSize, 25),
	}
	if params.Status != nil {
		for _, status := range *params.Status {
			filters.Statuses = append(filters.Statuses, string(status))
		}
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
	item, e := s.machineLogbook.LookupFilamentSpool(ctx, p, string(r.Params.Kind), r.Params.Value)
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
	kind := ""
	if body.Kind != nil {
		kind = string(*body.Kind)
	}
	item, e := s.machineLogbook.CreateFilamentSpool(
		ctx,
		p,
		machinelogbook.FilamentSpoolInput{
			Kind:                     kind,
			Label:                    defaultString(nullableStringPointer(body.Label)),
			ProductID:                uuidNullable(body.ProductId),
			MaterialID:               valueOrZero(body.MaterialId),
			InitialNetWeightG:        valueOrZero(body.InitialNetWeightG),
			StockMode:                string(body.StockMode),
			Supplier:                 nullableStringPointer(body.Supplier),
			TotalPrice:               decimalMoneyNullable(body.TotalPrice),
			Manufacturer:             nullableStringPointer(body.Manufacturer),
			ProductName:              nullableStringPointer(body.ProductName),
			TareWeightG:              decimalNullable(body.TareWeightG),
			AcquiredOn:               nullableDate(body.AcquiredOn),
			AcquisitionReference:     nullableStringPointer(body.AcquisitionReference),
			StorageLocation:          nullableStringPointer(body.StorageLocation),
			Notes:                    nullableStringPointer(body.Notes),
			OccurredAt:               body.OccurredAt,
			ExpectedInventoryVersion: valueOrZero(body.ExpectedInventoryVersion),
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
			Kind:                 stringEnum(body.Kind),
			Label:                nullableStringPointer(body.Label),
			Manufacturer:         nullableStringPointer(body.Manufacturer),
			ProductName:          nullableStringPointer(body.ProductName),
			TareWeightG:          decimalNullable(body.TareWeightG),
			AcquiredOn:           nullableDate(body.AcquiredOn),
			AcquisitionReference: nullableStringPointer(body.AcquisitionReference),
			StorageLocation:      nullableStringPointer(body.StorageLocation),
			Notes:                nullableStringPointer(body.Notes),
			Lifecycle:            string(body.Lifecycle),
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
		string(r.Body.Kind),
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
	if e = s.machineLogbook.DeleteFilamentSpoolIdentifier(ctx, p, r.SpoolId, r.IdentifierId, requestIDPointer(ctx)); e != nil {
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
		string(r.Body.Quantity),
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
		string(r.Body.Quantity),
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
		string(r.Body.PhysicalQuantity),
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
	v := string(value.GetOrEmpty())
	return &v
}
func valueBool(value *bool) bool { return value != nil && *value }

func (s *Server) ChangeFilamentSpoolFill(
	ctx context.Context,
	r openapi.ChangeFilamentSpoolFillRequestObject,
) (openapi.ChangeFilamentSpoolFillResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := r.Body
	input := machinelogbook.ChangeFillInput{OccurredAt: body.OccurredAt, ExpectedVersion: body.ExpectedVersion,
		Fill: machinelogbook.NewFillInput{
			ProductID:    uuidNullable(body.Fill.ProductId),
			MaterialID:   body.Fill.MaterialId,
			Manufacturer: nullableStringPointer(body.Fill.Manufacturer),
			ProductName:  nullableStringPointer(body.Fill.ProductName),
			NetWeightG: string(
				body.Fill.NetWeightG,
			),
			Source:     string(body.Fill.Source),
			TotalPrice: decimalMoneyNullable(body.Fill.TotalPrice),
			Supplier:   nullableStringPointer(body.Fill.Supplier),
		}}
	if l := body.Leftover; l.IsSpecified() && !l.IsNull() {
		leftover := leftoverInput(l.GetOrEmpty())
		input.Leftover = &leftover
	}
	input.KeepIdentifierIDs = append(input.KeepIdentifierIDs, body.KeepIdentifierIds...)
	for _, identifier := range body.NewIdentifiers {
		input.NewIdentifiers = append(
			input.NewIdentifiers,
			machinelogbook.NewSpoolIdentifier{Kind: string(identifier.Kind), Value: identifier.Value},
		)
	}
	item, e := s.machineLogbook.ChangeFilamentSpoolFill(ctx, p, r.SpoolId, input, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.ChangeFilamentSpoolFill201JSONResponse(spoolDTO(item)), nil
}

func (s *Server) FinishFilamentSpool(
	ctx context.Context,
	r openapi.FinishFilamentSpoolRequestObject,
) (openapi.FinishFilamentSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.machineLogbook.FinishFilamentSpool(
		ctx,
		p,
		r.SpoolId,
		machinelogbook.FinishSpoolInput{
			Leftover:        leftoverInput(r.Body.Leftover),
			OccurredAt:      r.Body.OccurredAt,
			ExpectedVersion: r.Body.ExpectedVersion,
		},
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	return openapi.FinishFilamentSpool200JSONResponse(spoolDTO(item)), nil
}

func (s *Server) CleanUpArchivedFilamentSpools(
	ctx context.Context,
	r openapi.CleanUpArchivedFilamentSpoolsRequestObject,
) (openapi.CleanUpArchivedFilamentSpoolsResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	var ids []uuid.UUID
	if r.Body.SpoolIds != nil {
		ids = *r.Body.SpoolIds
	}
	items, deleted, e := s.machineLogbook.CleanUpFilamentSpools(
		ctx,
		p,
		int(r.Body.OlderThanMonths),
		r.Body.DryRun,
		ids,
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	dto := make([]openapi.CleanUpFilamentSpoolCandidate, 0, len(items))
	for _, item := range items {
		dto = append(
			dto,
			openapi.CleanUpFilamentSpoolCandidate{
				Id:         item.ID,
				DisplayId:  item.DisplayID,
				Label:      nullableString(item.Label),
				ArchivedAt: item.ArchivedAt,
			},
		)
	}
	return openapi.CleanUpArchivedFilamentSpools200JSONResponse{Items: dto, Deleted: deleted}, nil
}
