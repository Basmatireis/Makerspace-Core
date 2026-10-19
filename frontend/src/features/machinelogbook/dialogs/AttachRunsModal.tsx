import { useEffect, useState } from 'react';
import { Checkbox, ComboBox, InlineNotification, Modal, Stack, StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bulkAttachMachineRuns } from '../../../api/generated/machine-runs/machine-runs';
import type { WorkItem } from '../../../api/generated/models';
import { RefLink } from '../../../app/RefLink';
import { RichNotification } from '../../../app/RichNotification';
import { plural, referenceTargets } from '../bulkWork';
import { jobQuery, machineLogbookKeys, workItemsQuery } from '../queries';
import { formatDateTime, formatRelative } from '../shared/format';
import { activeRuns, manualRuns } from '../shared/status';
import { useNotify } from '../shared/toasts';
import { BulkError } from './BulkError';

const jobLabel = (job: WorkItem) => `${job.displayId}${job.title ? ` ${job.title}` : ''} · ${job.customer?.displayName ?? 'No customer'} · started ${formatRelative(job.startedAt)} · ${plural(job.runCount, 'run')}`;

type Props = { open: boolean; onClose: () => void; runs: WorkItem[]; onDone: () => void };

/** Attaches several unassigned runs of one machine to an existing job on that machine. */
export function AttachRunsModal({ open, ...props }: Props) {
  return open ? <AttachRunsDialog {...props} /> : null;
}

function AttachRunsDialog({ onClose, runs, onDone }: Omit<Props, 'open'>) {
  const client = useQueryClient();
  const notify = useNotify();
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [search, setSearch] = useState('');
  const [replace, setReplace] = useState(true);
  const machineId = runs[0]?.machineId ?? '';
  const machineName = runs[0]?.machineName ?? 'this machine';
  useEffect(() => { setReplace(true); }, [selected?.id]);

  // A run can only join a job on its own machine; the server returns that machine's jobs and runs, newest first.
  const query = useQuery({
    ...workItemsQuery({ machineId: [machineId], search: search.trim() || undefined, sort: 'startedAt', direction: 'desc', page: 1, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });
  const jobs = (query.data?.items ?? []).filter((item) => item.kind === 'job');
  // The comparison and the version check need the full job, which carries its runs.
  const detail = useQuery({ ...jobQuery(selected?.id ?? ''), enabled: selected !== null });
  const job = detail.data;
  const hasManual = job ? manualRuns(job).length > 0 : false;
  const replacing = hasManual && replace;
  const targets = { ...referenceTargets(runs), ...(selected ? referenceTargets([selected]) : {}) };

  const attach = useMutation({
    mutationFn: () => bulkAttachMachineRuns(job!.id, { runs: runs.map((run) => ({ id: run.id, expectedVersion: run.version ?? 0 })), replaceManualRuns: replacing, expectedJobVersion: job!.version }),
    onSuccess: async (attached) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: `${plural(runs.length, 'run')} attached`, subtitle: `${attached.displayId} now has ${plural(activeRuns(attached).length, 'run')}.` });
      onDone();
      onClose();
    },
  });
  const pending = attach.isPending;

  const kept = job ? (replacing ? activeRuns(job).filter((run) => run.source !== 'manual') : activeRuns(job)) : [];
  const starts = [...runs, ...kept].map((run) => new Date(run.startedAt).getTime());
  const rows = job ? [
    { field: 'Start', now: job.startedAt ? formatDateTime(job.startedAt) : '—', after: formatDateTime(new Date(Math.min(...starts)).toISOString()) },
    { field: 'Runs', now: String(activeRuns(job).length), after: String(kept.length + runs.length) },
  ] : [];

  return (
    <Modal
      open size="md" modalHeading="Attach runs to a job" secondaryButtonText="Cancel" primaryButtonText={pending ? 'Attaching…' : `Attach ${plural(runs.length, 'run')}`}
      primaryButtonDisabled={!selected || !job || pending} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }}
      onRequestSubmit={() => { if (job && !pending) attach.mutate(); }}
    >
      <Stack gap={5}>
        <p>Pick the job on {machineName} that {runs.length === 1 ? 'this run belongs' : `these ${runs.length} runs belong`} to.</p>
        <ComboBox autoAlign
          id="attach-runs-job" titleText="Job" placeholder="Search jobs" helperText={`Jobs on ${machineName}, newest first. Type to search by job name or ID.`}
          items={jobs} itemToString={(item) => (item ? jobLabel(item) : '')} selectedItem={selected} shouldFilterItem={() => true}
          onInputChange={(value) => setSearch(selected && value === jobLabel(selected) ? '' : value)}
          onChange={({ selectedItem }) => setSelected(selectedItem ?? null)}
        />
        {query.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Jobs could not be loaded" subtitle="Close the dialog and try again." />}
        {query.isSuccess && jobs.length === 0 && !search.trim() && <InlineNotification kind="info" lowContrast hideCloseButton title="No jobs to attach to" subtitle={`There is no job on ${machineName}. Create a job from the runs instead.`} />}
        {detail.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="The job could not be loaded" subtitle="Choose it again or reload the page." />}
        {hasManual && (
          <Checkbox
            id="attach-runs-replace" labelText="Replace manual runs" checked={replace}
            helperText="Use the machine's data instead of the manually entered runs. Their material is returned to stock."
            onChange={(_event, { checked }) => setReplace(checked)}
          />
        )}
        {job && (
          <StructuredListWrapper isCondensed aria-label={`What changes for ${job.displayId}`}>
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
        )}
        {job && (
          <RichNotification kind={replacing ? 'warning' : 'info'} title={replacing ? 'Manual entry replaced' : 'Runs added'}>
            {replacing
              ? <><RefLink reference={job.displayId} id={job.id} onNavigate={onClose} /> uses the data of the recorded runs instead of its manual entry. Price is recalculated.</>
              : <>Runtime and material of the new runs are added to <RefLink reference={job.displayId} id={job.id} onNavigate={onClose} />. Price is recalculated.</>}
          </RichNotification>
        )}
        {selected?.billing?.orderId && (
          <RichNotification kind="warning" title="On an order">
            <RefLink reference={selected.billing.orderReference ?? ''} id={selected.billing.orderId} kind="order" onNavigate={onClose}>{selected.billing.orderReference ?? 'the order'}</RefLink>. The job changes after it was charged; the order amount is not updated.
          </RichNotification>
        )}
        <BulkError error={attach.error} title="The runs could not be attached" targets={targets} onNavigate={onClose} />
      </Stack>
    </Modal>
  );
}
