package httpapi

import (
	"context"

	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/dashboard"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) GetPersonalDashboard(
	ctx context.Context,
	_ openapi.GetPersonalDashboardRequestObject,
) (openapi.GetPersonalDashboardResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.dashboard.Get(ctx, principal)
	if err != nil {
		return nil, err
	}
	response := openapi.PersonalDashboard{
		Person: openapi.PersonalDashboardPerson{FirstName: result.Person.FirstName, MemberSince: openapi_types.Date{Time: result.Person.MemberSince}},
	}
	comingUp := make([]openapi.ComingUpItem, 0, len(result.ComingUp))
	for _, item := range result.ComingUp {
		comingUp = append(comingUp, openapi.ComingUpItem{
			Kind:         openapi.ComingUpItemKind(item.Kind),
			Id:           item.ID,
			Title:        item.Title,
			StartsAt:     item.StartsAt,
			EndsAt:       item.EndsAt,
			OpenDayId:    item.OpenDayID,
			PeriodId:     item.PeriodID,
			ShortStaffed: item.ShortStaffed,
			EventId:      item.EventID,
			PublicId:     item.PublicID,
		})
	}
	response.ComingUp = &comingUp
	if result.Staffing != nil {
		response.Staffing = staffingDTO(result.Staffing)
	}
	if result.Statistics != nil {
		response.Statistics = &openapi.PersonalStatistics{
			OpenDaysStaffed: result.Statistics.OpenDaysStaffed,
			OpenDayHours:    result.Statistics.OpenDayHours,
			EventShifts:     result.Statistics.EventShifts,
			EventShiftHours: result.Statistics.EventShiftHours,
			MemberSince:     openapi_types.Date{Time: result.Statistics.MemberSince},
		}
		if jobs := result.Statistics.Jobs; jobs != nil {
			response.Statistics.Jobs = jobStatisticsDTO(jobs)
		}
	}
	if balance := result.Balance; balance != nil {
		dto := openapi.PersonalBalance{
			UnpaidOrders:      ownOrdersDTO(balance.UnpaidOrders),
			UnbilledJobs:      make([]openapi.PersonalUnbilledJob, 0, len(balance.UnbilledJobs)),
			UnpaidOrdersTotal: balance.UnpaidOrdersTotal,
			UnbilledJobsTotal: balance.UnbilledJobsTotal,
			Total:             balance.Total,
		}
		for _, job := range balance.UnbilledJobs {
			dto.UnbilledJobs = append(dto.UnbilledJobs, openapi.PersonalUnbilledJob{
				Id:          job.ID,
				DisplayId:   job.DisplayID,
				Title:       job.Title,
				MachineName: job.MachineName,
				StartedAt:   job.StartedAt,
				Price:       job.Price.StringFixed(2),
			})
		}
		response.Balance = &dto
	}
	if result.RecentOrders != nil {
		recent := ownOrdersDTO(result.RecentOrders)
		response.RecentOrders = &recent
	}
	if result.RecentJobs != nil {
		recent := make([]openapi.PersonalRecentJob, 0, len(result.RecentJobs))
		for _, job := range result.RecentJobs {
			recent = append(recent, recentJobDTO(job))
		}
		response.RecentJobs = &recent
	}
	return openapi.GetPersonalDashboard200JSONResponse(response), nil
}

func ownOrdersDTO(items []orders.OwnOrder) []openapi.PersonalOrder {
	result := make([]openapi.PersonalOrder, 0, len(items))
	for _, order := range items {
		result = append(result, openapi.PersonalOrder{
			Id:                order.ID,
			Reference:         order.Reference,
			Status:            openapi.PersonalOrderStatus(order.Status),
			CreatedAt:         order.CreatedAt,
			ItemSummary:       order.ItemSummary,
			ItemCount:         order.ItemCount,
			NetCharge:         order.NetCharge,
			OutstandingAmount: order.OutstandingAmount,
			SettlementState:   openapi.PersonalOrderSettlementState(order.SettlementState),
			Invoiced:          order.Invoiced,
			Payable:           order.Payable,
		})
	}
	return result
}

func recentJobDTO(job machinelogbook.OwnRecentJob) openapi.PersonalRecentJob {
	dto := openapi.PersonalRecentJob{
		Id:             job.ID,
		DisplayId:      job.DisplayID,
		Title:          job.Title,
		MachineName:    job.MachineName,
		StartedAt:      nullable.NewNullNullable[time.Time](),
		EndedAt:        nullable.NewNullNullable[time.Time](),
		Status:         openapi.WorkItemStatus(job.Status),
		Price:          nullable.NewNullNullable[openapi.Money](),
		Own:            job.Own,
		BillingState:   nullable.NewNullNullable[openapi.JobBillingState](),
		OrderReference: nullable.NewNullNullable[string](),
	}
	if job.StartedAt != nil {
		dto.StartedAt = nullable.NewNullableWithValue(*job.StartedAt)
	}
	if job.EndedAt != nil {
		dto.EndedAt = nullable.NewNullableWithValue(*job.EndedAt)
	}
	if job.Price != nil {
		dto.Price = nullable.NewNullableWithValue(*job.Price)
	}
	if job.Billing != nil {
		dto.BillingState = nullable.NewNullableWithValue(openapi.JobBillingState(*job.Billing))
	}
	if job.OrderReference != nil {
		dto.OrderReference = nullable.NewNullableWithValue(*job.OrderReference)
	}
	return dto
}

func jobStatisticsDTO(jobs *machinelogbook.OwnJobStatistics) *openapi.PersonalJobStatistics {
	dto := &openapi.PersonalJobStatistics{
		Jobs:             jobs.Jobs,
		SuccessfulJobs:   jobs.SuccessfulJobs,
		FinishedJobs:     jobs.FinishedJobs,
		SuccessRate:      nullable.NewNullNullable[int](),
		MaterialGrams:    jobs.MaterialGrams,
		MachineSeconds:   jobs.MachineSeconds,
		FavouriteMachine: nullable.NewNullNullable[openapi.PersonalFavouriteMachine](),
		JobsPerMonth:     make([]openapi.PersonalJobMonth, 0, len(jobs.JobsPerMonth)),
	}
	if jobs.SuccessRate != nil {
		dto.SuccessRate = nullable.NewNullableWithValue(*jobs.SuccessRate)
	}
	if favourite := jobs.FavouriteMachine; favourite != nil {
		dto.FavouriteMachine = nullable.NewNullableWithValue(
			openapi.PersonalFavouriteMachine{Name: favourite.Name, Jobs: favourite.Jobs},
		)
	}
	for _, month := range jobs.JobsPerMonth {
		dto.JobsPerMonth = append(dto.JobsPerMonth, openapi.PersonalJobMonth{Month: month.Month, Jobs: month.Jobs})
	}
	return dto
}

func staffingDTO(section *dashboard.Staffing) *openapi.PersonalDashboardStaffing {
	response := &openapi.PersonalDashboardStaffing{
		Kind:             openapi.StaffingLevel(section.Kind),
		Semester:         semesterDTO(section.Semester),
		Minimum:          section.Minimum,
		TraineeThreshold: section.TraineeThreshold,
		Staffed:          section.Counts.Staffed,
		Booked:           section.Counts.Booked,
		StaffedAsTrainee: section.Counts.StaffedAsTrainee,
		Status:           openapi.StaffingStatus(section.Standing.Status),
		Missing:          section.Standing.Missing,
		NextOpenPlace:    nullable.NewNullNullable[openapi.OpenPlace](),
		NextOpenDay:      nullable.NewNullNullable[openapi.NextOpenDayStaffing](),
	}
	if place := section.NextOpenPlace; place != nil {
		response.NextOpenPlace = nullable.NewNullableWithValue(openapi.OpenPlace{
			OpenDayId: place.OpenDayID, PeriodId: place.PeriodID, RequirementId: place.RequirementID,
			StartsAt: place.StartsAt, EndsAt: place.EndsAt, FreePlaces: place.FreePlaces,
		})
	}
	if day := section.NextOpenDay; day != nil {
		response.NextOpenDay = nullable.NewNullableWithValue(openapi.NextOpenDayStaffing{
			OpenDayId: day.OpenDayID, StartsAt: day.StartsAt, EndsAt: day.EndsAt,
			OpenSupervisorPlaces: day.OpenSupervisorPlaces, ShortStaffed: day.ShortStaffed,
		})
	}
	return response
}
