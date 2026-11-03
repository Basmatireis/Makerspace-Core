/* eslint-disable react-refresh/only-export-components -- tags and their helpers belong together */
import { Tag } from '@carbon/react';
import type { JobBillingState, WorkItemBilling, WorkItemStatus } from '../../../api/generated/models';
import { RefLink } from '../../../app/RefLink';
import { formatDuration } from '../shared/format';
import type { JobRowStatus } from '../shared/status';
import './jobs.scss';

export type JobPhase = 'planned' | 'running' | 'finished';

/** Planned, running or finished: the status column of the jobs table; the outcome is a separate fact. */
export const jobPhase = (status: JobRowStatus): JobPhase =>
  status === 'planned' ? 'planned' : status === 'running' || status === 'running_unassigned' ? 'running' : 'finished';

const phaseMeta: Record<JobPhase, { label: string; type: 'gray' | 'blue' | 'teal' }> = {
  planned: { label: 'Planned', type: 'gray' },
  running: { label: 'Running', type: 'blue' },
  finished: { label: 'Finished', type: 'teal' },
};

export function JobPhaseTag({ status }: { status: JobRowStatus }) {
  const meta = phaseMeta[jobPhase(status)];
  return (
    <Tag type={meta.type} size="sm">
      {meta.label}
    </Tag>
  );
}

const outcomeMeta: Record<string, { label: string; type: 'green' | 'warm-gray' | 'red' | 'gray' | 'purple' }> = {
  successful: { label: 'Successful', type: 'green' },
  partial_failure: { label: 'Partial failure', type: 'warm-gray' },
  failed: { label: 'Failed', type: 'red' },
  cancelled: { label: 'Cancelled', type: 'gray' },
  needs_outcome: { label: 'Not recorded', type: 'purple' },
  unknown: { label: 'Not recorded', type: 'purple' },
};

/** The outcome of a finished job or run; nothing while it is planned or running. */
export function OutcomeStatusTag({ status }: { status: JobRowStatus | string }) {
  const meta = outcomeMeta[status];
  if (!meta) return null;
  return (
    <Tag type={meta.type} size="sm">
      {meta.label}
    </Tag>
  );
}

export const statusFilterOptions: { id: JobPhase; label: string }[] = [
  { id: 'planned', label: 'Planned' },
  { id: 'running', label: 'Running' },
  { id: 'finished', label: 'Finished' },
];
export const outcomeFilterOptions = [
  { id: 'successful', label: 'Successful' },
  { id: 'partial_failure', label: 'Partial failure' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'none', label: 'Not recorded' },
];
export const billingFilterOptions: { id: JobBillingState; label: string }[] = [
  { id: 'not_on_order', label: 'Not billed' },
  { id: 'on_order', label: 'On an order' },
  { id: 'order_outdated', label: 'Order outdated' },
  { id: 'price_incomplete', label: 'Price incomplete' },
];
export const sourceFilterOptions = [
  { id: 'manual', label: 'Manual' },
  { id: 'recorded', label: 'Recorded by a machine' },
];

const phaseStatuses: Record<JobPhase, WorkItemStatus[]> = {
  planned: ['planned'],
  running: ['running'],
  finished: ['needs_outcome', 'successful', 'partial_failure', 'failed', 'cancelled'],
};

/** The work-item statuses that match the status and outcome filters, or null when they exclude each other. */
export function statusesFor(phase: string, outcome: string): WorkItemStatus[] | null {
  const byPhase: WorkItemStatus[] =
    phase in phaseStatuses
      ? phaseStatuses[phase as JobPhase]
      : [...phaseStatuses.planned, ...phaseStatuses.running, ...phaseStatuses.finished];
  if (!outcome) return byPhase;
  const wanted: WorkItemStatus = outcome === 'none' ? 'needs_outcome' : (outcome as WorkItemStatus);
  return byPhase.includes(wanted) ? [wanted] : null;
}

/** What the billing column says: nothing while running, else Not billed, the order, Order outdated or Price incomplete. */
export function BillingText({ status, billing }: { status: JobRowStatus; billing: WorkItemBilling | undefined }) {
  if (jobPhase(status) !== 'finished' || !billing || billing.state === 'pending')
    return <span className="mj-secondary">—</span>;
  if (billing.state === 'on_order')
    return <RefLink kind="order" reference={billing.orderReference ?? 'Order'} id={billing.orderId} />;
  if (billing.state === 'order_outdated') return <span className="jobs-error-text">Order outdated</span>;
  if (billing.state === 'price_incomplete') return <span className="jobs-error-text">Price incomplete</span>;
  return <span>Not billed</span>;
}

/** Seconds between start and end, or until now while running. */
export const spanSeconds = (startedAt: string, endsAt: string | null | undefined, now = Date.now()) =>
  Math.max(0, Math.round(((endsAt ? new Date(endsAt).getTime() : now) - new Date(startedAt).getTime()) / 1000));

export const spanText = (startedAt: string, endsAt: string | null | undefined, running: boolean) =>
  `${formatDuration(spanSeconds(startedAt, running ? null : endsAt))}${running ? ' so far' : ''}`;
