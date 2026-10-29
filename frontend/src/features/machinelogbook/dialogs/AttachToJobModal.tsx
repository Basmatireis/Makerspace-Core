import { useEffect, useState } from 'react';
import { Checkbox, ComboBox, InlineNotification, Modal, Stack } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { MachineRun, WorkItem } from '../../../api/generated/models';
import { jobQuery, workItemsQuery } from '../queries';
import { formatRelative } from '../shared/format';
import { ReplaceComparison } from '../shared/ReplaceComparison';
import { manualRuns, replaceChangesAnything } from '../shared/status';
import { useAttachRun } from '../shared/useAttachRun';
import { saveError } from './jobFormHelpers';

const jobLabel = (job: WorkItem) =>
  `${job.displayId}${job.title ? ` ${job.title}` : ''} · ${job.customer?.displayName ?? 'No recipient'} · started ${formatRelative(job.startedAt)} · ${job.runCount} ${job.runCount === 1 ? 'run' : 'runs'}`;

export function AttachToJobModal({ open, onClose, run }: { open: boolean; onClose: () => void; run: MachineRun }) {
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [search, setSearch] = useState('');
  const [replace, setReplace] = useState(true);
  const { attach, pending, error, reset } = useAttachRun(onClose);
  useEffect(() => {
    if (open) {
      setSelected(null);
      setSearch('');
      setReplace(true);
      reset();
    }
  }, [open, reset]);
  // A run can only join a job on its own machine; the server returns that machine's jobs and runs, newest first.
  const query = useQuery({
    ...workItemsQuery({
      machineId: [run.machineId],
      search: search.trim() || undefined,
      sort: 'startedAt',
      direction: 'desc',
      page: 1,
      pageSize: 50,
    }),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const jobs = (query.data?.items ?? []).filter((item) => item.kind === 'job');
  // The comparison and the version check need the full job, which carries its runs.
  const detail = useQuery({ ...jobQuery(selected?.id ?? ''), enabled: open && selected !== null });
  const hasManual = detail.data ? manualRuns(detail.data).length > 0 : false;
  const replacing = hasManual && replace;
  const changes = detail.data && replacing ? replaceChangesAnything(detail.data, run) : false;
  const name = run.fileName || run.displayId;

  return (
    <Modal
      open={open}
      modalHeading="Attach run to job"
      size="md"
      secondaryButtonText="Cancel"
      primaryButtonText={pending ? 'Attaching…' : replacing && changes ? 'Attach and replace' : 'Attach run'}
      primaryButtonDisabled={!selected || !detail.data || pending}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        if (detail.data) void attach(run, detail.data, replacing);
      }}
      preventCloseOnClickOutside
    >
      <Stack gap={5}>
        <p>
          Pick the job that {name} belongs to. The run becomes one of its runs
          {run.state === 'running' ? '; the job keeps running until the run ends' : ''}.
        </p>
        <ComboBox
          autoAlign
          id="attach-job-select"
          titleText="Job"
          placeholder="Search jobs"
          helperText={`Jobs on ${run.machineName}, newest first. Type to search by job name, ID, recipient, operator or file name.`}
          items={jobs}
          itemToString={(job) => (job ? jobLabel(job) : '')}
          selectedItem={selected}
          shouldFilterItem={() => true}
          onInputChange={(value) => setSearch(selected && value === jobLabel(selected) ? '' : value)}
          onChange={({ selectedItem }) => setSelected(selectedItem ?? null)}
        />
        {query.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Jobs could not be loaded"
            subtitle="Close the dialog and try again."
          />
        )}
        {query.isSuccess && jobs.length === 0 && !search.trim() && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="No jobs to attach to"
            subtitle="There are no jobs on this machine. Create a job from the run instead."
          />
        )}
        {detail.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="The job could not be loaded"
            subtitle="Choose it again or reload the page."
          />
        )}
        {hasManual && (
          <Checkbox
            id="attach-job-replace"
            labelText="Replace manual runs"
            checked={replace}
            helperText="Use the machine's data instead of the manually entered runs. Their material is returned to stock."
            onChange={(_event, { checked }) => setReplace(checked)}
          />
        )}
        {detail.data && <ReplaceComparison job={detail.data} run={run} replace={replacing} />}
        {error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="The run could not be attached"
            subtitle={saveError(error, 'Reload the page if the job changed, then try again.').message}
          />
        )}
      </Stack>
    </Modal>
  );
}
