package machinelogbook

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func (s *Service) Overview(ctx context.Context, p authorization.Principal) (Overview, error) {
	if !p.Has(authorization.MachineJobsRead) && !p.Has(authorization.StatisticsRead) {
		return Overview{}, apperror.PermissionDenied
	}
	q := machinelogbookdb.New(s.pool)
	counts, err := q.CountOverviewJobs(ctx)
	if err != nil {
		return Overview{}, err
	}
	lowCount, err := q.CountLowStockMaterials(ctx)
	if err != nil {
		return Overview{}, err
	}
	result := Overview{JobsToday: counts.JobsToday, JobsThisWeek: counts.JobsThisWeek, UnbilledJobs: counts.UnbilledJobs, UnbilledAmount: decimalString(counts.UnbilledAmount), NeedsReview: counts.NeedsReview, FailedOrPartialThisWeek: counts.FailedOrPartialThisWeek, LowStockItems: lowCount, RecentJobs: []MachineJob{}, LowStockMaterials: []Material{}, Activity: []DailyActivity{}}
	recent, err := q.ListRecentJobIDs(ctx, 5)
	if err != nil {
		return Overview{}, err
	}
	for _, id := range recent {
		row, err := q.GetMachineJobBase(ctx, id)
		if err != nil {
			return Overview{}, err
		}
		job, err := s.jobFromRow(ctx, q, row)
		if err != nil {
			return Overview{}, err
		}
		result.RecentJobs = append(result.RecentJobs, job)
	}
	lowIDs, err := q.ListLowStockMaterialIDs(ctx, 5)
	if err != nil {
		return Overview{}, err
	}
	for _, id := range lowIDs {
		row, err := q.GetMaterial(ctx, id)
		if err != nil {
			return Overview{}, err
		}
		result.LowStockMaterials = append(result.LowStockMaterials, materialFromGet(row))
	}
	activity, err := q.OverviewDailyActivity(ctx)
	if err != nil {
		return Overview{}, err
	}
	for _, row := range activity {
		if row.ActivityDate.Valid {
			result.Activity = append(result.Activity, DailyActivity{Date: row.ActivityDate.Time, Jobs: row.JobCount})
		}
	}
	return result, nil
}

func (s *Service) Statistics(ctx context.Context, p authorization.Principal, from, to time.Time) (Statistics, error) {
	if err := require(p, authorization.StatisticsRead); err != nil {
		return Statistics{}, err
	}
	if from.IsZero() || to.IsZero() || !to.After(from) {
		return Statistics{}, validation("to must be after from")
	}
	q := machinelogbookdb.New(s.pool)
	result := Statistics{MaterialUsageByCategory: []StatisticPoint{}, MachineRuntimeHours: []StatisticPoint{}, MachineJobCounts: []StatisticPoint{}, AcquisitionCost: []StatisticPoint{}, CustomerCharges: []StatisticPoint{}, AdjustmentLoss: []StatisticPoint{}, MachineFailureRates: []StatisticPoint{}}
	material, err := q.StatisticMaterialUsage(ctx, machinelogbookdb.StatisticMaterialUsageParams{FromTime: from.UTC(), ToTime: to.UTC()})
	if err != nil {
		return result, err
	}
	for _, row := range material {
		result.MaterialUsageByCategory = append(result.MaterialUsageByCategory, StatisticPoint{Key: row.Label, Label: row.Label, Value: decimalString(row.Value)})
	}
	runtime, err := q.StatisticMachineRuntime(ctx, machinelogbookdb.StatisticMachineRuntimeParams{FromTime: from.UTC(), ToTime: to.UTC()})
	if err != nil {
		return result, err
	}
	for _, row := range runtime {
		result.MachineRuntimeHours = append(result.MachineRuntimeHours, StatisticPoint{Key: row.Key, Label: row.Label, Value: decimalString(row.Value)})
	}
	jobCounts, err := q.StatisticMachineJobCounts(ctx, machinelogbookdb.StatisticMachineJobCountsParams{FromTime: from.UTC(), ToTime: to.UTC()})
	if err != nil {
		return result, err
	}
	for _, row := range jobCounts {
		result.MachineJobCounts = append(result.MachineJobCounts, StatisticPoint{Key: row.Key, Label: row.Label, Value: decimalString(row.Value)})
	}
	acquisition, err := q.StatisticAcquisitionCost(ctx, machinelogbookdb.StatisticAcquisitionCostParams{FromTime: from.UTC(), ToTime: to.UTC()})
	if err != nil {
		return result, err
	}
	for _, row := range acquisition {
		result.AcquisitionCost = append(result.AcquisitionCost, StatisticPoint{Key: row.Label, Label: row.Label, Value: decimalString(row.Value)})
	}
	charges, err := q.StatisticCustomerCharges(ctx, machinelogbookdb.StatisticCustomerChargesParams{FromTime: from.UTC(), ToTime: to.UTC()})
	if err != nil {
		return result, err
	}
	for _, row := range charges {
		result.CustomerCharges = append(result.CustomerCharges, StatisticPoint{Key: row.Label, Label: row.Label, Value: decimalString(row.Value)})
	}
	loss, err := q.StatisticAdjustmentLoss(ctx, machinelogbookdb.StatisticAdjustmentLossParams{FromTime: from.UTC(), ToTime: to.UTC()})
	if err != nil {
		return result, err
	}
	for _, row := range loss {
		result.AdjustmentLoss = append(result.AdjustmentLoss, StatisticPoint{Key: row.Label, Label: row.Label, Value: decimalString(row.Value)})
	}
	failure, err := q.StatisticMachineFailureRates(ctx, machinelogbookdb.StatisticMachineFailureRatesParams{FromTime: from.UTC(), ToTime: to.UTC()})
	if err != nil {
		return result, err
	}
	for _, row := range failure {
		result.MachineFailureRates = append(result.MachineFailureRates, StatisticPoint{Key: row.Key, Label: row.Label, Value: decimalString(row.Value)})
	}
	return result, nil
}
