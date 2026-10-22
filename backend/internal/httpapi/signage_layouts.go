package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/oapi-codegen/nullable"
)

func signageCustomZoneDTO(zone signage.CustomZone) openapi.SignageCustomLayoutZone {
	dto := openapi.SignageCustomLayoutZone{
		Id:    zone.ID,
		Label: zone.Label,
		Grid:  nullable.NewNullNullable[openapi.SignageGridPlacement](),
		Rect:  nullable.NewNullNullable[openapi.SignageFreeRect](),
	}
	if zone.Grid != nil {
		dto.Grid = nullable.NewNullableWithValue(openapi.SignageGridPlacement{
			Col: zone.Grid.Col, Row: zone.Grid.Row, ColSpan: zone.Grid.ColSpan, RowSpan: zone.Grid.RowSpan,
		})
	}
	if zone.Rect != nil {
		dto.Rect = nullable.NewNullableWithValue(openapi.SignageFreeRect{
			X: zone.Rect.X, Y: zone.Rect.Y, Width: zone.Rect.Width, Height: zone.Rect.Height,
		})
	}
	return dto
}

func signageCustomZoneDTOs(zones []signage.CustomZone) []openapi.SignageCustomLayoutZone {
	result := make([]openapi.SignageCustomLayoutZone, 0, len(zones))
	for _, zone := range zones {
		result = append(result, signageCustomZoneDTO(zone))
	}
	return result
}

func signageCustomLayoutDTO(layout signage.CustomLayout) openapi.SignageCustomLayout {
	return openapi.SignageCustomLayout{
		Id:         layout.ID,
		Name:       layout.Name,
		Mode:       openapi.SignageCustomLayoutMode(layout.Mode),
		Columns:    layout.Columns,
		Rows:       layout.Rows,
		Zones:      signageCustomZoneDTOs(layout.Zones),
		SceneCount: layout.SceneCount,
		Version:    layout.Version,
		CreatedAt:  layout.CreatedAt,
		UpdatedAt:  layout.UpdatedAt,
	}
}

func signageCustomZones(zones []openapi.SignageCustomLayoutZone) []signage.CustomZone {
	result := make([]signage.CustomZone, 0, len(zones))
	for _, zone := range zones {
		item := signage.CustomZone{ID: zone.Id, Label: zone.Label}
		if grid := nullableToPointer(zone.Grid); grid != nil {
			item.Grid = &signage.GridPlacement{Col: grid.Col, Row: grid.Row, ColSpan: grid.ColSpan, RowSpan: grid.RowSpan}
		}
		if rect := nullableToPointer(zone.Rect); rect != nil {
			item.Rect = &signage.FreeRect{X: rect.X, Y: rect.Y, Width: rect.Width, Height: rect.Height}
		}
		result = append(result, item)
	}
	return result
}

func (s *Server) ListSignageCustomLayouts(
	ctx context.Context,
	_ openapi.ListSignageCustomLayoutsRequestObject,
) (openapi.ListSignageCustomLayoutsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	layouts, err := s.signage.ListCustomLayouts(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignageCustomLayout, 0, len(layouts))
	for _, layout := range layouts {
		items = append(items, signageCustomLayoutDTO(layout))
	}
	return openapi.ListSignageCustomLayouts200JSONResponse{Items: items}, nil
}

func (s *Server) CreateSignageCustomLayout(
	ctx context.Context,
	r openapi.CreateSignageCustomLayoutRequestObject,
) (openapi.CreateSignageCustomLayoutResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	layout, err := s.signage.CreateCustomLayout(ctx, p, signage.CustomLayoutInput{
		Name:    r.Body.Name,
		Mode:    signage.CustomLayoutMode(r.Body.Mode),
		Columns: r.Body.Columns,
		Rows:    r.Body.Rows,
		Zones:   signageCustomZones(r.Body.Zones),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateSignageCustomLayout201JSONResponse(signageCustomLayoutDTO(layout)), nil
}

func (s *Server) GetSignageCustomLayout(
	ctx context.Context,
	r openapi.GetSignageCustomLayoutRequestObject,
) (openapi.GetSignageCustomLayoutResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	layout, err := s.signage.GetCustomLayout(ctx, p, r.CustomLayoutId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageCustomLayout200JSONResponse(signageCustomLayoutDTO(layout)), nil
}

func (s *Server) UpdateSignageCustomLayout(
	ctx context.Context,
	r openapi.UpdateSignageCustomLayoutRequestObject,
) (openapi.UpdateSignageCustomLayoutResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	layout, err := s.signage.UpdateCustomLayout(ctx, p, r.CustomLayoutId, r.Body.ExpectedVersion, signage.CustomLayoutInput{
		Name:    r.Body.Name,
		Mode:    signage.CustomLayoutMode(r.Body.Mode),
		Columns: r.Body.Columns,
		Rows:    r.Body.Rows,
		Zones:   signageCustomZones(r.Body.Zones),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSignageCustomLayout200JSONResponse(signageCustomLayoutDTO(layout)), nil
}

func (s *Server) DeleteSignageCustomLayout(
	ctx context.Context,
	r openapi.DeleteSignageCustomLayoutRequestObject,
) (openapi.DeleteSignageCustomLayoutResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.signage.DeleteCustomLayout(ctx, p, r.CustomLayoutId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteSignageCustomLayout204Response{}, nil
}
