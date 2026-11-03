package machinelogbook

import (
	"context"
	"time"

	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// utilization is the share of time runs occupied the machines that are not retired, in percent with two decimals:
// per machine over the elapsed hours of the period and over its open-day hours, and for all of them together.
type utilization struct {
	machine, openDay    map[uuid.UUID]decimal.Decimal
	total, openDayTotal decimal.Decimal
}

var hundred = decimal.NewFromInt(100)

// percentOf is part/whole in percent, capped at 100 because runs on one machine may overlap.
func percentOf(part, whole decimal.Decimal) decimal.Decimal {
	if !whole.IsPositive() {
		return decimal.Zero
	}
	return decimal.Min(part.Mul(hundred).Div(whole), hundred).Round(2)
}

func machineUtilization(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	from, to, now time.Time,
) (utilization, error) {
	result := utilization{machine: map[uuid.UUID]decimal.Decimal{}, openDay: map[uuid.UUID]decimal.Decimal{}}
	rows, err := q.StatisticMachineUtilization(
		ctx,
		machinelogbookdb.StatisticMachineUtilizationParams{FromTime: from, ToTime: to, Now: now},
	)
	if err != nil {
		return result, err
	}
	// Only the hours that have passed count; a period that ends in the future is not yet idle.
	end := to
	if now.Before(end) {
		end = now
	}
	elapsed := decimal.Zero
	if end.After(from) {
		elapsed = decimal.NewFromFloat(end.Sub(from).Seconds())
	}
	busy, openBusy, openSeconds := decimal.Zero, decimal.Zero, decimal.Zero
	for _, row := range rows {
		machineBusy := decimalFromNumeric(row.BusySeconds)
		machineOpenBusy := decimalFromNumeric(row.OpenDayBusySeconds)
		openSeconds = decimalFromNumeric(row.OpenDaySeconds)
		result.machine[row.MachineID] = percentOf(machineBusy, elapsed)
		result.openDay[row.MachineID] = percentOf(machineOpenBusy, openSeconds)
		busy = busy.Add(decimal.Min(machineBusy, elapsed))
		openBusy = openBusy.Add(decimal.Min(machineOpenBusy, openSeconds))
	}
	count := decimal.NewFromInt(int64(len(rows)))
	result.total = percentOf(busy, elapsed.Mul(count))
	result.openDayTotal = percentOf(openBusy, openSeconds.Mul(count))
	return result, nil
}

// fillStatisticsDetail loads the aggregates the statistics pages chart beyond totals, months and machines.
func (s *Service) fillStatisticsDetail(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	from, to, now time.Time,
	detail *StatisticsDetail,
) error {
	hours, err := q.StatisticUsageByWeekdayHour(
		ctx,
		machinelogbookdb.StatisticUsageByWeekdayHourParams{FromTime: from, ToTime: to, Now: now, TimeZone: s.timeZone},
	)
	if err != nil {
		return err
	}
	detail.UsageByWeekdayHour = make([]StatisticWeekdayHour, 0, len(hours))
	for _, row := range hours {
		detail.UsageByWeekdayHour = append(detail.UsageByWeekdayHour, StatisticWeekdayHour{
			Weekday: int(row.Weekday), Hour: int(row.Hour), Runs: row.Runs, Minutes: decimalString(row.Minutes),
		})
	}
	outcomes, err := q.StatisticJobsByOutcome(
		ctx,
		machinelogbookdb.StatisticJobsByOutcomeParams{FromTime: from, ToTime: to},
	)
	if err != nil {
		return err
	}
	detail.JobsByOutcome = make([]StatisticOutcomeCount, 0, len(outcomes))
	for _, row := range outcomes {
		detail.JobsByOutcome = append(detail.JobsByOutcome, StatisticOutcomeCount{Outcome: row.Outcome, Jobs: row.Jobs})
	}
	weeks, err := q.StatisticJobsByWeek(ctx, machinelogbookdb.StatisticJobsByWeekParams{FromTime: from, ToTime: to})
	if err != nil {
		return err
	}
	detail.JobsByWeek = make([]StatisticWeek, 0, len(weeks))
	for _, row := range weeks {
		detail.JobsByWeek = append(detail.JobsByWeek, StatisticWeek{WeekStart: row.WeekStart.Time.UTC(), Jobs: row.Jobs})
	}
	materials, err := q.StatisticMaterialByMonth(
		ctx,
		machinelogbookdb.StatisticMaterialByMonthParams{FromTime: from, ToTime: to},
	)
	if err != nil {
		return err
	}
	detail.MaterialByMonth = make([]StatisticMaterialMonth, 0, len(materials))
	for _, row := range materials {
		detail.MaterialByMonth = append(detail.MaterialByMonth, StatisticMaterialMonth{
			Month:            row.Month,
			MaterialTypeID:   row.MaterialTypeID,
			MaterialTypeName: row.MaterialTypeName,
			Unit:             row.Unit,
			Quantity:         decimalString(row.Quantity),
			Cost:             decimalString(row.Cost),
		})
	}
	losses, err := q.StatisticMaterialLossByType(
		ctx,
		machinelogbookdb.StatisticMaterialLossByTypeParams{FromTime: from, ToTime: to},
	)
	if err != nil {
		return err
	}
	detail.MaterialLossByType = make([]StatisticPoint, 0, len(losses))
	for _, row := range losses {
		detail.MaterialLossByType = append(
			detail.MaterialLossByType,
			StatisticPoint{Key: row.Key, Label: row.Label, Value: decimalString(row.Value)},
		)
	}
	charges, err := q.StatisticMaterialChargesByType(
		ctx,
		machinelogbookdb.StatisticMaterialChargesByTypeParams{FromTime: from, ToTime: to},
	)
	if err != nil {
		return err
	}
	detail.MaterialChargesByType = make([]StatisticPoint, 0, len(charges))
	for _, row := range charges {
		detail.MaterialChargesByType = append(
			detail.MaterialChargesByType,
			StatisticPoint{Key: row.Key, Label: row.Label, Value: decimalString(row.Value)},
		)
	}
	groups, err := q.StatisticPricingGroups(ctx, machinelogbookdb.StatisticPricingGroupsParams{FromTime: from, ToTime: to})
	if err != nil {
		return err
	}
	detail.PricingGroups = make([]StatisticPricingGroup, 0, len(groups))
	for _, row := range groups {
		detail.PricingGroups = append(detail.PricingGroups, StatisticPricingGroup{
			PricingGroupName: row.PricingGroupName,
			Jobs:             row.Jobs,
			Charges:          decimalString(row.Charges),
			Discounts:        decimalString(row.Discounts),
		})
	}
	groupMonths, err := q.StatisticPricingGroupMonths(
		ctx,
		machinelogbookdb.StatisticPricingGroupMonthsParams{FromTime: from, ToTime: to},
	)
	if err != nil {
		return err
	}
	detail.PricingGroupMonths = make([]StatisticPricingGroupMonth, 0, len(groupMonths))
	for _, row := range groupMonths {
		detail.PricingGroupMonths = append(detail.PricingGroupMonths, StatisticPricingGroupMonth{
			Month: row.Month, PricingGroupName: row.PricingGroupName, Charges: decimalString(row.Charges),
		})
	}
	return nil
}
