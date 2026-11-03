package httpapi

import (
	"bytes"
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) ExportCashbook(
	ctx context.Context,
	r openapi.ExportCashbookRequestObject,
) (openapi.ExportCashbookResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	query := orders.CashbookExportQuery{
		From:     r.Params.From.Time,
		To:       r.Params.To.Time,
		Contents: orders.CashbookCashRegister,
		Format:   orders.CashbookPDF,
	}
	if r.Params.Contents != nil {
		query.Contents = orders.CashbookContents(*r.Params.Contents)
	}
	if r.Params.Format != nil {
		query.Format = orders.CashbookFormat(*r.Params.Format)
	}
	file, err := s.orders.ExportCashbook(ctx, p, query)
	if err != nil {
		return nil, err
	}
	headers := openapi.ExportCashbook200ResponseHeaders{ContentDisposition: attachmentDisposition(file.Filename)}
	if query.Format == orders.CashbookCSV {
		return openapi.ExportCashbook200TextcsvResponse{
			Body:          bytes.NewReader(file.Data),
			ContentLength: int64(len(file.Data)),
			Headers:       headers,
		}, nil
	}
	return openapi.ExportCashbook200ApplicationpdfResponse{
		Body:          bytes.NewReader(file.Data),
		ContentLength: int64(len(file.Data)),
		Headers:       headers,
	}, nil
}

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

func (s *Server) UpdateCashCount(
	ctx context.Context,
	r openapi.UpdateCashCountRequestObject,
) (openapi.UpdateCashCountResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	change, err := mapFinancialJSON[orders.CashCountChange](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.UpdateCashCount(ctx, p, r.CountId, change, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.CashCount](result)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateCashCount200JSONResponse(dto), nil
}

func (s *Server) DeleteCashCount(
	ctx context.Context,
	r openapi.DeleteCashCountRequestObject,
) (openapi.DeleteCashCountResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	deletion := orders.CashEntryDeletion{ExpectedVersion: r.Body.ExpectedVersion}
	if err = s.orders.DeleteCashCount(ctx, p, r.CountId, deletion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteCashCount204Response{}, nil
}

func (s *Server) UpdateCashMovement(
	ctx context.Context,
	r openapi.UpdateCashMovementRequestObject,
) (openapi.UpdateCashMovementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	change, err := mapFinancialJSON[orders.CashMovementChange](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.UpdateCashMovement(ctx, p, r.MovementId, change, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.CashMovement](result)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateCashMovement200JSONResponse(dto), nil
}

func (s *Server) DeleteCashMovement(
	ctx context.Context,
	r openapi.DeleteCashMovementRequestObject,
) (openapi.DeleteCashMovementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	deletion := orders.CashEntryDeletion{ExpectedVersion: r.Body.ExpectedVersion}
	if err = s.orders.DeleteCashMovement(ctx, p, r.MovementId, deletion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteCashMovement204Response{}, nil
}
