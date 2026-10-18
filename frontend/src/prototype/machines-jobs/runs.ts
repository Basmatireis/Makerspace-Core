import type { Job, JobOutcome, Print, PrintUsage } from './types';
import type { Permission } from './store';
import type { JobRow } from './derived';

// Pure helpers for jobs that own several recorded runs (UI wording "run"; the type is still `Print`).

export const runsOfJob = (jobId: string, prints: Print[]) => prints.filter((print) => print.linkedJobId === jobId);
const endOf = (print: Print) => print.endedAt ?? print.estimatedEndAt ?? print.startedAt;
const byStart = (a: Print, b: Print) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();

/** Earliest start, latest end and the summed machine time of the runs. */
export function runsSummary(runs: Print[]) {
  const sorted = [...runs].sort(byStart);
  const startsAt = sorted[0].startedAt;
  const endsAt = runs.map(endOf).reduce((latest, value) => (new Date(value) > new Date(latest) ? value : latest));
  const durationSeconds = Math.max(60, runs.reduce((sum, run) => sum + Math.max(0, Math.round((new Date(endOf(run)).getTime() - new Date(run.startedAt).getTime()) / 1000)), 0));
  return { startsAt, endsAt, durationSeconds, first: sorted[0] };
}

/** Reported material of several runs, summed per material and spool. */
export function sumReportedUsages(runs: Print[]): PrintUsage[] {
  const sums = new Map<string, PrintUsage>();
  for (const run of runs) {
    const usage = run.reportedUsage;
    if (!usage) continue;
    const key = `${usage.materialId ?? usage.materialName}|${usage.spoolDisplayId ?? ''}`;
    const existing = sums.get(key);
    sums.set(key, existing ? { ...existing, quantity: Math.round((existing.quantity + usage.quantity) * 1000) / 1000 } : { ...usage });
  }
  return [...sums.values()];
}

/** How a job that gathers these runs ended: all good, all bad, or mixed. */
export function outcomeFromRuns(runs: Print[]): JobOutcome {
  if (runs.some((run) => run.state === 'printing')) return 'unknown';
  const failed = runs.filter((run) => run.state === 'failed').length;
  const cancelled = runs.filter((run) => run.state === 'cancelled').length;
  if (failed + cancelled === 0) return 'successful';
  if (cancelled === runs.length) return 'cancelled';
  if (failed === runs.length) return 'failed';
  return 'partial_failure';
}

export type PlannedUsage = PrintUsage;

/** What a job looks like after runs are attached: the job's own numbers plus the runs it already has. */
export function planAttach(job: Job, current: Print[], added: Print[]) {
  const all = [...current, ...added];
  const summary = runsSummary(all);
  const reported = sumReportedUsages(added);
  const replacesManual = current.length === 0;
  const own: PlannedUsage[] = replacesManual ? [] : job.usages.map((usage) => ({ materialId: usage.materialId, materialName: usage.materialName, spoolDisplayId: usage.spoolDisplayId, quantity: usage.quantity, unit: usage.unit }));
  const usages = [...own];
  for (const usage of reported) {
    const match = usages.find((item) => (item.materialId ?? item.materialName) === (usage.materialId ?? usage.materialName) && item.spoolDisplayId === usage.spoolDisplayId);
    if (match) match.quantity = Math.round((match.quantity + usage.quantity) * 1000) / 1000; else usages.push({ ...usage });
  }
  // A manual job keeps its recorded material when none of the runs reported any.
  const keepsOwn = replacesManual && reported.length === 0;
  return {
    ...summary, replacesManual, runCount: all.length,
    usages: keepsOwn ? job.usages.map((usage): PlannedUsage => ({ materialId: usage.materialId, materialName: usage.materialName, spoolDisplayId: usage.spoolDisplayId, quantity: usage.quantity, unit: usage.unit })) : usages,
  };
}

export const usageListText = (usages: PrintUsage[]) => usages.length ? usages.map((usage) => `${usage.quantity} ${usage.unit} ${usage.materialName}`).join(', ') : 'None recorded';

// ---------------------------------------------------------------------------
// Batch actions on the Jobs table
// ---------------------------------------------------------------------------

export type BatchAction = 'delete' | 'separate' | 'combined' | 'attach';
export type BatchAvailability = { enabled: boolean; reason: string | null };

export const hasBookedMaterial = (job: Job) => job.usages.some((usage) => usage.ownership === 'makerspace');

/** Why a job or run can not be deleted, or null when it can. */
export function deleteBlocker(row: JobRow): string | null {
  if (row.job?.order) return `${row.job.displayId} is on order ${row.job.order.orderReference} — remove it from the order first`;
  if (row.print && row.kind === 'print' && row.print.state === 'printing') return `${row.print.displayId} is still running — wait until it has ended`;
  return null;
}

export function batchAvailability(rows: JobRow[], can: (permission: Permission) => boolean): Record<BatchAction, BatchAvailability> {
  const ok: BatchAvailability = { enabled: true, reason: null };
  const no = (reason: string): BatchAvailability => ({ enabled: false, reason });
  const runs = rows.filter((row) => row.kind === 'print');
  const machines = new Set(runs.map((row) => row.machineId));

  const runBase = (permission: Permission, label: string, minimum: number): BatchAvailability | null => {
    if (!can(permission)) return no(`${label}: you do not have permission for this.`);
    if (rows.length === 0) return no(`${label}: select unassigned runs first.`);
    if (runs.length < rows.length) return no(`${label}: only unassigned runs can be used — deselect the jobs.`);
    if (runs.some((row) => row.print?.state === 'printing')) return no(`${label}: runs that are still running can not be used.`);
    if (runs.length < minimum) return no(`${label}: select at least ${minimum} unassigned runs.`);
    return null;
  };

  const deletable = rows.filter((row) => deleteBlocker(row) === null);
  return {
    delete: !can('machine_jobs.delete') ? no('Delete: you do not have permission to delete jobs and runs.')
      : deletable.length === 0 ? no('Delete: every selected item is on an order or still running.') : ok,
    separate: runBase('machine_jobs.create', 'Create separate jobs', 1) ?? ok,
    combined: runBase('machine_jobs.create', 'Create combined job', 2) ?? (machines.size > 1 ? no('Create combined job: runs are on different machines.') : ok),
    attach: runBase('machine_jobs.edit', 'Attach to job', 1) ?? (machines.size > 1 ? no('Attach to job: runs are on different machines.') : ok),
  };
}
