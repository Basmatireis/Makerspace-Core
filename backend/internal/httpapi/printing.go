package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
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
