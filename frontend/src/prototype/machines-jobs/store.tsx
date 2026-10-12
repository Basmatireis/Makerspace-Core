/* eslint-disable react-refresh/only-export-components -- store provider, hooks and role presets form one module */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as seed from './mockData';
import type {
  BillingParty, IdentifierKind, InventoryTransaction, InventoryTransactionKind, FilamentProduct, Job, JobOutcome, JobUsage, Machine, MachineType, Material, Operator, Print, PrinterProfile,
  PriceAdjustment, Spool, SpoolFill, SpoolIdentifier, SpoolKind, SpoolLifecycle, SpoolStockSource,
} from './types';
import { leftoverOutcome, planClose, type LeftoverChoice } from './fillPlan';

// ---------------------------------------------------------------------------
// Prototype controls: role presets and simulated data states.
// Role presets use the real permission IDs (see features/auth/permissions.ts).
// ---------------------------------------------------------------------------

export type Permission =
  | 'machines.read' | 'machines.manage' | 'machine_jobs.read' | 'machine_jobs.create'
  | 'machine_jobs.edit' | 'machine_jobs.override_price'
  | 'printer_slots.assign' | 'inventory.read' | 'inventory.manage' | 'filament_spools.manage' | 'orders.read' | 'orders.write' | 'orders.finalize' | 'payments.read' | 'payments.record'
  | 'pricing.read' | 'statistics.read';

export type Role = 'supervisor' | 'operator' | 'viewer';
export type Scenario = 'normal' | 'loading' | 'error' | 'empty';

const ALL: Permission[] = ['machines.read', 'machines.manage', 'machine_jobs.read', 'machine_jobs.create', 'machine_jobs.edit', 'machine_jobs.override_price', 'printer_slots.assign', 'inventory.read', 'inventory.manage', 'filament_spools.manage', 'orders.read', 'orders.write', 'orders.finalize', 'payments.read', 'payments.record', 'pricing.read', 'statistics.read'];

export const rolePresets: Record<Role, { label: string; description: string; permissions: Permission[] }> = {
  supervisor: { label: 'Workshop supervisor', description: 'All Machines & Jobs permissions', permissions: ALL },
  operator: { label: 'Operator', description: 'Creates jobs; no linking, pricing or machine setup', permissions: ['machines.read', 'machine_jobs.read', 'machine_jobs.create', 'printer_slots.assign', 'inventory.read'] },
  viewer: { label: 'Read-only', description: 'Can look up machines and jobs only', permissions: ['machines.read', 'machine_jobs.read'] },
};

// ---------------------------------------------------------------------------
// Data store
// ---------------------------------------------------------------------------

type Data = {
  machines: Machine[];
  machineTypes: MachineType[];
  jobs: Job[];
  prints: Print[];
  printerProfiles: PrinterProfile[];
  spools: Spool[];
  materials: Material[];
  products: FilamentProduct[];
  transactions: InventoryTransaction[];
};

const initialData = (): Data => structuredClone({
  machines: seed.machines, machineTypes: seed.machineTypes, jobs: seed.jobs, prints: seed.prints,
  printerProfiles: seed.printerProfiles, spools: seed.spools, materials: seed.materials, products: seed.filamentProducts, transactions: seed.inventoryTransactions,
});

export type Toast = { id: number; kind: 'success' | 'error' | 'info'; title: string; subtitle?: string };

export type JobFactsInput = {
  title: string | null; machineId: string; startsAt: string; endsAt: string; customer: BillingParty | null; operator: Operator | null;
  outcome: JobOutcome; notes: string | null;
};
export type UsageInput = Omit<JobUsage, 'id' | 'spoolDisplayId' | 'category' | 'unit'> & { materialName?: string };

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

type Actions = {
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
  /** Ends a manual run now: outcome cancelled, duration and price recalculated. */
  cancelRun: (jobId: string) => void;
  /** Records how a finished run ended. */
  setOutcome: (jobId: string, outcome: JobOutcome) => void;
  saveMachine: (machine: Pick<Machine, 'name' | 'machineTypeId' | 'status' | 'externalIdentifier' | 'automaticCollectionEnabled'> & { id?: string }) => Machine;
  saveMachineType: (type: Pick<MachineType, 'name' | 'active'> & { id?: string }) => void;
  setProfileEnabled: (machineId: string, enabled: boolean) => void;
  createProfile: (machineId: string) => void;
  addInputUnit: (machineId: string, name: string) => void;
  addSlot: (machineId: string, inputUnitId: string, name: string) => void;
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
};

type Store = Data & Actions & {
  role: Role;
  setRole: (role: Role) => void;
  can: (permission: Permission) => boolean;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
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

// Simplified stand-in for the backend pricing service: hourly machine rate plus
// per-unit material rate from the customer's pricing group. Only used to make
// the prototype's numbers plausible.
function price(job: Job): Pick<Job, 'calculatedPrice' | 'pricingSnapshot' | 'pricingStatus'> {
  if (!job.customer) return { calculatedPrice: null, pricingSnapshot: null, pricingStatus: 'pending' };
  const external = job.customer.pricingGroup === 'External';
  const hourly = external ? 6 : 2;
  const perGram = external ? 0.08 : 0.04;
  const material = job.usages.filter((usage) => usage.ownership === 'makerspace').reduce((sum, usage) => sum + usage.quantity * (usage.unit === 'g' ? perGram : 12), 0);
  const total = Math.round(((job.durationSeconds / 3600) * hourly + material) * 100) / 100;
  return {
    calculatedPrice: total,
    pricingStatus: 'complete',
    pricingSnapshot: {
      revision: (job.pricingSnapshot?.revision ?? 0) + 1,
      pricingGroupName: job.customer.pricingGroup,
      reason: job.pricingSnapshot ? 'customer_changed' : 'initial',
      capturedAt: new Date().toISOString(),
      rules: [{ label: 'Machine time', rate: hourly.toFixed(2), unit: 'h', missing: false }, { label: 'Material', rate: perGram.toFixed(2), unit: 'g', missing: false }],
    },
  };
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
    startsAt: print.startedAt, endsAt, durationSeconds: secondsBetween(print.startedAt, endsAt), usages, version: job.version + 1,
    // A finished print reports how it ended; a still-printing one leaves the outcome open.
    outcome: job.outcome === 'unknown' && print.state !== 'printing' ? PRINT_OUTCOME[print.state] : job.outcome,
  });
  return {
    ...d,
    jobs: d.jobs.map((item) => item.id === jobId ? linked : item),
    prints: d.prints.map((item) => item.id === printId ? { ...item, linkedJobId: jobId } : item),
  };
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits + 0;

function unmountEverywhere(d: Data, spoolId: string): Data {
  return {
    ...d,
    printerProfiles: d.printerProfiles.map((p) => ({ ...p, slots: p.slots.map((s) => s.spoolId === spoolId ? { ...s, spoolId: null } : s) })),
    spools: d.spools.map((sp) => sp.id === spoolId ? { ...sp, mounted: false } : sp),
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
  const [role, setRole] = useState<Role>('supervisor');
  const [scenario, setScenario] = useState<Scenario>('normal');
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((toast: Omit<Toast, 'id'>) => setToasts((current) => [...current, { ...toast, id: Date.now() + Math.random() }]), []);
  const dismissToast = useCallback((id: number) => setToasts((current) => current.filter((item) => item.id !== id)), []);

  const patchJob = useCallback((id: string, fn: (job: Job) => Job) => setData((d) => ({ ...d, jobs: d.jobs.map((job) => job.id === id ? { ...fn(job), version: job.version + 1 } : job) })), []);
  const patchProfile = useCallback((machineId: string, fn: (p: PrinterProfile) => PrinterProfile) => setData((d) => ({ ...d, printerProfiles: d.printerProfiles.map((p) => p.machineId === machineId ? fn(p) : p) })), []);

  const actions: Actions = useMemo(() => ({
    createJob: (facts, usages) => {
      const next = Math.max(...data.jobs.map((job) => Number(job.displayId.slice(2)))) + 1;
      const durationSeconds = secondsBetween(facts.startsAt, facts.endsAt);
      const base: Job = {
        id: uid('j'), displayId: `J-${next}`, ...facts, durationSeconds, run: 'manual', printId: null, source: 'manual', externalId: null,
        usages: usages.map((usage) => toUsage(usage, data.spools, data.materials)), pricingStatus: 'pending', pricingSnapshot: null, calculatedPrice: null,
        priceAdjustment: null, order: null, version: 1,
      };
      const job = { ...base, ...price(base) };
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
      return {
        ...d,
        prints: d.prints.map((item) => item.id === printId ? { ...item, linkedJobId: null } : item),
        jobs: d.jobs.map((job) => job.id === print.linkedJobId ? { ...job, run: 'manual', source: 'manual', printId: null, externalId: null, version: job.version + 1 } : job),
      };
    }),
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
    saveMachine: (input) => {
      const stamp = new Date().toISOString();
      const existing = data.machines.find((m) => m.id === input.id);
      const machine: Machine = existing
        ? { ...existing, ...input, id: existing.id, updatedAt: stamp, version: existing.version + 1 }
        : { ...input, id: uid('m'), lastIngestedAt: null, jobCount: 0, runtimeSeconds: 0, failureRate: 0, createdAt: stamp, updatedAt: stamp, connector: null, version: 1 };
      setData((d) => ({ ...d, machines: existing ? d.machines.map((m) => m.id === machine.id ? machine : m) : [...d.machines, machine] }));
      return machine;
    },
    saveMachineType: (input) => setData((d) => ({
      ...d,
      machineTypes: input.id ? d.machineTypes.map((t) => t.id === input.id ? { ...t, ...input, id: t.id } : t) : [...d.machineTypes, { ...input, id: uid('type') }],
    })),
    setProfileEnabled: (machineId, enabled) => patchProfile(machineId, (p) => ({ ...p, enabled })),
    createProfile: (machineId) => setData((d) => ({ ...d, printerProfiles: [...d.printerProfiles, { machineId, enabled: true, inputUnits: [], slots: [] }] })),
    addInputUnit: (machineId, name) => patchProfile(machineId, (p) => ({ ...p, inputUnits: [...p.inputUnits, { id: uid('iu'), machineId, name, position: p.inputUnits.length, externalIdentifier: null }] })),
    addSlot: (machineId, inputUnitId, name) => patchProfile(machineId, (p) => ({ ...p, slots: [...p.slots, { id: uid('sl'), inputUnitId, name, position: p.slots.filter((s) => s.inputUnitId === inputUnitId).length, status: 'available', spoolId: null }] })),
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
  }), [data, patchJob, patchProfile]);

  const permissions = rolePresets[role].permissions;
  const value: Store = {
    ...data, ...actions, role, setRole, scenario, setScenario, toasts, notify, dismissToast,
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
