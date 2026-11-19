package httpapi

import (
	"bytes"
	"context"
	"io"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func wgDateNullable(v *time.Time) nullable.Nullable[openapi_types.Date] {
	if v == nil {
		return nil
	}
	return nullable.NewNullableWithValue(openapi_types.Date{Time: *v})
}

func nullableText[T any](v *T) nullable.Nullable[T] {
	if v == nil {
		return nil
	}
	return nullable.NewNullableWithValue(*v)
}

func wgOptional[T any](v nullable.Nullable[T]) *T {
	if !v.IsSpecified() || v.IsNull() {
		return nil
	}
	value := v.MustGet()
	return &value
}

func optionalDay(v nullable.Nullable[openapi_types.Date]) *time.Time {
	if date := wgOptional(v); date != nil {
		return &date.Time
	}
	return nil
}

type projectBody struct {
	Title, Goal, Benefit      string
	StartsOn, EndsOn          nullable.Nullable[openapi_types.Date]
	People                    int
	PlannedIncome             string
	Alcohol, AdvanceRequested bool
	AdvanceAmount             nullable.Nullable[openapi.Money]
}

func projectFieldsFrom(v projectBody) workinggroups.ProjectFields {
	return workinggroups.ProjectFields{
		Title: v.Title, Goal: v.Goal, Benefit: v.Benefit, StartsOn: optionalDay(v.StartsOn), EndsOn: optionalDay(v.EndsOn),
		People: v.People, PlannedIncome: v.PlannedIncome, Alcohol: v.Alcohol, AdvanceRequested: v.AdvanceRequested,
		AdvanceAmount: wgOptional(v.AdvanceAmount),
	}
}

func projectDTO(v workinggroups.Project) openapi.WorkingGroupProject {
	out := openapi.WorkingGroupProject{
		Id: v.ID, GroupId: v.GroupID, GroupName: v.GroupName, Title: v.Title, Goal: v.Goal, Benefit: v.Benefit,
		StartsOn: wgDateNullable(v.StartsOn), EndsOn: wgDateNullable(v.EndsOn), People: int(v.People), PlannedIncome: v.PlannedIncome,
		Alcohol: v.Alcohol, AdvanceRequested: v.AdvanceRequested, Status: openapi.WorkingGroupProjectStatus(v.Status),
		WirefNeeded: v.WiRefNeeded, WirefRequestPending: v.WiRefRequestPending, HasRequestPdf: v.HasRequestPDF,
		CanEdit: v.CanEdit, CanSubmit: v.CanSubmit, CanDecide: v.CanDecide, CanComplete: v.CanComplete,
		CreatedAt: v.CreatedAt, Version: v.Version,
		Totals: openapi.WorkingGroupProjectTotals{
			Planned: v.Totals.Planned, InPurchases: v.Totals.InPurchases, Spent: v.Totals.Spent, Left: v.Totals.Left,
		},
		Checklist: openapi.WorkingGroupProjectChecklist{Complete: v.Checklist.Complete, Open: nonNil(v.Checklist.Open)},
		Items:     make([]openapi.WorkingGroupProjectItem, 0, len(v.Items)),
		History:   make([]openapi.WorkingGroupProjectHistoryEntry, 0, len(v.History)),
	}
	out.AdvanceAmount = nullableText(v.AdvanceAmount)
	if v.AdvanceStatus != nil {
		out.AdvanceStatus = nullable.NewNullableWithValue(openapi.WorkingGroupProjectAdvanceStatus(*v.AdvanceStatus))
	}
	if v.PaidFrom != nil {
		out.PaidFrom = nullable.NewNullableWithValue(openapi.WorkingGroupProjectPaidFrom(*v.PaidFrom))
	}
	if v.WiRefNumber != "" {
		out.WirefNumber = &v.WiRefNumber
	}
	if v.CompletionReport != "" {
		out.CompletionReport = &v.CompletionReport
	}
	if v.Requester != nil {
		out.Requester = nullable.NewNullableWithValue(*workingGroupPersonDTO(v.Requester))
	}
	if f := v.RequestForm; f != nil {
		form := openapi.WorkingGroupProjectRequestForm{
			UnitKind: openapi.WorkingGroupProjectUnitKind(f.UnitKind), UnitName: f.UnitName, Number: f.Number, ProjectName: f.ProjectName,
			Alcohol: f.Alcohol, People: f.People, Advance: f.Advance, Description: f.Description, MaxExpenses: f.MaxExpenses,
			MaxIncome: f.MaxIncome, ResponsibleFirstName: f.ResponsibleFirstName, ResponsibleLastName: f.ResponsibleLastName,
			Place: f.Place, Date: openapi_types.Date{Time: parseDay(f.Date)},
		}
		if f.StartsOn != "" {
			form.StartsOn = nullable.NewNullableWithValue(openapi_types.Date{Time: parseDay(f.StartsOn)})
		}
		if f.EndsOn != "" {
			form.EndsOn = nullable.NewNullableWithValue(openapi_types.Date{Time: parseDay(f.EndsOn)})
		}
		out.RequestForm = nullable.NewNullableWithValue(form)
	}
	for _, item := range v.Items {
		dto := openapi.WorkingGroupProjectItem{
			Id: item.ID, Position: int(item.Position), Text: item.Text, PlannedAmount: item.PlannedAmount, Link: item.Link, Note: item.Note,
			NeedsOffers: item.NeedsOffers, ChosenOfferId: nullableText(item.ChosenOfferID),
			Offers:    make([]openapi.WorkingGroupProjectOffer, 0, len(item.Offers)),
			Purchases: make([]openapi.WorkingGroupProjectPurchase, 0, len(item.Purchases)),
		}
		for _, o := range item.Offers {
			dto.Offers = append(dto.Offers, openapi.WorkingGroupProjectOffer{Id: o.ID, Shop: o.Shop, Price: o.Price, HasFile: o.HasFile})
		}
		for _, pu := range item.Purchases {
			dto.Purchases = append(dto.Purchases, openapi.WorkingGroupProjectPurchase{
				Id: pu.ID, ItemId: nullableText(pu.ItemID), Item: pu.Item, Link: pu.Link, Quantity: int(pu.Quantity),
				UnitPrice: pu.UnitPrice, Status: openapi.WorkingGroupPurchaseStatus(pu.Status), HasAttachment: pu.HasAttachment,
			})
		}
		out.Items = append(out.Items, dto)
	}
	for _, h := range v.History {
		entry := openapi.WorkingGroupProjectHistoryEntry{Status: h.Status, At: h.At}
		if h.Reason != "" {
			entry.Reason = &h.Reason
		}
		if h.Actor != nil {
			entry.Actor = nullable.NewNullableWithValue(*workingGroupPersonDTO(h.Actor))
		}
		out.History = append(out.History, entry)
	}
	return out
}

func nonNil(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func parseDay(v string) time.Time {
	t, _ := time.Parse("2006-01-02", v)
	return t
}

func (s *Server) ListWorkingGroupProjects(
	ctx context.Context,
	r openapi.ListWorkingGroupProjectsRequestObject,
) (openapi.ListWorkingGroupProjectsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	filter := workinggroups.ProjectFilter{GroupID: r.Params.GroupId}
	if r.Params.Status != nil {
		status := string(*r.Params.Status)
		filter.Status = &status
	}
	items, truncated, err := s.workingGroups.ListProjects(ctx, p, filter)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupProject, 0, len(items))
	for _, item := range items {
		out = append(out, projectDTO(item))
	}
	return openapi.ListWorkingGroupProjects200JSONResponse{Items: out, Truncated: truncated}, nil
}

func (s *Server) CreateWorkingGroupProject(
	ctx context.Context,
	r openapi.CreateWorkingGroupProjectRequestObject,
) (openapi.CreateWorkingGroupProjectResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	b := r.Body
	item, err := s.workingGroups.CreateProject(ctx, p, workinggroups.CreateProjectInput{
		GroupID: b.GroupId,
		ProjectFields: projectFieldsFrom(projectBody{
			Title: b.Title, Goal: b.Goal, Benefit: b.Benefit, StartsOn: b.StartsOn, EndsOn: b.EndsOn, People: b.People,
			PlannedIncome: b.PlannedIncome, Alcohol: b.Alcohol, AdvanceRequested: b.AdvanceRequested, AdvanceAmount: b.AdvanceAmount,
		}),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupProject201JSONResponse(projectDTO(item)), nil
}

func (s *Server) GetWorkingGroupProject(
	ctx context.Context,
	r openapi.GetWorkingGroupProjectRequestObject,
) (openapi.GetWorkingGroupProjectResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.workingGroups.GetProject(ctx, p, r.ProjectId)
	if err != nil {
		return nil, err
	}
	return openapi.GetWorkingGroupProject200JSONResponse(projectDTO(item)), nil
}

func (s *Server) UpdateWorkingGroupProject(
	ctx context.Context,
	r openapi.UpdateWorkingGroupProjectRequestObject,
) (openapi.UpdateWorkingGroupProjectResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	b := r.Body
	item, err := s.workingGroups.UpdateProject(ctx, p, r.ProjectId, workinggroups.UpdateProjectInput{
		ExpectedVersion: b.ExpectedVersion,
		ProjectFields: projectFieldsFrom(projectBody{
			Title: b.Title, Goal: b.Goal, Benefit: b.Benefit, StartsOn: b.StartsOn, EndsOn: b.EndsOn, People: b.People,
			PlannedIncome: b.PlannedIncome, Alcohol: b.Alcohol, AdvanceRequested: b.AdvanceRequested, AdvanceAmount: b.AdvanceAmount,
		}),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateWorkingGroupProject200JSONResponse(projectDTO(item)), nil
}

func (s *Server) DeleteWorkingGroupProject(
	ctx context.Context,
	r openapi.DeleteWorkingGroupProjectRequestObject,
) (openapi.DeleteWorkingGroupProjectResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.DeleteProject(ctx, p, r.ProjectId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupProject204Response{}, nil
}

func (s *Server) CreateWorkingGroupProjectItem(
	ctx context.Context,
	r openapi.CreateWorkingGroupProjectItemRequestObject,
) (openapi.CreateWorkingGroupProjectItemResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.CreateProjectItem(ctx, p, r.ProjectId, workinggroups.ProjectItemInput{
		Text: r.Body.Text, PlannedAmount: r.Body.PlannedAmount, Link: r.Body.Link, Note: r.Body.Note,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupProjectItem201JSONResponse(projectDTO(item)), nil
}

func (s *Server) ReorderWorkingGroupProjectItems(
	ctx context.Context,
	r openapi.ReorderWorkingGroupProjectItemsRequestObject,
) (openapi.ReorderWorkingGroupProjectItemsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.ReorderProjectItems(ctx, p, r.ProjectId, r.Body.ExpectedVersion, r.Body.ItemIds, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReorderWorkingGroupProjectItems200JSONResponse(projectDTO(item)), nil
}

func (s *Server) UpdateWorkingGroupProjectItem(
	ctx context.Context,
	r openapi.UpdateWorkingGroupProjectItemRequestObject,
) (openapi.UpdateWorkingGroupProjectItemResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.UpdateProjectItem(ctx, p, r.ProjectId, r.ItemId, workinggroups.ProjectItemInput{
		ExpectedVersion: r.Body.ExpectedVersion, Text: r.Body.Text, PlannedAmount: r.Body.PlannedAmount, Link: r.Body.Link, Note: r.Body.Note,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateWorkingGroupProjectItem200JSONResponse(projectDTO(item)), nil
}

func (s *Server) DeleteWorkingGroupProjectItem(
	ctx context.Context,
	r openapi.DeleteWorkingGroupProjectItemRequestObject,
) (openapi.DeleteWorkingGroupProjectItemResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.workingGroups.DeleteProjectItem(ctx, p, r.ProjectId, r.ItemId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupProjectItem200JSONResponse(projectDTO(item)), nil
}

func (s *Server) CreateWorkingGroupProjectOffer(
	ctx context.Context,
	r openapi.CreateWorkingGroupProjectOfferRequestObject,
) (openapi.CreateWorkingGroupProjectOfferResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.CreateProjectOffer(ctx, p, r.ProjectId, r.ItemId, workinggroups.ProjectOfferInput{
		ExpectedVersion: r.Body.ExpectedVersion, Shop: r.Body.Shop, Price: r.Body.Price,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupProjectOffer201JSONResponse(projectDTO(item)), nil
}

func (s *Server) DeleteWorkingGroupProjectOffer(
	ctx context.Context,
	r openapi.DeleteWorkingGroupProjectOfferRequestObject,
) (openapi.DeleteWorkingGroupProjectOfferResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.workingGroups.DeleteProjectOffer(ctx, p, r.ProjectId, r.OfferId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupProjectOffer200JSONResponse(projectDTO(item)), nil
}

func (s *Server) UploadWorkingGroupProjectOfferFile(
	ctx context.Context,
	r openapi.UploadWorkingGroupProjectOfferFileRequestObject,
) (openapi.UploadWorkingGroupProjectOfferFileResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.CheckProjectOfferUpload(ctx, p, r.ProjectId); err != nil {
		return nil, err
	}
	upload, err := readFinanceFile(r.Body, r.Params.XFileName, r.Params.XFileContentType)
	if err != nil {
		return nil, err
	}
	item, err := s.workingGroups.SetProjectOfferFile(ctx, p, r.ProjectId, r.OfferId, upload, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UploadWorkingGroupProjectOfferFile200JSONResponse(projectDTO(item)), nil
}

func (s *Server) DownloadWorkingGroupProjectOfferFile(
	ctx context.Context,
	r openapi.DownloadWorkingGroupProjectOfferFileRequestObject,
) (openapi.DownloadWorkingGroupProjectOfferFileResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.workingGroups.OpenProjectOfferFile(ctx, p, r.ProjectId, r.OfferId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadWorkingGroupProjectOfferFile200ApplicationoctetStreamResponse{
		Body: reader, ContentLength: file.Size,
		Headers: openapi.DownloadWorkingGroupProjectOfferFile200ResponseHeaders{
			CacheControl: "no-store", ContentDisposition: attachmentDisposition(file.OriginalFilename),
			XContentTypeOptions: "nosniff", ContentSecurityPolicy: "default-src 'none'; sandbox",
		},
	}, nil
}

func (s *Server) SubmitWorkingGroupProject(
	ctx context.Context,
	r openapi.SubmitWorkingGroupProjectRequestObject,
) (openapi.SubmitWorkingGroupProjectResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.SubmitProject(ctx, p, r.ProjectId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SubmitWorkingGroupProject200JSONResponse(projectDTO(item)), nil
}

func (s *Server) ReturnWorkingGroupProject(
	ctx context.Context,
	r openapi.ReturnWorkingGroupProjectRequestObject,
) (openapi.ReturnWorkingGroupProjectResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.ReturnProject(ctx, p, r.ProjectId, r.Body.ExpectedVersion, r.Body.Reason, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReturnWorkingGroupProject200JSONResponse(projectDTO(item)), nil
}

func (s *Server) DeclineWorkingGroupProject(
	ctx context.Context,
	r openapi.DeclineWorkingGroupProjectRequestObject,
) (openapi.DeclineWorkingGroupProjectResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.DeclineProject(ctx, p, r.ProjectId, r.Body.ExpectedVersion, r.Body.Reason, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DeclineWorkingGroupProject200JSONResponse(projectDTO(item)), nil
}

func formInputFrom(f *openapi.WorkingGroupProjectRequestFormInput) workinggroups.RequestFormInput {
	if f == nil {
		return workinggroups.RequestFormInput{}
	}
	out := workinggroups.RequestFormInput{
		UnitName: f.UnitName, ProjectName: f.ProjectName, Alcohol: f.Alcohol, People: f.People, Advance: f.Advance,
		Description: f.Description, MaxExpenses: f.MaxExpenses, MaxIncome: f.MaxIncome, ResponsibleFirstName: f.ResponsibleFirstName,
		ResponsibleLastName: f.ResponsibleLastName, Place: f.Place,
	}
	if f.UnitKind != nil {
		kind := string(*f.UnitKind)
		out.UnitKind = &kind
	}
	for dst, src := range map[**time.Time]*openapi_types.Date{&out.StartsOn: f.StartsOn, &out.EndsOn: f.EndsOn, &out.Date: f.Date} {
		if src != nil {
			day := src.Time
			*dst = &day
		}
	}
	if f.Signature != nil {
		out.Signature = *f.Signature
	}
	out.UseSavedSignature = f.UseSavedSignature != nil && *f.UseSavedSignature
	return out
}

func (s *Server) ApproveWorkingGroupProject(
	ctx context.Context,
	r openapi.ApproveWorkingGroupProjectRequestObject,
) (openapi.ApproveWorkingGroupProjectResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.ApproveProject(ctx, p, r.ProjectId, workinggroups.ApproveProjectInput{
		ExpectedVersion: r.Body.ExpectedVersion, PaidFrom: string(r.Body.PaidFrom), Form: formInputFrom(r.Body.Form),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ApproveWorkingGroupProject200JSONResponse(projectDTO(item)), nil
}

func (s *Server) RecordWorkingGroupProjectWiRefDecision(
	ctx context.Context,
	r openapi.RecordWorkingGroupProjectWiRefDecisionRequestObject,
) (openapi.RecordWorkingGroupProjectWiRefDecisionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := workinggroups.WiRefDecisionInput{ExpectedVersion: r.Body.ExpectedVersion, Number: r.Body.Number}
	for _, c := range r.Body.ChosenOffers {
		input.ChosenOffers = append(input.ChosenOffers, workinggroups.ChosenOffer{ItemID: c.ItemId, OfferID: c.OfferId})
	}
	item, err := s.workingGroups.RecordWiRefDecision(ctx, p, r.ProjectId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RecordWorkingGroupProjectWiRefDecision200JSONResponse(projectDTO(item)), nil
}

func (s *Server) SetWorkingGroupProjectPaidFrom(
	ctx context.Context,
	r openapi.SetWorkingGroupProjectPaidFromRequestObject,
) (openapi.SetWorkingGroupProjectPaidFromResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	reason := ""
	if r.Body.Reason != nil {
		reason = *r.Body.Reason
	}
	item, err := s.workingGroups.SetProjectPaidFrom(ctx, p, r.ProjectId, r.Body.ExpectedVersion, string(r.Body.PaidFrom), reason, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetWorkingGroupProjectPaidFrom200JSONResponse(projectDTO(item)), nil
}

func (s *Server) SendWorkingGroupProjectToWiRef(
	ctx context.Context,
	r openapi.SendWorkingGroupProjectToWiRefRequestObject,
) (openapi.SendWorkingGroupProjectToWiRefResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.SendProjectToWiRef(ctx, p, r.ProjectId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SendWorkingGroupProjectToWiRef200JSONResponse(projectDTO(item)), nil
}

func (s *Server) MarkWorkingGroupProjectAdvanceReceived(
	ctx context.Context,
	r openapi.MarkWorkingGroupProjectAdvanceReceivedRequestObject,
) (openapi.MarkWorkingGroupProjectAdvanceReceivedResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.MarkProjectAdvanceReceived(ctx, p, r.ProjectId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.MarkWorkingGroupProjectAdvanceReceived200JSONResponse(projectDTO(item)), nil
}

func (s *Server) CompleteWorkingGroupProject(
	ctx context.Context,
	r openapi.CompleteWorkingGroupProjectRequestObject,
) (openapi.CompleteWorkingGroupProjectResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	report := ""
	if r.Body.Report != nil {
		report = *r.Body.Report
	}
	item, err := s.workingGroups.CompleteProject(ctx, p, r.ProjectId, r.Body.ExpectedVersion, report, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CompleteWorkingGroupProject200JSONResponse(projectDTO(item)), nil
}

func (s *Server) PreviewWorkingGroupProjectRequest(
	ctx context.Context,
	r openapi.PreviewWorkingGroupProjectRequestRequestObject,
) (openapi.PreviewWorkingGroupProjectRequestResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	pdf, err := s.workingGroups.PreviewProjectRequest(ctx, p, r.ProjectId, formInputFrom(r.Body))
	if err != nil {
		return nil, err
	}
	return openapi.PreviewWorkingGroupProjectRequest200ApplicationpdfResponse{
		Body: bytesReader(pdf), ContentLength: int64(len(pdf)),
		Headers: openapi.PreviewWorkingGroupProjectRequest200ResponseHeaders{
			CacheControl: "no-store", ContentDisposition: attachmentDisposition("Projektantrag.pdf"), XContentTypeOptions: "nosniff",
		},
	}, nil
}

func (s *Server) DownloadWorkingGroupProjectRequestPdf(
	ctx context.Context,
	r openapi.DownloadWorkingGroupProjectRequestPdfRequestObject,
) (openapi.DownloadWorkingGroupProjectRequestPdfResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.workingGroups.OpenProjectRequestPDF(ctx, p, r.ProjectId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadWorkingGroupProjectRequestPdf200ApplicationoctetStreamResponse{
		Body: reader, ContentLength: file.Size,
		Headers: openapi.DownloadWorkingGroupProjectRequestPdf200ResponseHeaders{
			CacheControl: "no-store", ContentDisposition: attachmentDisposition("Projektantrag.pdf"),
			XContentTypeOptions: "nosniff", ContentSecurityPolicy: "default-src 'none'; sandbox",
		},
	}, nil
}

func (s *Server) ConvertWorkingGroupPurchaseToProject(
	ctx context.Context,
	r openapi.ConvertWorkingGroupPurchaseToProjectRequestObject,
) (openapi.ConvertWorkingGroupPurchaseToProjectResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.workingGroups.ConvertPurchaseToProject(ctx, p, r.PurchaseId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ConvertWorkingGroupPurchaseToProject201JSONResponse(projectDTO(item)), nil
}

func (s *Server) PutWorkingGroupFinanceSignature(
	ctx context.Context,
	r openapi.PutWorkingGroupFinanceSignatureRequestObject,
) (openapi.PutWorkingGroupFinanceSignatureResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, workinggroups.MaxSignatureBytes+1))
	if err != nil {
		return nil, invalidRequest("could not read file")
	}
	if err := s.workingGroups.PutFinanceSignature(ctx, p, workinggroups.FileUpload{
		Filename: r.Params.XFileName, ContentType: r.Params.XFileContentType, Data: data,
	}, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.PutWorkingGroupFinanceSignature204Response{}, nil
}

func (s *Server) DeleteWorkingGroupFinanceSignature(
	ctx context.Context,
	_ openapi.DeleteWorkingGroupFinanceSignatureRequestObject,
) (openapi.DeleteWorkingGroupFinanceSignatureResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.DeleteFinanceSignature(ctx, p, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupFinanceSignature204Response{}, nil
}

func (s *Server) DownloadWorkingGroupFinanceSignature(
	ctx context.Context,
	_ openapi.DownloadWorkingGroupFinanceSignatureRequestObject,
) (openapi.DownloadWorkingGroupFinanceSignatureResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.workingGroups.OpenFinanceSignature(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadWorkingGroupFinanceSignature200ApplicationoctetStreamResponse{
		Body: reader, ContentLength: file.Size,
		Headers: openapi.DownloadWorkingGroupFinanceSignature200ResponseHeaders{
			CacheControl: "no-store", ContentDisposition: attachmentDisposition("signature.png"),
			XContentTypeOptions: "nosniff", ContentSecurityPolicy: "default-src 'none'; sandbox",
		},
	}, nil
}

func bytesReader(data []byte) io.Reader { return bytes.NewReader(data) }
