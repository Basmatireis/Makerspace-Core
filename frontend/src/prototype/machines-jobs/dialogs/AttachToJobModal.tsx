import { useEffect, useMemo, useState } from 'react';
import { ComboBox, InlineNotification, Modal, Stack, StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import { formatDateTime, formatDuration, formatRelative, jobName, jobUsageText } from '../derived';
import { planAttach, runsOfJob, usageListText } from '../runs';
import { useSimulatedMutation, useStore } from '../store';
import type { Job, Print } from '../types';

const jobLabel = (job: Job, name: string) => `${job.displayId}${name !== job.displayId ? ` ${name}` : ''} · ${job.customer.displayName} · started ${formatRelative(job.startsAt)}`;

/** Attach several unassigned runs (all on one machine) to an existing job on that machine. */
export function AttachToJobModal({ open, onClose, runs, onDone }: { open: boolean; onClose: () => void; runs: Print[]; onDone: () => void }) {
  const store = useStore();
  const [selected, setSelected] = useState<Job | null>(null);
  useEffect(() => { if (open) setSelected(null); }, [open]);
  const machineId = runs[0]?.machineId;
  const machine = store.machines.find((item) => item.id === machineId);
  const first = runs.map((run) => new Date(run.startedAt).getTime()).reduce((a, b) => Math.min(a, b), Infinity);
  const jobs = useMemo(() => store.jobs
    .filter((job) => job.machineId === machineId)
    .sort((a, b) => Math.abs(new Date(a.startsAt).getTime() - first) - Math.abs(new Date(b.startsAt).getTime() - first)), [store.jobs, machineId, first]);
  const { mutate, pending } = useSimulatedMutation((ids: string[], jobId: string) => store.attachRuns(ids, jobId));

  const current = selected ? runsOfJob(selected.id, store.prints) : [];
  const plan = selected ? planAttach(selected, current, runs) : null;
  const rows = selected && plan ? [
    { field: 'Start', now: formatDateTime(selected.startsAt), after: formatDateTime(plan.startsAt) },
    { field: 'End', now: formatDateTime(selected.endsAt), after: formatDateTime(plan.endsAt) },
    { field: 'Runtime', now: formatDuration(selected.durationSeconds), after: formatDuration(plan.durationSeconds) },
    { field: 'Recorded runs', now: String(current.length), after: String(plan.runCount) },
    { field: 'Material', now: jobUsageText(selected), after: usageListText(plan.usages) },
  ] : [];

  const submit = async () => {
    if (!selected) return;
    await mutate(runs.map((run) => run.id), selected.id);
    store.notify({ kind: 'success', title: `${runs.length} ${runs.length === 1 ? 'run' : 'runs'} attached`, subtitle: `${selected.displayId} now has ${plan?.runCount ?? runs.length} recorded runs.`, action: { label: `View ${selected.displayId}`, to: `/jobs/${selected.id}` } });
    onDone();
    onClose();
  };

  return (
    <Modal
      open={open} size="md" modalHeading="Attach runs to a job" secondaryButtonText="Cancel" primaryButtonText={pending ? 'Attaching…' : `Attach ${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`}
      primaryButtonDisabled={!selected || pending} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={5}>
        <p>Pick the job on {machine?.name ?? 'this machine'} that {runs.length === 1 ? 'this run belongs' : `these ${runs.length} runs belong`} to.</p>
        <ComboBox autoAlign
          id="attach-job-select" titleText="Job" placeholder="Search jobs" helperText="Jobs on the same machine, closest to the first run first."
          items={jobs} itemToString={(job) => (job ? jobLabel(job, jobName(job, store.prints.find((print) => print.id === job.printId))) : '')} selectedItem={selected}
          onChange={({ selectedItem }) => setSelected(selectedItem ?? null)}
        />
        {jobs.length === 0 && <InlineNotification kind="info" lowContrast hideCloseButton title="No jobs to attach to" subtitle={`There is no job on ${machine?.name ?? 'this machine'}. Create a job from the runs instead.`} />}
        {selected && plan && (
          <>
            <StructuredListWrapper isCondensed aria-label={`What changes for ${selected.displayId}`}>
              <StructuredListHead>
                <StructuredListRow head>
                  <StructuredListCell head>Field</StructuredListCell>
                  <StructuredListCell head>Now</StructuredListCell>
                  <StructuredListCell head>After attaching</StructuredListCell>
                </StructuredListRow>
              </StructuredListHead>
              <StructuredListBody>
                {rows.map((row) => (
                  <StructuredListRow key={row.field}>
                    <StructuredListCell noWrap>{row.field}</StructuredListCell>
                    <StructuredListCell>{row.now}</StructuredListCell>
                    <StructuredListCell>{row.after}</StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
            <InlineNotification
              kind="warning" lowContrast hideCloseButton title={plan.replacesManual ? 'Manual entry replaced' : 'Runs added'}
              subtitle={plan.replacesManual ? `${selected.displayId} uses the data of the recorded runs instead of its manual entry. Price is recalculated.` : `Runtime and material of the new runs are added to ${selected.displayId}. Price is recalculated.`}
            />
            {selected.order && <InlineNotification kind="warning" lowContrast hideCloseButton title={`On order ${selected.order.orderReference}`} subtitle="The job changes after it was charged; the order amount is not updated." />}
          </>
        )}
      </Stack>
    </Modal>
  );
}
