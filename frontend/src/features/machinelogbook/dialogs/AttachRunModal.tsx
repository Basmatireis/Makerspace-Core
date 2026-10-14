import { useMemo, useState } from 'react';
import { Checkbox, ComboBox, InlineNotification, Modal, Stack } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { MachineJob, MachineRun } from '../../../api/generated/models';
import { runsQuery } from '../queries';
import { formatRelative } from '../shared/format';
import { ReplaceComparison } from '../shared/ReplaceComparison';
import { manualRuns, replaceChangesAnything, runName } from '../shared/status';
import { useAttachRun } from '../shared/useAttachRun';
import { saveError, unassignedRunsParams } from './jobFormHelpers';

const runLabel = (run: MachineRun) => `${runName(run)} · ${run.displayId} · started ${formatRelative(run.startedAt)} · ${run.state}`;

function AttachRunForm({ onClose, job }: { onClose: () => void; job: MachineJob }) {
  const [selected, setSelected] = useState<MachineRun | null>(null);
  const hasManual = manualRuns(job).length > 0;
  const [replace, setReplace] = useState(hasManual);
  const query = useQuery(runsQuery(unassignedRunsParams(job.machine.id)));
  const runs = useMemo(() => {
    const start = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
    return [...(query.data?.items ?? [])].sort((a, b) => Math.abs(new Date(a.startedAt).getTime() - start) - Math.abs(new Date(b.startedAt).getTime() - start));
  }, [query.data, job.startedAt]);
  const { attach, pending, error } = useAttachRun(onClose);
  const replacing = hasManual && replace;
  const changes = selected && replacing ? replaceChangesAnything(job, selected) : false;

  return (
    <Modal
      open modalHeading="Attach recorded run" size="md" secondaryButtonText="Cancel"
      primaryButtonText={pending ? 'Attaching…' : replacing && changes ? 'Attach and replace' : 'Attach run'}
      primaryButtonDisabled={!selected || pending} onRequestClose={() => { if (!pending) onClose(); }}
      onRequestSubmit={() => { if (selected) void attach(selected, job, replacing); }} preventCloseOnClickOutside
    >
      <Stack gap={5}>
        <p>Pick the run reported by the machine that belongs to {job.displayId}. A run that is still running can be attached; the job keeps running until it ends.</p>
        <ComboBox autoAlign
          id="attach-run-select" titleText="Recorded run" placeholder="Search runs"
          helperText={`Unassigned runs on ${job.machine.name}, closest to the job start first.`}
          items={runs} itemToString={(run) => (run ? runLabel(run) : '')} selectedItem={selected}
          onChange={({ selectedItem }) => setSelected(selectedItem ?? null)}
        />
        {hasManual && (
          <Checkbox
            id="attach-run-replace" labelText="Replace manual runs" checked={replace}
            helperText="Use the machine's data instead of the manually entered runs. Their material is returned to stock."
            onChange={(_event, { checked }) => setReplace(checked)}
          />
        )}
        {query.isSuccess && runs.length === 0 && <InlineNotification kind="info" lowContrast hideCloseButton title="No runs to attach" subtitle="The machine has not reported an unassigned run." />}
        {query.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Runs not loaded" subtitle="The unassigned runs could not be loaded." />}
        {selected && <ReplaceComparison job={job} run={selected} replace={replacing} />}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Run not attached" subtitle={saveError(error, 'The run could not be attached.').message} />}
      </Stack>
    </Modal>
  );
}

/** Job-side counterpart of AttachToJobModal: pick an unassigned recorded run on the job's machine. */
export function AttachRunModal({ open, onClose, job }: { open: boolean; onClose: () => void; job: MachineJob }) {
  return open ? <AttachRunForm onClose={onClose} job={job} /> : null;
}
