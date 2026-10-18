/* eslint-disable react-refresh/only-export-components -- store provider, hooks and role presets form one module */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as seed from './mockData';
import type {
  AdapterKind, BillingParty, ConnectorHost, DetectedPrinterState, PrinterLiveStatus, IdentifierKind, InventoryTransaction, InventoryTransactionKind, FilamentProduct, Job, JobOutcome, JobUsage, Machine, MachineStatus, MachineType, Material, Nozzle, Operator, Print, PrinterModelId, PrinterProfile, SlotStatus,
  PriceAdjustment, Spool, SpoolFill, SpoolIdentifier, SpoolKind, SpoolLifecycle, SpoolStockSource,
} from './types';
import { leftoverOutcome, planClose, type LeftoverChoice } from './fillPlan';
import { nameFromFile } from './derived';
import { outcomeFromRuns, planAttach, runsOfJob, runsSummary } from './runs';
import * as sales from './sales/engine';
import { CURRENT_ACTOR } from './sales/labels';
import { effectiveGroup, livePricing, quoteJob, setLivePricing, type PricingConfig } from './sales/pricing';
import { salesSeed } from './sales/mockData';
import type { Allocation, CustomerRecord, DaySession, InvoiceRequest, Order, OrderAdjustment, Payment, PaymentInput, SalesCounters } from './sales/types';

// ---------------------------------------------------------------------------
// Prototype controls: role presets and simulated data states.
// Role presets use the real permission IDs (see features/auth/permissions.ts).
// ---------------------------------------------------------------------------

export type Permission =
  | 'machines.read' | 'machines.manage' | 'machine_jobs.read' | 'machine_jobs.create'
  | 'machine_jobs.edit' | 'machine_jobs.delete' | 'machine_jobs.override_price'
  | 'printer_slots.assign' | 'inventory.read' | 'inventory.manage' | 'filament_spools.manage' | 'orders.read' | 'orders.write' | 'orders.finalize' | 'payments.read' | 'payments.record'
  | 'orders.reverse' | 'payments.reverse' | 'external_invoice_requests.read' | 'external_invoice_requests.manage' | 'pricing.read' | 'pricing.manage' | 'organizations.read' | 'organizations.manage'
  | 'statistics.read' | 'printer_connectors.read' | 'printer_connectors.manage' | 'printer_connectors.credentials.manage';

export type Role = 'supervisor' | 'operator' | 'viewer' | 'front_desk' | 'finance';
export type Scenario = 'normal' | 'loading' | 'error' | 'empty';
/** Outcome of the simulated "Test connection" call in the machine setup wizard. */
export type ConnectionTestMode = 'success' | 'unreachable' | 'wrong_code';

const ALL: Permission[] = [
  'machines.read', 'machines.manage', 'machine_jobs.read', 'machine_jobs.create', 'machine_jobs.edit', 'machine_jobs.delete', 'machine_jobs.override_price', 'printer_slots.assign', 'inventory.read', 'inventory.manage', 'filament_spools.manage',
  'orders.read', 'orders.write', 'orders.finalize', 'orders.reverse', 'payments.read', 'payments.record', 'payments.reverse', 'external_invoice_requests.read', 'external_invoice_requests.manage',
  'pricing.read', 'pricing.manage', 'organizations.read', 'organizations.manage', 'statistics.read', 'printer_connectors.read', 'printer_connectors.manage', 'printer_connectors.credentials.manage',
];

export const rolePresets: Record<Role, { label: string; description: string; permissions: Permission[] }> = {
  supervisor: { label: 'Workshop supervisor', description: 'All Machines & Jobs and Sales permissions', permissions: ALL },
  operator: { label: 'Operator', description: 'Creates jobs; no linking, pricing or machine setup', permissions: ['machines.read', 'machine_jobs.read', 'machine_jobs.create', 'printer_slots.assign', 'inventory.read'] },
  viewer: { label: 'Read-only', description: 'Can look up machines and jobs only', permissions: ['machines.read', 'machine_jobs.read'] },
  front_desk: {
    label: 'Front desk', description: 'Counter sales and payments; no reversals, no wiRef',
    permissions: ['machines.read', 'machine_jobs.read', 'machine_jobs.create', 'machine_jobs.override_price', 'inventory.read', 'orders.read', 'orders.write', 'orders.finalize', 'payments.read', 'payments.record', 'pricing.read'],
  },
  finance: {
    label: 'Finance', description: 'All sales, payments and invoicing; read-only workshop',
    permissions: ['machines.read', 'machine_jobs.read', 'inventory.read', 'statistics.read', 'orders.read', 'orders.write', 'orders.finalize', 'orders.reverse', 'payments.read', 'payments.record', 'payments.reverse', 'external_invoice_requests.read', 'external_invoice_requests.manage', 'pricing.read', 'pricing.manage', 'organizations.read', 'organizations.manage'],
  },
};

// ---------------------------------------------------------------------------
// Data store
// ---------------------------------------------------------------------------

type Data = {
  machines: Machine[];
  connectorHosts: ConnectorHost[];
  /** Last status the connector reported per machine (live slot contents). */
  detected: Record<string, DetectedPrinterState>;
  /** Latest status snapshot the connector reported per machine. */
  liveStatus: Record<string, PrinterLiveStatus>;
  machineTypes: MachineType[];
  jobs: Job[];
  prints: Print[];
  printerProfiles: PrinterProfile[];
  spools: Spool[];
  materials: Material[];
  products: FilamentProduct[];
  transactions: InventoryTransaction[];
  orders: Order[];
  payments: Payment[];
  allocations: Allocation[];
  adjustments: OrderAdjustment[];
  requests: InvoiceRequest[];
  counters: SalesCounters;
  customers: CustomerRecord[];
  daySessions: DaySession[];
  pricing: PricingConfig;
};

const initialData = (): Data => structuredClone({
  machines: seed.machines, connectorHosts: seed.connectorHosts, detected: seed.detectedStates, liveStatus: seed.liveStatuses, machineTypes: seed.machineTypes, jobs: salesSeed.jobs, prints: seed.prints,
  printerProfiles: seed.printerProfiles, spools: seed.spools, materials: seed.materials, products: seed.filamentProducts, transactions: seed.inventoryTransactions,
  orders: salesSeed.orders, payments: salesSeed.payments, allocations: salesSeed.allocations, adjustments: salesSeed.adjustments, requests: salesSeed.requests, counters: salesSeed.counters,
  customers: salesSeed.customers, daySessions: salesSeed.daySessions, pricing: salesSeed.pricing,
});

export type Toast = { id: number; kind: 'success' | 'error' | 'info'; title: string; subtitle?: string; /** A single follow-up link; shown as the action button of the notification. */ action?: { label: string; to: string } };

export type JobFactsInput = {
  title: string | null; machineId: string; startsAt: string; endsAt: string; customer: BillingParty | null; operator: Operator | null;
  outcome: JobOutcome; notes: string | null;
};
export type UsageInput = Omit<JobUsage, 'id' | 'spoolDisplayId' | 'category' | 'unit'> & { materialName?: string };

export type SeparateJobsShared = { customer: BillingParty; operator: Operator; pricingGroup: string | null };
export type DeleteSelectionInput = { jobIds: string[]; runIds: string[]; deleteRuns: boolean; material: 'reverse' | 'keep' | null };
export type DeleteSelectionResult = { jobs: number; runs: number; skipped: string[] };

export type MaterialInput = Pick<Material, 'name' | 'category' | 'unit' | 'color' | 'diameterMm' | 'lowStockThreshold' | 'active'> & { id?: string };
export type ProductInput = Omit<FilamentProduct, 'id'> & { id?: string };
export type MovementExtra = { totalPrice?: number | null; supplier?: string | null; note?: string | null; jobId?: string | null };
export type SpoolInput = {
  id?: string; kind: SpoolKind; label: string | null;
  /** Reusable spools can be registered empty and filled later. */
  withFill: boolean; materialId: string; initialNetWeightG: number; tareWeightG: number | null; manufacturer: string | null; productName: string | null; productId: string | null;
  storageLocation: string | null; acquiredOn: string; acquisitionReference: string | null; notes: string | null;
  source: SpoolStockSource; purchasePrice: number | null; supplier: string | null;
};

export type ChangeFilamentInput = {
  spoolId: string;
  /** What happens to the current fill; null when the spool is waiting for a refill. */
  leftover: LeftoverChoice | null;
  materialId: string; netWeightG: number; source: SpoolStockSource; totalPrice: number | null; supplier: string | null;
  manufacturer: string | null; productName: string | null; productId: string | null;
  keepIdentifierIds: string[]; added: { kind: IdentifierKind; value: string }[];
};

export type SetupSlotInput = { id?: string; name: string; externalIdentifier: string | null; status?: SlotStatus };
export type SetupUnitInput = { id?: string; name: string; externalIdentifier: string | null; nozzle: Nozzle | null; slots: SetupSlotInput[] };
export type SetupConnectionInput = { connectorId: string; adapterKind: AdapterKind; ipAddress: string | null; serialNumber: string | null; autoMountRfid: boolean };
/** `undefined` sections are left unchanged (edit mode shows one wizard step at a time). The access code is only used to flip `accessCodeSet`; it is never stored. */
export type MachineSetupInput = {
  id?: string; name: string; machineTypeId: string; status: MachineStatus; modelId: PrinterModelId | null;
  connection?: SetupConnectionInput | null; accessCode?: string; inputUnits?: SetupUnitInput[] | null; detected?: DetectedPrinterState | null;
};

type Actions = {
  createConnector: (name: string, location: string | null) => string;
  /** Issues a fresh enrollment secret for a pending connector. */
  enrollConnector: (id: string) => string;
  setConnectorEnabled: (id: string, enabled: boolean) => void;
  revokeConnector: (id: string) => void;
  /** Simulated status probe; rejects with an Error whose message is `unreachable` or `wrong_code` depending on the prototype control. */
  detectPrinter: (connection: Pick<SetupConnectionInput, 'adapterKind'>, modelId?: PrinterModelId | null) => Promise<DetectedPrinterState>;
  /** Creates or updates a machine, its connection and its printer profile (units and slots) in one step. */
  saveMachineSetup: (input: MachineSetupInput) => Machine;
  createJob: (facts: JobFactsInput, usages: UsageInput[]) => Job;
  updateJobFacts: (id: string, facts: JobFactsInput) => void;
  replaceUsages: (id: string, usages: UsageInput[]) => void;
  /** Sets or clears the manual price adjustment (fixed price, discount or multiplier). */
  setPriceAdjustment: (id: string, adjustment: PriceAdjustment | null) => void;
  /** Replaces the job's manual run with the printer's data (times, material), then recalculates the price. */
  linkPrint: (printId: string, jobId: string, options?: { keepUsages?: boolean }) => void;
  /** The job keeps its values; its run returns to manual. */
  unlinkPrint: (printId: string) => void;
  createJobFromPrint: (printId: string, facts: JobFactsInput, usages: UsageInput[]) => Job;
  /** One job per unassigned run (title = file name), sharing customer, operator and optionally a pricing group. */
  createSeparateJobs: (runIds: string[], shared: SeparateJobsShared) => Job[];
  /** Assigns unassigned runs on the job's machine to the job; times, runtime, material and outcome follow all of its runs. */
  attachRuns: (runIds: string[], jobId: string, options?: { keepUsages?: boolean }) => void;
  /** Deletes jobs and unassigned runs. Jobs on orders and running runs are skipped. Returns what was deleted and what was skipped. */
  deleteSelection: (input: DeleteSelectionInput) => DeleteSelectionResult;
  /** Ends a manual run now: outcome cancelled, duration and price recalculated. */
  cancelRun: (jobId: string) => void;
  /** Records how a finished run ended. */
  setOutcome: (jobId: string, outcome: JobOutcome) => void;
  saveMachineType: (type: Pick<MachineType, 'name' | 'active'> & { id?: string }) => MachineType;
  setProfileEnabled: (machineId: string, enabled: boolean) => void;
  mountSpool: (machineId: string, slotId: string, spoolId: string) => void;
  unmountSpool: (machineId: string, slotId: string) => void;
  saveMaterial: (input: MaterialInput) => Material;
  /** Catalog entry of a filament product (future backend capability); needs `inventory.manage`. */
  saveProduct: (input: ProductInput) => FilamentProduct;
  /**
   * Appends a ledger entry and applies it to the material (and spool). `quantity` is the signed change for a
   * correction; for purchase it is the added amount, for consumption and disposal the removed amount (sign is normalised).
   */
  recordMovement: (materialId: string, spoolId: string | null, kind: Exclude<InventoryTransactionKind, 'transfer'>, quantity: number, extra?: MovementExtra) => InventoryTransaction;
  /** Disposes of the remaining stock on active spools and loose stock, leaving the material at zero. */
  markMaterialEmpty: (materialId: string) => void;
  saveSpool: (input: SpoolInput) => Spool;
  addIdentifier: (spoolId: string, kind: IdentifierKind, value: string) => SpoolIdentifier;
  removeIdentifier: (spoolId: string, identifierId: string) => void;
  /** Archiving unmounts the spool from its printer; restoring returns it to the list. */
  setSpoolLifecycle: (spoolId: string, lifecycle: SpoolLifecycle) => void;
  /** Closes the current fill (leftover handled per `leftover`) and starts a new one; identifiers are replaced in the same step. */
  changeFilament: (input: ChangeFilamentInput) => Spool;
  /** Closes the current fill. Single-use spools are archived, reusable ones wait for a refill; both leave the printer. */
  finishSpool: (spoolId: string, leftover: LeftoverChoice) => void;
  /** Hard-deletes archived single-use spools archived before `olderThan` (ISO); ledger entries and job usages keep the spool ID as text. */
  deleteArchivedSpools: (olderThan: string) => Spool[];

  // Sales & payments. Each runs one engine transition (see sales/engine.ts) and throws a SalesError when a rule is violated.
  createDraftOrder: SalesAction<typeof sales.createDraft>;
  updateDraftOrder: SalesAction<typeof sales.updateDraft>;
  addOrderManualItem: SalesAction<typeof sales.addManualItem>;
  addOrderJobs: SalesAction<typeof sales.addJobItems>;
  updateOrderManualItem: SalesAction<typeof sales.updateManualItem>;
  removeOrderItem: SalesAction<typeof sales.removeItem>;
  refreshOrderItem: SalesAction<typeof sales.refreshItem>;
  cancelDraftOrder: SalesAction<typeof sales.cancelDraft>;
  finalizeOrder: SalesAction<typeof sales.finalizeOrder>;
  checkoutOrder: SalesAction<typeof sales.checkoutOrder>;
  recordOrderPayments: SalesAction<typeof sales.recordPayments>;
  reverseOrderPayment: SalesAction<typeof sales.reversePayment>;
  reverseOrder: SalesAction<typeof sales.reverseOrder>;
  startReplacement: SalesAction<typeof sales.startReplacement>;
  commitReplacement: SalesAction<typeof sales.commitReplacement>;
  duplicateOrder: SalesAction<typeof sales.duplicateAsDraft>;
  createDraftFromJobs: SalesAction<typeof sales.draftFromJobs>;
  prepareInvoiceRequest: SalesAction<typeof sales.prepareInvoiceRequest>;
  updateRequestDetails: SalesAction<typeof sales.updateRequestDetails>;
  markRequestReady: SalesAction<typeof sales.markRequestReady>;
  markRequestSubmitted: SalesAction<typeof sales.markRequestSubmitted>;
  recordRequestIssued: SalesAction<typeof sales.recordRequestIssued>;
  cancelRequest: SalesAction<typeof sales.cancelRequest>;
  requestCancellation: SalesAction<typeof sales.requestCancellation>;
  confirmRequestCancellation: SalesAction<typeof sales.confirmRequestCancellation>;
  correctRequestReference: SalesAction<typeof sales.correctRequestReference>;
  /** [proposed] Closes the cash of one day. */
  closeDay: SalesAction<typeof sales.closeDay>;
  assignPricingGroup: SalesAction<typeof sales.assignPricingGroup>;
  setPurchaseOrderRequirement: SalesAction<typeof sales.setPurchaseOrderRequirement>;
  savePricingGroup: SalesAction<typeof sales.savePricingGroup>;
  setRate: SalesAction<typeof sales.setRate>;
  /** Anonymous sale: job, stock consumption, order, finalization and complete settlement in one step. */
  createCounterSale: (input: CounterSaleRequest) => { orderId: string; jobId: string };
};

type SalesAction<F> = F extends (state: sales.SalesState, c: sales.Ctx, ...args: infer A) => infer R ? (...args: A) => Omit<R, 'state'> : never;

export type CounterSaleRequest = {
  machineId: string; minutes: number; operator: Operator; usages: UsageInput[]; runId: string | null; pricingGroup: string; adjustment: PriceAdjustment | null;
  extras: sales.ManualItemInput[]; payments: PaymentInput[];
};

type Store = Data & Actions & {
  role: Role;
  setRole: (role: Role) => void;
  can: (permission: Permission) => boolean;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
  connectionTest: ConnectionTestMode;
  setConnectionTest: (mode: ConnectionTestMode) => void;
  toasts: Toast[];
  notify: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
  reset: () => void;
};

const StoreContext = createContext<Store | null>(null);

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

function toUsage(input: UsageInput, spools: Spool[], materials: Material[]): JobUsage {
  const material = materials.find((item) => item.id === input.materialId);
  const spool = spools.find((item) => item.id === input.spoolId);
  return {
    id: uid('u'), ownership: input.ownership, materialId: input.ownership === 'makerspace' ? input.materialId : null,
    spoolId: input.ownership === 'makerspace' ? input.spoolId : null, spoolDisplayId: spool?.displayId ?? null,
    materialName: input.ownership === 'external' ? input.materialName ?? 'External material' : material?.name ?? 'Unknown material',
    category: material?.category ?? 'External', unit: material?.unit ?? 'g', quantity: input.quantity, quantityBasis: input.quantityBasis,
  };
}

// Stand-in for the backend pricing service: the customer's pricing group (see sales/pricing.ts) supplies the machine runtime and material rates.
// A missing rate leaves the job's price incomplete, like the backend does, instead of guessing one.
function price(job: Job): Pick<Job, 'calculatedPrice' | 'pricingSnapshot' | 'pricingStatus'> {
  if (!job.customer) return { calculatedPrice: null, pricingSnapshot: null, pricingStatus: 'pending' };
  const group = effectiveGroup(livePricing(), job.customer.pricingGroup || null).name;
  const quote = quoteJob({
    group, durationSeconds: job.durationSeconds, machineTypeId: seed.machines.find((machine) => machine.id === job.machineId)?.machineTypeId,
    usages: job.usages.map((usage) => ({ materialName: usage.materialName, unit: usage.unit, quantity: usage.quantity, ownership: usage.ownership, category: usage.category })),
  });
  return {
    calculatedPrice: quote.complete ? quote.total : null,
    pricingStatus: quote.complete ? 'complete' : 'incomplete',
    pricingSnapshot: {
      revision: (job.pricingSnapshot?.revision ?? 0) + 1, pricingGroupName: group, reason: job.pricingSnapshot ? 'customer_changed' : 'initial', capturedAt: new Date().toISOString(), rules: quote.rules,
    },
  };
}

/** A new manual job; numbering looks at the jobs of `d`, so callers creating several jobs add each to `d` first. */
function buildJob(d: Data, facts: JobFactsInput, usages: UsageInput[], pricingGroup: string | null = null): Job {
  const next = Math.max(...d.jobs.map((job) => Number(job.displayId.slice(2)))) + 1;
  const base: Job = {
    id: uid('j'), displayId: `J-${next}`, ...facts, durationSeconds: secondsBetween(facts.startsAt, facts.endsAt), run: 'manual', printId: null, source: 'manual', externalId: null,
    usages: usages.map((usage) => toUsage(usage, d.spools, d.materials)), pricingStatus: 'pending', pricingSnapshot: null, calculatedPrice: null,
    priceAdjustment: null, order: null, version: 1,
  };
  // A pricing group chosen for a batch prices the job without changing the customer record.
  const priced = price(pricingGroup && base.customer ? { ...base, customer: { ...base.customer, pricingGroup } } : base);
  return { ...base, ...priced };
}

const secondsBetween = (startsAt: string, endsAt: string) => Math.max(60, Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 1000));
const reprice = (job: Job): Job => ({ ...job, calculatedPrice: price(job).calculatedPrice });

const PRINT_OUTCOME = { finished: 'successful', failed: 'failed', cancelled: 'cancelled' } as const;

function applyLink(d: Data, printId: string, jobId: string, keepUsages: boolean): Data {
  const print = d.prints.find((item) => item.id === printId);
  const job = d.jobs.find((item) => item.id === jobId);
  if (!print || !job || print.linkedJobId) return d;
  const endsAt = print.endedAt ?? print.estimatedEndAt ?? job.endsAt;
  const reported = print.reportedUsage;
  const usages = !keepUsages && reported
    ? [toUsage({
      ownership: reported.materialId ? 'makerspace' : 'external', materialId: reported.materialId,
      spoolId: d.spools.find((spool) => spool.displayId === reported.spoolDisplayId)?.id ?? null,
      materialName: reported.materialName, quantity: reported.quantity, quantityBasis: 'actual',
    }, d.spools, d.materials)]
    : job.usages;
  const linked = reprice({
    ...job, run: 'automatic', source: 'automatic', printId, externalId: print.displayId,
    startsAt: print.startedAt, endsAt, durationSeconds: secondsBetween(print.startedAt, endsAt), usages, version: job.version + 1, order: changedOrder(job),
    // A finished print reports how it ended; a still-printing one leaves the outcome open.
    outcome: job.outcome === 'unknown' && print.state !== 'printing' ? PRINT_OUTCOME[print.state] : job.outcome,
  });
  return {
    ...d,
    jobs: d.jobs.map((item) => item.id === jobId ? linked : item),
    prints: d.prints.map((item) => item.id === printId ? { ...item, linkedJobId: jobId } : item),
  };
}

/** Assigns unassigned runs to a job and recomputes the job from all of its runs. */
function applyAttach(d: Data, runIds: string[], jobId: string, keepUsages: boolean): Data {
  const job = d.jobs.find((item) => item.id === jobId);
  if (!job) return d;
  const added = runIds.map((id) => d.prints.find((item) => item.id === id)).filter((run): run is Print => !!run && run.linkedJobId === null && run.machineId === job.machineId && run.state !== 'printing');
  if (added.length === 0) return d;
  const current = runsOfJob(jobId, d.prints);
  const plan = planAttach(job, current, added);
  const usages = keepUsages ? job.usages : plan.usages.map((usage) => toUsage({
    ownership: usage.materialId ? 'makerspace' : 'external', materialId: usage.materialId, spoolId: d.spools.find((spool) => spool.displayId === usage.spoolDisplayId)?.id ?? null,
    materialName: usage.materialName, quantity: usage.quantity, quantityBasis: 'actual',
  }, d.spools, d.materials));
  const runs = [...current, ...added];
  const updated = reprice({
    ...job, run: 'automatic', source: 'automatic', printId: plan.first.id, externalId: runs.length > 1 ? `${plan.first.displayId} +${runs.length - 1}` : plan.first.displayId,
    startsAt: plan.startsAt, endsAt: plan.endsAt, durationSeconds: plan.durationSeconds, usages, version: job.version + 1, order: changedOrder(job),
    outcome: job.outcome === 'unknown' ? outcomeFromRuns(runs) : job.outcome,
  });
  const ids = new Set(added.map((run) => run.id));
  return {
    ...d, jobs: d.jobs.map((item) => item.id === jobId ? updated : item),
    prints: d.prints.map((item) => ids.has(item.id) ? { ...item, linkedJobId: jobId } : item),
  };
}

/** A job that changed after it was charged keeps its order link but flags the order as outdated. */
const changedOrder = (job: Job) => job.order ? { ...job.order, sourceChanged: true } : null;

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits + 0;

function unmountEverywhere(d: Data, spoolId: string): Data {
  return {
    ...d,
    printerProfiles: d.printerProfiles.map((p) => ({ ...p, slots: p.slots.map((s) => s.spoolId === spoolId ? { ...s, spoolId: null } : s) })),
    spools: d.spools.map((sp) => sp.id === spoolId ? { ...sp, mounted: false } : sp),
  };
}

const enrollmentSecret = () => `mke_${Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('')}`;

/** Replaces a machine's units and slots, keeping ids (and mounted spools) of those that survive the edit. */
function applyProfile(d: Data, machineId: string, units: SetupUnitInput[]): Data {
  const old = d.printerProfiles.find((p) => p.machineId === machineId);
  const inputUnits: PrinterProfile['inputUnits'] = [];
  const slots: PrinterProfile['slots'] = [];
  units.forEach((unit, ui) => {
    const unitId = unit.id ?? uid('iu');
    inputUnits.push({ id: unitId, machineId, name: unit.name, position: ui, externalIdentifier: unit.externalIdentifier, nozzle: unit.nozzle });
    unit.slots.forEach((slot, si) => {
      const before = old?.slots.find((item) => item.id === slot.id);
      slots.push({ id: slot.id ?? uid('sl'), inputUnitId: unitId, name: slot.name, position: si, status: slot.status ?? before?.status ?? 'available', spoolId: before?.spoolId ?? null, externalIdentifier: slot.externalIdentifier });
    });
  });
  const kept = new Set(slots.map((slot) => slot.spoolId).filter(Boolean));
  const freed = (old?.slots ?? []).map((slot) => slot.spoolId).filter((id): id is string => Boolean(id) && !kept.has(id));
  const profile: PrinterProfile = { machineId, enabled: old?.enabled ?? true, inputUnits, slots };
  return {
    ...d,
    printerProfiles: old ? d.printerProfiles.map((p) => p.machineId === machineId ? profile : p) : [...d.printerProfiles, profile],
    spools: d.spools.map((spool) => freed.includes(spool.id) ? { ...spool, mounted: false } : spool),
  };
}

/** Applies one ledger entry to material stock, average cost and spool remainder, then appends it. */
function applyTransaction(d: Data, tx: InventoryTransaction): Data {
  const next: Data = {
    ...d,
    transactions: [...d.transactions, tx],
    materials: d.materials.map((material) => {
      if (material.id !== tx.materialId || tx.kind === 'transfer') return material;
      const quantity = Math.max(0, round(material.quantity + tx.quantity, 3));
      let avg = material.avgCostPerUnit;
      if (tx.kind === 'purchase' && tx.totalValue != null && tx.quantity > 0) {
        const held = material.quantity * (material.avgCostPerUnit ?? tx.totalValue / tx.quantity);
        avg = round((held + tx.totalValue) / (material.quantity + tx.quantity), 5);
      }
      return { ...material, quantity, avgCostPerUnit: avg };
    }),
    spools: d.spools.map((spool) => {
      if (spool.id !== tx.spoolId) return spool;
      return { ...spool, remainingQuantity: Math.max(0, round(spool.remainingQuantity + tx.quantity, 3)) };
    }),
  };
  return next;
}

function buildTransaction(
  d: Data, materialId: string, spoolId: string | null, kind: InventoryTransactionKind, quantity: number, extra: MovementExtra = {},
): InventoryTransaction {
  const material = d.materials.find((item) => item.id === materialId);
  // Transfers keep their sign: positive moves loose stock onto the spool, negative returns it to loose stock.
  const delta = kind === 'purchase' ? Math.abs(quantity) : kind === 'correction' || kind === 'transfer' ? quantity : -Math.abs(quantity);
  const spool = spoolId ? d.spools.find((item) => item.id === spoolId) : undefined;
  const unitCost = kind === 'purchase'
    ? (extra.totalPrice != null ? round(extra.totalPrice / Math.abs(quantity), 5) : null)
    : kind === 'transfer' ? null : material?.avgCostPerUnit ?? null;
  const totalValue = kind === 'purchase' ? extra.totalPrice ?? null : kind !== 'transfer' && unitCost != null ? round(unitCost * delta, 2) : null;
  return {
    id: uid('tx'), materialId, spoolId, spoolDisplayId: spool?.displayId ?? null, fillNumber: spool && spool.fillNumber > 0 ? spool.fillNumber : null, kind, quantity: delta, unitCost, totalValue, jobId: extra.jobId ?? null, supplier: extra.supplier ?? null,
    note: extra.note ?? null, occurredAt: new Date().toISOString(), by: 'You',
  };
}

const salesSlice = (d: Data): sales.SalesState => ({
  orders: d.orders, payments: d.payments, allocations: d.allocations, adjustments: d.adjustments, requests: d.requests, jobs: d.jobs, counters: d.counters,
  customers: d.customers, daySessions: d.daySessions, pricing: d.pricing,
});
const salesCtx = (d: Data): sales.Ctx => ({ at: new Date().toISOString(), actor: CURRENT_ACTOR, machines: d.machines, machineTypes: d.machineTypes, prints: d.prints });

const CLEARED_FILL = { materialId: '', materialName: '', color: '', initialNetWeightG: 0, productId: null, manufacturer: null, productName: null, filledAt: null } as const;

/** Writes the closing ledger entries and moves the current fill into the history. Reusable spools end without a current fill. */
function closeCurrentFill(d: Data, spoolId: string, choice: LeftoverChoice): Data {
  const spool = d.spools.find((item) => item.id === spoolId);
  if (!spool || !spool.filledAt) return d;
  let next = d;
  for (const entry of planClose(spool, choice)) {
    next = applyTransaction(next, buildTransaction(next, spool.materialId, spool.id, entry.kind, entry.quantity, { note: entry.note }));
  }
  const leftoverG = Math.max(0, choice.leftoverG);
  const fill: SpoolFill = {
    id: `${spool.id}-fill-${spool.fillNumber}`, fillNumber: spool.fillNumber, materialId: spool.materialId, materialName: spool.materialName,
    productId: spool.productId, manufacturer: spool.manufacturer, productName: spool.productName, initialNetWeightG: spool.initialNetWeightG,
    usedG: Math.max(0, round(spool.initialNetWeightG - leftoverG, 3)), leftoverG, leftoverOutcome: leftoverOutcome(choice),
    filledAt: spool.filledAt, closedAt: new Date().toISOString(), identifiers: spool.identifiers,
  };
  return { ...next, spools: next.spools.map((item) => item.id === spoolId ? { ...item, fills: [...item.fills, fill], ...(item.kind === 'reusable' ? CLEARED_FILL : {}) } : item) };
}

export function PrototypeStoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Data>(initialData);
  // Sales actions run engine transitions and return ids synchronously, so they read the latest data through a ref that they also update eagerly.
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  // Quotes everywhere (job forms, counter sale, reprice) use the rates and customer assignments configured on the Pricing page.
  useEffect(() => { setLivePricing(data.pricing); }, [data.pricing]);
  useEffect(() => {
    for (const person of lookups.people) {
      const customer = data.customers.find((item) => item.id === person.id);
      if (customer) person.pricingGroup = effectiveGroup(data.pricing, customer.pricingGroup).name;
    }
  }, [data.customers, data.pricing]);
  const commit = useCallback((next: Data) => { dataRef.current = next; setData(next); }, []);
  const [role, setRole] = useState<Role>('supervisor');
  const [scenario, setScenario] = useState<Scenario>('normal');
  const [connectionTest, setConnectionTest] = useState<ConnectionTestMode>('success');
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((toast: Omit<Toast, 'id'>) => setToasts((current) => [...current, { ...toast, id: Date.now() + Math.random() }]), []);
  const dismissToast = useCallback((id: number) => setToasts((current) => current.filter((item) => item.id !== id)), []);

  const patchJob = useCallback((id: string, fn: (job: Job) => Job) => setData((d) => ({ ...d, jobs: d.jobs.map((job) => job.id === id ? { ...fn(job), version: job.version + 1, order: changedOrder(job) } : job) })), []);
  const patchProfile = useCallback((machineId: string, fn: (p: PrinterProfile) => PrinterProfile) => setData((d) => ({ ...d, printerProfiles: d.printerProfiles.map((p) => p.machineId === machineId ? fn(p) : p) })), []);

  const salesAction = useCallback(<A extends unknown[], R extends { state: sales.SalesState }>(fn: (state: sales.SalesState, c: sales.Ctx, ...args: A) => R) => (...args: A): Omit<R, 'state'> => {
    const d = dataRef.current;
    const { state, ...rest } = fn(salesSlice(d), salesCtx(d), ...args);
    commit({ ...d, ...state });
    return rest;
  }, [commit]);

  const actions: Actions = useMemo(() => ({
    createDraftOrder: salesAction(sales.createDraft), updateDraftOrder: salesAction(sales.updateDraft), addOrderManualItem: salesAction(sales.addManualItem),
    addOrderJobs: salesAction(sales.addJobItems), updateOrderManualItem: salesAction(sales.updateManualItem), removeOrderItem: salesAction(sales.removeItem),
    refreshOrderItem: salesAction(sales.refreshItem), cancelDraftOrder: salesAction(sales.cancelDraft), finalizeOrder: salesAction(sales.finalizeOrder),
    checkoutOrder: salesAction(sales.checkoutOrder), recordOrderPayments: salesAction(sales.recordPayments), reverseOrderPayment: salesAction(sales.reversePayment),
    reverseOrder: salesAction(sales.reverseOrder), startReplacement: salesAction(sales.startReplacement), commitReplacement: salesAction(sales.commitReplacement),
    duplicateOrder: salesAction(sales.duplicateAsDraft), createDraftFromJobs: salesAction(sales.draftFromJobs), prepareInvoiceRequest: salesAction(sales.prepareInvoiceRequest),
    updateRequestDetails: salesAction(sales.updateRequestDetails), markRequestReady: salesAction(sales.markRequestReady), markRequestSubmitted: salesAction(sales.markRequestSubmitted),
    recordRequestIssued: salesAction(sales.recordRequestIssued), cancelRequest: salesAction(sales.cancelRequest), requestCancellation: salesAction(sales.requestCancellation),
    confirmRequestCancellation: salesAction(sales.confirmRequestCancellation), correctRequestReference: salesAction(sales.correctRequestReference), closeDay: salesAction(sales.closeDay),
    assignPricingGroup: salesAction(sales.assignPricingGroup), setPurchaseOrderRequirement: salesAction(sales.setPurchaseOrderRequirement),
    savePricingGroup: salesAction(sales.savePricingGroup), setRate: salesAction(sales.setRate),
    createCounterSale: (input) => {
      const d = dataRef.current;
      const run = input.runId ? d.prints.find((item) => item.id === input.runId && item.linkedJobId === null) : undefined;
      if (input.runId && !run) throw new sales.SalesError('run_unavailable', 'That run was assigned to a job in the meantime');
      const at = new Date().toISOString();
      const endsAt = run ? run.endedAt ?? at : at;
      const startsAt = run ? run.startedAt : new Date(Date.now() - input.minutes * 60_000).toISOString();
      const usages = input.usages.map((usage) => toUsage(usage, d.spools, d.materials));
      const durationSeconds = secondsBetween(startsAt, endsAt);
      const quote = quoteJob({ group: input.pricingGroup, durationSeconds, machineTypeId: d.machines.find((machine) => machine.id === input.machineId)?.machineTypeId, usages: usages.map((usage) => ({ materialName: usage.materialName, unit: usage.unit, quantity: usage.quantity, ownership: usage.ownership, category: usage.category })) }, d.pricing);
      if (!quote.complete) throw new sales.SalesError('pricing_incomplete', `There is no rate for ${quote.missing.join(' and ')}. Ask someone who manages pricing to set it under Pricing.`);
      const job: Job = {
        id: uid('j'), displayId: `J-${Math.max(...d.jobs.map((item) => Number(item.displayId.slice(2)))) + 1}`, title: run ? nameFromFile(run.fileName) : null, machineId: input.machineId, startsAt, endsAt, durationSeconds,
        run: run ? 'automatic' : 'manual', printId: run?.id ?? null, source: run ? 'automatic' : 'manual', externalId: run?.displayId ?? null, customer: null, operator: input.operator, outcome: 'successful', notes: 'Counter sale',
        usages, pricingStatus: 'complete', pricingSnapshot: { revision: 1, pricingGroupName: input.pricingGroup, reason: 'initial', capturedAt: at, rules: quote.rules },
        calculatedPrice: quote.total, priceAdjustment: input.adjustment, order: null, version: 1,
      };
      const result = sales.counterSale(salesSlice(d), salesCtx(d), { job, extras: input.extras, payments: input.payments });
      let next: Data = { ...d, ...result.state, prints: run ? d.prints.map((item) => item.id === run.id ? { ...item, linkedJobId: job.id } : item) : d.prints };
      for (const usage of job.usages.filter((item) => item.ownership === 'makerspace' && item.materialId)) {
        next = applyTransaction(next, buildTransaction(next, usage.materialId!, usage.spoolId, 'consumption', usage.quantity, { jobId: job.id, note: `Counter sale ${job.displayId}` }));
      }
      commit(next);
      return { orderId: result.orderId, jobId: job.id };
    },
    createJob: (facts, usages) => {
      const job = buildJob(data, facts, usages);
      setData((d) => ({ ...d, jobs: [job, ...d.jobs] }));
      return job;
    },
    updateJobFacts: (id, facts) => patchJob(id, (job) => {
      const durationSeconds = secondsBetween(facts.startsAt, facts.endsAt);
      const next = { ...job, ...facts, durationSeconds };
      return job.customer?.id !== facts.customer?.id || job.machineId !== facts.machineId ? { ...next, ...price(next) } : next;
    }),
    replaceUsages: (id, usages) => patchJob(id, (job) => {
      const next = { ...job, usages: usages.map((usage) => toUsage(usage, data.spools, data.materials)) };
      return { ...next, calculatedPrice: price(next).calculatedPrice };
    }),
    setPriceAdjustment: (id, adjustment) => patchJob(id, (job) => ({ ...job, priceAdjustment: adjustment })),
    linkPrint: (printId, jobId, options) => setData((d) => applyLink(d, printId, jobId, options?.keepUsages ?? false)),
    unlinkPrint: (printId) => setData((d) => {
      const print = d.prints.find((item) => item.id === printId);
      if (!print?.linkedJobId) return d;
      const remaining = runsOfJob(print.linkedJobId, d.prints).filter((item) => item.id !== printId);
      const prints = d.prints.map((item) => item.id === printId ? { ...item, linkedJobId: null } : item);
      // A job with other runs left follows them; the last run leaving makes it a manual run with its current values.
      const jobs = d.jobs.map((job) => {
        if (job.id !== print.linkedJobId) return job;
        if (remaining.length === 0) return { ...job, run: 'manual' as const, source: 'manual' as const, printId: null, externalId: null, version: job.version + 1, order: changedOrder(job) };
        const summary = runsSummary(remaining);
        return { ...job, printId: summary.first.id, externalId: remaining.length > 1 ? `${summary.first.displayId} +${remaining.length - 1}` : summary.first.displayId, startsAt: summary.startsAt, endsAt: summary.endsAt, durationSeconds: summary.durationSeconds, version: job.version + 1, order: changedOrder(job) };
      });
      return { ...d, prints, jobs };
    }),
    attachRuns: (runIds, jobId, options) => setData((d) => applyAttach(d, runIds, jobId, options?.keepUsages ?? false)),
    createSeparateJobs: (runIds, shared) => {
      let next = data;
      const created: Job[] = [];
      for (const run of runIds.map((id) => data.prints.find((item) => item.id === id))) {
        if (!run || run.linkedJobId || run.state === 'printing') continue;
        const reported = run.reportedUsage;
        const job = buildJob(next, {
          title: run.fileName, machineId: run.machineId, startsAt: run.startedAt, endsAt: run.endedAt ?? run.estimatedEndAt ?? run.startedAt,
          customer: shared.customer, operator: shared.operator, outcome: outcomeFromRuns([run]), notes: null,
        }, reported ? [{
          ownership: reported.materialId ? 'makerspace' : 'external', materialId: reported.materialId, spoolId: data.spools.find((spool) => spool.displayId === reported.spoolDisplayId)?.id ?? null,
          materialName: reported.materialName, quantity: reported.quantity, quantityBasis: 'actual',
        }] : [], shared.pricingGroup);
        next = applyAttach({ ...next, jobs: [job, ...next.jobs] }, [run.id], job.id, true);
        created.push(next.jobs.find((item) => item.id === job.id) ?? job);
      }
      setData(next);
      return created;
    },
    deleteSelection: ({ jobIds, runIds, deleteRuns, material }) => {
      const skipped: string[] = [];
      const jobsToDelete = data.jobs.filter((job) => jobIds.includes(job.id)).filter((job) => {
        if (!job.order) return true;
        skipped.push(`${job.displayId} is on order ${job.order.orderReference} — remove it from the order first`);
        return false;
      });
      const runsToDelete = data.prints.filter((run) => runIds.includes(run.id) && run.linkedJobId === null).filter((run) => {
        if (run.state !== 'printing') return true;
        skipped.push(`${run.displayId} is still running — wait until it has ended`);
        return false;
      });
      const doomedJobs = new Set(jobsToDelete.map((job) => job.id));
      const linkedRuns = data.prints.filter((run) => run.linkedJobId && doomedJobs.has(run.linkedJobId));
      const doomedRuns = new Set([...runsToDelete.map((run) => run.id), ...(deleteRuns ? linkedRuns.map((run) => run.id) : [])]);
      setData((d) => {
        let next: Data = {
          ...d,
          jobs: d.jobs.filter((job) => !doomedJobs.has(job.id)),
          prints: d.prints.filter((run) => !doomedRuns.has(run.id)).map((run) => run.linkedJobId && doomedJobs.has(run.linkedJobId) ? { ...run, linkedJobId: null } : run),
        };
        if (material === 'reverse') {
          for (const job of jobsToDelete) {
            for (const usage of job.usages.filter((item) => item.ownership === 'makerspace' && item.materialId)) {
              next = applyTransaction(next, buildTransaction(next, usage.materialId!, usage.spoolId && next.spools.some((spool) => spool.id === usage.spoolId) ? usage.spoolId : null, 'correction', usage.quantity, { note: `Reversed: ${job.displayId} deleted`, jobId: null }));
            }
          }
        }
        return next;
      });
      return { jobs: jobsToDelete.length, runs: doomedRuns.size, skipped };
    },
    createJobFromPrint: (printId, facts, usages) => {
      const job = actions.createJob(facts, usages);
      setData((d) => applyLink(d, printId, job.id, true));
      return job;
    },
    setOutcome: (jobId, outcome) => patchJob(jobId, (job) => ({ ...job, outcome })),
    cancelRun: (jobId) => patchJob(jobId, (job) => {
      const stamp = new Date().toISOString();
      if (job.run !== 'manual' || new Date(job.endsAt).getTime() <= Date.now()) return job;
      return reprice({ ...job, endsAt: stamp, outcome: 'cancelled', durationSeconds: secondsBetween(job.startsAt, stamp) });
    }),
    createConnector: (name, location) => {
      const host: ConnectorHost = { id: uid('ch'), name, locationLabel: location, lifecycle: 'pending', healthState: 'offline', lastHeartbeatAt: null, softwareVersion: null, configRevisionApplied: 0, configRevisionDesired: 0, pendingEventCount: 0, quarantinedEventCount: 0, events: [] };
      setData((d) => ({ ...d, connectorHosts: [...d.connectorHosts, host] }));
      return enrollmentSecret();
    },
    enrollConnector: () => enrollmentSecret(),
    setConnectorEnabled: (id, enabled) => setData((d) => ({ ...d, connectorHosts: d.connectorHosts.map((host) => host.id === id ? { ...host, lifecycle: enabled ? 'active' : 'disabled' } : host) })),
    revokeConnector: (id) => setData((d) => ({
      ...d,
      connectorHosts: d.connectorHosts.map((host) => host.id === id ? { ...host, lifecycle: 'revoked', healthState: 'offline' } : host),
      machines: d.machines.map((m) => m.connection?.connectorId === id ? { ...m, connection: { ...m.connection, enabled: false, runtimeState: 'disabled' } } : m),
    })),
    detectPrinter: (connection, modelId) => new Promise((resolve, reject) => {
      window.setTimeout(() => {
        if (connectionTest !== 'success') { reject(new Error(connectionTest)); return; }
        resolve(structuredClone(connection.adapterKind === 'bambu_h2d' ? seed.h2dDetectedState : seed.simulatedDetectedState(modelId ?? null)));
      }, 1400);
    }),
    saveMachineSetup: (input) => {
      const stamp = new Date().toISOString();
      const existing = data.machines.find((m) => m.id === input.id);
      const id = existing?.id ?? uid('m');
      let connection = existing?.connection ?? null;
      let automatic = existing?.automaticCollectionEnabled ?? false;
      if (input.connection === null) { connection = null; automatic = false; }
      else if (input.connection) {
        const live = input.connection.adapterKind === 'bambu_h2d';
        connection = {
          ...input.connection, accessCodeSet: live ? Boolean(input.accessCode) || (connection?.accessCodeSet ?? false) : false, enabled: connection?.enabled ?? true,
          runtimeState: 'connected', runtimeErrorCode: null, lastHeartbeatAt: stamp,
        };
        automatic = true;
      }
      const machine: Machine = existing
        ? { ...existing, name: input.name, machineTypeId: input.machineTypeId, status: input.status, modelId: input.modelId, connection, automaticCollectionEnabled: automatic, updatedAt: stamp, version: existing.version + 1 }
        : {
          id, name: input.name, machineTypeId: input.machineTypeId, status: input.status, modelId: input.modelId, connection, automaticCollectionEnabled: automatic,
          lastIngestedAt: null, jobCount: 0, runtimeSeconds: 0, failureRate: 0, createdAt: stamp, updatedAt: stamp, version: 1,
        };
      setData((d) => {
        let next: Data = { ...d, machines: existing ? d.machines.map((m) => m.id === id ? machine : m) : [...d.machines, machine] };
        if (input.detected) next = { ...next, detected: { ...next.detected, [id]: input.detected } };
        if (input.connection === null) next = { ...next, detected: Object.fromEntries(Object.entries(next.detected).filter(([key]) => key !== id)) };
        if (input.inputUnits) next = applyProfile(next, id, input.inputUnits);
        return next;
      });
      return machine;
    },
    saveMachineType: (input) => {
      const existing = data.machineTypes.find((t) => t.id === input.id);
      const type: MachineType = existing ? { ...existing, ...input, id: existing.id } : { ...input, id: uid('type') };
      setData((d) => ({ ...d, machineTypes: existing ? d.machineTypes.map((t) => t.id === type.id ? type : t) : [...d.machineTypes, type] }));
      return type;
    },
    setProfileEnabled: (machineId, enabled) => patchProfile(machineId, (p) => ({ ...p, enabled })),
    mountSpool: (machineId, slotId, spoolId) => {
      patchProfile(machineId, (p) => ({ ...p, slots: p.slots.map((s) => s.id === slotId ? { ...s, spoolId } : s) }));
      setData((d) => ({ ...d, spools: d.spools.map((sp) => sp.id === spoolId ? { ...sp, mounted: true } : sp) }));
    },
    unmountSpool: (machineId, slotId) => {
      const spoolId = data.printerProfiles.find((p) => p.machineId === machineId)?.slots.find((s) => s.id === slotId)?.spoolId;
      patchProfile(machineId, (p) => ({ ...p, slots: p.slots.map((s) => s.id === slotId ? { ...s, spoolId: null } : s) }));
      setData((d) => ({ ...d, spools: d.spools.map((sp) => sp.id === spoolId ? { ...sp, mounted: false } : sp) }));
    },
    saveMaterial: (input) => {
      const existing = data.materials.find((item) => item.id === input.id);
      const material: Material = existing
        ? { ...existing, ...input, id: existing.id }
        : { ...input, id: uid('mat'), quantity: 0, avgCostPerUnit: null };
      setData((d) => ({
        ...d,
        materials: existing ? d.materials.map((item) => item.id === material.id ? material : item) : [...d.materials, material],
        spools: d.spools.map((spool) => spool.materialId === material.id ? { ...spool, materialName: material.name } : spool),
      }));
      return material;
    },
    saveProduct: (input) => {
      const existing = data.products.find((item) => item.id === input.id);
      const product: FilamentProduct = existing ? { ...existing, ...input, id: existing.id } : { ...input, id: uid('prod') };
      setData((d) => ({ ...d, products: existing ? d.products.map((item) => item.id === product.id ? product : item) : [...d.products, product] }));
      return product;
    },
    recordMovement: (materialId, spoolId, kind, quantity, extra) => {
      const tx = buildTransaction(data, materialId, spoolId, kind, quantity, extra);
      setData((d) => applyTransaction(d, tx));
      return tx;
    },
    markMaterialEmpty: (materialId) => setData((d) => {
      let next = d;
      for (const spool of d.spools.filter((item) => item.materialId === materialId && item.lifecycle === 'active' && item.filledAt)) {
        if (spool.remainingQuantity > 0) next = applyTransaction(next, buildTransaction(next, materialId, spool.id, 'disposal', spool.remainingQuantity, { note: 'Marked empty with the material' }));
        next = closeCurrentFill(next, spool.id, { basis: 'none', leftoverG: 0, outcome: 'disposed' });
        const single = spool.kind === 'single_use';
        next = { ...next, spools: next.spools.map((item) => item.id === spool.id ? { ...item, lifecycle: single ? 'archived' : 'empty', archivedAt: single ? new Date().toISOString() : null } : item) };
        next = unmountEverywhere(next, spool.id);
      }
      const rest = next.materials.find((item) => item.id === materialId)?.quantity ?? 0;
      return rest > 0 ? applyTransaction(next, buildTransaction(next, materialId, null, 'disposal', rest, { note: 'Marked as empty' })) : next;
    }),
    saveSpool: (input) => {
      const existing = data.spools.find((item) => item.id === input.id);
      if (existing) {
        const spool: Spool = {
          ...existing, label: input.label, tareWeightG: input.tareWeightG, manufacturer: input.manufacturer, productName: input.productName, storageLocation: input.storageLocation,
          acquiredOn: input.acquiredOn, acquisitionReference: input.acquisitionReference, notes: input.notes,
        };
        setData((d) => ({ ...d, spools: d.spools.map((item) => item.id === spool.id ? spool : item) }));
        return spool;
      }
      const material = data.materials.find((item) => item.id === input.materialId);
      const number = Math.max(0, ...data.spools.map((item) => Number(item.displayId.slice(3)))) + 1;
      const filled = input.kind === 'single_use' || input.withFill;
      const now = new Date().toISOString();
      const spool: Spool = {
        id: uid('sp'), displayId: `SP-${String(number).padStart(4, '0')}`, kind: input.kind, label: input.label, fillNumber: filled ? 1 : 0,
        filledAt: filled ? now : null, fills: [], archivedAt: null,
        materialId: filled ? input.materialId : '', materialName: filled ? material?.name ?? 'Unknown material' : '', color: filled ? material?.color ?? '' : '',
        remainingQuantity: 0, mounted: false, initialNetWeightG: filled ? input.initialNetWeightG : 0, tareWeightG: input.tareWeightG,
        productId: filled ? input.productId : null, manufacturer: filled ? input.manufacturer : null, productName: filled ? input.productName : null, storageLocation: input.storageLocation,
        lifecycle: filled ? 'active' : 'empty', acquiredOn: input.acquiredOn,
        acquisitionReference: input.acquisitionReference, purchasePrice: filled && input.source === 'purchase' ? input.purchasePrice : null, notes: input.notes, identifiers: [],
      };
      const withSpool: Data = { ...data, spools: [...data.spools, spool] };
      if (!filled) {
        setData((d) => ({ ...d, spools: [...d.spools, spool] }));
        return spool;
      }
      const tx = buildTransaction(withSpool, input.materialId, spool.id, input.source === 'purchase' ? 'purchase' : 'transfer', input.initialNetWeightG, {
        totalPrice: input.source === 'purchase' ? input.purchasePrice : null, supplier: input.supplier,
        note: input.source === 'purchase' ? `Spool bought${input.acquisitionReference ? `, ${input.acquisitionReference}` : ''}` : 'Spool registered from loose stock',
      });
      setData((d) => applyTransaction({ ...d, spools: [...d.spools, spool] }, tx));
      return spool;
    },
    addIdentifier: (spoolId, kind, value) => {
      const identifier: SpoolIdentifier = { id: uid('id'), kind, value, addedAt: new Date().toISOString() };
      setData((d) => ({ ...d, spools: d.spools.map((spool) => spool.id === spoolId ? { ...spool, identifiers: [...spool.identifiers, identifier] } : spool) }));
      return identifier;
    },
    removeIdentifier: (spoolId, identifierId) => setData((d) => ({
      ...d, spools: d.spools.map((spool) => spool.id === spoolId ? { ...spool, identifiers: spool.identifiers.filter((item) => item.id !== identifierId) } : spool),
    })),
    setSpoolLifecycle: (spoolId, lifecycle) => setData((d) => {
      const spool = d.spools.find((item) => item.id === spoolId);
      if (!spool || spool.lifecycle === lifecycle) return d;
      const next = { ...d, spools: d.spools.map((item) => item.id === spoolId ? { ...item, lifecycle, archivedAt: lifecycle === 'archived' ? new Date().toISOString() : null } : item) };
      return lifecycle === 'active' ? next : unmountEverywhere(next, spoolId);
    }),
    changeFilament: (input) => {
      const now = new Date().toISOString();
      const before = data.spools.find((item) => item.id === input.spoolId);
      if (!before) throw new Error('Unknown spool');
      let next = input.leftover && before.filledAt ? closeCurrentFill(data, input.spoolId, input.leftover) : data;
      const closed = next.spools.find((item) => item.id === input.spoolId) ?? before;
      const material = next.materials.find((item) => item.id === input.materialId);
      const added: SpoolIdentifier[] = input.added.map((item) => ({ id: uid('id'), kind: item.kind, value: item.value.trim(), addedAt: now }));
      next = {
        ...next,
        spools: next.spools.map((item) => item.id === input.spoolId ? {
          ...item, materialId: input.materialId, materialName: material?.name ?? 'Unknown material', color: material?.color ?? '', initialNetWeightG: input.netWeightG,
          productId: input.productId, manufacturer: input.manufacturer, productName: input.productName, fillNumber: closed.fillNumber + 1, filledAt: now, lifecycle: 'active', archivedAt: null,
          purchasePrice: input.source === 'purchase' ? input.totalPrice : null,
          identifiers: [...closed.identifiers.filter((identifier) => input.keepIdentifierIds.includes(identifier.id)), ...added],
        } : item),
      };
      const tx = buildTransaction(next, input.materialId, input.spoolId, input.source === 'purchase' ? 'purchase' : 'transfer', input.netWeightG, {
        totalPrice: input.source === 'purchase' ? input.totalPrice : null, supplier: input.supplier,
        note: input.source === 'purchase' ? `Filament bought for fill ${closed.fillNumber + 1}` : `Fill ${closed.fillNumber + 1} taken from loose stock`,
      });
      next = applyTransaction(next, tx);
      const updated = next.spools.find((item) => item.id === input.spoolId) as Spool;
      setData(() => next);
      return updated;
    },
    finishSpool: (spoolId, leftover) => setData((d) => {
      const spool = d.spools.find((item) => item.id === spoolId);
      if (!spool) return d;
      const single = spool.kind === 'single_use';
      let next = closeCurrentFill(d, spoolId, leftover);
      next = { ...next, spools: next.spools.map((item) => item.id === spoolId ? { ...item, lifecycle: single ? 'archived' : 'empty', archivedAt: single ? new Date().toISOString() : null } : item) };
      return unmountEverywhere(next, spoolId);
    }),
    deleteArchivedSpools: (olderThan) => {
      const doomed = data.spools.filter((spool) => spool.kind === 'single_use' && spool.lifecycle === 'archived' && spool.archivedAt != null && spool.archivedAt < olderThan);
      const ids = new Set(doomed.map((spool) => spool.id));
      if (ids.size === 0) return [];
      setData((d) => ({
        ...d,
        spools: d.spools.filter((spool) => !ids.has(spool.id)),
        jobs: d.jobs.map((job) => job.usages.some((usage) => usage.spoolId && ids.has(usage.spoolId))
          ? { ...job, usages: job.usages.map((usage) => usage.spoolId && ids.has(usage.spoolId) ? { ...usage, spoolId: null } : usage) } : job),
      }));
      return doomed;
    },
  }), [data, connectionTest, patchJob, patchProfile, salesAction, commit]);

  const permissions = rolePresets[role].permissions;
  const value: Store = {
    ...data, ...actions, role, setRole, scenario, setScenario, connectionTest, setConnectionTest, toasts, notify, dismissToast,
    can: (permission) => permissions.includes(permission),
    reset: () => { setData(initialData()); notify({ kind: 'info', title: 'Prototype data reset' }); },
  };
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside PrototypeStoreProvider');
  return store;
}

/**
 * Simulates a TanStack Query read: a short pending phase on mount, then the
 * selected data. The "loading", "error" and "empty" scenarios force the
 * corresponding states so every screen can demonstrate them.
 */
export function useSimulatedQuery<T>(select: (data: Data) => T, emptyValue: T): { status: 'pending' | 'error' | 'success'; data: T; retry: () => void } {
  const store = useStore();
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setReady(false);
    const timer = window.setTimeout(() => setReady(true), 350);
    return () => window.clearTimeout(timer);
  }, [attempt]);
  const retry = () => setAttempt((value) => value + 1);
  if (store.scenario === 'loading' || !ready) return { status: 'pending', data: emptyValue, retry };
  if (store.scenario === 'error') return { status: 'error', data: emptyValue, retry };
  if (store.scenario === 'empty') return { status: 'success', data: emptyValue, retry };
  return { status: 'success', data: select(store), retry };
}

/** Simulates a mutation round trip so pending states are visible. */
export function useSimulatedMutation<A extends unknown[], R>(fn: (...args: A) => R, delay = 500) {
  const [pending, setPending] = useState(false);
  const mutate = useCallback((...args: A) => new Promise<R>((resolve) => {
    setPending(true);
    window.setTimeout(() => { setPending(false); resolve(fn(...args)); }, delay);
  }), [fn, delay]);
  return { mutate, pending };
}

/** Current time that re-renders the caller periodically, so simulated runs progress and end on screen. */
export function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export const lookups = { people: seed.people, operators: seed.operators, materials: seed.materials };
