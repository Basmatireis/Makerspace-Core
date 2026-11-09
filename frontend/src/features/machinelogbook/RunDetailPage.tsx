import { useState } from 'react';
import { RefLink } from '../../app/RefLink';
import {
  Accordion,
  AccordionItem,
  Button,
  Checkbox,
  InlineNotification,
  Link as CarbonLink,
  OverflowMenu,
  OverflowMenuItem,
  ProgressBar,
  Tile,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { detachMachineRun, setMachineRunSignageVisibility } from '../../api/generated/machine-runs/machine-runs';
import type {
  MachineJob,
  MachineRunArtifactUploadResult,
  MachineRunRecording,
  MachineRunReportedUsageItem,
} from '../../api/generated/models';
import { StackCard } from '../../app/components/CardList';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { PermissionId } from '../auth/permissions';
import { DeleteJobModal, DeleteRunModal } from './dialogs/DeleteDialogs';
import { UsageFormModal } from './dialogs/UsageFormModal';
import { ClaimRunModal } from './jobs/ClaimRunModal';
import { MediaCard } from './jobs/MediaCard';
import { RecipientMaterialModal } from './jobs/RecipientMaterialModal';
import { SwitchToCustomerMaterialModal } from './jobs/SwitchToCustomerMaterialModal';
import { ReportedSegments } from './jobs/ReportedSegments';
import { openReportedLines, reportedLineName, reportedLineQuantity } from './jobs/runLines';
import { useUpdateJobFacts } from './jobs/jobsQueries';
import { RunFileUpload, UploadMismatchNotice } from './recording/RunFileUpload';
import { ResolveReportedUsageModal } from './dialogs/ResolveReportedUsageModal';
import { ApiError } from '../../api/http-client';
import { saveError } from './dialogs/jobFormHelpers';
import { artifactQuery, jobQuery, machineLogbookKeys, recordingQuery, runQuery } from './queries';
import { ConsumptionNotice } from './recording/ConsumptionNotice';
import { FactsBar } from './recording/FactsBar';
import { internalStorageMessage, isCommandOpen, isOnInternalStorage } from './recording/recordingText';
import { formatDateTime, formatDuration, formatQuantity, formatTime } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import {
  FromMachineTag,
  isRunLive,
  reportedUsageText,
  RunOutcomeTag,
  runEnd,
  runName,
  runProgress,
  RunSourceTag,
  RunStateTag,
  runStateNow,
  runConsumptionText,
  unresolvedReportedUsageItems,
} from './shared/status';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import { eventLines } from './shared/runEvents';
import { useNow } from './shared/useNow';
import './styles/runs.scss';

const RUN_REFRESH_MS = 5000;
const COMMAND_REFRESH_MS = 3000;

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const can = useCan();
  const currentUser = useCurrentUser();
  const now = useNow();
  const client = useQueryClient();
  const notify = useNotify();
  // Run facts and their machine-event history change independently of this
  // page, so keep the open detail view current while it is visible.
  const query = useQuery({ ...runQuery(runId), refetchInterval: RUN_REFRESH_MS });
  const run = query.data;
  const artifact = useQuery({
    ...artifactQuery(run?.artifact?.id ?? ''),
    enabled: Boolean(run?.artifact?.id) && can(PermissionId.print_artifactsread),
  });
  // Files and commands of a recorded run; poll while a connector command is still open.
  const recording = useQuery({
    ...recordingQuery(runId),
    enabled: run?.source === 'recorded',
    refetchInterval: (query) => (query.state.data?.commands.some(isCommandOpen) ? COMMAND_REFRESH_MS : false),
  });
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'claim' | 'detach' | 'delete' | 'delete-job' | 'usage' | null>(null);
  const [uploaded, setUploaded] = useState<{ result: MachineRunArtifactUploadResult; fileName: string } | null>(null);
  const [resolutionLine, setResolutionLine] = useState<number | null>(null);
  const [resolutionSegment, setResolutionSegment] = useState<MachineRunReportedUsageItem | null>(null);
  const [recipientLine, setRecipientLine] = useState<number | null>(null);
  const [switchUsageId, setSwitchUsageId] = useState<string | null>(null);
  const close = () => setDialog(null);

  const canReadJobs = can(PermissionId.machine_jobsread);
  const canCreate = can(PermissionId.machine_jobscreate);
  const canEdit = can(PermissionId.machine_jobsedit);
  const canAttach = canEdit && canReadJobs;
  const canDeleteJob = can(PermissionId.machine_jobsdelete);
  const canDelete = run !== undefined && (canDeleteJob || (run.source === 'manual' && canEdit));

  const jobRef = run?.job ?? null;
  const jobResult = useQuery({ ...jobQuery(jobRef?.id ?? ''), enabled: jobRef !== null && canReadJobs });
  const job = jobResult.data;
  const jobName = jobRef?.displayId ?? 'The job';

  const detach = useMutation({
    mutationFn: () => detachMachineRun(runId, { expectedJobVersion: job!.version }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: 'Run detached',
        subtitle: `${jobName} no longer includes this run; it is unassigned again.`,
      });
      close();
    },
  });

  const unassigned = run !== undefined && run.job == null;
  const onUploaded = (result: MachineRunArtifactUploadResult, fileName: string) => setUploaded({ result, fileName });
  const uploadAction =
    run?.source === 'recorded' && canEdit ? <RunFileUpload runId={runId} onUploaded={onUploaded} /> : undefined;
  // Staff usage wins over what the machine reports; tell staff when both exist.
  const staffAndMachineMaterial =
    run !== undefined &&
    run.usages.some((usage) => usage.staffCorrected) &&
    ((run.reportedUsageItems?.length ?? 0) > 0 || run.reportedUsage != null);
  const live = run !== undefined && isRunLive(run, now);
  // Mirrors the backend rule (job editors, or the job's operator or person customer); the backend decides.
  const canHideFromSignage =
    canEdit ||
    job?.operator?.personId === currentUser.person.id ||
    (job?.customer?.kind === 'person' && job.customer.id === currentUser.person.id);
  const signageVisibility = useMutation({
    mutationFn: (hidden: boolean) => setMachineRunSignageVisibility(runId, { hidden }),
    onSuccess: async (updated) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.run(runId) });
      notify({
        kind: 'success',
        title: updated.hiddenFromSignage ? 'Run hidden from signage' : 'Run shown on signage again',
      });
    },
    onError: (error) =>
      notify({
        kind: 'error',
        title: 'Signage visibility not changed',
        subtitle:
          error instanceof ApiError && error.data?.code === 'run_ended'
            ? 'The run has already ended.'
            : 'Reload the page and try again.',
      }),
  });
  const state = run ? runStateNow(run, now) : undefined;
  const end = run ? runEnd(run) : null;
  const progress = run ? runProgress(run, now) : 0;
  const consumedMaterial =
    run && live && run.usages.length === 0 ? 'Pending final report' : run ? runConsumptionText(run) : '';
  const reportedMaterial =
    run && live && run.reportedUsage == null && (run.reportedUsageItems?.length ?? 0) === 0
      ? 'Pending final report'
      : run
        ? reportedUsageText(run)
        : '';
  const unresolvedMaterials = run ? unresolvedReportedUsageItems(run) : [];
  // Lines neither a spool nor the recipient's own material accounts for; staff resolve them one by one.
  const openLines = run ? openReportedLines(run) : [];
  const plannedFilaments =
    artifact.data?.filaments.filter(
      (filament) => filament.plannedWeightGrams != null && Number(filament.plannedWeightGrams) >= 0,
    ) ?? [];
  const plannedGrams = plannedFilaments.reduce((total, filament) => total + Number(filament.plannedWeightGrams), 0);
  const approximateUsedGrams = (plannedGrams * progress) / 100;
  const title = run ? runName(run) : 'Run';
  const onlyRun = job !== undefined && job.runs.filter((item) => item.state !== 'replaced').length === 1;

  const canEditUsage = canEdit && run?.state !== 'replaced';
  const canDetach = !unassigned && canEdit && job !== undefined && run?.source === 'recorded';
  const canClaim = unassigned && (canCreate || canAttach);

  const actions = run ? (
    <>
      {(canEditUsage || canDetach || canDelete) && (
        <OverflowMenu aria-label="More run actions" iconDescription="More run actions" flipped>
          {canEditUsage && <OverflowMenuItem itemText="Edit material usage" onClick={() => setDialog('usage')} />}
          {canEditUsage &&
            run.usages
              .filter((usage) => usage.ownership === 'makerspace')
              .map((usage) => (
                <OverflowMenuItem
                  key={usage.id}
                  itemText={`Switch ${usage.materialName} to customer material`}
                  onClick={() => setSwitchUsageId(usage.id)}
                />
              ))}
          {canDetach && (
            <OverflowMenuItem
              itemText="Detach from job"
              isDelete
              hasDivider={canEditUsage}
              onClick={() => {
                detach.reset();
                setDialog('detach');
              }}
            />
          )}
          {canDelete && (
            <OverflowMenuItem itemText="Delete run" isDelete hasDivider onClick={() => setDialog('delete')} />
          )}
        </OverflowMenu>
      )}
      {canClaim && (
        <Button renderIcon={Add} onClick={() => setDialog('claim')}>
          Claim
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <PageShell
      title={title}
      width="wide"
      titleAdornment={
        run && state ? (
          <span className="mj-inline">
            <RunStateTag state={state} />
            <RunSourceTag source={run.source} />
          </span>
        ) : undefined
      }
      breadcrumbs={[
        { label: 'Workshop', to: machineLogbookPaths.home() },
        { label: 'Jobs', to: machineLogbookPaths.jobs() },
        { label: title },
      ]}
      actions={actions}
    >
      <QueryBoundary query={query} errorMessage="This run could not be loaded.">
        {!run ? (
          <EmptyState
            title="Run not found"
            description="It may have been removed, or the link is wrong."
            action={
              <Button as={Link} to={machineLogbookPaths.jobs()} kind="tertiary">
                Back to Jobs
              </Button>
            }
          />
        ) : (
          <div className="mj-stack">
            {unassigned && !live && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="Not part of a job"
                subtitle={
                  canCreate || canAttach
                    ? 'Create a job from this run, or attach it to an existing job, so material usage and billing are recorded.'
                    : 'Staff with job permissions can create a job for this run or attach it to one.'
                }
              />
            )}
            {unassigned && live && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Run in progress"
                subtitle="You can create a job from this run or attach it to one now; the job shows as running until the run ends."
              />
            )}
            {uploaded?.result.nameMismatch && (
              <UploadMismatchNotice
                result={uploaded.result}
                fileName={uploaded.fileName}
                runId={run.id}
                onKeep={() => setUploaded(null)}
                onUploaded={onUploaded}
              />
            )}
            {run.materialChangedDuringRun && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Material changed during the print"
                subtitle="The filament was booked per spool and priced per article."
              />
            )}
            {staffAndMachineMaterial && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="Material entered by staff"
                subtitle="The machine also reported material for this run. The staff entry counts; the machine’s report is not booked."
              />
            )}
            {live && (
              <Tile>
                <ProgressBar
                  label="Run progress"
                  value={progress}
                  max={100}
                  helperText={`${progress} %${end ? ` · ends ~${formatTime(end)}` : ''}`}
                />
              </Tile>
            )}
            {live && run.jobHiddenFromSignage && (
              <p className="mj-secondary">Off the signage screens because the job is kept off signage.</p>
            )}
            {live && canHideFromSignage && !run.jobHiddenFromSignage && (
              <Tile>
                <Checkbox
                  id="run-hidden-from-signage"
                  labelText="Hide this run from signage screens"
                  helperText="Machine status and camera are hidden from all displays until this run ends."
                  checked={run.hiddenFromSignage}
                  disabled={signageVisibility.isPending}
                  onChange={(_, { checked }) => signageVisibility.mutate(checked)}
                />
              </Tile>
            )}
            <div className="mj-detail-layout">
              <div className="mj-stack">
                {jobRef && (
                  <Tile>
                    <h2 className="mj-section-title">Job</h2>
                    <p>
                      Part of{' '}
                      <RefLink kind="job" reference={jobRef.displayId} id={jobRef.id}>
                        {jobRef.displayId}
                        {jobRef.title ? ` ${jobRef.title}` : ''}
                      </RefLink>
                      <span className="mj-secondary">
                        {job ? ` · ${job.customer?.displayName ?? 'No recipient'}.` : '.'} Material and outcome from
                        this run count towards the job.
                      </span>
                    </p>
                  </Tile>
                )}
                <FactsBar
                  metrics={[
                    {
                      label: 'Runtime',
                      value: live
                        ? `${formatDuration(run.durationSeconds)} so far`
                        : formatDuration(run.durationSeconds),
                    },
                    {
                      label: 'Material',
                      value: consumedMaterial,
                      note: run.usagesFromMachine ? <FromMachineTag /> : undefined,
                    },
                    {
                      label: 'Outcome',
                      value: live ? (
                        <span className="mj-secondary">Not recorded yet</span>
                      ) : (
                        <RunOutcomeTag outcome={run.outcome} size="sm" />
                      ),
                      note: run.outcomeFromMachine ? <FromMachineTag /> : undefined,
                    },
                    {
                      label: 'Machine',
                      value: can(PermissionId.machinesread) ? (
                        <CarbonLink as={Link} to={machineLogbookPaths.machine(run.machineId)}>
                          {run.machineName}
                        </CarbonLink>
                      ) : (
                        run.machineName
                      ),
                      note: run.connectorName ? `via ${run.connectorName}` : 'Manual run',
                    },
                  ]}
                  details={[
                    { label: 'Source', value: run.source === 'recorded' ? 'Recorded' : 'Manual' },
                    { label: 'Started', value: formatDateTime(run.startedAt) },
                    { label: run.endedAt ? 'Ended' : 'Estimated end', value: end ? formatDateTime(end) : '—' },
                    ...(run.source === 'recorded'
                      ? [
                          {
                            label: 'Reported material',
                            value: reportedMaterial,
                            note: (
                              <>
                                <ReportedSegments
                                  run={run}
                                  onMap={
                                    !live &&
                                    canEdit &&
                                    can(PermissionId.inventoryread) &&
                                    !run.usages.some((usage) => usage.staffCorrected)
                                      ? (item, segment) =>
                                          setResolutionSegment({
                                            ...item,
                                            plannedQuantityGrams: null,
                                            estimatedQuantityGrams: segment.estimatedQuantityGrams ?? null,
                                            segments: [],
                                          })
                                      : undefined
                                  }
                                />
                                {!live && canEdit && can(PermissionId.inventoryread) && openLines.length > 0 ? (
                                  <ul className="jobs-lines">
                                    {openLines.map((item) => {
                                      const grams = reportedLineQuantity(item);
                                      return (
                                        <li
                                          key={`${item.reportRevision}-${item.lineNumber}`}
                                          className="jobs-lines__line"
                                        >
                                          <span>
                                            {reportedLineName(item)}
                                            {grams != null ? ` · ${formatQuantity(grams)} g` : ''} · not booked
                                          </span>
                                          <span className="mj-inline">
                                            <Button
                                              kind="ghost"
                                              size="sm"
                                              onClick={() => setResolutionLine(item.lineNumber)}
                                            >
                                              Map{' '}
                                              {item.slicerFilamentId
                                                ? `filament ${item.slicerFilamentId}`
                                                : `line ${item.lineNumber + 1}`}{' '}
                                              to a spool
                                            </Button>
                                            <Button
                                              kind="ghost"
                                              size="sm"
                                              onClick={() => setRecipientLine(item.lineNumber)}
                                            >
                                              Recipient’s own
                                            </Button>
                                          </span>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                ) : undefined}
                              </>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
                {live && run.source === 'recorded' && run.usages.length === 0 && (
                  <p className="mj-secondary">
                    Mounted spools describe the printer setup, not which spool this run consumed. Core records run
                    consumption after the printer identifies the active source and the final report is accepted.
                  </p>
                )}
                {run.source === 'recorded' && (
                  <ConsumptionNotice
                    runId={run.id}
                    status={run.consumptionStatus}
                    recording={recording.data}
                    canEdit={canEdit}
                    ended={!live}
                    uploadAction={uploadAction}
                  />
                )}
                {live && run.source === 'recorded' && can(PermissionId.print_artifactsread) && (
                  <Tile>
                    <h2 className="mj-section-title">Filament estimate</h2>
                    {!run.artifact && isOnInternalStorage(run.consumptionStatus) && (
                      <p className="mj-secondary">{internalStorageMessage}</p>
                    )}
                    {!run.artifact && !isOnInternalStorage(run.consumptionStatus) && (
                      <p className="mj-secondary">
                        Waiting for the printer’s 3MF file. The estimate appears after the connector retrieves and
                        parses it.
                      </p>
                    )}
                    {run.artifact && artifact.isPending && <p className="mj-secondary">Reading the filament plan…</p>}
                    {artifact.isError && (
                      <InlineNotification
                        kind="warning"
                        lowContrast
                        hideCloseButton
                        title="Filament plan unavailable"
                        subtitle="The run continues normally. Check the connector’s FTPS diagnostics."
                      />
                    )}
                    {artifact.isSuccess && plannedGrams <= 0 && (
                      <p className="mj-secondary">The 3MF does not contain a defensible planned filament weight.</p>
                    )}
                    {artifact.isSuccess && plannedGrams > 0 && (
                      <>
                        <ProgressBar
                          label="Approximate filament used"
                          value={approximateUsedGrams}
                          max={plannedGrams}
                          helperText={`~${formatQuantity(approximateUsedGrams)} g / ${formatQuantity(plannedGrams)} g planned · based on ${progress} % print progress`}
                        />
                        {plannedFilaments.length > 1 && (
                          <ul>
                            {plannedFilaments.map((filament) => (
                              <li key={filament.filamentKey}>
                                {[filament.filamentType, filament.color && `${filament.color} (detected in file)`]
                                  .filter(Boolean)
                                  .join(' · ') || `Filament ${filament.filamentKey}`}
                                : {formatQuantity(filament.plannedWeightGrams!)} g planned
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="mj-secondary">
                          This is a display-only approximation. Inventory is updated only after the run ends and the
                          final report is accepted.
                        </p>
                      </>
                    )}
                  </Tile>
                )}
                {run.source === 'recorded' && (
                  <Tile>
                    <h2 className="mj-section-title">Machine events</h2>
                    <Accordion>
                      <AccordionItem title={`Events from ${run.connectorName ?? 'the machine'} (${run.events.length})`}>
                        {run.events.length === 0 ? (
                          <p className="mj-secondary">No events received from the machine.</p>
                        ) : (
                          <ul className="mj-runs__events">
                            {eventLines(run.events).map(({ event, line }) => (
                              <li key={event.id} className="mj-runs__event">
                                <span className="mj-cell-stack">
                                  <span>
                                    {line.text}
                                    {line.link && (
                                      <>
                                        {' '}
                                        <CarbonLink
                                          href={line.link}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          size="sm"
                                        >
                                          Read more
                                        </CarbonLink>
                                      </>
                                    )}
                                  </span>
                                  <span className="mj-secondary">{formatDateTime(event.occurredAt)}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </AccordionItem>
                    </Accordion>
                  </Tile>
                )}
              </div>
              <div className="mj-stack">
                {run.source === 'recorded' &&
                  (job && canEdit ? (
                    <JobMediaCard job={job} recordings={recording.data ? [recording.data] : []} />
                  ) : (
                    <MediaCard
                      recordings={recording.data ? [recording.data] : []}
                      offSignage={run.jobHiddenFromSignage || run.hiddenFromSignage}
                    />
                  ))}
                {recording.isError && (
                  <InlineNotification
                    kind="warning"
                    lowContrast
                    hideCloseButton
                    title="Preview unavailable"
                    subtitle="The print file information could not be loaded."
                  />
                )}
                {!run.job && (
                  <StackCard title="Job">
                    <p className="mj-secondary">This run belongs to no job yet.</p>
                    {canClaim && (
                      <div>
                        <Button kind="tertiary" size="md" renderIcon={Add} onClick={() => setDialog('claim')}>
                          Claim
                        </Button>
                      </div>
                    )}
                  </StackCard>
                )}
              </div>
            </div>
          </div>
        )}
      </QueryBoundary>

      <DestructiveActionDialog
        open={dialog === 'detach'}
        title="Detach this run?"
        fate="none"
        confirmLabel="Detach"
        pending={detach.isPending}
        onClose={close}
        error={
          detach.isError
            ? saveError(detach.error, 'The run could not be detached. Reload the page and try again.').message
            : undefined
        }
        onConfirm={() => {
          if (job) detach.mutate();
        }}
      >
        <p>
          {jobName} no longer includes this run, which shows as unassigned again. The run keeps its material usage and
          the stock it consumed.
          {onlyRun &&
            ` Because it is the only run, ${jobName} gets a manual run with the same start, end and outcome, but without material.`}
        </p>
      </DestructiveActionDialog>

      {run && canDelete && (
        <DeleteRunModal
          open={dialog === 'delete'}
          onClose={close}
          run={run}
          runId={run.id}
          job={job}
          onDeleteJob={canDeleteJob && job ? () => setDialog('delete-job') : undefined}
          onDeleted={() =>
            navigate(
              jobRef && !onlyRun && canReadJobs ? machineLogbookPaths.job(jobRef.id) : machineLogbookPaths.jobs(),
            )
          }
        />
      )}
      {job && canDeleteJob && <DeleteJobModal open={dialog === 'delete-job'} onClose={close} job={job} />}

      {run && canEdit && <UsageFormModal open={dialog === 'usage'} onClose={close} run={run} />}
      {run && resolutionSegment && (
        <ResolveReportedUsageModal open onClose={() => setResolutionSegment(null)} run={run} item={resolutionSegment} />
      )}
      {run &&
        resolutionLine !== null &&
        (() => {
          const item = unresolvedMaterials.find((candidate) => candidate.lineNumber === resolutionLine);
          return item ? (
            <ResolveReportedUsageModal open onClose={() => setResolutionLine(null)} run={run} item={item} />
          ) : null;
        })()}
      {run && (
        <SwitchToCustomerMaterialModal
          run={run}
          usage={run.usages.find((usage) => usage.id === switchUsageId) ?? null}
          onClose={() => setSwitchUsageId(null)}
        />
      )}
      {run && (
        <RecipientMaterialModal
          run={run}
          item={openLines.find((candidate) => candidate.lineNumber === recipientLine) ?? null}
          onClose={() => setRecipientLine(null)}
        />
      )}
      <ClaimRunModal
        runId={dialog === 'claim' && run ? run.id : null}
        onClose={close}
        canCreate={canCreate}
        canAttach={canAttach}
      />
    </PageShell>
  );
}

/** The media card of a run that belongs to a job: the title row toggles the job's signage flag. */
function JobMediaCard({ job, recordings }: { job: MachineJob; recordings: MachineRunRecording[] }) {
  const notify = useNotify();
  const update = useUpdateJobFacts(job);
  return (
    <MediaCard
      recordings={recordings}
      offSignage={job.hiddenFromSignage}
      signagePending={update.isPending}
      onToggleSignage={
        job.operator
          ? () =>
              update.mutate(
                { hiddenFromSignage: !job.hiddenFromSignage },
                {
                  onSuccess: (saved) =>
                    notify({
                      kind: 'success',
                      title: saved.hiddenFromSignage ? 'Kept off signage' : 'Back on signage',
                      subtitle: `${saved.displayId} · stream and timelapses of all its runs`,
                    }),
                  onError: () =>
                    notify({ kind: 'error', title: 'Signage not changed', subtitle: 'Reload and try again.' }),
                },
              )
          : undefined
      }
    />
  );
}
