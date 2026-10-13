import { useState } from 'react';
import { Button, ClickableTile as CarbonClickableTile, ContainedList, ContainedListItem, SkeletonText } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { ComponentProps, ComponentType } from 'react';
import type { WorkItem } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState } from '../../app/PageState';
import { PermissionId } from '../auth/permissions';
import { JobFormModal } from './dialogs/JobFormModal';
import { machineActivityQuery, machinesQuery, overviewQuery } from './queries';
import { formatDecimal } from './formatting';
import { formatRelative, formatTime } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { AvailabilityTag, ConnectorIssueTag, connectorIssue, currentItemName, JobRowStatusTag, workItemName } from './shared/status';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import './styles/overview.scss';

type RouterClickableTileProps = Omit<ComponentProps<typeof CarbonClickableTile>, 'href'> & { as: typeof Link; to: string };
// Carbon's ClickableTile forwards polymorphic Link props at runtime, but its public type omits them.
const ClickableTile = CarbonClickableTile as ComponentType<RouterClickableTileProps>;

const ACTIVE_LIMIT = 6;

type Metric = { key: string; label: string; count: number; detail: string; to: string };

const METRIC_LABELS = ['Running now', 'Needs outcome', 'Unlinked prints', 'Billing issues'];

function MetricTile({ metric }: { metric: Metric }) {
  return (
    <ClickableTile as={Link} to={metric.to} renderIcon={ArrowRight} className="mj-metric">
      <span className="mj-metric__label">{metric.label}</span>
      <span className={`mj-metric__value${metric.count === 0 ? ' mj-metric__value--zero' : ''}`}>{metric.count}</span>
      <span className="mj-secondary">{metric.detail}</span>
    </ClickableTile>
  );
}

const itemPath = (item: WorkItem) => item.kind === 'print' ? machineLogbookPaths.print(item.id) : machineLogbookPaths.job(item.id);

function activeLine(item: WorkItem, now: number) {
  const end = item.endsAt ?? item.estimatedEndAt;
  const ended = end !== null && end !== undefined && new Date(end).getTime() <= now;
  const when = ended ? `ended ${formatRelative(end)}` : end ? `ends ~${formatTime(end)}` : `started ${formatRelative(item.startedAt)}`;
  return [item.machineName, item.customer?.displayName, when].filter(Boolean).join(' · ');
}

export function MachineLogbookOverviewPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [jobOpen, setJobOpen] = useState(false);
  const now = useNow();
  const canCreate = can(PermissionId.machine_jobscreate);
  const canReadJobs = can(PermissionId.machine_jobsread);
  const canReadMachines = can(PermissionId.machinesread);
  const canReadInventory = can(PermissionId.inventoryread);
  const query = useQuery(overviewQuery());
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: canReadMachines });
  const activity = useQuery({ ...machineActivityQuery(), enabled: canReadMachines });
  const data = query.data;
  const loading = query.isPending;

  const hasJobFigures = data?.runningNow != null;
  const running = data?.runningNow ?? 0;
  const unlinked = data?.unlinkedPrints ?? 0;
  const runningMachines = data?.runningMachineNames ?? [];
  const activeItems = data?.activeItems ?? null;
  const activeTotal = data?.activeTotal ?? activeItems?.length ?? 0;
  const lowStock = data?.lowStockMaterials[0];

  const metrics: Metric[] = hasJobFigures ? [
    { key: 'running', label: 'Running now', count: running, detail: runningMachines.length ? runningMachines.join(', ') : 'No machine is busy', to: machineLogbookPaths.jobs({ status: 'running,printing' }) },
    { key: 'outcome', label: 'Needs outcome', count: data.needsOutcome ?? 0, detail: 'Run ended; record how it went', to: machineLogbookPaths.jobs({ status: 'needs_outcome' }) },
    { key: 'unlinked', label: 'Unlinked prints', count: unlinked, detail: 'Create a job or link to one', to: machineLogbookPaths.jobs({ status: 'unlinked' }) },
    { key: 'billing', label: 'Billing issues', count: data.billingIssues ?? 0, detail: 'Missing price rule or changed order', to: machineLogbookPaths.jobs({ billing: 'price_incomplete,order_outdated' }) },
  ] : [];

  const description = data
    ? [`${data.jobsToday} ${data.jobsToday === 1 ? 'job' : 'jobs'} today`, ...(hasJobFigures ? [`${running} running`, `${unlinked} unlinked`] : [])].join(' · ')
    : 'What is running and what needs you.';

  const showMachines = canReadMachines;
  const showLowStock = canReadInventory && data !== undefined && data.lowStockItems > 0;
  const nothingToShow = data !== undefined && !hasJobFigures && activeItems === null && !showMachines && !showLowStock;

  const activityByMachine = new Map((activity.data?.items ?? []).map((item) => [item.machineId, item]));
  const visibleMachines = (machines.data?.items ?? []).filter((machine) => machine.status !== 'retired');
  const machinesLoading = machines.isPending || activity.isPending;

  return (
    <PageShell
      title="Overview" width="wide" breadcrumbs={[{ label: 'Workshop' }]}
      description={description}
      actions={canCreate ? <Button kind="primary" onClick={() => setJobOpen(true)}>New job</Button> : undefined}
    >
      {query.isError ? <ErrorState message="The overview could not be loaded." onRetry={() => { void query.refetch(); }} /> : nothingToShow ? (
        <EmptyState title="Nothing to show yet" description="Job, machine and inventory permissions decide which parts of the overview you see." />
      ) : (
        <div className="mj-overview">
          {(loading ? canReadJobs : hasJobFigures) && (
            <section aria-label="Key figures" className="mj-overview__metrics">
              {loading ? METRIC_LABELS.map((label) => (
                <CarbonClickableTile key={label} className="mj-metric"><span className="mj-metric__label">{label}</span><SkeletonText heading width="3rem" /></CarbonClickableTile>
              )) : metrics.map((metric) => <MetricTile key={metric.key} metric={metric} />)}
            </section>
          )}

          <div className="mj-overview__panels">
            {(loading ? canReadJobs : activeItems !== null) && (
              <ContainedList
                label="Active jobs" kind="on-page" className="mj-overview__panel"
                action={<Button as={Link} to={machineLogbookPaths.jobs()} kind="ghost" size="sm" renderIcon={ArrowRight}>All jobs</Button>}
              >
                {loading && <ContainedListItem><SkeletonText paragraph lineCount={3} /></ContainedListItem>}
                {activeItems?.length === 0 && <ContainedListItem>Nothing is running and no print waits to be linked.</ContainedListItem>}
                {activeItems?.slice(0, ACTIVE_LIMIT).map((item) => (
                  <ContainedListItem key={`${item.kind}-${item.id}`} onClick={() => navigate(itemPath(item))} action={<JobRowStatusTag status={item.status} size="sm" />}>
                    <span className="mj-cell-stack">
                      <strong>{workItemName(item)}</strong>
                      <span className="mj-secondary">{activeLine(item, now)}</span>
                    </span>
                  </ContainedListItem>
                ))}
                {activeItems && activeTotal > ACTIVE_LIMIT && (
                  <ContainedListItem onClick={() => navigate(machineLogbookPaths.jobs({ status: 'running,printing,unlinked,needs_outcome' }))}>
                    <span className="mj-secondary">{activeTotal - ACTIVE_LIMIT} more active items</span>
                  </ContainedListItem>
                )}
              </ContainedList>
            )}

            {showMachines && (
              <ContainedList
                label="Machines" kind="on-page" className="mj-overview__panel"
                action={<Button as={Link} to={machineLogbookPaths.machines()} kind="ghost" size="sm" renderIcon={ArrowRight}>All machines</Button>}
              >
                {machinesLoading && !machines.isError && <ContainedListItem><SkeletonText paragraph lineCount={3} /></ContainedListItem>}
                {machines.isError && <ContainedListItem>Machines could not be loaded.</ContainedListItem>}
                {!machinesLoading && !machines.isError && visibleMachines.length === 0 && <ContainedListItem>No machines have been added yet.</ContainedListItem>}
                {!machinesLoading && !machines.isError && visibleMachines.map((machine) => {
                  const state = activityByMachine.get(machine.id);
                  const current = state?.current ?? null;
                  const availability = state?.availability ?? (machine.status === 'maintenance' ? 'maintenance' : 'available');
                  const detail = current ? `${currentItemName(current)}${current.endsAt ? ` · ends ~${formatTime(current.endsAt)}` : ''}`
                    : availability === 'maintenance' ? 'Marked for maintenance'
                      : state?.lastJobStartedAt ? `Last job ${formatRelative(state.lastJobStartedAt)}` : 'No jobs yet';
                  return (
                    <ContainedListItem
                      key={machine.id} onClick={() => navigate(machineLogbookPaths.machine(machine.id))}
                      action={<span className="mj-inline"><ConnectorIssueTag issue={connectorIssue(state?.connector ?? undefined)} /><AvailabilityTag availability={availability} size="sm" /></span>}
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

          {showLowStock && (
            <ContainedList label="Stock" kind="on-page" className="mj-overview__panel">
              <ContainedListItem
                action={<Button as={Link} to={`${machineLogbookPaths.inventory('materials')}&stock=low_stock`} kind="ghost" size="sm" renderIcon={ArrowRight}>Restock</Button>}
              >
                {data.lowStockItems === 1 && lowStock ? `Low stock · ${lowStock.name} ${formatDecimal(lowStock.quantity)} ${lowStock.unit}` : 'Materials low on stock'}
              </ContainedListItem>
            </ContainedList>
          )}
        </div>
      )}
      {canCreate && <JobFormModal open={jobOpen} onClose={() => setJobOpen(false)} mode="create" />}
    </PageShell>
  );
}
