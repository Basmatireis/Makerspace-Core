import { useMemo, useState } from 'react';
import { ComboBox, InlineNotification, Modal, Stack } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { MachineJob, Print } from '../../../api/generated/models';
import { printsQuery } from '../queries';
import { formatRelative } from '../shared/format';
import { ReplaceComparison } from '../shared/ReplaceComparison';
import { replaceChangesAnything } from '../shared/status';
import { useLinkPrint } from '../shared/useLinkPrint';
import { linkablePrints, saveError, unlinkedPrintsParams } from './jobFormHelpers';

const printLabel = (print: Print) => `${print.fileName || print.displayId} · ${print.displayId} · started ${formatRelative(print.startedAt)} · ${print.state}`;

function LinkPrintForm({ onClose, job }: { onClose: () => void; job: MachineJob }) {
  const [selected, setSelected] = useState<Print | null>(null);
  const query = useQuery(printsQuery(unlinkedPrintsParams(job.machine.id)));
  const prints = useMemo(() => {
    const start = new Date(job.startsAt).getTime();
    return linkablePrints(query.data?.items).sort((a, b) => Math.abs(new Date(a.startedAt).getTime() - start) - Math.abs(new Date(b.startedAt).getTime() - start));
  }, [query.data, job.startsAt]);
  const { link, pending, error } = useLinkPrint(onClose);
  const changes = selected ? replaceChangesAnything(job, selected) : false;

  return (
    <Modal
      open modalHeading="Link printer data" size="md" secondaryButtonText="Cancel"
      primaryButtonText={pending ? 'Linking…' : changes ? 'Link and replace' : 'Link print'}
      primaryButtonDisabled={!selected || pending} onRequestClose={() => { if (!pending) onClose(); }}
      onRequestSubmit={() => { if (selected) void link(selected, job); }} preventCloseOnClickOutside
    >
      <Stack gap={5}>
        <p>Pick the automatic print that belongs to {job.displayId}.</p>
        <ComboBox autoAlign
          id="link-print-select" titleText="Print" placeholder="Search prints"
          helperText={`Unlinked prints on ${job.machine.name}, closest to the job start first.`}
          items={prints} itemToString={(print) => (print ? printLabel(print) : '')} selectedItem={selected}
          onChange={({ selectedItem }) => setSelected(selectedItem ?? null)}
        />
        {query.isSuccess && prints.length === 0 && <InlineNotification kind="info" lowContrast hideCloseButton title="No prints to link" subtitle="The printer has not reported an unlinked print." />}
        {query.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Prints not loaded" subtitle="The unlinked prints could not be loaded." />}
        {selected && job.run === 'manual' && <ReplaceComparison job={job} print={selected} />}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Print not linked" subtitle={saveError(error, 'The print could not be linked.').message} />}
      </Stack>
    </Modal>
  );
}

/** Job-side counterpart of LinkJobModal: pick an unlinked print on the job's machine. */
export function LinkPrintModal({ open, onClose, job }: { open: boolean; onClose: () => void; job: MachineJob }) {
  return open ? <LinkPrintForm onClose={onClose} job={job} /> : null;
}
