import { useEffect, useState } from 'react';
import { ComboBox, InlineNotification, Modal, Stack } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Print, WorkItem } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { jobQuery, workItemsQuery } from '../queries';
import { formatRelative } from '../shared/format';
import { ReplaceComparison } from '../shared/ReplaceComparison';
import { replaceChangesAnything } from '../shared/status';
import { useLinkPrint } from '../shared/useLinkPrint';

const jobLabel = (job: WorkItem) => `${job.displayId}${job.title ? ` ${job.title}` : ''} · ${job.customer?.displayName ?? 'No customer'} · started ${formatRelative(job.startedAt)} · ${job.run} run`;

export function LinkJobModal({ open, onClose, print }: { open: boolean; onClose: () => void; print: Print }) {
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [search, setSearch] = useState('');
  const { link, pending, error, reset } = useLinkPrint(onClose);
  useEffect(() => { if (open) { setSelected(null); setSearch(''); reset(); } }, [open, reset]);
  // The server returns this machine's manual runs, newest first; a print can only replace a run on its own machine.
  // Jobs that already use printer data have run "printer" and are not offered.
  const query = useQuery({
    ...workItemsQuery({ machineId: [print.machineId], run: ['manual'], search: search.trim() || undefined, sort: 'startedAt', direction: 'desc', page: 1, pageSize: 50 }),
    enabled: open, placeholderData: keepPreviousData,
  });
  const jobs = (query.data?.items ?? []).filter((item) => item.kind === 'job');
  // Replacing compares usages and runtime, which only the full job carries.
  const detail = useQuery({ ...jobQuery(selected?.id ?? ''), enabled: open && selected !== null });
  const replaces = selected?.run === 'manual';
  const changes = detail.data ? replaceChangesAnything(detail.data, print) : false;
  const name = print.fileName || print.displayId;

  return (
    <Modal
      open={open} modalHeading="Link print to job" size="md" secondaryButtonText="Cancel"
      primaryButtonText={pending ? 'Linking…' : replaces && changes ? 'Link and replace' : 'Link print'}
      primaryButtonDisabled={!selected || !detail.data || pending} onRequestClose={() => { if (!pending) onClose(); }}
      onRequestSubmit={() => { if (detail.data) void link(print, detail.data); }} preventCloseOnClickOutside
    >
      <Stack gap={5}>
        <p>Pick the job that covers {name}. The print is the automatic run for that job.</p>
        <ComboBox autoAlign
          id="link-job-select" titleText="Job" placeholder="Search jobs"
          helperText={`Manual runs on ${print.machineName}, newest first. Type to search by job name or ID.`}
          items={jobs} itemToString={(job) => (job ? jobLabel(job) : '')} selectedItem={selected} shouldFilterItem={() => true}
          onInputChange={(value) => setSearch(selected && value === jobLabel(selected) ? '' : value)}
          onChange={({ selectedItem }) => setSelected(selectedItem ?? null)}
        />
        {query.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Jobs could not be loaded" subtitle="Close the dialog and try again." />}
        {query.isSuccess && jobs.length === 0 && !search.trim() && <InlineNotification kind="info" lowContrast hideCloseButton title="No jobs to link" subtitle="There are no unlinked jobs on this printer. Create a job from the print instead." />}
        {detail.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="The job could not be loaded" subtitle="Choose it again or reload the page." />}
        {detail.data && replaces && <ReplaceComparison job={detail.data} print={print} />}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="The print could not be linked" subtitle={error instanceof ApiError ? error.message : 'Reload the page if the job changed, then try again.'} />}
      </Stack>
    </Modal>
  );
}
