package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) ListMachineTypes(
	ctx context.Context,
	_ openapi.ListMachineTypesRequestObject,
) (openapi.ListMachineTypesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.ListMachineTypes(ctx, p)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.MachineType, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMachineTypeDTO(item))
	}
	return openapi.ListMachineTypes200JSONResponse{Items: dto}, nil
}

func (s *Server) CreateMachineType(
	ctx context.Context,
	r openapi.CreateMachineTypeRequestObject,
) (openapi.CreateMachineTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateMachineType(ctx, p, r.Body.Name, string(r.Body.Process), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachineType201JSONResponse(mlMachineTypeDTO(item)), nil
}

func (s *Server) UpdateMachineType(
	ctx context.Context,
	r openapi.UpdateMachineTypeRequestObject,
) (openapi.UpdateMachineTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateMachineType(
		ctx,
		p,
		r.MachineTypeId,
		r.Body.ExpectedVersion,
		r.Body.Name,
		r.Body.Active,
		machineProcessPointer(r.Body.Process),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachineType200JSONResponse(mlMachineTypeDTO(item)), nil
}

func (s *Server) ListMachines(
	ctx context.Context,
	r openapi.ListMachinesRequestObject,
) (openapi.ListMachinesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListMachines(
		ctx,
		p,
		defaultString(r.Params.Search),
		stringEnum(r.Params.Status),
		defaultInt(r.Params.Page, 1),
		defaultInt(r.Params.PageSize, 25),
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Machine, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMachineDTO(item))
	}
	return openapi.ListMachines200JSONResponse{
		Items:    dto,
		Page:     defaultInt(r.Params.Page, 1),
		PageSize: defaultInt(r.Params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) CreateMachine(
	ctx context.Context,
	r openapi.CreateMachineRequestObject,
) (openapi.CreateMachineResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateMachine(
		ctx,
		p,
		r.Body.MachineTypeId,
		r.Body.Name,
		string(r.Body.Status),
		nullableStringPointer(r.Body.ExternalIdentifier),
		r.Body.AutomaticCollectionEnabled,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachine201JSONResponse(mlMachineDTO(item)), nil
}

func (s *Server) GetMachine(
	ctx context.Context,
	r openapi.GetMachineRequestObject,
) (openapi.GetMachineResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetMachine(ctx, p, r.MachineId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMachine200JSONResponse(mlMachineDTO(item)), nil
}

func (s *Server) UpdateMachine(
	ctx context.Context,
	r openapi.UpdateMachineRequestObject,
) (openapi.UpdateMachineResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateMachine(
		ctx,
		p,
		r.MachineId,
		r.Body.ExpectedVersion,
		r.Body.MachineTypeId,
		r.Body.Name,
		string(r.Body.Status),
		nullableStringPointer(r.Body.ExternalIdentifier),
		r.Body.AutomaticCollectionEnabled,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachine200JSONResponse(mlMachineDTO(item)), nil
}

func (s *Server) DeleteMachine(
	ctx context.Context,
	r openapi.DeleteMachineRequestObject,
) (openapi.DeleteMachineResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.machineLogbook.DeleteMachine(
		ctx,
		p,
		r.MachineId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteMachine204Response{}, nil
}

func (s *Server) ListMachineJobs(
	ctx context.Context,
	r openapi.ListMachineJobsRequestObject,
) (openapi.ListMachineJobsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListJobs(
		ctx,
		p,
		machinelogbook.JobFilters{
			Search:     defaultString(r.Params.Search),
			MachineID:  r.Params.MachineId,
			CustomerID: r.Params.CustomerId,
			OperatorID: r.Params.OperatorPersonId,
			MaterialID: r.Params.MaterialId,
			Outcome:    stringEnum(r.Params.Outcome),
			From:       r.Params.From,
			To:         r.Params.To,
			Page:       defaultInt(r.Params.Page, 1),
			PageSize:   defaultInt(r.Params.PageSize, 25),
		},
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.MachineJob, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlJobDTO(item))
	}
	return openapi.ListMachineJobs200JSONResponse{
		Items:    dto,
		Page:     defaultInt(r.Params.Page, 1),
		PageSize: defaultInt(r.Params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) CreateMachineJob(
	ctx context.Context,
	r openapi.CreateMachineJobRequestObject,
) (openapi.CreateMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	run := manualRunInput(r.Body.Run)
	outcome := ""
	if run.Outcome != nil {
		outcome = *run.Outcome
	}
	item, err := s.machineLogbook.CreateManualJob(
		ctx,
		p,
		machinelogbook.JobInput{
			MachineID:        r.Body.MachineId,
			StartsAt:         run.StartsAt,
			EndsAt:           run.EndsAt,
			Customer:         partyInput(r.Body.Customer),
			OperatorPersonID: r.Body.OperatorPersonId,
			Outcome:          outcome,
			Title:            nullableStringPointer(r.Body.Title),
			Notes:            nullableStringPointer(r.Body.Notes),
			PricingGroupID:   uuidNullable(r.Body.PricingGroupId),
			Usages:           run.Usages,
			Measures:         run.Measures,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachineJob201JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) GetMachineJob(
	ctx context.Context,
	r openapi.GetMachineJobRequestObject,
) (openapi.GetMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetJob(ctx, p, r.MachineJobId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMachineJob200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) UpdateMachineJob(
	ctx context.Context,
	r openapi.UpdateMachineJobRequestObject,
) (openapi.UpdateMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	customer := machinelogbook.PartyReference{}
	if r.Body.Customer != nil {
		customer = partyInput(*r.Body.Customer)
	}
	item, err := s.machineLogbook.UpdateJobFacts(
		ctx,
		p,
		r.MachineJobId,
		r.Body.ExpectedVersion,
		machinelogbook.JobUpdate{
			MachineID:        r.Body.MachineId,
			Customer:         customer,
			OperatorPersonID: r.Body.OperatorPersonId,
			OutcomeOverride:  nullableStringPointer(r.Body.OutcomeOverride),
			Title:            nullableStringPointer(r.Body.Title),
			Notes:            nullableStringPointer(r.Body.Notes),
			PricingGroupID:   uuidNullable(r.Body.PricingGroupId),
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachineJob200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) SetMachineJobPriceAdjustment(
	ctx context.Context,
	r openapi.SetMachineJobPriceAdjustmentRequestObject,
) (openapi.SetMachineJobPriceAdjustmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.SetJobPriceAdjustment(
		ctx,
		p,
		r.MachineJobId,
		r.Body.ExpectedVersion,
		string(r.Body.Kind),
		r.Body.Value,
		r.Body.Reason,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.SetMachineJobPriceAdjustment200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) ClearMachineJobPriceAdjustment(
	ctx context.Context,
	r openapi.ClearMachineJobPriceAdjustmentRequestObject,
) (openapi.ClearMachineJobPriceAdjustmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.ClearJobPriceAdjustment(
		ctx,
		p,
		r.MachineJobId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.ClearMachineJobPriceAdjustment200JSONResponse(mlJobDTO(item)), nil
}
func derefSlice[T any](values *[]T) []T {
	if values == nil {
		return nil
	}
	return *values
}
func stringSlice[T ~string](values *[]T) []string {
	result := make([]string, 0, len(derefSlice(values)))
	for _, v := range derefSlice(values) {
		result = append(result, string(v))
	}
	return result
}

func (s *Server) ListMachineLogbookWorkItems(
	ctx context.Context,
	r openapi.ListMachineLogbookWorkItemsRequestObject,
) (openapi.ListMachineLogbookWorkItemsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	page, size := defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25)
	items, total, err := s.machineLogbook.ListWorkItems(
		ctx,
		p,
		machinelogbook.WorkItemFilters{
			Search:   defaultString(r.Params.Search),
			Statuses: stringSlice(r.Params.Status),
			Sources:  stringSlice(r.Params.Source),
			Billing: stringSlice(
				r.Params.Billing,
			),
			MachineIDs:  derefSlice(r.Params.MachineId),
			MaterialIDs: derefSlice(r.Params.MaterialId),
			CustomerID:  r.Params.CustomerId,
			OperatorID:  r.Params.OperatorPersonId,
			From:        r.Params.From,
			To:          r.Params.To,
			Sort:        defaultString(stringEnum(r.Params.Sort)),
			Direction:   defaultString(stringEnum(r.Params.Direction)),
			Page:        page,
			PageSize:    size,
		},
	)
	if err != nil {
		return nil, err
	}
	return openapi.ListMachineLogbookWorkItems200JSONResponse{
		Items:    mlWorkItemDTOs(items),
		Page:     page,
		PageSize: size,
		Total:    total,
	}, nil
}

func (s *Server) ListMachineActivity(
	ctx context.Context,
	_ openapi.ListMachineActivityRequestObject,
) (openapi.ListMachineActivityResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.MachineActivity(ctx, p)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.MachineActivity, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMachineActivityDTO(item))
	}
	return openapi.ListMachineActivity200JSONResponse{Items: dto}, nil
}

func (s *Server) GetMachineLogbookOverview(
	ctx context.Context,
	_ openapi.GetMachineLogbookOverviewRequestObject,
) (openapi.GetMachineLogbookOverviewResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.Overview(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.GetMachineLogbookOverview200JSONResponse(mlOverviewDTO(item)), nil
}

func (s *Server) GetMachineLogbookStatistics(
	ctx context.Context,
	r openapi.GetMachineLogbookStatisticsRequestObject,
) (openapi.GetMachineLogbookStatisticsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	from, to := utcDayBounds(r.Params.From.Time, r.Params.To.Time)
	item, err := s.machineLogbook.Statistics(ctx, p, from, to)
	if err != nil {
		return nil, err
	}
	return openapi.GetMachineLogbookStatistics200JSONResponse(mlStatisticsDTO(item)), nil
}

func valueString[T ~string](value *T) string {
	if value == nil {
		return ""
	}
	return string(*value)
}

func (s *Server) DeleteMachineJob(
	ctx context.Context,
	r openapi.DeleteMachineJobRequestObject,
) (openapi.DeleteMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.machineLogbook.DeleteJob(
		ctx,
		p,
		r.MachineJobId,
		machinelogbook.DeleteJobInput{
			ExpectedVersion:    r.Body.ExpectedVersion,
			ReverseConsumption: r.Body.ReverseConsumption,
			DeleteRecordedRuns: r.Body.DeleteRecordedRuns,
		},
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteMachineJob204Response{}, nil
}
