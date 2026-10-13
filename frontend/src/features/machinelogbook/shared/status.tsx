/* eslint-disable react-refresh/only-export-components -- status tags and the derivations they render form one module */
import { Tag } from '@carbon/react';
import { CheckmarkFilled, CircleDash, ErrorFilled, Flag, InProgress, Misuse, PauseFilled, WarningAltFilled, WarningFilled } from '@carbon/icons-react';
import type {
  JobBillingState, MachineAvailability, MachineConnectorState, MachineCurrentItem, MachineJob, MachineJobOutcome, PriceAdjustmentKind, Print, PrintState, WorkItem, WorkItemBilling, WorkItemStatus,
} from '../../../api/generated/models';
import { formatMoney, formatQuantity } from './format';

// ---------------------------------------------------------------------------
// Display names
// Only a job has an editable name. A print keeps the name its printer reported. A job without a name reads as its
// linked print's file name, made readable, else as its job number.
// ---------------------------------------------------------------------------

/** "gearbox_housing_v3.gcode" → "Gearbox housing v3": a readable suggestion for a job name. */
export function nameFromFile(fileName: string) {
  // Slicers stack extensions (Bambu: part.gcode.3mf), so strip known print extensions first.
  const stripped = fileName.replace(/(\.(gcode|bgcode|3mf|stl|step|stp|obj|svg|dxf))+$/i, '');
  const base = (stripped === fileName ? fileName.replace(/\.[^.]+$/, '') : stripped).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : fileName;
}

/** Title → readable file name → display ID. Works for anything that carries these three values. */
export const displayName = (item: { title?: string | null; fileName?: string | null; displayId: string }) => item.title || (item.fileName ? nameFromFile(item.fileName) : item.displayId);

/** The job's name, else its linked print's printer name, else the job number. */
export const machineJobName = (job: Pick<MachineJob, 'title' | 'displayId' | 'print'>) => displayName({ title: job.title, fileName: job.print?.fileName, displayId: job.displayId });

/** A work item row: a job reads by its display name, an unlinked print by the name its printer reported. */
export const workItemName = (item: Pick<WorkItem, 'kind' | 'title' | 'fileName' | 'displayId'>) => item.kind === 'print' ? item.fileName || item.displayId : displayName(item);

/** Other identifiers shown under the name (job number, file name; "Unlinked" for prints). */
export function workItemSecondaryIds(item: Pick<WorkItem, 'kind' | 'title' | 'fileName' | 'displayId' | 'printDisplayId'>) {
  if (item.kind === 'print') return [item.displayId, 'Unlinked'];
  const name = workItemName(item);
  return [item.displayId, ...(item.fileName ? [item.fileName] : [])].filter((value) => value !== name);
}

/** Name of the item a machine is currently working on. */
export const currentItemName = (current: NonNullable<MachineCurrentItem>) => current.kind === 'print' ? (current.fileName ? nameFromFile(current.fileName) : current.displayId) : displayName(current);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const isManualRunning = (job: Pick<MachineJob, 'run' | 'outcome' | 'endsAt'>, now: number) => job.run === 'manual' && job.outcome !== 'cancelled' && new Date(job.endsAt).getTime() > now;

/** 0-100 progress of a manual run. */
export function runProgress(job: Pick<MachineJob, 'startsAt' | 'endsAt'>, now: number) {
  const start = new Date(job.startsAt).getTime();
  const end = new Date(job.endsAt).getTime();
  if (end <= start) return 100;
  return Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100)));
}

// ---------------------------------------------------------------------------
// Machine availability
// ---------------------------------------------------------------------------

const availabilityMeta: Record<MachineAvailability, { label: string; type: 'blue' | 'green' | 'warm-gray' | 'gray'; icon: typeof InProgress }> = {
  in_use: { label: 'In use', type: 'blue', icon: InProgress },
  available: { label: 'Available', type: 'green', icon: CheckmarkFilled },
  maintenance: { label: 'Maintenance', type: 'warm-gray', icon: PauseFilled },
  retired: { label: 'Retired', type: 'gray', icon: CircleDash },
};

export function AvailabilityTag({ availability, size = 'md' }: { availability: MachineAvailability; size?: 'sm' | 'md' }) {
  const meta = availabilityMeta[availability];
  return <Tag type={meta.type} size={size} renderIcon={meta.icon}>{meta.label}</Tag>;
}

/** Text of a connector problem ("Connector degraded · E42"), or null when the connector is fine or absent. */
export function connectorIssue(connector: MachineConnectorState | undefined): string | null {
  if (!connector?.runtimeState || !['disconnected', 'degraded'].includes(connector.runtimeState)) return null;
  return `Connector ${connector.runtimeState}${connector.runtimeErrorCode ? ` · ${connector.runtimeErrorCode}` : ''}`;
}

export function ConnectorIssueTag({ issue }: { issue: string | null }) {
  if (!issue) return null;
  return <Tag type="red" size="sm" renderIcon={WarningFilled} title={issue}>Connector issue</Tag>;
}

// ---------------------------------------------------------------------------
// Job outcome
// ---------------------------------------------------------------------------

const outcomeMeta: Record<MachineJobOutcome, { label: string; type: 'green' | 'red' | 'warm-gray' | 'gray'; icon: typeof InProgress }> = {
  successful: { label: 'Successful', type: 'green', icon: CheckmarkFilled },
  partial_failure: { label: 'Partial failure', type: 'warm-gray', icon: WarningAltFilled },
  failed: { label: 'Failed', type: 'red', icon: ErrorFilled },
  cancelled: { label: 'Cancelled', type: 'gray', icon: Misuse },
  unknown: { label: 'Unknown outcome', type: 'gray', icon: CircleDash },
};

export const outcomeLabel = (outcome: MachineJobOutcome) => outcomeMeta[outcome].label;
export const outcomeOptions = (Object.keys(outcomeMeta) as MachineJobOutcome[]).map((id) => ({ id, label: outcomeMeta[id].label }));

export function OutcomeTag({ outcome, size = 'md' }: { outcome: MachineJobOutcome; size?: 'sm' | 'md' }) {
  const meta = outcomeMeta[outcome];
  return <Tag type={meta.type} size={size} renderIcon={meta.icon}>{meta.label}</Tag>;
}

// ---------------------------------------------------------------------------
// Job / work item status: one primary status per row, from the API.
// ---------------------------------------------------------------------------

const rowStatusMeta: Record<WorkItemStatus, { label: string; type: 'blue' | 'green' | 'red' | 'warm-gray' | 'gray' | 'cyan' | 'magenta'; icon: typeof InProgress }> = {
  running: { label: 'Running', type: 'blue', icon: InProgress },
  printing: { label: 'Printing (unlinked)', type: 'cyan', icon: InProgress },
  unlinked: { label: 'Unlinked print', type: 'magenta', icon: Flag },
  needs_outcome: { label: 'Needs outcome', type: 'magenta', icon: WarningAltFilled },
  successful: outcomeMeta.successful,
  partial_failure: outcomeMeta.partial_failure,
  failed: outcomeMeta.failed,
  cancelled: outcomeMeta.cancelled,
};

/** Status of a jobs list row: a work item's status, which also covers `MachineJob.status`. */
export type JobRowStatus = WorkItemStatus;

export const jobRowStatusLabel = (status: JobRowStatus) => rowStatusMeta[status].label;
export const jobRowStatusOptions = (Object.keys(rowStatusMeta) as JobRowStatus[]).map((id) => ({ id, label: rowStatusMeta[id].label }));

export function JobRowStatusTag({ status, size = 'md' }: { status: JobRowStatus; size?: 'sm' | 'md' }) {
  const meta = rowStatusMeta[status];
  return <Tag type={meta.type} size={size} renderIcon={meta.icon}>{meta.label}</Tag>;
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
  const result = adjustment.kind === 'discount_percent' ? calculated * (1 - adjustment.value / 100)
    : adjustment.kind === 'discount_amount' ? calculated - adjustment.value
      : calculated * adjustment.value;
  return Math.max(0, Math.round(result * 100) / 100);
}

export const adjustmentKindLabels: Record<PriceAdjustmentKind, string> = {
  fixed: 'Fixed price', discount_percent: 'Discount (%)', discount_amount: 'Discount (€)', multiplier: 'Multiplier',
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
  { id: 'on_order', label: 'On an order' }, { id: 'order_outdated', label: 'Order outdated' }, { id: 'not_on_order', label: 'Not on order' },
  { id: 'price_incomplete', label: 'Price incomplete' }, { id: 'pending', label: 'Price pending' },
];

export function BillingTag({ billing }: { billing: WorkItemBilling | undefined }) {
  if (!billing) return null;
  if (billing.state === 'on_order') return <Tag type="cool-gray" size="sm">{billing.orderReference ?? 'On order'}</Tag>;
  if (billing.state === 'order_outdated') return <Tag type="red" size="sm">Order outdated</Tag>;
  if (billing.state === 'price_incomplete') return <Tag type="red" size="sm">Price incomplete</Tag>;
  if (billing.state === 'not_on_order') return <Tag type="outline" size="sm">Not on order</Tag>;
  return null;
}

// ---------------------------------------------------------------------------
// Prints
// ---------------------------------------------------------------------------

const printMeta: Record<PrintState, { label: string; type: 'blue' | 'green' | 'red' | 'gray' }> = {
  printing: { label: 'Printing', type: 'blue' },
  finished: { label: 'Finished', type: 'green' },
  failed: { label: 'Failed', type: 'red' },
  cancelled: { label: 'Cancelled', type: 'gray' },
  unknown: { label: 'Unknown', type: 'gray' },
};

export function PrintStateTag({ state, size = 'md' }: { state: PrintState; size?: 'sm' | 'md' }) {
  return <Tag type={printMeta[state].type} size={size}>{printMeta[state].label}</Tag>;
}

/** End of a print: the real end, otherwise the printer's estimate. */
export const printEnd = (print: Pick<Print, 'endedAt' | 'estimatedEndAt'>) => print.endedAt ?? print.estimatedEndAt ?? null;

export function printDurationSeconds(print: Pick<Print, 'startedAt' | 'endedAt' | 'estimatedEndAt'>) {
  const end = printEnd(print);
  return end ? Math.max(0, Math.round((new Date(end).getTime() - new Date(print.startedAt).getTime()) / 1000)) : null;
}

/** Reported usage is in grams. */
export const printUsageText = (print: Pick<Print, 'reportedUsage'>) => print.reportedUsage
  ? `${formatQuantity(print.reportedUsage.quantity)} g ${print.reportedUsage.materialName ?? 'unknown material'}${print.reportedUsage.spoolDisplayId ? ` (${print.reportedUsage.spoolDisplayId})` : ''}`
  : 'Nothing reported';

export const jobUsageText = (job: Pick<MachineJob, 'usages'>) => job.usages.length ? job.usages.map((usage) => `${formatQuantity(usage.quantity)} ${usage.unit} ${usage.materialName}`).join(', ') : 'None recorded';

/** True when linking the print changes anything the manual run recorded. */
export function replaceChangesAnything(job: Pick<MachineJob, 'startsAt' | 'durationSeconds' | 'usages'>, print: Pick<Print, 'startedAt' | 'endedAt' | 'estimatedEndAt' | 'reportedUsage'>) {
  const duration = printDurationSeconds(print);
  const reported = print.reportedUsage;
  const sameUsage = !reported || (job.usages.length === 1 && Number(job.usages[0].quantity) === Number(reported.quantity) && job.usages[0].materialName === reported.materialName);
  return new Date(job.startsAt).getTime() !== new Date(print.startedAt).getTime() || (duration !== null && duration !== job.durationSeconds) || !sameUsage;
}
