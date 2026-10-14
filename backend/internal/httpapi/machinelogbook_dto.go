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
	return openapi.MachineType{Id: item.ID, Name: item.Name, Active: item.Active, Printer: item.Printer, Version: item.Version, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
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
	return openapi.Material{Id: item.ID, Name: item.Name, Category: item.Category, Color: nullableString(item.Color), Unit: openapi.MaterialUnit(item.Unit), Active: item.Active, LowStockThreshold: nullableDecimalValue(item.LowStockThreshold), FilamentDiameterMm: nullableDecimalValue(item.FilamentDiameterMM), Quantity: item.Quantity, AssignedQuantity: item.AssignedQuantity, UnassignedQuantity: item.UnassignedQuantity, InventoryValue: item.InventoryValue, AverageUnitCost: item.AverageUnitCost, RecentConsumption: item.RecentConsumption, StockState: openapi.StockState(item.StockState), Version: item.Version, InventoryVersion: item.InventoryVersion, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}
func mlInventoryTransactionDTO(item machinelogbook.InventoryTransaction) openapi.InventoryTransaction {
	var reason nullable.Nullable[openapi.InventoryAdjustmentReason]
	if item.AdjustmentReason == nil {
		reason = nullable.NewNullNullable[openapi.InventoryAdjustmentReason]()
	} else {
		reason = nullable.NewNullableWithValue(openapi.InventoryAdjustmentReason(*item.AdjustmentReason))
	}
	return openapi.InventoryTransaction{Id: item.ID, MaterialId: item.MaterialID, Kind: openapi.InventoryTransactionKind(item.Kind), QuantityDelta: item.QuantityDelta, UnitAcquisitionCost: item.UnitAcquisitionCost, InventoryValueDelta: item.InventoryValueDelta, TotalPurchasePrice: nullableMoney(item.TotalPurchasePrice), OccurredAt: item.OccurredAt, Supplier: nullableString(item.Supplier), Note: nullableString(item.Note), AdjustmentReason: reason, MachineJobId: nullableUUIDValue(item.MachineJobID), MachineJobDisplayId: nullableString(item.MachineJobDisplayID), SpoolId: nullableUUIDValue(item.SpoolID), SpoolDisplayId: nullableString(item.SpoolDisplayID), FillNumber: nullableInt32Value(item.FillNumber), FromSpoolId: nullableUUIDValue(item.FromSpoolID), FromSpoolDisplayId: nullableString(item.FromSpoolDisplayID), FromFillNumber: nullableInt32Value(item.FromFillNumber), ToSpoolId: nullableUUIDValue(item.ToSpoolID), ToSpoolDisplayId: nullableString(item.ToSpoolDisplayID), ToFillNumber: nullableInt32Value(item.ToFillNumber), TransferQuantity: nullableDecimalValue(item.TransferQuantity), ActorName: nullableString(item.ActorName), CreatedAt: item.CreatedAt}
}
func mlInventoryResultDTO(item machinelogbook.InventoryMutationResult) openapi.InventoryMutationResult {
	return openapi.InventoryMutationResult{Material: mlMaterialDTO(item.Material), Transaction: mlInventoryTransactionDTO(item.Transaction)}
}
func mlJobDTO(item machinelogbook.MachineJob) openapi.MachineJob {
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
	var adjustment nullable.Nullable[openapi.MachineJobPriceAdjustment]
	if item.PriceAdjustment == nil {
		adjustment = nullable.NewNullNullable[openapi.MachineJobPriceAdjustment]()
	} else {
		adjustment = nullable.NewNullableWithValue(openapi.MachineJobPriceAdjustment{Kind: openapi.PriceAdjustmentKind(item.PriceAdjustment.Kind), Value: openapi.Decimal(item.PriceAdjustment.Value), Reason: item.PriceAdjustment.Reason, AdjustedAt: item.PriceAdjustment.AdjustedAt})
	}
	artifact := nullable.NewNullNullable[openapi.PrintArtifactReference]()
	if item.Artifact != nil {
		artifact = nullable.NewNullableWithValue(mlArtifactReferenceDTO(*item.Artifact))
	}
	return openapi.MachineJob{Id: item.ID, DisplayId: item.DisplayID, Title: nullableString(item.Title), Status: openapi.MachineJobStatus(item.Status), Artifact: artifact, PriceAdjustment: adjustment, Machine: mlMachineDTO(item.Machine), Runs: mlRunDTOs(item.Runs), StartedAt: nullableValue(item.StartedAt), EndedAt: nullableValue(item.EndedAt), ExpectedEndAt: nullableValue(item.ExpectedEndAt), DurationSeconds: item.DurationSeconds, Customer: customer, Operator: operator, Outcome: openapi.MachineJobOutcome(item.Outcome), OutcomeOverridden: item.OutcomeOverridden, Notes: nullableString(item.Notes), PricingStatus: openapi.PricingStatus(item.PricingStatus), PricingSnapshot: snapshot, CalculatedPrice: nullableMoney(item.CalculatedPrice), EffectivePrice: nullableMoney(item.EffectivePrice), Version: item.Version, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}

func mlArtifactReferenceDTO(item machinelogbook.ArtifactReference) openapi.PrintArtifactReference {
	return openapi.PrintArtifactReference{Id: item.ID, Sha256: item.SHA256, ParserStatus: openapi.PrintArtifactParserStatus(item.ParserStatus)}
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
	result := openapi.MachineLogbookOverview{JobsToday: item.JobsToday, JobsThisWeek: item.JobsThisWeek, UnassignedJobs: item.UnassignedJobs, UnassignedEstimatedAmount: item.UnassignedEstimatedAmount, FailedOrPartialThisWeek: item.FailedOrPartialThisWeek, LowStockItems: item.LowStockItems, RecentJobs: jobs, LowStockMaterials: materials, Activity: activity,
		RunningNow: nullable.NewNullNullable[int64](), RunningMachineNames: nullable.NewNullNullable[[]string](), NeedsOutcome: nullable.NewNullNullable[int64](), UnassignedRuns: nullable.NewNullNullable[int64](),
		BillingIssues: nullable.NewNullNullable[int64](), ActiveItems: nullable.NewNullNullable[[]openapi.WorkItem](), ActiveTotal: nullable.NewNullNullable[int64]()}
	mlOverviewWorkItemsDTO(item, &result)
	return result
}
func mlStatisticPoints(items []machinelogbook.StatisticPoint) []openapi.StatisticPoint {
	result := make([]openapi.StatisticPoint, 0, len(items))
	for _, item := range items {
		result = append(result, openapi.StatisticPoint{Key: item.Key, Label: item.Label, Value: item.Value})
	}
	return result
}
func mlStatisticsDTO(item machinelogbook.Statistics) openapi.MachineLogbookStatistics {
	months := make([]openapi.StatisticMonth, 0, len(item.Months))
	for _, m := range item.Months {
		months = append(months, openapi.StatisticMonth{Month: m.Month, Charges: m.Charges, MaterialCost: m.MaterialCost, Losses: m.Losses})
	}
	runtime := make([]openapi.StatisticRuntimePoint, 0, len(item.Runtime))
	for _, r := range item.Runtime {
		runtime = append(runtime, openapi.StatisticRuntimePoint{BucketStart: openapi_types.Date{Time: r.BucketStart}, MachineId: r.MachineID, Hours: r.Hours})
	}
	machines := make([]openapi.StatisticMachine, 0, len(item.Machines))
	for _, m := range item.Machines {
		machines = append(machines, openapi.StatisticMachine{MachineId: m.MachineID, Name: m.Name, MachineTypeName: m.MachineTypeName, Jobs: m.Jobs, RuntimeHours: m.RuntimeHours, FailureRate: m.FailureRate, Charges: m.Charges, RuntimeShare: m.RuntimeShare})
	}
	return openapi.MachineLogbookStatistics{MaterialUsageByCategory: mlStatisticPoints(item.MaterialUsageByCategory), MachineRuntimeHours: mlStatisticPoints(item.MachineRuntimeHours), MachineJobCounts: mlStatisticPoints(item.MachineJobCounts), AcquisitionCost: mlStatisticPoints(item.AcquisitionCost), CustomerCharges: mlStatisticPoints(item.CustomerCharges), AdjustmentLoss: mlStatisticPoints(item.AdjustmentLoss), MachineFailureRates: mlStatisticPoints(item.MachineFailureRates),
		Totals: mlStatisticTotalsDTO(item.Totals), PreviousTotals: mlStatisticTotalsDTO(item.PreviousTotals), Months: months, RuntimeGranularity: openapi.MachineLogbookStatisticsRuntimeGranularity(item.RuntimeGranularity),
		Runtime: runtime, MaterialCostByCategory: mlStatisticPoints(item.MaterialCostByCategory), Machines: machines}
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
		materialID := uuid.Nil
		if value := uuidNullable(v.MaterialId); value != nil {
			materialID = *value
		}
		items = append(items, machinelogbook.UsageInput{MaterialID: materialID, SpoolID: uuidNullable(v.SpoolId), Ownership: string(v.Ownership), ExternalMaterialName: nullableStringPointer(v.ExternalMaterialName), Quantity: string(v.Quantity), QuantityBasis: string(v.QuantityBasis)})
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

func mlWorkItemDTO(item machinelogbook.WorkItem) openapi.WorkItem {
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
	var billing nullable.Nullable[openapi.WorkItemBilling]
	if item.Billing == nil {
		billing = nullable.NewNullNullable[openapi.WorkItemBilling]()
	} else {
		billing = nullable.NewNullableWithValue(openapi.WorkItemBilling{State: openapi.JobBillingState(item.Billing.State), OrderId: nullableUUIDValue(item.Billing.OrderID), OrderReference: nullableString(item.Billing.OrderReference)})
	}
	var progress nullable.Nullable[int]
	if item.ProgressPercent == nil {
		progress = nullable.NewNullNullable[int]()
	} else {
		progress = nullable.NewNullableWithValue(*item.ProgressPercent)
	}
	version := openapi.Version(item.Version)
	return openapi.WorkItem{Kind: openapi.WorkItemKind(item.Kind), Id: item.ID, DisplayId: item.DisplayID, Title: nullableString(item.Title), FileName: nullableString(item.FileName),
		RunCount: item.RunCount, MachineId: item.MachineID, MachineName: item.MachineName,
		Customer: customer, Operator: operator, Status: openapi.WorkItemStatus(item.Status), Source: openapi.WorkItemSource(item.Source), StartedAt: item.StartedAt,
		EndsAt: nullableValue(item.EndsAt), EstimatedEndAt: nullableValue(item.EstimatedEndAt), ProgressPercent: progress, EffectivePrice: nullableMoney(item.EffectivePrice),
		Billing: billing, Version: &version}
}
func mlWorkItemDTOs(items []machinelogbook.WorkItem) []openapi.WorkItem {
	result := make([]openapi.WorkItem, 0, len(items))
	for _, item := range items {
		result = append(result, mlWorkItemDTO(item))
	}
	return result
}
func mlMachineActivityDTO(item machinelogbook.MachineActivity) openapi.MachineActivity {
	current := nullable.NewNullNullable[openapi.MachineCurrentItem]()
	if item.Current != nil {
		current = nullable.NewNullableWithValue(openapi.MachineCurrentItem{Kind: openapi.MachineCurrentItemKind(item.Current.Kind), Id: item.Current.ID, DisplayId: item.Current.DisplayID,
			Title: nullableString(item.Current.Title), FileName: nullableString(item.Current.FileName), StartedAt: item.Current.StartedAt, EndsAt: nullableValue(item.Current.EndsAt)})
	}
	connector := nullable.NewNullNullable[openapi.MachineConnectorState]()
	if item.Connector != nil {
		state := nullable.NewNullNullable[openapi.MachineConnectorStateRuntimeState]()
		if item.Connector.RuntimeState != nil {
			state = nullable.NewNullableWithValue(openapi.MachineConnectorStateRuntimeState(*item.Connector.RuntimeState))
		}
		connector = nullable.NewNullableWithValue(openapi.MachineConnectorState{RuntimeState: state, RuntimeErrorCode: nullableString(item.Connector.RuntimeErrorCode), LastHeartbeatAt: nullableValue(item.Connector.LastHeartbeatAt)})
	}
	return openapi.MachineActivity{MachineId: item.MachineID, Availability: openapi.MachineAvailability(item.Availability), Current: current, Connector: connector, LastJobStartedAt: nullableValue(item.LastJobStartedAt)}
}
func mlStatisticTotalsDTO(item machinelogbook.StatisticTotals) openapi.StatisticTotals {
	return openapi.StatisticTotals{Jobs: item.Jobs, RuntimeHours: item.RuntimeHours, Charges: item.Charges, MaterialCost: item.MaterialCost, FailureRate: item.FailureRate}
}
func mlOverviewWorkItemsDTO(item machinelogbook.Overview, result *openapi.MachineLogbookOverview) {
	if item.RunningNow == nil {
		return // the caller may not read machine jobs
	}
	result.RunningNow = nullable.NewNullableWithValue(*item.RunningNow)
	result.NeedsOutcome = nullable.NewNullableWithValue(*item.NeedsOutcome)
	result.UnassignedRuns = nullable.NewNullableWithValue(*item.UnassignedRuns)
	result.BillingIssues = nullable.NewNullableWithValue(*item.BillingIssues)
	result.ActiveTotal = nullable.NewNullableWithValue(*item.ActiveTotal)
	result.RunningMachineNames = nullable.NewNullableWithValue(append([]string{}, item.RunningMachineNames...))
	result.ActiveItems = nullable.NewNullableWithValue(mlWorkItemDTOs(item.ActiveItems))
}
