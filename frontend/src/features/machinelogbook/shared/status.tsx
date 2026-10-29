/* eslint-disable react-refresh/only-export-components -- status tags and the derivations they render form one module */
import { Tag } from '@carbon/react';
import {
  CheckmarkFilled,
  CircleDash,
  ErrorFilled,
  Flag,
  InProgress,
  Misuse,
  PauseFilled,
  WarningAltFilled,
  WarningFilled,
} from '@carbon/icons-react';
import type {
  JobBillingState,
  MachineAvailability,
  MachineConnectorState,
  MachineCurrentItem,
  MachineJob,
  MachineJobOutcome,
  MachineJobUsage,
  MachineRun,
  MachineRunReportedUsageItem,
  MachineRunState,
  PriceAdjustmentKind,
  WorkItem,
  WorkItemBilling,
  WorkItemStatus,
} from '../../../api/generated/models';
import { consumptionSummary, sumUsages } from '../processConfig';
import { formatMoney, formatQuantity } from './format';

// ---------------------------------------------------------------------------
// Display names
// Only a job has an editable name. A recorded run keeps the file name its machine reported. A job without a name
// reads as the file name of its latest recorded run, made readable, else as its job number.
// ---------------------------------------------------------------------------

/** "gearbox_housing_v3.gcode" → "Gearbox housing v3": a readable suggestion for a job name. */
export function nameFromFile(fileName: string) {
  // Slicers stack extensions (Bambu: part.gcode.3mf), so strip known file extensions first.
  const stripped = fileName.replace(/(\.(gcode|bgcode|3mf|stl|step|stp|obj|svg|dxf|ai|pes|dst|exp|jef|xxx))+$/i, '');
  const base = (stripped === fileName ? fileName.replace(/\.[^.]+$/, '') : stripped)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : fileName;
}

/** Title → readable file name → display ID. Works for anything that carries these three values. */
export const displayName = (item: { title?: string | null; fileName?: string | null; displayId: string }) =>
  item.title || (item.fileName ? nameFromFile(item.fileName) : item.displayId);

/** Runs that count towards a job (replaced manual runs are history only). */
export const activeRuns = (job: Pick<MachineJob, 'runs'>) => job.runs.filter((run) => run.state !== 'replaced');

/** File name of the job's latest recorded run that is still part of the job. */
export const jobFileName = (job: Pick<MachineJob, 'runs'>) =>
  activeRuns(job)
    .filter((run) => run.source === 'recorded' && run.fileName)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0]?.fileName ?? null;

/** The job's name, else its latest recorded run's machine name, else the job number. */
export const machineJobName = (job: Pick<MachineJob, 'title' | 'displayId' | 'runs'>) =>
  displayName({ title: job.title, fileName: jobFileName(job), displayId: job.displayId });

/** A run reads by its readable file name, else its run ID. */
export const runName = (run: Pick<MachineRun, 'fileName' | 'displayId'>) =>
  run.fileName ? nameFromFile(run.fileName) : run.displayId;

/** A work item row: a job reads by its display name, an unassigned run by the name its machine reported. */
export const workItemName = (item: Pick<WorkItem, 'kind' | 'title' | 'fileName' | 'displayId'>) =>
  item.kind === 'run' ? item.fileName || item.displayId : displayName(item);

/** Other identifiers shown under the name (job number, file name, run count; "Unassigned" for runs). */
export function workItemSecondaryIds(item: Pick<WorkItem, 'kind' | 'title' | 'fileName' | 'displayId' | 'runCount'>) {
  if (item.kind === 'run') return [item.displayId, 'Unassigned'];
  const name = workItemName(item);
  return [
    item.displayId,
    ...(item.fileName ? [item.fileName] : []),
    ...(item.runCount > 1 ? [`${item.runCount} runs`] : []),
  ].filter((value) => value !== name);
}

/** Name of the item a machine is currently working on. */
export const currentItemName = (current: NonNullable<MachineCurrentItem>) =>
  current.kind === 'run'
    ? current.fileName
      ? nameFromFile(current.fileName)
      : current.displayId
    : displayName(current);

// ---------------------------------------------------------------------------
// Runs
// A run is one machine run: entered by hand (manual) or reported by a machine connector (recorded).
// ---------------------------------------------------------------------------

/** End of a run: the real end, otherwise the planned or estimated end. */
export const runEnd = (run: Pick<MachineRun, 'endedAt' | 'estimatedEndAt'>) =>
  run.endedAt ?? run.estimatedEndAt ?? null;

/**
 * State of a run now. A manual run is `running` until its planned end; the clock moves on between refreshes, so a
 * manual run whose planned end has passed already reads as finished.
 */
export function runStateNow(
  run: Pick<MachineRun, 'source' | 'state' | 'estimatedEndAt'>,
  now: number,
): MachineRunState {
  return run.source === 'manual' &&
    run.state === 'running' &&
    run.estimatedEndAt &&
    new Date(run.estimatedEndAt).getTime() <= now
    ? 'finished'
    : run.state;
}

export const isRunLive = (run: Pick<MachineRun, 'source' | 'state' | 'estimatedEndAt'>, now: number) =>
  runStateNow(run, now) === 'running';

/** 0-100 progress: the machine's figure, else the elapsed share of a planned runtime. */
export function runProgress(
  run: Pick<MachineRun, 'startedAt' | 'estimatedEndAt' | 'endedAt' | 'progressPercent'>,
  now: number,
) {
  if (run.progressPercent != null) return run.progressPercent;
  const start = new Date(run.startedAt).getTime();
  const end = new Date(run.endedAt ?? run.estimatedEndAt ?? run.startedAt).getTime();
  if (end <= start) return 100;
  return Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100)));
}

const runStateMeta: Record<
  MachineRunState,
  { label: string; type: 'blue' | 'green' | 'red' | 'gray' | 'outline'; icon: typeof InProgress }
> = {
  running: { label: 'Running', type: 'blue', icon: InProgress },
  finished: { label: 'Finished', type: 'green', icon: CheckmarkFilled },
  failed: { label: 'Failed', type: 'red', icon: ErrorFilled },
  cancelled: { label: 'Cancelled', type: 'gray', icon: Misuse },
  unknown: { label: 'Unknown', type: 'gray', icon: CircleDash },
  replaced: { label: 'Replaced', type: 'outline', icon: CircleDash },
};

export function RunStateTag({ state, size = 'md' }: { state: MachineRunState; size?: 'sm' | 'md' }) {
  const meta = runStateMeta[state];
  return (
    <Tag type={meta.type} size={size} renderIcon={meta.icon}>
      {meta.label}
    </Tag>
  );
}

export function RunSourceTag({ source, size = 'md' }: { source: MachineRun['source']; size?: 'sm' | 'md' }) {
  return source === 'recorded' ? (
    <Tag type="teal" size={size}>
      Recorded
    </Tag>
  ) : (
    <Tag type="gray" size={size}>
      Manual
    </Tag>
  );
}

/** Marks a value that the machine reported (material, outcome) rather than a person. */
export function FromMachineTag({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return (
    <Tag type="outline" size={size}>
      From machine
    </Tag>
  );
}

/** "12.5 g PLA Black, 3 pcs Insert", or "None recorded". */
export const usagesText = (usages: Pick<MachineJobUsage, 'quantity' | 'unit' | 'materialName'>[]) =>
  usages.length
    ? usages.map((usage) => `${formatQuantity(usage.quantity)} ${usage.unit} ${usage.materialName}`).join(', ')
    : 'None recorded';

/**
 * What a run consumed in each unit: "12,400 stitches · 0.4 m Stabilizer", "3.20 ml UV ink · 180 cm² DTF paper".
 * Runs that only used grams and have no measures keep the per-material text FDM always had.
 */
export function runConsumptionText(run: Pick<MachineRun, 'usages' | 'measures'>): string {
  const gramsOnly = run.usages.every((usage) => usage.unit === 'g');
  if (gramsOnly && Object.keys(run.measures ?? {}).length === 0) return usagesText(run.usages);
  return consumptionSummary(sumUsages(run.usages), run.measures) ?? 'None recorded';
}

function reportUsageMatches(run: Pick<MachineRun, 'reportedUsageItems' | 'usages'>) {
  const matches = new Map<number, MachineJobUsage>();
  const claimedUsageIDs = new Set<string>();
  const reportedUsageItems = Array.isArray(run.reportedUsageItems) ? run.reportedUsageItems : [];
  const usages = Array.isArray(run.usages) ? run.usages : [];

  // A connector-resolved spool is authoritative. Match those first so a
  // staff correction with the same quantity cannot claim the wrong line.
  for (const item of reportedUsageItems) {
    if (!item.spoolId) continue;
    const usage = usages.find((candidate) => candidate.spoolId === item.spoolId && !claimedUsageIDs.has(candidate.id));
    if (usage) {
      matches.set(item.lineNumber, usage);
      claimedUsageIDs.add(usage.id);
    }
  }

  // The machine report remains immutable. A staff-mapped line is presented
  // as resolved only when exactly one correction has its exact quantity (and
  // material, when the connector knew it).
  for (const item of reportedUsageItems) {
    if (matches.has(item.lineNumber)) continue;
    const quantity = item.estimatedQuantityGrams ?? item.plannedQuantityGrams;
    if (quantity == null) continue;
    const candidates = usages.filter(
      (usage) =>
        usage.staffCorrected &&
        !claimedUsageIDs.has(usage.id) &&
        Number(usage.quantity) === Number(quantity) &&
        (!item.materialId || usage.materialId === item.materialId),
    );
    if (candidates.length === 1) {
      matches.set(item.lineNumber, candidates[0]);
      claimedUsageIDs.add(candidates[0].id);
    }
  }
  return matches;
}

/** Report lines that still need a person to identify their physical spool. */
export function unresolvedReportedUsageItems(
  run: Pick<MachineRun, 'reportedUsageItems' | 'usages'>,
): MachineRunReportedUsageItem[] {
  const matches = reportUsageMatches(run);
  const reportedUsageItems = Array.isArray(run.reportedUsageItems) ? run.reportedUsageItems : [];
  return reportedUsageItems.filter((item) => {
    const quantity = item.estimatedQuantityGrams ?? item.plannedQuantityGrams;
    return quantity != null && Number(quantity) > 0 && !matches.has(item.lineNumber);
  });
}

/** What a machine reported for a run (grams), including unresolved itemized lines. */
export function reportedUsageText(
  run: Pick<MachineRun, 'reportedUsage'> & Partial<Pick<MachineRun, 'reportedUsageItems' | 'usages'>>,
) {
  if (run.reportedUsageItems?.length) {
    const matches = reportUsageMatches({ reportedUsageItems: run.reportedUsageItems, usages: run.usages ?? [] });
    return run.reportedUsageItems
      .map((item) => {
        const quantity = item.estimatedQuantityGrams ?? item.plannedQuantityGrams;
        const prefix = quantity == null ? 'Unknown quantity' : `${formatQuantity(quantity)} g`;
        const usage = matches.get(item.lineNumber);
        if (usage) {
          return `${prefix} ${usage.materialName}${usage.spoolDisplayId ? ` (${usage.spoolDisplayId})` : ''}${!item.spoolId ? ' · mapped by staff' : ''}`;
        }
        const filament = item.slicerFilamentId ? `filament ${item.slicerFilamentId}` : `line ${item.lineNumber + 1}`;
        if (item.inputUnitExternalId && item.slotExternalId) {
          const source =
            item.inputUnitExternalId === item.slotExternalId && ['254', '255'].includes(item.slotExternalId)
              ? `external spool ${item.slotExternalId}`
              : `input ${item.inputUnitExternalId}, slot ${item.slotExternalId}`;
          return `${prefix} ${filament} (${source})`;
        }
        return `${prefix} ${filament} (spool unresolved)`;
      })
      .join(', ');
  }
  return run.reportedUsage
    ? `${formatQuantity(run.reportedUsage.quantity)} g ${run.reportedUsage.materialName ?? 'unknown material'}${run.reportedUsage.spoolDisplayId ? ` (${run.reportedUsage.spoolDisplayId})` : ''}`
    : 'Nothing reported';
}

/** The manual runs a recorded run would replace: still part of the job and entered by hand. */
export const manualRuns = (job: Pick<MachineJob, 'runs'>) => activeRuns(job).filter((run) => run.source === 'manual');

/** True when replacing the job's manual runs changes anything they recorded. */
export function replaceChangesAnything(
  job: Pick<MachineJob, 'runs'>,
  run: Pick<MachineRun, 'startedAt' | 'durationSeconds' | 'usages' | 'reportedUsage'>,
) {
  const manual = manualRuns(job);
  if (manual.length === 0) return false;
  const start = Math.min(...manual.map((item) => new Date(item.startedAt).getTime()));
  const duration = manual.reduce((sum, item) => sum + item.durationSeconds, 0);
  const usages = manual.flatMap((item) => item.usages);
  const reported = run.reportedUsage;
  const sameUsage =
    !reported ||
    (usages.length === 1 &&
      Number(usages[0].quantity) === Number(reported.quantity) &&
      usages[0].materialName === reported.materialName);
  return start !== new Date(run.startedAt).getTime() || duration !== run.durationSeconds || !sameUsage;
}

// ---------------------------------------------------------------------------
// Machine availability
// ---------------------------------------------------------------------------

const availabilityMeta: Record<
  MachineAvailability,
  { label: string; type: 'blue' | 'green' | 'warm-gray' | 'gray'; icon: typeof InProgress }
> = {
  in_use: { label: 'In use', type: 'blue', icon: InProgress },
  available: { label: 'Available', type: 'green', icon: CheckmarkFilled },
  maintenance: { label: 'Maintenance', type: 'warm-gray', icon: PauseFilled },
  retired: { label: 'Retired', type: 'gray', icon: CircleDash },
};

export const availabilityLabel = (availability: MachineAvailability) => availabilityMeta[availability].label;

export function AvailabilityTag({
  availability,
  size = 'md',
}: {
  availability: MachineAvailability;
  size?: 'sm' | 'md';
}) {
  const meta = availabilityMeta[availability];
  return (
    <Tag type={meta.type} size={size} renderIcon={meta.icon}>
      {meta.label}
    </Tag>
  );
}

/** Text of a connector problem ("Connector degraded · E42"), or null when the connector is fine or absent. */
export function connectorIssue(connector: MachineConnectorState | undefined): string | null {
  if (!connector?.runtimeState || !['disconnected', 'degraded'].includes(connector.runtimeState)) return null;
  return `Connector ${connector.runtimeState}${connector.runtimeErrorCode ? ` · ${connector.runtimeErrorCode}` : ''}`;
}

export function ConnectorIssueTag({ issue }: { issue: string | null }) {
  if (!issue) return null;
  return (
    <Tag type="red" size="sm" renderIcon={WarningFilled} title={issue}>
      Connector issue
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Job outcome
// ---------------------------------------------------------------------------

const outcomeMeta: Record<
  MachineJobOutcome,
  { label: string; type: 'green' | 'red' | 'warm-gray' | 'gray'; icon: typeof InProgress }
> = {
  successful: { label: 'Successful', type: 'green', icon: CheckmarkFilled },
  partial_failure: { label: 'Partial failure', type: 'warm-gray', icon: WarningAltFilled },
  failed: { label: 'Failed', type: 'red', icon: ErrorFilled },
  cancelled: { label: 'Cancelled', type: 'gray', icon: Misuse },
  unknown: { label: 'Unknown outcome', type: 'gray', icon: CircleDash },
};

export const outcomeLabel = (outcome: MachineJobOutcome) => outcomeMeta[outcome].label;
export const outcomeOptions = (Object.keys(outcomeMeta) as MachineJobOutcome[]).map((id) => ({
  id,
  label: outcomeMeta[id].label,
}));

/** Outcome of a run, "Not recorded" while it is missing. */
export function RunOutcomeTag({
  outcome,
  size = 'md',
}: {
  outcome: MachineJobOutcome | null | undefined;
  size?: 'sm' | 'md';
}) {
  return outcome ? (
    <OutcomeTag outcome={outcome} size={size} />
  ) : (
    <Tag type="gray" size={size}>
      Not recorded
    </Tag>
  );
}

export function OutcomeTag({ outcome, size = 'md' }: { outcome: MachineJobOutcome; size?: 'sm' | 'md' }) {
  const meta = outcomeMeta[outcome];
  return (
    <Tag type={meta.type} size={size} renderIcon={meta.icon}>
      {meta.label}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Job / work item status: one primary status per row, from the API.
// ---------------------------------------------------------------------------

export type JobRowStatus = WorkItemStatus | 'planned';

const rowStatusMeta: Record<
  JobRowStatus,
  { label: string; type: 'blue' | 'green' | 'red' | 'warm-gray' | 'gray' | 'cyan' | 'magenta'; icon: typeof InProgress }
> = {
  planned: { label: 'Planned', type: 'gray', icon: CircleDash },
  running: { label: 'Running', type: 'blue', icon: InProgress },
  running_unassigned: { label: 'Running (unassigned)', type: 'cyan', icon: InProgress },
  unassigned: { label: 'Unassigned run', type: 'magenta', icon: Flag },
  needs_outcome: { label: 'Needs outcome', type: 'magenta', icon: WarningAltFilled },
  successful: outcomeMeta.successful,
  partial_failure: outcomeMeta.partial_failure,
  failed: outcomeMeta.failed,
  cancelled: outcomeMeta.cancelled,
};

export const jobRowStatusLabel = (status: JobRowStatus) => rowStatusMeta[status].label;
export const jobRowStatusOptions = (Object.keys(rowStatusMeta) as JobRowStatus[]).map((id) => ({
  id,
  label: rowStatusMeta[id].label,
}));

export function JobRowStatusTag({ status, size = 'md' }: { status: JobRowStatus; size?: 'sm' | 'md' }) {
  const meta = rowStatusMeta[status];
  return (
    <Tag type={meta.type} size={size} renderIcon={meta.icon}>
      {meta.label}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export type PriceAdjustmentValue = { kind: PriceAdjustmentKind; value: number };

/** Applies a manual adjustment to a calculated price (preview only; the backend computes the stored price). */
export function adjustPrice(calculated: number | null, adjustment: PriceAdjustmentValue | null): number | null {
  if (!adjustment) return calculated;
  if (adjustment.kind === 'fixed') return adjustment.value;
  if (calculated == null) return null;
  const result =
    adjustment.kind === 'discount_percent'
      ? calculated * (1 - adjustment.value / 100)
      : adjustment.kind === 'discount_amount'
        ? calculated - adjustment.value
        : calculated * adjustment.value;
  return Math.max(0, Math.round(result * 100) / 100);
}

export const adjustmentKindLabels: Record<PriceAdjustmentKind, string> = {
  fixed: 'Fixed price',
  discount_percent: 'Discount (%)',
  discount_amount: 'Discount (€)',
  multiplier: 'Multiplier',
};

/** "Discount 20 %", "Multiplier ×0.67", "Fixed price €5.00". */
export function adjustmentSummary(adjustment: { kind: PriceAdjustmentKind; value: string | number }) {
  if (adjustment.kind === 'fixed') return `Fixed price ${formatMoney(adjustment.value)}`;
  const value = formatQuantity(adjustment.value, 4);
  if (adjustment.kind === 'discount_percent') return `Discount ${value} %`;
  if (adjustment.kind === 'discount_amount') return `Discount ${formatMoney(adjustment.value)}`;
  return `Multiplier ×${value}`;
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const billingStateOptions: { id: JobBillingState; label: string }[] = [
  { id: 'on_order', label: 'On an order' },
  { id: 'order_outdated', label: 'Order outdated' },
  { id: 'not_on_order', label: 'Not on order' },
  { id: 'price_incomplete', label: 'Price incomplete' },
  { id: 'pending', label: 'Price pending' },
];

export function BillingTag({ billing }: { billing: WorkItemBilling | undefined }) {
  if (!billing) return null;
  if (billing.state === 'on_order')
    return (
      <Tag type="cool-gray" size="sm">
        {billing.orderReference ?? 'On order'}
      </Tag>
    );
  if (billing.state === 'order_outdated')
    return (
      <Tag type="red" size="sm">
        Order outdated
      </Tag>
    );
  if (billing.state === 'price_incomplete')
    return (
      <Tag type="red" size="sm">
        Price incomplete
      </Tag>
    );
  if (billing.state === 'not_on_order')
    return (
      <Tag type="outline" size="sm">
        Not on order
      </Tag>
    );
  return null;
}
