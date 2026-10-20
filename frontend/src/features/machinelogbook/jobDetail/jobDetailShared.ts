import type { JobOrderAssociation, MachineJob, WorkItemBilling } from '../../../api/generated/models';
import { saveError } from '../dialogs/jobFormHelpers';
import { activeRuns, isRunLive, type JobRowStatus } from '../shared/status';

export const usageHeaders = [
  { key: 'material', header: 'Material' },
  { key: 'run', header: 'Run' },
  { key: 'source', header: 'Source' },
  { key: 'quantity', header: 'Quantity' },
];

/** What the job list shows as billing state; the job itself carries no billing field, only price status and the order association. */
export function jobBilling(job: MachineJob, association: JobOrderAssociation | undefined): WorkItemBilling | undefined {
  if (association?.orderId)
    return {
      state: association.sourceChanged ? 'order_outdated' : 'on_order',
      orderId: association.orderId,
      orderReference: association.orderReference,
    };
  if (job.pricingStatus === 'pending') return { state: 'pending' };
  if (job.pricingStatus === 'incomplete') return { state: 'price_incomplete' };
  return association ? { state: 'not_on_order' } : undefined;
}

export const errorText = (error: unknown, fallback: string) => saveError(error, fallback).message;

/** Status of the job now: a run whose planned end has passed since the last refresh no longer counts as running. */
export function statusNow(job: MachineJob, now: number): JobRowStatus {
  if (job.status !== 'running') return job.status;
  if (activeRuns(job).some((run) => isRunLive(run, now))) return 'running';
  if (job.outcomeOverridden) return job.outcome === 'unknown' ? 'needs_outcome' : job.outcome;
  return activeRuns(job).some((run) => !run.outcome) || job.outcome === 'unknown' ? 'needs_outcome' : job.outcome;
}

/** Runs that have ended without a recorded outcome. */
export const runsNeedingOutcome = (job: MachineJob, now: number) =>
  activeRuns(job).filter((run) => !run.outcome && !isRunLive(run, now));

export type JobDialog = 'edit' | 'override' | 'clear' | 'add-run' | 'attach' | 'delete' | null;
