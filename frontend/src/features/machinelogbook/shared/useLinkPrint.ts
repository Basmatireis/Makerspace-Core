import { useMutation, useQueryClient } from '@tanstack/react-query';
import { linkPrintToMachineJob } from '../../../api/generated/prints/prints';
import type { MachineJob, Print } from '../../../api/generated/models';
import { machineLogbookKeys } from '../queries';
import { useNotify } from './toasts';

type LinkJob = Pick<MachineJob, 'id' | 'displayId' | 'run' | 'version'>;
type LinkTarget = Pick<Print, 'id' | 'displayId'>;

/**
 * Shared confirm copy and action for linking a print to a job. `link` resolves to true when the link was saved
 * (after which `onDone` ran) and to false when it failed; the failure is available as `error` for the dialog.
 */
export function useLinkPrint(onDone: () => void) {
  const client = useQueryClient();
  const notify = useNotify();
  const mutation = useMutation({
    mutationFn: ({ print, job }: { print: LinkTarget; job: LinkJob }) => linkPrintToMachineJob(print.id, { machineJobId: job.id, expectedJobVersion: job.version }),
    onSuccess: async (_linked, { print, job }) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success', title: job.run === 'manual' ? 'Manual run replaced' : 'Print linked',
        subtitle: `${job.displayId} now uses the data from ${print.displayId}.`,
      });
      onDone();
    },
  });
  const link = (print: LinkTarget, job: LinkJob) => mutation.mutateAsync({ print, job }).then(() => true, () => false);
  return { link, pending: mutation.isPending, error: mutation.error, reset: mutation.reset };
}
