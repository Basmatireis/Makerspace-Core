import { useState } from 'react';
import { Button, IconButton, ProgressBar, Tag } from '@carbon/react';
import { Add, ArrowRight, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { MachineRun, MachineRunRecording } from '../../../api/generated/models';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../../app/components/Facts';
import { ListWithPanel } from '../../../app/components/ListWithPanel';
import { AttentionFlag } from '../../../app/components/AttentionFlag';
import { formatDate, formatTime } from '../../../app/dateTime';
import { EmptyState } from '../../../app/PageState';
import { DeleteRunModal } from '../dialogs/DeleteDialogs';
import { jobOrderQuery } from '../dialogs/jobFormHelpers';
import { jobConsumption } from '../processConfig';
import { jobQuery, jobRecordingsQuery, recordingQuery, runQuery } from '../queries';
import { formatDuration, formatMoney } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import {
  activeRuns,
  isRunLive,
  machineJobName,
  reportedUsageText,
  runConsumptionText,
  runName,
  runProgress,
} from '../shared/status';
import { useCan } from '../shared/useCan';
import { useNow } from '../shared/useNow';
import { jobBilling } from '../jobDetail/jobDetailShared';
import { ClaimRunModal } from './ClaimRunModal';
import { BillingText, jobPhase, JobPhaseTag, OutcomeStatusTag } from './jobStatus';
import { JobsTable, type JobsSelection, type JobsTableProps } from './JobsTable';
import { PanelPreview } from './MediaCard';
import '../styles/jobs.scss';
import './jobs.scss';

const dateTime = (value: string) => `${formatDate(value)} ${formatTime(value)}`;

function JobPanel({ jobId }: { jobId: string }) {
  const can = useCan();
  const now = useNow();
  const query = useQuery(jobQuery(jobId));
  const recordings = useQuery(jobRecordingsQuery(jobId));
  const association = useQuery({ ...jobOrderQuery(jobId), enabled: can('orders.read') });
  const job = query.data;
  if (!job) return <DetailPanel>{query.isError ? <p>The job could not be loaded.</p> : <p>Loading…</p>}</DetailPanel>;
  const runs = activeRuns(job);
  const running = runs.filter((run) => isRunLive(run, now));
  const phase = jobPhase(job.status);
  const material = jobConsumption({ runs, measures: job.measures }) ?? 'None recorded';
  return (
    <DetailPanel className="jobs-panel">
      <PanelPreview recordings={recordings.data?.items ?? []} />
      <DetailPanelHead
        title={machineJobName(job)}
        meta={`${job.displayId} · ${job.machine.name}`}
        secondary={[job.customer?.displayName ?? 'No recipient', job.operator?.displayName].filter(Boolean).join(' · ')}
        helper={
          <span className="mj-inline jobs-panel__tags">
            <JobPhaseTag status={job.status} />
            {phase === 'finished' && <OutcomeStatusTag status={job.status} />}
            {job.hiddenFromSignage && (
              <Tag type="outline" size="sm">
                Off signage
              </Tag>
            )}
          </span>
        }
        actions={<AttentionFlag attention={job.attention} align="left" />}
      />
      <div>
        <Button kind="primary" size="md" renderIcon={ArrowRight} as={Link} to={machineLogbookPaths.job(job.id)}>
          Open job
        </Button>
      </div>
      <FactsGrid columns={2}>
        <Fact label="Started">{job.startedAt ? dateTime(job.startedAt) : 'Planned, no run yet'}</Fact>
        <Fact label="Runtime">
          {formatDuration(job.durationSeconds)}
          {running.length ? ' so far' : ''}
        </Fact>
        <Fact label="Runs" helper={running.length ? `${running.length} running` : undefined}>
          {runs.length}
        </Fact>
        <Fact label="Material">{material}</Fact>
        <Fact label="Recipient" helper={job.customer?.pricingGroup?.name}>
          {job.customer?.displayName ?? '—'}
        </Fact>
        <Fact label="Operator">{job.operator?.displayName ?? '—'}</Fact>
        <Fact label="Billing">
          <BillingText status={job.status} billing={jobBilling(job, association.data) ?? undefined} />
        </Fact>
        <Fact label="Price">{job.pricingStatus === 'incomplete' ? 'Incomplete' : formatMoney(job.effectivePrice)}</Fact>
      </FactsGrid>
      <DetailPanelSection title="Notes">
        <p className="mj-notes">{job.notes || <span className="mj-secondary">—</span>}</p>
      </DetailPanelSection>
      <DetailPanelSection title="Runs">
        {runs.length === 0 ? (
          <p className="mj-secondary">No run yet.</p>
        ) : (
          <ul className="jobs-panel__runs">
            {runs.map((run) => (
              <li key={run.id} className="jobs-panel__run">
                <span className="mj-cell-stack">
                  <span>
                    <strong>{run.fileName ? runName(run) : 'Manual run'}</strong>{' '}
                    <span className="mj-secondary">{run.displayId}</span>
                  </span>
                  <span className="mj-secondary">
                    {dateTime(run.startedAt)} · {formatDuration(run.durationSeconds)}
                    {isRunLive(run, now) ? ' so far' : ''} · {runConsumptionText(run) || 'no material'}
                  </span>
                  {isRunLive(run, now) && run.source === 'recorded' && (
                    <ProgressBar
                      label={`Progress of ${run.displayId}`}
                      hideLabel
                      size="small"
                      value={runProgress(run, now)}
                      max={100}
                    />
                  )}
                </span>
                <RunStatusTag run={run} now={now} />
              </li>
            ))}
          </ul>
        )}
      </DetailPanelSection>
    </DetailPanel>
  );
}

function RunStatusTag({ run, now }: { run: MachineRun; now: number }) {
  if (isRunLive(run, now))
    return (
      <Tag type="blue" size="sm">
        Running
      </Tag>
    );
  return <OutcomeStatusTag status={run.outcome ?? 'unknown'} />;
}

function RunPanel({ runId, onGone }: { runId: string; onGone: () => void }) {
  const can = useCan();
  const now = useNow();
  const query = useQuery(runQuery(runId));
  const recording = useQuery({ ...recordingQuery(runId), enabled: query.data?.source === 'recorded' });
  const [claiming, setClaiming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const run = query.data;
  if (!run) return <DetailPanel>{query.isError ? <p>The run could not be loaded.</p> : <p>Loading…</p>}</DetailPanel>;
  const live = isRunLive(run, now);
  const recordings: MachineRunRecording[] = recording.data ? [recording.data] : [];
  return (
    <DetailPanel className="jobs-panel">
      <PanelPreview recordings={recordings} />
      <DetailPanelHead
        title={runName(run)}
        meta={`${run.displayId} · ${run.machineName}`}
        secondary={run.connectorName ? `via ${run.connectorName}` : 'Manual run'}
        helper={
          <span className="mj-inline jobs-panel__tags">
            <RunStatusTag run={run} now={now} />
            {!run.job && (
              <Tag type="purple" size="sm">
                Unassigned
              </Tag>
            )}
            <Tag type={run.source === 'recorded' ? 'teal' : 'gray'} size="sm">
              {run.source === 'recorded' ? 'Recorded' : 'Manual'}
            </Tag>
          </span>
        }
      />
      <div className="mj-inline">
        {!run.job && (can('machine_jobs.create') || can('machine_jobs.edit')) && (
          <Button kind="primary" size="md" renderIcon={Add} onClick={() => setClaiming(true)}>
            Claim
          </Button>
        )}
        <Button kind="tertiary" size="md" renderIcon={ArrowRight} as={Link} to={machineLogbookPaths.run(run.id)}>
          Open run
        </Button>
        {can('machine_jobs.delete') && (
          <IconButton kind="ghost" size="md" label="Delete run" align="bottom" onClick={() => setDeleting(true)}>
            <TrashCan />
          </IconButton>
        )}
      </div>
      {live && run.progressPercent != null && (
        <ProgressBar
          label="Progress"
          value={runProgress(run, now)}
          max={100}
          helperText={`${runProgress(run, now)} %${run.estimatedEndAt ? ` · ends ~${formatTime(run.estimatedEndAt)}` : ''}`}
        />
      )}
      <FactsGrid columns={2}>
        <Fact label="Machine">{run.machineName}</Fact>
        <Fact label="Started">{dateTime(run.startedAt)}</Fact>
        <Fact label={live ? 'Expected end' : 'Ended'}>
          {live
            ? run.estimatedEndAt
              ? `~${formatTime(run.estimatedEndAt)}`
              : '—'
            : run.endedAt
              ? dateTime(run.endedAt)
              : '—'}
        </Fact>
        <Fact label="Runtime">
          {formatDuration(run.durationSeconds)}
          {live ? ' so far' : ''}
        </Fact>
        <Fact label="Outcome" helper={run.outcomeFromMachine ? 'from machine' : undefined}>
          {live ? 'Not yet' : <OutcomeStatusTag status={run.outcome ?? 'unknown'} />}
        </Fact>
        <Fact label="Material">
          {run.usages.length ? runConsumptionText(run) : run.source === 'recorded' ? reportedUsageText(run) : '—'}
        </Fact>
      </FactsGrid>
      <ClaimRunModal
        runId={claiming ? run.id : null}
        onClose={() => setClaiming(false)}
        canCreate={can('machine_jobs.create')}
        canAttach={can('machine_jobs.edit') && can('machine_jobs.read')}
      />
      {deleting && (
        <DeleteRunModal open onClose={() => setDeleting(false)} run={run} runId={run.id} onDeleted={onGone} />
      )}
    </DetailPanel>
  );
}

/**
 * The jobs table with its permanent detail panel (≥ 1056 px): the selected job or unassigned run, or a hint while
 * nothing is selected. Embeddable on a machine's page with the `JobsTable` props.
 */
export function JobsWorkspace(props: Omit<JobsTableProps, 'selected' | 'onSelect'>) {
  const [selected, setSelected] = useState<JobsSelection | null>(null);
  const panel = !selected ? (
    <DetailPanel>
      <EmptyState title="No job selected" description="Select a job or a reported run to see its details here." />
    </DetailPanel>
  ) : selected.kind === 'job' ? (
    <JobPanel key={selected.id} jobId={selected.id} />
  ) : (
    <RunPanel key={selected.id} runId={selected.id} onGone={() => setSelected(null)} />
  );
  return (
    <ListWithPanel panel={panel} panelLabel={selected?.kind === 'run' ? 'Run details' : 'Job details'}>
      <JobsTable {...props} selected={selected} onSelect={setSelected} />
    </ListWithPanel>
  );
}
