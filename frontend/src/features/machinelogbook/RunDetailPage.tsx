import { useState } from 'react';
import { Accordion, AccordionItem, Button, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem, ProgressBar, Tile } from '@carbon/react';
import { Add, Link as LinkIcon } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { detachMachineRun } from '../../api/generated/machine-runs/machine-runs';
import type { MachineRunEvent } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { PermissionId } from '../auth/permissions';
import { AttachToJobModal } from './dialogs/AttachToJobModal';
import { JobFormModal } from './dialogs/JobFormModal';
import { saveError } from './dialogs/jobFormHelpers';
import { artifactQuery, jobQuery, machineLogbookKeys, runQuery } from './queries';
import { formatDateTime, formatDuration, formatQuantity, formatTime } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { FromMachineTag, isRunLive, reportedUsageText, RunOutcomeTag, runEnd, runName, runProgress, RunSourceTag, RunStateTag, runStateNow, usagesText } from './shared/status';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import './styles/runs.scss';

const words = (value: string) => value.replace(/_/g, ' ');

/** One readable line per machine event (never the raw payload). */
function eventSummary(event: MachineRunEvent) {
  switch (event.kind) {
    case 'identity': return 'Machine identified';
    case 'connectivity': return event.state ? `Connectivity: ${words(event.state)}` : 'Connectivity changed';
    case 'operational_state': return event.state ? `State: ${words(event.state)}` : 'State changed';
    case 'progress': return event.progressPercent != null ? `Progress ${event.progressPercent} %` : 'Progress reported';
    case 'slot_observation': return 'Material slot observed';
    case 'consumption_report': return event.quantity != null ? `Consumption reported: ${formatQuantity(event.quantity)} g` : 'Consumption reported';
    case 'terminal_outcome': return event.state ? `Outcome: ${words(event.state)}` : 'Outcome reported';
    case 'printer_error': return 'Printer error changed';
    case 'filament_change': return 'Filament changed';
  }
}

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const can = useCan();
  const now = useNow();
  const client = useQueryClient();
  const notify = useNotify();
  const query = useQuery(runQuery(runId));
  const run = query.data;
  const artifact = useQuery({ ...artifactQuery(run?.artifact?.id ?? ''), enabled: Boolean(run?.artifact?.id) && can(PermissionId.print_artifactsread) });
  const [dialog, setDialog] = useState<'create' | 'attach' | 'detach' | null>(null);
  const close = () => setDialog(null);

  const canReadJobs = can(PermissionId.machine_jobsread);
  const canCreate = can(PermissionId.machine_jobscreate);
  const canEdit = can(PermissionId.machine_jobsedit);
  const canAttach = canEdit && canReadJobs;

  const jobRef = run?.job ?? null;
  const jobResult = useQuery({ ...jobQuery(jobRef?.id ?? ''), enabled: jobRef !== null && canReadJobs });
  const job = jobResult.data;
  const jobName = jobRef?.displayId ?? 'The job';

  const detach = useMutation({
    mutationFn: () => detachMachineRun(runId, { expectedJobVersion: job!.version }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Run detached', subtitle: `${jobName} no longer includes this run; it is unassigned again.` });
      close();
    },
  });

  const unassigned = run !== undefined && run.job == null;
  const live = run !== undefined && isRunLive(run, now);
  const state = run ? runStateNow(run, now) : undefined;
  const end = run ? runEnd(run) : null;
  const progress = run ? runProgress(run, now) : 0;
  const plannedFilaments = artifact.data?.filaments.filter((filament) => filament.plannedWeightGrams != null && Number(filament.plannedWeightGrams) >= 0) ?? [];
  const plannedGrams = plannedFilaments.reduce((total, filament) => total + Number(filament.plannedWeightGrams), 0);
  const approximateUsedGrams = plannedGrams * progress / 100;
  const title = run ? runName(run) : 'Run';
  const onlyRun = job !== undefined && job.runs.filter((item) => item.state !== 'replaced').length === 1;

  const actions = run ? (
    <>
      {!unassigned && canEdit && job !== undefined && run.source === 'recorded' && (
        <OverflowMenu aria-label="More run actions" iconDescription="More run actions" flipped>
          <OverflowMenuItem itemText="Detach from job" isDelete onClick={() => { detach.reset(); setDialog('detach'); }} />
        </OverflowMenu>
      )}
      {unassigned && canAttach && <Button kind="tertiary" renderIcon={LinkIcon} onClick={() => setDialog('attach')}>Attach to job</Button>}
      {unassigned && canCreate && <Button renderIcon={Add} onClick={() => setDialog('create')}>Create job</Button>}
    </>
  ) : undefined;

  return (
    <PageShell
      title={title} width="wide"
      titleAdornment={run && state ? <span className="mj-inline"><RunStateTag state={state} /><RunSourceTag source={run.source} /></span> : undefined}
      description={run ? [run.displayId, run.machineName, run.connectorName ? `via ${run.connectorName}` : null].filter(Boolean).join(' · ') : undefined}
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Jobs', to: machineLogbookPaths.jobs() }, { label: title }]}
      actions={actions}
    >
      <QueryBoundary query={query} errorMessage="This run could not be loaded.">
        {!run ? (
          <EmptyState title="Run not found" description="It may have been removed, or the link is wrong." action={<Button as={Link} to={machineLogbookPaths.jobs()} kind="tertiary">Back to Jobs</Button>} />
        ) : (
          <div className="mj-stack">
            {unassigned && !live && (
              <InlineNotification
                kind="warning" lowContrast hideCloseButton title="Not part of a job"
                subtitle={canCreate || canAttach ? 'Create a job from this run, or attach it to an existing job, so material usage and billing are recorded.' : 'Staff with job permissions can create a job for this run or attach it to one.'}
              />
            )}
            {unassigned && live && (
              <InlineNotification
                kind="info" lowContrast hideCloseButton title="Run in progress"
                subtitle="You can create a job from this run or attach it to one now; the job shows as running until the run ends."
              />
            )}
            {live && (
              <Tile>
                <ProgressBar
                  label="Run progress" value={progress} max={100}
                  helperText={`${progress} %${end ? ` · ends ~${formatTime(end)}` : ''}`}
                />
              </Tile>
            )}
            {live && run.source === 'recorded' && can(PermissionId.print_artifactsread) && (
              <Tile>
                <h2 className="mj-section-title">Filament estimate</h2>
                {!run.artifact && <p className="mj-secondary">Waiting for the printer’s 3MF file. The estimate appears after the connector retrieves and parses it.</p>}
                {run.artifact && artifact.isPending && <p className="mj-secondary">Reading the filament plan…</p>}
                {artifact.isError && <InlineNotification kind="warning" lowContrast hideCloseButton title="Filament plan unavailable" subtitle="The run continues normally. Check the connector’s FTPS diagnostics." />}
                {artifact.isSuccess && plannedGrams <= 0 && <p className="mj-secondary">The 3MF does not contain a defensible planned filament weight.</p>}
                {artifact.isSuccess && plannedGrams > 0 && (
                  <>
                    <ProgressBar
                      label="Approximate filament used" value={approximateUsedGrams} max={plannedGrams}
                      helperText={`~${formatQuantity(approximateUsedGrams)} g / ${formatQuantity(plannedGrams)} g planned · based on ${progress} % print progress`}
                    />
                    {plannedFilaments.length > 1 && (
                      <ul>
                        {plannedFilaments.map((filament) => <li key={filament.filamentKey}>{[filament.filamentType, filament.color].filter(Boolean).join(' · ') || `Filament ${filament.filamentKey}`}: {formatQuantity(filament.plannedWeightGrams!)} g planned</li>)}
                      </ul>
                    )}
                    <p className="mj-secondary">This is a display-only approximation. Inventory is updated only after the run ends and the final report is accepted.</p>
                  </>
                )}
              </Tile>
            )}
            {jobRef && (
              <Tile>
                <h2 className="mj-section-title">Job</h2>
                <p>
                  Part of{' '}
                  {canReadJobs ? <CarbonLink as={Link} to={machineLogbookPaths.job(jobRef.id)}>{jobRef.displayId}{jobRef.title ? ` ${jobRef.title}` : ''}</CarbonLink> : jobRef.displayId}
                  <span className="mj-secondary">{job ? ` · ${job.customer?.displayName ?? 'No customer'}.` : '.'} Material and outcome from this run count towards the job.</span>
                </p>
              </Tile>
            )}
            <Tile>
              <dl className="mj-facts">
                <div><dt>Machine</dt><dd>{can(PermissionId.machinesread) ? <CarbonLink as={Link} to={machineLogbookPaths.machine(run.machineId)}>{run.machineName}</CarbonLink> : run.machineName}</dd></div>
                <div><dt>Source</dt><dd className="mj-cell-stack"><span>{run.source === 'recorded' ? 'Recorded' : 'Manual'}</span>{run.connectorName && <span className="mj-secondary">via {run.connectorName}</span>}</dd></div>
                <div><dt>Started</dt><dd>{formatDateTime(run.startedAt)}</dd></div>
                <div><dt>{run.endedAt ? 'Ended' : 'Estimated end'}</dt><dd>{end ? formatDateTime(end) : '—'}</dd></div>
                <div><dt>Runtime</dt><dd>{live ? `${formatDuration(run.durationSeconds)} so far` : formatDuration(run.durationSeconds)}</dd></div>
                <div>
                  <dt>Outcome</dt>
                  <dd className="mj-cell-stack">
                    {live ? <span className="mj-secondary">Not recorded yet</span> : <span><RunOutcomeTag outcome={run.outcome} size="sm" /></span>}
                    {run.outcomeFromMachine && <span><FromMachineTag /></span>}
                  </dd>
                </div>
                <div><dt>Material</dt><dd className="mj-cell-stack"><span>{usagesText(run.usages)}</span>{run.usagesFromMachine && <span><FromMachineTag /></span>}</dd></div>
                {run.source === 'recorded' && <div><dt>Reported material</dt><dd>{reportedUsageText(run)}</dd></div>}
              </dl>
            </Tile>
            {run.source === 'recorded' && (
              <Tile>
                <h2 className="mj-section-title">Machine events</h2>
                <Accordion>
                  <AccordionItem title={`Events from ${run.connectorName ?? 'the machine'} (${run.events.length})`}>
                    {run.events.length === 0 ? <p className="mj-secondary">No events received from the machine.</p> : (
                      <ul className="mj-runs__events">
                        {run.events.map((event) => (
                          <li key={event.id} className="mj-runs__event">
                            <span className="mj-cell-stack"><span>{eventSummary(event)}</span><span className="mj-secondary">{formatDateTime(event.occurredAt)}</span></span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </AccordionItem>
                </Accordion>
              </Tile>
            )}
          </div>
        )}
      </QueryBoundary>

      <DestructiveActionDialog
        open={dialog === 'detach'} title="Detach this run?" confirmLabel="Detach" pending={detach.isPending} onClose={close}
        error={detach.isError ? saveError(detach.error, 'The run could not be detached. Reload the page and try again.').message : undefined}
        onConfirm={() => { if (job) detach.mutate(); }}
      >
        <p>
          {jobName} no longer includes this run, which shows as unassigned again. The run keeps its material usage and the stock it consumed.
          {onlyRun && ` Because it is the only run, ${jobName} gets a manual run with the same start, end and outcome, but without material.`}
        </p>
      </DestructiveActionDialog>

      {run && canAttach && <AttachToJobModal open={dialog === 'attach'} onClose={close} run={run} />}
      {run && canCreate && dialog === 'create' && (
        // As in the prototype the page stays open after saving; the form confirms with "Job created".
        <JobFormModal open mode="create" onClose={close} run={run} onSaved={() => undefined} />
      )}
    </PageShell>
  );
}
