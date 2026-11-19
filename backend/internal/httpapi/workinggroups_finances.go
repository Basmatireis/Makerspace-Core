package httpapi

import (
	"context"
	"io"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func periodDTO(v workinggroups.Period) openapi.WorkingGroupBudgetPeriod {
	out := openapi.WorkingGroupBudgetPeriod{
		Id: v.ID, Name: v.Name, StartsOn: openapi_types.Date{Time: v.StartsOn}, EndsOn: openapi_types.Date{Time: v.EndsOn},
		Closed: v.Closed, ClosedAt: v.ClosedAt, Current: v.Current, Version: v.Version, CreatedAt: v.CreatedAt,
	}
	if v.TotalAmount != "" {
		out.TotalAmount = &v.TotalAmount
	}
	return out
}

func groupBudgetDTO(v workinggroups.GroupBudget) openapi.WorkingGroupGroupBudget {
	return openapi.WorkingGroupGroupBudget{
		GroupId: v.GroupID, GroupName: v.GroupName, Given: v.Given, Spent: v.Spent, Reserved: v.Reserved, Free: v.Free,
	}
}

func purchaseDTO(v workinggroups.Purchase) openapi.WorkingGroupPurchase {
	out := openapi.WorkingGroupPurchase{
		Id: v.ID, GroupId: v.GroupID, GroupName: v.GroupName, PeriodId: v.PeriodID, PeriodName: v.PeriodName,
		PeriodClosed: v.PeriodClosed, Item: v.Item, Link: v.Link, Quantity: int(v.Quantity), UnitPrice: v.UnitPrice,
		EstimatedTotal: v.EstimatedTotal, How: openapi.WorkingGroupPurchaseHow(v.How), Status: openapi.WorkingGroupPurchaseStatus(v.Status),
		DeclineReason: v.DeclineReason, NeedsProject: v.NeedsProject, HasAttachment: v.HasAttachment, HasReceipt: v.HasReceipt,
		OrderId: v.OrderID, CreatedAt: v.CreatedAt, ApprovedAt: v.ApprovedAt, DeclinedAt: v.DeclinedAt, OrderedAt: v.OrderedAt,
		ReceivedAt: v.ReceivedAt, BoughtAt: v.BoughtAt, RefundedAt: v.RefundedAt,
		CanApprove: v.CanApprove, CanDecline: v.CanDecline, CanHandInReceipt: v.CanHandInReceipt,
		CanMarkArrived: v.CanMarkArrived, CanMarkRefunded: v.CanMarkRefunded, CanDelete: v.CanDelete, Version: v.Version,
	}
	if v.ActualTotal != nil {
		out.ActualTotal = v.ActualTotal
	}
	if v.ProjectID != nil {
		out.ProjectId = nullable.NewNullableWithValue(*v.ProjectID)
	}
	if v.ProjectItemID != nil {
		out.ProjectItemId = nullable.NewNullableWithValue(*v.ProjectItemID)
	}
	if v.Requester != nil {
		out.Requester = &openapi.WorkingGroupPerson{PersonId: v.Requester.ID, DisplayName: v.Requester.DisplayName}
	}
	return out
}

func purchaseListDTO(items []workinggroups.Purchase, truncated bool) openapi.WorkingGroupPurchaseList {
	out := make([]openapi.WorkingGroupPurchase, 0, len(items))
	for _, item := range items {
		out = append(out, purchaseDTO(item))
	}
	return openapi.WorkingGroupPurchaseList{Items: out, Truncated: &truncated}
}

func orderDTO(v workinggroups.PurchaseOrder) openapi.WorkingGroupPurchaseOrder {
	return openapi.WorkingGroupPurchaseOrder{
		Id: v.ID, PeriodId: v.PeriodID, Shop: v.Shop, TotalAmount: v.TotalAmount,
		Status: openapi.WorkingGroupPurchaseOrderStatus(v.Status), ProjectRequestId: v.ProjectRequestID,
		ProjectNumber: v.ProjectNumber, PurchaseIds: v.PurchaseIDs, HasInvoice: v.HasInvoice, CreatedAt: v.CreatedAt,
		ArrivedAt: v.ArrivedAt, Version: v.Version,
	}
}

func bookingDTO(v workinggroups.Booking) openapi.WorkingGroupBooking {
	return openapi.WorkingGroupBooking{
		Id: v.ID, GroupId: v.GroupID, GroupName: v.GroupName, PeriodId: v.PeriodID, Text: v.Text, Amount: v.Amount,
		BookedOn: openapi_types.Date{Time: v.BookedOn}, CreatedAt: v.CreatedAt,
	}
}

func rulesDTO(v workinggroups.FinanceRules) openapi.WorkingGroupFinanceRules {
	requests := make([]openapi.WorkingGroupProjectRequest, 0, len(v.ProjectRequests))
	for _, r := range v.ProjectRequests {
		requests = append(requests, openapi.WorkingGroupProjectRequest{Id: r.ID, Number: r.Number, Label: r.Label})
	}
	defaults := openapi.WorkingGroupRequestDefaults{
		UnitKind: openapi.WorkingGroupProjectUnitKind(v.Request.UnitKind), UnitName: v.Request.UnitName,
		AddGroupName: v.Request.AddGroupName, Place: v.Request.Place,
	}
	if v.Request.ResponsiblePerson != nil {
		defaults.ResponsiblePerson = nullable.NewNullableWithValue(*workingGroupPersonDTO(v.Request.ResponsiblePerson))
	}
	return openapi.WorkingGroupFinanceRules{
		ProjectThreshold: v.ProjectThreshold, OffersThreshold: v.OffersThreshold, Request: &defaults,
		ProjectRequests: requests, Version: v.Version,
	}
}

func readFinanceFile(body io.Reader, name, contentType string) (workinggroups.FileUpload, error) {
	data, err := io.ReadAll(io.LimitReader(body, workinggroups.MaxFinanceFileBytes+1))
	if err != nil {
		return workinggroups.FileUpload{}, invalidRequest("could not read file")
	}
	return workinggroups.FileUpload{Filename: name, ContentType: contentType, Data: data}, nil
}

func (s *Server) ListWorkingGroupBudgetPeriods(
	ctx context.Context,
	_ openapi.ListWorkingGroupBudgetPeriodsRequestObject,
) (openapi.ListWorkingGroupBudgetPeriodsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.workingGroups.ListPeriods(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupBudgetPeriod, 0, len(items))
	for _, item := range items {
		out = append(out, periodDTO(item))
	}
	return openapi.ListWorkingGroupBudgetPeriods200JSONResponse{Items: out}, nil
}

func (s *Server) CreateWorkingGroupBudgetPeriod(
	ctx context.Context,
	r openapi.CreateWorkingGroupBudgetPeriodRequestObject,
) (openapi.CreateWorkingGroupBudgetPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	period, err := s.workingGroups.CreatePeriod(ctx, p, workinggroups.PeriodInput{
		Name: r.Body.Name, StartsOn: r.Body.StartsOn.Time, EndsOn: r.Body.EndsOn.Time, TotalAmount: r.Body.TotalAmount,
		CopySharesFromPeriodID: r.Body.CopySharesFromPeriodId,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupBudgetPeriod201JSONResponse(periodDTO(period)), nil
}

func (s *Server) UpdateWorkingGroupBudgetPeriod(
	ctx context.Context,
	r openapi.UpdateWorkingGroupBudgetPeriodRequestObject,
) (openapi.UpdateWorkingGroupBudgetPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	update := workinggroups.PeriodUpdate{ExpectedVersion: r.Body.ExpectedVersion, Name: r.Body.Name, TotalAmount: r.Body.TotalAmount}
	if r.Body.StartsOn != nil {
		update.StartsOn = &r.Body.StartsOn.Time
	}
	if r.Body.EndsOn != nil {
		update.EndsOn = &r.Body.EndsOn.Time
	}
	period, err := s.workingGroups.UpdatePeriod(ctx, p, r.PeriodId, update, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateWorkingGroupBudgetPeriod200JSONResponse(periodDTO(period)), nil
}

func (s *Server) CloseWorkingGroupBudgetPeriod(
	ctx context.Context,
	r openapi.CloseWorkingGroupBudgetPeriodRequestObject,
) (openapi.CloseWorkingGroupBudgetPeriodResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	period, err := s.workingGroups.ClosePeriod(ctx, p, r.PeriodId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CloseWorkingGroupBudgetPeriod200JSONResponse(periodDTO(period)), nil
}

func (s *Server) SetWorkingGroupBudgetShare(
	ctx context.Context,
	r openapi.SetWorkingGroupBudgetShareRequestObject,
) (openapi.SetWorkingGroupBudgetShareResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	group, err := s.workingGroups.SetShare(ctx, p, r.PeriodId, r.GroupId, r.Body.Amount, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetWorkingGroupBudgetShare200JSONResponse(groupBudgetDTO(group)), nil
}

func (s *Server) GetWorkingGroupBudget(ctx context.Context, r openapi.GetWorkingGroupBudgetRequestObject) (openapi.GetWorkingGroupBudgetResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	budget, err := s.workingGroups.GetBudget(ctx, p, r.Params.PeriodId)
	if err != nil {
		return nil, err
	}
	out := openapi.WorkingGroupBudget{Period: periodDTO(budget.Period), Groups: make([]openapi.WorkingGroupGroupBudget, 0, len(budget.Groups))}
	for _, g := range budget.Groups {
		out.Groups = append(out.Groups, groupBudgetDTO(g))
	}
	if t := budget.Totals; t != nil {
		out.Totals = &openapi.WorkingGroupBudgetTotals{
			TotalAmount: t.TotalAmount, GivenSum: t.GivenSum, KeptBack: t.KeptBack, SpentSum: t.SpentSum,
			ReservedSum: t.ReservedSum, FreeSum: t.FreeSum,
		}
	}
	return openapi.GetWorkingGroupBudget200JSONResponse(out), nil
}

func (s *Server) ListWorkingGroupPurchases(
	ctx context.Context,
	r openapi.ListWorkingGroupPurchasesRequestObject,
) (openapi.ListWorkingGroupPurchasesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	filter := workinggroups.PurchaseFilter{GroupID: r.Params.GroupId, PeriodID: r.Params.PeriodId}
	if r.Params.Status != nil {
		status := string(*r.Params.Status)
		filter.Status = &status
	}
	items, truncated, err := s.workingGroups.ListPurchases(ctx, p, filter)
	if err != nil {
		return nil, err
	}
	return openapi.ListWorkingGroupPurchases200JSONResponse(purchaseListDTO(items, truncated)), nil
}

func (s *Server) CreateWorkingGroupPurchases(
	ctx context.Context,
	r openapi.CreateWorkingGroupPurchasesRequestObject,
) (openapi.CreateWorkingGroupPurchasesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := workinggroups.CreatePurchasesInput{
		GroupID: r.Body.GroupId, How: string(r.Body.How), ProjectID: r.Body.ProjectId, ProjectItemID: r.Body.ProjectItemId,
	}
	for _, item := range r.Body.Items {
		input.Items = append(input.Items, workinggroups.PurchaseItemInput{
			Item: item.Item, Link: item.Link, Quantity: item.Quantity, UnitPrice: item.UnitPrice,
		})
	}
	items, err := s.workingGroups.CreatePurchases(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupPurchases201JSONResponse(purchaseListDTO(items, false)), nil
}

func (s *Server) GetWorkingGroupPurchase(
	ctx context.Context,
	r openapi.GetWorkingGroupPurchaseRequestObject,
) (openapi.GetWorkingGroupPurchaseResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.workingGroups.GetPurchase(ctx, p, r.PurchaseId)
	if err != nil {
		return nil, err
	}
	return openapi.GetWorkingGroupPurchase200JSONResponse(purchaseDTO(item)), nil
}

func (s *Server) DeleteWorkingGroupPurchase(
	ctx context.Context,
	r openapi.DeleteWorkingGroupPurchaseRequestObject,
) (openapi.DeleteWorkingGroupPurchaseResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.DeletePurchase(ctx, p, r.PurchaseId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupPurchase204Response{}, nil
}

func (s *Server) ApproveWorkingGroupPurchase(
	ctx context.Context,
	r openapi.ApproveWorkingGroupPurchaseRequestObject,
) (openapi.ApproveWorkingGroupPurchaseResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.ApprovePurchase(ctx, p, r.PurchaseId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ApproveWorkingGroupPurchase200JSONResponse(purchaseDTO(item)), nil
}

func (s *Server) DeclineWorkingGroupPurchase(
	ctx context.Context,
	r openapi.DeclineWorkingGroupPurchaseRequestObject,
) (openapi.DeclineWorkingGroupPurchaseResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.DeclinePurchase(ctx, p, r.PurchaseId, r.Body.ExpectedVersion, r.Body.Reason, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DeclineWorkingGroupPurchase200JSONResponse(purchaseDTO(item)), nil
}

func (s *Server) ArrivedWorkingGroupPurchase(
	ctx context.Context,
	r openapi.ArrivedWorkingGroupPurchaseRequestObject,
) (openapi.ArrivedWorkingGroupPurchaseResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.MarkPurchaseArrived(ctx, p, r.PurchaseId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ArrivedWorkingGroupPurchase200JSONResponse(purchaseDTO(item)), nil
}

func (s *Server) RefundedWorkingGroupPurchase(
	ctx context.Context,
	r openapi.RefundedWorkingGroupPurchaseRequestObject,
) (openapi.RefundedWorkingGroupPurchaseResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.MarkPurchaseRefunded(ctx, p, r.PurchaseId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RefundedWorkingGroupPurchase200JSONResponse(purchaseDTO(item)), nil
}

func (s *Server) HandInWorkingGroupPurchaseReceipt(
	ctx context.Context,
	r openapi.HandInWorkingGroupPurchaseReceiptRequestObject,
) (openapi.HandInWorkingGroupPurchaseReceiptResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.CheckPurchaseUpload(ctx, p, r.PurchaseId); err != nil {
		return nil, err
	}
	upload, err := readFinanceFile(r.Body, r.Params.XFileName, r.Params.XFileContentType)
	if err != nil {
		return nil, err
	}
	item, err := s.workingGroups.HandInReceipt(ctx, p, r.PurchaseId, workinggroups.ReceiptInput{
		ExpectedVersion: r.Params.XExpectedVersion, Amount: r.Params.XReceiptAmount, File: upload,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.HandInWorkingGroupPurchaseReceipt200JSONResponse(purchaseDTO(item)), nil
}

func (s *Server) DownloadWorkingGroupPurchaseReceipt(
	ctx context.Context,
	r openapi.DownloadWorkingGroupPurchaseReceiptRequestObject,
) (openapi.DownloadWorkingGroupPurchaseReceiptResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.workingGroups.OpenPurchaseFile(ctx, p, r.PurchaseId, true)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadWorkingGroupPurchaseReceipt200ApplicationoctetStreamResponse{
		Body: reader, ContentLength: file.Size,
		Headers: openapi.DownloadWorkingGroupPurchaseReceipt200ResponseHeaders{
			CacheControl: "no-store", ContentDisposition: attachmentDisposition(file.OriginalFilename),
			XContentTypeOptions: "nosniff", ContentSecurityPolicy: "default-src 'none'; sandbox",
		},
	}, nil
}

func (s *Server) UploadWorkingGroupPurchaseAttachment(
	ctx context.Context,
	r openapi.UploadWorkingGroupPurchaseAttachmentRequestObject,
) (openapi.UploadWorkingGroupPurchaseAttachmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.CheckPurchaseUpload(ctx, p, r.PurchaseId); err != nil {
		return nil, err
	}
	upload, err := readFinanceFile(r.Body, r.Params.XFileName, r.Params.XFileContentType)
	if err != nil {
		return nil, err
	}
	item, err := s.workingGroups.SetAttachment(ctx, p, r.PurchaseId, upload, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UploadWorkingGroupPurchaseAttachment200JSONResponse(purchaseDTO(item)), nil
}

func (s *Server) DownloadWorkingGroupPurchaseAttachment(
	ctx context.Context,
	r openapi.DownloadWorkingGroupPurchaseAttachmentRequestObject,
) (openapi.DownloadWorkingGroupPurchaseAttachmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.workingGroups.OpenPurchaseFile(ctx, p, r.PurchaseId, false)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadWorkingGroupPurchaseAttachment200ApplicationoctetStreamResponse{
		Body: reader, ContentLength: file.Size,
		Headers: openapi.DownloadWorkingGroupPurchaseAttachment200ResponseHeaders{
			CacheControl: "no-store", ContentDisposition: attachmentDisposition(file.OriginalFilename),
			XContentTypeOptions: "nosniff", ContentSecurityPolicy: "default-src 'none'; sandbox",
		},
	}, nil
}

func (s *Server) ListWorkingGroupPurchaseOrders(
	ctx context.Context,
	_ openapi.ListWorkingGroupPurchaseOrdersRequestObject,
) (openapi.ListWorkingGroupPurchaseOrdersResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, truncated, err := s.workingGroups.ListOrders(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupPurchaseOrder, 0, len(items))
	for _, item := range items {
		out = append(out, orderDTO(item))
	}
	return openapi.ListWorkingGroupPurchaseOrders200JSONResponse{Items: out, Truncated: &truncated}, nil
}

func (s *Server) CreateWorkingGroupPurchaseOrder(
	ctx context.Context,
	r openapi.CreateWorkingGroupPurchaseOrderRequestObject,
) (openapi.CreateWorkingGroupPurchaseOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	order, err := s.workingGroups.CreateOrder(ctx, p, workinggroups.CreateOrderInput{
		Shop: r.Body.Shop, PurchaseIDs: r.Body.PurchaseIds, ProjectRequestID: r.Body.ProjectRequestId,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupPurchaseOrder201JSONResponse(orderDTO(order)), nil
}

func (s *Server) GetWorkingGroupPurchaseOrder(
	ctx context.Context,
	r openapi.GetWorkingGroupPurchaseOrderRequestObject,
) (openapi.GetWorkingGroupPurchaseOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	order, err := s.workingGroups.GetOrder(ctx, p, r.OrderId)
	if err != nil {
		return nil, err
	}
	return openapi.GetWorkingGroupPurchaseOrder200JSONResponse(orderDTO(order)), nil
}

func (s *Server) ArrivedWorkingGroupPurchaseOrder(
	ctx context.Context,
	r openapi.ArrivedWorkingGroupPurchaseOrderRequestObject,
) (openapi.ArrivedWorkingGroupPurchaseOrderResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	order, err := s.workingGroups.MarkOrderArrived(ctx, p, r.OrderId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ArrivedWorkingGroupPurchaseOrder200JSONResponse(orderDTO(order)), nil
}

func (s *Server) UploadWorkingGroupPurchaseOrderInvoice(
	ctx context.Context,
	r openapi.UploadWorkingGroupPurchaseOrderInvoiceRequestObject,
) (openapi.UploadWorkingGroupPurchaseOrderInvoiceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.CheckOrderUpload(ctx, p, r.OrderId); err != nil {
		return nil, err
	}
	upload, err := readFinanceFile(r.Body, r.Params.XFileName, r.Params.XFileContentType)
	if err != nil {
		return nil, err
	}
	order, err := s.workingGroups.SetOrderInvoice(ctx, p, r.OrderId, upload, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UploadWorkingGroupPurchaseOrderInvoice200JSONResponse(orderDTO(order)), nil
}

func (s *Server) DownloadWorkingGroupPurchaseOrderInvoice(
	ctx context.Context,
	r openapi.DownloadWorkingGroupPurchaseOrderInvoiceRequestObject,
) (openapi.DownloadWorkingGroupPurchaseOrderInvoiceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.workingGroups.OpenOrderInvoice(ctx, p, r.OrderId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadWorkingGroupPurchaseOrderInvoice200ApplicationoctetStreamResponse{
		Body: reader, ContentLength: file.Size,
		Headers: openapi.DownloadWorkingGroupPurchaseOrderInvoice200ResponseHeaders{
			CacheControl: "no-store", ContentDisposition: attachmentDisposition(file.OriginalFilename),
			XContentTypeOptions: "nosniff", ContentSecurityPolicy: "default-src 'none'; sandbox",
		},
	}, nil
}

func (s *Server) ListWorkingGroupBookings(
	ctx context.Context,
	r openapi.ListWorkingGroupBookingsRequestObject,
) (openapi.ListWorkingGroupBookingsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, truncated, err := s.workingGroups.ListBookings(ctx, p, r.Params.GroupId, r.Params.PeriodId)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupBooking, 0, len(items))
	for _, item := range items {
		out = append(out, bookingDTO(item))
	}
	return openapi.ListWorkingGroupBookings200JSONResponse{Items: out, Truncated: &truncated}, nil
}

func (s *Server) CreateWorkingGroupBooking(
	ctx context.Context,
	r openapi.CreateWorkingGroupBookingRequestObject,
) (openapi.CreateWorkingGroupBookingResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	booking, err := s.workingGroups.CreateBooking(ctx, p, workinggroups.CreateBookingInput{
		GroupID: r.Body.GroupId, PeriodID: r.Body.PeriodId, Text: r.Body.Text, Amount: r.Body.Amount, BookedOn: r.Body.BookedOn.Time,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupBooking201JSONResponse(bookingDTO(booking)), nil
}

func (s *Server) DeleteWorkingGroupBooking(
	ctx context.Context,
	r openapi.DeleteWorkingGroupBookingRequestObject,
) (openapi.DeleteWorkingGroupBookingResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.DeleteBooking(ctx, p, r.BookingId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupBooking204Response{}, nil
}

func (s *Server) GetWorkingGroupFinanceRules(
	ctx context.Context,
	_ openapi.GetWorkingGroupFinanceRulesRequestObject,
) (openapi.GetWorkingGroupFinanceRulesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	rules, err := s.workingGroups.GetRules(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.GetWorkingGroupFinanceRules200JSONResponse(rulesDTO(rules)), nil
}

func (s *Server) SetWorkingGroupFinanceRules(
	ctx context.Context,
	r openapi.SetWorkingGroupFinanceRulesRequestObject,
) (openapi.SetWorkingGroupFinanceRulesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := workinggroups.FinanceRulesInput{
		ExpectedVersion: r.Body.ExpectedVersion, ProjectThreshold: r.Body.ProjectThreshold, OffersThreshold: r.Body.OffersThreshold,
	}
	if in := r.Body.Request; in != nil {
		input.Request = &workinggroups.RequestDefaultsInput{
			UnitKind: string(in.UnitKind), UnitName: in.UnitName, AddGroupName: in.AddGroupName, Place: in.Place,
		}
		if in.ResponsiblePersonId.IsSpecified() && !in.ResponsiblePersonId.IsNull() {
			id := in.ResponsiblePersonId.MustGet()
			input.Request.ResponsiblePersonID = &id
		}
	}
	rules, err := s.workingGroups.SetRules(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetWorkingGroupFinanceRules200JSONResponse(rulesDTO(rules)), nil
}

func (s *Server) CreateWorkingGroupProjectRequest(
	ctx context.Context,
	r openapi.CreateWorkingGroupProjectRequestRequestObject,
) (openapi.CreateWorkingGroupProjectRequestResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	request, err := s.workingGroups.CreateProjectRequest(ctx, p, r.Body.Number, r.Body.Label, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupProjectRequest201JSONResponse{Id: request.ID, Number: request.Number, Label: request.Label}, nil
}

func (s *Server) UpdateWorkingGroupProjectRequest(
	ctx context.Context,
	r openapi.UpdateWorkingGroupProjectRequestRequestObject,
) (openapi.UpdateWorkingGroupProjectRequestResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	request, err := s.workingGroups.UpdateProjectRequest(ctx, p, r.RequestId, r.Body.Number, r.Body.Label, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateWorkingGroupProjectRequest200JSONResponse{Id: request.ID, Number: request.Number, Label: request.Label}, nil
}

func (s *Server) DeleteWorkingGroupProjectRequest(
	ctx context.Context,
	r openapi.DeleteWorkingGroupProjectRequestRequestObject,
) (openapi.DeleteWorkingGroupProjectRequestResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.DeleteProjectRequest(ctx, p, r.RequestId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupProjectRequest204Response{}, nil
}

func (s *Server) RedactWorkingGroupPurchase(
	ctx context.Context,
	r openapi.RedactWorkingGroupPurchaseRequestObject,
) (openapi.RedactWorkingGroupPurchaseResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.RedactPurchase(ctx, p, r.PurchaseId, r.Body.ExpectedVersion, r.Body.Text, r.Body.Files, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RedactWorkingGroupPurchase200JSONResponse(purchaseDTO(item)), nil
}

func (s *Server) DeleteWorkingGroupPurchaseOrderInvoice(
	ctx context.Context,
	r openapi.DeleteWorkingGroupPurchaseOrderInvoiceRequestObject,
) (openapi.DeleteWorkingGroupPurchaseOrderInvoiceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.RemoveOrderInvoice(ctx, p, r.OrderId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupPurchaseOrderInvoice204Response{}, nil
}

func (s *Server) RedactWorkingGroupBooking(
	ctx context.Context,
	r openapi.RedactWorkingGroupBookingRequestObject,
) (openapi.RedactWorkingGroupBookingResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	booking, err := s.workingGroups.RedactBooking(ctx, p, r.BookingId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RedactWorkingGroupBooking200JSONResponse(bookingDTO(booking)), nil
}
