package machinelogbook

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
	RunEventTerminalOutcome   RunEventKind = "terminal_outcome"
	RunEventConsumptionReport RunEventKind = "consumption_report"
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

const EstimateQualityUnresolved EstimateQuality = "unresolved"

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

// SpoolKind says whether a spool is refilled or thrown away when empty.
type SpoolKind string

const (
	SpoolReusable  SpoolKind = "reusable"
	SpoolSingleUse SpoolKind = "single_use"
)

// SpoolStatus is the display status derived from a spool's lifecycle, kind
// and open fill.
type SpoolStatus string

const (
	SpoolStatusLoaded      SpoolStatus = "loaded"
	SpoolStatusNeedsRefill SpoolStatus = "needs_refill"
	SpoolStatusActive      SpoolStatus = "active"
	SpoolStatusArchived    SpoolStatus = "archived"
)

// IdentifierKind is the code type of a spool identifier.
type IdentifierKind string

const (
	IdentifierBarcode IdentifierKind = "barcode"
	IdentifierQR      IdentifierKind = "qr"
	IdentifierNFC     IdentifierKind = "nfc"
)

// StockMode is how the stock of a new spool entered inventory.
type StockMode string

const (
	StockModeNewAcquisition StockMode = "new_acquisition"
	StockModeExistingStock  StockMode = "existing_stock"
	StockModeEmpty          StockMode = "empty"
)

// LeftoverBasis is how the leftover of a closed fill was determined.
type LeftoverBasis string

const (
	LeftoverSystem  LeftoverBasis = "system"
	LeftoverWeighed LeftoverBasis = "weighed"
	LeftoverNone    LeftoverBasis = "none"
)

// LeftoverDisposition is what happens to the leftover of a closed fill.
type LeftoverDisposition string

const (
	DispositionReturnedToStock LeftoverDisposition = "returned_to_stock"
	DispositionDisposed        LeftoverDisposition = "disposed"
)

// FillOutcome is how a closed fill ended.
type FillOutcome string

const (
	FillUsedUp          FillOutcome = "used_up"
	FillReturnedToStock FillOutcome = FillOutcome(DispositionReturnedToStock)
	FillDisposed        FillOutcome = FillOutcome(DispositionDisposed)
)

// FillSource is where the material of a new fill comes from.
type FillSource string

const (
	FillSourceLooseStock FillSource = "loose_stock"
	FillSourcePurchase   FillSource = "purchase"
)

// PlacementMode is where received filament goes.
type PlacementMode string

const (
	PlacementStorage       PlacementMode = "storage"
	PlacementNewSpools     PlacementMode = "new_spools"
	PlacementReusableSpool PlacementMode = "reusable_spool"
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

// MaterialUnit is the unit a material type is counted in.
type MaterialUnit string

const (
	UnitGram             MaterialUnit = "g"
	UnitMeter            MaterialUnit = "m"
	UnitMilliliter       MaterialUnit = "ml"
	UnitSquareMeter      MaterialUnit = "m2"
	UnitSquareCentimeter MaterialUnit = "cm2"
	UnitPiece            MaterialUnit = "piece"
)

// SortDirection orders a listing.
type SortDirection string

const (
	SortAsc  SortDirection = "asc"
	SortDesc SortDirection = "desc"
)
