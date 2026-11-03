package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
)

func (s *Server) ListCashCounts(
	ctx context.Context,
	r openapi.ListCashCountsRequestObject,
) (openapi.ListCashCountsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.ListCashCounts(
		ctx,
		p,
		r.Params.From,
		r.Params.To,
		defaultInt(r.Params.Page, 1),
		defaultInt(r.Params.PageSize, 25),
	)
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.CashCountPage](result)
	if err != nil {
		return nil, err
	}
	return openapi.ListCashCounts200JSONResponse(dto), nil
}

func (s *Server) RecordCashCount(
	ctx context.Context,
	r openapi.RecordCashCountRequestObject,
) (openapi.RecordCashCountResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.CashCountInput](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.RecordCashCount(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.CashCount](result)
	if err != nil {
		return nil, err
	}
	return openapi.RecordCashCount201JSONResponse(dto), nil
}
