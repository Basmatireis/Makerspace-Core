package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) ListPrints(ctx context.Context, r openapi.ListPrintsRequestObject) (openapi.ListPrintsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListPrints(ctx, p, machinelogbook.PrintFilters{Search: defaultString(r.Params.Search), MachineID: r.Params.MachineId, State: stringEnum(r.Params.State), Linked: r.Params.Linked, From: r.Params.From, To: r.Params.To, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25)})
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Print, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlPrintDTO(item))
	}
	return openapi.ListPrints200JSONResponse{Items: dto, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25), Total: total}, nil
}

func (s *Server) GetPrint(ctx context.Context, r openapi.GetPrintRequestObject) (openapi.GetPrintResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetPrint(ctx, p, r.PrintId)
	if err != nil {
		return nil, err
	}
	return openapi.GetPrint200JSONResponse(mlPrintDetailDTO(item)), nil
}

func (s *Server) CreateMachineJobFromPrint(ctx context.Context, r openapi.CreateMachineJobFromPrintRequestObject) (openapi.CreateMachineJobFromPrintResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	var outcome *string
	if !r.Body.Outcome.IsNull() && r.Body.Outcome.IsSpecified() {
		value := string(r.Body.Outcome.MustGet())
		outcome = &value
	}
	item, err := s.machineLogbook.CreateJobFromPrint(ctx, p, r.PrintId, machinelogbook.PrintJobInput{Title: nullableStringPointer(r.Body.Title), Customer: partyInput(r.Body.Customer), OperatorPersonID: r.Body.OperatorPersonId, Outcome: outcome, Notes: nullableStringPointer(r.Body.Notes), PricingGroupID: uuidNullable(r.Body.PricingGroupId), Usages: usageInputs(r.Body.Usages)}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachineJobFromPrint201JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) LinkPrintToMachineJob(ctx context.Context, r openapi.LinkPrintToMachineJobRequestObject) (openapi.LinkPrintToMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.LinkPrintToJob(ctx, p, r.PrintId, r.Body.MachineJobId, r.Body.ExpectedJobVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.LinkPrintToMachineJob200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) UnlinkPrintFromMachineJob(ctx context.Context, r openapi.UnlinkPrintFromMachineJobRequestObject) (openapi.UnlinkPrintFromMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UnlinkPrint(ctx, p, r.PrintId, r.Body.ExpectedJobVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UnlinkPrintFromMachineJob200JSONResponse(mlJobDTO(item)), nil
}

func nullableInt(value *int) nullable.Nullable[int] {
	if value == nil {
		return nullable.NewNullNullable[int]()
	}
	return nullable.NewNullableWithValue(*value)
}

func mlPrintDTO(item machinelogbook.Print) openapi.Print {
	var usage nullable.Nullable[openapi.PrintReportedUsage]
	if item.ReportedUsage == nil {
		usage = nullable.NewNullNullable[openapi.PrintReportedUsage]()
	} else {
		u := item.ReportedUsage
		usage = nullable.NewNullableWithValue(openapi.PrintReportedUsage{Quantity: u.Quantity, QuantityBasis: openapi.QuantityBasis(u.QuantityBasis), SpoolId: nullableUUIDValue(u.SpoolID), SpoolDisplayId: nullableString(u.SpoolDisplayID), MaterialId: nullableUUIDValue(u.MaterialID), MaterialName: nullableString(u.MaterialName)})
	}
	var job nullable.Nullable[openapi.PrintJobReference]
	if item.Job == nil {
		job = nullable.NewNullNullable[openapi.PrintJobReference]()
	} else {
		job = nullable.NewNullableWithValue(openapi.PrintJobReference{Id: item.Job.ID, DisplayId: item.Job.DisplayID, Title: nullableString(item.Job.Title)})
	}
	return openapi.Print{Id: item.ID, DisplayId: item.DisplayID, MachineId: item.MachineID, MachineName: item.MachineName, ConnectorName: nullableString(item.ConnectorName), FileName: nullableString(item.FileName), State: openapi.PrintState(item.State), StartedAt: item.StartedAt, EndedAt: nullableValue(item.EndedAt), EstimatedEndAt: nullableValue(item.EstimatedEndAt), ProgressPercent: nullableInt(item.ProgressPercent), ReportedUsage: usage, Job: job, Version: item.Version}
}

func mlPrintDetailDTO(item machinelogbook.PrintDetail) openapi.PrintDetail {
	base := mlPrintDTO(item.Print)
	events := make([]openapi.PrintEvent, 0, len(item.Events))
	for _, e := range item.Events {
		events = append(events, openapi.PrintEvent{Id: e.ID, Kind: openapi.PrintEventKind(e.Kind), OccurredAt: e.OccurredAt, State: nullableString(e.State), ProgressPercent: nullableInt(e.ProgressPercent), Quantity: nullableDecimalValue(e.Quantity)})
	}
	return openapi.PrintDetail{Id: base.Id, DisplayId: base.DisplayId, MachineId: base.MachineId, MachineName: base.MachineName, ConnectorName: base.ConnectorName, FileName: base.FileName, State: base.State, StartedAt: base.StartedAt, EndedAt: base.EndedAt, EstimatedEndAt: base.EstimatedEndAt, ProgressPercent: base.ProgressPercent, ReportedUsage: base.ReportedUsage, Job: base.Job, Version: base.Version, Events: events}
}

func mlJobPrintDTO(item *machinelogbook.MachineJobPrint) nullable.Nullable[openapi.MachineJobPrintReference] {
	if item == nil {
		return nullable.NewNullNullable[openapi.MachineJobPrintReference]()
	}
	return nullable.NewNullableWithValue(openapi.MachineJobPrintReference{Id: item.ID, DisplayId: item.DisplayID, FileName: nullableString(item.FileName), State: openapi.PrintState(item.State), ConnectorName: nullableString(item.ConnectorName)})
}
