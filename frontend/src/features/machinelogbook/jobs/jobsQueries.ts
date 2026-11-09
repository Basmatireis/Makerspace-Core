import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { updateMachineJob } from '../../../api/generated/machine-jobs/machine-jobs';
import { attachMachineRun } from '../../../api/generated/machine-runs/machine-runs';
import { addOrderItem, createOrder, listOrders } from '../../../api/generated/orders/orders';
import type {
  BillingParty,
  MachineJob,
  MachineRunOutcome,
  Order,
  UpdateMachineJobRequest,
  WorkItemStatus,
} from '../../../api/generated/models';
import { machineLogbookKeys } from '../queries';

/** Statuses of jobs in the work-item list; the remaining ones belong to unassigned runs. */
export const jobStatuses: WorkItemStatus[] = [
  'planned',
  'running',
  'needs_outcome',
  'successful',
  'partial_failure',
  'failed',
  'cancelled',
];
/** Statuses of recorded runs without a job. */
export const unassignedStatuses: WorkItemStatus[] = ['running_unassigned', 'unassigned'];

/**
 * The update request that keeps every fact of a job and changes only `patch` (notes, signage flag). The update
 * endpoint replaces title, notes and the outcome override, so they are sent as they are.
 */
export function jobFactsUpdate(
  job: MachineJob,
  patch: Partial<Pick<UpdateMachineJobRequest, 'notes' | 'hiddenFromSignage'>>,
): UpdateMachineJobRequest | null {
  if (!job.operator) return null;
  return {
    machineId: job.machine.id,
    customer: job.customer ? { kind: job.customer.kind, id: job.customer.id } : undefined,
    operatorPersonId: job.operator.personId,
    title: job.title ?? null,
    notes: job.notes ?? null,
    outcomeOverride: job.outcomeOverridden && job.outcome !== 'unknown' ? (job.outcome as MachineRunOutcome) : null,
    expectedVersion: job.version,
    ...patch,
  };
}

/** Saves notes or the signage flag of a job without touching its other facts. */
export function useUpdateJobFacts(job: MachineJob) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Pick<UpdateMachineJobRequest, 'notes' | 'hiddenFromSignage'>>) => {
      const request = jobFactsUpdate(job, patch);
      if (!request) throw new Error('The job has no operator; edit the job to choose one first.');
      return updateMachineJob(job.id, request);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: machineLogbookKeys.all }),
  });
}

/** Attaches a recorded run to a job; `hiddenFromSignage` sets the job's signage flag as well. */
export function useAttachRunToJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      runId,
      job,
      replaceManualRuns,
      hiddenFromSignage,
    }: {
      runId: string;
      job: Pick<MachineJob, 'id' | 'version'>;
      replaceManualRuns: boolean;
      hiddenFromSignage?: boolean;
    }) =>
      attachMachineRun(runId, {
        machineJobId: job.id,
        replaceManualRuns,
        expectedJobVersion: job.version,
        hiddenFromSignage,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: machineLogbookKeys.all }),
  });
}

/** Draft orders of one recipient: the orders a finished job can still be added to. */
export const draftOrdersQuery = (customer: Pick<BillingParty, 'id' | 'displayName'> | null | undefined) =>
  queryOptions({
    queryKey: [...machineLogbookKeys.all, 'draft-orders', customer?.id ?? ''],
    queryFn: async ({ signal }) => {
      const page = await listOrders(
        { status: 'draft', search: customer?.displayName ?? '', page: 1, pageSize: 100 },
        { signal },
      );
      return page.items.filter((order) => order.customer?.id === customer?.id);
    },
    enabled: Boolean(customer),
  });

/** Adds a job to an existing draft order of its recipient, or to a new draft order for the recipient. */
export function useAddJobToOrder(job: MachineJob) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ order }: { order: Order | null }): Promise<Order> => {
      if (!job.customer) throw new Error('The job has no recipient.');
      const target = order ?? (await createOrder({ customer: { kind: job.customer.kind, id: job.customer.id } }));
      return addOrderItem(target.id, {
        kind: 'machine_job',
        machineJobId: job.id,
        expectedJobVersion: job.version,
        expectedVersion: target.version,
      });
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: machineLogbookKeys.all }),
        client.invalidateQueries({ queryKey: ['orders'] }),
      ]),
  });
}
