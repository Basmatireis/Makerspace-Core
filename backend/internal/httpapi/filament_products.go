package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func filamentProductDTO(item machinelogbook.FilamentProduct) openapi.FilamentProduct {
	return openapi.FilamentProduct{
		Id:           item.ID,
		Manufacturer: item.Manufacturer,
		Name:         item.Name,
		MaterialId:   item.MaterialID,
		MaterialName: item.MaterialName,
		NetWeightG:   item.NetWeightG,
		DefaultPrice: nullableMoney(
			item.DefaultPrice,
		),
		Packaging:  openapi.FilamentPackaging(item.Packaging),
		Notes:      nullableString(item.Notes),
		Active:     item.Active,
		InUseCount: item.InUseCount,
		Version:    item.Version,
		CreatedAt:  item.CreatedAt,
		UpdatedAt:  item.UpdatedAt,
	}
}

func (s *Server) ListFilamentProducts(
	ctx context.Context,
	r openapi.ListFilamentProductsRequestObject,
) (openapi.ListFilamentProductsResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	params := r.Params
	items, total, e := s.machineLogbook.ListFilamentProducts(
		ctx,
		p,
		machinelogbook.FilamentProductFilters{
			Search:       defaultString(params.Search),
			MaterialID:   params.MaterialId,
			Manufacturer: defaultString(params.Manufacturer),
			Packaging: machinelogbook.Packaging(valueString(
				params.Packaging,
			)),
			IncludeInactive: valueBool(params.IncludeInactive),
			Page:            defaultInt(params.Page, 1),
			PageSize:        defaultInt(params.PageSize, 25),
		},
	)
	if e != nil {
		return nil, e
	}
	dto := make([]openapi.FilamentProduct, 0, len(items))
	for _, item := range items {
		dto = append(dto, filamentProductDTO(item))
	}
	return openapi.ListFilamentProducts200JSONResponse{
		Items:    dto,
		Page:     defaultInt(params.Page, 1),
		PageSize: defaultInt(params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) GetFilamentProduct(
	ctx context.Context,
	r openapi.GetFilamentProductRequestObject,
) (openapi.GetFilamentProductResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	item, e := s.machineLogbook.GetFilamentProduct(ctx, p, r.ProductId)
	if e != nil {
		return nil, e
	}
	return openapi.GetFilamentProduct200JSONResponse(filamentProductDTO(item)), nil
}

func (s *Server) CreateFilamentProduct(
	ctx context.Context,
	r openapi.CreateFilamentProductRequestObject,
) (openapi.CreateFilamentProductResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := r.Body
	item, e := s.machineLogbook.CreateFilamentProduct(
		ctx,
		p,
		machinelogbook.FilamentProductInput{
			Manufacturer: body.Manufacturer,
			Name:         body.Name,
			MaterialID:   body.MaterialId,
			NetWeightG:   body.NetWeightG,
			DefaultPrice: decimalMoneyNullable(
				body.DefaultPrice,
			),
			Packaging: machinelogbook.Packaging(body.Packaging),
			Notes:     nullableStringPointer(body.Notes),
			Active:    true,
		},
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	return openapi.CreateFilamentProduct201JSONResponse(filamentProductDTO(item)), nil
}

func (s *Server) UpdateFilamentProduct(
	ctx context.Context,
	r openapi.UpdateFilamentProductRequestObject,
) (openapi.UpdateFilamentProductResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := r.Body
	item, e := s.machineLogbook.UpdateFilamentProduct(
		ctx,
		p,
		r.ProductId,
		machinelogbook.FilamentProductInput{
			Manufacturer: body.Manufacturer,
			Name:         body.Name,
			MaterialID:   body.MaterialId,
			NetWeightG:   body.NetWeightG,
			DefaultPrice: decimalMoneyNullable(
				body.DefaultPrice,
			),
			Packaging:       machinelogbook.Packaging(body.Packaging),
			Notes:           nullableStringPointer(body.Notes),
			Active:          body.Active,
			ExpectedVersion: body.ExpectedVersion,
		},
		requestIDPointer(ctx),
	)
	if e != nil {
		return nil, e
	}
	return openapi.UpdateFilamentProduct200JSONResponse(filamentProductDTO(item)), nil
}
