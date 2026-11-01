package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func deletedJobDTO(item machinelogbook.DeletedJob) openapi.DeletedMachineJob {
	return openapi.DeletedMachineJob{
		Id:                   item.ID,
		DisplayId:            item.DisplayID,
		Title:                nullableString(item.Title),
		MachineId:            item.MachineID,
		MachineName:          item.MachineName,
		DeletedAt:            item.DeletedAt,
		DeletedByName:        nullableString(item.DeletedByName),
		DeletedRunCount:      item.DeletedRunCount,
		DetachedRunCount:     item.DetachedRunCount,
		HasInventoryBookings: item.HasInventoryBookings,
		Version:              item.Version,
	}
}

func deletedRunDTO(item machinelogbook.DeletedRun) openapi.DeletedMachineRun {
	return openapi.DeletedMachineRun{
		Id:                   item.ID,
		DisplayId:            item.DisplayID,
		FileName:             nullableString(item.FileName),
		Source:               openapi.MachineRunSource(item.Source),
		MachineId:            item.MachineID,
		MachineName:          item.MachineName,
		DeletedAt:            item.DeletedAt,
		DeletedByName:        nullableString(item.DeletedByName),
		FormerJobId:          nullableUUIDValue(item.FormerJobID),
		FormerJobDisplayId:   nullableString(item.FormerJobDisplayID),
		FormerJobInBin:       item.FormerJobInBin,
		HasInventoryBookings: item.HasInventoryBookings,
		Version:              item.Version,
	}
}

func (s *Server) GetRecycleBin(ctx context.Context, _ openapi.GetRecycleBinRequestObject) (openapi.GetRecycleBinResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	bin, err := s.machineLogbook.RecycleBin(ctx, p)
	if err != nil {
		return nil, err
	}
	jobs := make([]openapi.DeletedMachineJob, 0, len(bin.Jobs))
	for _, item := range bin.Jobs {
		jobs = append(jobs, deletedJobDTO(item))
	}
	runs := make([]openapi.DeletedMachineRun, 0, len(bin.Runs))
	for _, item := range bin.Runs {
		runs = append(runs, deletedRunDTO(item))
	}
	return openapi.GetRecycleBin200JSONResponse{Jobs: jobs, Runs: runs}, nil
}

func (s *Server) RestoreMachineJob(ctx context.Context, r openapi.RestoreMachineJobRequestObject) (openapi.RestoreMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	job, err := s.machineLogbook.RestoreJob(ctx, p, r.MachineJobId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RestoreMachineJob200JSONResponse(mlJobDTO(job)), nil
}

func (s *Server) RestoreMachineRun(ctx context.Context, r openapi.RestoreMachineRunRequestObject) (openapi.RestoreMachineRunResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	run, err := s.machineLogbook.RestoreRun(ctx, p, r.RunId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RestoreMachineRun200JSONResponse(mlRunBase(run)), nil
}

func (s *Server) PurgeMachineJob(ctx context.Context, r openapi.PurgeMachineJobRequestObject) (openapi.PurgeMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.machineLogbook.PurgeJob(ctx, p, r.MachineJobId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.PurgeMachineJob204Response{}, nil
}

func (s *Server) PurgeMachineRun(ctx context.Context, r openapi.PurgeMachineRunRequestObject) (openapi.PurgeMachineRunResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.machineLogbook.PurgeRun(ctx, p, r.RunId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.PurgeMachineRun204Response{}, nil
}
