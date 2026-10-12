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
  const unlinked = print !== undefined && print.linkedJobId === null;
  const end = print ? printEnd(print) : null;
  const duration = print ? printDurationSeconds(print) : null;

  const actions = print ? (
    <>
      {!unlinked && canEdit && (
        <OverflowMenu aria-label="More actions" iconDescription="More actions" flipped>
          <OverflowMenuItem itemText="Unlink" isDelete onClick={() => setDialog('unlink')} />
        </OverflowMenu>
      )}
      {unlinked && canLink && <Button kind="tertiary" renderIcon={LinkIcon} onClick={() => setDialog('link')}>Link to job</Button>}
      {unlinked && canCreate && <Button renderIcon={Add} onClick={() => setDialog('create')}>Create job</Button>}
    </>
  ) : undefined;

  return (
    <PageShell
      title={print?.fileName ?? 'Print'} width="wide"
      titleAdornment={print ? <PrintStateTag state={print.state} /> : undefined}
      description={print ? `${print.displayId} · ${machine?.name ?? 'Unknown printer'} · via ${print.connectorName}` : undefined}
      breadcrumbs={[{ label: 'Workshop', to: '/' }, { label: 'Jobs', to: '/jobs' }, { label: print?.fileName ?? 'Print' }]}
      actions={actions}
    >
      <QueryBoundary query={query} errorMessage="This print could not be loaded.">
        {!print ? (
          <EmptyState title="Print not found" description="It may have been removed, or the link is wrong." action={<Button as={Link} to="/jobs" kind="tertiary">Back to Jobs</Button>} />
        ) : (
          <div className="mj-stack">
            {unlinked && print.state !== 'printing' && (
              <InlineNotification
                kind="warning" lowContrast hideCloseButton title="Not linked to a job"
                subtitle={canCreate || canLink ? 'Create a job from this print, or link it to an existing job, so material usage and billing are recorded.' : 'Staff with job permissions can create or link a job for this print.'}
              />
            )}
            {print.state === 'printing' && (
              <Tile>
                <ProgressBar
                  label="Print progress" value={print.progress ?? 0} max={100}
                  helperText={`${print.progress ?? 0} %${print.estimatedEndAt ? ` · ends ~${formatTime(print.estimatedEndAt)}` : ''}`}
                />
              </Tile>
            )}
            {linkedJob && (
              <Tile>
                <h2 className="mj-section-title">Linked job</h2>
                <p>
                  Linked to{' '}
                  {store.can('machine_jobs.read') ? <CarbonLink as={Link} to={`/jobs/${linkedJob.id}`}>{linkedJob.displayId}{linkedJob.title ? ` ${linkedJob.title}` : ''}</CarbonLink> : linkedJob.displayId}
                  <span className="mj-secondary"> · {linkedJob.customer?.displayName ?? 'No customer'}. The job uses this print’s times and material.</span>
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
        open={dialog === 'unlink'} title="Unlink this print?" confirmLabel="Unlink" pending={unlinking} onClose={close}
        onConfirm={async () => {
          if (!print) return;
          await unlink(print.id);
          store.notify({ kind: 'success', title: 'Print unlinked', subtitle: `${linkedJob?.displayId ?? 'The job'} keeps its values and is a manual run again.` });
          close();
        }}
      >
        <p>{linkedJob?.displayId ?? 'The job'} keeps its current times and material, but becomes a manual run again. The print shows as unlinked.</p>
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
            store.notify({ kind: 'success', title: 'Job created and linked', subtitle: `${job.displayId} uses the data from ${print.displayId}.` });
          }}
        />
      )}
    </PageShell>
  );
}
