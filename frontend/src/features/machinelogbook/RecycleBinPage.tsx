import { useState } from 'react';
import { Button, InlineNotification, Modal, Stack } from '@carbon/react';
import { Restart, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  purgeMachineJob,
  purgeMachineRun,
  restoreMachineJob,
  restoreMachineRun,
} from '../../api/generated/machine-runs/machine-runs';
import type { DeletedMachineJob, DeletedMachineRun } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { saveError } from './dialogs/jobFormHelpers';
import { machineLogbookKeys, recycleBinQuery } from './queries';
import { DirectoryTable, type Column } from './shared/DirectoryTable';
import { formatDateTime } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { useNotify } from './shared/toasts';
import './styles/jobs.scss';

type Entry = { kind: 'job'; item: DeletedMachineJob } | { kind: 'run'; item: DeletedMachineRun };
type Pending = { mode: 'restore' | 'purge'; entry: Entry };

const sourceLabel = { manual: 'Manual', recorded: 'Recorded' } as const;

const deletedCell = (item: { deletedAt: string; deletedByName: string | null }) => (
  <div className="mj-cell-stack">
    <span>{formatDateTime(item.deletedAt)}</span>
    <span className="mj-secondary">{item.deletedByName ? `by ${item.deletedByName}` : 'by a removed account'}</span>
  </div>
);

/** Same shape as the other directory tables: the count is a plain number, never a tag. */
const countCell = (count: number) => <span>{count}</span>;

/** "The 3 runs that went into the bin with it are deleted too." */
const withJobRuns = (count: number) =>
  count === 1
    ? 'The run that went into the bin with it is deleted too.'
    : `The ${count} runs that went into the bin with it are deleted too.`;

function restoreText(entry: Entry) {
  if (entry.kind === 'job') {
    const { deletedRunCount, detachedRunCount } = entry.item;
    return [
      deletedRunCount > 0
        ? `${deletedRunCount === 1 ? 'The run' : `The ${deletedRunCount} runs`} deleted with it come${deletedRunCount === 1 ? 's' : ''} back too.`
        : null,
      detachedRunCount > 0
        ? `${detachedRunCount === 1 ? 'The recorded run' : `The ${detachedRunCount} recorded runs`} that stayed behind as ${detachedRunCount === 1 ? 'an unassigned run is' : 'unassigned runs are'} attached to the job again.`
        : null,
      'Material that the deletion returned to stock stays in stock.',
    ].filter((sentence): sentence is string => sentence !== null);
  }
  const { formerJobInBin, formerJobId, formerJobDisplayId } = entry.item;
  return [
    formerJobInBin
      ? 'The job is in the bin too, so the run comes back as an unassigned run.'
      : formerJobId
        ? `The run goes back into job ${formerJobDisplayId ?? 'it belonged to'}.`
        : 'The run comes back as an unassigned run.',
    'Material that the deletion returned to stock stays in stock.',
  ];
}

const nameOf = (entry: Entry) => entry.item.displayId;

export function RecycleBinPage() {
  const bin = useQuery(recycleBinQuery());
  const client = useQueryClient();
  const notify = useNotify();
  const [pending, setPending] = useState<Pending | null>(null);

  const act = useMutation({
    mutationFn: async ({ mode, entry }: Pending) => {
      const request = { expectedVersion: entry.item.version };
      if (entry.kind === 'job') {
        if (mode === 'restore') await restoreMachineJob(entry.item.id, request);
        else await purgeMachineJob(entry.item.id, request);
      } else if (mode === 'restore') await restoreMachineRun(entry.item.id, request);
      else await purgeMachineRun(entry.item.id, request);
    },
    onSuccess: async (_result, { mode, entry }) => {
      // Jobs, runs, the overview and the bin all live under the Workshop key.
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: mode === 'restore' ? `${nameOf(entry)} restored` : `${nameOf(entry)} deleted for good`,
      });
      setPending(null);
    },
  });
  const close = () => {
    setPending(null);
    act.reset();
  };
  const errorText = act.isError
    ? saveError(act.error, 'The action could not be completed. Reload the page and try again.').message
    : undefined;

  const actions = (entry: Entry) => (
    <div className="mj-inline">
      <Button
        kind="ghost"
        size="sm"
        renderIcon={Restart}
        aria-label={`Restore ${nameOf(entry)}`}
        onClick={() => setPending({ mode: 'restore', entry })}
      >
        Restore
      </Button>
      {entry.item.hasInventoryBookings ? (
        <span className="mj-secondary">Kept: its material is booked in the inventory ledger</span>
      ) : (
        <Button
          kind="danger--ghost"
          size="sm"
          renderIcon={TrashCan}
          aria-label={`Delete ${nameOf(entry)} for good`}
          onClick={() => setPending({ mode: 'purge', entry })}
        >
          Delete for good
        </Button>
      )}
    </div>
  );

  const jobColumns: Column<DeletedMachineJob>[] = [
    { key: 'displayId', header: 'Job', sortValue: (job) => job.displayId, render: (job) => job.displayId },
    { key: 'title', header: 'Title', sortValue: (job) => job.title ?? '', render: (job) => job.title ?? '—' },
    {
      key: 'machine',
      header: 'Machine',
      sortValue: (job) => job.machineName,
      narrow: true,
      render: (job) => job.machineName,
    },
    {
      key: 'deleted',
      header: 'Deleted',
      sortValue: (job) => job.deletedAt,
      firstDirection: 'DESC',
      render: deletedCell,
    },
    {
      key: 'runsInBin',
      header: 'Runs in the bin',
      sortValue: (job) => job.deletedRunCount,
      narrow: true,
      render: (job) => countCell(job.deletedRunCount),
    },
    {
      key: 'unassigned',
      header: 'Runs left unassigned',
      sortValue: (job) => job.detachedRunCount,
      narrow: true,
      render: (job) => countCell(job.detachedRunCount),
    },
    { key: 'actions', header: 'Actions', render: (job) => actions({ kind: 'job', item: job }) },
  ];

  const runColumns: Column<DeletedMachineRun>[] = [
    { key: 'displayId', header: 'Run', sortValue: (run) => run.displayId, render: (run) => run.displayId },
    {
      key: 'fileName',
      header: 'File',
      sortValue: (run) => run.fileName ?? '',
      render: (run) => run.fileName ?? '—',
    },
    {
      key: 'source',
      header: 'Source',
      sortValue: (run) => run.source,
      narrow: true,
      render: (run) => sourceLabel[run.source],
    },
    {
      key: 'machine',
      header: 'Machine',
      sortValue: (run) => run.machineName,
      narrow: true,
      render: (run) => run.machineName,
    },
    {
      key: 'formerJob',
      header: 'Former job',
      sortValue: (run) => run.formerJobDisplayId ?? '',
      narrow: true,
      render: (run) =>
        run.formerJobDisplayId
          ? run.formerJobInBin
            ? `${run.formerJobDisplayId} (in the bin)`
            : run.formerJobDisplayId
          : '—',
    },
    {
      key: 'deleted',
      header: 'Deleted',
      sortValue: (run) => run.deletedAt,
      firstDirection: 'DESC',
      render: deletedCell,
    },
    { key: 'actions', header: 'Actions', render: (run) => actions({ kind: 'run', item: run }) },
  ];

  return (
    <PageShell
      title="Recycle bin"
      description="Deleted jobs and runs stay here until they are restored or deleted for good."
      width="wide"
      breadcrumbs={[
        { label: 'Workshop', to: machineLogbookPaths.home() },
        { label: 'Jobs', to: machineLogbookPaths.jobs() },
        { label: 'Recycle bin' },
      ]}
    >
      <QueryBoundary query={bin} errorMessage="The recycle bin could not be loaded.">
        {({ jobs, runs }) =>
          jobs.length === 0 && runs.length === 0 ? (
            <EmptyState
              title="The recycle bin is empty"
              description="Jobs and runs you delete appear here and can be restored."
            />
          ) : (
            <Stack gap={8}>
              <section aria-labelledby="bin-jobs-heading">
                <Stack gap={4}>
                  <h2 id="bin-jobs-heading">Jobs</h2>
                  <DirectoryTable
                    id="bin-jobs"
                    label="Deleted jobs"
                    columns={jobColumns}
                    rows={jobs}
                    totalCount={jobs.length}
                    searchText={(job) => `${job.displayId} ${job.title ?? ''} ${job.machineName}`}
                    defaultSort={{ key: 'deleted', direction: 'DESC' }}
                    empty={{ title: 'No deleted jobs', description: 'Deleted jobs appear here.' }}
                  />
                </Stack>
              </section>
              <section aria-labelledby="bin-runs-heading">
                <Stack gap={4}>
                  <h2 id="bin-runs-heading">Runs</h2>
                  <DirectoryTable
                    id="bin-runs"
                    label="Deleted runs"
                    columns={runColumns}
                    rows={runs}
                    totalCount={runs.length}
                    searchText={(run) =>
                      `${run.displayId} ${run.fileName ?? ''} ${run.machineName} ${run.formerJobDisplayId ?? ''}`
                    }
                    defaultSort={{ key: 'deleted', direction: 'DESC' }}
                    empty={{ title: 'No deleted runs', description: 'Deleted runs appear here.' }}
                  />
                </Stack>
              </section>
            </Stack>
          )
        }
      </QueryBoundary>
      {pending?.mode === 'restore' && (
        <Modal
          open
          size="sm"
          modalHeading={`Restore ${nameOf(pending.entry)}?`}
          primaryButtonText={act.isPending ? 'Restoring…' : 'Restore'}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={act.isPending}
          preventCloseOnClickOutside
          onRequestClose={() => {
            if (!act.isPending) close();
          }}
          onSecondarySubmit={() => {
            if (!act.isPending) close();
          }}
          onRequestSubmit={() => {
            if (!act.isPending) act.mutate(pending);
          }}
        >
          <Stack gap={5}>
            {restoreText(pending.entry).map((sentence) => (
              <p key={sentence}>{sentence}</p>
            ))}
            {errorText && (
              <InlineNotification kind="error" lowContrast hideCloseButton title="Not restored" subtitle={errorText} />
            )}
          </Stack>
        </Modal>
      )}
      <DestructiveActionDialog
        open={pending?.mode === 'purge'}
        title={pending ? `Delete ${nameOf(pending.entry)} for good?` : ''}
        fate="permanent"
        confirmLabel="Delete for good"
        pending={act.isPending}
        error={errorText}
        onClose={close}
        onConfirm={() => pending && act.mutate(pending)}
      >
        {pending?.entry.kind === 'job' ? (
          <>
            <p>
              {pending.entry.item.displayId} is removed from the bin with its pricing and usages. Inventory bookings are
              kept.
            </p>
            {pending.entry.item.deletedRunCount > 0 && <p>{withJobRuns(pending.entry.item.deletedRunCount)}</p>}
          </>
        ) : (
          <p>{pending?.entry.item.displayId} is removed from the bin. Inventory bookings are kept.</p>
        )}
      </DestructiveActionDialog>
    </PageShell>
  );
}
