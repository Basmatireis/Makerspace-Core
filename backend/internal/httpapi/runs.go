package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) ListMachineRuns(
	ctx context.Context,
	r openapi.ListMachineRunsRequestObject,
) (openapi.ListMachineRunsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListRuns(
		ctx,
		p,
		machinelogbook.RunFilters{
			Search:    defaultString(r.Params.Search),
			MachineID: r.Params.MachineId,
			States:    enumSlice[machinelogbook.RunState](stringSlice(r.Params.State)),
			Source:    enumPointer[machinelogbook.RunSource](r.Params.Source),
			Assigned:  r.Params.Assigned,
			From:      r.Params.From,
			To:        r.Params.To,
			Page:      defaultInt(r.Params.Page, 1),
			PageSize:  defaultInt(r.Params.PageSize, 25),
		},
	)
	if err != nil {
		return nil, err
	}
	return openapi.ListMachineRuns200JSONResponse{
		Items:    mlRunDTOs(items),
		Page:     defaultInt(r.Params.Page, 1),
		PageSize: defaultInt(r.Params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) GetMachineRun(
	ctx context.Context,
	r openapi.GetMachineRunRequestObject,
) (openapi.GetMachineRunResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetRun(ctx, p, r.RunId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMachineRun200JSONResponse(mlRunDetailDTO(item)), nil
}

func (s *Server) UpdateMachineRun(
	ctx context.Context,
	r openapi.UpdateMachineRunRequestObject,
) (openapi.UpdateMachineRunResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateRun(
		ctx,
		p,
		r.RunId,
		r.Body.ExpectedVersion,
		machinelogbook.RunUpdate{
			StartsAt: r.Body.StartsAt,
			EndsAt:   r.Body.EndsAt,
			Outcome:  enumPointer[machinelogbook.RunOutcome](nullableStringPointer(r.Body.Outcome)),
			Measures: runMeasuresInput(r.Body.Measures),
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachineRun200JSONResponse(mlRunResultDTO(item)), nil
}

func (s *Server) DeleteMachineRun(
	ctx context.Context,
	r openapi.DeleteMachineRunRequestObject,
) (openapi.DeleteMachineRunResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.machineLogbook.DeleteRun(
		ctx,
		p,
		r.RunId,
		r.Body.ExpectedVersion,
		r.Body.ReverseConsumption,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteMachineRun204Response{}, nil
}

func (s *Server) ReplaceMachineRunUsages(
	ctx context.Context,
	r openapi.ReplaceMachineRunUsagesRequestObject,
) (openapi.ReplaceMachineRunUsagesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.ReplaceRunUsages(
		ctx,
		p,
		r.RunId,
		r.Body.ExpectedVersion,
		usageInputs(r.Body.Usages),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.ReplaceMachineRunUsages200JSONResponse(mlRunResultDTO(item)), nil
}

func (s *Server) CancelMachineRun(
	ctx context.Context,
	r openapi.CancelMachineRunRequestObject,
) (openapi.CancelMachineRunResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CancelRun(ctx, p, r.RunId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CancelMachineRun200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) CreateMachineJobFromRun(
	ctx context.Context,
	r openapi.CreateMachineJobFromRunRequestObject,
) (openapi.CreateMachineJobFromRunResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateJobFromRun(
		ctx,
		p,
		r.RunId,
		machinelogbook.RunJobInput{
			Title:            nullableStringPointer(r.Body.Title),
			Customer:         partyInput(r.Body.Customer),
			OperatorPersonID: r.Body.OperatorPersonId,
			Notes:            nullableStringPointer(r.Body.Notes),
			PricingGroupID:   uuidNullable(r.Body.PricingGroupId),
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachineJobFromRun201JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) AttachMachineRun(
	ctx context.Context,
	r openapi.AttachMachineRunRequestObject,
) (openapi.AttachMachineRunResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.AttachRun(
		ctx,
		p,
		r.RunId,
		r.Body.MachineJobId,
		r.Body.ReplaceManualRuns,
		r.Body.ExpectedJobVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.AttachMachineRun200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) DetachMachineRun(
	ctx context.Context,
	r openapi.DetachMachineRunRequestObject,
) (openapi.DetachMachineRunResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.DetachRun(ctx, p, r.RunId, r.Body.ExpectedJobVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DetachMachineRun200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) AddManualMachineRun(
	ctx context.Context,
	r openapi.AddManualMachineRunRequestObject,
) (openapi.AddManualMachineRunResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.AddManualRun(
		ctx,
		p,
		r.MachineJobId,
		r.Body.ExpectedJobVersion,
		manualRunInput(r.Body.Run),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.AddManualMachineRun201JSONResponse(mlJobDTO(item)), nil
}

func manualRunInput(value openapi.ManualRunInput) machinelogbook.ManualRunInput {
	return machinelogbook.ManualRunInput{
		StartsAt: value.StartsAt,
		EndsAt:   value.EndsAt,
		Outcome:  enumPointer[machinelogbook.RunOutcome](nullableStringPointer(value.Outcome)),
		Usages:   usageInputs(value.Usages),
		Measures: runMeasuresInput(value.Measures),
	}
}

func mlRunBase(item machinelogbook.MachineRun) openapi.MachineRun {
	usages := make([]openapi.MachineJobUsage, 0, len(item.Usages))
	for _, u := range item.Usages {
		usages = append(usages, mlUsageDTO(u))
	}
	job := nullable.NewNullNullable[openapi.MachineRunJobReference]()
	if item.Job != nil {
		job = nullable.NewNullableWithValue(
			openapi.MachineRunJobReference{
				Id:        item.Job.ID,
				DisplayId: item.Job.DisplayID,
				Title:     nullableString(item.Job.Title),
			},
		)
	}
	outcome := nullable.NewNullNullable[openapi.MachineRunOutcome]()
	if item.Outcome != nil {
		outcome = nullable.NewNullableWithValue(openapi.MachineRunOutcome(*item.Outcome))
	}
	reported := nullable.NewNullNullable[openapi.MachineRunReportedUsage]()
	if u := item.ReportedUsage; u != nil {
		reported = nullable.NewNullableWithValue(
			openapi.MachineRunReportedUsage{
				Quantity:       u.Quantity,
				QuantityBasis:  openapi.QuantityBasis(u.QuantityBasis),
				SpoolId:        nullableUUIDValue(u.SpoolID),
				SpoolDisplayId: nullableString(u.SpoolDisplayID),
				MaterialId:     nullableUUIDValue(u.MaterialID),
				MaterialName:   nullableString(u.MaterialName),
			},
		)
	}
	reportedItems := make([]openapi.MachineRunReportedUsageItem, 0, len(item.ReportedUsageItems))
	for _, u := range item.ReportedUsageItems {
		lineNumber := 0
		if u.LineNumber != nil {
			lineNumber = *u.LineNumber
		}
		reportedItems = append(
			reportedItems,
			openapi.MachineRunReportedUsageItem{
				LineNumber:               lineNumber,
				Extruder:                 nullableValue(u.Extruder),
				ReportRevision:           u.ReportRevision,
				SlicerFilamentId:         nullableString(u.SlicerFilamentID),
				InputUnitExternalId:      nullableString(u.InputUnitExternalID),
				SlotExternalId:           nullableString(u.SlotExternalID),
				PlannedQuantityGrams:     nullableDecimalValue(u.PlannedQuantityGrams),
				PlannedLengthMillimeters: nullableDecimalValue(u.PlannedLengthMillimeters),
				EstimatedQuantityGrams:   nullableDecimalValue(u.EstimatedQuantityGrams),
				MaterialId:               nullableUUIDValue(u.MaterialID),
				SpoolId:                  nullableUUIDValue(u.SpoolID),
				Method:                   u.Method,
				CalculationVersion:       u.CalculationVersion,
				Quality:                  openapi.MachineRunReportedUsageItemQuality(u.Quality),
			},
		)
	}
	artifact := nullable.NewNullNullable[openapi.PrintArtifactReference]()
	if item.Artifact != nil {
		artifact = nullable.NewNullableWithValue(mlArtifactReferenceDTO(*item.Artifact))
	}
	return openapi.MachineRun{
		Id:          item.ID,
		DisplayId:   item.DisplayID,
		MachineId:   item.MachineID,
		MachineName: item.MachineName,
		Source:      openapi.MachineRunSource(item.Source),
		State:       openapi.MachineRunState(item.State),
		Job:         job,
		ConnectorName: nullableString(
			item.ConnectorName,
		),
		FileName:           nullableString(item.FileName),
		StartedAt:          item.StartedAt,
		EndedAt:            nullableValue(item.EndedAt),
		EstimatedEndAt:     nullableValue(item.EstimatedEndAt),
		DurationSeconds:    item.DurationSeconds,
		ProgressPercent:    nullableInt(item.ProgressPercent),
		Outcome:            outcome,
		OutcomeFromMachine: item.OutcomeFromMachine,
		Usages:             usages,
		Measures:           mlMeasuresDTO(item.Measures),
		UsagesFromMachine:  item.UsagesFromMachine,
		ReportedUsage:      reported,
		ReportedUsageItems: reportedItems,
		Artifact:           artifact,
		Version:            item.Version,
	}
}

func mlRunDTOs(items []machinelogbook.MachineRun) []openapi.MachineRun {
	result := make([]openapi.MachineRun, 0, len(items))
	for _, item := range items {
		result = append(result, mlRunBase(item))
	}
	return result
}

func mlRunDetailDTO(item machinelogbook.RunDetail) openapi.MachineRunDetail {
	base := mlRunBase(item.MachineRun)
	events := make([]openapi.MachineRunEvent, 0, len(item.Events))
	for _, e := range item.Events {
		events = append(
			events,
			openapi.MachineRunEvent{
				Id:              e.ID,
				Kind:            openapi.MachineRunEventKind(e.Kind),
				OccurredAt:      e.OccurredAt,
				State:           nullableString(e.State),
				ProgressPercent: nullableInt(e.ProgressPercent),
				Quantity:        nullableDecimalValue(e.Quantity),
			},
		)
	}
	return openapi.MachineRunDetail{
		Id:                 base.Id,
		DisplayId:          base.DisplayId,
		MachineId:          base.MachineId,
		MachineName:        base.MachineName,
		Source:             base.Source,
		State:              base.State,
		Job:                base.Job,
		ConnectorName:      base.ConnectorName,
		FileName:           base.FileName,
		StartedAt:          base.StartedAt,
		EndedAt:            base.EndedAt,
		EstimatedEndAt:     base.EstimatedEndAt,
		DurationSeconds:    base.DurationSeconds,
		ProgressPercent:    base.ProgressPercent,
		Outcome:            base.Outcome,
		OutcomeFromMachine: base.OutcomeFromMachine,
		Usages:             base.Usages,
		Measures:           base.Measures,
		UsagesFromMachine:  base.UsagesFromMachine,
		ReportedUsage:      base.ReportedUsage,
		ReportedUsageItems: base.ReportedUsageItems,
		Artifact:           base.Artifact,
		Version:            base.Version,
		Events:             events,
	}
}

func mlRunResultDTO(item machinelogbook.RunUpdateResult) openapi.MachineRunUpdateResult {
	result := openapi.MachineRunUpdateResult{
		Run: mlRunBase(item.Run),
		Job: nullable.NewNullNullable[openapi.MachineJob](),
	}
	if item.Job != nil {
		result.Job = nullable.NewNullableWithValue(mlJobDTO(*item.Job))
	}
	return result
}

func nullableInt(value *int) nullable.Nullable[int] {
	if value == nil {
		return nullable.NewNullNullable[int]()
	}
	return nullable.NewNullableWithValue(*value)
}

func mlUsageDTO(u machinelogbook.MachineJobUsage) openapi.MachineJobUsage {
	quality := nullable.NewNullNullable[openapi.MachineJobUsageEstimateQuality]()
	if u.EstimateQuality != nil {
		quality = nullable.NewNullableWithValue(openapi.MachineJobUsageEstimateQuality(*u.EstimateQuality))
	}
	return openapi.MachineJobUsage{
		Id:                 u.ID,
		MaterialId:         nullableUUIDValue(u.MaterialID),
		SpoolId:            nullableUUIDValue(u.SpoolID),
		SpoolDisplayId:     nullableString(u.SpoolDisplayID),
		FillNumber:         nullableInt32Value(u.FillNumber),
		Ownership:          openapi.FilamentOwnership(u.Ownership),
		MaterialName:       u.MaterialName,
		MaterialTypeId:     nullableUUIDValue(u.MaterialTypeID),
		MaterialTypeName:   u.MaterialTypeName,
		Unit:               openapi.MaterialUnit(u.Unit),
		Quantity:           u.Quantity,
		QuantityBasis:      openapi.QuantityBasis(u.QuantityBasis),
		EstimationMethod:   nullableString(u.EstimationMethod),
		CalculationVersion: nullableString(u.CalculationVersion),
		EstimateQuality:    quality,
		ReportRevision:     nullableValue(u.ReportRevision),
		StaffCorrected:     u.StaffCorrected,
	}
}

func bulkItems(values []openapi.BulkItem) []machinelogbook.BulkItem {
	items := make([]machinelogbook.BulkItem, 0, len(values))
	for _, v := range values {
		items = append(items, machinelogbook.BulkItem{ID: v.Id, ExpectedVersion: v.ExpectedVersion})
	}
	return items
}

func (s *Server) BulkDeleteMachineWork(
	ctx context.Context,
	r openapi.BulkDeleteMachineWorkRequestObject,
) (openapi.BulkDeleteMachineWorkResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	material := nullableStringPointer(r.Body.Material)
	input := machinelogbook.BulkDeleteInput{
		Jobs:               bulkItems(r.Body.Jobs),
		Runs:               bulkItems(r.Body.Runs),
		DeleteRecordedRuns: r.Body.DeleteRuns,
		ReverseConsumption: material != nil && *material == string(openapi.Reverse),
	}
	if err := s.machineLogbook.BulkDelete(ctx, p, input, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.BulkDeleteMachineWork204Response{}, nil
}

func (s *Server) BulkCreateMachineJobsFromRuns(
	ctx context.Context,
	r openapi.BulkCreateMachineJobsFromRunsRequestObject,
) (openapi.BulkCreateMachineJobsFromRunsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	created, err := s.machineLogbook.BulkCreateJobsFromRuns(
		ctx,
		p,
		machinelogbook.BulkRunJobInput{
			Runs:             bulkItems(r.Body.Runs),
			Customer:         partyInput(r.Body.Customer),
			OperatorPersonID: r.Body.OperatorPersonId,
			Notes:            nullableStringPointer(r.Body.Notes),
			PricingGroupID:   uuidNullable(r.Body.PricingGroupId),
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	response := openapi.BulkCreateMachineJobsFromRuns201JSONResponse{Jobs: make([]struct {
		DisplayId string                    `json:"displayId"`
		Id        openapi.UUIDv7            `json:"id"`
		Title     nullable.Nullable[string] `json:"title,omitempty"`
	}, 0, len(created))}
	for _, job := range created {
		response.Jobs = append(response.Jobs, struct {
			DisplayId string                    `json:"displayId"`
			Id        openapi.UUIDv7            `json:"id"`
			Title     nullable.Nullable[string] `json:"title,omitempty"`
		}{DisplayId: job.DisplayID, Id: job.ID, Title: nullableString(job.Title)})
	}
	return response, nil
}

func (s *Server) BulkCombineMachineRuns(
	ctx context.Context,
	r openapi.BulkCombineMachineRunsRequestObject,
) (openapi.BulkCombineMachineRunsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.BulkCombineRuns(
		ctx,
		p,
		machinelogbook.BulkRunJobInput{
			Runs:             bulkItems(r.Body.Runs),
			Title:            nullableStringPointer(r.Body.Title),
			Customer:         partyInput(r.Body.Customer),
			OperatorPersonID: r.Body.OperatorPersonId,
			Notes:            nullableStringPointer(r.Body.Notes),
			PricingGroupID:   uuidNullable(r.Body.PricingGroupId),
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.BulkCombineMachineRuns201JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) BulkAttachMachineRuns(
	ctx context.Context,
	r openapi.BulkAttachMachineRunsRequestObject,
) (openapi.BulkAttachMachineRunsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.BulkAttachRuns(
		ctx,
		p,
		machinelogbook.BulkAttachInput{
			JobID:              r.MachineJobId,
			ExpectedJobVersion: r.Body.ExpectedJobVersion,
			Runs:               bulkItems(r.Body.Runs),
			ReplaceManualRuns:  r.Body.ReplaceManualRuns,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.BulkAttachMachineRuns200JSONResponse(mlJobDTO(item)), nil
}
