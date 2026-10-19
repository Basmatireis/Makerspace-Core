import { RefLink } from '../components/RefLink';
import { useEffect, useMemo, useState } from 'react';
import { ComboBox, InlineNotification, Modal, Stack } from '@carbon/react';
import { ReplaceComparison } from '../components/ReplaceComparison';
import { formatRelative, replaceChangesAnything } from '../derived';
import { useStore } from '../store';
import type { Job, Print } from '../types';
import { useLinkPrint } from './useLinkPrint';

const printLabel = (print: Print) => `${print.fileName} · ${print.displayId} · started ${formatRelative(print.startedAt)} · ${print.state}`;

/** Job-side counterpart of LinkJobModal: pick an unassigned run on the job's machine. */
export function LinkPrintModal({ open, onClose, job }: { open: boolean; onClose: () => void; job: Job }) {
  const store = useStore();
  const [selected, setSelected] = useState<Print | null>(null);
  useEffect(() => { if (open) setSelected(null); }, [open]);
  const prints = useMemo(() => {
    const start = new Date(job.startsAt).getTime();
    return store.prints
      .filter((print) => print.machineId === job.machineId && print.linkedJobId === null)
      .sort((a, b) => Math.abs(new Date(a.startedAt).getTime() - start) - Math.abs(new Date(b.startedAt).getTime() - start));
  }, [store.prints, job.machineId, job.startsAt]);
  const { link, pending } = useLinkPrint(onClose);
  const machine = store.machines.find((item) => item.id === job.machineId);
  const changes = selected ? replaceChangesAnything(job, selected) : false;

  return (
    <Modal
      open={open} modalHeading="Assign recorded run" size="md" secondaryButtonText="Cancel"
      primaryButtonText={pending ? 'Assigning…' : changes ? 'Assign and replace' : 'Assign run'}
      primaryButtonDisabled={!selected || pending} onRequestClose={() => { if (!pending) onClose(); }}
      onRequestSubmit={() => { if (selected) void link(selected, job); }} preventCloseOnClickOutside
    >
      <Stack gap={5}>
        <p>Pick the recorded run that belongs to <RefLink reference={job.displayId} id={job.id} onNavigate={onClose} />.</p>
        <ComboBox autoAlign
          id="link-print-select" titleText="Run" placeholder="Search runs"
          helperText={`Unassigned runs on ${machine?.name ?? 'this machine'}, closest to the job start first.`}
          items={prints} itemToString={(print) => (print ? printLabel(print) : '')} selectedItem={selected}
          onChange={({ selectedItem }) => setSelected(selectedItem ?? null)}
        />
        {prints.length === 0 && <InlineNotification kind="info" lowContrast hideCloseButton title="No runs to assign" subtitle="The printer has not recorded an unassigned run." />}
        {selected && job.run === 'manual' && <ReplaceComparison job={job} print={selected} />}
      </Stack>
    </Modal>
  );
}
