import { useState } from 'react';
import { Accordion, AccordionItem, Button, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem, ProgressBar, Tile } from '@carbon/react';
import { Add, Link as LinkIcon } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { MachineJobOutcome, PrintDetail, PrintEvent, PrintState } from '../../api/generated/models';
import { unlinkPrintFromMachineJob } from '../../api/generated/prints/prints';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { PermissionId } from '../auth/permissions';
import { JobFormModal, type JobInitialValues } from './dialogs/JobFormModal';
import { usageRowFromPrint } from './dialogs/jobFormHelpers';
import { LinkJobModal } from './dialogs/LinkJobModal';
import { jobQuery, machineLogbookKeys, printQuery } from './queries';
import { formatDateTime, formatDuration, formatQuantity, formatTime } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { nameFromFile, printDurationSeconds, printEnd, PrintStateTag, printUsageText } from './shared/status';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import './styles/prints.scss';

const OUTCOME_FOR_STATE: Record<PrintState, MachineJobOutcome> = { printing: 'successful', finished: 'successful', failed: 'failed', cancelled: 'cancelled', unknown: 'unknown' };

const words = (value: string) => value.replace(/_/g, ' ');

/** One readable line per printer event (never the raw payload). */
function eventSummary(event: PrintEvent) {
  switch (event.kind) {
    case 'identity': return 'Printer identified';
    case 'connectivity': return event.state ? `Connectivity: ${words(event.state)}` : 'Connectivity changed';
    case 'operational_state': return event.state ? `State: ${words(event.state)}` : 'State changed';
    case 'progress': return event.progressPercent != null ? `Progress ${event.progressPercent} %` : 'Progress reported';
    case 'slot_observation': return 'Filament slot observed';
    case 'consumption_report': return event.quantity != null ? `Consumption reported: ${formatQuantity(event.quantity)} g` : 'Consumption reported';
    case 'terminal_outcome': return event.state ? `Outcome: ${words(event.state)}` : 'Outcome reported';
  }
}

/** Values the job form starts with when a job is created from a print. */
function initialValuesFromPrint(print: PrintDetail): JobInitialValues {
  const usage = print.reportedUsage;
  const end = printEnd(print);
  return {
    title: print.fileName ? nameFromFile(print.fileName) : undefined,
    machineId: print.machineId,
    startsAt: print.startedAt,
    endsAt: end ?? undefined,
    outcome: OUTCOME_FOR_STATE[print.state],
    printFileName: print.fileName ?? undefined,
    usages: usage && (usage.materialId || usage.spoolId) ? [usageRowFromPrint(usage)] : undefined,
  };
}

export function PrintDetailPage() {
  const { printId = '' } = useParams();
  const can = useCan();
  const now = useNow();
  const client = useQueryClient();
  const notify = useNotify();
  const query = useQuery(printQuery(printId));
  const print = query.data;
  const [dialog, setDialog] = useState<'create' | 'link' | 'unlink' | null>(null);
  const close = () => setDialog(null);

  const canReadJobs = can(PermissionId.machine_jobsread);
  const canCreate = can(PermissionId.machine_jobscreate);
  const canEdit = can(PermissionId.machine_jobsedit);
  const canLink = canEdit && canReadJobs;

  const linkedRef = print?.job ?? null;
  const linkedQuery = useQuery({ ...jobQuery(linkedRef?.id ?? ''), enabled: linkedRef !== null && canReadJobs });
  const linkedJob = linkedQuery.data;
  const linkedName = linkedRef?.displayId ?? 'The job';

  const unlink = useMutation({
    mutationFn: () => unlinkPrintFromMachineJob(printId, { expectedJobVersion: linkedJob!.version }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Print unlinked', subtitle: `${linkedName} keeps its values and is a manual run again.` });
      close();
    },
  });

  const unlinked = print !== undefined && print.job == null;
  const ended = print !== undefined && print.state !== 'printing';
  const end = print ? printEnd(print) : null;
  const duration = print ? printDurationSeconds(print) : null;
  const canUnlink = canEdit && linkedJob !== undefined;
  const title = print ? print.fileName || print.displayId : 'Print';

  const actions = print ? (
    <>
      {!unlinked && canUnlink && (
        <OverflowMenu iconDescription="More actions" flipped>
          <OverflowMenuItem itemText="Unlink" isDelete onClick={() => { unlink.reset(); setDialog('unlink'); }} />
        </OverflowMenu>
      )}
      {unlinked && ended && canLink && <Button kind="tertiary" renderIcon={LinkIcon} onClick={() => setDialog('link')}>Link to job</Button>}
      {unlinked && ended && canCreate && <Button renderIcon={Add} onClick={() => setDialog('create')}>Create job</Button>}
    </>
  ) : undefined;

  return (
    <PageShell
      title={title} width="wide"
      titleAdornment={print ? <PrintStateTag state={print.state} /> : undefined}
      description={print ? [print.displayId, print.machineName, print.connectorName ? `via ${print.connectorName}` : null].filter(Boolean).join(' · ') : undefined}
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Jobs', to: machineLogbookPaths.jobs() }, { label: title }]}
      actions={actions}
    >
      <QueryBoundary query={query} errorMessage="This print could not be loaded.">
        {!print ? (
          <EmptyState title="Print not found" description="It may have been removed, or the link is wrong." action={<Button as={Link} to={machineLogbookPaths.jobs()} kind="tertiary">Back to Jobs</Button>} />
        ) : (
          <div className="mj-stack">
            {unlinked && ended && (
              <InlineNotification
                kind="warning" lowContrast hideCloseButton title="Not linked to a job"
                subtitle={canCreate || canLink ? 'Create a job from this print, or link it to an existing job, so material usage and billing are recorded.' : 'Staff with job permissions can create or link a job for this print.'}
              />
            )}
            {unlinked && !ended && (
              <InlineNotification
                kind="info" lowContrast hideCloseButton title="Print in progress"
                subtitle="You can create a job from this print or link it to one once the printer has finished."
              />
            )}
            {print.state === 'printing' && (
              <Tile>
                <ProgressBar
                  label="Print progress" value={print.progressPercent ?? 0} max={100}
                  helperText={`${print.progressPercent ?? 0} %${print.estimatedEndAt ? ` · ends ~${formatTime(print.estimatedEndAt)}` : ''}`}
                />
              </Tile>
            )}
            {linkedRef && (
              <Tile>
                <h2 className="mj-section-title">Linked job</h2>
                <p>
                  Linked to{' '}
                  {canReadJobs ? <CarbonLink as={Link} to={machineLogbookPaths.job(linkedRef.id)}>{linkedRef.displayId}{linkedRef.title ? ` ${linkedRef.title}` : ''}</CarbonLink> : linkedRef.displayId}
                  <span className="mj-secondary">{linkedJob ? ` · ${linkedJob.customer?.displayName ?? 'No customer'}.` : '.'} The job uses this print’s times and material.</span>
                </p>
              </Tile>
            )}
            <Tile>
              <dl className="mj-facts">
                <div><dt>Machine</dt><dd>{can(PermissionId.machinesread) ? <CarbonLink as={Link} to={machineLogbookPaths.machine(print.machineId)}>{print.machineName}</CarbonLink> : print.machineName}</dd></div>
                <div><dt>Started</dt><dd>{formatDateTime(print.startedAt)}</dd></div>
                <div><dt>{print.endedAt ? 'Ended' : 'Estimated end'}</dt><dd>{end ? formatDateTime(end) : '—'}</dd></div>
                <div><dt>Runtime</dt><dd>{print.state === 'printing' ? `${formatDuration(Math.max(0, (now - new Date(print.startedAt).getTime()) / 1000))} so far` : duration === null ? '—' : formatDuration(duration)}</dd></div>
                <div><dt>Reported material</dt><dd>{printUsageText(print)}</dd></div>
              </dl>
            </Tile>
            <Tile>
              <h2 className="mj-section-title">Printer events</h2>
              <Accordion>
                <AccordionItem title={`Events from ${print.connectorName ?? 'the printer'} (${print.events.length})`}>
                  {print.events.length === 0 ? <p className="mj-secondary">No events received from the printer.</p> : (
                    <ul className="mj-prints__events">
                      {print.events.map((event) => (
                        <li key={event.id} className="mj-prints__event">
                          <span className="mj-cell-stack"><span>{eventSummary(event)}</span><span className="mj-secondary">{formatDateTime(event.occurredAt)}</span></span>
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
        open={dialog === 'unlink'} title="Unlink this print?" confirmLabel="Unlink" pending={unlink.isPending} onClose={close}
        error={unlink.isError ? (unlink.error instanceof ApiError ? unlink.error.message : 'The print could not be unlinked. Reload the page and try again.') : undefined}
        onConfirm={() => { if (linkedJob) unlink.mutate(); }}
      >
        <p>{linkedName} keeps its current times and material, but becomes a manual run again. The print shows as unlinked.</p>
      </DestructiveActionDialog>

      {print && canLink && <LinkJobModal open={dialog === 'link'} onClose={close} print={print} />}
      {print && canCreate && dialog === 'create' && (
        <JobFormModal
          open mode="create" onClose={close} printId={print.id} initialValues={initialValuesFromPrint(print)}
          // As in the prototype the page stays open after saving; the form confirms with "Job created and linked".
          onSaved={() => undefined}
        />
      )}
    </PageShell>
  );
}
