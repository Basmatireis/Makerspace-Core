package httpapi

import (
	"context"
	"encoding/json"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

func inputUnitDTO(v printing.InputUnit) openapi.PrinterInputUnit {
	return openapi.PrinterInputUnit{Id: v.ID, MachineId: v.MachineID, Name: v.Name, Position: v.Position, ExternalIdentifier: nullableString(v.ExternalIdentifier), Enabled: v.Enabled, Version: v.Version}
}
func slotDTO(v printing.Slot) openapi.PrinterSlot {
	return openapi.PrinterSlot{Id: v.ID, InputUnitId: v.InputUnitID, InputUnitName: v.InputUnitName, MachineId: v.MachineID, Name: v.Name, Position: v.Position, ExternalIdentifier: nullableString(v.ExternalIdentifier), Status: openapi.PrinterSlotStatus(v.Status), AssignmentId: nullableUUIDValue(v.AssignmentID), SpoolId: nullableUUIDValue(v.SpoolID), SpoolDisplayId: nullableString(v.SpoolDisplayID), MountedAt: nullableValue(v.MountedAt), Version: v.Version}
}
func profileDTO(v printing.Profile) openapi.PrinterProfile {
	units := make([]openapi.PrinterInputUnit, 0, len(v.InputUnits))
	for _, x := range v.InputUnits {
		units = append(units, inputUnitDTO(x))
	}
	slots := make([]openapi.PrinterSlot, 0, len(v.Slots))
	for _, x := range v.Slots {
		slots = append(slots, slotDTO(x))
	}
	return openapi.PrinterProfile{MachineId: v.MachineID, MachineName: v.MachineName, Enabled: v.Enabled, InputUnits: units, Slots: slots, Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func declarationInput(v openapi.FilamentDeclarationInput) printing.DeclarationInput {
	return printing.DeclarationInput{Ownership: string(v.Ownership), MaterialID: uuidNullable(v.MaterialId), SpoolID: uuidNullable(v.SpoolId), ExternalMaterialName: nullableStringPointer(v.ExternalMaterialName), EstimatedQuantityG: decimalNullable(v.EstimatedQuantityG)}
}
func declarationDTO(v printing.Declaration) openapi.FilamentDeclaration {
	return openapi.FilamentDeclaration{Ownership: openapi.FilamentOwnership(v.Ownership), MaterialId: nullableUUIDValue(v.MaterialID), SpoolId: nullableUUIDValue(v.SpoolID), ExternalMaterialName: nullableString(v.ExternalMaterialName), EstimatedQuantityG: nullableDecimalValue(v.EstimatedQuantityG), Id: v.ID, MaterialName: v.MaterialName, SpoolDisplayId: nullableString(v.SpoolDisplayID)}
}
func printerEventDTO(v printing.PrinterEvent) openapi.PrinterEvent {
	payload := map[string]interface{}{}
	_ = json.Unmarshal(v.Payload, &payload)
	return openapi.PrinterEvent{Id: v.ID, SourceId: v.SourceID, EventKey: v.EventKey, ProtocolVersion: v.ProtocolVersion, Kind: openapi.PrinterEventKind(v.Kind), OccurredAt: v.OccurredAt, ReceivedAt: v.ReceivedAt, Payload: payload, ReconciliationState: openapi.PrinterEventReconciliationState(v.ReconciliationState)}
}
func attemptDTO(v printing.Attempt) openapi.PrintAttempt {
	d := make([]openapi.FilamentDeclaration, 0, len(v.Declarations))
	for _, x := range v.Declarations {
		d = append(d, declarationDTO(x))
	}
	events := make([]openapi.PrinterEvent, 0, len(v.Events))
	for _, x := range v.Events {
		events = append(events, printerEventDTO(x))
	}
	return openapi.PrintAttempt{Id: v.ID, SubmissionId: v.SubmissionID, AttemptNumber: v.AttemptNumber, MachineId: v.MachineID, MachineName: v.MachineName, State: openapi.PrintAttemptState(v.State), MachineJobId: nullableUUIDValue(v.MachineJobID), AcceptedAt: nullableValue(v.AcceptedAt), StartedAt: nullableValue(v.StartedAt), EndedAt: nullableValue(v.EndedAt), Declarations: d, Events: events, Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func submissionDTO(v printing.Submission) openapi.PrintSubmission {
	d := make([]openapi.FilamentDeclaration, 0, len(v.Declarations))
	for _, x := range v.Declarations {
		d = append(d, declarationDTO(x))
	}
	a := make([]openapi.PrintAttempt, 0, len(v.Attempts))
	for _, x := range v.Attempts {
		a = append(a, attemptDTO(x))
	}
	customer := nullable.NewNullNullable[openapi.BillingPartyReference]()
	if v.Customer.ID != uuid.Nil {
		customer = nullable.NewNullableWithValue(openapi.BillingPartyReference{Kind: openapi.BillingPartyKind(v.Customer.Kind), Id: v.Customer.ID})
	}
	return openapi.PrintSubmission{Id: v.ID, DisplayId: v.DisplayID, MachineId: v.MachineID, MachineName: v.MachineName, Customer: customer, Title: v.Title, Notes: nullableString(v.Notes), State: openapi.PrintSubmissionState(v.State), ReprintsSubmissionId: nullableUUIDValue(v.ReprintsSubmissionID), Declarations: d, Attempts: a, Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}

func (s *Server) GetPrinterProfile(ctx context.Context, r openapi.GetPrinterProfileRequestObject) (openapi.GetPrinterProfileResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	item, e := s.printing.GetProfile(ctx, p, r.MachineId)
	if e != nil {
		return nil, e
	}
	return openapi.GetPrinterProfile200JSONResponse(profileDTO(item)), nil
}
func (s *Server) ConfigurePrinterProfile(ctx context.Context, r openapi.ConfigurePrinterProfileRequestObject) (openapi.ConfigurePrinterProfileResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.printing.ConfigureProfile(ctx, p, r.MachineId, r.Body.Enabled, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.ConfigurePrinterProfile200JSONResponse(profileDTO(item)), nil
}
func (s *Server) CreatePrinterInputUnit(ctx context.Context, r openapi.CreatePrinterInputUnitRequestObject) (openapi.CreatePrinterInputUnitResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.printing.CreateInputUnit(ctx, p, r.MachineId, r.Body.Name, r.Body.Position, nullableStringPointer(r.Body.ExternalIdentifier), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.CreatePrinterInputUnit201JSONResponse(inputUnitDTO(item)), nil
}
func (s *Server) CreatePrinterSlot(ctx context.Context, r openapi.CreatePrinterSlotRequestObject) (openapi.CreatePrinterSlotResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.printing.CreateSlot(ctx, p, r.InputUnitId, r.Body.Name, r.Body.Position, string(r.Body.Status), nullableStringPointer(r.Body.ExternalIdentifier), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.CreatePrinterSlot201JSONResponse(slotDTO(item)), nil
}
func (s *Server) MountPrinterSpool(ctx context.Context, r openapi.MountPrinterSpoolRequestObject) (openapi.MountPrinterSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.printing.Mount(ctx, p, r.SlotId, r.Body.SpoolId, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.MountPrinterSpool200JSONResponse(slotDTO(item)), nil
}
func (s *Server) UnmountPrinterSpool(ctx context.Context, r openapi.UnmountPrinterSpoolRequestObject) (openapi.UnmountPrinterSpoolResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	item, e := s.printing.Unmount(ctx, p, r.SlotId, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.UnmountPrinterSpool200JSONResponse(slotDTO(item)), nil
}
func (s *Server) CreatePrintSubmission(ctx context.Context, r openapi.CreatePrintSubmissionRequestObject) (openapi.CreatePrintSubmissionResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	customer := machinelogbook.PartyReference{}
	if !r.Body.Customer.IsNull() && r.Body.Customer.IsSpecified() {
		customer = partyInput(r.Body.Customer.GetOrEmpty())
	}
	decls := make([]printing.DeclarationInput, 0, len(r.Body.Declarations))
	for _, x := range r.Body.Declarations {
		decls = append(decls, declarationInput(x))
	}
	item, e := s.printing.CreateSubmission(ctx, p, printing.SubmissionInput{MachineID: r.Body.MachineId, Customer: customer, Title: r.Body.Title, Notes: nullableStringPointer(r.Body.Notes), ReprintsSubmissionID: uuidNullable(r.Body.ReprintsSubmissionId), Declarations: decls}, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.CreatePrintSubmission201JSONResponse(submissionDTO(item)), nil
}
func (s *Server) GetPrintSubmission(ctx context.Context, r openapi.GetPrintSubmissionRequestObject) (openapi.GetPrintSubmissionResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	item, e := s.printing.GetSubmission(ctx, p, r.SubmissionId)
	if e != nil {
		return nil, e
	}
	return openapi.GetPrintSubmission200JSONResponse(submissionDTO(item)), nil
}
func (s *Server) ListPrintSubmissions(ctx context.Context, r openapi.ListPrintSubmissionsRequestObject) (openapi.ListPrintSubmissionsResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	items, total, e := s.printing.ListSubmissions(ctx, p, defaultString(r.Params.Search), valueString(r.Params.State), r.Params.MachineId, defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25))
	if e != nil {
		return nil, e
	}
	dto := make([]openapi.PrintSubmission, 0, len(items))
	for _, x := range items {
		dto = append(dto, submissionDTO(x))
	}
	return openapi.ListPrintSubmissions200JSONResponse{Items: dto, Page: defaultInt(r.Params.Page, 1), PageSize: defaultInt(r.Params.PageSize, 25), Total: total}, nil
}
func (s *Server) CreatePrintAttempt(ctx context.Context, r openapi.CreatePrintAttemptRequestObject) (openapi.CreatePrintAttemptResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, created, e := s.printing.CreateAttempt(ctx, p, r.SubmissionId, r.Body.MachineId, r.Body.OperationKey, r.Body.ExpectedSubmissionVersion, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	if created {
		return openapi.CreatePrintAttempt201JSONResponse(attemptDTO(item)), nil
	}
	return openapi.CreatePrintAttempt200JSONResponse(attemptDTO(item)), nil
}
func (s *Server) TransitionPrintAttempt(ctx context.Context, r openapi.TransitionPrintAttemptRequestObject) (openapi.TransitionPrintAttemptResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.printing.TransitionAttempt(ctx, p, r.AttemptId, string(r.Body.State), r.Body.ExpectedVersion, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.TransitionPrintAttempt200JSONResponse(attemptDTO(item)), nil
}
func (s *Server) LinkPrintAttemptJob(ctx context.Context, r openapi.LinkPrintAttemptJobRequestObject) (openapi.LinkPrintAttemptJobResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.printing.LinkAttemptJob(ctx, p, r.AttemptId, r.Body.MachineJobId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.LinkPrintAttemptJob200JSONResponse(attemptDTO(item)), nil
}
func (s *Server) ReconcilePrinterEvent(ctx context.Context, r openapi.ReconcilePrinterEventRequestObject) (openapi.ReconcilePrinterEventResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	var expected *int64
	if r.Body.ExpectedJobVersion.IsSpecified() && !r.Body.ExpectedJobVersion.IsNull() {
		v := r.Body.ExpectedJobVersion.GetOrEmpty()
		expected = &v
	}
	rawUsages := []openapi.MachineJobUsageInput{}
	if r.Body.Usages != nil {
		rawUsages = *r.Body.Usages
	}
	e = s.printing.ReconcileEvent(ctx, p, r.EventId, string(r.Body.Decision), r.Body.OperationKey, uuidNullable(r.Body.MachineJobId), expected, usageInputs(rawUsages), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.ReconcilePrinterEvent204Response{}, nil
}
