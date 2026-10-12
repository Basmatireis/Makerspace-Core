import './styles.scss';
import { Add, ArrowRight, InventoryManagement } from '@carbon/icons-react';
import { Button, Column, ContainedList, ContainedListItem, Grid, Tag } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Machine } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { PermissionId, hasPermission } from '../auth/permissions';
import { useCurrentUser } from '../auth/auth';
import { formatDateTime, formatDecimal, formatMoney } from './formatting';
import { machinesQuery, overviewQuery } from './queries';

type AttentionItem = { key: string; count: number; label: string; tone: 'red' | 'warm-gray'; action?: { label: string; to: string } };

function machineStatusTag(machine: Machine) {
  if (machine.status === 'maintenance') return <Tag size="sm" type="warm-gray">Maintenance</Tag>;
  if (machine.status === 'retired') return <Tag size="sm" type="gray">Retired</Tag>;
  return <Tag size="sm" type="green">Active</Tag>;
}

function ActionLink({ label, to }: { label: string; to: string }) {
  return <Button as={Link} to={to} kind="ghost" size="sm" renderIcon={ArrowRight}>{label}</Button>;
}

export function MachineLogbookOverviewPage() {
  const currentUser = useCurrentUser();
  const canReadJobs = hasPermission(currentUser, PermissionId.machine_jobsread);
  const canReadInventory = hasPermission(currentUser, PermissionId.inventoryread);
  const canReview = hasPermission(currentUser, PermissionId.machine_jobsreview);
  const canReadMachines = hasPermission(currentUser, PermissionId.machinesread);
  const canReadOrders = hasPermission(currentUser, PermissionId.ordersread);
  const query = useQuery(overviewQuery());
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 25 }), enabled: canReadMachines });
  if (query.isPending) return <FullPageLoading label="Loading workshop overview" />;
  if (query.isError) return <ErrorState message="The overview could not be loaded." onRetry={() => query.refetch()} />;
  const data = query.data;

  const lowStock = data.lowStockMaterials[0];
  const candidates: Array<AttentionItem | false> = [
    canReview && { key: 'review', count: data.needsReview, label: data.needsReview === 1 ? 'Job waiting for review' : 'Jobs waiting for review', tone: 'warm-gray', action: { label: 'Review', to: '/machine-logbook/review' } },
    canReadJobs && { key: 'orders', count: data.unassignedJobs, label: `${data.unassignedJobs === 1 ? 'Job' : 'Jobs'} without an order · ${formatMoney(data.unassignedEstimatedAmount)} open`, tone: 'warm-gray', action: canReadOrders ? { label: 'Orders', to: '/orders' } : undefined },
    canReadJobs && { key: 'failed', count: data.failedOrPartialThisWeek, label: 'Failed or partial prints this week', tone: 'red', action: { label: 'Inspect', to: '/machine-logbook/jobs?outcome=failed' } },
    canReadInventory && { key: 'stock', count: data.lowStockItems, label: data.lowStockItems === 1 && lowStock ? `Low stock · ${lowStock.name} ${formatDecimal(lowStock.quantity)} ${lowStock.unit}` : 'Materials low on stock', tone: 'red', action: { label: 'Restock', to: '/machine-logbook/inventory?stock=low_stock' } },
  ];
  const attention = candidates.filter((item): item is AttentionItem => item !== false && item.count > 0);

  const actions: ReactNode = <>
    {canReadInventory && hasPermission(currentUser, PermissionId.inventorymanage) && <Button as={Link} to="/machine-logbook/inventory?new=1" kind="secondary" renderIcon={InventoryManagement}>Add material</Button>}
    {canReadJobs && hasPermission(currentUser, PermissionId.machine_jobscreate) && <Button as={Link} to="/machine-logbook/jobs?new=1" renderIcon={Add}>New job</Button>}
  </>;

  return <PageShell title="Workshop" description={`${data.jobsToday} ${data.jobsToday === 1 ? 'job' : 'jobs'} today · ${data.jobsThisWeek} this week`} actions={actions} width="wide" className="machine-logbook-page workshop-overview">
    <Grid condensed className="machine-logbook-grid">
      <Column sm={4} md={8} lg={9}>
        <ContainedList label="Needs attention" kind="on-page" size="lg">
          {attention.length === 0
            ? <ContainedListItem>Nothing needs attention right now.</ContainedListItem>
            : attention.map((item) => <ContainedListItem key={item.key} action={item.action && <ActionLink {...item.action} />}>
              <span className="workshop-attention"><Tag size="sm" type={item.tone}>{item.count}</Tag>{item.label}</span>
            </ContainedListItem>)}
        </ContainedList>
      </Column>
      <Column sm={4} md={8} lg={7}>
        {canReadMachines
          ? <ContainedList label="Machines" kind="on-page" size="md" action={<ActionLink label="All machines" to="/machine-logbook/machines" />}>
            {machines.isPending && <ContainedListItem>Loading machines…</ContainedListItem>}
            {machines.isError && <ContainedListItem>Machines could not be loaded.</ContainedListItem>}
            {machines.data?.items.length === 0 && <ContainedListItem>No machines yet.</ContainedListItem>}
            {machines.data?.items.filter((item) => item.status !== 'retired').map((item) => <ContainedListItem key={item.id} action={machineStatusTag(item)}>
              <Link to={`/machine-logbook/machines/${item.id}`}>{item.name}</Link>
              <span className="workshop-machine__meta">{item.lastIngestedAt ? `Last job data ${formatDateTime(item.lastIngestedAt)}` : item.machineType.name}</span>
            </ContainedListItem>)}
          </ContainedList>
          : <EmptyState title="Machine list unavailable" description="Machine read permission is required to see machine status." />}
      </Column>
    </Grid>
  </PageShell>;
}
