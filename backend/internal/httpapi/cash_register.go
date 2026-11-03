package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func datePointer(v *openapi_types.Date) *time.Time {
	if v == nil {
		return nil
	}
	day := v.Time
	return &day
}

func (s *Server) GetCashJournal(
	ctx context.Context,
	r openapi.GetCashJournalRequestObject,
) (openapi.GetCashJournalResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	query := orders.CashJournalQuery{
		From:        datePointer(r.Params.From),
		To:          datePointer(r.Params.To),
		Search:      defaultString(r.Params.Search),
		NewestFirst: r.Params.Direction != nil && *r.Params.Direction == openapi.GetCashJournalParamsDirectionDesc,
		Page:        defaultInt(r.Params.Page, 1),
		Size:        defaultInt(r.Params.PageSize, 25),
	}
	if r.Params.Kind != nil {
		for _, kind := range *r.Params.Kind {
			query.Kinds = append(query.Kinds, orders.CashJournalKind(kind))
		}
	}
	result, err := s.orders.CashJournal(ctx, p, query)
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.CashJournal](result)
	if err != nil {
		return nil, err
	}
	return openapi.GetCashJournal200JSONResponse(dto), nil
}

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
