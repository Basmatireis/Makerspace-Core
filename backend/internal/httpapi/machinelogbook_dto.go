package httpapi

import (
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func mlMachineTypeDTO(item machinelogbook.MachineType) openapi.MachineType {
	return openapi.MachineType{Id: item.ID, Name: item.Name, Active: item.Active, Version: item.Version, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}
func mlMachineDTO(item machinelogbook.Machine) openapi.Machine {
	return openapi.Machine{Id: item.ID, MachineType: mlMachineTypeDTO(item.MachineType), Name: item.Name, Status: openapi.MachineStatus(item.Status), ExternalIdentifier: nullableString(item.ExternalIdentifier), AutomaticCollectionEnabled: item.AutomaticCollectionEnabled, LastIngestedAt: nullableValue(item.LastIngestedAt), Version: item.Version, JobCount: item.JobCount, RuntimeSeconds: item.RuntimeSeconds, FailureRate: item.FailureRate, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}
func mlPricingSummaryDTO(item *machinelogbook.PricingGroupSummary) nullable.Nullable[openapi.PricingGroupSummary] {
	if item == nil {
		return nullable.NewNullNullable[openapi.PricingGroupSummary]()
	}
	return nullable.NewNullableWithValue(openapi.PricingGroupSummary{Id: item.ID, Name: item.Name})
}
func mlOrganizationDTO(item machinelogbook.Organization) openapi.Organization {
	return openapi.Organization{Id: item.ID, Name: item.Name, Kind: openapi.OrganizationKind(item.Kind), Active: item.Active, PricingGroup: mlPricingSummaryDTO(item.PricingGroup), PricingGroupAssignmentVersion: item.PricingGroupAssignmentVersion, Version: item.Version, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}
func mlBillingPartyDTO(item machinelogbook.BillingParty) openapi.BillingParty {
	var kind *openapi.OrganizationKind
	if item.OrganizationKind != nil {
		v := openapi.OrganizationKind(*item.OrganizationKind)
		kind = &v
	}
	return openapi.BillingParty{Id: item.ID, Kind: openapi.BillingPartyKind(item.Kind), DisplayName: item.DisplayName, OrganizationKind: kind, PricingGroup: mlPricingSummaryDTO(item.PricingGroup), PricingGroupAssignmentVersion: item.PricingGroupAssignmentVersion}
}
func mlOperatorDTO(item machinelogbook.Operator) openapi.Operator {
	return openapi.Operator{PersonId: item.PersonID, DisplayName: item.DisplayName}
}
func mlPricingRuleDTO(item machinelogbook.PricingRule) openapi.PricingRule {
	var unit nullable.Nullable[openapi.MaterialUnit]
	if item.MaterialUnit == nil {
		unit = nullable.NewNullNullable[openapi.MaterialUnit]()
	} else {
		unit = nullable.NewNullableWithValue(openapi.MaterialUnit(*item.MaterialUnit))
	}
	return openapi.PricingRule{Id: item.ID, PricingGroupId: item.PricingGroupID, Kind: openapi.PricingRuleKind(item.Kind), MachineTypeId: nullableUUIDValue(item.MachineTypeID), MaterialCategory: nullableString(item.MaterialCategory), MaterialUnit: unit, Rate: item.Rate, Active: item.Active, Version: item.Version}
}
func mlPricingGroupDTO(item machinelogbook.PricingGroup) openapi.PricingGroup {
	rules := make([]openapi.PricingRule, 0, len(item.Rules))
	for _, rule := range item.Rules {
		rules = append(rules, mlPricingRuleDTO(rule))
	}
	return openapi.PricingGroup{Id: item.ID, Name: item.Name, Description: nullableString(item.Description), Active: item.Active, IsDefault: item.IsDefault, Rules: rules, Version: item.Version, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}
func mlMaterialDTO(item machinelogbook.Material) openapi.Material {
	return openapi.Material{Id: item.ID, Name: item.Name, Category: item.Category, Color: nullableString(item.Color), Unit: openapi.MaterialUnit(item.Unit), Active: item.Active, LowStockThreshold: nullableDecimalValue(item.LowStockThreshold), Quantity: item.Quantity, InventoryValue: item.InventoryValue, AverageUnitCost: item.AverageUnitCost, RecentConsumption: item.RecentConsumption, StockState: openapi.StockState(item.StockState), Version: item.Version, InventoryVersion: item.InventoryVersion, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}
func mlInventoryTransactionDTO(item machinelogbook.InventoryTransaction) openapi.InventoryTransaction {
	var reason nullable.Nullable[openapi.InventoryAdjustmentReason]
	if item.AdjustmentReason == nil {
		reason = nullable.NewNullNullable[openapi.InventoryAdjustmentReason]()
	} else {
		reason = nullable.NewNullableWithValue(openapi.InventoryAdjustmentReason(*item.AdjustmentReason))
	}
	return openapi.InventoryTransaction{Id: item.ID, MaterialId: item.MaterialID, Kind: openapi.InventoryTransactionKind(item.Kind), QuantityDelta: item.QuantityDelta, UnitAcquisitionCost: item.UnitAcquisitionCost, InventoryValueDelta: item.InventoryValueDelta, TotalPurchasePrice: nullableMoney(item.TotalPurchasePrice), OccurredAt: item.OccurredAt, Supplier: nullableString(item.Supplier), Note: nullableString(item.Note), AdjustmentReason: reason, MachineJobId: nullableUUIDValue(item.MachineJobID), MachineJobDisplayId: nullableString(item.MachineJobDisplayID), CreatedAt: item.CreatedAt}
}
func mlInventoryResultDTO(item machinelogbook.InventoryMutationResult) openapi.InventoryMutationResult {
	return openapi.InventoryMutationResult{Material: mlMaterialDTO(item.Material), Transaction: mlInventoryTransactionDTO(item.Transaction)}
}
func mlJobDTO(item machinelogbook.MachineJob) openapi.MachineJob {
	usages := make([]openapi.MachineJobUsage, 0, len(item.Usages))
	for _, u := range item.Usages {
		usages = append(usages, openapi.MachineJobUsage{Id: u.ID, MaterialId: u.MaterialID, MaterialName: u.MaterialName, Category: u.Category, Unit: openapi.MaterialUnit(u.Unit), Quantity: u.Quantity})
	}
	var customer nullable.Nullable[openapi.BillingParty]
	if item.Customer == nil {
		customer = nullable.NewNullNullable[openapi.BillingParty]()
	} else {
		customer = nullable.NewNullableWithValue(mlBillingPartyDTO(*item.Customer))
	}
	var operator nullable.Nullable[openapi.Operator]
	if item.Operator == nil {
		operator = nullable.NewNullNullable[openapi.Operator]()
	} else {
		operator = nullable.NewNullableWithValue(mlOperatorDTO(*item.Operator))
	}
	var snapshot nullable.Nullable[openapi.MachineJobPricingSnapshot]
	if item.PricingSnapshot == nil {
		snapshot = nullable.NewNullNullable[openapi.MachineJobPricingSnapshot]()
	} else {
		rules := make([]openapi.PricingSnapshotRule, 0, len(item.PricingSnapshot.Rules))
		for _, r := range item.PricingSnapshot.Rules {
			rules = append(rules, openapi.PricingSnapshotRule{SourceRuleId: nullableUUIDValue(r.SourceRuleID), Kind: openapi.PricingRuleKind(r.Kind), Label: r.Label, Selector: r.Selector, Unit: r.Unit, Rate: nullableDecimalValue(r.Rate), Missing: r.Missing})
		}
		snapshot = nullable.NewNullableWithValue(openapi.MachineJobPricingSnapshot{Id: item.PricingSnapshot.ID, Revision: item.PricingSnapshot.Revision, PricingGroupName: item.PricingSnapshot.PricingGroupName, Currency: openapi.MachineJobPricingSnapshotCurrency(item.PricingSnapshot.Currency), Reason: openapi.MachineJobPricingSnapshotReason(item.PricingSnapshot.Reason), Complete: item.PricingSnapshot.Complete, CalculatedAmount: nullableMoney(item.PricingSnapshot.CalculatedAmount), Rules: rules, CapturedAt: item.PricingSnapshot.CapturedAt})
	}
	return openapi.MachineJob{Id: item.ID, DisplayId: item.DisplayID, Machine: mlMachineDTO(item.Machine), StartsAt: item.StartsAt, EndsAt: item.EndsAt, DurationSeconds: item.DurationSeconds, Source: openapi.MachineJobSource(item.Source), ExternalId: nullableString(item.ExternalID), ReviewState: openapi.MachineJobReviewState(item.ReviewState), Customer: customer, Operator: operator, Outcome: openapi.MachineJobOutcome(item.Outcome), Notes: nullableString(item.Notes), Usages: usages, PricingStatus: openapi.PricingStatus(item.PricingStatus), PricingSnapshot: snapshot, CalculatedPrice: nullableMoney(item.CalculatedPrice), FinalPrice: nullableMoney(item.FinalPrice), EffectivePrice: nullableMoney(item.EffectivePrice), PriceOverrideReason: nullableString(item.PriceOverrideReason), PriceOverriddenAt: nullableValue(item.PriceOverriddenAt), BillingStatus: openapi.BillingStatus(item.BillingStatus), BillingReference: nullableString(item.BillingReference), Version: item.Version, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}
func mlOverviewDTO(item machinelogbook.Overview) openapi.MachineLogbookOverview {
	jobs := make([]openapi.MachineJob, 0, len(item.RecentJobs))
	for _, j := range item.RecentJobs {
		jobs = append(jobs, mlJobDTO(j))
	}
	materials := make([]openapi.Material, 0, len(item.LowStockMaterials))
	for _, m := range item.LowStockMaterials {
		materials = append(materials, mlMaterialDTO(m))
	}
	activity := make([]openapi.DailyJobActivity, 0, len(item.Activity))
	for _, a := range item.Activity {
		activity = append(activity, openapi.DailyJobActivity{Date: openapi_types.Date{Time: a.Date}, Count: a.Jobs})
	}
	return openapi.MachineLogbookOverview{JobsToday: item.JobsToday, JobsThisWeek: item.JobsThisWeek, UnbilledJobs: item.UnbilledJobs, UnbilledAmount: item.UnbilledAmount, NeedsReview: item.NeedsReview, FailedOrPartialThisWeek: item.FailedOrPartialThisWeek, LowStockItems: item.LowStockItems, RecentJobs: jobs, LowStockMaterials: materials, Activity: activity}
}
func mlStatisticPoints(items []machinelogbook.StatisticPoint) []openapi.StatisticPoint {
	result := make([]openapi.StatisticPoint, 0, len(items))
	for _, item := range items {
		result = append(result, openapi.StatisticPoint{Key: item.Key, Label: item.Label, Value: item.Value})
	}
	return result
}
func mlStatisticsDTO(item machinelogbook.Statistics) openapi.MachineLogbookStatistics {
	return openapi.MachineLogbookStatistics{MaterialUsageByCategory: mlStatisticPoints(item.MaterialUsageByCategory), MachineRuntimeHours: mlStatisticPoints(item.MachineRuntimeHours), MachineJobCounts: mlStatisticPoints(item.MachineJobCounts), AcquisitionCost: mlStatisticPoints(item.AcquisitionCost), CustomerCharges: mlStatisticPoints(item.CustomerCharges), AdjustmentLoss: mlStatisticPoints(item.AdjustmentLoss), MachineFailureRates: mlStatisticPoints(item.MachineFailureRates)}
}
func nullableValue[T any](value *T) nullable.Nullable[T] {
	if value == nil {
		return nullable.NewNullNullable[T]()
	}
	return nullable.NewNullableWithValue(*value)
}
func nullableUUIDValue(value *uuid.UUID) nullable.Nullable[openapi.UUIDv7] {
	if value == nil {
		return nullable.NewNullNullable[openapi.UUIDv7]()
	}
	return nullable.NewNullableWithValue(*value)
}
func nullableDecimalValue(value *string) nullable.Nullable[openapi.Decimal] {
	if value == nil {
		return nullable.NewNullNullable[openapi.Decimal]()
	}
	return nullable.NewNullableWithValue(openapi.Decimal(*value))
}
func nullableMoney(value *string) nullable.Nullable[openapi.Money] {
	if value == nil {
		return nullable.NewNullNullable[openapi.Money]()
	}
	return nullable.NewNullableWithValue(openapi.Money(*value))
}
func uuidNullable(value nullable.Nullable[openapi.UUIDv7]) *uuid.UUID {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	v := value.GetOrEmpty()
	return &v
}
func decimalNullable(value nullable.Nullable[openapi.Decimal]) *string {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	v := string(value.GetOrEmpty())
	return &v
}
func materialUnitNullable(value nullable.Nullable[openapi.MaterialUnit]) *string {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	v := string(value.GetOrEmpty())
	return &v
}
func partyInput(value openapi.BillingPartyReference) machinelogbook.PartyReference {
	return machinelogbook.PartyReference{Kind: string(value.Kind), ID: value.Id}
}
func usageInputs(values []openapi.MachineJobUsageInput) []machinelogbook.UsageInput {
	items := make([]machinelogbook.UsageInput, 0, len(values))
	for _, v := range values {
		items = append(items, machinelogbook.UsageInput{MaterialID: v.MaterialId, Quantity: string(v.Quantity)})
	}
	return items
}
func defaultInt(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}
func defaultString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func stringEnum[T ~string](value *T) *string {
	if value == nil {
		return nil
	}
	v := string(*value)
	return &v
}
func utcDayBounds(from, to time.Time) (time.Time, time.Time) {
	return from.UTC(), to.UTC().Add(24 * time.Hour)
}
