/* eslint-disable react-refresh/only-export-components -- status tags and the derivations they render form one module */
import { Tag } from '@carbon/react';
import { CheckmarkFilled, CircleDash, ErrorFilled, Flag, InProgress, Misuse, PauseFilled, WarningAltFilled, WarningFilled } from '@carbon/icons-react';
import type { ConnectorHost, Job, JobOutcome, Machine, Print, PrintState, PriceAdjustment, PriceAdjustmentKind } from './types';
import { formatDateTime, formatTime } from '../../app/dateTime';

// ---------------------------------------------------------------------------
// Formatting (same conventions as features/machinelogbook/formatting.ts)
// ---------------------------------------------------------------------------

export { formatDateTime, formatTime };
export const formatMoney = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(value);
export const formatDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
export const formatHours = (seconds: number) => `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(seconds / 3600)} h`;
export function formatRelative(value: string) {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return formatDateTime(value);
}

// ---------------------------------------------------------------------------
// Runs
// A manual job whose defined end lies in the future is a simulated run: it ends
// at that time, or earlier when someone cancels it. A linked print that is
// still printing makes its job run, too.
// ---------------------------------------------------------------------------

export const isManualRunning = (job: Job, now: number) => job.run === 'manual' && job.outcome !== 'cancelled' && new Date(job.endsAt).getTime() > now;

/** 0-100 progress of a manual run. */
export function runProgress(job: Job, now: number) {
  const start = new Date(job.startsAt).getTime();
  const end = new Date(job.endsAt).getTime();
  if (end <= start) return 100;
  return Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100)));
}

// ---------------------------------------------------------------------------
// Machine availability
// Derived only from data the backend already exposes: administrative status,
// printing prints, running manual jobs and the connector assignment state.
// ---------------------------------------------------------------------------

export type MachineAvailability = 'in_use' | 'available' | 'maintenance' | 'retired';

export type CurrentItem = { kind: 'print' | 'job'; title: string; href: string; startedAt: string; endsAt: string | null };

export type MachineActivity = {
  availability: MachineAvailability;
  current?: CurrentItem;
  connectorIssue: string | null;
};

export function machineActivity(machine: Machine, prints: Print[], jobs: Job[], now: number): MachineActivity {
  const connectorIssue = machine.connection && ['disconnected', 'degraded'].includes(machine.connection.runtimeState)
    ? `Connector ${machine.connection.runtimeState}${machine.connection.runtimeErrorCode ? ` · ${machine.connection.runtimeErrorCode}` : ''}`
    : null;
  if (machine.status === 'retired') return { availability: 'retired', connectorIssue: null };
  if (machine.status === 'maintenance') return { availability: 'maintenance', connectorIssue };
  const print = prints.find((item) => item.machineId === machine.id && item.state === 'printing');
  if (print) {
    return { availability: 'in_use', connectorIssue, current: { kind: 'print', title: nameFromFile(print.fileName), href: `/jobs/prints/${print.id}`, startedAt: print.startedAt, endsAt: print.estimatedEndAt } };
  }
  const job = jobs.find((item) => item.machineId === machine.id && isManualRunning(item, now));
  if (job) return { availability: 'in_use', connectorIssue, current: { kind: 'job', title: jobName(job), href: `/jobs/${job.id}`, startedAt: job.startsAt, endsAt: job.endsAt } };
  return { availability: 'available', connectorIssue };
}

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

export function connectorStatus(host: ConnectorHost): { label: string; type: 'green' | 'purple' | 'red' | 'blue' | 'warm-gray' } {
  if (host.lifecycle === 'revoked') return { label: 'Revoked', type: 'red' };
  if (host.lifecycle === 'disabled') return { label: 'Disabled', type: 'warm-gray' };
  if (host.lifecycle === 'pending') return { label: 'Pending', type: 'blue' };
  if (host.healthState === 'degraded') return { label: 'Degraded', type: 'purple' };
  if (host.healthState === 'offline') return { label: 'Offline', type: 'red' };
  return { label: 'Healthy', type: 'green' };
}

export function ConnectorIssueTag({ issue }: { issue: string | null }) {
  if (!issue) return null;
  return <Tag type="red" size="sm" renderIcon={WarningFilled} title={issue}>Connector issue</Tag>;
}

// ---------------------------------------------------------------------------
// Job status
// A job has no single lifecycle enum. The UI shows one primary status:
// "Running" while its run is in progress, otherwise the recorded outcome.
// ---------------------------------------------------------------------------

const outcomeMeta: Record<JobOutcome, { label: string; type: 'green' | 'red' | 'warm-gray' | 'gray'; icon: typeof InProgress }> = {
  successful: { label: 'Successful', type: 'green', icon: CheckmarkFilled },
  partial_failure: { label: 'Partial failure', type: 'warm-gray', icon: WarningAltFilled },
  failed: { label: 'Failed', type: 'red', icon: ErrorFilled },
  cancelled: { label: 'Cancelled', type: 'gray', icon: Misuse },
  unknown: { label: 'Unknown outcome', type: 'gray', icon: CircleDash },
};

export const outcomeLabel = (outcome: JobOutcome) => outcomeMeta[outcome].label;
export const outcomeOptions = (Object.keys(outcomeMeta) as JobOutcome[]).map((id) => ({ id, label: outcomeMeta[id].label }));

export function OutcomeTag({ outcome, size = 'md' }: { outcome: JobOutcome; size?: 'sm' | 'md' }) {
  const meta = outcomeMeta[outcome];
  return <Tag type={meta.type} size={size} renderIcon={meta.icon}>{meta.label}</Tag>;
}

/** Applies a manual adjustment to a calculated price. Relative kinds need a calculated price. */
export function adjustPrice(calculated: number | null, adjustment: PriceAdjustment | null): number | null {
  if (!adjustment) return calculated;
  if (adjustment.kind === 'fixed') return adjustment.value;
  if (calculated == null) return null;
  const result = adjustment.kind === 'discount_percent' ? calculated * (1 - adjustment.value / 100)
    : adjustment.kind === 'discount_amount' ? calculated - adjustment.value
      : calculated * adjustment.value;
  return Math.max(0, Math.round(result * 100) / 100);
}

export const effectivePrice = (job: Job) => adjustPrice(job.calculatedPrice, job.priceAdjustment);

export const adjustmentKindLabels: Record<PriceAdjustmentKind, string> = {
  fixed: 'Fixed price', discount_percent: 'Discount (%)', discount_amount: 'Discount (€)', multiplier: 'Multiplier',
};

/** "Discount 20 %", "Multiplier ×0.67", "Fixed price €5.00". */
export function adjustmentSummary(adjustment: PriceAdjustment) {
  if (adjustment.kind === 'fixed') return `Fixed price ${formatMoney(adjustment.value)}`;
  if (adjustment.kind === 'discount_percent') return `Discount ${adjustment.value} %`;
  if (adjustment.kind === 'discount_amount') return `Discount ${formatMoney(adjustment.value)}`;
  return `Multiplier ×${adjustment.value}`;
}

export type BillingState = 'on_order' | 'order_outdated' | 'ready' | 'price_incomplete' | 'pending';
export function billingState(job: Job): BillingState {
  if (job.order) return job.order.sourceChanged ? 'order_outdated' : 'on_order';
  if (job.pricingStatus === 'pending') return 'pending';
  if (job.pricingStatus === 'incomplete') return 'price_incomplete';
  return 'ready';
}

export function BillingTag({ job }: { job: Job }) {
  const state = billingState(job);
  if (state === 'on_order') return <Tag type="cool-gray" size="sm">{job.order!.orderReference}</Tag>;
  if (state === 'order_outdated') return <Tag type="red" size="sm">Order outdated</Tag>;
  if (state === 'price_incomplete') return <Tag type="red" size="sm">Price incomplete</Tag>;
  if (state === 'ready') return <Tag type="outline" size="sm">Not on order</Tag>;
  return null;
}

// ---------------------------------------------------------------------------
// Print status
// ---------------------------------------------------------------------------

const printMeta: Record<PrintState, { label: string; type: 'blue' | 'green' | 'red' | 'gray' }> = {
  printing: { label: 'Printing', type: 'blue' },
  finished: { label: 'Finished', type: 'green' },
  failed: { label: 'Failed', type: 'red' },
  cancelled: { label: 'Cancelled', type: 'gray' },
};

/** End of a print: the real end, otherwise the printer's estimate. */
export const printEnd = (print: Print) => print.endedAt ?? print.estimatedEndAt;
export const printDurationSeconds = (print: Print) => {
  const end = printEnd(print);
  return end ? Math.max(0, Math.round((new Date(end).getTime() - new Date(print.startedAt).getTime()) / 1000)) : null;
};
export const printUsageText = (print: Print) => print.reportedUsage
  ? `${print.reportedUsage.quantity} ${print.reportedUsage.unit} ${print.reportedUsage.materialName}${print.reportedUsage.spoolDisplayId ? ` (${print.reportedUsage.spoolDisplayId})` : ''}`
  : 'Nothing reported';
export const jobUsageText = (job: Job) => job.usages.length ? job.usages.map((usage) => `${usage.quantity} ${usage.unit} ${usage.materialName}`).join(', ') : 'None recorded';

/** True when linking the print changes anything the manual run recorded. */
export function replaceChangesAnything(job: Job, print: Print) {
  const duration = printDurationSeconds(print);
  const reported = print.reportedUsage;
  const sameUsage = !reported || (job.usages.length === 1 && job.usages[0].quantity === reported.quantity && job.usages[0].materialName === reported.materialName);
  return job.startsAt !== print.startedAt || (duration !== null && duration !== job.durationSeconds) || !sameUsage;
}

export function PrintStateTag({ state, size = 'md' }: { state: PrintState; size?: 'sm' | 'md' }) {
  return <Tag type={printMeta[state].type} size={size}>{printMeta[state].label}</Tag>;
}

// ---------------------------------------------------------------------------
// Unified Jobs rows
// Prints come from printers; nobody creates them. A print that is linked to a
// job is shown as that job; every other print is its own "unlinked" row.
// ---------------------------------------------------------------------------

export type JobRowStatus = 'running' | 'printing' | 'unlinked' | 'needs_outcome' | JobOutcome;

const rowStatusMeta: Record<JobRowStatus, { label: string; type: 'blue' | 'green' | 'red' | 'warm-gray' | 'gray' | 'cyan' | 'magenta'; icon: typeof InProgress }> = {
  running: { label: 'Running', type: 'blue', icon: InProgress },
  printing: { label: 'Printing (unlinked)', type: 'cyan', icon: InProgress },
  unlinked: { label: 'Unlinked print', type: 'magenta', icon: Flag },
  needs_outcome: { label: 'Needs outcome', type: 'magenta', icon: WarningAltFilled },
  successful: outcomeMeta.successful,
  partial_failure: outcomeMeta.partial_failure,
  failed: outcomeMeta.failed,
  cancelled: outcomeMeta.cancelled,
  unknown: outcomeMeta.unknown,
};

export const jobRowStatusLabel = (status: JobRowStatus) => rowStatusMeta[status].label;
// 'unknown' is never shown on its own: a finished job without an outcome reads as 'needs_outcome'.
export const jobRowStatusOptions = (Object.keys(rowStatusMeta) as JobRowStatus[]).filter((id) => id !== 'unknown').map((id) => ({ id, label: rowStatusMeta[id].label }));

export function JobRowStatusTag({ status, size = 'md' }: { status: JobRowStatus; size?: 'sm' | 'md' }) {
  const meta = rowStatusMeta[status];
  return <Tag type={meta.type} size={size} renderIcon={meta.icon}>{meta.label}</Tag>;
}

export function jobStatus(job: Job, print: Print | null | undefined, now: number): JobRowStatus {
  if (print?.state === 'printing' || isManualRunning(job, now)) return 'running';
  // The outcome is only known once the run has ended; until it is recorded the job asks for it.
  return job.outcome === 'unknown' ? 'needs_outcome' : job.outcome;
}

export type JobRow = {
  id: string;
  kind: 'job' | 'print';
  title: string;
  /** Other identifiers shown under the title (file name, print id). */
  secondaryIds: string[];
  machineId: string;
  machineName: string;
  customer: string | null;
  customerId: string | null;
  operator: string | null;
  operatorId: string | null;
  startedAt: string;
  status: JobRowStatus;
  price: number | null;
  href: string;
  job: Job | null;
  /** The unlinked print of a print row, or the print linked to a job row. */
  print: Print | null;
  run: 'manual' | 'printer';
  materialIds: string[];
  materialNames: string[];
};

/** "gearbox_housing_v3.gcode" → "Gearbox housing v3": a readable suggestion for a job name. */
export function nameFromFile(fileName: string) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : fileName;
}

/** The job's name, else its linked print's printer name, else the job number. */
export function jobName(job: Job, print?: Print | null) {
  return job.title ?? (print ? nameFromFile(print.fileName) : job.displayId);
}

export function buildJobRows(jobs: Job[], prints: Print[], machines: Machine[], now: number): JobRow[] {
  const machineName = (id: string) => machines.find((machine) => machine.id === id)?.name ?? 'Unknown machine';
  const printById = new Map(prints.map((print) => [print.id, print]));

  const jobRows = jobs.map<JobRow>((job) => {
    const print = job.printId ? printById.get(job.printId) ?? null : null;
    return {
      id: job.id, kind: 'job', title: jobName(job, print), secondaryIds: [job.displayId, ...(print ? [print.fileName] : [])].filter((value) => value !== jobName(job, print)),
      machineId: job.machineId, machineName: machineName(job.machineId),
      customer: job.customer?.displayName ?? null, customerId: job.customer?.id ?? null,
      operator: job.operator?.displayName ?? null, operatorId: job.operator?.personId ?? null,
      startedAt: job.startsAt, status: jobStatus(job, print, now), price: effectivePrice(job), href: `/jobs/${job.id}`, job, print,
      run: job.run === 'manual' ? 'manual' : 'printer',
      materialIds: job.usages.flatMap((usage) => usage.materialId ? [usage.materialId] : []),
      materialNames: job.usages.map((usage) => usage.materialName),
    };
  });

  const printRows = prints.filter((print) => !print.linkedJobId).map<JobRow>((print) => ({
    id: print.id, kind: 'print', title: print.fileName, secondaryIds: [print.displayId, 'Unlinked'],
    machineId: print.machineId, machineName: machineName(print.machineId),
    customer: null, customerId: null, operator: null, operatorId: null,
    startedAt: print.startedAt, status: print.state === 'printing' ? 'printing' : 'unlinked', price: null,
    href: `/jobs/prints/${print.id}`, job: null, print, run: 'printer',
    materialIds: print.reportedUsage?.materialId ? [print.reportedUsage.materialId] : [],
    materialNames: print.reportedUsage ? [print.reportedUsage.materialName] : [],
  }));

  return [...jobRows, ...printRows];
}
