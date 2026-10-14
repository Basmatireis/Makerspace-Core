import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attachMachineRun } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineJob, MachineRun } from '../../../api/generated/models';
import { machineLogbookKeys } from '../queries';
import { useNotify } from './toasts';

type AttachJob = Pick<MachineJob, 'id' | 'displayId' | 'version'>;
type AttachTarget = Pick<MachineRun, 'id' | 'displayId'>;

/**
 * Shared action for attaching a recorded run to a job. `attach` resolves to true when the run was attached
 * (after which `onDone` ran) and to false when it failed; the failure is available as `error` for the dialog.
 */
export function useAttachRun(onDone: () => void) {
  const client = useQueryClient();
  const notify = useNotify();
  const mutation = useMutation({
    mutationFn: ({ run, job, replaceManualRuns }: { run: AttachTarget; job: AttachJob; replaceManualRuns: boolean }) => attachMachineRun(run.id, { machineJobId: job.id, replaceManualRuns, expectedJobVersion: job.version }),
    onSuccess: async (_attached, { run, job, replaceManualRuns }) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success', title: replaceManualRuns ? 'Manual runs replaced' : 'Run attached',
        subtitle: replaceManualRuns ? `${job.displayId} now uses the data from ${run.displayId}.` : `${run.displayId} is part of ${job.displayId}.`,
      });
      onDone();
    },
  });
  const attach = (run: AttachTarget, job: AttachJob, replaceManualRuns: boolean) => mutation.mutateAsync({ run, job, replaceManualRuns }).then(() => true, () => false);
  return { attach, pending: mutation.isPending, error: mutation.error, reset: mutation.reset };
}
