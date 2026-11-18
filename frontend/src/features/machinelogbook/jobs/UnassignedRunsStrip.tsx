import { useState, type MouseEvent } from 'react';
import { Button, IconButton, ProgressBar } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { WorkItem } from '../../../api/generated/models';
import { formatDate, formatTime } from '../../../app/dateTime';
import { DeleteRunModal } from '../dialogs/DeleteDialogs';
import { workItemsQuery } from '../queries';
import { workItemName } from '../shared/status';
import { useCan } from '../shared/useCan';
import { ClaimRunModal } from './ClaimRunModal';
import { spanText } from './jobStatus';
import { unassignedStatuses } from './jobsQueries';
import type { JobsSelection } from './JobsTable';
import '../styles/jobs.scss';
import './jobs.scss';

const REFRESH_MS = 10_000;

function Progress({ item }: { item: WorkItem }) {
  const live = item.status === 'running_unassigned';
  if (!live)
    return (
      <span className="mj-secondary">
        {formatDate(item.startedAt)} {formatTime(item.startedAt)} · {spanText(item.startedAt, item.endsAt, false)}
      </span>
    );
  const progress = item.progressPercent ?? null;
  const eta = item.estimatedEndAt ?? item.endsAt;
  return (
    <span className="jobs-strip__progress">
      {progress != null && (
        <ProgressBar label={`Progress of ${item.displayId}`} hideLabel size="small" value={progress} max={100} />
      )}
      <span className="mj-secondary">
        {progress != null ? `${progress} %` : 'Running'}
        {eta ? ` · ETA ${formatTime(eta)}` : ''}
      </span>
    </span>
  );
}

/**
 * "Reported by machines, not assigned": recorded runs without a job above the jobs table, each with Claim and
 * Delete. A row click shows the run in the detail panel (or opens its page on narrow screens).
 */
export function UnassignedRunsStrip({
  machineId,
  selected,
  onOpen,
  canDelete,
}: {
  machineId?: string;
  selected?: JobsSelection | null;
  onOpen: (selection: JobsSelection) => void;
  canDelete: boolean;
}) {
  const can = useCan();
  const canClaim = can('machine_jobs.create') || can('machine_jobs.edit');
  const [claiming, setClaiming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const query = useQuery({
    ...workItemsQuery({
      status: unassignedStatuses,
      machineId: machineId ? [machineId] : undefined,
      sort: 'startedAt',
      direction: 'desc',
      page: 1,
      pageSize: 50,
    }),
    refetchInterval: REFRESH_MS,
  });
  const runs = query.data?.items ?? [];
  if (runs.length === 0) return null;
  const select = (item: WorkItem) => onOpen({ kind: 'run', id: item.id });
  return (
    <>
      <section className="jobs-strip" aria-labelledby="jobs-strip-title" data-guide="workshop-unassigned-strip">
        <div className="jobs-strip__head">
          <h2 id="jobs-strip-title" className="jobs-strip__title">
            Reported by machines, not assigned
          </h2>
          <p className="jobs-strip__description">Recorded runs without a job. Claim one or delete it.</p>
        </div>
        <ul className="jobs-strip__rows">
          {runs.map((item) => {
            const isSelected = selected?.kind === 'run' && selected.id === item.id;
            return (
              <li key={item.id}>
                <div
                  className={isSelected ? 'jobs-strip__row jobs-strip__row--selected' : 'jobs-strip__row'}
                  role="presentation"
                  onClick={(event: MouseEvent<HTMLElement>) => {
                    // The row is a mouse convenience; the run's name is the keyboard control.
                    if (!(event.target as HTMLElement).closest('button, a')) select(item);
                  }}
                >
                  <span className="jobs-strip__cell">{item.machineName}</span>
                  <span className="jobs-strip__cell jobs-strip__name">
                    <button
                      type="button"
                      className="jobs-strip__open"
                      aria-pressed={isSelected}
                      aria-describedby={`jobs-strip-${item.id}`}
                      onClick={() => select(item)}
                    >
                      {workItemName(item)}
                    </button>
                    <span id={`jobs-strip-${item.id}`} className="mj-secondary">
                      {item.displayId}
                    </span>
                  </span>
                  <span className="jobs-strip__cell">
                    <Progress item={item} />
                  </span>
                  <span className="jobs-strip__actions">
                    {canClaim && (
                      <Button
                        kind="ghost"
                        size="lg"
                        renderIcon={Add}
                        onClick={() => setClaiming(item.id)}
                        data-guide="workshop-claim-run"
                      >
                        Claim
                      </Button>
                    )}
                    {canDelete && (
                      <IconButton
                        kind="ghost"
                        size="lg"
                        label={`Delete ${item.displayId}`}
                        align="left"
                        onClick={() => setDeleting(item.id)}
                      >
                        <TrashCan />
                      </IconButton>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      <ClaimRunModal
        runId={claiming}
        onClose={() => setClaiming(null)}
        canCreate={can('machine_jobs.create')}
        canAttach={can('machine_jobs.edit') && can('machine_jobs.read')}
      />
      {deleting && <DeleteRunModal open onClose={() => setDeleting(null)} runId={deleting} />}
    </>
  );
}
