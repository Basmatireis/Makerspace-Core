package machinelogbook

import (
	"time"

	"github.com/google/uuid"
)

// MachineStatus is whether a machine can take work.
type MachineStatus string

const (
	MachineStatusActive      MachineStatus = "active"
	MachineStatusMaintenance MachineStatus = "maintenance"
	MachineStatusRetired     MachineStatus = "retired"
)

// MachineAvailability is what a machine can do right now.
type MachineAvailability string

const (
	AvailabilityAvailable   MachineAvailability = "available"
	AvailabilityInUse       MachineAvailability = "in_use"
	AvailabilityMaintenance MachineAvailability = MachineAvailability(MachineStatusMaintenance)
	AvailabilityRetired     MachineAvailability = MachineAvailability(MachineStatusRetired)
)

// RunOutcome is how a machine run ended.
type RunOutcome string

const (
	RunOutcomeSuccessful     RunOutcome = "successful"
	RunOutcomePartialFailure RunOutcome = "partial_failure"
	RunOutcomeFailed         RunOutcome = "failed"
	RunOutcomeCancelled      RunOutcome = "cancelled"
)

// JobOutcome is how a machine job ended; it is unknown until staff or a
// machine report one.
type JobOutcome string

const (
	JobOutcomeUnknown        JobOutcome = "unknown"
	JobOutcomeSuccessful     JobOutcome = JobOutcome(RunOutcomeSuccessful)
	JobOutcomePartialFailure JobOutcome = JobOutcome(RunOutcomePartialFailure)
	JobOutcomeFailed         JobOutcome = JobOutcome(RunOutcomeFailed)
	JobOutcomeCancelled      JobOutcome = JobOutcome(RunOutcomeCancelled)
)

// JobStatus is the lifecycle position of a machine job.
type JobStatus string

const (
	JobStatusPlanned        JobStatus = "planned"
	JobStatusRunning        JobStatus = "running"
	JobStatusNeedsOutcome   JobStatus = "needs_outcome"
	JobStatusSuccessful     JobStatus = "successful"
	JobStatusPartialFailure JobStatus = "partial_failure"
	JobStatusFailed         JobStatus = "failed"
	JobStatusCancelled      JobStatus = "cancelled"
)

// RunSource tells who created a run.
type RunSource string

const (
	RunSourceManual   RunSource = "manual"
	RunSourceRecorded RunSource = "recorded"
)

// RunState is the derived state of a run.
type RunState string

const (
	RunStateRunning   RunState = "running"
	RunStateFinished  RunState = "finished"
	RunStateFailed    RunState = "failed"
	RunStateCancelled RunState = "cancelled"
	RunStateUnknown   RunState = "unknown"
	RunStateReplaced  RunState = "replaced"
)

// RunEventKind is what a machine connector event reported.
type RunEventKind string

const (
	RunEventOperationalState  RunEventKind = "operational_state"
	RunEventTerminalOutcome   RunEventKind = "terminal_outcome"
	RunEventConsumptionReport RunEventKind = "consumption_report"
	RunEventPrinterError      RunEventKind = "printer_error"
	RunEventFilamentChange    RunEventKind = "filament_change"
)

// UsageOwnership says whether a material usage came from the makerspace's
// inventory or from the customer.
type UsageOwnership string

const (
	OwnershipMakerspace UsageOwnership = "makerspace"
	OwnershipExternal   UsageOwnership = "external"
)

// QuantityBasis says whether a usage quantity was measured or estimated.
type QuantityBasis string

const (
	QuantityBasisActual    QuantityBasis = "actual"
	QuantityBasisEstimated QuantityBasis = "estimated"
)

// EstimateQuality is how reliable a reported usage item is.
type EstimateQuality string

const (
	EstimateQualityHigh       EstimateQuality = "high"
	EstimateQualityMedium     EstimateQuality = "medium"
	EstimateQualityLow        EstimateQuality = "low"
	EstimateQualityUnresolved EstimateQuality = "unresolved"
)

// PartyKind is the kind of a billing party.
type PartyKind string

const (
	PartyPerson       PartyKind = "person"
	PartyOrganization PartyKind = "organization"
)

// OrganizationKind is the legal form of an organization.
type OrganizationKind string

const (
	OrganizationCompany     OrganizationKind = "company"
	OrganizationInstitute   OrganizationKind = "institute"
	OrganizationAssociation OrganizationKind = "association"
	OrganizationOther       OrganizationKind = "other"
)

// PricingRuleKind is what a pricing rule prices.
type PricingRuleKind string

const (
	PricingRuleMachineRuntime PricingRuleKind = "machine_runtime"
	PricingRuleMaterial       PricingRuleKind = "material"
	PricingRuleMachineMeasure PricingRuleKind = "machine_measure"
	PricingRuleStockArticle   PricingRuleKind = "stock_article"
)

// PriceAdjustmentKind is how staff changed a calculated price.
type PriceAdjustmentKind string

const (
	AdjustmentFixed           PriceAdjustmentKind = "fixed"
	AdjustmentDiscountPercent PriceAdjustmentKind = "discount_percent"
	AdjustmentDiscountAmount  PriceAdjustmentKind = "discount_amount"
	AdjustmentMultiplier      PriceAdjustmentKind = "multiplier"
)

// PricingStatus is whether every priced part of a job has a price.
type PricingStatus string

const (
	PricingComplete   PricingStatus = "complete"
	PricingIncomplete PricingStatus = "incomplete"
)

// SnapshotReason is why a pricing snapshot was captured.
type SnapshotReason string

const (
	SnapshotInitial         SnapshotReason = "initial"
	SnapshotManualReprice   SnapshotReason = "manual_reprice"
	SnapshotMachineChanged  SnapshotReason = "machine_changed"
	SnapshotCustomerChanged SnapshotReason = "customer_changed"
)

// SpoolLifecycle says whether a spool is in use or archived.
type SpoolLifecycle string

const (
	SpoolActive   SpoolLifecycle = "active"
	SpoolArchived SpoolLifecycle = "archived"
)

// IdentifierKind is the code type of a spool identifier.
type IdentifierKind string

const (
	IdentifierBarcode IdentifierKind = "barcode"
	IdentifierQR      IdentifierKind = "qr"
	IdentifierNFC     IdentifierKind = "nfc"
	// IdentifierBambuTrayUUID is the tray_uuid both RFID chips of a Bambu spool store.
	IdentifierBambuTrayUUID IdentifierKind = "bambu_tray_uuid"
)

// StockMode is how the stock of a new spool entered inventory.
type StockMode string

const (
	StockModeNewAcquisition StockMode = "new_acquisition"
	StockModeExistingStock  StockMode = "existing_stock"
)

// PlacementMode is where received filament goes.
type PlacementMode string

const (
	PlacementStorage   PlacementMode = "storage"
	PlacementNewSpools PlacementMode = "new_spools"
)

// StockState classifies the stock level of a material.
type StockState string

const (
	StockEmpty   StockState = "empty"
	StockLow     StockState = "low_stock"
	StockInStock StockState = "in_stock"
)

// InventoryKind is the kind of an inventory ledger movement.
type InventoryKind string

const (
	InventoryPurchase           InventoryKind = "purchase"
	InventoryAdjustment         InventoryKind = "adjustment"
	InventoryDisposal           InventoryKind = "disposal"
	InventoryManualConsumption  InventoryKind = "manual_consumption"
	InventoryMachineConsumption InventoryKind = "machine_run_consumption"
	InventorySpoolTransfer      InventoryKind = "spool_transfer"
	InventoryOrderSale          InventoryKind = "order_sale"
	InventoryOrderSaleReversal  InventoryKind = "order_sale_reversal"
)

// WorkItemKind says whether a work item is a job or an unassigned run.
type WorkItemKind string

const (
	WorkItemJob WorkItemKind = "job"
	WorkItemRun WorkItemKind = "run"
)

// WorkItemStatus is the status of a row of the unified work table.
type WorkItemStatus string

const (
	WorkItemPlanned           WorkItemStatus = "planned"
	WorkItemRunning           WorkItemStatus = "running"
	WorkItemRunningUnassigned WorkItemStatus = "running_unassigned"
	WorkItemUnassigned        WorkItemStatus = "unassigned"
	WorkItemNeedsOutcome      WorkItemStatus = "needs_outcome"
	WorkItemSuccessful        WorkItemStatus = "successful"
	WorkItemPartialFailure    WorkItemStatus = "partial_failure"
	WorkItemFailed            WorkItemStatus = "failed"
	WorkItemCancelled         WorkItemStatus = "cancelled"
)

// BillingState is where a job stands in billing.
type BillingState string

const (
	BillingOnOrder         BillingState = "on_order"
	BillingOrderOutdated   BillingState = "order_outdated"
	BillingNotOnOrder      BillingState = "not_on_order"
	BillingPriceIncomplete BillingState = "price_incomplete"
	BillingPending         BillingState = "pending"
)

// MaterialKind is the kind of an article; it comes from the article's material
// type. Filament and consumables are used in machine runs, parts are only
// counted and sold.
type MaterialKind string

const (
	KindFilament   MaterialKind = "filament"
	KindConsumable MaterialKind = "consumable"
	KindPart       MaterialKind = "part"
)

// MaterialUnit is a unit of a material type (its reference unit) or of an article (any unit of the type's dimension).
type MaterialUnit string

const (
	UnitGram             MaterialUnit = "g"
	UnitKilogram         MaterialUnit = "kg"
	UnitMillimeter       MaterialUnit = "mm"
	UnitCentimeter       MaterialUnit = "cm"
	UnitMeter            MaterialUnit = "m"
	UnitSquareCentimeter MaterialUnit = "cm2"
	UnitSquareMeter      MaterialUnit = "m2"
	UnitMilliliter       MaterialUnit = "ml"
	UnitLiter            MaterialUnit = "l"
	UnitPiece            MaterialUnit = "piece"
)

// SortDirection orders a listing.
type SortDirection string

const (
	SortAsc  SortDirection = "asc"
	SortDesc SortDirection = "desc"
)

// SpoolRetireOutcome is why a spool was retired: it ran empty, or the rest was thrown away.
type SpoolRetireOutcome string

const (
	SpoolRetiredEmpty     SpoolRetireOutcome = "empty"
	SpoolRetiredDiscarded SpoolRetireOutcome = "discarded"
)

// AttentionCode names something on a job, run, machine, order, article or spool that needs someone's attention.
type AttentionCode string

const (
	AttentionRunFailed              AttentionCode = "run_failed"
	AttentionConsumptionUnconfirmed AttentionCode = "consumption_unconfirmed"
	AttentionNoRecipient            AttentionCode = "no_recipient"
	AttentionNotOnOrder             AttentionCode = "not_on_order"
	AttentionNeedsOutcome           AttentionCode = "needs_outcome"
	AttentionPriceIncomplete        AttentionCode = "price_incomplete"
	AttentionOrderOutdated          AttentionCode = "order_outdated"
	AttentionConnectorOffline       AttentionCode = "connector_offline"
	AttentionConnectorError         AttentionCode = "connector_error"
	AttentionPrinterErrorOpen       AttentionCode = "printer_error_open"
	AttentionOutOfOrder             AttentionCode = "out_of_order"
	AttentionRunsUnassigned         AttentionCode = "runs_unassigned"
	AttentionLowStock               AttentionCode = "low_stock"
	AttentionRemainderLow           AttentionCode = "remainder_low"
	AttentionRanOutDuringRun        AttentionCode = "ran_out_during_run"
)

// Attention is one reason to look at an item, with a short English message for people.
type Attention struct {
	Code    AttentionCode
	Message string
}

// MaterialPriceSource says which rule an article's sale price comes from.
type MaterialPriceSource string

const (
	PriceFromStockArticle        MaterialPriceSource = "stock_article"
	PriceFromMaterialTypeVariant MaterialPriceSource = "material_type_variant"
	PriceFromMaterialType        MaterialPriceSource = "material_type"
)

// MaterialPrice is the sale price of an article in one pricing group.
type MaterialPrice struct {
	PricingGroupID   uuid.UUID
	PricingGroupName string
	Rate             string
	Source           MaterialPriceSource
	PricingRuleID    uuid.UUID
}

// StatisticsDetail holds the statistics aggregates beyond the totals, months and machines: when the workshop is
// busy, outcomes, weekly jobs, material per month and type, losses and charges per material type and the split by
// pricing group.
type StatisticsDetail struct {
	UsageByWeekdayHour    []StatisticWeekdayHour
	JobsByOutcome         []StatisticOutcomeCount
	JobsByWeek            []StatisticWeek
	MaterialByMonth       []StatisticMaterialMonth
	MaterialLossByType    []StatisticPoint
	MaterialChargesByType []StatisticPoint
	PricingGroups         []StatisticPricingGroup
	PricingGroupMonths    []StatisticPricingGroupMonth
}

// StatisticWeekdayHour is machine time in one hour of the week (Monday = 0) in the makerspace's time zone.
type StatisticWeekdayHour struct {
	Weekday, Hour int
	Runs          int64
	Minutes       string
}

type StatisticOutcomeCount struct {
	Outcome string
	Jobs    int64
}

type StatisticWeek struct {
	WeekStart time.Time
	Jobs      int64
}

type StatisticMaterialMonth struct {
	Month                                  string
	MaterialTypeID                         uuid.UUID
	MaterialTypeName, Unit, Quantity, Cost string
}

type StatisticPricingGroup struct {
	PricingGroupName   string
	Jobs               int64
	Charges, Discounts string
}

type StatisticPricingGroupMonth struct {
	Month, PricingGroupName, Charges string
}
