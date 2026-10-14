// Prototype-only domain types. They mirror the generated OpenAPI models
// (src/api/generated/models) closely enough that the screens can later be wired
// to the real queries without reshaping the UI. No field here is invented:
// derived values (e.g. machine activity) are computed in `derived.ts`.

export type MachineStatus = 'active' | 'maintenance' | 'retired';
export type JobOutcome = 'successful' | 'partial_failure' | 'failed' | 'cancelled' | 'unknown';
export type JobSource = 'manual' | 'automatic';
export type JobRun = 'manual' | 'automatic';
export type Ownership = 'makerspace' | 'external';
export type QuantityBasis = 'actual' | 'estimated';
export type PrintState = 'printing' | 'finished' | 'failed' | 'cancelled';
export type ConnectorRuntimeState = 'connecting' | 'connected' | 'disconnected' | 'degraded' | 'disabled';
export type ConnectorLifecycle = 'pending' | 'active' | 'disabled' | 'revoked';
export type ConnectorHealth = 'healthy' | 'degraded' | 'offline';
export type AdapterKind = 'bambu_h2d' | 'simulator';
export type PrinterModelId = 'bambu_h2d' | 'bambu_x1c' | 'prusa_core_one' | 'generic';
export type Nozzle = 'left' | 'right';
export type SlotStatus = 'available' | 'unavailable' | 'retired';
export type PrinterEventKind = 'operational_state' | 'progress' | 'consumption_report' | 'terminal_outcome' | 'connectivity';

export type MachineType = { id: string; name: string; active: boolean };

/** A printer connector host (the agent that runs next to the printers). Printers are assigned to it from the printer, not from here. */
export type ConnectorEventKind =
  | 'operational_state' | 'progress' | 'filament_change' | 'consumption_report' | 'terminal_outcome' | 'hms_error' | 'connectivity'
  | 'config_applied' | 'heartbeat_restored';
export type ConnectorHostEvent = {
  id: string;
  kind: ConnectorEventKind;
  receivedAt: string;
  /** The printer the event belongs to; null for connector-level events (heartbeat, configuration, enrollment). */
  machineId: string | null;
  /** Readable one-liner derived from the payload. */
  summary: string;
  /** Set when Core quarantined the event instead of accepting it. */
  quarantine: { reason: string } | null;
  payload: object;
};
export type ConnectorHost = {
  id: string;
  name: string;
  locationLabel: string | null;
  lifecycle: ConnectorLifecycle;
  healthState: ConnectorHealth;
  lastHeartbeatAt: string | null;
  softwareVersion: string | null;
  /** Configuration revision the connector confirmed vs. the one Core wants it to run. */
  configRevisionApplied: number;
  configRevisionDesired: number;
  pendingEventCount: number;
  quarantinedEventCount: number;
  events: ConnectorHostEvent[];
};

/** How one printer reaches its connector. The LAN access code is a secret: only `accessCodeSet` is ever kept or shown. */
export type MachineConnection = {
  connectorId: string;
  adapterKind: AdapterKind;
  ipAddress: string | null;
  serialNumber: string | null;
  accessCodeSet: boolean;
  autoMountRfid: boolean;
  enabled: boolean;
  runtimeState: ConnectorRuntimeState;
  runtimeErrorCode: string | null;
  lastHeartbeatAt: string | null;
};

export type Machine = {
  id: string;
  name: string;
  machineTypeId: string;
  status: MachineStatus;
  /** Printer model for 3D-printer machines; drives the setup template and the available adapter. */
  modelId: PrinterModelId | null;
  automaticCollectionEnabled: boolean;
  lastIngestedAt: string | null;
  jobCount: number;
  runtimeSeconds: number;
  failureRate: number;
  createdAt: string;
  updatedAt: string;
  connection: MachineConnection | null;
  version: number;
};

export type BillingParty = { kind: 'person' | 'organization'; id: string; displayName: string; pricingGroup: string };
export type Operator = { personId: string; displayName: string };

export type MaterialUnit = 'g' | 'ml' | 'pcs' | 'm2';
export type Material = {
  id: string;
  name: string;
  category: string;
  unit: MaterialUnit;
  active: boolean;
  /** Free-text colour, mainly for filament and resin. */
  color: string | null;
  /** Filament diameter in mm; set for filament only. */
  diameterMm: number | null;
  /** Stock at or below this quantity counts as low. Null: no threshold. */
  lowStockThreshold: number | null;
  /** Current stock in `unit`, including what is held on spools. */
  quantity: number;
  /** Weighted average acquisition cost per `unit` (EUR). Null until a priced purchase exists. */
  avgCostPerUnit: number | null;
};

export type SpoolLifecycle = 'active' | 'empty' | 'archived';
export type IdentifierKind = 'nfc' | 'barcode' | 'qr' | 'other';
export type SpoolIdentifier = { id: string; kind: IdentifierKind; value: string; addedAt: string };
export type SpoolStockSource = 'purchase' | 'stock';
/** Reusable spools (e.g. Bambu AMS spools) are refilled many times; single-use spools are archived once finished. */
export type SpoolKind = 'reusable' | 'single_use';
/** What happened to the filament left on a spool when its fill was closed. */
export type LeftoverOutcome = 'used_up' | 'returned_to_stock' | 'disposed';

/** `refill`: filament only, for reusable spools. `spool`: comes on its own single-use spool. */
export type FilamentPackaging = 'refill' | 'spool';
/**
 * Catalog entry for a purchasable filament product. A product is chosen once when registering a spool or changing
 * filament and fills in material, net weight and the purchase price. FUTURE backend capability: no catalog entity exists in the API today.
 */
export type FilamentProduct = {
  id: string;
  manufacturer: string;
  name: string;
  /** The inventory material whose stock the grams count towards and which drives job pricing via its category. */
  materialId: string;
  netWeightG: number;
  /** EUR per unit bought (one refill or one spool). */
  defaultPrice: number | null;
  packaging: FilamentPackaging;
  notes: string | null;
  active: boolean;
};

/** A closed fill of a spool: one filling of the physical spool with one filament, kept as history. */
export type SpoolFill = {
  id: string;
  fillNumber: number;
  materialId: string;
  materialName: string;
  /** Catalog reference; manufacturer and productName stay as snapshot text. */
  productId: string | null;
  manufacturer: string | null;
  productName: string | null;
  initialNetWeightG: number;
  usedG: number;
  leftoverG: number;
  leftoverOutcome: LeftoverOutcome;
  filledAt: string;
  closedAt: string;
  /** The tags that belonged to this fill. */
  identifiers: SpoolIdentifier[];
};

/**
 * A physical spool. Material, remaining, initial weight, manufacturer, product and identifiers describe the CURRENT FILL.
 * A reusable spool without a current fill (lifecycle `empty`, "Needs refill") has an empty `materialId` and zero weights.
 * `fillNumber` is the current fill, or the most recent closed one while the spool waits for a refill.
 */
export type Spool = {
  id: string;
  displayId: string;
  kind: SpoolKind;
  /** Optional name, e.g. "Bambu spool 03". */
  label: string | null;
  fillNumber: number;
  filledAt: string | null;
  fills: SpoolFill[];
  /** Set when the spool was archived; single-use spools are cleaned up by this date. */
  archivedAt: string | null;
  materialId: string;
  materialName: string;
  color: string;
  remainingQuantity: number;
  mounted: boolean;
  initialNetWeightG: number;
  tareWeightG: number | null;
  /** Catalog reference of the current fill; manufacturer and productName stay as snapshot text. */
  productId: string | null;
  manufacturer: string | null;
  productName: string | null;
  storageLocation: string | null;
  lifecycle: SpoolLifecycle;
  /** ISO date (yyyy-mm-dd). */
  acquiredOn: string;
  acquisitionReference: string | null;
  /** Total purchase price (EUR) when the spool was bought as a spool. */
  purchasePrice: number | null;
  notes: string | null;
  identifiers: SpoolIdentifier[];
};

/** `transfer` moves stock from general stock onto a spool; it never changes the material total. */
export type InventoryTransactionKind = 'purchase' | 'consumption' | 'correction' | 'disposal' | 'transfer';
export type InventoryTransaction = {
  id: string;
  materialId: string;
  spoolId: string | null;
  /** Snapshots: they survive the deletion of the spool. */
  spoolDisplayId: string | null;
  fillNumber: number | null;
  kind: InventoryTransactionKind;
  /** Signed change in the material's unit. Transfers carry the (positive) moved amount. */
  quantity: number;
  unitCost: number | null;
  /** Signed value in EUR, same sign as `quantity`. */
  totalValue: number | null;
  jobId: string | null;
  supplier: string | null;
  note: string | null;
  occurredAt: string;
  by: string;
};

export type JobUsage = {
  id: string;
  ownership: Ownership;
  materialId: string | null;
  spoolId: string | null;
  spoolDisplayId: string | null;
  materialName: string;
  category: string;
  unit: string;
  quantity: number;
  quantityBasis: QuantityBasis;
};

export type PricingRule = { label: string; rate: string; unit: string; missing: boolean };

export type PricingSnapshot = {
  revision: number;
  pricingGroupName: string;
  reason: 'initial' | 'customer_changed' | 'machine_changed' | 'manual_reprice';
  capturedAt: string;
  rules: PricingRule[];
};

export type OrderAssociation = { orderId: string; orderReference: string; sourceChanged: boolean };

export type PriceAdjustmentKind = 'fixed' | 'discount_percent' | 'discount_amount' | 'multiplier';
export type PriceAdjustment = { kind: PriceAdjustmentKind; value: number; reason: string };

export type Job = {
  id: string;
  displayId: string;
  /** Optional staff-chosen name. Prints keep the name their printer reported (fileName). */
  title: string | null;
  machineId: string;
  startsAt: string;
  endsAt: string;
  durationSeconds: number;
  /** manual: entered by staff (a future end means a simulated run); automatic: replaced by a linked print. */
  run: JobRun;
  printId: string | null;
  source: JobSource;
  externalId: string | null;
  customer: BillingParty | null;
  operator: Operator | null;
  outcome: JobOutcome;
  notes: string | null;
  usages: JobUsage[];
  pricingStatus: 'pending' | 'complete' | 'incomplete';
  pricingSnapshot: PricingSnapshot | null;
  calculatedPrice: number | null;
  /** Manual change to the calculated price. Relative kinds re-apply when the calculated price changes. */
  priceAdjustment: PriceAdjustment | null;
  order: OrderAssociation | null;
  version: number;
};

export type PrinterEvent = {
  id: string;
  kind: PrinterEventKind;
  occurredAt: string;
  sourceId: string;
  summary: string;
};

export type PrintUsage = { materialId: string | null; materialName: string; spoolDisplayId: string | null; quantity: number; unit: string };

/** An automatic run reported by a printer connector. Nobody creates prints by hand. */
export type Print = {
  id: string;
  displayId: string;
  machineId: string;
  fileName: string;
  state: PrintState;
  startedAt: string;
  endedAt: string | null;
  estimatedEndAt: string | null;
  /** 0-100 while printing. */
  progress: number | null;
  reportedUsage: PrintUsage | null;
  events: PrinterEvent[];
  linkedJobId: string | null;
  connectorName: string;
};

export type InputUnit = { id: string; machineId: string; name: string; position: number; externalIdentifier: string | null; nozzle: Nozzle | null };
export type Slot = { id: string; inputUnitId: string; name: string; position: number; status: SlotStatus; spoolId: string | null; externalIdentifier: string | null };
export type PrinterProfile = { machineId: string; enabled: boolean; inputUnits: InputUnit[]; slots: Slot[] };

/** One tray as reported in the printer's status JSON (print.ams.ams[].tray[] or print.vir_slot[]). */
export type DetectedTray = {
  externalId: string;
  materialType: string | null;
  subBrand: string | null;
  /** RGB hex without alpha, e.g. "FFF144". */
  colorHex: string | null;
  remainPercent: number | null;
  rfid: boolean;
  empty: boolean;
};
export type DetectedUnit = {
  externalId: string;
  kind: 'ams_2_pro' | 'ams_ht' | 'external';
  label: string;
  nozzle: Nozzle;
  humidityPercent: number | null;
  temperatureC: number | null;
  trays: DetectedTray[];
};
export type DetectedPrinterState = {
  firmware: string;
  nozzles: { id: string; side: Nozzle; diameter: number; type: string }[];
  units: DetectedUnit[];
};

export type PrinterModelTemplate = {
  name: string;
  externalIdentifier: string | null;
  nozzle: Nozzle | null;
  slots: { name: string; externalIdentifier: string | null }[];
};
export type PrinterModel = {
  id: PrinterModelId;
  label: string;
  description: string;
  /** Only the H2D has a live adapter; the simulator adapter works with any model for testing. */
  adapterKind: AdapterKind | null;
  nozzles: number;
  template: PrinterModelTemplate[];
};

export type PrinterRunState = 'idle' | 'preparing' | 'printing' | 'paused' | 'finished' | 'failed';
export type HmsEntry = { code: string; attr: string; at: string; meaning: string | null };
/** Latest status snapshot of one printer, modelled on the Bambu H2D MQTT report (print.*). */
export type PrinterLiveStatus = {
  receivedAt: string;
  /** From `gcode_state`. */
  state: PrinterRunState;
  job: { fileName: string; progressPercent: number; layer: number; totalLayers: number; remainingMinutes: number } | null;
  temperatures: { nozzles: { side: Nozzle; currentC: number; targetC: number }[]; bedC: number; bedTargetC: number; chamberC: number | null };
  nozzles: { side: Nozzle; diameterMm: number; type: string }[];
  /** `ams.tray_now`, resolved to its AMS unit and tray. */
  activeTray: { unitExternalId: string; trayExternalId: string } | null;
  hms: HmsEntry[];
  printError: string | null;
  wifiSignalDbm: number | null;
  firmware: string;
  /** Fields the connector could not refresh with the last report. */
  staleFields?: string[];
};
