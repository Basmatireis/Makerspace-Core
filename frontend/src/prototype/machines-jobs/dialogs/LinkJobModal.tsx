import { useEffect, useMemo, useState } from 'react';
import { ComboBox, InlineNotification, Modal, Stack } from '@carbon/react';
import { ReplaceComparison } from '../components/ReplaceComparison';
import { formatRelative, replaceChangesAnything } from '../derived';
import { useStore } from '../store';
import type { Job, Print } from '../types';
import { useLinkPrint } from './useLinkPrint';

const jobLabel = (job: Job) => `${job.displayId}${job.title ? ` ${job.title}` : ''} · ${job.customer?.displayName ?? 'No customer'} · started ${formatRelative(job.startsAt)} · ${job.run} run`;

export function LinkJobModal({ open, onClose, print }: { open: boolean; onClose: () => void; print: Print }) {
  const store = useStore();
  const [selected, setSelected] = useState<Job | null>(null);
  useEffect(() => { if (open) setSelected(null); }, [open]);
  // Jobs already linked to another print are excluded; a print can only replace a run on its own machine.
  const jobs = useMemo(() => {
    const start = new Date(print.startedAt).getTime();
    return store.jobs
      .filter((job) => job.machineId === print.machineId && job.printId === null)
      .sort((a, b) => Math.abs(new Date(a.startsAt).getTime() - start) - Math.abs(new Date(b.startsAt).getTime() - start));
  }, [store.jobs, print.machineId, print.startedAt]);
  const { link, pending } = useLinkPrint(onClose);
  const machine = store.machines.find((item) => item.id === print.machineId);
  const replaces = selected?.run === 'manual';
  const changes = selected ? replaceChangesAnything(selected, print) : false;

  return (
    <Modal
      open={open} modalHeading="Assign run to job" size="md" secondaryButtonText="Cancel"
      primaryButtonText={pending ? 'Assigning…' : replaces && changes ? 'Assign and replace' : 'Assign run'}
      primaryButtonDisabled={!selected || pending} onRequestClose={() => { if (!pending) onClose(); }}
      onRequestSubmit={() => { if (selected) void link(print, selected); }} preventCloseOnClickOutside
    >
      <Stack gap={5}>
        <p>Pick the job that covers {print.fileName}. The recorded run becomes the run of that job.</p>
        <ComboBox autoAlign
          id="link-job-select" titleText="Job" placeholder="Search jobs"
          helperText={`Jobs without a recorded run on ${machine?.name ?? 'this printer'}, closest to the run start first.`}
          items={jobs} itemToString={(job) => (job ? jobLabel(job) : '')} selectedItem={selected}
          onChange={({ selectedItem }) => setSelected(selectedItem ?? null)}
        />
        {jobs.length === 0 && <InlineNotification kind="info" lowContrast hideCloseButton title="No jobs to assign to" subtitle="There are no jobs without a recorded run on this printer. Create a job from the run instead." />}
        {selected && replaces && <ReplaceComparison job={selected} print={print} />}
      </Stack>
    </Modal>
  );
}
