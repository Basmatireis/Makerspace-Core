import type { JobOrderAssociation, MachineJob, MachineRun, WorkItemBilling } from '../../../api/generated/models';
import { saveError } from '../dialogs/jobFormHelpers';
import {
  consumptionNeedsSomeone,
  consumptionNotice,
  internalStorageShortMessage,
  isOnInternalStorage,
} from '../recording/recordingText';
import { activeRuns, isRunLive, type JobRowStatus } from '../shared/status';

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

export type RunAction = 'edit' | 'usage' | 'cancel' | 'delete' | 'detach';

/** Actions available for one run of a job, depending on the permissions of the viewer. */
export function runActions(
  run: MachineRun,
  now: number,
  canEdit: boolean,
  canDelete: boolean,
): { action: RunAction; label: string; isDelete?: boolean }[] {
  if (run.state === 'replaced') return [];
  const live = isRunLive(run, now);
  const mayDelete = canDelete || (run.source === 'manual' && canEdit);
  return [
    // A running recorded run has no start to correct and cannot have an outcome yet.
    ...(canEdit && (run.source === 'manual' || !live) ? [{ action: 'edit' as const, label: 'Edit run' }] : []),
    ...(canEdit ? [{ action: 'usage' as const, label: 'Edit material usage' }] : []),
    ...(canEdit && run.source === 'manual' && live ? [{ action: 'cancel' as const, label: 'Cancel run' }] : []),
    ...(canEdit && run.source === 'recorded'
      ? [{ action: 'detach' as const, label: 'Detach from job', isDelete: true }]
      : []),
    ...(mayDelete ? [{ action: 'delete' as const, label: 'Delete run', isDelete: true }] : []),
  ];
}

/**
 * What a run of a job still needs, for its attention flag: material that is missing, partly booked or still pending
 * after the run ended, as the backend's consumption_unconfirmed. A print cancelled before its first layer used none.
 */
export function runAttention(run: MachineRun, now: number): { code: string; message: string }[] {
  const status = run.consumptionStatus;
  if (run.source !== 'recorded' || run.state === 'replaced' || !status) return [];
  const open = consumptionNeedsSomeone(status) || (status.state === 'pending' && !isRunLive(run, now));
  const notice = consumptionNotice(status);
  if (!open || !notice) return [];
  const message = isOnInternalStorage(status) ? internalStorageShortMessage : notice.message;
  return [{ code: 'consumption_unconfirmed', message: `${notice.title}. ${message}` }];
}

export type JobDialog = 'edit' | 'override' | 'clear' | 'add-run' | 'attach' | 'delete' | 'reprice' | null;
