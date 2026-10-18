import { useSimulatedMutation, useStore } from '../store';
import type { Job, Print } from '../types';

/** Shared confirm copy and action for assigning a recorded run to a job. */
export function useLinkPrint(onDone: () => void) {
  const store = useStore();
  const { mutate, pending } = useSimulatedMutation((printId: string, jobId: string) => store.linkPrint(printId, jobId));
  const link = async (print: Print, job: Job) => {
    await mutate(print.id, job.id);
    store.notify({
      kind: 'success', title: job.run === 'manual' ? 'Manual run replaced' : 'Run assigned',
      subtitle: `${job.displayId} now uses the data from ${print.displayId}.`, action: { label: `View ${job.displayId}`, to: `/jobs/${job.id}` },
    });
    onDone();
  };
  return { link, pending };
}
