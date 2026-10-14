package machinelogbook

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

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
	result := Overview{JobsToday: counts.JobsToday, JobsThisWeek: counts.JobsThisWeek, UnassignedJobs: counts.UnassignedJobs, UnassignedEstimatedAmount: decimalString(counts.UnassignedEstimatedAmount), FailedOrPartialThisWeek: counts.FailedOrPartialThisWeek, LowStockItems: lowCount, RecentJobs: []MachineJob{}, LowStockMaterials: []Material{}, Activity: []DailyActivity{}}
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
	if p.Has(authorization.MachineJobsRead) {
		if err = s.fillOverviewWorkItems(ctx, q, p, &result); err != nil {
			return Overview{}, err
		}
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

func (s *Service) fillOverviewWorkItems(ctx context.Context, q *machinelogbookdb.Queries, p authorization.Principal, result *Overview) error {
	now := s.now().UTC()
	var err error
	count := func(statuses, billing []string) *int64 {
		if err != nil {
			return nil
		}
		var total int64
		total, err = s.countWorkItems(ctx, q, statuses, billing)
		return &total
	}
	result.RunningNow = count([]string{"running", "running_unassigned"}, nil)
	result.NeedsOutcome = count([]string{"needs_outcome"}, nil)
	result.UnassignedRuns = count([]string{"unassigned"}, nil)
	result.BillingIssues = count(nil, []string{"price_incomplete", "order_outdated"})
	if err != nil {
		return err
	}
	result.RunningMachineNames, err = q.ListRunningMachineNames(ctx, now)
	if err != nil {
		return err
	}
	rows, err := q.ListWorkItems(ctx, machinelogbookdb.ListWorkItemsParams{Statuses: []string{"running", "running_unassigned", "unassigned", "needs_outcome"}, MachineIds: []uuid.UUID{}, Sources: []string{},
		MaterialIds: []uuid.UUID{}, BillingStates: []string{}, ActiveOrder: true, SortKey: "startedAt", SortDirection: "desc", PageLimit: 6})
	if err != nil {
		return err
	}
	result.ActiveItems = workItemsFromRows(rows, p.Has(authorization.OrdersRead))
	total := int64(0)
	if len(rows) > 0 {
		total = rows[0].Total
	}
	result.ActiveTotal = &total
	return nil
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
	runtime, err := q.StatisticMachineRuntime(ctx, machinelogbookdb.StatisticMachineRuntimeParams{Now: s.now().UTC(), FromTime: from.UTC(), ToTime: to.UTC()})
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
	if err = s.fillPeriodStatistics(ctx, q, from.UTC(), to.UTC(), &result); err != nil {
		return result, err
	}
	return result, nil
}

// maxWeeklyRuntimeDays is the longest period whose runtime is bucketed by week.
const maxWeeklyRuntimeDays = 92

func (s *Service) periodTotals(ctx context.Context, q *machinelogbookdb.Queries, from, to, now time.Time) (StatisticTotals, error) {
	row, err := q.StatisticPeriodTotals(ctx, machinelogbookdb.StatisticPeriodTotalsParams{Now: now, FromTime: from, ToTime: to})
	if err != nil {
		return StatisticTotals{}, err
	}
	return StatisticTotals{Jobs: row.Jobs, RuntimeHours: decimalString(row.RuntimeHours), Charges: decimalString(row.Charges), MaterialCost: decimalString(row.MaterialCost), FailureRate: decimalString(row.FailureRate)}, nil
}

func (s *Service) fillPeriodStatistics(ctx context.Context, q *machinelogbookdb.Queries, from, to time.Time, result *Statistics) error {
	now := s.now().UTC()
	var err error
	if result.Totals, err = s.periodTotals(ctx, q, from, to, now); err != nil {
		return err
	}
	length := to.Sub(from)
	if result.PreviousTotals, err = s.periodTotals(ctx, q, from.Add(-length), from, now); err != nil {
		return err
	}
	months, err := q.StatisticMonths(ctx, machinelogbookdb.StatisticMonthsParams{FromTime: from, ToTime: to})
	if err != nil {
		return err
	}
	result.Months = make([]StatisticMonth, 0, len(months))
	for _, row := range months {
		result.Months = append(result.Months, StatisticMonth{Month: row.Month, Charges: decimalString(row.Charges), MaterialCost: decimalString(row.MaterialCost), Losses: decimalString(row.Losses)})
	}
	unit := "month"
	result.RuntimeGranularity = "month"
	if length <= maxWeeklyRuntimeDays*24*time.Hour {
		unit, result.RuntimeGranularity = "week", "week"
	}
	points, err := q.StatisticRuntimePoints(ctx, machinelogbookdb.StatisticRuntimePointsParams{Unit: unit, Now: now, FromTime: from, ToTime: to})
	if err != nil {
		return err
	}
	result.Runtime = make([]StatisticRuntimePoint, 0, len(points))
	for _, row := range points {
		result.Runtime = append(result.Runtime, StatisticRuntimePoint{BucketStart: row.BucketStart.Time.UTC(), MachineID: row.MachineID, Hours: decimalString(row.Hours)})
	}
	categories, err := q.StatisticMaterialCostByCategory(ctx, machinelogbookdb.StatisticMaterialCostByCategoryParams{FromTime: from, ToTime: to})
	if err != nil {
		return err
	}
	result.MaterialCostByCategory = make([]StatisticPoint, 0, len(categories))
	for _, row := range categories {
		result.MaterialCostByCategory = append(result.MaterialCostByCategory, StatisticPoint{Key: row.Label, Label: row.Label, Value: decimalString(row.Value)})
	}
	machines, err := q.StatisticMachineSummaries(ctx, machinelogbookdb.StatisticMachineSummariesParams{Now: now, FromTime: from, ToTime: to})
	if err != nil {
		return err
	}
	totalRuntime := decimal.Zero
	for _, row := range machines {
		totalRuntime = totalRuntime.Add(decimalFromNumeric(row.RuntimeHours))
	}
	result.Machines = make([]StatisticMachine, 0, len(machines))
	for _, row := range machines {
		share := decimal.Zero
		if totalRuntime.IsPositive() {
			share = decimalFromNumeric(row.RuntimeHours).Mul(decimal.NewFromInt(100)).Div(totalRuntime).Round(2)
		}
		result.Machines = append(result.Machines, StatisticMachine{MachineID: row.MachineID, Name: row.Name, MachineTypeName: row.MachineTypeName, Jobs: row.Jobs,
			RuntimeHours: decimalString(row.RuntimeHours), FailureRate: decimalString(row.FailureRate), Charges: decimalString(row.Charges), RuntimeShare: share.String()})
	}
	return nil
}
