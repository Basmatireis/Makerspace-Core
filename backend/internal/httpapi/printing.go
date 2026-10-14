package httpapi

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

func inputUnitDTO(v printing.InputUnit) openapi.PrinterInputUnit {
	return openapi.PrinterInputUnit{Id: v.ID, MachineId: v.MachineID, Name: v.Name, Position: v.Position, Nozzle: nullableEnum[openapi.PrinterNozzle](v.Nozzle), ExternalIdentifier: nullableString(v.ExternalIdentifier), Enabled: v.Enabled, Version: v.Version}
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
	return openapi.PrinterProfile{MachineId: v.MachineID, MachineName: v.MachineName, Enabled: v.Enabled, Model: nullableEnum[openapi.PrinterModel](v.Model), InputUnits: units, Slots: slots, Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func nullableEnum[T ~string](value *string) nullable.Nullable[T] {
	if value == nil {
		return nullable.NewNullNullable[T]()
	}
	return nullable.NewNullableWithValue(T(*value))
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
func (s *Server) UpdatePrinterInputUnit(ctx context.Context, r openapi.UpdatePrinterInputUnitRequestObject) (openapi.UpdatePrinterInputUnitResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.printing.UpdateInputUnit(ctx, p, r.InputUnitId, r.Body.Name, r.Body.Position, nullableStringPointer(r.Body.ExternalIdentifier), r.Body.Enabled, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.UpdatePrinterInputUnit200JSONResponse(inputUnitDTO(item)), nil
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
func (s *Server) UpdatePrinterSlot(ctx context.Context, r openapi.UpdatePrinterSlotRequestObject) (openapi.UpdatePrinterSlotResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.printing.UpdateSlot(ctx, p, r.SlotId, r.Body.Name, r.Body.Position, string(r.Body.Status), nullableStringPointer(r.Body.ExternalIdentifier), r.Body.ExpectedVersion, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.UpdatePrinterSlot200JSONResponse(slotDTO(item)), nil
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

func setupUUID(value nullable.Nullable[openapi.UUIDv7]) *uuid.UUID {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	result := uuid.UUID(value.GetOrEmpty())
	return &result
}

func (s *Server) SavePrinterSetup(ctx context.Context, r openapi.SavePrinterSetupRequestObject) (openapi.SavePrinterSetupResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := printing.SetupInput{Enabled: r.Body.Enabled, Model: nullableStringPointer(r.Body.Model), InputUnits: make([]printing.SetupUnitInput, 0, len(r.Body.InputUnits))}
	if expected := nullableInt64Pointer(r.Body.ExpectedVersion); expected != nil {
		input.ExpectedVersion = *expected
	}
	for _, unit := range r.Body.InputUnits {
		item := printing.SetupUnitInput{ID: setupUUID(unit.Id), Name: unit.Name, Nozzle: nullableStringPointer(unit.Nozzle), ExternalIdentifier: nullableStringPointer(unit.ExternalIdentifier), Slots: make([]printing.SetupSlotInput, 0, len(unit.Slots))}
		for _, slot := range unit.Slots {
			item.Slots = append(item.Slots, printing.SetupSlotInput{ID: setupUUID(slot.Id), Name: slot.Name, Status: string(slot.Status), ExternalIdentifier: nullableStringPointer(slot.ExternalIdentifier)})
		}
		input.InputUnits = append(input.InputUnits, item)
	}
	item, e := s.printing.SaveSetup(ctx, p, r.MachineId, input, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.SavePrinterSetup200JSONResponse(profileDTO(item)), nil
}

func (s *Server) GetPrinterLiveStatus(ctx context.Context, r openapi.GetPrinterLiveStatusRequestObject) (openapi.GetPrinterLiveStatusResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	item, e := s.printerConnectors.LiveStatus(ctx, p, r.MachineId)
	if e != nil {
		return nil, e
	}
	var snapshot openapi.PrinterLiveStatusSnapshot
	if json.Unmarshal(item.Snapshot, &snapshot) != nil {
		return nil, errors.New("stored live status snapshot is invalid")
	}
	return openapi.GetPrinterLiveStatus200JSONResponse{MachineId: item.MachineID, AssignmentId: item.AssignmentID, ReceivedAt: item.ReceivedAt, ObservedAt: item.ObservedAt, Status: snapshot}, nil
}
