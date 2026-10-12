import { useSimulatedMutation, useStore } from '../store';
import type { Job, Print } from '../types';

/** Shared confirm copy and action for linking a print to a job. */
export function useLinkPrint(onDone: () => void) {
  const store = useStore();
  const { mutate, pending } = useSimulatedMutation((printId: string, jobId: string) => store.linkPrint(printId, jobId));
  const link = async (print: Print, job: Job) => {
    await mutate(print.id, job.id);
    store.notify({
      kind: 'success', title: job.run === 'manual' ? 'Manual run replaced' : 'Print linked',
      subtitle: `${job.displayId} now uses the data from ${print.displayId}.`,
    });
    onDone();
  };
  return { link, pending };
}
