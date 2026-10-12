import { useState } from 'react';
import { Button, ClickableTile, ContainedList, ContainedListItem, SkeletonText } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../../../app/PageShell';
import { ErrorState } from '../../../app/PageState';
import { JobFormModal } from '../dialogs/JobFormModal';
import { AvailabilityTag, billingState, buildJobRows, ConnectorIssueTag, formatRelative, formatTime, JobRowStatusTag, machineActivity, printEnd, type JobRow } from '../derived';
import { useNow, useSimulatedQuery, useStore } from '../store';
import type { Job, Machine, Print } from '../types';
import '../styles/overview.scss';

const EMPTY: { machines: Machine[]; jobs: Job[]; prints: Print[] } = { machines: [], jobs: [], prints: [] };
const ACTIVE_STATUSES: JobRow['status'][] = ['running', 'printing', 'needs_outcome', 'unlinked'];
const ACTIVE_LIMIT = 6;

type Metric = { key: string; label: string; count: number; detail: string; to: string };

function MetricTile({ metric, loading }: { metric: Metric; loading: boolean }) {
  return (
    <ClickableTile href={`#${metric.to}`} renderIcon={ArrowRight} className="mj-metric">
      <span className="mj-metric__label">{metric.label}</span>
      {loading ? <SkeletonText heading width="3rem" /> : <span className={`mj-metric__value${metric.count === 0 ? ' mj-metric__value--zero' : ''}`}>{metric.count}</span>}
      <span className="mj-secondary">{metric.detail}</span>
    </ClickableTile>
  );
}

function activeLine(row: JobRow) {
  const end = row.job && row.print?.state !== 'printing' ? row.job.endsAt : row.print ? printEnd(row.print) : null;
  const when = row.status === 'unlinked' && row.print?.endedAt ? `${row.print.state} ${formatRelative(row.print.endedAt)}`
    : end ? `ends ~${formatTime(end)}` : `started ${formatRelative(row.startedAt)}`;
  return [row.machineName, row.customer, when].filter(Boolean).join(' · ');
}

export function OverviewPage() {
  const store = useStore();
  const navigate = useNavigate();
  const [jobOpen, setJobOpen] = useState(false);
  const now = useNow();
  const query = useSimulatedQuery((d) => ({ machines: d.machines, jobs: d.jobs, prints: d.prints }), EMPTY);
  const { machines, jobs, prints } = query.data;
  const loading = query.status === 'pending';
  const canCreate = store.can('machine_jobs.create');

  const rows = buildJobRows(jobs, prints, machines, now);
  const running = rows.filter((row) => row.status === 'running' || row.status === 'printing');
  const unlinkedCount = rows.filter((row) => row.status === 'unlinked').length;
  const runningMachines = [...new Set(running.map((row) => row.machineName))];
  const billingIssues = jobs.filter((job) => ['price_incomplete', 'order_outdated'].includes(billingState(job))).length;

  const metrics: Metric[] = [
    { key: 'running', label: 'Running now', count: running.length, detail: runningMachines.length ? runningMachines.join(', ') : 'No machine is busy', to: '/jobs?status=running,printing' },
    { key: 'outcome', label: 'Needs outcome', count: rows.filter((row) => row.status === 'needs_outcome').length, detail: 'Run ended; record how it went', to: '/jobs?status=needs_outcome' },
    { key: 'unlinked', label: 'Unlinked prints', count: unlinkedCount, detail: 'Create a job or link to one', to: '/jobs?status=unlinked' },
    { key: 'billing', label: 'Billing issues', count: billingIssues, detail: 'Missing price rule or changed order', to: '/jobs?billing=price_incomplete,order_outdated' },
  ];

  const active = rows.filter((row) => ACTIVE_STATUSES.includes(row.status))
    .sort((a, b) => ACTIVE_STATUSES.indexOf(a.status) - ACTIVE_STATUSES.indexOf(b.status) || b.startedAt.localeCompare(a.startedAt));
  const visibleMachines = machines.filter((machine) => machine.status !== 'retired');
  const todayCount = jobs.filter((job) => new Date(job.startsAt).toDateString() === new Date().toDateString()).length;

  return (
    <PageShell
      title="Overview" width="wide" breadcrumbs={[{ label: 'Workshop' }]}
      description={loading || query.status === 'error' ? 'What is running and what needs you.' : `${todayCount} ${todayCount === 1 ? 'job' : 'jobs'} today · ${running.length} running · ${unlinkedCount} unlinked`}
      actions={canCreate ? <Button kind="primary" onClick={() => setJobOpen(true)}>New job</Button> : undefined}
    >
      {query.status === 'error' ? <ErrorState message="The overview could not be loaded." onRetry={query.retry} /> : (
        <div className="mj-overview">
          <section aria-label="Key figures" className="mj-overview__metrics">
            {metrics.map((metric) => <MetricTile key={metric.key} metric={metric} loading={loading} />)}
          </section>

          <div className="mj-overview__panels">
            <ContainedList
              label="Active jobs" kind="on-page" className="mj-overview__panel"
              action={<Button as={Link} to="/jobs" kind="ghost" size="sm" renderIcon={ArrowRight}>All jobs</Button>}
            >
              {loading && <ContainedListItem><SkeletonText paragraph lineCount={3} /></ContainedListItem>}
              {!loading && active.length === 0 && <ContainedListItem>Nothing is running and no print waits to be linked.</ContainedListItem>}
              {!loading && active.slice(0, ACTIVE_LIMIT).map((row) => (
                <ContainedListItem key={row.id} onClick={() => navigate(row.href)} action={<JobRowStatusTag status={row.status} size="sm" />}>
                  <span className="mj-cell-stack">
                    <strong>{row.title}</strong>
                    <span className="mj-secondary">{activeLine(row)}</span>
                  </span>
                </ContainedListItem>
              ))}
              {!loading && active.length > ACTIVE_LIMIT && (
                <ContainedListItem onClick={() => navigate('/jobs?status=running,printing,unlinked')}>
                  <span className="mj-secondary">{active.length - ACTIVE_LIMIT} more active items</span>
                </ContainedListItem>
              )}
            </ContainedList>

            {store.can('machines.read') && (
              <ContainedList
                label="Machines" kind="on-page" className="mj-overview__panel"
                action={<Button as={Link} to="/machines" kind="ghost" size="sm" renderIcon={ArrowRight}>All machines</Button>}
              >
                {loading && <ContainedListItem><SkeletonText paragraph lineCount={3} /></ContainedListItem>}
                {!loading && visibleMachines.length === 0 && <ContainedListItem>No machines have been added yet.</ContainedListItem>}
                {!loading && visibleMachines.map((machine) => {
                  const activity = machineActivity(machine, prints, jobs, now);
                  const last = jobs.filter((job) => job.machineId === machine.id).sort((a, b) => b.endsAt.localeCompare(a.endsAt))[0];
                  const detail = activity.current ? `${activity.current.title}${activity.current.endsAt ? ` · ends ~${formatTime(activity.current.endsAt)}` : ''}`
                    : activity.availability === 'maintenance' ? 'Marked for maintenance'
                      : last ? `Last job ${formatRelative(last.endsAt)}` : 'No jobs yet';
                  return (
                    <ContainedListItem
                      key={machine.id} onClick={() => navigate(`/machines/${machine.id}`)}
                      action={<span className="mj-inline"><ConnectorIssueTag issue={activity.connectorIssue} /><AvailabilityTag availability={activity.availability} size="sm" /></span>}
                    >
                      <span className="mj-cell-stack">
                        <strong>{machine.name}</strong>
                        <span className="mj-secondary">{detail}</span>
                      </span>
                    </ContainedListItem>
                  );
                })}
              </ContainedList>
            )}
          </div>
        </div>
      )}
      {canCreate && <JobFormModal open={jobOpen} onClose={() => setJobOpen(false)} mode="create" />}
    </PageShell>
  );
}
