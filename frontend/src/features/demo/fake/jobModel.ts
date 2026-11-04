import type {
  MachineJob,
  MachineJobAttention,
  MachineJobOutcome,
  MachineJobPricingSnapshot,
  MachineJobStatus,
  MachineJobUsage,
  MachineRun,
  MachineRunDetail,
  PricingGroup,
  PricingSnapshotRule,
  WorkItem,
} from '../../../api/generated/models';
import { decimal, money, toCents, type DemoStore } from './store';

const SECONDS_PER_HOUR = 3600;

export function runDuration(run: Pick<MachineRun, 'startedAt' | 'endedAt'>, store: DemoStore): number {
  const end = run.endedAt ? Date.parse(run.endedAt) : store.now.getTime();
  return Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
}

/** The pricing group a job is charged with: the recipient's own group, else the default one. */
export function pricingGroupFor(store: DemoStore, job: Pick<MachineJob, 'customer'>): PricingGroup | undefined {
  const own = job.customer?.pricingGroup?.id;
  return store.pricingGroups.find((group) => group.id === own) ?? store.pricingGroups.find((group) => group.isDefault);
}

/** Prices a job from the pricing group's rules: machine time per hour plus material quantities. */
export function priceJob(
  store: DemoStore,
  job: Pick<MachineJob, 'id' | 'customer' | 'machine' | 'durationSeconds'>,
  usages: MachineJobUsage[],
): { cents: number; snapshot: NonNullable<MachineJobPricingSnapshot> } {
  const group = pricingGroupFor(store, job);
  const rules: PricingSnapshotRule[] = [];
  let cents = 0;
  const machineRule = group?.rules.find(
    (rule) => rule.kind === 'machine_runtime' && rule.processId === job.machine.process.id && rule.active,
  );
  if (machineRule) {
    cents += Math.round((job.durationSeconds / SECONDS_PER_HOUR) * toCents(machineRule.rate));
    rules.push({
      sourceRuleId: machineRule.id,
      kind: 'machine_runtime',
      label: 'Machine time',
      selector: job.machine.process.name,
      unit: 'h',
      rate: machineRule.rate,
      missing: false,
    });
  }
  for (const usage of usages.filter((item) => item.ownership === 'makerspace')) {
    const rule = group?.rules.find((item) => item.kind === 'material' && item.materialTypeId === usage.materialTypeId);
    cents += rule ? Math.round(Number(usage.quantity) * toCents(rule.rate)) : 0;
    rules.push({
      sourceRuleId: rule?.id ?? null,
      kind: 'material',
      label: usage.materialTypeName,
      selector: usage.materialTypeName,
      unit: usage.unit,
      rate: rule?.rate ?? null,
      missing: !rule,
    });
  }
  return {
    cents,
    snapshot: {
      id: job.id,
      revision: 1,
      pricingGroupName: group?.name ?? 'Standard',
      currency: 'EUR',
      reason: 'initial',
      complete: !rules.some((rule) => rule.missing),
      calculatedAmount: money(cents),
      rules,
      capturedAt: store.now.toISOString(),
    },
  };
}

/** A run without the event history that only the run detail carries. */
export function plainRun(run: MachineRunDetail): MachineRun {
  const plain: Partial<MachineRunDetail> = { ...run };
  delete plain.events;
  return plain as MachineRun;
}

const outcomeOf = (runs: MachineRun[]): MachineJobOutcome => {
  const finished = runs.filter((run) => run.outcome);
  if (finished.length === 0) return 'unknown';
  if (finished.every((run) => run.outcome === 'successful')) return 'successful';
  if (finished.every((run) => run.outcome === 'failed')) return 'failed';
  if (finished.every((run) => run.outcome === 'cancelled')) return 'cancelled';
  return 'partial_failure';
};

/** Recomputes everything a job derives from its runs (times, usages, outcome, price); call after any change. */
export function refreshJob(store: DemoStore, job: MachineJob): MachineJob {
  const runs = store.runs.filter((run) => run.job?.id === job.id && run.state !== 'replaced');
  job.runs = runs.map(plainRun);
  job.startedAt = runs.map((run) => run.startedAt).sort()[0] ?? null;
  const ends = runs.map((run) => run.endedAt).filter((end): end is string => Boolean(end));
  job.endedAt = ends.length === runs.length ? (ends.sort().at(-1) ?? null) : null;
  job.durationSeconds = runs.reduce((sum, run) => sum + run.durationSeconds, 0);
  const running = runs.some((run) => run.state === 'running');
  const derived = outcomeOf(runs);
  job.outcome = job.outcomeOverridden ? job.outcome : derived;
  job.status = running ? 'running' : job.outcome === 'unknown' ? 'needs_outcome' : (job.outcome as MachineJobStatus);
  const { cents, snapshot } = priceJob(
    store,
    job,
    runs.flatMap((run) => run.usages),
  );
  job.pricingSnapshot = snapshot;
  job.pricingStatus = running ? 'pending' : snapshot.complete ? 'complete' : 'incomplete';
  job.calculatedPrice = running ? null : money(cents);
  job.effectivePrice = job.calculatedPrice;
  job.attention = attentionOf(store, job);
  return job;
}

/** The ready-to-bill flag a job carries: on an order, not yet on one, or not billable. */
export function billingOf(store: DemoStore, job: MachineJob): NonNullable<WorkItem['billing']> {
  const order = store.orders.find(
    (item) =>
      item.status !== 'cancelled' &&
      item.status !== 'reversed' &&
      item.items.some((line) => !line.removedAt && line.sourceMachineJobId === job.id),
  );
  if (order) return { state: 'on_order', orderId: order.id, orderReference: order.reference };
  if (job.pricingStatus === 'pending') return { state: 'pending' };
  if (job.pricingStatus === 'incomplete') return { state: 'price_incomplete' };
  return { state: 'not_on_order' };
}

function attentionOf(store: DemoStore, job: MachineJob): MachineJobAttention[] {
  const flags: MachineJobAttention[] = [];
  if (job.status === 'needs_outcome') flags.push({ code: 'needs_outcome', message: 'The outcome is not known yet.' });
  if (job.pricingStatus === 'incomplete') flags.push({ code: 'price_incomplete', message: 'A price rule is missing.' });
  if (!job.customer && job.status !== 'running') flags.push({ code: 'no_recipient', message: 'Nobody is charged.' });
  if (job.customer && billingOf(store, job).state === 'not_on_order' && job.status !== 'cancelled') {
    flags.push({ code: 'not_on_order', message: 'Not on an order yet.' });
  }
  return flags;
}

export function workItemOfJob(store: DemoStore, job: MachineJob): WorkItem {
  const materials = new Map<string, { materialTypeName: string; unit: MachineJobUsage['unit']; quantity: number }>();
  for (const usage of job.runs.flatMap((run) => run.usages)) {
    const entry = materials.get(usage.materialTypeName) ?? {
      materialTypeName: usage.materialTypeName,
      unit: usage.unit,
      quantity: 0,
    };
    entry.quantity += Number(usage.quantity);
    materials.set(usage.materialTypeName, entry);
  }
  return {
    kind: 'job',
    id: job.id,
    displayId: job.displayId,
    title: job.title,
    runCount: job.runs.length,
    machineId: job.machine.id,
    machineName: job.machine.name,
    customer: job.customer,
    operator: job.operator,
    status: job.status,
    source: job.runs.some((run) => run.source === 'recorded') ? 'recorded' : 'manual',
    startedAt: job.startedAt ?? job.createdAt,
    endsAt: job.endedAt,
    effectivePrice: job.effectivePrice,
    billing: billingOf(store, job),
    consumption: {
      materials: [...materials.values()].map((item) => ({ ...item, quantity: decimal(item.quantity, 1) })),
      measures: {},
    },
    attention: job.attention,
    version: job.version,
  };
}

export function workItemOfRun(run: MachineRunDetail): WorkItem {
  return {
    kind: 'run',
    id: run.id,
    displayId: run.displayId,
    fileName: run.fileName,
    runCount: 1,
    machineId: run.machineId,
    machineName: run.machineName,
    status: run.state === 'running' ? 'running_unassigned' : 'unassigned',
    source: run.source,
    startedAt: run.startedAt,
    endsAt: run.endedAt,
    progressPercent: run.progressPercent,
    effectivePrice: null,
    billing: null,
    consumption: {
      materials: run.usages.map((usage) => ({
        materialTypeName: usage.materialTypeName,
        unit: usage.unit,
        quantity: usage.quantity,
      })),
      measures: {},
    },
    version: run.version,
  };
}
