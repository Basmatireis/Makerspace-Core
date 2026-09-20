package httpapi

import (
	"context"
	"encoding/json"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) ListMachineTypes(ctx context.Context, _ openapi.ListMachineTypesRequestObject) (openapi.ListMachineTypesResponseObject, error) {
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
func (s *Server) CreateMachineType(ctx context.Context, r openapi.CreateMachineTypeRequestObject) (openapi.CreateMachineTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateMachineType(ctx, p, r.Body.Name, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachineType201JSONResponse(mlMachineTypeDTO(item)), nil
}
func (s *Server) UpdateMachineType(ctx context.Context, r openapi.UpdateMachineTypeRequestObject) (openapi.UpdateMachineTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateMachineType(ctx, p, r.MachineTypeId, r.Body.ExpectedVersion, r.Body.Name, r.Body.Active, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachineType200JSONResponse(mlMachineTypeDTO(item)), nil
}
func (s *Server) ListMachines(ctx context.Context, r openapi.ListMachinesRequestObject) (openapi.ListMachinesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListMachines(ctx, p, defaultString(r.Params.Search), stringEnum(r.Params.Status), defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Machine, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMachineDTO(item))
	}
	return openapi.ListMachines200JSONResponse{Items: dto, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25), Total: total}, nil
}
func (s *Server) CreateMachine(ctx context.Context, r openapi.CreateMachineRequestObject) (openapi.CreateMachineResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateMachine(ctx, p, r.Body.MachineTypeId, r.Body.Name, string(r.Body.Status), nullableStringPointer(r.Body.ExternalIdentifier), r.Body.AutomaticCollectionEnabled, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachine201JSONResponse(mlMachineDTO(item)), nil
}
func (s *Server) GetMachine(ctx context.Context, r openapi.GetMachineRequestObject) (openapi.GetMachineResponseObject, error) {
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
func (s *Server) UpdateMachine(ctx context.Context, r openapi.UpdateMachineRequestObject) (openapi.UpdateMachineResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateMachine(ctx, p, r.MachineId, r.Body.ExpectedVersion, r.Body.MachineTypeId, r.Body.Name, string(r.Body.Status), nullableStringPointer(r.Body.ExternalIdentifier), r.Body.AutomaticCollectionEnabled, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachine200JSONResponse(mlMachineDTO(item)), nil
}

func (s *Server) ListOrganizations(ctx context.Context, r openapi.ListOrganizationsRequestObject) (openapi.ListOrganizationsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListOrganizations(ctx, p, defaultString(r.Params.Search), r.Params.Active, defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Organization, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlOrganizationDTO(item))
	}
	return openapi.ListOrganizations200JSONResponse{Items: dto, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25), Total: total}, nil
}
func (s *Server) CreateOrganization(ctx context.Context, r openapi.CreateOrganizationRequestObject) (openapi.CreateOrganizationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateOrganization(ctx, p, r.Body.Name, string(r.Body.Kind), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateOrganization201JSONResponse(mlOrganizationDTO(item)), nil
}
func (s *Server) UpdateOrganization(ctx context.Context, r openapi.UpdateOrganizationRequestObject) (openapi.UpdateOrganizationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateOrganization(ctx, p, r.OrganizationId, r.Body.ExpectedVersion, r.Body.Name, string(r.Body.Kind), r.Body.Active, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOrganization200JSONResponse(mlOrganizationDTO(item)), nil
}
func (s *Server) SearchBillingParties(ctx context.Context, r openapi.SearchBillingPartiesRequestObject) (openapi.SearchBillingPartiesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.SearchBillingParties(ctx, p, defaultString(r.Params.Search), defaultInt(r.Params.Limit, 20))
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.BillingParty, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlBillingPartyDTO(item))
	}
	return openapi.SearchBillingParties200JSONResponse{Items: dto}, nil
}
func (s *Server) SearchMachineJobOperators(ctx context.Context, r openapi.SearchMachineJobOperatorsRequestObject) (openapi.SearchMachineJobOperatorsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.SearchOperators(ctx, p, defaultString(r.Params.Search), defaultInt(r.Params.Limit, 20))
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Operator, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlOperatorDTO(item))
	}
	return openapi.SearchMachineJobOperators200JSONResponse{Items: dto}, nil
}

func (s *Server) ListPricingGroups(ctx context.Context, _ openapi.ListPricingGroupsRequestObject) (openapi.ListPricingGroupsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.ListPricingGroups(ctx, p)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.PricingGroup, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlPricingGroupDTO(item))
	}
	return openapi.ListPricingGroups200JSONResponse{Items: dto}, nil
}
func (s *Server) CreatePricingGroup(ctx context.Context, r openapi.CreatePricingGroupRequestObject) (openapi.CreatePricingGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreatePricingGroup(ctx, p, r.Body.Name, nullableStringPointer(r.Body.Description), r.Body.IsDefault, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreatePricingGroup201JSONResponse(mlPricingGroupDTO(item)), nil
}
func (s *Server) UpdatePricingGroup(ctx context.Context, r openapi.UpdatePricingGroupRequestObject) (openapi.UpdatePricingGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdatePricingGroup(ctx, p, r.PricingGroupId, r.Body.ExpectedVersion, r.Body.Name, nullableStringPointer(r.Body.Description), r.Body.Active, r.Body.IsDefault, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdatePricingGroup200JSONResponse(mlPricingGroupDTO(item)), nil
}
func (s *Server) CreatePricingRule(ctx context.Context, r openapi.CreatePricingRuleRequestObject) (openapi.CreatePricingRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreatePricingRule(ctx, p, r.PricingGroupId, string(r.Body.Kind), uuidNullable(r.Body.MachineTypeId), nullableStringPointer(r.Body.MaterialCategory), materialUnitNullable(r.Body.MaterialUnit), string(r.Body.Rate), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreatePricingRule201JSONResponse(mlPricingRuleDTO(item)), nil
}
func (s *Server) UpdatePricingRule(ctx context.Context, r openapi.UpdatePricingRuleRequestObject) (openapi.UpdatePricingRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdatePricingRule(ctx, p, r.PricingRuleId, r.Body.ExpectedVersion, string(r.Body.Kind), uuidNullable(r.Body.MachineTypeId), nullableStringPointer(r.Body.MaterialCategory), materialUnitNullable(r.Body.MaterialUnit), string(r.Body.Rate), r.Body.Active, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdatePricingRule200JSONResponse(mlPricingRuleDTO(item)), nil
}
func (s *Server) SetBillingPartyPricingGroup(ctx context.Context, r openapi.SetBillingPartyPricingGroupRequestObject) (openapi.SetBillingPartyPricingGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	_, err = s.machineLogbook.SetPartyPricingGroup(ctx, p, partyInput(r.Body.Party), uuidNullable(r.Body.PricingGroupId), r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetBillingPartyPricingGroup204Response{}, nil
}

func (s *Server) ListMaterials(ctx context.Context, r openapi.ListMaterialsRequestObject) (openapi.ListMaterialsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, value, err := s.machineLogbook.ListMaterials(ctx, p, defaultString(r.Params.Search), defaultString(r.Params.Category), valueString(r.Params.StockState), defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Material, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMaterialDTO(item))
	}
	return openapi.ListMaterials200JSONResponse{Items: dto, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25), Total: total, TotalInventoryValue: value}, nil
}
func (s *Server) CreateMaterial(ctx context.Context, r openapi.CreateMaterialRequestObject) (openapi.CreateMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateMaterial(ctx, p, r.Body.Name, r.Body.Category, nullableStringPointer(r.Body.Color), string(r.Body.Unit), decimalNullable(r.Body.LowStockThreshold), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateMaterial201JSONResponse(mlMaterialDTO(item)), nil
}
func (s *Server) GetMaterial(ctx context.Context, r openapi.GetMaterialRequestObject) (openapi.GetMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetMaterial(ctx, p, r.MaterialId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMaterial200JSONResponse(mlMaterialDTO(item)), nil
}
func (s *Server) UpdateMaterial(ctx context.Context, r openapi.UpdateMaterialRequestObject) (openapi.UpdateMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateMaterial(ctx, p, r.MaterialId, r.Body.ExpectedVersion, r.Body.Name, r.Body.Category, nullableStringPointer(r.Body.Color), string(r.Body.Unit), r.Body.Active, decimalNullable(r.Body.LowStockThreshold), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMaterial200JSONResponse(mlMaterialDTO(item)), nil
}
func (s *Server) AddMaterialPurchase(ctx context.Context, r openapi.AddMaterialPurchaseRequestObject) (openapi.AddMaterialPurchaseResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.AddPurchase(ctx, p, r.MaterialId, r.Body.ExpectedInventoryVersion, string(r.Body.Quantity), string(r.Body.TotalPrice), r.Body.OccurredAt, nullableStringPointer(r.Body.Supplier), nullableStringPointer(r.Body.Note), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.AddMaterialPurchase201JSONResponse(mlInventoryResultDTO(item)), nil
}
func (s *Server) RecordMaterialConsumption(ctx context.Context, r openapi.RecordMaterialConsumptionRequestObject) (openapi.RecordMaterialConsumptionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.RecordConsumption(ctx, p, r.MaterialId, r.Body.ExpectedInventoryVersion, string(r.Body.Quantity), r.Body.OccurredAt, r.Body.Disposal, nullableStringPointer(r.Body.Reason), nullableStringPointer(r.Body.Note), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RecordMaterialConsumption201JSONResponse(mlInventoryResultDTO(item)), nil
}
func (s *Server) CorrectMaterialStock(ctx context.Context, r openapi.CorrectMaterialStockRequestObject) (openapi.CorrectMaterialStockResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CorrectStock(ctx, p, r.MaterialId, r.Body.ExpectedInventoryVersion, string(r.Body.PhysicalQuantity), decimalNullable(r.Body.AcquisitionUnitCost), r.Body.OccurredAt, string(r.Body.Reason), nullableStringPointer(r.Body.Note), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CorrectMaterialStock201JSONResponse(mlInventoryResultDTO(item)), nil
}
func (s *Server) MarkMaterialEmpty(ctx context.Context, r openapi.MarkMaterialEmptyRequestObject) (openapi.MarkMaterialEmptyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.MarkEmpty(ctx, p, r.MaterialId, r.Body.ExpectedInventoryVersion, r.Body.OccurredAt, nullableStringPointer(r.Body.Note), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.MarkMaterialEmpty201JSONResponse(mlInventoryResultDTO(item)), nil
}
func (s *Server) ListMaterialTransactions(ctx context.Context, r openapi.ListMaterialTransactionsRequestObject) (openapi.ListMaterialTransactionsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListMaterialTransactions(ctx, p, r.MaterialId, defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.InventoryTransaction, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlInventoryTransactionDTO(item))
	}
	return openapi.ListMaterialTransactions200JSONResponse{Items: dto, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25), Total: total}, nil
}

func (s *Server) ListMachineJobs(ctx context.Context, r openapi.ListMachineJobsRequestObject) (openapi.ListMachineJobsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListJobs(ctx, p, machinelogbook.JobFilters{Search: defaultString(r.Params.Search), MachineID: r.Params.MachineId, CustomerID: r.Params.CustomerId, OperatorID: r.Params.OperatorPersonId, MaterialID: r.Params.MaterialId, Outcome: stringEnum(r.Params.Outcome), BillingStatus: stringEnum(r.Params.BillingStatus), Source: stringEnum(r.Params.Source), ReviewState: stringEnum(r.Params.ReviewState), From: r.Params.From, To: r.Params.To, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25)})
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.MachineJob, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlJobDTO(item))
	}
	return openapi.ListMachineJobs200JSONResponse{Items: dto, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25), Total: total}, nil
}
func (s *Server) CreateMachineJob(ctx context.Context, r openapi.CreateMachineJobRequestObject) (openapi.CreateMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateManualJob(ctx, p, machinelogbook.JobInput{MachineID: r.Body.MachineId, StartsAt: r.Body.StartsAt, EndsAt: r.Body.EndsAt, Customer: partyInput(r.Body.Customer), OperatorPersonID: r.Body.OperatorPersonId, Outcome: string(r.Body.Outcome), Notes: nullableStringPointer(r.Body.Notes), PricingGroupID: uuidNullable(r.Body.PricingGroupId), Usages: usageInputs(r.Body.Usages)}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachineJob201JSONResponse(mlJobDTO(item)), nil
}
func (s *Server) IngestAutomaticMachineJob(ctx context.Context, r openapi.IngestAutomaticMachineJobRequestObject) (openapi.IngestAutomaticMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	metadata := []byte("{}")
	if r.Body.ExternalMetadata != nil {
		metadata, err = json.Marshal(*r.Body.ExternalMetadata)
		if err != nil {
			return nil, invalidRequest("externalMetadata is invalid")
		}
	}
	item, created, err := s.machineLogbook.IngestAutomaticJob(ctx, p, machinelogbook.AutomaticJobInput{MachineID: r.Body.MachineId, StartsAt: r.Body.StartsAt, EndsAt: r.Body.EndsAt, ExternalID: r.Body.ExternalId, ExternalMetadata: metadata, Usages: usageInputs(r.Body.Usages)}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	if created {
		return openapi.IngestAutomaticMachineJob201JSONResponse(mlJobDTO(item)), nil
	}
	return openapi.IngestAutomaticMachineJob200JSONResponse(mlJobDTO(item)), nil
}
func (s *Server) ListMachineJobReviewQueue(ctx context.Context, _ openapi.ListMachineJobReviewQueueRequestObject) (openapi.ListMachineJobReviewQueueResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.ReviewQueue(ctx, p)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.MachineJob, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlJobDTO(item))
	}
	return openapi.ListMachineJobReviewQueue200JSONResponse{Items: dto}, nil
}
func (s *Server) GetMachineJob(ctx context.Context, r openapi.GetMachineJobRequestObject) (openapi.GetMachineJobResponseObject, error) {
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
func (s *Server) UpdateMachineJob(ctx context.Context, r openapi.UpdateMachineJobRequestObject) (openapi.UpdateMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateJobFacts(ctx, p, r.MachineJobId, r.Body.ExpectedVersion, machinelogbook.JobInput{MachineID: r.Body.MachineId, StartsAt: r.Body.StartsAt, EndsAt: r.Body.EndsAt, Customer: partyInput(r.Body.Customer), OperatorPersonID: r.Body.OperatorPersonId, Outcome: string(r.Body.Outcome), Notes: nullableStringPointer(r.Body.Notes), PricingGroupID: uuidNullable(r.Body.PricingGroupId)}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachineJob200JSONResponse(mlJobDTO(item)), nil
}
func (s *Server) ConfirmMachineJob(ctx context.Context, r openapi.ConfirmMachineJobRequestObject) (openapi.ConfirmMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.ConfirmJob(ctx, p, r.MachineJobId, r.Body.ExpectedVersion, partyInput(r.Body.Customer), r.Body.OperatorPersonId, string(r.Body.Outcome), nullableStringPointer(r.Body.Notes), uuidNullable(r.Body.PricingGroupId), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ConfirmMachineJob200JSONResponse(mlJobDTO(item)), nil
}
func (s *Server) ReplaceMachineJobUsages(ctx context.Context, r openapi.ReplaceMachineJobUsagesRequestObject) (openapi.ReplaceMachineJobUsagesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.ReplaceJobUsages(ctx, p, r.MachineJobId, r.Body.ExpectedVersion, usageInputs(r.Body.Usages), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReplaceMachineJobUsages200JSONResponse(mlJobDTO(item)), nil
}
func (s *Server) OverrideMachineJobPrice(ctx context.Context, r openapi.OverrideMachineJobPriceRequestObject) (openapi.OverrideMachineJobPriceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.OverrideJobPrice(ctx, p, r.MachineJobId, r.Body.ExpectedVersion, string(r.Body.FinalPrice), r.Body.Reason, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.OverrideMachineJobPrice200JSONResponse(mlJobDTO(item)), nil
}
func (s *Server) ClearMachineJobPriceOverride(ctx context.Context, r openapi.ClearMachineJobPriceOverrideRequestObject) (openapi.ClearMachineJobPriceOverrideResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.ClearJobPriceOverride(ctx, p, r.MachineJobId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ClearMachineJobPriceOverride200JSONResponse(mlJobDTO(item)), nil
}
func (s *Server) UpdateMachineJobBilling(ctx context.Context, r openapi.UpdateMachineJobBillingRequestObject) (openapi.UpdateMachineJobBillingResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateJobBilling(ctx, p, r.MachineJobId, r.Body.ExpectedVersion, string(r.Body.Status), nullableStringPointer(r.Body.BillingReference), nullableStringPointer(r.Body.WaiverReason), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachineJobBilling200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) GetMachineLogbookOverview(ctx context.Context, _ openapi.GetMachineLogbookOverviewRequestObject) (openapi.GetMachineLogbookOverviewResponseObject, error) {
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
func (s *Server) GetMachineLogbookStatistics(ctx context.Context, r openapi.GetMachineLogbookStatisticsRequestObject) (openapi.GetMachineLogbookStatisticsResponseObject, error) {
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
