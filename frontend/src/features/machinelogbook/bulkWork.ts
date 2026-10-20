import type { WorkItem } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import type { PermissionIdType } from '../auth/permissions';

/**
 * Rules for the batch actions of the Jobs table. They only decide what the UI offers; the server applies the same
 * rules in one transaction and refuses the whole request when an item is blocked.
 */
export type BatchAction = 'delete' | 'separate' | 'combined' | 'attach';
export type BatchAvailability = { enabled: boolean; reason: string | null };
type Can = (permission: PermissionIdType) => boolean;

/** True for a recorded run the machine still reports. */
export const isRunning = (item: WorkItem) => item.kind === 'run' && item.status === 'running_unassigned';

/** Why a job or run is skipped by "Delete", or null when it can be deleted. */
export function deleteBlocker(item: WorkItem): string | null {
  const billing = item.billing;
  if (item.kind === 'job' && billing && (billing.state === 'on_order' || billing.state === 'order_outdated')) {
    return billing.orderReference
      ? `${item.displayId} is on order ${billing.orderReference} — remove it from the order first`
      : `${item.displayId} is on an order — remove it from the order first`;
  }
  if (isRunning(item)) return `${item.displayId} is still running — wait until it has ended`;
  return null;
}

/** Whether deleting the item can return material to stock: own material was consumed (customer material never touched stock). */
export const hasBookedMaterial = (item: WorkItem) =>
  (item.consumption?.materials ?? []).some(
    (material) => material.materialTypeName !== 'External' && Number(material.quantity) > 0,
  );

/** Reference -> entity id for the references the skip reasons mention, so they become links. */
export function referenceTargets(items: WorkItem[]): Record<string, string> {
  const targets: Record<string, string> = {};
  for (const item of items) {
    targets[item.displayId] = item.id;
    if (item.billing?.orderReference && item.billing.orderId)
      targets[item.billing.orderReference] = item.billing.orderId;
  }
  return targets;
}

export function batchAvailability(items: WorkItem[], can: Can): Record<BatchAction, BatchAvailability> {
  const ok: BatchAvailability = { enabled: true, reason: null };
  const no = (reason: string): BatchAvailability => ({ enabled: false, reason });
  const runs = items.filter((item) => item.kind === 'run');
  const machines = new Set(runs.map((item) => item.machineId));

  const runBase = (permission: PermissionIdType, label: string, minimum: number): BatchAvailability | null => {
    if (!can(permission)) return no(`${label}: you do not have permission for this.`);
    if (items.length === 0) return no(`${label}: select unassigned runs first.`);
    if (runs.length < items.length) return no(`${label}: only unassigned runs can be used — deselect the jobs.`);
    if (runs.some(isRunning)) return no(`${label}: runs that are still running can not be used.`);
    if (runs.length < minimum) return no(`${label}: select at least ${minimum} unassigned runs.`);
    return null;
  };

  const deletable = items.filter((item) => deleteBlocker(item) === null);
  return {
    delete: !can('machine_jobs.delete')
      ? no('Delete: you do not have permission to delete jobs and runs.')
      : deletable.length === 0
        ? no('Delete: every selected item is on an order or still running.')
        : ok,
    separate: runBase('machine_jobs.create', 'Create separate jobs', 1) ?? ok,
    combined:
      runBase('machine_jobs.create', 'Create combined job', 2) ??
      (machines.size > 1 ? no('Create combined job: runs are on different machines.') : ok),
    attach:
      runBase('machine_jobs.edit', 'Attach to job', 1) ??
      (machines.size > 1 ? no('Attach to job: runs are on different machines.') : ok),
  };
}

/** Whether the person may use any batch action; without one the table offers no selection. */
export const canSelectWork = (can: Can) =>
  can('machine_jobs.create') || can('machine_jobs.edit') || can('machine_jobs.delete');

export type BlockedItem = { kind: string; id: string; displayId: string; code: string; message: string };

/** The items a bulk request was refused for (409 bulk_blocked), or null for any other failure. */
export function blockedItems(error: unknown): BlockedItem[] | null {
  if (!(error instanceof ApiError) || error.data?.code !== 'bulk_blocked') return null;
  const items = (error.data.details as { items?: BlockedItem[] } | undefined)?.items;
  return Array.isArray(items) ? items : null;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
