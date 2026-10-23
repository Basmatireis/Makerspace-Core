package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/trainings"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) ListCompetencyCategories(
	ctx context.Context,
	_ openapi.ListCompetencyCategoriesRequestObject,
) (openapi.ListCompetencyCategoriesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.trainings.ListCompetencyCategories(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.CompetencyCategory, 0, len(items))
	for _, item := range items {
		out = append(out, competencyCategoryDTO(item))
	}
	return openapi.ListCompetencyCategories200JSONResponse{Items: out}, nil
}

func (s *Server) CreateCompetencyCategory(
	ctx context.Context,
	r openapi.CreateCompetencyCategoryRequestObject,
) (openapi.CreateCompetencyCategoryResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.trainings.CreateCompetencyCategory(ctx, p, trainings.CompetencyCategoryInput{
		Name:        r.Body.Name,
		Description: nullableStringPointer(r.Body.Description),
		Active:      r.Body.Active,
		SortOrder:   r.Body.SortOrder,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateCompetencyCategory201JSONResponse(competencyCategoryDTO(item)), nil
}

func (s *Server) UpdateCompetencyCategory(
	ctx context.Context,
	r openapi.UpdateCompetencyCategoryRequestObject,
) (openapi.UpdateCompetencyCategoryResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.trainings.UpdateCompetencyCategory(ctx, p, r.CompetencyCategoryId, r.Body.ExpectedVersion,
		trainings.CompetencyCategoryInput{
			Name:        r.Body.Name,
			Description: nullableStringPointer(r.Body.Description),
			Active:      r.Body.Active,
			SortOrder:   r.Body.SortOrder,
		}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateCompetencyCategory200JSONResponse(competencyCategoryDTO(item)), nil
}

func (s *Server) DeleteCompetencyCategory(
	ctx context.Context,
	r openapi.DeleteCompetencyCategoryRequestObject,
) (openapi.DeleteCompetencyCategoryResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.trainings.DeleteCompetencyCategory(
		ctx, p, r.CompetencyCategoryId, r.Body.ExpectedVersion, requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteCompetencyCategory204Response{}, nil
}

func (s *Server) ListTrainings(
	ctx context.Context,
	_ openapi.ListTrainingsRequestObject,
) (openapi.ListTrainingsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.trainings.ListTrainings(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.Training, 0, len(items))
	for _, item := range items {
		out = append(out, trainingDTO(item))
	}
	return openapi.ListTrainings200JSONResponse{Items: out}, nil
}

func (s *Server) CreateTraining(
	ctx context.Context,
	r openapi.CreateTrainingRequestObject,
) (openapi.CreateTrainingResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.trainings.CreateTraining(ctx, p, trainings.TrainingInput{
		Name:           r.Body.Name,
		Description:    nullableStringPointer(r.Body.Description),
		Active:         r.Body.Active,
		SortOrder:      r.Body.SortOrder,
		CompetencyIDs:  r.Body.CompetencyIds,
		MachineTypeIDs: r.Body.MachineTypeIds,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateTraining201JSONResponse(trainingDTO(item)), nil
}

func (s *Server) UpdateTraining(
	ctx context.Context,
	r openapi.UpdateTrainingRequestObject,
) (openapi.UpdateTrainingResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.trainings.UpdateTraining(ctx, p, r.TrainingId, r.Body.ExpectedVersion, trainings.TrainingInput{
		Name:           r.Body.Name,
		Description:    nullableStringPointer(r.Body.Description),
		Active:         r.Body.Active,
		SortOrder:      r.Body.SortOrder,
		CompetencyIDs:  r.Body.CompetencyIds,
		MachineTypeIDs: r.Body.MachineTypeIds,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateTraining200JSONResponse(trainingDTO(item)), nil
}

func (s *Server) DeleteTraining(
	ctx context.Context,
	r openapi.DeleteTrainingRequestObject,
) (openapi.DeleteTrainingResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.trainings.DeleteTraining(ctx, p, r.TrainingId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteTraining204Response{}, nil
}

func competencyCategoryDTO(item trainings.CompetencyCategory) openapi.CompetencyCategory {
	return openapi.CompetencyCategory{
		Id:            item.ID,
		Name:          item.Name,
		Description:   nullableString(item.Description),
		Active:        item.Active,
		SortOrder:     item.SortOrder,
		TrainingCount: item.TrainingCount,
		Version:       item.Version,
		CreatedAt:     item.CreatedAt,
		UpdatedAt:     item.UpdatedAt,
	}
}

func trainingDTO(item trainings.Training) openapi.Training {
	return openapi.Training{
		Id:             item.ID,
		Name:           item.Name,
		Description:    nullableString(item.Description),
		Active:         item.Active,
		SortOrder:      item.SortOrder,
		CompetencyIds:  item.CompetencyIDs,
		MachineTypeIds: item.MachineTypeIDs,
		RecordCount:    item.RecordCount,
		Version:        item.Version,
		CreatedAt:      item.CreatedAt,
		UpdatedAt:      item.UpdatedAt,
	}
}

func (s *Server) ListPersonTrainingRecords(
	ctx context.Context,
	r openapi.ListPersonTrainingRecordsRequestObject,
) (openapi.ListPersonTrainingRecordsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.trainings.ListPersonRecords(ctx, p, r.PersonId)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.TrainingRecord, 0, len(items))
	for _, item := range items {
		out = append(out, trainingRecordDTO(item))
	}
	return openapi.ListPersonTrainingRecords200JSONResponse{Items: out}, nil
}

func (s *Server) SetPersonTrainingRecord(
	ctx context.Context,
	r openapi.SetPersonTrainingRecordRequestObject,
) (openapi.SetPersonTrainingRecordResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := trainings.RecordInput{Status: trainings.Status(r.Body.Status), Notes: nullableStringPointer(r.Body.Notes)}
	if completedOn, err := r.Body.CompletedOn.Get(); err == nil {
		day := completedOn.Time
		input.CompletedOn = &day
	}
	if expected, err := r.Body.ExpectedVersion.Get(); err == nil {
		input.ExpectedVersion = &expected
	}
	item, err := s.trainings.SetRecord(ctx, p, r.PersonId, r.TrainingId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetPersonTrainingRecord200JSONResponse(trainingRecordDTO(item)), nil
}

func trainingRecordDTO(item trainings.Record) openapi.TrainingRecord {
	out := openapi.TrainingRecord{
		TrainingId:     item.TrainingID,
		TrainingName:   item.TrainingName,
		TrainingActive: item.TrainingActive,
		Status:         openapi.TrainingStatus(item.Status),
		CompletedOn:    nullablePointer(item.CompletedOn, func(day time.Time) openapi_types.Date { return openapi_types.Date{Time: day} }),
		Version:        nullablePointer(item.Version, func(version int64) int64 { return version }),
		UpdatedAt:      nullablePointer(item.UpdatedAt, func(at time.Time) time.Time { return at }),
	}
	if item.Notes != nil {
		out.Notes = nullable.NewNullableWithValue(*item.Notes)
	}
	return out
}
