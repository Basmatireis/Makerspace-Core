package httpapi

import (
	"context"
	"encoding/json"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/google/uuid"
)

// mapFinancialJSON translates separate transport/domain representations. Both sides
// have explicitly defined schemas; conversion errors are propagated, never ignored.
func mapFinancialJSON[To any](from any) (To, error) {
	var result To
	encoded, err := json.Marshal(from)
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(encoded, &result)
	return result, err
}
func (s *Server) ListOrders(ctx context.Context, r openapi.ListOrdersRequestObject) (openapi.ListOrdersResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.List(ctx, p, defaultString(r.Params.Search), defaultString(r.Params.Status), defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.OrderPage](result)
	if err != nil {
		return nil, err
	}
	return openapi.ListOrders200JSONResponse(dto), nil
}
func (s *Server) CreateOrder(ctx context.Context, r openapi.CreateOrderRequestObject) (openapi.CreateOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderDraftInput](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.Create(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.CreateOrder201JSONResponse(dto), nil
}
func (s *Server) GetOrder(ctx context.Context, r openapi.GetOrderRequestObject) (openapi.GetOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.Get(ctx, p, r.OrderId)
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.GetOrder200JSONResponse(dto), nil
}
func (s *Server) UpdateOrder(ctx context.Context, r openapi.UpdateOrderRequestObject) (openapi.UpdateOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.UpdateOrderDraftInput](r.Body)
	if err != nil {
		return nil, err
	}
	input.PreserveCustomer = !r.Body.Customer.IsSpecified()
	result, err := s.orders.Update(ctx, p, r.OrderId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOrder200JSONResponse(dto), nil
}
func (s *Server) AddOrderItem(ctx context.Context, r openapi.AddOrderItemRequestObject) (openapi.AddOrderItemResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderItemInput](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.ChangeItem(ctx, p, r.OrderId, uuid.Nil, input, "add", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.AddOrderItem201JSONResponse(dto), nil
}
func (s *Server) UpdateOrderItem(ctx context.Context, r openapi.UpdateOrderItemRequestObject) (openapi.UpdateOrderItemResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderItemInput](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.ChangeItem(ctx, p, r.OrderId, r.ItemId, input, "update", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOrderItem200JSONResponse(dto), nil
}
func (s *Server) RemoveOrderItem(ctx context.Context, r openapi.RemoveOrderItemRequestObject) (openapi.RemoveOrderItemResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderCommand](r.Body)
	if err != nil {
		return nil, err
	}
	itemInput := orders.OrderItemInput{ExpectedVersion: input.ExpectedVersion}
	result, err := s.orders.ChangeItem(ctx, p, r.OrderId, r.ItemId, itemInput, "remove", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.RemoveOrderItem200JSONResponse(dto), nil
}
func (s *Server) RefreshOrderItem(ctx context.Context, r openapi.RefreshOrderItemRequestObject) (openapi.RefreshOrderItemResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderCommand](r.Body)
	if err != nil {
		return nil, err
	}
	itemInput := orders.OrderItemInput{ExpectedVersion: input.ExpectedVersion}
	result, err := s.orders.ChangeItem(ctx, p, r.OrderId, r.ItemId, itemInput, "refresh", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.RefreshOrderItem201JSONResponse(dto), nil
}
func (s *Server) FinalizeOrder(ctx context.Context, r openapi.FinalizeOrderRequestObject) (openapi.FinalizeOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.Command(ctx, p, r.OrderId, input, "finalize", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.FinalizeOrder201JSONResponse(dto), nil
}
func (s *Server) CheckoutOrder(ctx context.Context, r openapi.CheckoutOrderRequestObject) (openapi.CheckoutOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.Command(ctx, p, r.OrderId, input, "checkout", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.CheckoutOrder201JSONResponse(dto), nil
}
func (s *Server) CancelOrder(ctx context.Context, r openapi.CancelOrderRequestObject) (openapi.CancelOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.Command(ctx, p, r.OrderId, input, "cancel", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.CancelOrder201JSONResponse(dto), nil
}
func (s *Server) ReverseOrder(ctx context.Context, r openapi.ReverseOrderRequestObject) (openapi.ReverseOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.Command(ctx, p, r.OrderId, input, "reverse", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.ReverseOrder201JSONResponse(dto), nil
}
func (s *Server) CreateReplacementOrder(ctx context.Context, r openapi.CreateReplacementOrderRequestObject) (openapi.CreateReplacementOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.Command(ctx, p, r.OrderId, input, "replacements", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.CreateReplacementOrder201JSONResponse(dto), nil
}
func (s *Server) ReplaceOrder(ctx context.Context, r openapi.ReplaceOrderRequestObject) (openapi.ReplaceOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.OrderCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.Command(ctx, p, r.OrderId, input, "replace", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.ReplaceOrder201JSONResponse(dto), nil
}
func (s *Server) CompleteCounterSale(ctx context.Context, r openapi.CompleteCounterSaleRequestObject) (openapi.CompleteCounterSaleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.CounterSaleCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.CounterSale(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.CompleteCounterSale201JSONResponse(dto), nil
}
func (s *Server) ListOrderPayments(ctx context.Context, r openapi.ListOrderPaymentsRequestObject) (openapi.ListOrderPaymentsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.ListPayments(ctx, p, defaultString(stringEnum(r.Params.Method)), r.Params.From, r.Params.To, defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.OrderPaymentPage](result)
	if err != nil {
		return nil, err
	}
	return openapi.ListOrderPayments200JSONResponse(dto), nil
}
func (s *Server) GetOrderPayment(ctx context.Context, r openapi.GetOrderPaymentRequestObject) (openapi.GetOrderPaymentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.GetPayment(ctx, p, r.PaymentId)
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.OrderPayment](result)
	if err != nil {
		return nil, err
	}
	return openapi.GetOrderPayment200JSONResponse(dto), nil
}
func (s *Server) RecordOrderPayment(ctx context.Context, r openapi.RecordOrderPaymentRequestObject) (openapi.RecordOrderPaymentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.RecordOrderPayment](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.RecordPayment(ctx, p, r.OrderId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.RecordOrderPayment201JSONResponse(dto), nil
}
func (s *Server) ReverseOrderPayment(ctx context.Context, r openapi.ReverseOrderPaymentRequestObject) (openapi.ReverseOrderPaymentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.ReversePaymentCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.ReversePayment(ctx, p, r.PaymentId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.Order](result)
	if err != nil {
		return nil, err
	}
	return openapi.ReverseOrderPayment201JSONResponse(dto), nil
}
func (s *Server) GetPaymentReconciliation(ctx context.Context, r openapi.GetPaymentReconciliationRequestObject) (openapi.GetPaymentReconciliationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.Reconciliation(ctx, p, defaultString(stringEnum(r.Params.Method)), r.Params.From, r.Params.To, defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.PaymentReconciliation](result)
	if err != nil {
		return nil, err
	}
	return openapi.GetPaymentReconciliation200JSONResponse(dto), nil
}
func (s *Server) CreateExternalInvoiceRequest(ctx context.Context, r openapi.CreateExternalInvoiceRequestRequestObject) (openapi.CreateExternalInvoiceRequestResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.CreateInvoiceRequest](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.CreateRequest(ctx, p, r.OrderId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.CreateExternalInvoiceRequest201JSONResponse(dto), nil
}
func (s *Server) ListExternalInvoiceRequests(ctx context.Context, r openapi.ListExternalInvoiceRequestsRequestObject) (openapi.ListExternalInvoiceRequestsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.ListRequests(ctx, p, defaultString(r.Params.Search), defaultString(r.Params.Status), defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequestPage](result)
	if err != nil {
		return nil, err
	}
	return openapi.ListExternalInvoiceRequests200JSONResponse(dto), nil
}
func (s *Server) GetExternalInvoiceRequest(ctx context.Context, r openapi.GetExternalInvoiceRequestRequestObject) (openapi.GetExternalInvoiceRequestResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.GetRequest(ctx, p, r.RequestId)
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.GetExternalInvoiceRequest200JSONResponse(dto), nil
}
func (s *Server) UpdateExternalInvoiceRequest(ctx context.Context, r openapi.UpdateExternalInvoiceRequestRequestObject) (openapi.UpdateExternalInvoiceRequestResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.UpdateInvoiceRequest](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.UpdateRequest(ctx, p, r.RequestId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateExternalInvoiceRequest200JSONResponse(dto), nil
}
func (s *Server) MarkExternalInvoiceRequestReady(ctx context.Context, r openapi.MarkExternalInvoiceRequestReadyRequestObject) (openapi.MarkExternalInvoiceRequestReadyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.InvoiceRequestCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.RequestCommand(ctx, p, r.RequestId, input, "ready", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.MarkExternalInvoiceRequestReady201JSONResponse(dto), nil
}
func (s *Server) SubmitExternalInvoiceRequest(ctx context.Context, r openapi.SubmitExternalInvoiceRequestRequestObject) (openapi.SubmitExternalInvoiceRequestResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.InvoiceRequestCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.RequestCommand(ctx, p, r.RequestId, input, "submit", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.SubmitExternalInvoiceRequest201JSONResponse(dto), nil
}
func (s *Server) RecordExternalInvoiceIssued(ctx context.Context, r openapi.RecordExternalInvoiceIssuedRequestObject) (openapi.RecordExternalInvoiceIssuedResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.InvoiceRequestCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.RequestCommand(ctx, p, r.RequestId, input, "record-issued", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.RecordExternalInvoiceIssued201JSONResponse(dto), nil
}
func (s *Server) RequestExternalInvoiceCancellation(ctx context.Context, r openapi.RequestExternalInvoiceCancellationRequestObject) (openapi.RequestExternalInvoiceCancellationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.InvoiceRequestCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.RequestCommand(ctx, p, r.RequestId, input, "request-cancellation", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.RequestExternalInvoiceCancellation201JSONResponse(dto), nil
}
func (s *Server) ConfirmExternalInvoiceCancellation(ctx context.Context, r openapi.ConfirmExternalInvoiceCancellationRequestObject) (openapi.ConfirmExternalInvoiceCancellationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.InvoiceRequestCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.RequestCommand(ctx, p, r.RequestId, input, "confirm-cancellation", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.ConfirmExternalInvoiceCancellation201JSONResponse(dto), nil
}
func (s *Server) CancelExternalInvoiceRequest(ctx context.Context, r openapi.CancelExternalInvoiceRequestRequestObject) (openapi.CancelExternalInvoiceRequestResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.InvoiceRequestCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.RequestCommand(ctx, p, r.RequestId, input, "cancel", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.CancelExternalInvoiceRequest201JSONResponse(dto), nil
}
func (s *Server) CorrectExternalInvoiceReference(ctx context.Context, r openapi.CorrectExternalInvoiceReferenceRequestObject) (openapi.CorrectExternalInvoiceReferenceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.InvoiceRequestCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.RequestCommand(ctx, p, r.RequestId, input, "reference-corrections", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.CorrectExternalInvoiceReference201JSONResponse(dto), nil
}
func (s *Server) GetOrganizationInvoicingRequirements(ctx context.Context, r openapi.GetOrganizationInvoicingRequirementsRequestObject) (openapi.GetOrganizationInvoicingRequirementsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.GetRequirements(ctx, p, r.OrganizationId)
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.InvoicingRequirements](result)
	if err != nil {
		return nil, err
	}
	return openapi.GetOrganizationInvoicingRequirements200JSONResponse(dto), nil
}
func (s *Server) UpdateOrganizationInvoicingRequirements(ctx context.Context, r openapi.UpdateOrganizationInvoicingRequirementsRequestObject) (openapi.UpdateOrganizationInvoicingRequirementsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.UpdateInvoicingRequirements](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.UpdateRequirements(ctx, p, r.OrganizationId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.InvoicingRequirements](result)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOrganizationInvoicingRequirements200JSONResponse(dto), nil
}
func (s *Server) GetJobOrderAssociation(ctx context.Context, r openapi.GetJobOrderAssociationRequestObject) (openapi.GetJobOrderAssociationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.JobAssociation(ctx, p, r.MachineJobId)
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.JobOrderAssociation](result)
	if err != nil {
		return nil, err
	}
	return openapi.GetJobOrderAssociation200JSONResponse(dto), nil
}

func (s *Server) PreviewCounterSale(ctx context.Context, r openapi.PreviewCounterSaleRequestObject) (openapi.PreviewCounterSaleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input, err := mapFinancialJSON[orders.CounterSaleCommand](r.Body)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.PreviewCounterSale(ctx, p, input)
	if err != nil {
		return nil, err
	}
	return openapi.PreviewCounterSale200JSONResponse{TotalAmount: result.TotalAmount, Currency: openapi.CounterSaleQuoteCurrency(result.Currency)}, nil
}
