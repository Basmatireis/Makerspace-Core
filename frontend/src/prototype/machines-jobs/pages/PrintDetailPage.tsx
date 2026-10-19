import { useState } from 'react';
import { Accordion, AccordionItem, Button, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem, ProgressBar, Tile } from '@carbon/react';
import { Add, Link as LinkIcon } from '@carbon/icons-react';
import { Link, useParams } from 'react-router-dom';
import { PageShell } from '../../../app/PageShell';
import { EmptyState } from '../../../app/PageState';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { QueryBoundary } from '../components/QueryBoundary';
import { JobFormModal } from '../dialogs/JobFormModal';
import { usageRowFromPrint } from '../dialogs/jobFormHelpers';
import { LinkJobModal } from '../dialogs/LinkJobModal';
import { formatDateTime, formatDuration, formatTime, printDurationSeconds, printEnd, PrintStateTag, printUsageText, nameFromFile } from '../derived';
import { useNow, useSimulatedMutation, useSimulatedQuery, useStore } from '../store';
import type { Job, Machine, Print, PrintState } from '../types';
import '../styles/prints.scss';

const EMPTY: { print: Print | undefined; machines: Machine[]; jobs: Job[] } = { print: undefined, machines: [], jobs: [] };
const OUTCOME_FOR_STATE: Record<PrintState, Job['outcome']> = { printing: 'successful', finished: 'successful', failed: 'failed', cancelled: 'cancelled' };

export function PrintDetailPage() {
  const { printId = '' } = useParams();
  const store = useStore();
  const now = useNow();
  const query = useSimulatedQuery((d) => ({ print: d.prints.find((item) => item.id === printId), machines: d.machines, jobs: d.jobs }), EMPTY);
  const { print, machines, jobs } = query.data;
  const [dialog, setDialog] = useState<'create' | 'link' | 'unlink' | null>(null);
  const close = () => setDialog(null);
  const { mutate: unlink, pending: unlinking } = useSimulatedMutation((id: string) => store.unlinkPrint(id));

  const canCreate = store.can('machine_jobs.create');
  const canLink = store.can('machine_jobs.edit') && store.can('machine_jobs.read');
  const canEdit = store.can('machine_jobs.edit');

  const machine = machines.find((item) => item.id === print?.machineId);
  const linkedJob = print?.linkedJobId ? jobs.find((job) => job.id === print.linkedJobId) : undefined;
  const linkedRunCount = linkedJob ? store.prints.filter((item) => item.linkedJobId === linkedJob.id).length : 0;
  const unlinked = print !== undefined && print.linkedJobId === null;
  const end = print ? printEnd(print) : null;
  const duration = print ? printDurationSeconds(print) : null;

  const actions = print ? (
    <>
      {!unlinked && canEdit && (
        <OverflowMenu aria-label="More actions" iconDescription="More actions" flipped>
          <OverflowMenuItem itemText="Unassign" isDelete onClick={() => setDialog('unlink')} />
        </OverflowMenu>
      )}
      {unlinked && canLink && <Button kind="tertiary" renderIcon={LinkIcon} onClick={() => setDialog('link')}>Assign to job</Button>}
      {unlinked && canCreate && <Button renderIcon={Add} onClick={() => setDialog('create')}>Create job</Button>}
    </>
  ) : undefined;

  return (
    <PageShell
      title={print?.fileName ?? 'Run'} width="wide"
      titleAdornment={print ? <PrintStateTag state={print.state} /> : undefined}
      description={print ? `${print.displayId} · ${machine?.name ?? 'Unknown printer'} · via ${print.connectorName}` : undefined}
      breadcrumbs={[{ label: 'Workshop', to: '/' }, { label: 'Jobs', to: '/jobs' }, { label: print?.fileName ?? 'Run' }]}
      actions={actions}
    >
      <QueryBoundary query={query} errorMessage="This run could not be loaded.">
        {!print ? (
          <EmptyState title="Run not found" description="It may have been removed, or the link is wrong." action={<Button as={Link} to="/jobs" kind="tertiary">Back to Jobs</Button>} />
        ) : (
          <div className="mj-stack">
            {unlinked && print.state !== 'printing' && (
              <InlineNotification
                kind="warning" lowContrast hideCloseButton title="Unassigned run"
                subtitle={canCreate || canLink ? 'Create a job from this run, or assign it to an existing job, so material usage and billing are recorded.' : 'Staff with job permissions can create a job for this run or assign it to one.'}
              />
            )}
            {print.state === 'printing' && (
              <Tile>
                <ProgressBar
                  label="Run progress" value={print.progress ?? 0} max={100}
                  helperText={`${print.progress ?? 0} %${print.estimatedEndAt ? ` · ends ~${formatTime(print.estimatedEndAt)}` : ''}`}
                />
              </Tile>
            )}
            {linkedJob && (
              <Tile>
                <h2 className="mj-section-title">Assigned job</h2>
                <p>
                  Assigned to{' '}
                  {store.can('machine_jobs.read') ? <CarbonLink as={Link} to={`/jobs/${linkedJob.id}`}>{linkedJob.displayId}{linkedJob.title ? ` ${linkedJob.title}` : ''}</CarbonLink> : linkedJob.displayId}
                  <span className="mj-secondary"> · {linkedJob.customer.displayName}. The job uses this run’s times and material.</span>
                </p>
              </Tile>
            )}
            <Tile>
              <dl className="mj-facts">
                <div><dt>Machine</dt><dd>{machine ? (store.can('machines.read') ? <CarbonLink as={Link} to={`/machines/${machine.id}`}>{machine.name}</CarbonLink> : machine.name) : 'Unknown printer'}</dd></div>
                <div><dt>Started</dt><dd>{formatDateTime(print.startedAt)}</dd></div>
                <div><dt>{print.endedAt ? 'Ended' : 'Estimated end'}</dt><dd>{end ? formatDateTime(end) : '—'}</dd></div>
                <div><dt>Runtime</dt><dd>{print.state === 'printing' ? `${formatDuration(Math.max(0, (now - new Date(print.startedAt).getTime()) / 1000))} so far` : duration === null ? '—' : formatDuration(duration)}</dd></div>
                <div><dt>Reported material</dt><dd>{printUsageText(print)}</dd></div>
              </dl>
            </Tile>
            <Tile>
              <h2 className="mj-section-title">Printer events</h2>
              <Accordion>
                <AccordionItem title={`Events from ${print.connectorName} (${print.events.length})`}>
                  {print.events.length === 0 ? <p className="mj-secondary">No events received from the printer.</p> : (
                    <ul className="mj-prints__events">
                      {print.events.map((event) => (
                        <li key={event.id} className="mj-prints__event">
                          <span className="mj-cell-stack"><span>{event.summary}</span><span className="mj-secondary">{formatDateTime(event.occurredAt)}</span></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </AccordionItem>
              </Accordion>
            </Tile>
          </div>
        )}
      </QueryBoundary>

      <DestructiveActionDialog
        open={dialog === 'unlink'} title="Unassign this run?" confirmLabel="Unassign" pending={unlinking} onClose={close}
        onConfirm={async () => {
          if (!print) return;
          await unlink(print.id);
          store.notify({ kind: 'success', title: 'Run unassigned', subtitle: `${linkedJob?.displayId ?? 'The job'} keeps its values${linkedRunCount > 1 ? ' and its other runs' : ' and is a manual run again'}.` });
          close();
        }}
      >
        <p>{linkedJob?.displayId ?? 'The job'} keeps its current material{linkedRunCount > 1 ? ', and its times follow the runs that remain' : ', but becomes a manual run again'}. This run shows as unassigned.</p>
      </DestructiveActionDialog>

      {print && <LinkJobModal open={dialog === 'link'} onClose={close} print={print} />}
      {print && dialog === 'create' && (
        <JobFormModal
          open mode="create" onClose={close}
          initialValues={{
            title: nameFromFile(print.fileName), printFileName: print.fileName, machineId: print.machineId, startsAt: print.startedAt, endsAt: end ?? undefined, outcome: OUTCOME_FOR_STATE[print.state],
            usages: print.reportedUsage ? [usageRowFromPrint(print.reportedUsage, store.spools)] : undefined,
          }}
          onSaved={(job) => {
            store.linkPrint(print.id, job.id, { keepUsages: true });
            store.notify({ kind: 'success', title: 'Job created', subtitle: `${job.displayId} uses the data from ${print.displayId}.`, action: { label: `View ${job.displayId}`, to: `/jobs/${job.id}` } });
          }}
        />
      )}
    </PageShell>
  );
}
